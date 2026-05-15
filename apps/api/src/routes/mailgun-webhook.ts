// Mailgun inbound email webhook
// Receives POST from Mailgun when emails arrive at @trustysquire.ai
//
// Security: every payload is HMAC-verified before ingest. Mailgun signs
// `timestamp + token` with the webhook signing key (HMAC-SHA256). An
// unverified POST could forge a signup-verification email, so a missing
// signing key fails the request closed (503) rather than accepting it.

import type { FastifyInstance } from "fastify";
import type { MailgunHandler, MailgunInboundPayload } from "@trusty-squire/inbox";
import { z } from "zod";
import { verifyMailgunSignature } from "../auth/webhook-signatures.js";

// Mailgun's signature fields arrive either flat on the payload or nested
// under a `signature` object (the JSON store/notify webhook shape). We
// accept both and normalise.
const mailgunPayloadSchema = z.object({
  sender: z.string(),
  recipient: z.string(),
  subject: z.string(),
  "message-id": z.string(),
  "body-mime": z.string().optional(),
  "stripped-text": z.string().optional(),
  "stripped-html": z.string().optional(),
  // Flat signature fields (form-encoded inbound route).
  timestamp: z.string().optional(),
  token: z.string().optional(),
  signature: z
    .union([
      z.string(),
      z.object({
        timestamp: z.string(),
        token: z.string(),
        signature: z.string(),
      }),
    ])
    .optional(),
});

type MailgunPayload = z.infer<typeof mailgunPayloadSchema>;

// Pull the (timestamp, token, signature) triple out of either layout.
function extractSignatureFields(p: MailgunPayload): {
  timestamp: string;
  token: string;
  signature: string;
} {
  if (typeof p.signature === "object") {
    return p.signature;
  }
  return {
    timestamp: p.timestamp ?? "",
    token: p.token ?? "",
    signature: typeof p.signature === "string" ? p.signature : "",
  };
}

export interface MailgunWebhookDeps {
  mailgunHandler: MailgunHandler;
}

export async function registerMailgunWebhookRoute(
  fastify: FastifyInstance,
  opts: { deps: MailgunWebhookDeps },
): Promise<void> {
  // POST /v1/webhooks/mailgun — Mailgun posts here for inbound emails
  fastify.post("/v1/webhooks/mailgun", async (req, reply) => {
    const parsed = mailgunPayloadSchema.safeParse(req.body);
    if (!parsed.success) {
      fastify.log.warn({ errors: parsed.error.issues }, "Invalid Mailgun payload");
      reply.code(400).send({ error: "invalid_payload" });
      return;
    }

    const sig = extractSignatureFields(parsed.data);
    const verification = verifyMailgunSignature({
      timestamp: sig.timestamp,
      token: sig.token,
      signature: sig.signature,
      signingKey: process.env.MAILGUN_WEBHOOK_SIGNING_KEY,
    });
    if (!verification.ok) {
      if (verification.reason === "not_configured") {
        // Fail closed: without the signing key we cannot tell a real
        // Mailgun delivery from a forgery, so we must not ingest.
        fastify.log.error(
          { detail: verification.detail },
          "Mailgun webhook rejected — signing key not configured",
        );
        reply.code(503).send({ error: "webhook_verification_unconfigured" });
        return;
      }
      fastify.log.warn(
        { detail: verification.detail },
        "Mailgun webhook rejected — signature verification failed",
      );
      reply.code(401).send({ error: "invalid_signature" });
      return;
    }

    const payload = {
      sender: parsed.data.sender,
      recipient: parsed.data.recipient,
      subject: parsed.data.subject,
      "message-id": parsed.data["message-id"],
      ...(parsed.data["body-mime"] !== undefined
        ? { "body-mime": parsed.data["body-mime"] }
        : {}),
      ...(parsed.data["stripped-text"] !== undefined
        ? { "stripped-text": parsed.data["stripped-text"] }
        : {}),
      ...(parsed.data["stripped-html"] !== undefined
        ? { "stripped-html": parsed.data["stripped-html"] }
        : {}),
    } satisfies MailgunInboundPayload;

    try {
      const result = await opts.deps.mailgunHandler.ingest(payload);

      fastify.log.info(
        {
          messageId: payload["message-id"],
          result: result.kind,
          alias: result.kind === "stored" ? result.email.alias : undefined,
        },
        "Mailgun email ingested",
      );

      reply.code(200).send({ ok: true, result: result.kind });
    } catch (err) {
      fastify.log.error({ err, messageId: payload["message-id"] }, "Failed to ingest Mailgun email");
      reply.code(500).send({ error: "ingest_failed" });
    }
  });
}
