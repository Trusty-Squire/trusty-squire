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
//   3. A fix commits ONLY when (a) the gate's regress bucket stays 100% AND the
//      target-holdout didn't drop below baseline (didn't break known-good), AND
//      (b) the cluster's own captured stuck pages now MOVE — the planner picks a
//      different action than the one that left them stuck (the fix demonstrably
//      unstuck the thing it was written for). "Iterate-to-green": keep
//      re-proposing until every verifiable page in the cluster moves, or K/wall.
//   4. After maxAttemptsPerCluster (K=3) attempts without a verified-green fix,
//      the cluster is parked as a wall-candidate — the residual, never a
//      pre-judged category.
//
// The live end-to-end confirmation (does the WHOLE signup now complete) stays
// for the next dogfood run — re-driving live signups in-loop is slow, flaky, and
// stateful (the reason the offline eval exists). The captured-page verify is the
// most we can prove today; the next-day OF#2 confirms end-to-end.
//
// Operator-only (housekeeper/, excluded from the npm tarball).

import type { FailureStage } from "../bot/failure-stage.js";
import type { EvalGateResult } from "../bot/eval-gate.js";
import type { PostVerifyStep } from "../bot/agent.js";
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
  // The captured stuck pages this cluster must un-stick. The verifier replays
  // the planner against each capture file AFTER a fix and requires the chosen
  // action to differ from `observed`. Failures without a captured terminal
  // round contribute nothing here.
  pages: Array<{ service: string; captureRef: string; observed: PostVerifyStep }>;
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

