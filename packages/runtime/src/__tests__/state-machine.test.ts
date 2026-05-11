// State machine tests. Cover every routing rule + every invariant.
// 100% line coverage target — the state machine is security-critical
// (gates side effects + compensation).

import { describe, expect, it } from "vitest";
import { IllegalTransitionError, transition } from "../state-machine.js";
import type {
  ExtractedCredential,
  Run,
  RunState,
  SideEffect,
  StepError,
  StepRecord,
  Tier,
  Transition,
} from "../types.js";

// ── Fixtures ─────────────────────────────────────────────────

const NOW = "2026-05-10T08:00:00.000Z";
const LATER = "2026-05-10T08:00:01.000Z";

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: "01HXXXXXXXXXXXXXXXXXXXXXXX",
    account_id: "01HACCOUNTAAAAAAAAAAAAAAA0",
    idempotency_key: "key-1",
    service: "resend",
    plan: "free",
    project_name: "demo",
    user_facing_purpose: null,
    state: "CREATED",
    state_entered_at: "2026-05-10T07:59:00.000Z",
    retry_count: 0,
    mandate_id: "01HMANDATEAAAAAAAAAAAAAAA0",
    delta_mandate_id: null,
    adapter_id: "resend",
    adapter_version: "0.1.0",
    current_tier: 1,
    steps: [],
    side_effects: [],
    context: {
      email_alias: "demo@inbox.trustysquire.ai",
      project_name: "demo",
      user_display_name: null,
      generated: {},
      steps: {},
      vault: {},
    },
    subscription_id: null,
    credentials: null,
    failure_reason: null,
    failure_detail: null,
    created_at: "2026-05-10T07:59:00.000Z",
    updated_at: "2026-05-10T07:59:00.000Z",
    completed_at: null,
    ...overrides,
  };
}

function makeStep(overrides: Partial<StepRecord> = {}): StepRecord {
  return {
    index: 0,
    step_id: "create_account",
    type: "http_request",
    attempt: 1,
    tier: 1,
    started_at: NOW,
    completed_at: NOW,
    status: "success",
    request: { method: "POST", url: "https://example.com" },
    response: { status: 200 },
    error: null,
    fixture_uri: null,
    ...overrides,
  };
}

function makeSideEffect(overrides: Partial<SideEffect> = {}): SideEffect {
  return {
    id: "01HSIDEEFFECT0000000000000",
    type: "saas_account",
    reference: "resend:acc_123",
    reversible: true,
    reverse_action: { kind: "noop", reason: "test fixture" },
    emitted_at: NOW,
    ...overrides,
  };
}

function makeError(overrides: Partial<StepError> = {}): StepError {
  return {
    message: "boom",
    capability_violation: false,
    causes_tier_escalation: false,
    retryable: false,
    ...overrides,
  };
}

// ── Happy path ───────────────────────────────────────────────

