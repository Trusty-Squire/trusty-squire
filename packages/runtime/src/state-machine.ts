// Pure state machine — runs the transition logic without touching I/O.
//
// The shape: transition(run, t, now) returns { next_state, event, patch }.
// The caller persists the patch + event (assigning ids / emitted_at).
// Throws IllegalTransitionError on any disallowed transition.

import {
  isTerminal,
  type Run,
  type RunEventDraft,
  type RunPatch,
  type RunState,
  type StepError,
  type StepRecord,
  type Tier,
  type Transition,
  type TransitionResult,
} from "./types.js";

export class IllegalTransitionError extends Error {
  public readonly state: RunState;
  public readonly transition: string;

  constructor(state: RunState, transitionKind: string, detail?: string) {
    super(
      detail
        ? `Illegal transition '${transitionKind}' from state '${state}': ${detail}`
        : `Illegal transition '${transitionKind}' from state '${state}'`,
    );
    this.name = "IllegalTransitionError";
    this.state = state;
    this.transition = transitionKind;
  }
}

const MAX_RETRIES = 3;

export function transition(run: Run, t: Transition, now: string): TransitionResult {
  if (isTerminal(run.state)) {
    throw new IllegalTransitionError(run.state, t.kind, "terminal states accept no transitions");
  }

  switch (t.kind) {
    case "mandate_validated":
      return handleMandateValidated(run, t, now);
    case "approval_granted":
      return handleApprovalGranted(run, t, now);
    case "approval_denied":
      return handleApprovalDenied(run, t, now);
    case "approval_expired":
      return handleApprovalExpired(run, now);
    case "step_succeeded":
      return handleStepSucceeded(run, t, now);
    case "step_failed":
      return handleStepFailed(run, t, now);
    case "tier_escalation_started":
      return handleTierEscalation(run, t, now);
    case "all_steps_complete":
      return handleAllStepsComplete(run, t, now);
    case "vault_write_succeeded":
      return handleVaultWriteSucceeded(run, t, now);
    case "vault_write_failed":
      return handleVaultWriteFailed(run, t, now);
    case "compensation_started":
      return handleCompensationStarted(run, now);
    case "compensation_completed":
      return handleCompensationCompleted(run, now, t);
    case "rejected":
      return handleRejected(run, t, now);
  }
}

// ── Per-transition handlers ──────────────────────────────────

function handleMandateValidated(
  run: Run,
  t: Extract<Transition, { kind: "mandate_validated" }>,
  now: string,
): TransitionResult {
  if (run.state !== "CREATED") {
    throw new IllegalTransitionError(run.state, t.kind);
  }
  // Routes directly to PENDING_APPROVAL or PROVISIONING based on the
  // validator's needs_approval verdict. The MANDATE_VALIDATED literal
  // exists in the state union for future use (see chunk-2 report flag)
  // but no current transition lands there.
  const next: RunState = t.needs_approval ? "PENDING_APPROVAL" : "PROVISIONING";
  return result(run, next, now, "mandate_validated", { needs_approval: t.needs_approval });
}

function handleApprovalGranted(
  run: Run,
  t: Extract<Transition, { kind: "approval_granted" }>,
  now: string,
): TransitionResult {
  if (run.state !== "PENDING_APPROVAL") {
    throw new IllegalTransitionError(run.state, t.kind);
  }
  const patch: RunPatch = {
    state: "PROVISIONING",
    state_entered_at: now,
    delta_mandate_id: t.delta_mandate_id,
  };
  return {
    next_state: "PROVISIONING",
    event: draftEvent(run, "approval_granted", run.state, "PROVISIONING", {
      delta_mandate_id: t.delta_mandate_id,
    }),
    patch,
  };
}

function handleApprovalDenied(
  run: Run,
  t: Extract<Transition, { kind: "approval_denied" }>,
  now: string,
): TransitionResult {
  if (run.state !== "PENDING_APPROVAL") {
    throw new IllegalTransitionError(run.state, t.kind);
  }
  return rejectFromApproval(run, now, "approval_denied", t.reason);
}

