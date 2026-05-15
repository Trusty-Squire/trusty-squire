// Mailgun inbound email webhook
// Receives POST from Mailgun when emails arrive at @trustysquire.ai

import type { FastifyInstance } from "fastify";
import type { MailgunHandler, MailgunInboundPayload } from "@trusty-squire/inbox";
import { z } from "zod";

const mailgunPayloadSchema = z.object({
  sender: z.string(),
  recipient: z.string(),
  subject: z.string(),
  "message-id": z.string(),
  "body-mime": z.string().optional(),
  "stripped-text": z.string().optional(),
  "stripped-html": z.string().optional(),
});

export interface MailgunWebhookDeps {
  mailgunHandler: MailgunHandler;
}

export async function registerMailgunWebhookRoute(
  fastify: FastifyInstance,
  opts: { deps: MailgunWebhookDeps },
): Promise<void> {
  // POST /v1/webhooks/mailgun — Mailgun posts here for inbound emails
  fastify.post("/v1/webhooks/mailgun", async (req, reply) => {
    // Mailgun sends form-encoded data
    const parsed = mailgunPayloadSchema.safeParse(req.body);
    if (!parsed.success) {
      fastify.log.warn({ errors: parsed.error.issues }, "Invalid Mailgun payload");
      reply.code(400).send({ error: "invalid_payload" });
      return;
    }

    const payload = parsed.data as MailgunInboundPayload;

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