describe("happy path", () => {
  it("CREATED + mandate_validated(needs_approval=false) → PROVISIONING", () => {
    const run = makeRun({ state: "CREATED" });
    const t: Transition = { kind: "mandate_validated", needs_approval: false };
    const r = transition(run, t, NOW);
    expect(r.next_state).toBe<RunState>("PROVISIONING");
    expect(r.patch.state).toBe<RunState>("PROVISIONING");
    expect(r.patch.state_entered_at).toBe(NOW);
    expect(r.event.from_state).toBe<RunState>("CREATED");
    expect(r.event.to_state).toBe<RunState>("PROVISIONING");
    expect(r.event.type).toBe("mandate_validated");
  });

  it("CREATED + mandate_validated(needs_approval=true) → PENDING_APPROVAL", () => {
    const run = makeRun({ state: "CREATED" });
    const r = transition(run, { kind: "mandate_validated", needs_approval: true }, NOW);
    expect(r.next_state).toBe<RunState>("PENDING_APPROVAL");
    expect(r.event.payload).toEqual({ needs_approval: true });
  });

  it("PENDING_APPROVAL + approval_granted → PROVISIONING (records delta_mandate_id)", () => {
    const run = makeRun({ state: "PENDING_APPROVAL" });
    const r = transition(
      run,
      { kind: "approval_granted", delta_mandate_id: "01HDELTA" },
      NOW,
    );
    expect(r.next_state).toBe<RunState>("PROVISIONING");
    expect(r.patch.delta_mandate_id).toBe("01HDELTA");
  });

  it("PROVISIONING + step_succeeded → ADAPTER_EXECUTING", () => {
    const run = makeRun({ state: "PROVISIONING" });
    const step = makeStep();
    const r = transition(run, { kind: "step_succeeded", step, new_side_effects: [] }, NOW);
    expect(r.next_state).toBe<RunState>("ADAPTER_EXECUTING");
    expect(r.patch.steps).toHaveLength(1);
  });

  it("ADAPTER_EXECUTING + step_succeeded stays in ADAPTER_EXECUTING and appends side effects", () => {
    const run = makeRun({ state: "ADAPTER_EXECUTING", state_entered_at: NOW });
    const step = makeStep({ index: 1, step_id: "verify_email" });
    const eff = makeSideEffect();
    const r = transition(
      run,
      { kind: "step_succeeded", step, new_side_effects: [eff] },
      LATER,
    );
    expect(r.next_state).toBe<RunState>("ADAPTER_EXECUTING");
    // state_entered_at preserved when staying in same state
    expect(r.patch.state_entered_at).toBe(NOW);
    expect(r.patch.side_effects).toEqual([eff]);
  });

  it("ADAPTER_EXECUTING + all_steps_complete(extracted=true) → CRED_EXTRACTED", () => {
    const run = makeRun({ state: "ADAPTER_EXECUTING" });
    const r = transition(run, { kind: "all_steps_complete", credentials_extracted: true }, NOW);
    expect(r.next_state).toBe<RunState>("CRED_EXTRACTED");
  });

  it("CRED_EXTRACTED + vault_write_succeeded → COMPLETE (sets subscription_id, completed_at)", () => {
    const run = makeRun({ state: "CRED_EXTRACTED" });
    const r = transition(
      run,
      { kind: "vault_write_succeeded", subscription_id: "01HSUB" },
      NOW,
    );
    expect(r.next_state).toBe<RunState>("COMPLETE");
    expect(r.patch.subscription_id).toBe("01HSUB");
    expect(r.patch.completed_at).toBe(NOW);
  });

  it("ADAPTER_EXECUTING + all_steps_complete(extracted=false) → COMPENSATING", () => {
    const run = makeRun({ state: "ADAPTER_EXECUTING" });
    const r = transition(
      run,
      { kind: "all_steps_complete", credentials_extracted: false },
      NOW,
    );
    expect(r.next_state).toBe<RunState>("COMPENSATING");
    expect(r.patch.failure_reason).toBe("no_credentials_extracted");
  });

  it("step_succeeded replaces a prior StepRecord with the same index (retry semantics)", () => {
    const prior = makeStep({ attempt: 1, status: "failure" });
    const run = makeRun({
      state: "ADAPTER_EXECUTING",
      steps: [prior],
    });
    const retried = makeStep({ attempt: 2, status: "success" });
    const r = transition(
      run,
      { kind: "step_succeeded", step: retried, new_side_effects: [] },
      NOW,
    );
    expect(r.patch.steps).toEqual([retried]);
  });
});

// ── Rejection paths ──────────────────────────────────────────

describe("rejection", () => {
  it("CREATED + rejected (no side effects) → REJECTED", () => {
    const run = makeRun({ state: "CREATED" });
    const r = transition(run, { kind: "rejected", reason: "user_cancelled" }, NOW);
    expect(r.next_state).toBe<RunState>("REJECTED");
    expect(r.patch.failure_reason).toBe("user_cancelled");
    expect(r.patch.completed_at).toBe(NOW);
  });

  it("PENDING_APPROVAL + approval_denied → REJECTED", () => {
    const run = makeRun({ state: "PENDING_APPROVAL" });
    const r = transition(run, { kind: "approval_denied", reason: "user_said_no" }, NOW);
    expect(r.next_state).toBe<RunState>("REJECTED");
    expect(r.patch.failure_reason).toBe("approval_denied");
    expect(r.event.payload).toEqual({ reason: "user_said_no" });
  });

  it("PENDING_APPROVAL + approval_expired → REJECTED", () => {
    const run = makeRun({ state: "PENDING_APPROVAL" });
    const r = transition(run, { kind: "approval_expired" }, NOW);
    expect(r.next_state).toBe<RunState>("REJECTED");
    expect(r.patch.failure_reason).toBe("approval_expired");
  });
});

