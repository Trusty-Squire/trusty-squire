// Telegram bot — daily digest + crash alerts.
//
// Recipient: @lunchboxfortwo (per design doc decision).
//
// Setup (one-time):
//   1. Create a bot via @BotFather, save the token.
//   2. Send /start to your bot from @lunchboxfortwo (Telegram bots
//      cannot initiate conversations — the user has to message first).
//   3. Set TELEGRAM_BOT_TOKEN as a systemd env-file var (mode 0600).
//   4. First sendDigest() call will auto-resolve your chat_id from
//      the bot's getUpdates and cache it in
//      ~/.trusty-squire/telegram-chat-id.txt. After that, no further
//      setup needed.
//
// Failure mode: when TELEGRAM_BOT_TOKEN is unset, sendDigest() prints
// the formatted digest to stderr instead of POSTing. This is the
// development / Phase-1-without-token-yet path; production runs
// should always have the token set.
//
// Phase 1 / 2 message format is plain-text + emoji prefix per
// category. Phase 3+ may add Markdown or split into multiple messages
// if the digest grows past Telegram's 4096-char limit; today's
// expected size at 50-service scale stays well under that.

import { homedir } from "node:os";
import { join } from "node:path";
import { readText, writeTextAtomic } from "./state.mjs";

export const CHAT_ID_PATH = join(
  homedir(),
  ".trusty-squire",
  "telegram-chat-id.txt",
);

const API_BASE = "https://api.telegram.org";
const TELEGRAM_MAX_MESSAGE_LEN = 4096;

// Send a message to the configured chat. Returns true on success,
// false on any failure (including no-token, no-chat-id, HTTP error).
// Best-effort by design — digest/alert delivery failure must not
// turn into a harvester failure.
export async function sendMessage(text, opts = {}) {
  const token = opts.token ?? process.env.TELEGRAM_BOT_TOKEN;
  if (token === undefined || token === "") {
    // Dev / unset-token path: print to stderr so the operator still
    // sees the message during Phase 1 before they wire the token.
    process.stderr.write(`[telegram] (no TELEGRAM_BOT_TOKEN — printing instead)\n${text}\n`);
    return false;
  }

  let chatId = opts.chatId;
  if (chatId === undefined) {
    chatId = await loadChatId();
  }
  if (chatId === undefined || chatId === null) {
    chatId = await resolveChatIdFromUpdates(token);
    if (chatId === null) {
      process.stderr.write(
        `[telegram] No chat_id known and getUpdates returned nothing. ` +
          `Send /start to your bot from @lunchboxfortwo, then retry.\n`,
      );
      return false;
    }
    await persistChatId(chatId);
  }

  return await postSendMessage(token, chatId, truncate(text));
}

// Resolves the chat_id from the bot's recent message updates.
// Returns the most recent message's chat_id, or null if no messages.
// This is the "user sent /start" handshake — Telegram bots can't
// initiate, but once you've messaged the bot, getUpdates returns
// the chat_id you can send back to.
export async function resolveChatIdFromUpdates(token) {
  try {
    const res = await fetch(`${API_BASE}/bot${token}/getUpdates`);
    if (!res.ok) return null;
    const json = await res.json();
    if (!json.ok || !Array.isArray(json.result) || json.result.length === 0) {
      return null;
    }
    // Take the most recent update with a usable chat
    for (let i = json.result.length - 1; i >= 0; i--) {
      const update = json.result[i];
      const chat = update?.message?.chat ?? update?.channel_post?.chat;
      if (chat && typeof chat.id === "number") return chat.id;
    }
    return null;
  } catch {
    return null;
  }
}

async function postSendMessage(token, chatId, text) {
  try {
    const res = await fetch(`${API_BASE}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
    if (!res.ok) {
      process.stderr.write(`[telegram] sendMessage HTTP ${res.status}\n`);
      return false;
    }
    return true;
  } catch (err) {
    process.stderr.write(
      `[telegram] sendMessage failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return false;
  }
}

async function loadChatId() {
  const raw = await readText(CHAT_ID_PATH);
  if (raw === null) return null;
  const id = Number(raw.trim());
  return Number.isFinite(id) ? id : null;
}

async function persistChatId(chatId) {
  await writeTextAtomic(CHAT_ID_PATH, String(chatId) + "\n");
}

function truncate(text) {
  if (text.length <= TELEGRAM_MAX_MESSAGE_LEN) return text;
  // Leave room for the truncation marker
  return text.slice(0, TELEGRAM_MAX_MESSAGE_LEN - 32) + "\n…[truncated]";
}

// Compose the daily-digest body from the harvester's day-state.
// Pure — no IO. Caller fetches state from backoff/budget modules
// and passes in.
//
// opts:
//   date              — ISO date string ("2026-05-24")
//   budget            — output of summarizeBudget()
//   succeeded         — list of slugs that hit replay-ok today
//   demoted           — list of slugs that hit consecutive-failures threshold
//   newCaptures       — list of slugs that produced new skill captures
//   inBackoff         — list of slugs currently in backoff window
//   recentFailures    — list of { slug, status, error } for newest 5 failures
export function buildDailyDigest(opts) {
  const lines = [];
  lines.push(`📋 Harvester daily digest — ${opts.date}`);
  lines.push("");
  if (opts.budget) lines.push(`💰 ${opts.budget}`);
  lines.push("");
  lines.push(`✅ Succeeded: ${opts.succeeded?.length ?? 0}`);
  if ((opts.succeeded?.length ?? 0) > 0) {
    lines.push(`   ${opts.succeeded.join(", ")}`);
  }
  lines.push(`⚠️  In backoff: ${opts.inBackoff?.length ?? 0}`);
  if ((opts.inBackoff?.length ?? 0) > 0) {
    lines.push(`   ${opts.inBackoff.join(", ")}`);
  }
  lines.push(`🆕 New captures: ${opts.newCaptures?.length ?? 0}`);
  if ((opts.newCaptures?.length ?? 0) > 0) {
    lines.push(`   ${opts.newCaptures.join(", ")}`);
  }
  lines.push(`👀 Pending review: ${opts.pendingReview?.length ?? 0}`);
  if ((opts.pendingReview?.length ?? 0) > 0) {
    lines.push(`   ${opts.pendingReview.join(", ")}`);
  }
  lines.push(`❌ Demoted today: ${opts.demoted?.length ?? 0}`);
  if ((opts.demoted?.length ?? 0) > 0) {
    lines.push(`   ${opts.demoted.join(", ")}`);
  }
  if ((opts.recentFailures?.length ?? 0) > 0) {
    lines.push("");
    lines.push("Recent failures:");
    for (const f of opts.recentFailures.slice(0, 5)) {
      const err = f.error ? ` — ${f.error.slice(0, 80)}` : "";
      lines.push(`  • ${f.slug}: ${f.status}${err}`);
    }
  }
  return lines.join("\n");
}

// Compose a crash-alert message. Dedup key = component+sig+service+
// stage so the same crash recurring every 5min doesn't spam.
export function buildCrashAlert(component, signature, opts = {}) {
  const lines = [];
  lines.push(`🚨 Harvester crash alert`);
  lines.push(`Component: ${component}`);
  lines.push(`Signature: ${signature}`);
  if (opts.service) lines.push(`Service: ${opts.service}`);
  if (opts.stage) lines.push(`Stage: ${opts.stage}`);
  if (opts.message) lines.push(`Message: ${opts.message.slice(0, 200)}`);
  if (opts.runId) lines.push(`Run: ${opts.runId}`);
  return lines.join("\n");
}
