// Daily $ budget cap for harvester LLM spend.
//
// The bot reports `llm_calls` count per signup; we estimate cost at
// the cheap-tier (Gemini Flash) rate of ~$0.0006/call. Premium-
// fallback (GPT-4o, Claude Sonnet) can be 10x but happens rarely on
// parse-failure; the conservative average across mixed runs lands
// near the cheap rate.
//
// When the day's estimated spend exceeds HARVESTER_DAILY_BUDGET_USD
// (default $5), the harvester halts globally. The global halt sentinel
// is set; subsequent timer ticks short-circuit until the operator
// clears it or the day rolls over (UTC midnight).
//
// State: ~/.trusty-squire/daily-budget.json
//   { "date": "2026-05-24", "llm_calls_total": N, "estimated_cost_usd": F, "attempts": N }
// Reset semantics: when current date != stored date, the file is
// rotated (stored → daily-budget-<prev-date>.json for audit) and a
// fresh row begins.

import { homedir } from "node:os";
import { join } from "node:path";
import { readJson, writeJsonAtomic } from "./state.mjs";

export const DAILY_BUDGET_PATH = join(
  homedir(),
  ".trusty-squire",
  "daily-budget.json",
);

// Cheap-tier per-call rate. Conservative — premium fallback (GPT-4o,
// Sonnet) is ~10x but rare on parse-failure.
const COST_PER_CALL_USD = 0.0006;

export const DEFAULT_BUDGET_USD = 5.0;

function todayUtcIso() {
  return new Date().toISOString().slice(0, 10);
}

function freshState(date) {
  return {
    date,
    llm_calls_total: 0,
    estimated_cost_usd: 0,
    attempts: 0,
  };
}

// Load today's budget state. If the stored date is stale (different
// day), returns a fresh state — the caller persists via
// saveBudgetState. Phase 1 doesn't bother rotating the prior day's
// file; Phase 2 can add rotation when we want longer audit.
export async function loadBudgetState(today = todayUtcIso()) {
  const stored = await readJson(DAILY_BUDGET_PATH);
  if (stored === null || stored.date !== today) {
    return freshState(today);
  }
  return stored;
}

export async function saveBudgetState(state) {
  await writeJsonAtomic(DAILY_BUDGET_PATH, state);
}

// Pure: returns a new state with the attempt's cost added.
export function recordCallsToday(state, llmCalls, today = todayUtcIso()) {
  // Date rolled over since load — discard prior, start fresh. (Caller
  // already loaded a same-day state in the common case; this guards
  // long-running processes that span midnight.)
  const base = state.date === today ? state : freshState(today);
  const calls = typeof llmCalls === "number" && llmCalls > 0 ? llmCalls : 0;
  return {
    ...base,
    llm_calls_total: base.llm_calls_total + calls,
    estimated_cost_usd: round((base.llm_calls_total + calls) * COST_PER_CALL_USD),
    attempts: base.attempts + 1,
  };
}

// Returns { over: bool, reason?: string }. Pure.
export function isOverBudget(state, capUsd = DEFAULT_BUDGET_USD) {
  if (state.estimated_cost_usd >= capUsd) {
    return {
      over: true,
      reason: `daily LLM spend (~$${state.estimated_cost_usd.toFixed(2)}) >= cap ($${capUsd.toFixed(2)}) — ${state.attempts} attempts, ${state.llm_calls_total} LLM calls`,
    };
  }
  return { over: false };
}

// Diagnostic for digest / step logging.
export function summarizeBudget(state, capUsd = DEFAULT_BUDGET_USD) {
  const pct = capUsd > 0 ? Math.round((state.estimated_cost_usd / capUsd) * 100) : 0;
  return `daily budget: ~$${state.estimated_cost_usd.toFixed(2)} / $${capUsd.toFixed(2)} (${pct}%) — ${state.attempts} attempts, ${state.llm_calls_total} LLM calls`;
}

function round(n) {
  return Math.round(n * 10000) / 10000;
}
