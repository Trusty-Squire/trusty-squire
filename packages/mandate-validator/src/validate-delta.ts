// Per-action delta (approval) signature verification.
//
// Two security-critical extras over the standing-mandate path:
//   1. run_binding must match sha256(run_id|service|plan|cost_cents) —
//      mismatch means the approval was obtained for a different run /
//      cost and is being replayed. This is the "the user said yes to
//      $5 but you're charging $50" attack.
//   2. The delta's payload.mandate_id must equal mandate.id — prevents
//      cross-mandate splicing.
//
// Two paths, mirroring validate-mandate.ts:
//   - verifyDeltaSignature: raw-signature path (legacy / unit tests)
//   - verifyDeltaBundle:    Vouchflow signPayload bundle path (API)

import { canonicalBytes } from "./canonicalize.js";
import { verifyEd25519 } from "./crypto/vouchflow.js";
import { verifyEs256 } from "./crypto/webauthn.js";
import { computeRunBinding } from "./run-binding.js";
import {
  VouchflowVerificationError,
  type VouchflowSignedBundle,
  type VouchflowVerifier,
  type VouchflowVerifiedClaims,
} from "./vouchflow.js";
import type {
  Delta,
  Mandate,
  MandateValidatorDeps,
  SignedDelta,
  ValidationResult,
} from "./types.js";

const SIGNED_AT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export async function verifyDeltaSignature(
  signed: SignedDelta,
  mandate: Mandate,
  deps: MandateValidatorDeps,
): Promise<ValidationResult> {
  const { payload, signature } = signed;

  if (payload.mandate_id !== mandate.id) {
    return { valid: false, reason: "mandate_id_mismatch" };
  }
  if (payload.account_id !== mandate.account_id) {
    return { valid: false, reason: "account_id_mismatch" };
  }

  // Recompute the binding from the action and compare. Constant-time
  // comparison isn't required (both values are known to the validator)
  // but stick to value equality on the hex digest.
  const expectedBinding = computeRunBinding(payload.action);
  if (expectedBinding !== payload.run_binding) {
    return { valid: false, reason: "run_binding_mismatch" };
  }

  const device = mandate.signing_devices.find(
    (d) => d.id === signature.signing_device_id,
  );
  if (device === undefined) {
    return { valid: false, reason: "unknown_signing_device" };
  }
  if (device.alg !== signature.alg) {
    return { valid: false, reason: "signature_alg_mismatch" };
  }
  if (device.revoked_at !== null) {
    if (Date.parse(signature.signed_at) >= Date.parse(device.revoked_at)) {
      return { valid: false, reason: "signing_device_revoked" };
    }
  }

  const now = (deps.now?.() ?? new Date()).getTime();
  const signedAtMs = Date.parse(signature.signed_at);
  if (Number.isNaN(signedAtMs)) {
    return { valid: false, reason: "signed_at_unparseable" };
  }
  if (now - signedAtMs > SIGNED_AT_MAX_AGE_MS) {
    return { valid: false, reason: "signed_at_too_old" };
  }

  if (await deps.isNonceUsed(payload.nonce)) {
    return { valid: false, reason: "nonce_replay" };
  }

  const message = canonicalBytes(payload);
  let verified: boolean;
  try {
    verified =
      signature.alg === "Ed25519"
        ? verifyEd25519(device.public_key, message, signature.sig)
        : verifyEs256(device.public_key, message, signature.sig);
  } catch (err) {
    return {
      valid: false,
      reason: `crypto_error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!verified) {
    return { valid: false, reason: "signature_invalid" };
  }

  await deps.recordNonce(payload.nonce);
  return { valid: true };
}

// ── Vouchflow signPayload path ───────────────────────────────

export interface VouchflowDeltaVerification {
  result: ValidationResult;
  claims?: VouchflowVerifiedClaims;
  delta?: Delta;
}

// Verify a Vouchflow signPayload bundle whose payload is a Delta.
// minConfidence is computed per the active mandate's
// confidence_requirements (DEFAULT_CONFIDENCE_REQUIREMENTS floor when
// the mandate doesn't specify) — the API layer passes the resolved
// requirement; we don't re-decide here.
export async function verifyDeltaBundle(
  bundle: VouchflowSignedBundle,
  mandate: Mandate,
  minConfidence: Parameters<VouchflowVerifier["verify"]>[2],
  verifier: VouchflowVerifier,
  deps: MandateValidatorDeps,
): Promise<VouchflowDeltaVerification> {
  let claims: VouchflowVerifiedClaims;
  try {
    claims = await verifier.verify(bundle, "delta_mandate_signing", minConfidence);
  } catch (err) {
    if (err instanceof VouchflowVerificationError) {
      return { result: { valid: false, reason: err.code } };
    }
    return {
      result: {
        valid: false,
        reason: `vouchflow_error: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }

  let delta: Delta;
  try {
    delta = verifier.parsePayload<Delta>(bundle);
  } catch (err) {
    if (err instanceof VouchflowVerificationError) {
      return { result: { valid: false, reason: err.code } };
    }
    throw err;
  }

  if (delta.mandate_id !== mandate.id) {
    return { result: { valid: false, reason: "mandate_id_mismatch" } };
  }
  if (delta.account_id !== mandate.account_id) {
    return { result: { valid: false, reason: "account_id_mismatch" } };
  }
  const expectedBinding = computeRunBinding(delta.action);
  if (expectedBinding !== delta.run_binding) {
    return { result: { valid: false, reason: "run_binding_mismatch" } };
  }

  if (await deps.isNonceUsed(claims.session_id)) {
    return { result: { valid: false, reason: "nonce_replay" } };
  }

  await deps.recordNonce(claims.session_id);
  return { result: { valid: true }, claims, delta };
}
