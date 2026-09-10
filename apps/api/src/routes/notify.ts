import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { AccountStore } from "../services/in-memory-account-store.js";
import type { EmailForwarder } from "../services/email-forwarder.js";
import { buildEmailForwarder } from "../services/webhook-forwarder.js";
import { sendTelegramMessage } from "../services/telegram.js";

type TelegramSender = (chatId: string, text: string) => Promise<boolean>;

export interface NotifyRouteDeps {
  accountStore: AccountStore;
  emailForwarder?: EmailForwarder;
  telegramSender?: TelegramSender;
  now?: () => Date;
}

// Five-minute dedupe — the bot's number-match detector fires once per
// challenge page render but the planner re-reads the page on each loop
// iteration; we don't want each re-read to spam another email.
const DEDUPE_WINDOW_MS = 5 * 60 * 1000;
const MAX_DEDUPE_ENTRIES = 1_000;
type DeliveryResult = {
  sent: boolean;
  delivery: {
    channel: "telegram" | "email" | null;
    status: "sent" | "failed";
    error?: string;
  };
};
const recentSends = new Map<string, { sentAt: number; result: DeliveryResult }>();
const inFlightSends = new Map<string, Promise<DeliveryResult>>();
let inFlightJoins = 0;

function pruneDedupe(nowMs: number): void {
  // Keep the map bounded — sweep anything past the window. Cheap
  // because nothing here is hot (one POST per signup at most).
  for (const [key, entry] of recentSends) {
    if (nowMs - entry.sentAt > DEDUPE_WINDOW_MS) recentSends.delete(key);
  }
  while (recentSends.size > MAX_DEDUPE_ENTRIES) {
    const oldest = recentSends.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    recentSends.delete(oldest);
  }
}

function buildEmail(opts: {
  digit: string | null;
  service: string;
  windowSeconds: number;
  attemptId: string;
  challengeRevision: string;
  observedAt: string;
  expiresAt: string | null;
}): { subject: string; text: string } {
  const minutes = Math.max(1, Math.round(opts.windowSeconds / 60));
  if (opts.digit !== null) {
    return {
      subject: `Trusty Squire: tap ${opts.digit} on your phone for ${opts.service}`,
      text: [
        `Google is asking you to tap a number on your phone to complete the ${opts.service} signup.`,
        ``,
        `Tap: ${opts.digit}`,
        ``,
        `You have about ${minutes} minute${minutes === 1 ? "" : "s"}.`,
        ``,
        `Open the Google app on your phone (or any device signed into your Google account) and tap ${opts.digit}.`,
        `This applies only while the matching prompt is still visible.`,
        `Observed: ${opts.observedAt}`,
        `Expires: ${opts.expiresAt ?? "unknown; use only while the prompt remains visible"}`,
        `Attempt: ${opts.attemptId} / ${opts.challengeRevision}`,
        ``,
        `— Trusty Squire`,
      ].join("\n"),
    };
  }
  return {
    subject: `Trusty Squire: Google challenge — number unreadable (${opts.service})`,
    text: [
      `Google threw a challenge while completing the ${opts.service} signup, but the bot couldn't read the number to tap.`,
      ``,
      `You have about ${minutes} minute${minutes === 1 ? "" : "s"}.`,
      ``,
      `Open the Google app on your phone — it will show the number to tap.`,
      `This applies only while the matching prompt is still visible.`,
      `Observed: ${opts.observedAt}`,
      `Expires: ${opts.expiresAt ?? "unknown; use only while the prompt remains visible"}`,
      `Attempt: ${opts.attemptId} / ${opts.challengeRevision}`,
      ``,
      `— Trusty Squire`,
    ].join("\n"),
  };
}

