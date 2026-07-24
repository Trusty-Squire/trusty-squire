// Telegram account linking + the bot webhook.
//
//   POST /v1/telegram/link     (web)    mint a one-time /start deep link
//   GET  /v1/telegram/status   (any)    { connected }
//   POST /v1/telegram/webhook  (public) Telegram's Bot API callback
//
// The webhook is public — Telegram, not our auth, calls it — so it's
// trusted only via the `x-telegram-bot-api-secret-token` header Telegram
// echoes back exactly as configured on setWebhook (TELEGRAM_WEBHOOK_SECRET).

import { randomBytes } from "node:crypto";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { ApiDeps } from "../services/deps.js";
import { sendTelegramMessage } from "../services/telegram.js";

const LINK_TTL_MS = 15 * 60 * 1000;
const START_COMMAND = /^\/start (\S+)$/;

export const registerTelegramRoute: FastifyPluginAsync<{
  deps: ApiDeps;
  requireWeb: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  requireAny: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
}> = async (fastify, opts) => {
  fastify.post("/v1/telegram/link", { preHandler: opts.requireWeb }, async (req, reply) => {
    const auth = req.auth!;
    if (auth.kind !== "web") return;
    const token = randomBytes(16).toString("hex");
    const now = opts.deps.now?.() ?? new Date();
    const expiresAt = new Date(now.getTime() + LINK_TTL_MS);
    await opts.deps.telegramLinkTokenStore.create(auth.account_id, token, expiresAt);
    const username = process.env.TELEGRAM_BOT_USERNAME ?? "trusty_squire_bot";
    return reply.code(201).send({ url: `https://t.me/${username}?start=${token}` });
  });

  fastify.get("/v1/telegram/status", { preHandler: opts.requireAny }, async (req, reply) => {
    const account = await opts.deps.accountStore.findAccountById(req.auth!.account_id);
    return reply.code(200).send({ connected: account?.telegram_chat_id != null });
  });

  fastify.post("/v1/telegram/webhook", async (req, reply) => {
    const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
    const secret = req.headers["x-telegram-bot-api-secret-token"];
    if (expected === undefined || expected.length === 0 || secret !== expected) {
      reply.code(401).send({ error: "invalid_webhook_secret" });
      return;
    }

    const message = extractMessage(req.body);
    const match = message?.text !== undefined ? START_COMMAND.exec(message.text) : null;
    if (match !== null && message?.chatId !== undefined) {
      const token = match[1]!;
      const now = opts.deps.now?.() ?? new Date();
      const accountId = await opts.deps.telegramLinkTokenStore.consume(token, now);
      if (accountId !== null) {
        await opts.deps.accountStore.setTelegramChatId(accountId, message.chatId);
        await sendTelegramMessage(
          message.chatId,
          "✅ Connected. You'll get payment-approval links here.",
        );
      }
    }

    // Always 200 — a non-2xx response makes Telegram retry the update.
    return reply.code(200).send({ ok: true });
  });
};

function extractMessage(body: unknown): { text: string | undefined; chatId: string | undefined } | null {
  if (typeof body !== "object" || body === null || !("message" in body)) return null;
  const message = (body as { message?: unknown }).message;
  if (typeof message !== "object" || message === null) return null;
  const text = (message as { text?: unknown }).text;
  const chat = (message as { chat?: unknown }).chat;
  const chatId =
    typeof chat === "object" && chat !== null && "id" in chat
      ? (chat as { id: unknown }).id
      : undefined;
  return {
    text: typeof text === "string" ? text : undefined,
    chatId:
      typeof chatId === "number" || typeof chatId === "string" ? String(chatId) : undefined,
  };
}
