// Resend inbound email webhook handler
// https://resend.com/docs/api-reference/webhooks/email-received
//
// Security: Resend delivers webhooks via Svix. The svix-id /
// svix-timestamp / svix-signature headers are HMAC-verified against
// RESEND_WEBHOOK_SECRET before ingest — a forged POST could otherwise
// inject a signup-verification email. A missing secret fails closed.

import type { FastifyInstance } from "fastify";
import type { MailgunHandler, MailgunInboundPayload } from "@trusty-squire/inbox";
import type { EmailForwarder } from "../services/email-forwarder.js";
import { buildEmailForwarder } from "../services/webhook-forwarder.js";
import { verifySvixSignature } from "../auth/webhook-signatures.js";
import { z } from "zod";

// Resend webhook payload schema
const resendEmailSchema = z.object({
  type: z.literal("email.received"),
  created_at: z.string(),
  data: z.object({
    from: z.string(),
    to: z.array(z.string()),
    subject: z.string(),
    html: z.string().optional(),
    text: z.string().optional(),
    reply_to: z.string().optional(),
    email_id: z.string(),
  }),
});

export interface ResendWebhookDeps {
  mailgunHandler: MailgunHandler;
  emailForwarder?: EmailForwarder;
}

// Read a single header value (Fastify gives string | string[] | undefined).
function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

export async function registerResendWebhookRoute(
  fastify: FastifyInstance,
  opts: { deps: ResendWebhookDeps },
): Promise<void> {
  const forwarder = buildEmailForwarder(opts.deps.emailForwarder);

  // POST /v1/webhooks/resend — Resend posts here for inbound emails
  fastify.post("/v1/webhooks/resend", async (req, reply) => {
    // Verify the Svix signature over the EXACT raw body bytes before
    // trusting any field. req.rawBody is captured by the JSON parser in
    // server.ts; a re-serialised object would not byte-match.
    const verification = verifySvixSignature({
      svixId: headerValue(req.headers["svix-id"]),
      svixTimestamp: headerValue(req.headers["svix-timestamp"]),
      svixSignature: headerValue(req.headers["svix-signature"]),
      rawBody: req.rawBody ?? "",
      secret: process.env.RESEND_WEBHOOK_SECRET,
    });
    if (!verification.ok) {
      if (verification.reason === "not_configured") {
        fastify.log.error(
          { detail: verification.detail },
          "Resend webhook rejected — webhook secret not configured",
        );
        reply.code(503).send({ error: "webhook_verification_unconfigured" });
        return;
      }
      fastify.log.warn(
        { detail: verification.detail },
        "Resend webhook rejected — signature verification failed",
      );
      reply.code(401).send({ error: "invalid_signature" });
      return;
    }

    const parsed = resendEmailSchema.safeParse(req.body);
    if (!parsed.success) {
      fastify.log.warn({ errors: parsed.error.issues }, "Invalid Resend webhook payload");
      reply.code(400).send({ error: "invalid_payload" });
      return;
    }

    const email = parsed.data.data;
    const recipient = email.to[0]; // Primary recipient

    if (recipient === undefined) {
      reply.code(400).send({ error: "missing_recipient" });
      return;
    }

    try {
      // Check if this is a personal email alias (business emails)
      if (forwarder.shouldForward(recipient)) {
        // Forward to personal Gmail
        await forwarder.forward({
          from: email.from,
          to: recipient,
          subject: email.subject,
          ...(email.text !== undefined ? { text: email.text } : {}),
          ...(email.html !== undefined ? { html: email.html } : {}),
        });

        fastify.log.info(
          {
            emailId: email.email_id,
            from: email.from,
            to: recipient,
            forwardTo: forwarder.getForwardAddress(recipient),
          },
          "Resend email forwarded to personal address",
        );

        reply.code(200).send({ ok: true, forwarded: true });
        return;
      }

      // Otherwise, it's for the universal signup bot - store it
      const mailgunPayload = {
        sender: email.from,
        recipient,
        subject: email.subject,
        "message-id": email.email_id,
        ...(email.text !== undefined ? { "stripped-text": email.text } : {}),
        ...(email.html !== undefined ? { "stripped-html": email.html } : {}),
      } satisfies MailgunInboundPayload;

      const result = await opts.deps.mailgunHandler.ingest(mailgunPayload);

      fastify.log.info(
        {
          emailId: email.email_id,
          result: result.kind,
          alias: result.kind === "stored" ? result.email.alias : undefined,
        },
        "Resend bot email ingested",
      );

      reply.code(200).send({ ok: true, result: result.kind });
    } catch (err) {
      fastify.log.error({ err, recipient }, "Failed to process Resend email");
      reply.code(500).send({ error: "processing_failed" });
    }
  });
}
