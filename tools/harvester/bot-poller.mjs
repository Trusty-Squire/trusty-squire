#!/usr/bin/env node
// Interactive Telegram bot for the harvester. Long-polls
// /getUpdates and responds to a small command vocabulary:
//
//   /status   — overview (next tick, halted?, queue, today's spend)
//   /last     — most recent signup attempt result
//   /next     — when next tick fires + which service is next
//   /queue    — per-service backoff state (last attempt, failures)
//   /halt     — trip the halt sentinel (manual circuit-break)
//   /unhalt   — clear the halt sentinel
//   /help     — list commands
//
// Anti-spam: only responds to the registered chat_id (the operator
// who first /started the bot, persisted to ~/.trusty-squire/
// telegram-chat-id). Every other chat is silently ignored.
//
// Designed for one process under systemd user units. Long-poll
// with 30s timeout — Telegram holds the request open until an
// update arrives or the timeout hits, so this is cheap.

import { promises as fs } from "node:fs";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { CHAT_ID_PATH } from "./telegram.mjs";

const API_BASE = "https://api.telegram.org";
const LONG_POLL_TIMEOUT = 30; // seconds

const HOME = homedir();
const HALTED_FILE = join(HOME, ".trusty-squire", "harvester-halted");
const COUNTER_FILE = join(HOME, ".trusty-squire", "harvester-consecutive-failures");
const BACKOFF_FILE = join(HOME, ".trusty-squire", "backoff-state.json");
const BUDGET_FILE = join(HOME, ".trusty-squire", "daily-budget.json");
const BLOCKS_FILE = join(HOME, ".trusty-squire", "service-blocks.json");
const SERVICES_YAML = join(import.meta.dirname ?? ".", "services.yaml");

// ── helpers ────────────────────────────────────────────────────────