// Replay the planner against a captured page FILE and return the action it now
// picks. MUST reflect the just-applied fix — the real impl runs in a fresh
// process so it sees the edited source (an in-process import would use the stale
// planner). `captureRef` is the path to the terminal round's capture JSON.
export type ClusterReplay = (captureRef: string) => Promise<PostVerifyStep>;

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
  // Replays a captured page through the (freshly-edited) planner so the loop can
  // verify the fix actually moved the stuck page before committing.
  replay: ClusterReplay;
  // The LIVE ORACLE (autonomous-fix-loop Phase 2). When wired, the offline gate
  // + replay above are only the FAST inner filter; a fix commits ONLY if it also
  // passes the live gate — the cluster's services extract a working key on ≥M
  // distinct services AND a held-out canary doesn't regress. Builds dist + runs
  // real signups internally; returns the verdict. Absent → offline-only (the
  // pre-Phase-2 behaviour; the unit tests drive it without live runs).
  liveGate?: (cluster: FixCluster) => Promise<{ passed: boolean; reason: string }>;
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
  committed: Array<{
    cluster_id: string;
    version: string;
    summary: string;
    // The services + signature this fix targeted — what the grading ledger
    // checks on the next pass (fix-ledger.ts). See docs/DESIGN-autonomous-output-loop.md.
    services: string[];
    signature: string;
  }>;
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
    // Cluster by SEMANTIC failure shape: failure_stage + the planner's terminal
    // action kind. This groups "the planner kept clicking and looped" or "the
    // planner gave up (done) too early" across services — the shared-root-cause
    // case the holistic pass exists for. The page signature is deliberately NOT
    // in the key: even a structural (role-only) signature is per-page, so it
    // shatters same-root-cause failures back into per-service singletons
    // (measured 2026-06-11: stage+kind → 11 clusters, +signature → 22). The
    // eval gate + per-cluster replay are the safety net against an over-merge —
    // a fix that can't satisfy the whole cluster fails the gate and walls.
    const observedKind = f.terminal_page?.observed.kind ?? "none";
    const key = `${f.failure_stage}:${observedKind}`;
    const page =
      f.terminal_capture_ref !== undefined && f.terminal_page !== undefined
        ? { service: f.service, captureRef: f.terminal_capture_ref, observed: f.terminal_page.observed }
        : undefined;
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, {
        id: key,
        failure_stage: f.failure_stage,
        signature: f.signature,
        services: [f.service],
        failures: [f],
        capture_refs: [...f.capture_refs],
        pages: page !== undefined ? [page] : [],
      });
    } else {
      if (!existing.services.includes(f.service)) existing.services.push(f.service);
      existing.failures.push(f);
      for (const r of f.capture_refs) {
        if (!existing.capture_refs.includes(r)) existing.capture_refs.push(r);
      }
      if (page !== undefined) existing.pages.push(page);
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

// ── Fix verification (did the fix actually unstick the page?) ────────

function actionLocator(s: PostVerifyStep): string {
  if ("selector" in s && typeof s.selector === "string") return `sel:${s.selector}`;
  if (s.kind === "navigate") return `url:${s.url}`;
  return "";
}

// Two planner actions are "the same" iff same kind AND same locator. A fix that
// leaves the planner picking the identical action on a stuck page did nothing
// for that page — it hasn't moved.
export function sameAction(a: PostVerifyStep, b: PostVerifyStep): boolean {
  return a.kind === b.kind && actionLocator(a) === actionLocator(b);
}

export interface ClusterVerify {
  verifiable: number; // captured pages we could replay
  moved: number; // verifiable pages whose action changed post-fix
  allMoved: boolean; // verifiable >= 1 AND moved === verifiable
  stuckServices: string[]; // services whose page did NOT move
}

// Replay each captured stuck page through the (freshly-edited) planner; a page
// "moved" if the planner now picks a different action than the one that left it
// stuck. The fix is verified iff every verifiable page moved (and there's at
// least one). This proves "the fix changed behavior on the exact page that was
// stuck" — the most we can confirm today; live end-to-end is the next-day run.
export async function verifyClusterMoved(
  cluster: FixCluster,
  replay: ClusterReplay,
): Promise<ClusterVerify> {
  let moved = 0;
  const stuck: string[] = [];
  for (const { service, captureRef, observed } of cluster.pages) {
    const chosen = await replay(captureRef);
    if (sameAction(chosen, observed)) stuck.push(service);
    else moved += 1;
  }
  const verifiable = cluster.pages.length;
  return {
    verifiable,
    moved,
    allMoved: verifiable >= 1 && moved === verifiable,
    stuckServices: stuck,
  };
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
    // Can't verify a fix with no captured page — don't commit blind. Park as a
    // wall-candidate (the honest "we can't confirm a fix here today"), and skip
    // burning the coding agent on something we couldn't prove either way.
    if (cluster.pages.length === 0) {
      result.walls.push(
        wallWith(cluster, 0, "no captured page to verify a fix against — cannot confirm a fix today"),
      );
      log(`cluster ${cluster.id}: WALL-candidate — unverifiable (no captured page)`);
      continue;
    }

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

      // Guard 1 — didn't break known-good. The empty-regress gate is vacuously
      // green; refuse to commit against a meaningless gate.
      const verdict = await opts.gate();
      const regressOk = verdict.regressPassed && !verdict.emptyRegress;
      if (!regressOk || !holdoutHeld(verdict, baseline)) {
        await proposal.revert();
        priorFeedback = gateFeedback(verdict, baseline);
        log(`cluster ${cluster.id}: attempt ${attempt}/${K} red (regression) — ${priorFeedback}`);
        continue;
      }

      // Guard 2 — the fix actually unstuck THIS cluster's pages (iterate-to-green).
      const verify = await verifyClusterMoved(cluster, opts.replay);
      if (!verify.allMoved) {
        await proposal.revert();
        priorFeedback =
          `gate stayed green but the fix did not change the planner's action on ` +
          `stuck page(s): ${verify.stuckServices.join(", ")}. Make the planner pick ` +
          `a different action on those pages.`;
        log(`cluster ${cluster.id}: attempt ${attempt}/${K} not-unstuck (${verify.moved}/${verify.verifiable} moved)`);
        continue;
      }

      // Guard 3 — the LIVE ORACLE (Phase 2). Offline said the page moves; now
      // prove it against reality: the cluster extracts a working key live AND
      // the canary held. The offline gate can be fooled (stale DOM, a fix that
      // moves the planner's STEP but doesn't complete the signup); a live key
      // cannot. Only run after the cheap offline filters pass.
      if (opts.liveGate !== undefined) {
        const live = await opts.liveGate(cluster);
        log(`cluster ${cluster.id}: attempt ${attempt}/${K} live gate — ${live.reason}`);
        if (!live.passed) {
          await proposal.revert();
          priorFeedback =
            `offline said the page moved, but the LIVE gate rejected it: ${live.reason}. ` +
            `The fix must make REAL signups extract a working key without breaking the canary.`;
          continue;
        }
      }

      // Verified: no regression, every stuck page moved offline, AND the live
      // oracle confirmed real keys without canary regression.
      await opts.commit({ cluster, proposal, version: nextVersion });
      result.committed.push({
        cluster_id: cluster.id,
        version: nextVersion,
        summary: proposal.summary,
        services: cluster.services,
        signature: cluster.signature,
      });
      log(`cluster ${cluster.id}: committed ${nextVersion} (${verify.moved}/${verify.verifiable} pages unstuck) — ${proposal.summary}`);
      nextVersion = computeNextRc(nextVersion);
      committed = true;
    }

    if (!committed) {
      if (wallReason !== undefined) {
        result.walls.push(wallWith(cluster, K, wallReason));
        log(`cluster ${cluster.id}: WALL — ${wallReason}`);
      } else if (!result.parked.some((p) => p.cluster_id === cluster.id)) {
        const reason = `no fix both held the gate AND unstuck the page after ${K} attempt(s); no articulable infra reason`;
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
