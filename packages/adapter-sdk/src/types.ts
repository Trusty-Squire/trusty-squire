// Adapter manifest type surface — the public contract every adapter authors against.
// Pure types. No I/O, no validation logic. Validation happens at registry publish time.

export type Recurrence = "none" | "one_time" | "monthly" | "yearly";
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

// ── Manifest identity ─────────────────────────────────────────

export interface AuthorRef {
  org: string;
  contact: string;
  homepage?: string;
}

export interface AuditRef {
  reviewer: string;
  reviewed_at: string;
  report_url?: string;
}

export interface AdapterMetadata {
  display_name: string;
  category: string;
  homepage: string;
  privacy_policy?: string;
  terms_of_service?: string;
  description?: string;
}

// ── Plans ─────────────────────────────────────────────────────

export interface PlanDef {
  id: string;
  display_name: string;
  monthly_cents: number;
  yearly_cents?: number;
  recurrence: Recurrence;
  description?: string;
}

// ── Capabilities (security perimeter) ────────────────────────

export interface PaymentCapability {
  max_authorize_cents: number;
  recurrence: Recurrence;
}

export interface EmailCapability {
  receive_from: string[];
}

export interface NetworkCapability {
  allowed_domains: string[];
}

export type VaultWriteKind =
  | "api_key"
  | "oauth_token"
  | "session_cookie"
  | "totp_seed"
  | "sso_metadata";

export interface VaultWriteCapability {
  kind: VaultWriteKind;
  reference_template: string;
  rotation_required: boolean;
}

export interface IdentityReleaseCapability {
  release_to_user_on: ("complete" | "request")[];
  redact_on_release: string[];
}

export interface OtpCapability {
  delivery: ("email" | "sms" | "totp")[];
  max_attempts: number;
}

export interface AdapterCapabilities {
  payment: PaymentCapability;
  email: EmailCapability;
  network: NetworkCapability;
  vault_writes: VaultWriteCapability[];
  identity_release?: IdentityReleaseCapability;
  otp?: OtpCapability;
}

// ── Side effect emission ─────────────────────────────────────

// What a step DECLARES it might emit. The runtime tracks the actual
// emitted side effects in its own SideEffect type (see runtime package).
export type SideEffectType =
  | "saas_account"
  | "stripe_charge"
  | "email_alias_consumed"
  | "vault_entry"
  | "totp_seed_stored";

export type ReverseAction =
  | {
      kind: "http_request";
      method: HttpMethod;
      url_template: string;
      // Optional — public/idempotent endpoints (e.g. unsubscribe links)
      // need no credential. The compensator's reverse-http executor
      // skips auth handling when this is omitted.
      auth?: ReverseAuth;
    }
  | { kind: "stripe_refund"; charge_id_template: string }
  | { kind: "vault_delete"; reference_template: string }
  | { kind: "noop"; reason: string };

export interface ReverseAuth {
  // Where the runtime should look up the credential to authenticate
  // the reverse-action call. Reads from the run's vault context.
  source: "vault" | "context";
  reference_template: string;
  scheme?: "bearer" | "basic" | "header";
  header_name?: string;
}

export interface SideEffectEmission {
  type: SideEffectType;
  reference_template: string;
  reversible: boolean;
  reverse_action: ReverseAction;
}

// ── Step definitions ─────────────────────────────────────────
// Closed set. New step kinds require an SDK version bump.

export interface StepBase {
  id: string;
  description?: string;
  emit_side_effect?: SideEffectEmission;
}

export interface HttpRequestStepDef extends StepBase {
  type: "http_request";
  request: HttpRequestSpec;
  expect: HttpExpect;
}

export interface HttpRequestSpec {
  method: HttpMethod;
  url_template: string;
  headers?: Record<string, string>;
  body_template?: unknown;
  auth?: ReverseAuth;
  timeout_ms?: number;
}

export interface HttpExpect {
  status: number | number[];
  // JSONPath-style selectors. Values stored under the step's id in
  // RunContext.steps for downstream interpolation.
  extract?: Record<string, string>;
  body_includes?: string[];
}