// ── Failure routing ──────────────────────────────────────────

describe("step_failed routing", () => {
  it("capability_violation → COMPENSATING immediately, regardless of retry budget", () => {
    const run = makeRun({ state: "ADAPTER_EXECUTING", retry_count: 0 });
    const step = makeStep({ status: "failure" });
    const error = makeError({ capability_violation: true, retryable: true });
    const r = transition(run, { kind: "step_failed", step, error }, NOW);
    expect(r.next_state).toBe<RunState>("COMPENSATING");
    expect(r.patch.failure_reason).toBe("capability_violation");
  });

  it("causes_tier_escalation at tier 1 → TIER_ESCALATING", () => {
    const run = makeRun({ state: "ADAPTER_EXECUTING", current_tier: 1 });
    const step = makeStep({ status: "failure" });
    const error = makeError({ causes_tier_escalation: true });
    const r = transition(run, { kind: "step_failed", step, error }, NOW);
    expect(r.next_state).toBe<RunState>("TIER_ESCALATING");
  });

  it("causes_tier_escalation at tier 3 → COMPENSATING (no further escalation possible)", () => {
    const run = makeRun({ state: "ADAPTER_EXECUTING", current_tier: 3 });
    const step = makeStep({ status: "failure" });
    const error = makeError({ causes_tier_escalation: true });
    const r = transition(run, { kind: "step_failed", step, error }, NOW);
    expect(r.next_state).toBe<RunState>("COMPENSATING");
  });

  it("retryable + retry_count below budget → stays in state, increments retry_count", () => {
    const run = makeRun({ state: "ADAPTER_EXECUTING", retry_count: 1 });
    const step = makeStep({ status: "failure" });
    const error = makeError({ retryable: true });
    const r = transition(run, { kind: "step_failed", step, error }, NOW);
    expect(r.next_state).toBe<RunState>("ADAPTER_EXECUTING");
    expect(r.patch.retry_count).toBe(2);
    // state_entered_at preserved
    expect(r.patch.state_entered_at).toBe(run.state_entered_at);
  });

  it("retryable + retry_count at budget edge → COMPENSATING", () => {
    // retry_count = 2 means a third attempt is the final one; further
    // failure exhausts retries (2 + 1 === MAX_RETRIES).
    const run = makeRun({ state: "ADAPTER_EXECUTING", retry_count: 2 });
    const step = makeStep({ status: "failure" });
    const error = makeError({ retryable: true });
    const r = transition(run, { kind: "step_failed", step, error }, NOW);
    expect(r.next_state).toBe<RunState>("COMPENSATING");
  });

  it("non-retryable, non-escalatable error → COMPENSATING", () => {
    const run = makeRun({ state: "PROVISIONING" });
    const step = makeStep({ status: "failure" });
    const error = makeError({ detail: { code: 422 } });
    const r = transition(run, { kind: "step_failed", step, error }, NOW);
    expect(r.next_state).toBe<RunState>("COMPENSATING");
    expect(r.patch.failure_detail).toEqual({ code: 422 });
  });

  it("step_failed from PROVISIONING with retryable + budget → stays in PROVISIONING", () => {
    const run = makeRun({ state: "PROVISIONING", retry_count: 0 });
    const step = makeStep({ status: "failure" });
    const error = makeError({ retryable: true });
    const r = transition(run, { kind: "step_failed", step, error }, NOW);
    expect(r.next_state).toBe<RunState>("PROVISIONING");
    expect(r.patch.retry_count).toBe(1);
  });
});

// ── Tier escalation ──────────────────────────────────────────

