// Fly.io email webhook handler
// Fly.io can deliver inbound emails to your app via HTTP POST
// https://fly.io/docs/networking/email-handlers/

import type { FastifyInstance } from "fastify";
import type { MailgunHandler } from "@trusty-squire/inbox";
import { z } from "zod";

// Fly.io sends emails in Mailgun-compatible format
const flyEmailPayloadSchema = z.object({
  sender: z.string(),
  recipient: z.string(),
  subject: z.string(),
  "message-id": z.string(),
  "body-mime": z.string().optional(),
  "stripped-text": z.string().optional(),
  "stripped-html": z.string().optional(),
});

export interface FlyEmailWebhookDeps {
  mailgunHandler: MailgunHandler;
}

export async function registerFlyEmailWebhookRoute(
  fastify: FastifyInstance,
  opts: { deps: FlyEmailWebhookDeps },
): Promise<void> {
  // POST /v1/webhooks/fly-email — Fly.io posts here for inbound emails
  fastify.post("/v1/webhooks/fly-email", async (req, reply) => {
    const parsed = flyEmailPayloadSchema.safeParse(req.body);
    if (!parsed.success) {
      fastify.log.warn({ errors: parsed.error.issues }, "Invalid Fly.io email payload");
      reply.code(400).send({ error: "invalid_payload" });
      return;
    }

    // Reuse Mailgun handler (same format)
    try {
      const result = await opts.deps.mailgunHandler.ingest(parsed.data as any);

      fastify.log.info(
        {
          messageId: parsed.data["message-id"],
          result: result.kind,
          alias: result.kind === "stored" ? result.email.alias : undefined,
        },
        "Fly.io email ingested",
      );

      reply.code(200).send({ ok: true, result: result.kind });
    } catch (err) {
      fastify.log.error({ err, messageId: parsed.data["message-id"] }, "Failed to ingest Fly.io email");
      reply.code(500).send({ error: "ingest_failed" });
    }
  });
}
