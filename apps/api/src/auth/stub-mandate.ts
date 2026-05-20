// Stub mandate for OAuth-created accounts.
//
// The founder's decision: signup is OAuth, and the mandate-signing
// ceremony is stubbed for now. So a freshly OAuth-registered account
// gets this minimal default mandate attached automatically — no user
// signing step. It is deliberately restrictive: $0 paid budget, free
// signups allowed. Paid spend stays gated until the account holder
// signs a real mandate (that UI is deferred).

import type { SigningDevice } from "@trusty-squire/mandate-validator";
import type { ActiveMandateRecord } from "../services/in-memory-account-store.js";
import { policyToMandate, type MandatePolicy } from "../services/policy-to-mandate.js";

const STUB_POLICY: MandatePolicy = {
  spend_limit_cents_per_month: 0,
  allowed_categories: [],
  silent_signup: { max_monthly_cost_cents: 0, allow_free: true },
  approval_required_categories: [],
  confidence_requirements: {
    login: "low",
    mandate_signing: "high",
    delta_mandate_signing: "high",
    provision_silent: "low",
    provision_approved: "high",
    amend_mandate: "high",
    cancel: "medium",
    rotate: "medium",
    release_identity: "high",
  },
};

export function stubMandate(accountId: string, now: Date): ActiveMandateRecord {
  const device: SigningDevice = {
    id: "oauth-stub",
    alg: "Ed25519",
    public_key: "",
    platform: "web",
    registered_at: now.toISOString(),
    revoked_at: null,
  };
  // 100-year horizon — the stub is replaced wholesale when a real
  // mandate is signed, so its expiry just needs to be far off.
  const farFuture = new Date(now.getTime() + 100 * 365 * 24 * 60 * 60 * 1000);
  const mandate = policyToMandate({
    policy: STUB_POLICY,
    accountId,
    signedAt: now.toISOString(),
    expiresAt: farFuture.toISOString(),
    signingDevice: device,
  });
  return {
    account_id: accountId,
    mandate,
    signed_by_device: "oauth-stub",
    vouchflow_device_token: "oauth-stub",
    session_id: `oauth-stub-${accountId}`,
    installed_at: now,
  };
}