describe("tier escalation", () => {
  it("TIER_ESCALATING + tier_escalation_started(2) → ADAPTER_EXECUTING, retries reset", () => {
    const run = makeRun({ state: "TIER_ESCALATING", current_tier: 1, retry_count: 2 });
    const r = transition(run, { kind: "tier_escalation_started", new_tier: 2 }, NOW);
    expect(r.next_state).toBe<RunState>("ADAPTER_EXECUTING");
    expect(r.patch.current_tier).toBe<Tier>(2);
    expect(r.patch.retry_count).toBe(0);
  });

  it("escalation from tier 2 to 3 succeeds", () => {
    const run = makeRun({ state: "TIER_ESCALATING", current_tier: 2 });
    const r = transition(run, { kind: "tier_escalation_started", new_tier: 3 }, NOW);
    expect(r.patch.current_tier).toBe<Tier>(3);
  });

  it("escalation that does not increase tier throws", () => {
    const run = makeRun({ state: "TIER_ESCALATING", current_tier: 2 });
    expect(() =>
      transition(run, { kind: "tier_escalation_started", new_tier: 2 }, NOW),
    ).toThrow(IllegalTransitionError);
  });

  it("tier_escalation_started from non-TIER_ESCALATING state throws", () => {
    const run = makeRun({ state: "ADAPTER_EXECUTING", current_tier: 1 });
    expect(() =>
      transition(run, { kind: "tier_escalation_started", new_tier: 2 }, NOW),
    ).toThrow(IllegalTransitionError);
  });
});

// ── Compensation ─────────────────────────────────────────────

describe("compensation", () => {
  it("COMPENSATING + compensation_started → COMPENSATING (audit only, state unchanged)", () => {
    const run = makeRun({ state: "COMPENSATING", state_entered_at: NOW });
    const r = transition(run, { kind: "compensation_started" }, LATER);
    expect(r.next_state).toBe<RunState>("COMPENSATING");
    expect(r.patch.state_entered_at).toBe(NOW);
    expect(r.event.from_state).toBe<RunState>("COMPENSATING");
    expect(r.event.to_state).toBe<RunState>("COMPENSATING");
  });

  it("COMPENSATING + compensation_completed → FAILED", () => {
    const run = makeRun({ state: "COMPENSATING" });
    const r = transition(run, { kind: "compensation_completed" }, NOW);
    expect(r.next_state).toBe<RunState>("FAILED");
    expect(r.patch.completed_at).toBe(NOW);
  });

  it("compensation_started outside COMPENSATING throws", () => {
    const run = makeRun({ state: "ADAPTER_EXECUTING" });
    expect(() => transition(run, { kind: "compensation_started" }, NOW)).toThrow(
      IllegalTransitionError,
    );
  });
});

// ── Invariants ───────────────────────────────────────────────

