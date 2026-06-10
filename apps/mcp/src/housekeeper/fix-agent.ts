// fix-agent.ts (C2) — the holistic fix-agent that automates A7 of the planner
// eval design: it consumes one FixBatch (C1), clusters the failures by root
// cause, proposes a GENERALIZING fix per cluster, reconciles each fix against
// the EXISTING eval gate until green, and commits surviving fixes to the
// `staging` (RC / `next`) channel. See docs/DESIGN-autonomous-output-loop.md.
//
// What this module owns is the CONTROL FLOW and the hard invariants — it is
// deterministic and unit-tested (the "dry-run harness"). The two model-driven
// seams are injected:
//   • FixProposer — proposes the actual code/prompt change (real impl shells to
//     a coding agent; tests pass a deterministic fake).
//   • GateRunner  — runs the eval gate (real impl = runEvalGate; tests fake it).
//
// Invariants enforced here (not trusted):
//   1. Only ever targets `staging` + a prerelease version (assertStagingPrerelease).
//      A `main`/stable shape is a hard stop — that channel is the human promote.
//   2. A fix may only touch `allowedPaths` (posture a: the gated post-OAuth-nav
//      surface). corpus/eval is ALWAYS forbidden — the agent can't grade its own
//      homework.
//   3. A fix commits ONLY when the gate's regress bucket stays 100% AND the
//      target-holdout didn't drop below the pre-fix baseline.
//   4. After maxAttemptsPerCluster (K=3) gate-red iterations, the cluster is
//      parked as a wall-candidate — the residual, never a pre-judged category.
//
// Operator-only (housekeeper/, excluded from the npm tarball).

import type { FailureStage } from "../bot/failure-stage.js";
import type { EvalGateResult } from "../bot/eval-gate.js";
import { assertStagingPrerelease, computeNextRc } from "./release-guard.js";
import type { FixBatch, FixBatchFailure } from "./fix-batch.js";

// Default give-up bound per cluster (decision: K = 3).
export const DEFAULT_MAX_ATTEMPTS = 3;

// Paths the agent may NEVER write, regardless of allowedPaths — the corpus is
// append-only-from-successes (build-corpus), never edited to make the gate pass.
export const FORBIDDEN_PATH_FRAGMENTS = ["corpus/eval"] as const;

// A cluster of failures sharing a root cause: same failure_stage + page
// signature. The unit of fixing — one generalizing change per cluster, not one
// patch per service.
export interface FixCluster {
  id: string;
  failure_stage: FailureStage;
  signature: string;
  services: string[];
  failures: FixBatchFailure[];
  // Union of capture refs across the cluster — the fix-agent's evidence.
  capture_refs: string[];
}

// A proposed fix for a cluster. The orchestrator only needs the touched paths
// (to enforce posture a) and apply/revert hooks; the proposer owns HOW.
export interface FixProposal {
  summary: string;
  touched_paths: string[];
  apply: () => Promise<void>;
  revert: () => Promise<void>;
}

// Thrown by a proposer when it concludes a cluster is a GENUINE wall — a
// concrete infra reason no code change beats (real phone / card / IP-rep). This
// is the residual a fix attempt earns, not a category picked up front.
export class WallError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = "WallError";
  }
}

// Propose a fix for a cluster (or null = "nothing this attempt"). Throw a
// WallError to park it as a genuine wall with a concrete reason.
export type FixProposer = (
  cluster: FixCluster,
  attempt: number,
  priorFeedback: string | undefined,
) => Promise<FixProposal | null>;

// Run the eval gate and return the verdict.
export type GateRunner = () => Promise<EvalGateResult>;

// Commit a green fix to staging with the bumped RC version.
export type Committer = (input: {
  cluster: FixCluster;
  proposal: FixProposal;
  version: string;
}) => Promise<void>;