export interface WaitForEmailStepDef extends StepBase {
  type: "wait_for_email";
  match: EmailMatch;
  timeout_seconds: number;
}

export interface WaitForEmailWithCodeStepDef extends StepBase {
  type: "wait_for_email_with_code";
  match: EmailMatch;
  code_pattern: string;
  extract_to: string;
  timeout_seconds: number;
}

export interface ClickLinkInEmailStepDef extends StepBase {
  type: "click_link_in_email";
  match: EmailMatch;
  link_pattern: string;
  follow_redirects: boolean;
  timeout_seconds: number;
}

export interface WaitForWebhookStepDef extends StepBase {
  type: "wait_for_webhook";
  // Path the webhook endpoint exposes for this run; the runtime
  // assigns it from the alias pool.
  match_event: string;
  timeout_seconds: number;
}

export interface TotpGenerateStepDef extends StepBase {
  type: "totp_generate";
  seed_reference: string;
  extract_to: string;
}

export interface DelayStepDef extends StepBase {
  type: "delay";
  // Bounded — long delays belong in scheduler / wait_for_* steps.
  seconds: number;
}

export interface BranchStepDef extends StepBase {
  type: "branch";
  condition: BranchCondition;
  on_true: string;
  on_false: string;
}

export type BranchCondition =
  | { kind: "context_equals"; path: string; value: unknown }
  | { kind: "context_includes"; path: string; value: string }
  | { kind: "step_status"; step_id: string; status: "success" | "failure" };

export interface CustomHookStepDef extends StepBase {
  type: "custom_hook";
  // The hook name must exist in the adapter's reviewed code bundle.
  hook: string;
  capabilities_required: string[];
  inputs?: Record<string, unknown>;
}

export interface EmailMatch {
  from?: string | string[];
  subject_pattern?: string;
  body_pattern?: string;
}

export type StepDef =
  | HttpRequestStepDef
  | WaitForEmailStepDef
  | WaitForEmailWithCodeStepDef
  | ClickLinkInEmailStepDef
  | WaitForWebhookStepDef
  | TotpGenerateStepDef
  | DelayStepDef
  | BranchStepDef
  | CustomHookStepDef;

// ── Flows ─────────────────────────────────────────────────────

export interface FlowDef {
  steps: StepDef[];
  // Step ID where execution begins. Defaults to steps[0].id when omitted.
  entry?: string;
}

// ── Post-signup hints ────────────────────────────────────────

export interface PostSignupHints {
  default_dashboard_url?: string;
  api_key_visible_in_ui?: boolean;
  next_steps?: string[];
}

// ── Tier 2 overrides ─────────────────────────────────────────

export interface TierOverrides {
  // Adapter authors describe alternate flows when tier-1 retries fail.
  // The runtime escalates by switching to these step lists.
  signup?: FlowDef;
  rotate?: FlowDef;
  cancel?: FlowDef;
}

// ── Migrations ───────────────────────────────────────────────

export interface MigrationDef {
  from_version: string;
  to_version: string;
  // Expressed as a flow that takes the old subscription state to
  // the new one. Reviewed alongside the adapter at registry publish.
  steps: StepDef[];
}

// ── Reliability hints ────────────────────────────────────────

export interface ReliabilityHints {
  expected_signup_seconds?: number;
  expected_p99_seconds?: number;
  known_outage_windows?: string[];
}

// ── Top-level manifest ───────────────────────────────────────

export interface AdapterManifest {
  service: string;
  version: string;
  schema_version: 1;

  authored_by: AuthorRef;
  audit: AuditRef;
  signature: string;

  metadata: AdapterMetadata;
  plans: PlanDef[];
  default_plan: string;

  capabilities: AdapterCapabilities;

  signup: FlowDef;
  cancel: FlowDef;
  rotate: FlowDef;

  post_signup?: PostSignupHints;
  tier_2_overrides?: TierOverrides;
  migrations?: Record<string, MigrationDef>;
  reliability?: ReliabilityHints;
}