function handleApprovalExpired(run: Run, now: string): TransitionResult {
  if (run.state !== "PENDING_APPROVAL") {
    throw new IllegalTransitionError(run.state, "approval_expired");
  }
  return rejectFromApproval(run, now, "approval_expired", null);
}

// failure_reason is the stable category (matches the event type); the
// caller-supplied detail string goes into the event payload.
function rejectFromApproval(
  run: Run,
  now: string,
  type: "approval_denied" | "approval_expired",
  reason: string | null,
): TransitionResult {
  const patch: RunPatch = {
    state: "REJECTED",
    state_entered_at: now,
    failure_reason: type,
    completed_at: now,
  };
  const payload: Record<string, unknown> = reason === null ? {} : { reason };
  return {
    next_state: "REJECTED",
    event: draftEvent(run, type, run.state, "REJECTED", payload),
    patch,
  };
}

function handleStepSucceeded(
  run: Run,
  t: Extract<Transition, { kind: "step_succeeded" }>,
  now: string,
): TransitionResult {
  if (run.state !== "PROVISIONING" && run.state !== "ADAPTER_EXECUTING") {
    throw new IllegalTransitionError(run.state, t.kind);
  }
  // Both states route to ADAPTER_EXECUTING — first success leaves
  // PROVISIONING for good; later successes are no-op state-wise.
  const next: RunState = "ADAPTER_EXECUTING";
  const patch: RunPatch = {
    state: next,
    state_entered_at: run.state === next ? run.state_entered_at : now,
    steps: appendOrUpdateStep(run.steps, t.step),
    side_effects: [...run.side_effects, ...t.new_side_effects],
    ...(t.generated_updates !== undefined && Object.keys(t.generated_updates).length > 0
      ? { context_generated_merge: t.generated_updates }
      : {}),
  };
  return {
    next_state: next,
    event: draftEvent(run, "step_succeeded", run.state, next, {
      step_id: t.step.step_id,
      attempt: t.step.attempt,
      tier: t.step.tier,
      side_effects_added: t.new_side_effects.length,
      generated_keys_added: t.generated_updates ? Object.keys(t.generated_updates) : [],
    }),
    patch,
  };
}

function handleStepFailed(
  run: Run,
  t: Extract<Transition, { kind: "step_failed" }>,
  now: string,
): TransitionResult {
  if (run.state !== "PROVISIONING" && run.state !== "ADAPTER_EXECUTING") {
    throw new IllegalTransitionError(run.state, t.kind);
  }
  const decision = decideFailureRouting(run.state, run.current_tier, run.retry_count, t.error);
  const updatedSteps = appendOrUpdateStep(run.steps, t.step);

  const basePayload: Record<string, unknown> = {
    step_id: t.step.step_id,
    attempt: t.step.attempt,
    error_message: t.error.message,
    routing: decision.kind,
  };

  if (decision.kind === "stay") {
    const patch: RunPatch = {
      state: run.state,
      state_entered_at: run.state_entered_at,
      retry_count: run.retry_count + 1,
      steps: updatedSteps,
    };
    return {
      next_state: run.state,
      event: draftEvent(run, "step_failed", run.state, run.state, {
        ...basePayload,
        new_retry_count: run.retry_count + 1,
      }),
      patch,
    };
  }

  if (decision.kind === "escalate") {
    const patch: RunPatch = {
      state: "TIER_ESCALATING",
      state_entered_at: now,
      steps: updatedSteps,
    };
    return {
      next_state: "TIER_ESCALATING",
      event: draftEvent(run, "step_failed", run.state, "TIER_ESCALATING", basePayload),
      patch,
    };
  }

  // decision.kind === "compensate"
  const patch: RunPatch = {
    state: "COMPENSATING",
    state_entered_at: now,
    steps: updatedSteps,
    failure_reason: decision.reason,
    failure_detail: t.error.detail ?? null,
  };
  return {
    next_state: "COMPENSATING",
    event: draftEvent(run, "step_failed", run.state, "COMPENSATING", {
      ...basePayload,
      compensation_reason: decision.reason,
    }),
    patch,
  };
}

type FailureDecision =
  | { kind: "stay" }
  | { kind: "escalate" }
  | { kind: "compensate"; reason: string };

