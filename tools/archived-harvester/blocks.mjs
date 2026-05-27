// External-block tagging — per design doc:
//   external_block → never opens a PR. Tags service with
//   blocked_reason: needs_phone | needs_payment | …
//   and blocked_until: <date + 30d>.
//   After cooldown, retries once; if still blocked, re-tags.
//
// We keep this state in a SIDECAR file rather than mutating
// services.yaml in place. services.yaml is operator-curated config
// (URLs, OAuth providers, scope hints) — rewriting it programatically
// would lose comment formatting and intent. State belongs in state
// files. Picker reads both:
//   - services.yaml = static config
//   - service-blocks.json = dynamic state
//
// Schema (~/.trusty-squire/service-blocks.json):
//   {
//     "vercel": {
//       "blocked_reason": "needs_phone",
//       "blocked_until": "2026-06-23T17:21:00Z",
//       "blocked_at": "2026-05-24T17:21:00Z",
//       "attempts_after_block": 0  // post-block retries (max 1)
//     },
//     ...
//   }

import { homedir } from "node:os";
import { join } from "node:path";
import { readJson, writeJsonAtomic } from "./state.mjs";

export const BLOCKS_STATE_PATH = join(
  homedir(),
  ".trusty-squire",
  "service-blocks.json",
);

const BLOCK_DURATION_DAYS = 30;
const POST_BLOCK_RETRY_CAP = 1;

export async function loadBlocksState() {
  return (await readJson(BLOCKS_STATE_PATH)) ?? {};
}

export async function saveBlocksState(state) {
  await writeJsonAtomic(BLOCKS_STATE_PATH, state);
}

// Pure. Derive a block "reason" key from the bot's final result.
// These are the keys subagent + operator can use to filter on
// "what blocks are upstream/operator territory."
//
// Returns null when the failure isn't external_block-shaped.
export function deriveBlockReason(final) {
  const status = final?.status ?? null;
  const error = String(final?.error ?? "").toLowerCase();

  if (status === "payment_required") return "needs_payment";
  if (status === "oauth_required") return "needs_oauth_provider_session";
  if (status === "needs_login") return "needs_login";
  if (status === "oauth_consent_needs_review") return "needs_oauth_consent_review";
  if (status === "onboarding_blocked") return "needs_onboarding_review";

  if (/phone[\s-]?verification|please verify your phone/.test(error)) {
    return "needs_phone";
  }
  if (/sms[\s-]?required/.test(error)) {
    return "needs_sms";
  }
  return null;
}

// Pure: returns new state with the block applied. Used by run.mjs
// after each external_block-classified failure. Resets the retry
// counter on a fresh block (different reason than what's already
// recorded → operator-meaningful change, treat as new).
export function recordBlock(state, slug, reason, nowMs = Date.now()) {
  const blockedUntilMs = nowMs + BLOCK_DURATION_DAYS * 24 * 60 * 60 * 1000;
  const prior = state[slug];
  const resetRetries =
    prior === undefined || prior.blocked_reason !== reason;
  return {
    ...state,
    [slug]: {
      blocked_reason: reason,
      blocked_at: new Date(nowMs).toISOString(),
      blocked_until: new Date(blockedUntilMs).toISOString(),
      attempts_after_block: resetRetries ? 0 : prior.attempts_after_block ?? 0,
    },
  };
}

// Pure: clear a service's block (used on successful signup or
// operator-initiated clear). Returns new state.
export function clearBlock(state, slug) {
  if (!(slug in state)) return state;
  const next = { ...state };
  delete next[slug];
  return next;
}

// Pure: returns { eligible: bool, reason: string }. The picker calls
// this alongside the backoff check. Block-policy:
//   - blocked_until in the future AND attempts_after_block >= cap
//     → ineligible
//   - blocked_until in the future AND retries available
//     → eligible (this is the "retry once after cooldown" rule;
//                  applies to the FIRST attempt after blocked_until
//                  passes, not during the window)
//
// Slight twist: during the window (blocked_until > now), we ALWAYS
// skip — the post-block retry happens AFTER blocked_until elapses.
export function isEligibleByBlock(state, slug, nowMs = Date.now()) {
  const entry = state[slug];
  if (entry === undefined) {
    return { eligible: true, reason: "no block recorded" };
  }
  const blockedUntilMs = Date.parse(entry.blocked_until);
  if (Number.isFinite(blockedUntilMs) && blockedUntilMs > nowMs) {
    const daysLeft = Math.ceil((blockedUntilMs - nowMs) / 86400000);
    return {
      eligible: false,
      reason: `external block (${entry.blocked_reason}) — ${daysLeft}d until retry`,
    };
  }
  // Cooldown elapsed. Allow one retry; subsequent attempts blocked
  // until something clears the entry.
  if ((entry.attempts_after_block ?? 0) >= POST_BLOCK_RETRY_CAP) {
    return {
      eligible: false,
      reason: `external block (${entry.blocked_reason}) — retried, still blocked; needs operator`,
    };
  }
  return {
    eligible: true,
    reason: `post-block retry (${entry.blocked_reason})`,
  };
}

// Pure: bump the post-block retry counter (called when the picker
// picks a post-block-retry attempt).
export function bumpPostBlockAttempts(state, slug) {
  const entry = state[slug];
  if (entry === undefined) return state;
  return {
    ...state,
    [slug]: {
      ...entry,
      attempts_after_block: (entry.attempts_after_block ?? 0) + 1,
    },
  };
}

// Diagnostic for digest.
export function listActiveBlocks(state, nowMs = Date.now()) {
  return Object.entries(state)
    .map(([slug, entry]) => ({ slug, ...entry }))
    .filter((entry) => {
      const blockedUntilMs = Date.parse(entry.blocked_until);
      return Number.isFinite(blockedUntilMs) && blockedUntilMs > nowMs;
    })
    .sort((a, b) => Date.parse(a.blocked_until) - Date.parse(b.blocked_until));
}
