// Postfix email webhook handler
// Receives raw RFC822 email from self-hosted mail server
//
// Security: the self-hosted mail server has no provider signature to
// verify, so this route requires the operator admin bearer
// (UNIVERSAL_BOT_API_KEY). Without it a forged POST could inject a
// signup-verification email. A missing key fails the request closed.

import type { FastifyInstance } from "fastify";
import type { MailgunHandler, MailgunInboundPayload } from "@trusty-squire/inbox";
import { parseRfc822 } from "@trusty-squire/inbox";
import type { EmailForwarder } from "../services/email-forwarder.js";
import { buildEmailForwarder } from "../services/webhook-forwarder.js";
import { checkAdminBearer } from "../auth/authorize-machine-or-admin.js";

export interface PostfixWebhookDeps {
  mailgunHandler: MailgunHandler;
  emailForwarder?: EmailForwarder;
}

export async function registerPostfixWebhookRoute(
  fastify: FastifyInstance,
  opts: { deps: PostfixWebhookDeps },
): Promise<void> {
  const forwarder = buildEmailForwarder(opts.deps.emailForwarder);

  // POST /v1/webhooks/postfix — Self-hosted mail server posts raw email here
  fastify.post("/v1/webhooks/postfix", async (req, reply) => {
    // Require the operator admin bearer before trusting the payload.
    const adminCheck = checkAdminBearer(req);
    if (adminCheck === "unconfigured") {
      // Fail closed: with no admin key set we cannot authenticate the
      // self-hosted mail server, so we must not ingest.
      fastify.log.error(
        "Postfix webhook rejected — UNIVERSAL_BOT_API_KEY not configured",
      );
      reply.code(503).send({ error: "webhook_verification_unconfigured" });
      return;
    }
    if (adminCheck === "unauthorized") {
      fastify.log.warn("Postfix webhook rejected — missing or invalid admin bearer");
      reply.code(401).send({ error: "invalid_token" });
      return;
    }

    const recipientHeader = req.headers["x-original-to"];
    const recipient = Array.isArray(recipientHeader) ? recipientHeader[0] : recipientHeader;

    if (recipient === undefined || recipient.length === 0) {
      reply.code(400).send({ error: "missing_recipient" });
      return;
    }

    // Parse raw RFC822 email
    const rawEmail: unknown = req.body;
    const emailBuffer = Buffer.isBuffer(rawEmail)
      ? rawEmail
      : Buffer.from(typeof rawEmail === "string" ? rawEmail : "", "utf-8");

    try {
      const parsed = await parseRfc822(emailBuffer);

      // Check if this is a personal email alias (business emails)
      if (forwarder.shouldForward(recipient)) {
        // Forward to personal Gmail
        await forwarder.forward({
          from: parsed.from_address,
          to: recipient,
          subject: parsed.subject,
          ...(parsed.body_text !== null && parsed.body_text !== undefined
            ? { text: parsed.body_text }
            : {}),
          ...(parsed.body_html !== null && parsed.body_html !== undefined
            ? { html: parsed.body_html }
            : {}),
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
        ...(parsed.body_text !== null && parsed.body_text !== undefined
          ? { "stripped-text": parsed.body_text }
          : {}),
        ...(parsed.body_html !== null && parsed.body_html !== undefined
          ? { "stripped-html": parsed.body_html }
          : {}),
      } satisfies MailgunInboundPayload;

      const result = await opts.deps.mailgunHandler.ingest(mailgunPayload);

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
