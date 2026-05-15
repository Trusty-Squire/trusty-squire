// SES inbound email webhook
// Flow:
//   AWS SES receives mail → writes raw RFC 822 to S3 → publishes SNS notification
//   SNS POSTs here → we fetch the raw email from S3 → forward to Gmail (if aliased)
//   or fall back to the inbox-store path (for universal-bot signups).
//
// SNS subscription confirmation is handled automatically by visiting SubscribeURL.

import type { FastifyInstance } from "fastify";
import type { SesHandler } from "@trusty-squire/inbox";
import { parseRfc822 } from "@trusty-squire/inbox";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { EmailForwarder, DEFAULT_ALIASES } from "../services/email-forwarder.js";

export interface SesWebhookDeps {
  sesHandler: SesHandler;
  emailForwarder?: EmailForwarder;
}

// Reuse a single S3 client (lazy-init so tests/dev without AWS creds still load).
let s3Client: S3Client | null = null;
function getS3Client(): S3Client {
  if (s3Client === null) {
    s3Client = new S3Client({ region: process.env.AWS_REGION ?? "us-east-1" });
  }
  return s3Client;
}

async function fetchRawEmailFromS3(bucket: string, key: string): Promise<Buffer> {
  const res = await getS3Client().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (res.Body === undefined) throw new Error("s3_empty_body");
  // Body is a readable stream in Node. Recent AWS SDK v3 typings expose
  // it as `StreamingBlobPayloadOutputTypes` which is iterable, so we no
  // longer need a @ts-expect-error here.
  const chunks: Buffer[] = [];
  for await (const chunk of res.Body as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function registerSesWebhookRoute(
  fastify: FastifyInstance,
  opts: { deps: SesWebhookDeps },
): Promise<void> {
  const gmailConfig =
    process.env.GMAIL_USER !== undefined && process.env.GMAIL_APP_PASSWORD !== undefined
      ? {
          gmailUser: process.env.GMAIL_USER,
          gmailAppPassword: process.env.GMAIL_APP_PASSWORD,
        }
      : undefined;

  const forwarder = opts.deps.emailForwarder ?? new EmailForwarder(DEFAULT_ALIASES, gmailConfig);

  fastify.post("/v1/webhooks/ses", async (req, reply) => {
    // SNS posts with Content-Type "text/plain; charset=UTF-8". Our server.ts
    // text/plain parser turns that into a JS object via JSON.parse, so by the
    // time we get here req.body should already be an object. Be defensive in
    // case AWS ever flips to application/json — handle both.
    let sns: Record<string, unknown>;
    if (typeof req.body === "string") {
      try {
        sns = JSON.parse(req.body) as Record<string, unknown>;
      } catch {
        reply.code(400).send({ error: "invalid_sns_body" });
        return;
      }
    } else if (req.body !== null && typeof req.body === "object") {
      sns = req.body as Record<string, unknown>;
    } else {
      reply.code(400).send({ error: "missing_sns_body" });
      return;
    }

    const snsType = sns["Type"];

    // Step 1: SNS handshake.
    if (snsType === "SubscriptionConfirmation") {
      const subscribeUrl = sns["SubscribeURL"];
      fastify.log.info({ messageId: sns["MessageId"] }, "SNS subscription confirmation received");
      if (typeof subscribeUrl === "string") {
        try {
          const response = await fetch(subscribeUrl);
          if (response.ok) {
            fastify.log.info("SNS subscription confirmed");
          } else {
            fastify.log.error({ status: response.status }, "Failed to confirm SNS subscription");
          }
        } catch (err) {
          fastify.log.error({ err }, "Error confirming SNS subscription");
        }
      }
      reply.code(200).send({ ok: true });
      return;
    }

    // Step 2: real notification.
    if (snsType !== "Notification") {
      reply.code(400).send({ error: "unknown_sns_type", type: snsType });
      return;
    }

    // The actual SES payload is JSON-stringified inside sns.Message.
    let sesPayload: any;
    try {
      sesPayload = JSON.parse(sns["Message"] as string);
    } catch (err) {
      fastify.log.error({ err }, "Failed to parse SES Message JSON");
      reply.code(400).send({ error: "invalid_ses_message" });
      return;
    }

    // SES rule with both S3Action and SNSAction: SNS reports the *triggering*
    // action (SNS), not the S3 action. The raw email is written to S3 with the
    // key = `<prefix><mail.messageId>` where prefix comes from the rule config.
    // We read both from env so the rule and the webhook stay in sync.
    const mail = sesPayload?.mail;
    const recipients: string[] = mail?.destination ?? sesPayload?.receipt?.recipients ?? [];
    const sesMessageId: string | undefined = mail?.messageId;

    if (typeof sesMessageId !== "string" || sesMessageId.length === 0) {
      fastify.log.error({ payload: sesPayload }, "SES notification missing mail.messageId");
      reply.code(400).send({ error: "missing_ses_message_id" });
      return;
    }

    const bucket = process.env.SES_INBOUND_BUCKET ?? "trusty-squire-inbound";
    const keyPrefix = process.env.SES_INBOUND_PREFIX ?? "inbound/";
    const objectKey = `${keyPrefix}${sesMessageId}`;

    let raw: Buffer;
    try {
      raw = await fetchRawEmailFromS3(bucket, objectKey);
    } catch (err) {
      fastify.log.error({ err, bucket, key: objectKey }, "Failed to fetch raw email from S3");
      reply.code(500).send({ error: "s3_fetch_failed" });
      return;
    }

    let parsed;
    try {
      parsed = await parseRfc822(raw);
    } catch (err) {
      fastify.log.error({ err }, "Failed to parse RFC 822");
      reply.code(500).send({ error: "rfc822_parse_failed" });
      return;
    }

    // Find which configured alias this email landed at.
    const recipient = recipients.find((r) => forwarder.shouldForward(r)) ?? recipients[0];

    if (recipient !== undefined && forwarder.shouldForward(recipient)) {
      const result = await forwarder.forward({
        from: parsed.from_address,
        to: recipient,
        subject: parsed.subject,
        ...(parsed.body_text !== null && parsed.body_text !== undefined ? { text: parsed.body_text } : {}),
        ...(parsed.body_html !== null && parsed.body_html !== undefined ? { html: parsed.body_html } : {}),
      });

      fastify.log.info(
        {
          messageId: parsed.message_id,
          from: parsed.from_address,
          to: recipient,
          forwardTo: forwarder.getForwardAddress(recipient),
          success: result.success,
        },
        "SES email forwarded to Gmail",
      );

      reply.code(200).send({ ok: true, forwarded: true, success: result.success });
      return;
    }

    // No matching personal alias — fall through to the bot-inbox handler so
    // signup-verification emails (vouchflow.dev/inbox-*@…) still get stored.
    try {
      const outcome = await opts.deps.sesHandler.ingest({
        bucket,
        key: objectKey,
        recipients,
      });
      fastify.log.info(
        { messageId: parsed.message_id, kind: outcome.kind },
        "SES email handed to inbox handler",
      );
      reply.code(200).send({ ok: true, kind: outcome.kind });
    } catch (err) {
      fastify.log.error({ err }, "Inbox ingest failed");
      reply.code(500).send({ error: "ingest_failed" });
    }
  });
}