function decideFailureRouting(
  _state: RunState,
  currentTier: Tier,
  retryCount: number,
  error: StepError,
): FailureDecision {
  // Order matters — capability violations short-circuit retry/escalate.
  if (error.capability_violation) {
    return { kind: "compensate", reason: "capability_violation" };
  }
  if (error.causes_tier_escalation && currentTier < 3) {
    return { kind: "escalate" };
  }
  if (error.retryable && retryCount + 1 < MAX_RETRIES) {
    // retry_count is incremented to (current+1) before next check;
    // we allow retry as long as the post-increment stays under 3.
    return { kind: "stay" };
  }
  return { kind: "compensate", reason: "retries_exhausted_or_unrecoverable" };
}

function handleTierEscalation(
  run: Run,
  t: Extract<Transition, { kind: "tier_escalation_started" }>,
  now: string,
): TransitionResult {
  if (run.state !== "TIER_ESCALATING") {
    throw new IllegalTransitionError(run.state, t.kind);
  }
  if (t.new_tier <= run.current_tier) {
    throw new IllegalTransitionError(
      run.state,
      t.kind,
      `new_tier ${t.new_tier} must exceed current_tier ${run.current_tier}`,
    );
  }
  const patch: RunPatch = {
    state: "ADAPTER_EXECUTING",
    state_entered_at: now,
    current_tier: t.new_tier,
    retry_count: 0,
  };
  return {
    next_state: "ADAPTER_EXECUTING",
    event: draftEvent(run, "tier_escalation_started", run.state, "ADAPTER_EXECUTING", {
      from_tier: run.current_tier,
      to_tier: t.new_tier,
    }),
    patch,
  };
}

function handleAllStepsComplete(
  run: Run,
  t: Extract<Transition, { kind: "all_steps_complete" }>,
  now: string,
): TransitionResult {
  if (run.state !== "ADAPTER_EXECUTING") {
    throw new IllegalTransitionError(run.state, t.kind);
  }
  // No credentials => the flow ran but produced nothing useful; the
  // safe response is to compensate any side effects rather than marking
  // a useless run COMPLETE.
  const next: RunState = t.credentials_extracted ? "CRED_EXTRACTED" : "COMPENSATING";
  const patch: RunPatch =
    next === "CRED_EXTRACTED"
      ? {
          state: next,
          state_entered_at: now,
          credentials: t.credentials ?? null,
        }
      : {
          state: next,
          state_entered_at: now,
          failure_reason: "no_credentials_extracted",
        };
  return {
    next_state: next,
    event: draftEvent(run, "all_steps_complete", run.state, next, {
      credentials_extracted: t.credentials_extracted,
      credential_count: t.credentials?.length ?? 0,
    }),
    patch,
  };
}

function handleVaultWriteSucceeded(
  run: Run,
  t: Extract<Transition, { kind: "vault_write_succeeded" }>,
  now: string,
): TransitionResult {
  if (run.state !== "CRED_EXTRACTED") {
    throw new IllegalTransitionError(run.state, t.kind);
  }
  const patch: RunPatch = {
    state: "COMPLETE",
    state_entered_at: now,
    subscription_id: t.subscription_id,
    completed_at: now,
    // Plaintext erasure: per spec, drop the credentials list from the
    // run record once they're durably in the vault.
    credentials: null,
    side_effects:
      t.new_side_effects !== undefined && t.new_side_effects.length > 0
        ? [...run.side_effects, ...t.new_side_effects]
        : run.side_effects,
  };
  return {
    next_state: "COMPLETE",
    event: draftEvent(run, "vault_write_succeeded", run.state, "COMPLETE", {
      subscription_id: t.subscription_id,
      new_side_effect_count: t.new_side_effects?.length ?? 0,
    }),
    patch,
  };
}

