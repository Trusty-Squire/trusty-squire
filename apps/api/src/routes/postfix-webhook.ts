// Postfix email webhook handler
// Receives raw RFC822 email from self-hosted mail server

import type { FastifyInstance } from "fastify";
import type { MailgunHandler } from "@trusty-squire/inbox";
import { parseRfc822 } from "@trusty-squire/inbox";
import { EmailForwarder, DEFAULT_ALIASES } from "../services/email-forwarder.js";

export interface PostfixWebhookDeps {
  mailgunHandler: MailgunHandler;
  emailForwarder?: EmailForwarder;
}

export async function registerPostfixWebhookRoute(
  fastify: FastifyInstance,
  opts: { deps: PostfixWebhookDeps },
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
  
  // POST /v1/webhooks/postfix — Self-hosted mail server posts raw email here
  fastify.post("/v1/webhooks/postfix", async (req, reply) => {
    const recipient = req.headers["x-original-to"] as string | undefined;
    
    if (!recipient) {
      reply.code(400).send({ error: "missing_recipient" });
      return;
    }

    // Parse raw RFC822 email
    const rawEmail = req.body as Buffer | string;
    const emailBuffer = Buffer.isBuffer(rawEmail) 
      ? rawEmail 
      : Buffer.from(rawEmail, "utf-8");

    try {
      const parsed = await parseRfc822(emailBuffer);

      // Check if this is a personal email alias (business emails)
      if (forwarder.shouldForward(recipient)) {
        // Forward to personal Gmail
        await forwarder.forward({
          from: parsed.from_address,
          to: recipient,
          subject: parsed.subject,
          ...(parsed.body_text ? { text: parsed.body_text } : {}),
          ...(parsed.body_html ? { html: parsed.body_html } : {}),
        });

        fastify.log.info(
          {
            messageId: parsed.message_id,
            from: parsed.from_address,
            to: recipient,
            forwardTo: forwarder.getForwardAddress(recipient),
          },
          "Email forwarded to personal address",
        );

        reply.code(200).send({ ok: true, forwarded: true });
        return;
      }

      // Otherwise, it's for the universal signup bot - store it
      const mailgunPayload = {
        sender: parsed.from_address,
        recipient,
        subject: parsed.subject,
        "message-id": parsed.message_id,
        "stripped-text": parsed.body_text || undefined,
        "stripped-html": parsed.body_html || undefined,
      };

      const result = await opts.deps.mailgunHandler.ingest(mailgunPayload as any);

      fastify.log.info(
        {
          messageId: parsed.message_id,
          result: result.kind,
          alias: result.kind === "stored" ? result.email.alias : undefined,
        },
        "Bot email ingested",
      );

      reply.code(200).send({ ok: true, result: result.kind });
    } catch (err) {
      fastify.log.error({ err, recipient }, "Failed to process email");
      reply.code(500).send({ error: "processing_failed" });
    }
  });
}