export interface FixAgentOpts {
  batch: FixBatch;
  propose: FixProposer;
  gate: GateRunner;
  commit: Committer;
  branch: string;
  currentVersion: string;
  // Posture (a): the gated surfaces the agent may touch. A proposal touching
  // anything outside these (or under corpus/eval) is parked, never committed.
  allowedPaths: readonly string[];
  maxAttemptsPerCluster?: number;
  log?: (line: string) => void;
}

export interface WallCandidate {
  cluster_id: string;
  failure_stage: FailureStage;
  services: string[];
  signature: string;
  attempts: number;
  reason: string;
}

export interface FixAgentResult {
  committed: Array<{ cluster_id: string; version: string; summary: string }>;
  walls: WallCandidate[];
  parked: Array<{ cluster_id: string; reason: string; touched_paths: string[] }>;
}

// ── Clustering (pure) ───────────────────────────────────────────────
//
// Group failures by (failure_stage, signature). Failures that hit the SAME
// stuck page (same signature) cluster together even across services — that's
// the shared-root-cause case the holistic pass exists to catch. Same stage but
// a different page stays a separate cluster (likely a different fix).
export function clusterFailures(batch: FixBatch): FixCluster[] {
  const byKey = new Map<string, FixCluster>();
  for (const f of batch.failures) {
    const key = `${f.failure_stage}:${f.signature}`;
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, {
        id: key,
        failure_stage: f.failure_stage,
        signature: f.signature,
        services: [f.service],
        failures: [f],
        capture_refs: [...f.capture_refs],
      });
    } else {
      if (!existing.services.includes(f.service)) existing.services.push(f.service);
      existing.failures.push(f);
      for (const r of f.capture_refs) {
        if (!existing.capture_refs.includes(r)) existing.capture_refs.push(r);
      }
    }
  }
  // Biggest blast radius first: most services, then most failures.
  return [...byKey.values()].sort(
    (a, b) => b.services.length - a.services.length || b.failures.length - a.failures.length,
  );
}

// ── Path fence (pure) ───────────────────────────────────────────────
//
// A proposal is in-bounds iff every touched path is under an allowedPath AND
// none is under a forbidden fragment (corpus/eval). Returns the first
// out-of-bounds path, or null if the proposal is clean.
export function firstOutOfBoundsPath(
  touched: readonly string[],
  allowedPaths: readonly string[],
): string | null {
  for (const raw of touched) {
    const p = normalize(raw);
    if (FORBIDDEN_PATH_FRAGMENTS.some((frag) => p.includes(frag))) return raw;
    const allowed = allowedPaths.some((a) => p.startsWith(normalize(a)));
    if (!allowed) return raw;
  }
  return null;
}

