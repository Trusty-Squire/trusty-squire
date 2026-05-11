// Runtime types — the Run record and everything resumable-on-restart.
//
// All timestamps are ISO 8601 strings in TypeScript; Prisma stores them
// as DateTime. Pure data; no methods.

import type { ReverseAction, SideEffectType } from "@trusty-squire/adapter-sdk";

// ── State machine surface ────────────────────────────────────

export type RunState =
  | "CREATED"
  | "MANDATE_VALIDATED"
  | "PENDING_APPROVAL"
  | "PROVISIONING"
  | "ADAPTER_EXECUTING"
  | "CRED_EXTRACTED"
  | "VAULT_WRITTEN"
  | "TIER_ESCALATING"
  | "COMPENSATING"
  | "COMPLETE"
  | "FAILED"
  | "REJECTED";

export const TERMINAL_STATES: ReadonlySet<RunState> = new Set<RunState>([
  "COMPLETE",
  "FAILED",
  "REJECTED",
]);

export const isTerminal = (s: RunState): boolean => TERMINAL_STATES.has(s);

export type Tier = 1 | 2 | 3;

// ── Run-shaped pieces ────────────────────────────────────────

export type StepStatus = "pending" | "running" | "success" | "failure" | "skipped";

export interface StepRecord {
  index: number;
  step_id: string;
  type: string;
  attempt: number;
  tier: Tier;
  started_at: string | null;
  completed_at: string | null;
  status: StepStatus;
  request: unknown | null;
  response: unknown | null;
  error: StepError | null;
  fixture_uri: string | null;
}

export interface StepError {
  message: string;
  // Three orthogonal flags drive the failure-handling switch in the
  // state machine. Adapters/executors stamp these based on the cause.
  capability_violation: boolean;
  causes_tier_escalation: boolean;
  retryable: boolean;
  detail?: unknown;
}

export interface SideEffect {
  id: string;
  type: SideEffectType;
  reference: string;
  reversible: boolean;
  reverse_action: ReverseAction;
  emitted_at: string;
}

// Credential type names — superset of the adapter SDK's VaultWriteKind
// (so any kind an adapter declares is assignable here) plus generic
// 'username_password' and 'secret' for vault entries that don't
// originate from a manifest declaration.
export type CredentialType =
  | "api_key"
  | "oauth_token"
  | "username_password"
  | "session_cookie"
  | "secret"
  | "totp_seed"
  | "sso_metadata";

export interface ExtractedCredential {
  type: CredentialType;
  // Plaintext, briefly stored on the run between step extraction and
  // vault write. Nulled (alongside the whole `credentials` array) once
  // vault_write_succeeded commits.
  value: string;
  // What env var this should be exported as on the user's machine
  // (e.g. RESEND_API_KEY). null when the adapter manifest doesn't
  // declare one — the user can set it themselves.
  env_var_suggestion: string | null;
  // Vault reference; null pre-vault-write, populated post-vault-write
  // by the `vault.store` response.
  reference: string | null;
}

export interface RunContext {
  email_alias: string;
  project_name: string;
  user_display_name: string | null;
  generated: { strong_password?: string; [k: string]: string | undefined };
  steps: Record<string, unknown>;
  vault: Record<string, string>;
}

export interface Run {
  id: string;
  account_id: string;
  idempotency_key: string;
  service: string;
  plan: string;
  project_name: string;
  user_facing_purpose: string | null;

  state: RunState;
  state_entered_at: string;
  retry_count: number;

  mandate_id: string;
  delta_mandate_id: string | null;

  adapter_id: string;
  adapter_version: string;
  current_tier: Tier;

  steps: StepRecord[];
  side_effects: SideEffect[];
  context: RunContext;

  subscription_id: string | null;
  credentials: ExtractedCredential[] | null;

  failure_reason: string | null;
  failure_detail: unknown | null;

  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

// ── Audit event ──────────────────────────────────────────────

// What the state machine emits per transition. Caller stamps id +
// emitted_at when persisting (state machine stays pure / deterministic).
export type RunEventType =
  | "mandate_validated"
  | "approval_granted"
  | "approval_denied"
  | "approval_expired"
  | "step_succeeded"
  | "step_failed"
  | "tier_escalation_started"
  | "all_steps_complete"
  | "vault_write_succeeded"
  | "vault_write_failed"
  | "compensation_started"
  | "compensation_completed"
  | "rejected";

export interface RunEventDraft {
  run_id: string;
  account_id: string;
  type: RunEventType;
  from_state: RunState;
  to_state: RunState;
  payload: Record<string, unknown>;
}

export interface RunEvent extends RunEventDraft {
  id: string;
  emitted_at: string;
}

// ── Transitions ──────────────────────────────────────────────

export type Transition =
  | { kind: "mandate_validated"; needs_approval: boolean }
  | { kind: "approval_granted"; delta_mandate_id: string }
  | { kind: "approval_denied"; reason: string }
  | { kind: "approval_expired" }
  | {
      kind: "step_succeeded";
      step: StepRecord;
      new_side_effects: SideEffect[];
      // Optional merge into run.context.generated — populated when an
      // executor extracts a value via the step's extract_to field
      // (wait_for_email_with_code, totp_generate). Subsequent steps
      // reference these via ${generated.<extract_to>}.
      generated_updates?: Record<string, string>;
    }
  | { kind: "step_failed"; step: StepRecord; error: StepError }
  | { kind: "tier_escalation_started"; new_tier: Tier }
  | {
      kind: "all_steps_complete";
      credentials_extracted: boolean;
      // Populated by the executor when extraction succeeded (matches
      // manifest.capabilities.vault_writes against extracted step
      // values). The state machine writes these into the patch verbatim.
      credentials?: ExtractedCredential[];
    }
  | {
      kind: "vault_write_succeeded";
      subscription_id: string;
      // Vault entries created during the write — appended to the run's
      // side effects so a future cancel/rotate has a reverse path.
      new_side_effects?: SideEffect[];
    }
  | {
      kind: "vault_write_failed";
      reason: string;
      // Side effects already produced by the partial write; persisted
      // for audit but NOT reversed (per spec: "stay partial").
      partial_side_effects?: SideEffect[];
      detail?: unknown;
    }
  | { kind: "compensation_started" }
  | { kind: "compensation_completed"; results?: CompensationResults }
  | { kind: "rejected"; reason: string };

// Per-side-effect outcome bundle attached to the compensation_completed
// event payload. Lets the audit trail explain "we tried this, it
// failed three times" without expanding the state space.
export interface CompensationResult {
  side_effect_id: string;
  outcome: "succeeded" | "failed" | "skipped_non_reversible";
  attempts?: number;
  error?: string;
}

export interface CompensationResults {
  per_effect: CompensationResult[];
}

// Caller-supplied patch the persistence layer applies to the Run row.
// Keys are limited to whitelisted Run fields the state machine is
// allowed to mutate.
export interface RunPatch {
  state: RunState;
  state_entered_at: string;
  retry_count?: number;
  current_tier?: Tier;
  steps?: StepRecord[];
  side_effects?: SideEffect[];
  delta_mandate_id?: string | null;
  subscription_id?: string | null;
  credentials?: ExtractedCredential[] | null;
  failure_reason?: string | null;
  failure_detail?: unknown | null;
  completed_at?: string | null;
  // Shallow merge into run.context.generated — values added here
  // win over existing keys with the same name.
  context_generated_merge?: Record<string, string>;
}

export interface TransitionResult {
  next_state: RunState;
  event: RunEventDraft;
  patch: RunPatch;
}
