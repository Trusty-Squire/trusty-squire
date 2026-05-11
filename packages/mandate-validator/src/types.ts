// Type surface for the mandate validator. Mandates and Deltas are the
// signed JSON shapes the user's device produces; everything in this
// file is data, not behaviour.

export type SignatureAlg = "Ed25519" | "ES256";
export type ConfidenceLevel = "low" | "medium" | "high";
export type ActionType =
  | "provision"
  | "rotate"
  | "cancel"
  | "amend_mandate"
  | "release_identity";

// Mandate-validator-internal action surface — broader than the
// runtime ActionType because it covers Vouchflow ceremony contexts
// (login, mandate_signing, delta_mandate_signing) plus the runtime
// action types. The DEFAULT_CONFIDENCE_REQUIREMENTS below maps each
// to a sensible floor; mandate authors may raise (never lower) per
// the lower-bound invariant enforced in verifyMandateSignature.
export type CeremonyContext =
  | "login"
  | "mandate_signing"
  | "delta_mandate_signing"
  | "provision_silent"
  | "provision_approved"
  | "amend_mandate"
  | "cancel"
  | "rotate"
  | "release_identity";

// Floor values used when a mandate doesn't specify a confidence
// requirement for an action type. Mandate authors can raise these
// but the validator rejects any mandate that LOWERS one (per the
// "weak settings can't be smuggled in" invariant).
export const DEFAULT_CONFIDENCE_REQUIREMENTS: Record<CeremonyContext, ConfidenceLevel> = {
  login: "low",
  mandate_signing: "high",
  delta_mandate_signing: "high",
  provision_silent: "low",
  provision_approved: "medium",
  amend_mandate: "high",
  cancel: "low",
  rotate: "medium",
  release_identity: "high",
};

// Recurrence on a ProposedAction can be 'none' (one-shot, e.g. amend_mandate);
// recurrence on the signed Delta payload is one of the three paying values.
export type Recurrence = "one_time" | "monthly" | "yearly" | "none";
export type DeltaRecurrence = "one_time" | "monthly" | "yearly";

export type DevicePlatform = "ios" | "android" | "web";

export interface SigningDevice {
  id: string;
  alg: SignatureAlg;
  // Base64url. ES256 → SPKI DER. Ed25519 → raw 32 bytes.
  public_key: string;
  platform: DevicePlatform;
  registered_at: string;
  revoked_at: string | null;
}

export interface StepUpTriggers {
  above_silent_max: boolean;
  new_category: boolean;
  novel_service: boolean;
  near_daily_limit: boolean;
  near_monthly_limit: boolean;
  velocity_anomaly: boolean;
  session_anomaly: boolean;
  recurring_commitment: boolean;
  cross_account_action: boolean;
}

export interface SilentApproval {
  service: string;
  max_monthly_cents: number;
  approved_at: string;
  // Source of the approval: an initial mandate or a previous delta id.
  approved_via: string;
}

export interface Mandate {
  v: 1;
  id: string;
  account_id: string;

  monthly_budget_cents: number;
  daily_silent_max_cents: number;
  per_action_silent_max_cents: number;
  per_subscription_max_cents: number;
  allowed_categories: string[];
  allowed_services: string[] | "*";
  blocked_services: string[];
  step_up_triggers: StepUpTriggers;
  silently_approved_services: SilentApproval[];
  confidence_requirements: Record<ActionType, ConfidenceLevel>;

  not_before: string;
  not_after: string;

  signing_devices: SigningDevice[];
  issuer: { domain: "trustysquire.ai"; web_bot_auth_key: string };
}

export interface MandateSignature {
  alg: SignatureAlg;
  // Base64url. ES256 may arrive as DER or raw r||s — verifyMandateSignature
  // accepts both and normalises before passing to crypto.verify.
  sig: string;
  signed_at: string;
  nonce: string;
  signing_device_id: string;
}

export interface SignedMandate {
  payload: Mandate;
  signature: MandateSignature;
}

export interface Delta {
  v: 1;
  id: string;
  mandate_id: string;
  account_id: string;

  action: {
    type: ActionType;
    run_id: string;
    service: string;
    plan: string;
    cost_cents: number;
    recurrence: DeltaRecurrence;
  };

  // When set, on success the runtime adds the service to the mandate's
  // silently_approved_services list (durable extension, capped by
  // max_monthly_cents).
  remember: { service: string; max_monthly_cents: number } | null;

  not_before: string;
  not_after: string;
  // Server-issued challenge from issueDeltaChallenge.
  nonce: string;
  // sha256(`${run_id}|${service}|${plan}|${cost_cents}`) — binds the
  // approval to the specific in-flight run. Mismatch is the
  // security-critical failure mode.
  run_binding: string;
}

export interface DeltaSignature {
  alg: SignatureAlg;
  sig: string;
  signed_at: string;
  signing_device_id: string;
}

export interface SignedDelta {
  payload: Delta;
  signature: DeltaSignature;
}

// What the executor passes to evaluateAction. Carries enough to apply
// every short-circuit and step-up rule without a follow-up DB call.
export interface ProposedAction {
  type: ActionType;
  service: string;
  category: string;
  plan: string;
  cost_cents: number;
  recurrence: Recurrence;
}

export interface EvaluationContext {
  // ISO 8601. Injected so tests can pin the clock.
  now: string;
  // Adapter / session-anomaly detector (separate service) populates this.
  // The validator doesn't compute these — it just consumes them.
  session_anomaly_flags: string[];
}

export type ApprovalReason =
  | "above_silent_max"
  | "new_category"
  | "novel_service"
  | "near_daily_limit"
  | "near_monthly_limit"
  | "recurring_commitment"
  | "session_anomaly"
  | "velocity_anomaly"
  | "cross_account_action";

export type PolicyDecision =
  | { kind: "silent"; mandate_id: string }
  | {
      kind: "needs_approval";
      mandate_id: string;
      reasons: ApprovalReason[];
      required_confidence: ConfidenceLevel;
    }
  | { kind: "reject"; reason: string };

export interface ValidationResult {
  valid: boolean;
  reason?: string;
}

// Dependency-injected seam. Tests pass mocks; the runtime wires Prisma
// in chunk 5+. The validator never imports a Prisma client directly.
export interface MandateValidatorDeps {
  recordNonce: (nonce: string) => Promise<void>;
  isNonceUsed: (nonce: string) => Promise<boolean>;
  // Sum of completed-or-in-flight spend on this account since `since`,
  // in cents. Used for monthly-budget + daily-limit checks.
  getRecentSpend: (accountId: string, since: Date) => Promise<number>;
  getProvisionedServices: (accountId: string) => Promise<string[]>;
  getProvisionedCategories: (accountId: string) => Promise<string[]>;
  getRevokedMandates: () => Promise<Set<string>>;
  // Optional clock injection (tests pin time; production reads system).
  now?: () => Date;
}

export interface DeltaChallenge {
  nonce: string;
  expires_at: string;
}