function normalize(p: string): string {
  return p.replace(/^\.\//, "").replace(/\\/g, "/");
}

// Holdout didn't regress below baseline (the generalization guard alongside the
// hard regress gate).
function holdoutHeld(verdict: EvalGateResult, baseline: EvalGateResult): boolean {
  return verdict.targetHoldout.passed >= baseline.targetHoldout.passed;
}

// ── The orchestration ───────────────────────────────────────────────

export async function runFixAgent(opts: FixAgentOpts): Promise<FixAgentResult> {
  const log = opts.log ?? ((line: string) => console.log(`[fix-agent] ${line}`));
  const K = opts.maxAttemptsPerCluster ?? DEFAULT_MAX_ATTEMPTS;

  // Invariant 1, fail-fast: refuse to even start on a main/stable shape. The
  // first bumped version is what we'd push; if that's not a legal staging
  // prerelease the whole run aborts before touching anything.
  let nextVersion = computeNextRc(opts.currentVersion);
  assertStagingPrerelease({ branch: opts.branch, version: nextVersion });

  const result: FixAgentResult = { committed: [], walls: [], parked: [] };
  const clusters = clusterFailures(opts.batch);
  log(`batch ${opts.batch.batch_id}: ${opts.batch.failures.length} failure(s) → ${clusters.length} cluster(s)`);

  // Baseline the gate ONCE so "holdout didn't drop" is measured against the
  // pre-fix state, not re-derived per attempt.
  const baseline = await opts.gate();
  if (baseline.emptyRegress) {
    log("WARNING: regress corpus is empty — the gate is not meaningful; nothing will be committed");
  }

  for (const cluster of clusters) {
    let committed = false;
    let priorFeedback: string | undefined;
    let wallReason: string | undefined;

    for (let attempt = 1; attempt <= K && !committed; attempt++) {
      let proposal: FixProposal | null;
      try {
        proposal = await opts.propose(cluster, attempt, priorFeedback);
      } catch (err) {
        if (err instanceof WallError) {
          wallReason = err.reason;
          break;
        }
        throw err;
      }
      if (proposal === null) {
        priorFeedback = "proposer returned no change";
        continue;
      }

      // Invariant 2: the path fence. An out-of-bounds touch is parked, never
      // applied/committed (posture a: form-fill + corpus are off-limits).
      const oob = firstOutOfBoundsPath(proposal.touched_paths, opts.allowedPaths);
      if (oob !== null) {
        log(`cluster ${cluster.id}: parked — fix touches out-of-bounds path "${oob}"`);
        result.parked.push({
          cluster_id: cluster.id,
          reason: `out-of-bounds path: ${oob}`,
          touched_paths: proposal.touched_paths,
        });
        break;
      }

      await proposal.apply();
      const verdict = await opts.gate();

      // The empty-regress gate is vacuously green; refuse to commit against a
      // meaningless gate (don't ship a "fix" nothing guarded).
      const regressOk = verdict.regressPassed && !verdict.emptyRegress;
      if (regressOk && holdoutHeld(verdict, baseline)) {
        await opts.commit({ cluster, proposal, version: nextVersion });
        result.committed.push({ cluster_id: cluster.id, version: nextVersion, summary: proposal.summary });
        log(`cluster ${cluster.id}: committed ${nextVersion} — ${proposal.summary}`);
        nextVersion = computeNextRc(nextVersion);
        committed = true;
      } else {
        await proposal.revert();
        priorFeedback = gateFeedback(verdict, baseline);
        log(`cluster ${cluster.id}: attempt ${attempt}/${K} red — ${priorFeedback}`);
      }
    }

    if (!committed) {
      if (wallReason !== undefined) {
        result.walls.push(wallWith(cluster, K, wallReason));
        log(`cluster ${cluster.id}: WALL — ${wallReason}`);
      } else if (!result.parked.some((p) => p.cluster_id === cluster.id)) {
        const reason = `no fix passed the gate after ${K} attempt(s); no articulable infra reason`;
        result.walls.push(wallWith(cluster, K, reason));
        log(`cluster ${cluster.id}: WALL-candidate — ${reason}`);
      }
    }
  }

  log(
    `done: ${result.committed.length} committed · ${result.walls.length} wall-candidate(s) · ${result.parked.length} parked`,
  );
  return result;
}

function gateFeedback(verdict: EvalGateResult, baseline: EvalGateResult): string {
  if (verdict.emptyRegress) return "regress corpus empty — gate not meaningful";
  if (!verdict.regressPassed) {
    const fails = verdict.regress.failures.map((f) => `${f.service}/${f.id}`).slice(0, 4).join(", ");
    return `regress broke (${verdict.regress.passed}/${verdict.regress.total}): ${fails}`;
  }
  return `target-holdout dropped ${baseline.targetHoldout.passed}→${verdict.targetHoldout.passed}`;
}

function wallWith(cluster: FixCluster, attempts: number, reason: string): WallCandidate {
  return {
    cluster_id: cluster.id,
    failure_stage: cluster.failure_stage,
    services: cluster.services,
    signature: cluster.signature,
    attempts,
    reason,
  };
}
