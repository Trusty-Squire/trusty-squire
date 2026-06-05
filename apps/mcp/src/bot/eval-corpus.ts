// eval-corpus.ts — the committed, redacted eval corpus for the post-OAuth
// navigation planner (docs/DESIGN-planner-navigation-eval.md, Workstream A).
//
// DEV HARNESS, not shipped (excluded from the published build in
// tsconfig.build.json, like eval-onboarding.ts / eval-planner.ts).
//
// Two sets, two jobs (the "two-set semantics" guardrail):
//   • regress/  — auto-derived from SUCCESSFUL captures' gold paths
//                 (build-corpus.ts). UNION of observed step KINDS across all
//                 successful runs of an equivalent page = acceptKinds; KINDS
//                 that left a FAILED run stuck (and were never good elsewhere)
//                 = rejectKinds. Reject-driven so it stops regressions without
//                 blocking a better route (R1). The merge-gate must stay 100%.
//   • target/   — hand-labeled N1 stuck pages (the generalization signal).
//                 {tune, holdout} split; report macro-avg lift, never tune on
//                 holdout (R5).
//
// Scoring reuses the EXISTING `scoreOnboardingStep` (pure, unit-tested). This
// module only adds the on-disk case shape, a loader, and a bucketed gate.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  scoreOnboardingStep,
  type OnboardingEvalCase,
  type OnboardingExpectation,
  type OnboardingScore,
} from "./eval-onboarding.js";
import type { PostVerifyStep } from "./agent.js";

export type EvalSet = "regress" | "target";
export type EvalSource = "gold_path" | "human" | "llm_proposed_human_confirmed";

// On-disk case: an OnboardingEvalCase (state + inventory + expect that the
// existing scorer understands) plus the provenance fields the gate buckets on.
export interface EvalCaseFile extends OnboardingEvalCase {
  id: string;
  set: EvalSet;
  source: EvalSource;
  // target/ cases are further split so inspection of `tune` never leaks into
  // the sealed `holdout` measurement (R5). Absent for regress.
  holdout?: boolean;
}

// Repo-committed corpus root: apps/mcp/corpus/eval/. The builder writes
// regress/ here; humans curate target/{tune,holdout}/ here.
export const EVAL_CORPUS_ROOT = fileURLToPath(
  new URL("../../corpus/eval", import.meta.url),
);

function readCasesFrom(dir: string, set: EvalSet, holdout?: boolean): EvalCaseFile[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return []; // a missing set dir is fine — target/ may not exist yet
  }
  const out: EvalCaseFile[] = [];
  for (const f of files) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, f), "utf8")) as Record<string, unknown>;
      const exp = raw["expect"];
      if (exp === null || exp === undefined || typeof exp !== "object") continue;
      if (typeof raw["state"] !== "object" || !Array.isArray(raw["inventory"])) continue;
      out.push({
        ...(raw as unknown as EvalCaseFile),
        set,
        ...(holdout !== undefined ? { holdout } : {}),
      });
    } catch {
      console.error(`[eval-corpus] skipped malformed case: ${join(dir, f)}`);
    }
  }
  return out;
}

// Load every committed eval case, bucketed by set. `root` override lets the
// builder/tests point at a scratch dir.
export function loadEvalCorpus(root: string = EVAL_CORPUS_ROOT): {
  regress: EvalCaseFile[];
  targetTune: EvalCaseFile[];
  targetHoldout: EvalCaseFile[];
} {
  return {
    regress: readCasesFrom(join(root, "regress"), "regress"),
    targetTune: readCasesFrom(join(root, "target", "tune"), "target", false),
    targetHoldout: readCasesFrom(join(root, "target", "holdout"), "target", true),
  };
}

export interface GateBucketResult {
  passed: number;
  total: number;
  failures: Array<{ id: string; service: string; detail: string }>;
}

// Score one bucket of cases with a plan function. The plan function is the
// real planner at temp 0 in the live runner, or a deterministic fake in
// tests. Pure given its inputs.
export async function scoreBucket(
  cases: readonly EvalCaseFile[],
  plan: (c: EvalCaseFile) => Promise<PostVerifyStep>,
): Promise<GateBucketResult> {
  let passed = 0;
  const failures: GateBucketResult["failures"] = [];
  for (const c of cases) {
    let score: OnboardingScore;
    try {
      const step = await plan(c);
      score = scoreOnboardingStep(step, c.expect as OnboardingExpectation);
    } catch (err) {
      score = { pass: false, detail: err instanceof Error ? err.message : String(err) };
    }
    if (score.pass) passed += 1;
    else failures.push({ id: c.id, service: c.service, detail: score.detail });
  }
  return { passed, total: cases.length, failures };
}

// The gate's verdict: the REGRESS bucket must be perfect. Target buckets are
// reported for the lift signal but never block (they measure generalization,
// not regression).
export function regressGatePassed(regress: GateBucketResult): boolean {
  return regress.passed === regress.total;
}
