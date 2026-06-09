// Per-state retry policy — the single table the autonomous loop consults to
// decide what to DO with each ProvisionState, and (critically) whether reaching
// that state's terminal ever surfaces to a human. Exactly one state has
// surfaces=true: `unknown`. That is the whole "no human except an
// unclassifiable DOM state" guarantee, expressed as data.
//
// Pairs with provision-state.ts (the classifier). Kept here, in skill-schema,
// so the loop (registry-side orchestrator) and any mcp-side consumer share one
// policy — the same reason failure-taxonomy.ts lives here.

import type { ProvisionState } from "./provision-state.js";

export type ProvisionAction =
  | "promote" // success + virgin + uncovered service → synthesize & publish a skill
  | "record" // success on an already-covered service → just record the stat
  | "drive" // virgin/authenticated → run the flow (form-fill or already_oauth extract)
  | "poll_then_retry" // email_pending → poll the inbox, then one retry; else degrade to infra
  | "backoff_requeue" // rate_limited → exponential backoff, requeue the service
  | "retry" // transient → re-attempt
  | "skip_unservable" // wall → mark the service unservable, log a reason, move on
  | "infra_alert" // infra → note in the digest; never demote the skill
  | "demote" // rot → advance the 3-strike demote counter
  | "escalate"; // unknown → after the attempt cap, the ONE human-facing surface

export interface StatePolicy {
  readonly action: ProvisionAction;
  // Attempts on the SAME (service, state-signature) before the action is
  // considered exhausted. For `unknown` this is the escalation threshold.
  readonly maxAttempts: number;
  // Does exhausting this policy surface to a human? True for `unknown` ONLY.
  readonly surfaces: boolean;
  // Base backoff for `rate_limited` (exponential per attempt). Undefined elsewhere.
  readonly backoffMs?: number;
}

// The single escalation threshold the operator asked for: a never-seen DOM
// state is retried this many times (same signature) before the one human ping.
export const UNKNOWN_ESCALATION_THRESHOLD = 3 as const;

export const PROVISION_POLICY: Readonly<Record<ProvisionState, StatePolicy>> = {
  success: { action: "promote", maxAttempts: 1, surfaces: false },
  virgin: { action: "drive", maxAttempts: 1, surfaces: false },
  authenticated: { action: "drive", maxAttempts: 1, surfaces: false },
  email_pending: { action: "poll_then_retry", maxAttempts: 2, surfaces: false },
  rate_limited: { action: "backoff_requeue", maxAttempts: 3, surfaces: false, backoffMs: 60_000 },
  transient: { action: "retry", maxAttempts: 3, surfaces: false },
  wall: { action: "skip_unservable", maxAttempts: 1, surfaces: false },
  infra: { action: "infra_alert", maxAttempts: 1, surfaces: false },
  rot: { action: "demote", maxAttempts: 3, surfaces: false },
  unknown: { action: "escalate", maxAttempts: UNKNOWN_ESCALATION_THRESHOLD, surfaces: true },
};

export function policyFor(state: ProvisionState): StatePolicy {
  return PROVISION_POLICY[state];
}

// THE escalation gate. True iff this state surfaces to a human AND we've hit its
// attempt cap. The loop calls this with the running attempt count for the
// (service, state-signature) pair; only `unknown` at >= threshold returns true.
// Every other state returns false at every count — the autonomy guarantee.
export function shouldEscalate(state: ProvisionState, attempts: number): boolean {
  const p = PROVISION_POLICY[state];
  return p.surfaces && attempts >= p.maxAttempts;
}

// Exponential backoff for rate_limited, given the attempt index (1-based).
// Returns 0 for states without a backoff. Capped at 30 min so a stubborn 429
// doesn't park a service forever.
export function backoffForAttempt(state: ProvisionState, attempt: number): number {
  const base = PROVISION_POLICY[state].backoffMs;
  if (base === undefined) return 0;
  const ms = base * 2 ** Math.max(0, attempt - 1);
  return Math.min(ms, 30 * 60_000);
}