function readJsonSync(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function readTextSync(path) {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}

async function loadRegisteredChatId() {
  try {
    const raw = await fs.readFile(CHAT_ID_PATH, "utf8");
    return Number(raw.trim());
  } catch {
    return null;
  }
}

function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

function fmtTimestamp(iso) {
  if (!iso) return "(never)";
  const ago = fmtDuration(Date.now() - Date.parse(iso));
  return `${ago} ago`;
}

// ── command handlers ───────────────────────────────────────────────

function cmdStatus() {
  const lines = ["📊 *harvester status*", ""];

  const halted = existsSync(HALTED_FILE);
  if (halted) {
    const since = readTextSync(HALTED_FILE) ?? "?";
    lines.push(`🛑 HALTED since ${since}`);
    lines.push(`   send \`/unhalt\` to resume`);
  } else {
    lines.push(`🟢 running`);
  }

  // Next tick from systemd
  try {
    const out = execSync(
      "systemctl --user list-timers harvester.timer --no-pager 2>&1 | awk 'NR==2{print $1, $2, $3, $4}'",
      { encoding: "utf8" },
    ).trim();
    if (out) lines.push(`⏱ next tick: ${out}`);
  } catch { /* skip */ }

  // Consecutive failures counter
  const counter = readTextSync(COUNTER_FILE);
  if (counter !== null) {
    lines.push(`⚠ consecutive failures: ${counter}/3 (halt at 3)`);
  }

  // Budget
  const budget = readJsonSync(BUDGET_FILE);
  if (budget) {
    lines.push(
      `💰 today: ${budget.attempts ?? 0} attempts, ` +
        `$${(budget.estimated_cost_usd ?? 0).toFixed(4)} spent, ` +
        `${budget.llm_calls_total ?? 0} LLM calls`,
    );
  }

  // Backoff summary
  const backoff = readJsonSync(BACKOFF_FILE) ?? {};
  const slugs = Object.keys(backoff);
  if (slugs.length > 0) {
    const inBackoff = slugs.filter((s) => {
      const e = backoff[s];
      return e?.backoff_until && Date.parse(e.backoff_until) > Date.now();
    });
    lines.push(
      `📋 ${slugs.length} services tracked, ${inBackoff.length} in backoff`,
    );
  }

  // Blocks
  const blocks = readJsonSync(BLOCKS_FILE) ?? {};
  if (Object.keys(blocks).length > 0) {
    lines.push(`🚫 ${Object.keys(blocks).length} external-blocked`);
  }

  lines.push("");
  lines.push(`send \`/last\` \`/next\` \`/queue\` \`/help\``);
  return lines.join("\n");
}

function cmdLast() {
  // Pull the most recent harvester.service entry from journalctl
  // and grep for the outcome line. Cheap (last few minutes).
  try {
    const out = execSync(
      `journalctl --user -u harvester.service --since '2 hours ago' --no-pager -o cat 2>&1 | grep -E '(outcome:|Signing up|Result:|Error:)' | tail -10`,
      { encoding: "utf8" },
    ).trim();
    if (!out) return "📭 no signup attempts in the last 2 hours.";
    return "📋 *last attempt log:*\n```\n" + out.slice(0, 1800) + "\n```";
  } catch (err) {
    return `❌ couldn't read journal: ${err.message}`;
  }
}

function cmdNext() {
  try {
    const out = execSync(
      "systemctl --user list-timers harvester.timer --no-pager 2>&1",
      { encoding: "utf8" },
    ).trim();
    return "⏱ *next ticks:*\n```\n" + out.slice(0, 1500) + "\n```";
  } catch (err) {
    return `❌ ${err.message}`;
  }
}

function cmdQueue() {
  const backoff = readJsonSync(BACKOFF_FILE) ?? {};
  const blocks = readJsonSync(BLOCKS_FILE) ?? {};
  const slugs = Object.keys(backoff);
  if (slugs.length === 0) return "📭 no service state yet.";

  const lines = ["📋 *per-service state:*"];
  for (const slug of slugs.sort()) {
    const e = backoff[slug];
    const block = blocks[slug];
    const fails = e?.consecutive_failures ?? 0;
    const last = fmtTimestamp(e?.last_attempt_at);
    const success = e?.last_success_at
      ? `✓ ${fmtTimestamp(e.last_success_at)}`
      : "✗ never";
    const inBackoff =
      e?.backoff_until && Date.parse(e.backoff_until) > Date.now()
        ? ` 🕒 backoff until ${e.backoff_until}`
        : "";
    const blocked = block ? ` 🚫 ${block.reason}` : "";
    lines.push(
      `• \`${slug}\` — fails:${fails} last:${last} success:${success}${inBackoff}${blocked}`,
    );
  }
  return lines.join("\n");
}

function cmdHalt() {
  if (existsSync(HALTED_FILE)) {
    return "🛑 already halted.";
  }
  try {
    writeFileSync(HALTED_FILE, new Date().toISOString(), "utf8");
    return "🛑 halt sentinel created. subsequent ticks will skip until `/unhalt`.";
  } catch (err) {
    return `❌ couldn't halt: ${err.message}`;
  }
}

function cmdUnhalt() {
  if (!existsSync(HALTED_FILE)) {
    return "🟢 not halted — nothing to clear.";
  }
  try {
    unlinkSync(HALTED_FILE);
    // Also reset the consecutive-failures counter so the breaker
    // doesn't immediately re-trip on the next failure.
    try { writeFileSync(COUNTER_FILE, "0", "utf8"); } catch { /* ok */ }
    return "🟢 halt cleared. consecutive-failures counter reset. next tick will run.";
  } catch (err) {
    return `❌ couldn't unhalt: ${err.message}`;
  }
}

function cmdHelp() {
  return [
    "*harvester bot — commands*",
    "",
    "/status — overview (halted?, next tick, today's spend)",
    "/last — most recent signup attempt log",
    "/next — upcoming timer ticks",
    "/queue — per-service backoff + block state",
    "/halt — trip the halt sentinel manually",
    "/unhalt — clear the halt sentinel + reset failure counter",
    "/help — this message",
    "",
    "every harvester tick also posts a one-line report here.",
  ].join("\n");
}

const COMMANDS = {
  "/status": cmdStatus,
  "/last": cmdLast,
  "/next": cmdNext,
  "/queue": cmdQueue,
  "/halt": cmdHalt,
  "/unhalt": cmdUnhalt,
  "/help": cmdHelp,
  "/start": cmdHelp, // on first /start, send the help message
};

// ── Telegram I/O ───────────────────────────────────────────────────

async function send(token, chatId, text) {
  try {
    const res = await fetch(`${API_BASE}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      process.stderr.write(
        `[bot] sendMessage HTTP ${res.status}: ${await res.text()}\n`,
      );
    }
  } catch (err) {
    process.stderr.write(`[bot] send failed: ${err.message}\n`);
  }
}

async function longPoll(token, offset) {
  const url = `${API_BASE}/bot${token}/getUpdates?timeout=${LONG_POLL_TIMEOUT}` +
    (offset !== undefined ? `&offset=${offset}` : "");
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`getUpdates HTTP ${res.status}`);
  }
  const json = await res.json();
  if (!json.ok) {
    throw new Error(`getUpdates error: ${JSON.stringify(json)}`);
  }
  return json.result;
}

// ── main loop ──────────────────────────────────────────────────────

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error("TELEGRAM_BOT_TOKEN not set — bot can't start.");
    process.exit(1);
  }
  const allowedChatId = await loadRegisteredChatId();
  if (allowedChatId === null || Number.isNaN(allowedChatId)) {
    console.error(
      `No registered chat_id at ${CHAT_ID_PATH} — send /start to the bot first.`,
    );
    process.exit(1);
  }

  console.log(`harvester-bot starting — allowed chat_id ${allowedChatId}`);

  let offset; // next update_id to fetch
  for (;;) {
    let updates;
    try {
      updates = await longPoll(token, offset);
    } catch (err) {
      console.error(`[bot] poll failed: ${err.message} — sleeping 10s`);
      await new Promise((r) => setTimeout(r, 10_000));
      continue;
    }

    for (const update of updates) {
      offset = update.update_id + 1;
      const msg = update.message;
      if (!msg || typeof msg.text !== "string") continue;
      // Anti-spam: ignore every chat except the registered operator
      if (msg.chat?.id !== allowedChatId) {
        console.log(
          `[bot] ignoring message from unauthorized chat_id=${msg.chat?.id}`,
        );
        continue;
      }
      // Extract command (strip bot-username suffix for group chats)
      const raw = msg.text.trim().split(/\s+/)[0];
      const cmd = raw.split("@")[0].toLowerCase();
      const handler = COMMANDS[cmd];
      let reply;
      if (handler) {
        try {
          reply = handler();
        } catch (err) {
          reply = `❌ \`${cmd}\` errored: ${err.message}`;
        }
      } else {
        reply = `unknown command \`${cmd}\` — send /help for the list.`;
      }
      await send(token, allowedChatId, reply);
    }
  }
}

main().catch((err) => {
  console.error(`[bot] fatal: ${err?.stack ?? err}`);
  process.exit(1);
});
