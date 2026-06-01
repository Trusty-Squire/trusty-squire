// T44 — compatibility score derivation. Pure math, unit-tested.
// Inputs: a recent slice of ProvisionEvent rows for one service.
// Output: a single signed score (positive = healthy, negative =
// struggling/blocked) and the four-state classification used by the
// MCP recommendation engine.

import type { ProvisionEventRecord } from "./provision-event-store.js";

export interface CompatScoreOptions {
  /** Half-life of an attempt's weight. A failure 14d ago contributes
   *  half as much as a failure today. */
  halfLifeDays?: number;
  /** Score < this → "hard-block". */
  hardBlockThreshold?: number;
  /** Score in [hardBlockThreshold, strugglingCeiling] → "struggling".
   *  Score > strugglingCeiling AND no skill → "working". */
  strugglingCeiling?: number;
  /** "Now" for the calculation. Pure-function knob for tests. */
  now?: number;
}

const DEFAULTS = {
  halfLifeDays: 14,
  hardBlockThreshold: -2,
  strugglingCeiling: 0,
};

export type CompatState = "skill-active" | "working" | "struggling" | "hard-block";

export interface CompatHealth {
  state: CompatState;
  compat_score: number;
  successful_count: number;
  failed_count: number;
  last_attempt_at: string | null;
}

export function deriveCompatScore(
  attempts: readonly ProvisionEventRecord[],
  opts: CompatScoreOptions = {},
): number {
  const halfLife = (opts.halfLifeDays ?? DEFAULTS.halfLifeDays) * 86_400_000;
  const now = opts.now ?? Date.now();
  let score = 0;
  for (const a of attempts) {
    const age = now - a.occurred_at.getTime();
    // 2 ** (-age/halfLife) decays cleanly: age=0 → 1.0, age=halfLife → 0.5.
    const weight = Math.pow(0.5, age / halfLife);
    score += a.status === "success" ? weight : -weight;
  }
  return score;
}

export function classifyCompat(
  score: number,
  hasActiveSkill: boolean,
  opts: CompatScoreOptions = {},
): CompatState {
  if (hasActiveSkill) return "skill-active";
  const hardBlock = opts.hardBlockThreshold ?? DEFAULTS.hardBlockThreshold;
  const strugglingCeiling = opts.strugglingCeiling ?? DEFAULTS.strugglingCeiling;
  if (score < hardBlock) return "hard-block";
  if (score <= strugglingCeiling) return "struggling";
  return "working";
}

export function buildCompatHealth(
  attempts: readonly ProvisionEventRecord[],
  hasActiveSkill: boolean,
  opts: CompatScoreOptions = {},
): CompatHealth {
  const compat_score = deriveCompatScore(attempts, opts);
  const state = classifyCompat(compat_score, hasActiveSkill, opts);
  let successful_count = 0;
  let failed_count = 0;
  let last: Date | null = null;
  for (const a of attempts) {
    if (a.status === "success") successful_count++;
    else failed_count++;
    if (last === null || a.occurred_at > last) last = a.occurred_at;
  }
  return {
    state,
    compat_score,
    successful_count,
    failed_count,
    last_attempt_at: last === null ? null : last.toISOString(),
  };
}
