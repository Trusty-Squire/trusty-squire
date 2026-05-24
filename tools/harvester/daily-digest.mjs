#!/usr/bin/env node
// Daily-digest emitter — runs on its own systemd timer (e.g. 09:00
// local). Reads the harvester's state (backoff, budget, today's
// halt reports) and posts a summary to Telegram.
//
// Phase 1 omits GitHub-API integration (new-captures / closed-issues
// counts). Those come from `gh issue list --state closed --since 1d`
// in Phase 2 once the GH-issue de-dup work lands and we have a clean
// label vocabulary to filter on. The MVP digest is still useful: it
// covers what services attempted, what succeeded, what's in backoff,
// and the day's spend.
//
// Exits 0 on successful send, 1 on send failure (including no-token).
// The systemd unit's OnFailure= can hook Telegram crash alerts.

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  loadBackoffState,
  summarizeBackoffState,
} from "./backoff.mjs";
import {
  loadBudgetState,
  summarizeBudget,
  DEFAULT_BUDGET_USD,
} from "./budget.mjs";
import { sendMessage, buildDailyDigest } from "./telegram.mjs";

const HALTS_DIR = join(homedir(), ".trusty-squire", "halts");

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  const todayMs = Date.parse(`${today}T00:00:00Z`);

  const [backoff, budget] = await Promise.all([
    loadBackoffState(),
    loadBudgetState(today),
  ]);
  const halts = await readHaltsSince(todayMs);

  const summary = summarizeBackoffState(backoff);
  const nowMs = Date.now();

  const inBackoff = summary
    .filter((e) => e.backoff_until !== null && Date.parse(e.backoff_until) > nowMs)
    .map((e) => e.slug);

  const succeededToday = summary
    .filter((e) => e.last_success_at !== null && Date.parse(e.last_success_at) >= todayMs)
    .map((e) => e.slug);

  // Demoted = services whose consecutive_failures crossed threshold
  // today. We see this via halt-reports with consecutive_failures>=3.
  const demotedToday = dedupe(
    halts
      .filter((h) => (h.consecutive_failures ?? 0) >= 3)
      .map((h) => h.service),
  );

  const recentFailures = halts.slice(-5).reverse().map((h) => ({
    slug: h.service,
    status: h.bot_status,
    error: h.error_message,
  }));

  const cap = numericEnv("HARVESTER_DAILY_BUDGET_USD", DEFAULT_BUDGET_USD);
  const message = buildDailyDigest({
    date: today,
    budget: summarizeBudget(budget, cap),
    succeeded: succeededToday,
    demoted: demotedToday,
    newCaptures: [],
    inBackoff,
    recentFailures,
  });

  const ok = await sendMessage(message);
  process.exit(ok ? 0 : 1);
}

async function readHaltsSince(sinceMs) {
  try {
    const entries = await fs.readdir(HALTS_DIR);
    const out = [];
    for (const name of entries) {
      const full = join(HALTS_DIR, name);
      try {
        const stat = await fs.stat(full);
        if (!stat.isFile() || stat.mtimeMs < sinceMs) continue;
        const raw = await fs.readFile(full, "utf8");
        out.push(JSON.parse(raw));
      } catch {
        // skip unreadable/malformed entries
      }
    }
    return out.sort((a, b) => Date.parse(a.ts ?? 0) - Date.parse(b.ts ?? 0));
  } catch {
    return [];
  }
}

function dedupe(arr) {
  return [...new Set(arr)];
}

function numericEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

main().catch((err) => {
  console.error("daily-digest crashed:", err?.stack || err);
  process.exit(99);
});
