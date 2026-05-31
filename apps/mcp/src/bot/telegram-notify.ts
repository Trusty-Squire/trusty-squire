// Telegram fallback for heightened-auth alerts.
//
// The API's /v1/notify/heightened-auth fires an email via Gmail SMTP
// authed as the operator's gmail. When GMAIL_USER == account.email
// (the housekeeper case where the operator and the only paired user
// are the same gmail account), Gmail collapses the self-send to the
// Sent folder and it never reaches the Inbox. The user never sees
// the digit.
//
// This module sends the digit to a Telegram bot/chat directly from
// the bot, bypassing email entirely. Opt-in via TELEGRAM_BOT_TOKEN
// in the bot's env — when unset, this module is a no-op and the
// email path is the only delivery channel. The housekeeper's
// env already sets the token, so the housekeeper run is
// covered automatically.
//
// chat_id resolution mirrors the harvester's tools/archived-harvester/
// telegram.mjs: read ~/.trusty-squire/telegram-chat-id.txt (cached
// from the first /start), fall back to getUpdates if absent, persist
// the discovered id. Sharing the cache file with the housekeeper means
// no extra one-time setup for the bot-side path on machines where
// the housekeeper already runs.

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";

const TELEGRAM_API = "https://api.telegram.org";
const CHAT_ID_PATH = join(homedir(), ".trusty-squire", "telegram-chat-id.txt");
const MAX_MESSAGE_LEN = 4096;

export interface TelegramHeightenedAuthInput {
  service: string;
  digit: string | null;
  windowSeconds: number;
}

// Fire-and-forget. Returns true on POST success, false on any failure
// (missing token, missing chat id, HTTP error). Never throws.
export async function sendTelegramHeightenedAuth(
  input: TelegramHeightenedAuthInput,
): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (token === undefined || token.length === 0) return false;
  const chatId = await resolveChatId(token);
  if (chatId === null) return false;
  const text = formatMessage(input);
  return await postSendMessage(token, chatId, text);
}

// Exported for unit testing.
export function formatMessage(input: TelegramHeightenedAuthInput): string {
  if (input.digit !== null) {
    return (
      `🔐 Google number-match on ${input.service}\n\n` +
      `Tap *${input.digit}* on your phone — ${input.windowSeconds}-second window.\n\n` +
      `(Trusty Squire bot mid-OAuth handshake.)`
    );
  }
  return (
    `🔐 Google challenge on ${input.service}\n\n` +
    `A number-match prompt was detected but the bot couldn't read the digit. ` +
    `Open the Google app on your phone, then tap the number the prompt shows — ` +
    `${input.windowSeconds}-second window.\n\n` +
    `(Trusty Squire bot mid-OAuth handshake.)`
  );
}

async function resolveChatId(token: string): Promise<number | null> {
  // Env override wins. Lets the operator pin a specific chat
  // (group/channel) without depending on the cache file, and gives
  // tests a clean injection point.
  const envChatId = process.env.TELEGRAM_CHAT_ID;
  if (envChatId !== undefined && envChatId.length > 0) {
    const n = Number(envChatId);
    if (Number.isFinite(n)) return n;
  }
  const cached = loadCachedChatId();
  if (cached !== null) return cached;
  const fromUpdates = await fetchChatIdFromUpdates(token);
  if (fromUpdates !== null) persistChatId(fromUpdates);
  return fromUpdates;
}

function loadCachedChatId(): number | null {
  try {
    if (!existsSync(CHAT_ID_PATH)) return null;
    const raw = readFileSync(CHAT_ID_PATH, "utf8").trim();
    const id = Number(raw);
    return Number.isFinite(id) ? id : null;
  } catch {
    return null;
  }
}

function persistChatId(id: number): void {
  try {
    mkdirSync(join(homedir(), ".trusty-squire"), { recursive: true });
    writeFileSync(CHAT_ID_PATH, `${id}\n`);
  } catch {
    // Non-fatal; next call will re-fetch.
  }
}

async function fetchChatIdFromUpdates(token: string): Promise<number | null> {
  try {
    const res = await fetch(`${TELEGRAM_API}/bot${token}/getUpdates`);
    if (!res.ok) return null;
    const body = (await res.json()) as {
      ok?: boolean;
      result?: Array<{
        message?: { chat?: { id?: number } };
        channel_post?: { chat?: { id?: number } };
      }>;
    };
    if (body.ok !== true || !Array.isArray(body.result)) return null;
    for (let i = body.result.length - 1; i >= 0; i--) {
      const u = body.result[i];
      const id = u?.message?.chat?.id ?? u?.channel_post?.chat?.id;
      if (typeof id === "number") return id;
    }
    return null;
  } catch {
    return null;
  }
}

async function postSendMessage(
  token: string,
  chatId: number,
  text: string,
): Promise<boolean> {
  try {
    const truncated =
      text.length <= MAX_MESSAGE_LEN
        ? text
        : text.slice(0, MAX_MESSAGE_LEN - 32) + "\n…[truncated]";
    const res = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: truncated,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
