// Resend inbound email webhook handler
// https://resend.com/docs/api-reference/webhooks/email-received

import type { FastifyInstance } from "fastify";
import type { MailgunHandler } from "@trusty-squire/inbox";
import { EmailForwarder, DEFAULT_ALIASES } from "../services/email-forwarder.js";
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

export async function registerResendWebhookRoute(
  fastify: FastifyInstance,
  opts: { deps: ResendWebhookDeps },
): Promise<void> {
  const gmailConfig = process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD
    ? {
        gmailUser: process.env.GMAIL_USER,
        gmailAppPassword: process.env.GMAIL_APP_PASSWORD,
      }
    : undefined;
  
  const forwarder = opts.deps.emailForwarder || new EmailForwarder(
    DEFAULT_ALIASES,
    gmailConfig
  );

  // POST /v1/webhooks/resend — Resend posts here for inbound emails
  fastify.post("/v1/webhooks/resend", async (req, reply) => {
    const parsed = resendEmailSchema.safeParse(req.body);
    
    if (!parsed.success) {
      fastify.log.warn({ errors: parsed.error.issues }, "Invalid Resend webhook payload");
      reply.code(400).send({ error: "invalid_payload" });
      return;
    }

    const email = parsed.data.data;
    const recipient = email.to[0]; // Primary recipient
    
    if (!recipient) {
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
          ...(email.text ? { text: email.text } : {}),
          ...(email.html ? { html: email.html } : {}),
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
        "stripped-text": email.text,
        "stripped-html": email.html,
      };

      const result = await opts.deps.mailgunHandler.ingest(mailgunPayload as any);

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
