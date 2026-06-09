// Telegram notifier — ported from tools/archived-harvester/telegram.mjs.
//
// Reads TELEGRAM_BOT_TOKEN from env. Resolves chat_id from the
// bot's getUpdates on first send and caches it to
// ~/.trusty-squire/telegram-chat-id.txt. Subsequent sends reuse
// the cached chat_id without round-tripping.
//
// Best-effort: a delivery failure is logged but doesn't break the
// housekeeper loop. When TELEGRAM_BOT_TOKEN is unset the notifier
// writes the formatted message to stderr instead — useful in
// dev/CI without wiring a token.

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { Notifier, NotifierEvent } from "./notifier.js";
import { formatObjectives } from "./notifier.js";

export const CHAT_ID_PATH = join(
  homedir(),
  ".trusty-squire",
  "telegram-chat-id.txt",
);

const API_BASE = "https://api.telegram.org";
const TELEGRAM_MAX_MESSAGE_LEN = 4096;

export interface TelegramNotifierOpts {
  // Override TELEGRAM_BOT_TOKEN — useful for tests.
  token?: string;
  // Override the cached chat_id resolution — tests inject a fixed id.
  chatId?: number;
  // Fetch override (test mocks).
  fetchFn?: typeof globalThis.fetch;
  // Override the stderr writer (tests).
  write?: (line: string) => void;
}

export class TelegramNotifier implements Notifier {
  readonly name = "telegram";
  private cachedChatId: number | null = null;

  constructor(private readonly opts: TelegramNotifierOpts = {}) {}

  async notify(event: NotifierEvent): Promise<void> {
    const text = formatEvent(event);
    await this.send(text);
  }

  // Public for tests / one-off operator notifications.
  async send(text: string): Promise<boolean> {
    const token = this.opts.token ?? process.env.TELEGRAM_BOT_TOKEN;
    const write = this.opts.write ?? ((l: string) => process.stderr.write(l + "\n"));
    if (token === undefined || token === "") {
      write(`[telegram-notifier] (no TELEGRAM_BOT_TOKEN — printing instead)\n${text}`);
      return false;
    }
    let chatId = this.opts.chatId ?? this.cachedChatId;
    if (chatId === null || chatId === undefined) {
      const loaded = await loadChatId();
      if (loaded !== null) chatId = loaded;
    }
    if (chatId === null || chatId === undefined) {
      const resolved = await resolveChatIdFromUpdates(
        token,
        this.opts.fetchFn ?? globalThis.fetch,
      );
      if (resolved === null) {
        write(
          "[telegram-notifier] no chat_id known and getUpdates returned nothing — send /start to the bot and retry",
        );
        return false;
      }
      chatId = resolved;
      await persistChatId(chatId);
    }
    this.cachedChatId = chatId;
    return await postSendMessage(
      token,
      chatId,
      truncate(text),
      this.opts.fetchFn ?? globalThis.fetch,
    );
  }
}

// ── Public helpers (used by future operator notifications) ────────

export async function resolveChatIdFromUpdates(
  token: string,
  fetchFn: typeof globalThis.fetch,
): Promise<number | null> {
  try {
    const res = await fetchFn(`${API_BASE}/bot${token}/getUpdates`);
    if (!res.ok) return null;
    const json = (await res.json()) as {
      ok: boolean;
      result: Array<{ message?: { chat?: { id?: number } }; channel_post?: { chat?: { id?: number } } }>;
    };
    if (!json.ok || !Array.isArray(json.result) || json.result.length === 0) {
      return null;
    }
    for (let i = json.result.length - 1; i >= 0; i--) {
      const update = json.result[i];
      const chat = update?.message?.chat ?? update?.channel_post?.chat;
      if (chat !== undefined && typeof chat.id === "number") return chat.id;
    }
    return null;
  } catch {
    return null;
  }
}

// ── Formatting ────────────────────────────────────────────────────

function formatEvent(event: NotifierEvent): string {
  if (event.kind === "unknown_state") {
    // THE single escalation. Everything else the loop handles itself.
    return (
      `🚨 UNKNOWN STATE — ${event.service}\n` +
      `The bot hit a DOM/outcome it has never classified, ${event.attempts}× on the same page.\n` +
      `Kind: ${event.failure_kind}\n` +
      `URL: ${event.url ?? "?"}\n` +
      (event.trace_excerpt !== undefined
        ? `Trace:\n${event.trace_excerpt.slice(0, 500)}`
        : "") +
      `\n\nAdd a classifier branch for this state, then the loop handles it autonomously.`
    );
  }
  if (event.kind === "heal_digest") {
    // The two objective functions on their own line so the operator can
    // eyeball them rising run-over-run: OF#1 skills in the registry, OF#2
    // discovery success rate this pass.
    const obj = formatObjectives(event.objectives);
    const objLine = obj === "" ? "" : `\n📊${obj.replace(/^ · OBJECTIVES:/, "")}`;
    return (
      `🩺 Heal pass\n${event.summary}${objLine}` +
      (event.needs_human > 0
        ? `\n\n${event.needs_human} need a human — GET /admin/needs-human`
        : "")
    );
  }
  if (event.kind === "replay_outcome") {
    const emoji =
      event.outcome === "success"
        ? "✅"
        : event.outcome === "skipped"
          ? "⏭️"
          : "❌";
    // 0.8.2-rc.20 — always render the transition line, including
    // when it's `none`. Pre-fix we omitted it for transition=none,
    // which made failure messages look like state changes even when
    // they weren't ("Reason: skill_demoted..." reads as "the skill
    // got demoted" without a counter-signal). Always-rendered: every
    // alert tells the operator at a glance whether the registry
    // actually changed.
    const transitionLine =
      event.transition === "none"
        ? `\nTransition: none (no registry state change)`
        : `\nTransition: ${event.transition}`;
    return (
      `${emoji} Replay [${event.queue}] ${event.service}\n` +
      `Skill: ${event.service} (${event.skill_id.slice(0, 10)}…)\n` +
      `Outcome: ${event.outcome}${transitionLine}\n` +
      `Reason: ${event.reason.slice(0, 600)}`
    );
  }
  const emoji =
    event.outcome === "ok" ? "✅" : event.outcome === "blocked" ? "⛔" : "❌";
  const userLine =
    event.meta?.distinct_failures !== undefined
      ? `\nUsers hit: ${event.meta.distinct_failures} (top: ${event.meta.top_error_kind ?? "?"})`
      : "";
  return (
    `${emoji} Discover [${event.queue}] ${event.service}\n` +
    `Outcome: ${event.outcome}${userLine}\n` +
    `Reason: ${event.reason.slice(0, 600)}`
  );
}

function truncate(text: string): string {
  if (text.length <= TELEGRAM_MAX_MESSAGE_LEN) return text;
  return text.slice(0, TELEGRAM_MAX_MESSAGE_LEN - 16) + "\n…(truncated)";
}

// ── Internal helpers ──────────────────────────────────────────────

async function postSendMessage(
  token: string,
  chatId: number,
  text: string,
  fetchFn: typeof globalThis.fetch,
): Promise<boolean> {
  try {
    const res = await fetchFn(`${API_BASE}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function loadChatId(): Promise<number | null> {
  try {
    const raw = await readFile(CHAT_ID_PATH, "utf8");
    const n = Number(raw.trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

async function persistChatId(chatId: number): Promise<void> {
  try {
    await mkdir(join(homedir(), ".trusty-squire"), { recursive: true });
    await writeFile(CHAT_ID_PATH, `${chatId}\n`, { mode: 0o600 });
  } catch {
    // best-effort — if writing fails we just re-resolve next time
  }
}
