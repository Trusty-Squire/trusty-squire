// SES inbound email webhook
// Flow:
//   AWS SES receives mail → writes raw RFC 822 to S3 → publishes SNS notification
//   SNS POSTs here → we fetch the raw email from S3 → forward to Gmail (if aliased)
//   or fall back to the inbox-store path (for universal-bot signups).
//
// Security: the SNS message signature is verified against the AWS SNS
// signing certificate before anything is read off the payload. An
// unverified POST could forge a signup-verification email, so this is
// always-on (the AWS public cert is the trust anchor — no shared secret
// needed). SubscriptionConfirmation is only honoured when SubscribeURL
// points at a genuine AWS SNS host.

import type { FastifyInstance } from "fastify";
import type { SesHandler } from "@trusty-squire/inbox";
import { parseRfc822 } from "@trusty-squire/inbox";
import type { EmailForwarder } from "../services/email-forwarder.js";
import { buildEmailForwarder, fetchRawEmailFromS3 } from "../services/webhook-forwarder.js";
import {
  isAwsSnsHost,
  verifySnsSignature,
  type CertFetcher,
} from "../auth/webhook-signatures.js";

export interface SesWebhookDeps {
  sesHandler: SesHandler;
  emailForwarder?: EmailForwarder;
  // Test seam — inject a stub SNS certificate fetcher so tests can sign
  // payloads with a local key pair.
  snsCertFetcher?: CertFetcher;
}

export async function registerSesWebhookRoute(
  fastify: FastifyInstance,
  opts: { deps: SesWebhookDeps },
): Promise<void> {
  const forwarder = buildEmailForwarder(opts.deps.emailForwarder);

  fastify.post("/v1/webhooks/ses", async (req, reply) => {
    // SNS posts with Content-Type "text/plain; charset=UTF-8". Our server.ts
    // text/plain parser turns that into a JS object via JSON.parse, so by the
    // time we get here req.body should already be an object. Be defensive in
    // case AWS ever flips to application/json — handle both.
    let sns: Record<string, unknown>;
    if (typeof req.body === "string") {
      try {
        const decoded: unknown = JSON.parse(req.body);
        if (decoded === null || typeof decoded !== "object") {
          reply.code(400).send({ error: "invalid_sns_body" });
          return;
        }
        sns = decoded as Record<string, unknown>;
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

    // Verify the SNS signature against the AWS signing cert BEFORE
    // trusting any field on the payload. A forged SNS message could
    // otherwise inject a verification email into the inbox store.
    const verification = await verifySnsSignature(sns, {
      ...(opts.deps.snsCertFetcher !== undefined
        ? { certFetcher: opts.deps.snsCertFetcher }
        : {}),
    });
    if (!verification.ok) {
      fastify.log.warn(
        { detail: verification.detail },
        "SES webhook rejected — SNS signature verification failed",
      );
      reply.code(401).send({ error: "invalid_sns_signature" });
      return;
    }

    const snsType = sns["Type"];

    // Step 1: SNS handshake. Only honour SubscribeURL when it points at
    // a genuine AWS SNS host — otherwise an attacker who passed signature
    // verification with their own cert (impossible) or a misconfigured
    // topic could redirect us to an arbitrary URL.
    if (snsType === "SubscriptionConfirmation") {
      const subscribeUrl = sns["SubscribeURL"];
      fastify.log.info({ messageId: sns["MessageId"] }, "SNS subscription confirmation received");
      if (typeof subscribeUrl !== "string" || !isAwsSnsHost(subscribeUrl)) {
        fastify.log.warn(
          { subscribeUrl },
          "SNS SubscribeURL is not an AWS SNS host — refusing to confirm",
        );
        reply.code(400).send({ error: "invalid_subscribe_url" });
        return;
      }
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
      reply.code(200).send({ ok: true });
      return;
    }

    // Step 2: real notification.
    if (snsType !== "Notification") {
      reply.code(400).send({ error: "unknown_sns_type", type: snsType });
      return;
    }

    // The actual SES payload is JSON-stringified inside sns.Message.
    const rawMessage = sns["Message"];
    let sesPayload: unknown;
    try {
      sesPayload = JSON.parse(typeof rawMessage === "string" ? rawMessage : "");
    } catch (err) {
      fastify.log.error({ err }, "Failed to parse SES Message JSON");
      reply.code(400).send({ error: "invalid_ses_message" });
      return;
    }

    // SES rule with both S3Action and SNSAction: SNS reports the *triggering*
    // action (SNS), not the S3 action. The raw email is written to S3 with the
    // key = `<prefix><mail.messageId>` where prefix comes from the rule config.
    // We read both from env so the rule and the webhook stay in sync.
    const ses = extractSesNotification(sesPayload);
    if (ses === null) {
      fastify.log.error({ payload: sesPayload }, "SES notification missing mail.messageId");
      reply.code(400).send({ error: "missing_ses_message_id" });
      return;
    }
    const { recipients, sesMessageId } = ses;

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

// Narrow the JSON-parsed SES Message into the fields we consume. Returns
// null when mail.messageId is missing — without it we can't locate the
// raw email in S3.
function extractSesNotification(
  payload: unknown,
): { recipients: string[]; sesMessageId: string } | null {
  if (payload === null || typeof payload !== "object") return null;
  const obj = payload as Record<string, unknown>;
  const mail =
    obj.mail !== null && typeof obj.mail === "object"
      ? (obj.mail as Record<string, unknown>)
      : {};
  const receipt =
    obj.receipt !== null && typeof obj.receipt === "object"
      ? (obj.receipt as Record<string, unknown>)
      : {};

  const sesMessageId = mail.messageId;
  if (typeof sesMessageId !== "string" || sesMessageId.length === 0) {
    return null;
  }

  const fromMail = Array.isArray(mail.destination) ? mail.destination : null;
  const fromReceipt = Array.isArray(receipt.recipients) ? receipt.recipients : null;
  const rawRecipients = fromMail ?? fromReceipt ?? [];
  const recipients = rawRecipients.filter((r): r is string => typeof r === "string");

  return { recipients, sesMessageId };
}
