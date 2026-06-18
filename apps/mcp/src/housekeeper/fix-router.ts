// fix-router.ts — autonomous-fix-loop Phase 1 (docs/DESIGN-autonomous-fix-loop.md).
//
// Pure classification of an open ledger cluster into one of four routes. This
// is the gate that keeps the autonomous fix-agent pointed at exactly the
// failures it can safely fix, and routes everything else away:
//
//   drain          — flaky / timing; a re-run resolves it, no code fix
//   wall           — genuinely unservable (dead domain, phone/payment/manual)
//   fix            — DETERMINISTIC and inside the fix-agent's path-fence
//                    (the post-OAuth nav planner: planner_loop / extract).
//                    The ONLY route that spends an autonomous code fix.
//   capability_gap — deterministic but OUTSIDE the fence; the agent's eval
//                    doesn't cover it, so it surfaces with evidence instead of
//                    being hacked. Widening the fence is a deliberate per-class
//                    step, never automatic.
//
// Why these stages are "in fence": the fix-agent may only edit the gated
// post-OAuth navigation planner (modes/fix.ts DEFAULT_ALLOWED_PATHS). A fix
// there can only move `planner_loop` (stalled nav) and `extract` (reached the
// key page, couldn't surface a credential). Everything else — OAuth handshake,
// account-chooser, email/OTP, captcha, form — lives in code the fence forbids,
// so its eval is hollow and an "autonomous fix" would be unguarded.

import type { FailureStage } from "../bot/failure-stage.js";

export type FixRoute = "drain" | "wall" | "fix" | "capability_gap";

export interface RouterInput {
  service: string;
  /** Coarse ledger key (token before the first colon), e.g. "oauth_onboarding_failed". */
  coarseKind: string;
  /** Failure stage (classifyFailureStage over the original error). */
  stage: FailureStage;
  /** Fraction of recent runs for this service that went GREEN (0..1). High =
   *  flaky (it flips), so a re-run — not a code fix — is the move. */
  retryVariance: number;
  /** The signup domain resolves. False = dead host → wall. */
  dnsAlive: boolean;
  /** Curated `needs-manual` flag (operator-confirmed unservable). */
  curatedNeedsManual: boolean;
}

export interface RouterVerdict {
  route: FixRoute;
  reason: string;
}

// Stages the fix-agent's path-fence can actually move (post-OAuth nav planner).
export const IN_FENCE_STAGES: ReadonlySet<FailureStage> = new Set<FailureStage>([
  "planner_loop",
  "extract",
]);

// Timing / environment stages where a retry is the correct move, not a fix.
const FLAKY_STAGES: ReadonlySet<FailureStage> = new Set<FailureStage>([
  "proxy_timeout",
  "run_timeout",
  "hydration",
]);

// Stages that need a faculty the bot doesn't have → unservable autonomously.
const CAPABILITY_WALL_STAGES: ReadonlySet<FailureStage> = new Set<FailureStage>([
  "phone",
  "payment",
  "manual",
]);

// A service that goes green this often on retry is flaky, not deterministically
// broken — leave it to the drain clock.
export const RETRY_VARIANCE_FLAKY = 0.2;

export function classifyCluster(i: RouterInput): RouterVerdict {
  // Mechanical walls first — operator curation, then a dead host.
  if (i.curatedNeedsManual) {
    return { route: "wall", reason: "curated needs-manual (operator-confirmed unservable)" };
  }
  if (!i.dnsAlive) {
    return { route: "wall", reason: "signup domain does not resolve (DNS dead)" };
  }
  // Flaky overrides stage: if it flips green on retry, a fix would chase noise.
  if (i.retryVariance >= RETRY_VARIANCE_FLAKY) {
    return {
      route: "drain",
      reason: `flaky — ${Math.round(i.retryVariance * 100)}% of recent runs green; retry, no fix`,
    };
  }
  // Deterministic + inside the fence → the one route that spends a fix.
  if (IN_FENCE_STAGES.has(i.stage)) {
    return {
      route: "fix",
      reason: `deterministic post-OAuth nav failure (stage=${i.stage}) — inside the fix-agent fence`,
    };
  }
  // Deterministic but a timing/env stage → still a retry, not a fix.
  if (FLAKY_STAGES.has(i.stage)) {
    return { route: "drain", reason: `timing/env stage=${i.stage} — retry` };
  }
  // Needs a faculty the bot lacks → unservable autonomously.
  if (CAPABILITY_WALL_STAGES.has(i.stage)) {
    return { route: "wall", reason: `needs a faculty the bot lacks (stage=${i.stage})` };
  }
  // Deterministic, real, but OUTSIDE the fence — surface, don't hack.
  return {
    route: "capability_gap",
    reason: `deterministic but out-of-fence (stage=${i.stage}) — needs eval coverage before an autonomous fix`,
  };
}
