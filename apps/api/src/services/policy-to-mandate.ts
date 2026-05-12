// Deterministic mapping from the PWA's MandatePolicy (signup intent
// shape) to the canonical Mandate the mandate-validator + runtime
// expect.
//
// The signed bundle's payload contains the policy intent — that's
// what the user has audit-visible authority over. The mandate is
// derived from that intent server-side; the mapping below is the
// single source of truth for that derivation, recorded in code and
// tested.

import { ulid } from "ulid";
import type {
  ActionType,
  ConfidenceLevel,
  Mandate,
  SigningDevice,
} from "@trusty-squire/mandate-validator";

// Wire shape — must match apps/pwa/src/lib/mandate.ts MandatePolicy.
export interface MandatePolicy {
  spend_limit_cents_per_month: number;
  allowed_categories: string[];
  silent_signup: {
    max_monthly_cost_cents: number;
    allow_free: boolean;
  };
  approval_required_categories: string[];
  // The PWA's CeremonyContext-shaped map. The mandate uses ActionType,
  // which is a strict subset; we copy across the overlapping keys and
  // ignore the rest (the mandate-validator floors handle the missing
  // ones at evaluation time).
  confidence_requirements: {
    login: ConfidenceLevel;
    mandate_signing: ConfidenceLevel;
    delta_mandate_signing: ConfidenceLevel;
    provision_silent: ConfidenceLevel;
    provision_approved: ConfidenceLevel;
    amend_mandate: ConfidenceLevel;
    cancel: ConfidenceLevel;
    rotate: ConfidenceLevel;
    release_identity: ConfidenceLevel;
  };
}

// Web Bot Auth placeholder — v0 ships before WBA key provisioning,
// and the mandate-validator only checks the issuer.domain, so this
// can be empty until that work lands.
const ISSUER: Mandate["issuer"] = {
  domain: "trustysquire.ai",
  web_bot_auth_key: "",
};

export interface PolicyToMandateInput {
  policy: MandatePolicy;
  accountId: string;
  signedAt: string; // ISO
  expiresAt: string; // ISO
  signingDevice: SigningDevice;
}

export function policyToMandate(input: PolicyToMandateInput): Mandate {
  const { policy } = input;

  // Daily silent max defaults to 1/10th of the monthly budget. Per-
  // action silent max defaults to the silent-signup ceiling from the
  // policy. Per-subscription cap mirrors the silent ceiling.
  const dailySilentMax = Math.floor(policy.spend_limit_cents_per_month / 10);
  const perActionSilentMax = policy.silent_signup.max_monthly_cost_cents;

  // ActionType subset of the PWA's broader confidence_requirements map.
  const confidence: Record<ActionType, ConfidenceLevel> = {
    provision: policy.confidence_requirements.provision_silent,
    rotate: policy.confidence_requirements.rotate,
    cancel: policy.confidence_requirements.cancel,
    amend_mandate: policy.confidence_requirements.amend_mandate,
    release_identity: policy.confidence_requirements.release_identity,
  };

  return {
    v: 1,
    id: ulid(),
    account_id: input.accountId,
    monthly_budget_cents: policy.spend_limit_cents_per_month,
    daily_silent_max_cents: dailySilentMax,
    per_action_silent_max_cents: perActionSilentMax,
    per_subscription_max_cents: perActionSilentMax,
    allowed_categories: [...policy.allowed_categories],
    allowed_services: "*",
    blocked_services: [],
    step_up_triggers: {
      above_silent_max: true,
      new_category: true,
      novel_service: true,
      near_daily_limit: true,
      near_monthly_limit: true,
      velocity_anomaly: true,
      session_anomaly: true,
      recurring_commitment: true,
      cross_account_action: true,
    },
    silently_approved_services: [],
    confidence_requirements: confidence,
    not_before: input.signedAt,
    not_after: input.expiresAt,
    signing_devices: [input.signingDevice],
    issuer: ISSUER,
  };
}
