// Per-service backoff + 24h quota tracker.
//
// Replaces the prior "global halt at 3 consecutive failures" primitive
// (which let one flaky service stall the whole queue — codex called
// this out during the eng review). Now each service has its own state
// and the queue picker skips services that recently attempted OR are
// in backoff.
//
// State file: ~/.trusty-squire/backoff-state.json
//   {
//     "<slug>": {
//       "consecutive_failures": <int>,
//       "last_attempt_at": "<iso8601>",
//       "last_success_at": "<iso8601 | null>",
//       "backoff_until": "<iso8601 | null>"
//     },
//     ...
//   }
//
// Rules (Phase 1):
//   - QUOTA: any attempt within COOLDOWN_HOURS of last_attempt_at →
//     skip. Looks human-scale to upstream services (no more than
//     one signup attempt per service per day from this IP).
//   - BACKOFF: after BACKOFF_THRESHOLD consecutive failures on a
//     single service → mark backoff_until = now + BACKOFF_EXTRA_HOURS.
//     While backoff_until is in the future, skip regardless of
//     last_attempt_at.
//   - HARVESTER_FORCE_SERVICE bypasses both checks (operator override
//     for targeted validation).
//
// Phase 2+ may add finer-grained policy (per-classification backoff,
// permanent skip after N total failures, etc.). The data structure
// is forward-compatible.

import { homedir } from "node:os";
import { join } from "node:path";
import { readJson, writeJsonAtomic } from "./state.mjs";

export const BACKOFF_STATE_PATH = join(
  homedir(),
  ".trusty-squire",
  "backoff-state.json",
);

const COOLDOWN_HOURS = 24;
const BACKOFF_THRESHOLD = 3;
const BACKOFF_EXTRA_HOURS = 24;

export async function loadBackoffState() {
  return (await readJson(BACKOFF_STATE_PATH)) ?? {};
}

export async function saveBackoffState(state) {
  await writeJsonAtomic(BACKOFF_STATE_PATH, state);
}

// Pure: returns a new state with the attempt recorded. Caller persists
// via saveBackoffState. Outcome is the harvester's classification
// output ("replay-ok", "failed", "needs-manual", "skill-replay-failed",
// "promotion-only", …).
//
// "replay-ok" resets the consecutive counter and lifts any backoff.
// Anything else increments and may trigger a backoff.
export function recordAttempt(state, slug, outcome, nowMs = Date.now()) {
  const nowIso = new Date(nowMs).toISOString();
  const prior = state[slug] ?? {
    consecutive_failures: 0,
    last_attempt_at: null,
    last_success_at: null,
    backoff_until: null,
  };
  const next = { ...prior, last_attempt_at: nowIso };
  if (outcome === "replay-ok") {
    next.consecutive_failures = 0;
    next.last_success_at = nowIso;
    next.backoff_until = null;
  } else {
    next.consecutive_failures = prior.consecutive_failures + 1;
    if (next.consecutive_failures >= BACKOFF_THRESHOLD) {
      next.backoff_until = new Date(
        nowMs + BACKOFF_EXTRA_HOURS * 3600 * 1000,
      ).toISOString();
    }
  }
  return { ...state, [slug]: next };
}

// Returns { eligible: bool, reason: string }. Pure — reads state, no IO.
//
// Order of checks:
//   1. Service never attempted → eligible
//   2. backoff_until is in the future → not eligible (consecutive
//      failures triggered the longer pause)
//   3. last_attempt_at within COOLDOWN_HOURS → not eligible (quota)
//   4. Otherwise → eligible
export function isEligibleByBackoff(state, slug, nowMs = Date.now()) {
  const entry = state[slug];
  if (entry === undefined || entry.last_attempt_at === null) {
    return { eligible: true, reason: "no prior attempt" };
  }
  if (entry.backoff_until !== null) {
    const backoffMs = Date.parse(entry.backoff_until);
    if (Number.isFinite(backoffMs) && backoffMs > nowMs) {
      const hoursLeft = Math.ceil((backoffMs - nowMs) / 3600 / 1000);
      return {
        eligible: false,
        reason: `in backoff for ${hoursLeft}h more (${entry.consecutive_failures} consecutive failures)`,
      };
    }
  }
  const lastMs = Date.parse(entry.last_attempt_at);
  if (Number.isFinite(lastMs)) {
    const sinceMs = nowMs - lastMs;
    if (sinceMs < COOLDOWN_HOURS * 3600 * 1000) {
      const hoursLeft = Math.ceil(
        (COOLDOWN_HOURS * 3600 * 1000 - sinceMs) / 3600 / 1000,
      );
      return {
        eligible: false,
        reason: `cooldown — ${hoursLeft}h until next attempt allowed`,
      };
    }
  }
  return { eligible: true, reason: "cooldown elapsed" };
}

// Diagnostic: returns a summary of every service's state, sorted by
// last_attempt_at desc. Used by the daily digest.
export function summarizeBackoffState(state) {
  const entries = Object.entries(state).map(([slug, s]) => ({
    slug,
    ...s,
  }));
  entries.sort((a, b) => {
    const aMs = a.last_attempt_at ? Date.parse(a.last_attempt_at) : 0;
    const bMs = b.last_attempt_at ? Date.parse(b.last_attempt_at) : 0;
    return bMs - aMs;
  });
  return entries;
}
