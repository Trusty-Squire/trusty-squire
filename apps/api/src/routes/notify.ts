// Heightened-auth notification route.
//
// The universal bot can't complete some OAuth flows on its own — when
// Google throws a number-match challenge ("tap N on your phone"), the
// user has a ~2-minute window to react. Without this route the only
// surface is stderr on the harvester box, which the user usually
// isn't watching.
//
// Flow: bot POSTs {service, digit, window_seconds} authenticated by
// its machine token; this route resolves token → paired account →
// account.email (the OAuth-registered address) and fires a short
// email via the same Gmail SMTP transporter that powers
// /v1/webhooks/ses forwarding.
//
// Idempotency: an in-memory 5-min dedupe window keyed by
// (account_id, digit, service) so a flaky detector that fires
// twice doesn't double-notify.
//
// Failure modes (all return 4xx/5xx without sending; the bot's
// caller is fire-and-forget so it never escalates):
//   401 — missing/invalid machine token
//   412 — machine token not paired to an account (anonymous tier;
//         there's no email to send to)
//   503 — Gmail SMTP not configured on the API host

import type { FastifyInstance } from "fastify";
import { extractMachineToken } from "./install.js";
import type { MachineTokenStore } from "../services/machine-tokens.js";
import type { AccountStore } from "../services/in-memory-account-store.js";
import type { EmailForwarder } from "../services/email-forwarder.js";
import { buildEmailForwarder } from "../services/webhook-forwarder.js";

export interface NotifyRouteDeps {
  machineTokenStore: MachineTokenStore;
  accountStore: AccountStore;
  emailForwarder?: EmailForwarder;
  now?: () => Date;
}

// Five-minute dedupe — the bot's number-match detector fires once per
// challenge page render but the planner re-reads the page on each loop
// iteration; we don't want each re-read to spam another email.
const DEDUPE_WINDOW_MS = 5 * 60 * 1000;
const recentSends = new Map<string, number>();

function pruneDedupe(nowMs: number): void {
  // Keep the map bounded — sweep anything past the window. Cheap
  // because nothing here is hot (one POST per signup at most).
  for (const [key, ts] of recentSends) {
    if (nowMs - ts > DEDUPE_WINDOW_MS) recentSends.delete(key);
  }
}

function buildEmail(opts: {
  digit: string | null;
  service: string;
  windowSeconds: number;
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
      ``,
      `— Trusty Squire`,
    ].join("\n"),
  };
}

export async function registerNotifyRoute(
  fastify: FastifyInstance,
  opts: { deps: NotifyRouteDeps },
): Promise<void> {
  const now = (): Date => opts.deps.now?.() ?? new Date();
  const forwarder = buildEmailForwarder(opts.deps.emailForwarder);

  fastify.post("/v1/notify/heightened-auth", async (req, reply) => {
    const token = extractMachineToken(req);
    if (token === null) {
      reply.code(401).send({ error: "missing_machine_token" });
      return;
    }
    const tokenRow = await opts.deps.machineTokenStore.find(token);
    if (tokenRow === null) {
      reply.code(401).send({ error: "invalid_machine_token" });
      return;
    }
    if (tokenRow.paired_account_id === null) {
      // Anonymous machine token — no account, no email to send to.
      // Distinct status so the bot can degrade gracefully (the
      // stderr banner still fires regardless).
      reply.code(412).send({ error: "not_paired" });
      return;
    }
    const account = await opts.deps.accountStore.findAccountById(tokenRow.paired_account_id);
    if (account === null) {
      // Token references a deleted account. Treat as unauthorized.
      reply.code(401).send({ error: "invalid_machine_token" });
      return;
    }

    const body = req.body;
    if (body === null || typeof body !== "object") {
      reply.code(400).send({ error: "invalid_body" });
      return;
    }
    const b = body as Record<string, unknown>;

    const service = typeof b.service === "string" && b.service.length > 0 ? b.service : null;
    if (service === null) {
      reply.code(400).send({ error: "missing_service" });
      return;
    }

    // digit is optional — null means "Google challenge but extractor
    // didn't recognize the number". The email body is different but
    // the route shape is the same.
    const rawDigit = b.digit;
    const digit =
      typeof rawDigit === "string" && /^\d{1,3}$/.test(rawDigit) ? rawDigit : null;

    const rawWindow = b.window_seconds;
    const windowSeconds =
      typeof rawWindow === "number" && rawWindow > 0 && rawWindow < 3600
        ? Math.floor(rawWindow)
        : 120;

    const nowMs = now().getTime();
    pruneDedupe(nowMs);
    const dedupeKey = `${account.id}:${digit ?? "unreadable"}:${service}`;
    const lastSent = recentSends.get(dedupeKey);
    if (lastSent !== undefined && nowMs - lastSent < DEDUPE_WINDOW_MS) {
      reply.code(200).send({ sent: false, deduped: true });
      return;
    }

    const { subject, text } = buildEmail({ digit, service, windowSeconds });
    const result = await forwarder.sendDirect({
      to: account.email,
      subject,
      text,
    });

    if (!result.success) {
      reply
        .code(503)
        .send({ sent: false, error: result.error ?? "send_failed" });
      return;
    }

    recentSends.set(dedupeKey, nowMs);
    reply.code(200).send({ sent: true });
  });
}

// Test-only — clears the in-memory dedupe map so tests don't bleed
// state between runs. Not exported in the package barrel.
export function _resetNotifyDedupeForTests(): void {
  recentSends.clear();
}