describe("invariants", () => {
  it.each<RunState>(["COMPLETE", "FAILED", "REJECTED"])(
    "cannot transition from terminal state %s",
    (state) => {
      const run = makeRun({ state });
      expect(() =>
        transition(run, { kind: "mandate_validated", needs_approval: false }, NOW),
      ).toThrow(IllegalTransitionError);
    },
  );

  it("cannot REJECT a run that already has side effects", () => {
    const run = makeRun({ state: "CREATED", side_effects: [makeSideEffect()] });
    expect(() => transition(run, { kind: "rejected", reason: "x" }, NOW)).toThrow(
      /side effects exist/,
    );
  });

  it("rejected from non-CREATED state throws", () => {
    const run = makeRun({ state: "PROVISIONING" });
    expect(() => transition(run, { kind: "rejected", reason: "x" }, NOW)).toThrow(
      IllegalTransitionError,
    );
  });

  it("transition does not mutate the input Run", () => {
    const run = makeRun({ state: "ADAPTER_EXECUTING", retry_count: 1 });
    const before = JSON.parse(JSON.stringify(run)) as Run;
    const step = makeStep({ status: "failure" });
    const error = makeError({ retryable: true });
    transition(run, { kind: "step_failed", step, error }, NOW);
    expect(run).toEqual(before);
  });

  it("every transition produces an event with from/to state matching the routing", () => {
    const run = makeRun({ state: "CREATED" });
    const r = transition(run, { kind: "mandate_validated", needs_approval: false }, NOW);
    expect(r.event.from_state).toBe<RunState>("CREATED");
    expect(r.event.to_state).toBe<RunState>("PROVISIONING");
    expect(r.event.run_id).toBe(run.id);
    expect(r.event.account_id).toBe(run.account_id);
  });

  it("step_succeeded from a non-execution state throws", () => {
    const run = makeRun({ state: "PENDING_APPROVAL" });
    const step = makeStep();
    expect(() =>
      transition(run, { kind: "step_succeeded", step, new_side_effects: [] }, NOW),
    ).toThrow(IllegalTransitionError);
  });

  it("step_failed from a non-execution state throws", () => {
    const run = makeRun({ state: "PENDING_APPROVAL" });
    const step = makeStep({ status: "failure" });
    const error = makeError();
    expect(() => transition(run, { kind: "step_failed", step, error }, NOW)).toThrow(
      IllegalTransitionError,
    );
  });

  it("vault_write_succeeded outside CRED_EXTRACTED throws", () => {
    const run = makeRun({ state: "ADAPTER_EXECUTING" });
    expect(() =>
      transition(run, { kind: "vault_write_succeeded", subscription_id: "x" }, NOW),
    ).toThrow(IllegalTransitionError);
  });

  it("approval_granted outside PENDING_APPROVAL throws", () => {
    const run = makeRun({ state: "PROVISIONING" });
    expect(() =>
      transition(run, { kind: "approval_granted", delta_mandate_id: "x" }, NOW),
    ).toThrow(IllegalTransitionError);
  });

  it("approval_denied outside PENDING_APPROVAL throws", () => {
    const run = makeRun({ state: "CREATED" });
    expect(() => transition(run, { kind: "approval_denied", reason: "x" }, NOW)).toThrow(
      IllegalTransitionError,
    );
  });

  it("approval_expired outside PENDING_APPROVAL throws", () => {
    const run = makeRun({ state: "CREATED" });
    expect(() => transition(run, { kind: "approval_expired" }, NOW)).toThrow(
      IllegalTransitionError,
    );
  });

  it("all_steps_complete outside ADAPTER_EXECUTING throws", () => {
    const run = makeRun({ state: "PROVISIONING" });
    expect(() =>
      transition(run, { kind: "all_steps_complete", credentials_extracted: true }, NOW),
    ).toThrow(IllegalTransitionError);
  });

  it("mandate_validated outside CREATED throws", () => {
    const run = makeRun({ state: "PROVISIONING" });
    expect(() =>
      transition(run, { kind: "mandate_validated", needs_approval: false }, NOW),
    ).toThrow(IllegalTransitionError);
  });

  it("compensation_completed outside COMPENSATING throws", () => {
    const run = makeRun({ state: "ADAPTER_EXECUTING" });
    expect(() => transition(run, { kind: "compensation_completed" }, NOW)).toThrow(
      IllegalTransitionError,
    );
  });
});

// ── Integration-ish: a full happy-path lifecycle ─────────────

describe("end-to-end lifecycle", () => {
  it("CREATED → PROVISIONING → ADAPTER_EXECUTING → CRED_EXTRACTED → COMPLETE", () => {
    let run = makeRun({ state: "CREATED" });
    const cred: ExtractedCredential = {
      type: "api_key",
      value: "sk_test_dummy",
      env_var_suggestion: "RESEND_API_KEY",
      reference: null,
    };

    // 1. mandate ok, no approval needed
    let r = transition(run, { kind: "mandate_validated", needs_approval: false }, NOW);
    run = applyPatch(run, r);

    // 2. first step ok
    r = transition(
      run,
      { kind: "step_succeeded", step: makeStep({ index: 0 }), new_side_effects: [] },
      NOW,
    );
    run = applyPatch(run, r);

    // 3. second step ok
    r = transition(
      run,
      {
        kind: "step_succeeded",
        step: makeStep({ index: 1, step_id: "verify_email" }),
        new_side_effects: [makeSideEffect()],
      },
      NOW,
    );
    run = applyPatch(run, r);

    // 4. all done, creds extracted
    r = transition(run, { kind: "all_steps_complete", credentials_extracted: true }, NOW);
    run = applyPatch(run, { ...r, patch: { ...r.patch, credentials: [cred] } });

    // 5. vault write
    r = transition(run, { kind: "vault_write_succeeded", subscription_id: "01HSUB" }, NOW);
    run = applyPatch(run, r);

    expect(run.state).toBe<RunState>("COMPLETE");
    expect(run.subscription_id).toBe("01HSUB");
    expect(run.completed_at).toBe(NOW);
  });
});

function applyPatch(run: Run, r: { patch: Run extends infer R ? Partial<R> : never } | { patch: object }): Run {
  return { ...run, ...(r.patch as Partial<Run>) };
}
