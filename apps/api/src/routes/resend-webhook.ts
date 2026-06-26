// Resend inbound webhook — rc.19 cutover.
//
// Replaces the SES + S3 + SNS inbound pipeline. Resend POSTs a
// parsed email payload directly (no S3 fetch step). Signature
// verification uses Svix's HMAC-SHA256 over `svix-id.svix-timestamp.
// <raw body>` — see ../auth/webhook-signatures.ts for the
// implementation. The SES route stays registered as a fallback per
// the rc.19 cutover plan; trustysquire.com MX moves to Resend, and
// SES stops receiving traffic once propagation completes.
//
// Flow:
//   Resend → POST /v1/webhooks/resend-inbound
//   → verify Svix signature
//   → if `to` matches a personal alias → forward via EmailForwarder
//   → else → hand to ResendHandler.ingest() which writes ReceivedEmail
//     for the bot's verification-mail polling path
//
// Raw-body requirement: Svix verification must read the EXACT bytes
// POSTed. Fastify's default JSON parser produces an object — useless
// for HMAC. The route plugs into a raw-body source (req.rawBody when
// the fastify-raw-body plugin is wired, else fall through to a
// JSON.stringify of req.body which is best-effort and noted below).

import type { FastifyInstance } from "fastify";
import {
  ResendHandler,
  type ResendInboundPayload,
} from "@trusty-squire/inbox";
import type { EmailForwarder } from "../services/email-forwarder.js";
import { buildEmailForwarder } from "../services/webhook-forwarder.js";
import { verifySvixSignature } from "../auth/webhook-signatures.js";

export interface ResendWebhookDeps {
  resendHandler: ResendHandler;
  emailForwarder?: EmailForwarder;
  // Test seam — override the current time for the replay-window check.
  nowSeconds?: () => number;
}

export async function registerResendWebhookRoute(
  fastify: FastifyInstance,
  opts: { deps: ResendWebhookDeps },
): Promise<void> {
  const forwarder = buildEmailForwarder(opts.deps.emailForwarder);
  const secret = process.env.RESEND_WEBHOOK_SECRET ?? "";

  fastify.post("/v1/webhooks/resend-inbound", async (req, reply) => {
    // Pull svix headers (case-insensitive — Fastify lowercases).
    const svixId = headerValue(req.headers["svix-id"]);
    const svixTimestamp = headerValue(req.headers["svix-timestamp"]);
    const svixSignature = headerValue(req.headers["svix-signature"]);

    // Raw body for HMAC. Prefer the fastify-raw-body plugin's
    // `req.rawBody` when present; fall back to re-serialising the
    // parsed body (best-effort, may not byte-match the original if
    // Resend ships exotic whitespace — Svix's verification is strict
    // about exact bytes). For the rc.19 deploy we'll wire the raw-
    // body plugin; the fallback exists so dev/test work without it.
    const reqAny = req as unknown as { rawBody?: string | Buffer };
    let rawBody: string;
    if (typeof reqAny.rawBody === "string") {
      rawBody = reqAny.rawBody;
    } else if (Buffer.isBuffer(reqAny.rawBody)) {
      rawBody = reqAny.rawBody.toString("utf8");
    } else if (typeof req.body === "string") {
      rawBody = req.body;
    } else {
      rawBody = JSON.stringify(req.body ?? {});
    }

    if (secret.length === 0) {
      fastify.log.error("Resend webhook rejected — RESEND_WEBHOOK_SECRET unset");
      reply.code(503).send({ error: "webhook_secret_not_configured" });
      return;
    }
    const verification = verifySvixSignature(
      { id: svixId, timestamp: svixTimestamp, signature: svixSignature },
      rawBody,
      secret,
      opts.deps.nowSeconds !== undefined ? { nowSeconds: opts.deps.nowSeconds() } : {},
    );
    if (!verification.ok) {
      fastify.log.warn(
        { detail: verification.detail },
        "Resend webhook rejected — Svix signature verification failed",
      );
      reply.code(401).send({ error: "invalid_svix_signature", detail: verification.detail });
      return;
    }

    // Body shape: {"type":"email.received","data":{...}}. Unknown
    // event types are acked-and-ignored (Resend can deliver bounce /
    // delivered / opened events on the same webhook; only inbound
    // mail is interesting here).
    let parsed: { type?: string; data?: unknown };
    try {
      parsed = JSON.parse(rawBody) as { type?: string; data?: unknown };
    } catch {
      reply.code(400).send({ error: "invalid_json_body" });
      return;
    }
    if (parsed.type !== "email.received") {
      reply.code(200).send({ ok: true, ignored_event: parsed.type ?? "(none)" });
      return;
    }

    const payload = normaliseInboundPayload(parsed.data);
    if (payload === null) {
      reply.code(400).send({ error: "invalid_inbound_payload" });
      return;
    }

    const recipients = normaliseRecipients(payload.to);
    const aliasMatch = recipients.find((r) => forwarder.shouldForward(r));

    if (aliasMatch !== undefined) {
      // Personal-alias forward path. Mirror the SES route's behavior:
      // forward to the mapped destination via Resend SDK (the same
      // EmailForwarder the outbound surface uses).
      const result = await forwarder.forward({
        from: payload.from,
        to: aliasMatch,
        subject: payload.subject,
        ...(typeof payload.text === "string" && payload.text.length > 0
          ? { text: payload.text }
          : {}),
        ...(typeof payload.html === "string" && payload.html.length > 0
          ? { html: payload.html }
          : {}),
      });
      fastify.log.info(
        {
          messageId: payload.message_id,
          from: payload.from,
          to: aliasMatch,
          forwardTo: forwarder.getForwardAddress(aliasMatch),
          success: result.success,
        },
        "Resend inbound forwarded",
      );
      reply.code(200).send({ ok: true, forwarded: true, success: result.success });
      return;
    }

    // Bot-inbox path. Hand to ResendHandler which writes the
    // ReceivedEmail row the universal-bot polls.
    try {
      const outcome = await opts.deps.resendHandler.ingest(payload);
      fastify.log.info(
        { messageId: payload.message_id, kind: outcome.kind },
        "Resend inbound handed to bot inbox",
      );
      reply.code(200).send({ ok: true, kind: outcome.kind });
    } catch (err) {
      fastify.log.error({ err }, "Resend inbound ingest failed");
      reply.code(500).send({ error: "ingest_failed" });
    }
  });
}

