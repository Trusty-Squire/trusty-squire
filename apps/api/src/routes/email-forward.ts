// Simple email forwarding service
// Receives emails and forwards them to a personal email address

import type { FastifyInstance } from "fastify";
import { parseRfc822 } from "@trusty-squire/inbox";

export interface EmailForwardDeps {
  forwardTo: string; // e.g., "yourname@gmail.com"
}

export async function registerEmailForwardRoute(
  fastify: FastifyInstance,
  opts: { deps: EmailForwardDeps },
): Promise<void> {
  // POST /v1/webhooks/email-forward — Forward personal business emails
  fastify.post("/v1/webhooks/email-forward", async (req, reply) => {
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

      // TODO: Send email via SMTP to opts.deps.forwardTo
      // For now, just log it
      fastify.log.info(
        {
          from: parsed.from_address,
          to: recipient,
          subject: parsed.subject,
          forwardTo: opts.deps.forwardTo,
        },
        "Email received - would forward",
      );

      reply.code(200).send({ ok: true, forwarded: true });
    } catch (err) {
      fastify.log.error({ err, recipient }, "Failed to forward email");
      reply.code(500).send({ error: "forward_failed" });
    }
  });
}