function handleVaultWriteFailed(
  run: Run,
  t: Extract<Transition, { kind: "vault_write_failed" }>,
  now: string,
): TransitionResult {
  if (run.state !== "CRED_EXTRACTED") {
    throw new IllegalTransitionError(run.state, t.kind);
  }
  // Direct CRED_EXTRACTED → FAILED. Per spec, partial vault entries
  // stay; we don't compensate them (the user has actionable references
  // for whatever did land).
  const patch: RunPatch = {
    state: "FAILED",
    state_entered_at: now,
    completed_at: now,
    failure_reason: t.reason,
    failure_detail: t.detail ?? null,
    credentials: null,
    side_effects:
      t.partial_side_effects !== undefined && t.partial_side_effects.length > 0
        ? [...run.side_effects, ...t.partial_side_effects]
        : run.side_effects,
  };
  return {
    next_state: "FAILED",
    event: draftEvent(run, "vault_write_failed", run.state, "FAILED", {
      reason: t.reason,
      partial_count: t.partial_side_effects?.length ?? 0,
    }),
    patch,
  };
}

function handleCompensationStarted(run: Run, now: string): TransitionResult {
  if (run.state !== "COMPENSATING") {
    throw new IllegalTransitionError(run.state, "compensation_started");
  }
  // Audit-only event; the state and entry timestamp are unchanged.
  const patch: RunPatch = {
    state: "COMPENSATING",
    state_entered_at: run.state_entered_at,
  };
  return {
    next_state: "COMPENSATING",
    event: draftEvent(run, "compensation_started", "COMPENSATING", "COMPENSATING", {}),
    patch,
  };
  // `now` is unused but required by the call signature for symmetry; the
  // caller can ignore the patch's entry timestamp since it's the prior value.
  void now;
}

function handleCompensationCompleted(
  run: Run,
  now: string,
  t?: Extract<Transition, { kind: "compensation_completed" }>,
): TransitionResult {
  if (run.state !== "COMPENSATING") {
    throw new IllegalTransitionError(run.state, "compensation_completed");
  }
  const patch: RunPatch = {
    state: "FAILED",
    state_entered_at: now,
    completed_at: now,
  };
  const payload: Record<string, unknown> = {};
  if (t?.results !== undefined) payload.results = t.results;
  return {
    next_state: "FAILED",
    event: draftEvent(run, "compensation_completed", "COMPENSATING", "FAILED", payload),
    patch,
  };
}

function handleRejected(
  run: Run,
  t: Extract<Transition, { kind: "rejected" }>,
  now: string,
): TransitionResult {
  if (run.state !== "CREATED") {
    throw new IllegalTransitionError(run.state, t.kind);
  }
  // Critical invariant: `rejected` is only valid before any side
  // effects exist. Once side effects are emitted, the run must go
  // through COMPENSATING instead.
  if (run.side_effects.length > 0) {
    throw new IllegalTransitionError(
      run.state,
      t.kind,
      "side effects exist; must transition through COMPENSATING",
    );
  }
  const patch: RunPatch = {
    state: "REJECTED",
    state_entered_at: now,
    failure_reason: t.reason,
    completed_at: now,
  };
  return {
    next_state: "REJECTED",
    event: draftEvent(run, "rejected", run.state, "REJECTED", { reason: t.reason }),
    patch,
  };
}

// ── Helpers ──────────────────────────────────────────────────

function result(
  run: Run,
  next: RunState,
  now: string,
  type: RunEventDraft["type"],
  payload: Record<string, unknown>,
): TransitionResult {
  return {
    next_state: next,
    event: draftEvent(run, type, run.state, next, payload),
    patch: { state: next, state_entered_at: now },
  };
}

function draftEvent(
  run: Run,
  type: RunEventDraft["type"],
  from: RunState,
  to: RunState,
  payload: Record<string, unknown>,
): RunEventDraft {
  return {
    run_id: run.id,
    account_id: run.account_id,
    type,
    from_state: from,
    to_state: to,
    payload,
  };
}

// Append the step record by index, replacing any prior entry with the
// same index (e.g. successive retries of the same step). Keeps step
// history compact and deterministic.
function appendOrUpdateStep(steps: StepRecord[], step: StepRecord): StepRecord[] {
  const existing = steps.findIndex((s) => s.index === step.index);
  if (existing >= 0) {
    const next = steps.slice();
    next[existing] = step;
    return next;
  }
  return [...steps, step];
}
