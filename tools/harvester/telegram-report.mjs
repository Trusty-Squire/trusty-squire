// Per-run Telegram reporter. Fires once per harvester tick — every
// tick, not just successful signups — so the operator sees what the
// 10-minute timer is actually doing.
//
// All sends are best-effort. A Telegram outage / no-token / no-chat
// must NOT turn a successful harvester tick into a failed exit.
//
// The reporter accepts a structured `tickReport` and renders a short
// message (<400 chars typical). Formats:
//
//   SIGNUP:    [emoji] <SERVICE>: <classification>
//              <one-line error/success summary>
//              issue: <gh url>
//
//   HALTED:    🛑 tick skipped — halt sentinel present (since <ts>)
//              clear: rm ~/.trusty-squire/harvester-halted
//
//   NO_ELIGIBLE: 💤 nothing to run — all services in backoff / cooldown
//
//   PREFLIGHT_FAIL: ⚠ preflight failed — <which check>

import { sendMessage } from "./telegram.mjs";

const EMOJI = {
  "replay-ok": "✅",
  "failed": "❌",
  "captcha-blocked": "🛡",
  "anti-bot-blocked": "🚫",
  "needs-login": "🔑",
  "needs-manual": "👤",
  "payment-required": "💳",
  "phone-required": "📱",
  "halted": "🛑",
  "no-eligible": "💤",
  "preflight-fail": "⚠",
};

const SIGNAL_PREFIX = "[harvester]"; // small visual prefix in the message

function emojiFor(classification) {
  return EMOJI[classification] ?? "•";
}

// Truncate to ~3 lines of an error string so the message stays scannable.
function shortError(error) {
  if (error === undefined || error === null) return "";
  const s = String(error).trim();
  if (s.length <= 220) return s;
  return s.slice(0, 217) + "…";
}

export function buildTickMessage(report) {
  const lines = [];
  const ts = new Date(report.ts ?? Date.now())
    .toISOString()
    .slice(11, 19); // HH:MM:SS UTC, brief

  switch (report.kind) {
    case "signup": {
      const emoji = emojiFor(report.classification);
      lines.push(
        `${emoji} *${report.service}* — \`${report.classification}\`  _${ts}Z_`,
      );
      if (report.errorOrSummary) {
        lines.push(shortError(report.errorOrSummary));
      }
      if (report.issueUrl) {
        lines.push(`issue: ${report.issueUrl}`);
      }
      if (report.attempt !== undefined) {
        lines.push(`attempt #${report.attempt}`);
      }
      break;
    }

    case "halted": {
      lines.push(`🛑 ${SIGNAL_PREFIX} tick skipped — halt sentinel present  _${ts}Z_`);
      if (report.haltedSince) {
        lines.push(`halted since: ${report.haltedSince}`);
      }
      lines.push(`clear: \`rm ~/.trusty-squire/harvester-halted\``);
      lines.push(`or send \`/unhalt\` to this bot.`);
      break;
    }

    case "no_eligible": {
      lines.push(`💤 ${SIGNAL_PREFIX} no eligible service  _${ts}Z_`);
      lines.push(
        `all services in 24h cooldown, backoff, or marked needs-manual.`,
      );
      break;
    }

    case "preflight_fail": {
      lines.push(`⚠ ${SIGNAL_PREFIX} preflight failed  _${ts}Z_`);
      lines.push(shortError(report.detail));
      break;
    }

    case "halt_tripped": {
      lines.push(`🛑 ${SIGNAL_PREFIX} circuit breaker TRIPPED  _${ts}Z_`);
      lines.push(
        `${report.failures} consecutive failures — sentinel created.`,
      );
      lines.push(`subsequent ticks will skip until cleared.`);
      break;
    }

    default:
      lines.push(`• ${SIGNAL_PREFIX} ${report.kind ?? "unknown"}  _${ts}Z_`);
  }

  return lines.join("\n");
}

// Send a tick report. Returns true on send, false on any failure
// (including no-token / no-chat). Never throws.
export async function reportTick(report) {
  try {
    const text = buildTickMessage(report);
    return await sendMessage(text, { parse_mode: "Markdown" });
  } catch {
    return false;
  }
}

// Convenience for the run.mjs call sites:
export const REPORT_KINDS = Object.freeze({
  SIGNUP: "signup",
  HALTED: "halted",
  NO_ELIGIBLE: "no_eligible",
  PREFLIGHT_FAIL: "preflight_fail",
  HALT_TRIPPED: "halt_tripped",
});

// Throttled halted-tick reporter. Fires at most once per hour while
// the halt sentinel is present, so the operator sees a periodic
// reminder without getting 6 messages an hour. State file tracks
// the last-sent timestamp.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HALTED_NOTIFY_STATE = join(
  homedir(),
  ".trusty-squire",
  "telegram-halted-notify.txt",
);
const HALTED_NOTIFY_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export async function maybeReportHaltedTick(haltedSince) {
  const lastMs = (() => {
    if (!existsSync(HALTED_NOTIFY_STATE)) return 0;
    try {
      return Number.parseInt(readFileSync(HALTED_NOTIFY_STATE, "utf8").trim(), 10) || 0;
    } catch { return 0; }
  })();
  const nowMs = Date.now();
  if (nowMs - lastMs < HALTED_NOTIFY_INTERVAL_MS) {
    return false;
  }
  const sent = await reportTick({
    kind: REPORT_KINDS.HALTED,
    haltedSince: haltedSince ?? "(unknown)",
    ts: nowMs,
  });
  if (sent) {
    try { writeFileSync(HALTED_NOTIFY_STATE, String(nowMs), "utf8"); } catch { /* ok */ }
  }
  return sent;
}