export async function registerNotifyRoute(
  fastify: FastifyInstance,
  opts: {
    deps: NotifyRouteDeps;
    requireAgent: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  },
): Promise<void> {
  const now = (): Date => opts.deps.now?.() ?? new Date();
  const forwarder = buildEmailForwarder(opts.deps.emailForwarder);
  const sendTelegram = opts.deps.telegramSender ?? sendTelegramMessage;

  fastify.post(
    "/v1/notify/heightened-auth",
    { preHandler: opts.requireAgent },
    async (req, reply) => {
      const account = await opts.deps.accountStore.findAccountById(req.auth!.account_id);
      if (account === null) {
        reply.code(401).send({ error: "agent_session_required" });
        return;
      }

      const body = req.body;
      if (body === null || typeof body !== "object") {
        reply.code(400).send({ error: "invalid_body" });
        return;
      }
      const b = body as Record<string, unknown>;

      const service =
        typeof b.service === "string" &&
        b.service.length > 0 &&
        b.service.length <= 120 &&
        /^[\p{L}\p{N} ._()+&'/-]+$/u.test(b.service)
          ? b.service
          : null;
      if (service === null) {
        reply.code(400).send({ error: "missing_service" });
        return;
      }

      // digit is optional — null means "Google challenge but extractor
      // didn't recognize the number". The email body is different but
      // the route shape is the same.
      const rawDigit = b.digit;
      const digit = typeof rawDigit === "string" && /^\d{1,3}$/.test(rawDigit) ? rawDigit : null;

      const rawWindow = b.window_seconds;
      const windowSeconds =
        typeof rawWindow === "number" && rawWindow > 0 && rawWindow < 3600
          ? Math.floor(rawWindow)
          : 120;

      const boundedId = (value: unknown): string | null =>
        typeof value === "string" &&
        value.length > 0 &&
        value.length <= 160 &&
        /^[A-Za-z0-9_.:-]+$/.test(value)
          ? value
          : null;
      const attemptId = boundedId(b.attempt_id);
      const challengeRevision = boundedId(b.challenge_revision);
      const observedAt =
        typeof b.observed_at === "string" &&
        b.observed_at.length <= 40 &&
        Number.isFinite(Date.parse(b.observed_at))
          ? new Date(b.observed_at).toISOString()
          : null;
      const expiresAt =
        b.expires_at === null || b.expires_at === undefined
          ? null
          : typeof b.expires_at === "string" &&
              b.expires_at.length <= 40 &&
              Number.isFinite(Date.parse(b.expires_at))
            ? new Date(b.expires_at).toISOString()
            : undefined;
      if (
        attemptId === null ||
        challengeRevision === null ||
        observedAt === null ||
        expiresAt === undefined
      ) {
        reply.code(400).send({ error: "invalid_challenge_identity" });
        return;
      }

      const nowMs = now().getTime();
      pruneDedupe(nowMs);
      const dedupeKey = JSON.stringify([account.id, attemptId, challengeRevision]);
      const prior = recentSends.get(dedupeKey);
      if (prior !== undefined && nowMs - prior.sentAt < DEDUPE_WINDOW_MS) {
        reply.code(200).send({
          ...prior.result,
          sent: false,
          deduped: true,
          attempt_id: attemptId,
          challenge_revision: challengeRevision,
        });
        return;
      }

      const existingSend = inFlightSends.get(dedupeKey);
      const isConcurrentRetry = existingSend !== undefined;
      if (isConcurrentRetry) inFlightJoins += 1;
      if (existingSend === undefined && inFlightSends.size >= MAX_DEDUPE_ENTRIES) {
        reply.code(503).send({
          sent: false,
          deduped: false,
          attempt_id: attemptId,
          challenge_revision: challengeRevision,
          delivery: { channel: null, status: "failed", error: "notification_capacity" },
          error: "notification_capacity",
        });
        return;
      }
      const send =
        existingSend ??
        (async (): Promise<DeliveryResult> => {
          const { subject, text } = buildEmail({
            digit,
            service,
            windowSeconds,
            attemptId,
            challengeRevision,
            observedAt,
            expiresAt,
          });
          if (account.telegram_chat_id !== null) {
            const telegramSent = await sendTelegram(account.telegram_chat_id, text).catch(
              () => false,
            );
            if (telegramSent) {
              return { sent: true, delivery: { channel: "telegram", status: "sent" } };
            }
          }
          const result = await forwarder.sendDirect({ to: account.email, subject, text });
          if (result.success) {
            return { sent: true, delivery: { channel: "email", status: "sent" } };
          }
          return {
            sent: false,
            delivery: {
              channel: "email",
              status: "failed",
              error: result.error ?? "send_failed",
            },
          };
        })();
      if (existingSend === undefined) inFlightSends.set(dedupeKey, send);
      const result = await send.finally(() => {
        if (inFlightSends.get(dedupeKey) === send) inFlightSends.delete(dedupeKey);
      });

      if (!result.sent) {
        reply.code(503).send({
          ...result,
          deduped: isConcurrentRetry,
          attempt_id: attemptId,
          challenge_revision: challengeRevision,
          error: result.delivery.error ?? "send_failed",
        });
        return;
      }

      recentSends.set(dedupeKey, { sentAt: nowMs, result });
      pruneDedupe(nowMs);
      reply.code(200).send({
        ...result,
        deduped: isConcurrentRetry,
        attempt_id: attemptId,
        challenge_revision: challengeRevision,
      });
    },
  );
}

// Test-only — clears the in-memory dedupe map so tests don't bleed
// state between runs. Not exported in the package barrel.
export function _resetNotifyDedupeForTests(): void {
  recentSends.clear();
  inFlightSends.clear();
  inFlightJoins = 0;
}

export function _notifyInFlightJoinsForTests(): number {
  return inFlightJoins;
}
