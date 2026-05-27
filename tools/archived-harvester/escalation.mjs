// Persistent-environment escalation.
//
// Per design doc:
//   environment → digest entry only. If same (service, failure)
//   persists >7d, escalate to a regular GH issue (not PR) labeled
//   `harvester:investigate`.
//
// The escalation is the bridge between "subagent ignores environment
// failures forever" and "human notices a CF/captcha block has gone
// from transient to chronic." A captcha that fails once is environment
// noise; a captcha failing 3+ times over 7d is the upstream actively
// hardening and someone needs to investigate (proxy upgrade, GPU box
// for Phase 5, accept the service as off-limits, etc.).
//
// Idempotent via GitHub labels: we look for existing open issues with
// `harvester:investigate` + `service:<slug>` + `category:<cat>` before
// creating a new one. No separate state file — GitHub IS the state.
//
// Triggered from daily-digest.mjs once per day. Phase 3 may move this
// to a faster cadence (every halt) once we have a sense of false-
// positive rate.

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HALTS_DIR = join(homedir(), ".trusty-squire", "halts");

const DEFAULT_WINDOW_DAYS = 7;
const DEFAULT_MIN_OCCURRENCES = 3;

// Pure: groups halt reports by (service, failure_category), filters
// to environment-category, returns pairs that meet the persistence
// threshold (≥minOccurrences AND span ≥ windowDays/2 to confirm
// "persistent" rather than "burst in one hour"). The half-window
// span check filters out 5 captcha-blocked attempts in a 2-hour
// window — those are a burst, not a persistent issue.
export function findPersistentFailures(halts, opts = {}) {
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const minOccurrences = opts.minOccurrences ?? DEFAULT_MIN_OCCURRENCES;
  const minSpanMs = (windowDays * 86400000) / 2;
  const nowMs = opts.nowMs ?? Date.now();
  const cutoffMs = nowMs - windowDays * 86400000;

  // Group by (service, failure_category). Only environment-category.
  const groups = new Map();
  for (const h of halts) {
    if (h.failure_category !== "environment") continue;
    const ts = Date.parse(h.ts);
    if (!Number.isFinite(ts) || ts < cutoffMs) continue;
    const key = `${h.service}|${h.failure_category}`;
    if (!groups.has(key)) {
      groups.set(key, {
        service: h.service,
        category: h.failure_category,
        occurrences: [],
      });
    }
    groups.get(key).occurrences.push({
      ts: h.ts,
      bot_status: h.bot_status,
      error_message: h.error_message,
    });
  }

  // Filter by threshold + span.
  const persistent = [];
  for (const g of groups.values()) {
    if (g.occurrences.length < minOccurrences) continue;
    const tsMillis = g.occurrences.map((o) => Date.parse(o.ts));
    const span = Math.max(...tsMillis) - Math.min(...tsMillis);
    if (span < minSpanMs) continue;
    persistent.push(g);
  }
  return persistent;
}

// Read all halt reports from the configured directory, parsing each
// as JSON. Silently skips malformed files (we don't want one bad
// file to break the escalation pass).
export async function readAllHalts(haltsDir = HALTS_DIR) {
  try {
    const entries = await fs.readdir(haltsDir);
    const out = [];
    for (const name of entries) {
      if (!name.endsWith(".json")) continue;
      try {
        const raw = await fs.readFile(join(haltsDir, name), "utf8");
        out.push(JSON.parse(raw));
      } catch {
        // skip
      }
    }
    return out;
  } catch {
    return [];
  }
}

// Build the issue body for an escalation. Includes occurrence count,
// span, sample errors, and a pointer to the halt files so the
// operator can dig deeper.
export function buildEscalationIssueBody(group) {
  const tsMillis = group.occurrences.map((o) => Date.parse(o.ts));
  const oldest = new Date(Math.min(...tsMillis)).toISOString();
  const newest = new Date(Math.max(...tsMillis)).toISOString();
  const spanDays = Math.ceil(
    (Math.max(...tsMillis) - Math.min(...tsMillis)) / 86400000,
  );
  const statusCounts = new Map();
  for (const o of group.occurrences) {
    statusCounts.set(o.bot_status, (statusCounts.get(o.bot_status) ?? 0) + 1);
  }
  const lines = [];
  lines.push(
    `**Persistent ${group.category} failure** for \`${group.service}\` — ` +
      `${group.occurrences.length} attempts over ~${spanDays}d (since ${oldest.slice(0, 10)}).`,
  );
  lines.push("");
  lines.push(`First seen: ${oldest}`);
  lines.push(`Most recent: ${newest}`);
  lines.push("");
  lines.push(`### Bot status breakdown`);
  for (const [status, count] of statusCounts.entries()) {
    lines.push(`- \`${status}\`: ${count}`);
  }
  lines.push("");
  lines.push(`### Sample errors`);
  for (const o of group.occurrences.slice(0, 3)) {
    const err = o.error_message ? `: ${o.error_message.slice(0, 120)}` : "";
    lines.push(`- ${o.ts.slice(0, 16)} \`${o.bot_status}\`${err}`);
  }
  lines.push("");
  lines.push("### What to investigate");
  lines.push(
    `Environment failures persist when something upstream (anti-bot ` +
      `scoring, fingerprint, IP reputation, captcha gating) has actively ` +
      `hardened against the bot. Options:`,
  );
  lines.push("");
  lines.push("- Try the service from a residential proxy if not already");
  lines.push("- Try from a real-GPU machine (Phase 5 Mac harvester)");
  lines.push("- Accept the service as off-limits and add to services.yaml `status: skip`");
  lines.push("- Wait — sometimes anti-bot scoring relaxes over time");
  lines.push("");
  lines.push(
    `Raw halt reports: \`~/.trusty-squire/halts/*-${group.service}.json\``,
  );
  return lines.join("\n");
}

// Returns the labels an escalation issue MUST carry, so future
// lookups stay idempotent. Order matters less than presence.
export function escalationLabels(group) {
  return [
    "skill-harvester",
    "harvester:investigate",
    `service:${group.service}`,
    `category:${group.category}`,
  ];
}

// Compose the issue title. Same shape for every escalation so the
// operator can scan/filter.
export function escalationTitle(group) {
  return `[harvester:investigate] ${group.service} — persistent ${group.category} failures`;
}