function headerValue(h: unknown): string | undefined {
  if (typeof h === "string") return h;
  if (Array.isArray(h) && typeof h[0] === "string") return h[0];
  return undefined;
}

function normaliseRecipients(to: string | string[]): string[] {
  if (typeof to === "string") return [to];
  if (Array.isArray(to)) {
    return to.filter((r): r is string => typeof r === "string");
  }
  return [];
}

// Narrow the unknown `data` field to ResendInboundPayload. Drops the
// payload if message_id / from / to / subject aren't all present.
function normaliseInboundPayload(data: unknown): ResendInboundPayload | null {
  if (data === null || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const messageId = pickString(d.message_id) ?? pickString(d.headers && (d.headers as Record<string, unknown>)["message-id"]);
  const from = pickString(d.from);
  const subject = pickString(d.subject);
  const rawTo = d.to;
  if (
    typeof messageId !== "string" ||
    typeof from !== "string" ||
    typeof subject !== "string" ||
    (typeof rawTo !== "string" && !Array.isArray(rawTo))
  ) {
    return null;
  }
  const to: string | string[] =
    typeof rawTo === "string"
      ? rawTo
      : rawTo.filter((r): r is string => typeof r === "string");
  return {
    message_id: messageId,
    from,
    to,
    subject,
    ...(pickString(d.text) !== undefined ? { text: pickString(d.text)! } : {}),
    ...(pickString(d.html) !== undefined ? { html: pickString(d.html)! } : {}),
    ...(pickString(d.received_at) !== undefined
      ? { received_at: pickString(d.received_at)! }
      : {}),
    ...(pickString(d.id) !== undefined ? { id: pickString(d.id)! } : {}),
    ...(pickString(d.email_id) !== undefined ? { email_id: pickString(d.email_id)! } : {}),
  };
}

function pickString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
