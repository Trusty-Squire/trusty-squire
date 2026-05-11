// Standing-mandate signature verification.
//
// Two entry points:
//   - verifyMandateSignature: legacy raw-signature path (Ed25519 /
//     ES256 over canonical bytes). Used in unit tests + retained for
//     future direct-signing scenarios.
//   - verifyMandateBundle: Vouchflow signPayload bundle path. This is
//     what the API uses today. The bundle's JWS authoritatively
//     conveys context, confidence, and the signing device.
//
// Both end with `recordNonce`-on-success so a verified bundle can't be
// replayed against a second runtime instance, and both enforce the
// lower-bound invariant on confidence_requirements (a mandate cannot
// downgrade the spec's DEFAULT_CONFIDENCE_REQUIREMENTS floor).

import { canonicalBytes, canonicalString } from "./canonicalize.js";
import { verifyEd25519 } from "./crypto/vouchflow.js";
import { verifyEs256 } from "./crypto/webauthn.js";
import {
  VouchflowVerificationError,
  type VouchflowSignedBundle,
  type VouchflowVerifier,
  type VouchflowVerifiedClaims,
} from "./vouchflow.js";
import {
  DEFAULT_CONFIDENCE_REQUIREMENTS,
  type CeremonyContext,
  type ConfidenceLevel,
  type Mandate,
  type MandateValidatorDeps,
  type SignedMandate,
  type ValidationResult,
} from "./types.js";

const SIGNED_AT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export async function verifyMandateSignature(
  signed: SignedMandate,
  deps: MandateValidatorDeps,
): Promise<ValidationResult> {
  const { payload, signature } = signed;

  const device = payload.signing_devices.find((d) => d.id === signature.signing_device_id);
  if (device === undefined) {
    return { valid: false, reason: "unknown_signing_device" };
  }
  if (device.alg !== signature.alg) {
    return { valid: false, reason: "signature_alg_mismatch" };
  }
  if (device.revoked_at !== null) {
    // A revoked device's signatures are honoured only if they were
    // produced strictly before revocation. We compare with strict <
    // because clock skew at the signer can put a fresh signature on
    // the wrong side of the revocation timestamp.
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

  if (await deps.isNonceUsed(signature.nonce)) {
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

  // Order: only burn the nonce after we've established the signature is
  // good. A failed verification leaves the nonce reusable for a later
  // legitimate attempt (e.g. retry after a transient crypto error).
  await deps.recordNonce(signature.nonce);

  return { valid: true };
}

// ── Vouchflow signPayload path ───────────────────────────────

export interface VouchflowMandateVerification {
  result: ValidationResult;
  // Populated on success. The caller persists these alongside the
  // mandate so the audit log can answer "which device signed this?"
  // without storing the raw bundle.
  claims?: VouchflowVerifiedClaims;
  mandate?: Mandate;
}

// Verify a Vouchflow signPayload bundle that contains a Mandate as its
// payload. Returns the parsed-and-trusted mandate on success.
export async function verifyMandateBundle(
  bundle: VouchflowSignedBundle,
  verifier: VouchflowVerifier,
  deps: MandateValidatorDeps,
): Promise<VouchflowMandateVerification> {
  let claims: VouchflowVerifiedClaims;
  try {
    claims = await verifier.verify(
      bundle,
      "mandate_signing",
      // Per the spec, mandate signing always requires high. Bundles
      // below this never reach the lower-bound-invariant check below.
      "high",
    );
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

  // session_id is the Vouchflow-issued challenge id. It's structurally
  // single-use server-side at Vouchflow but we also burn it in our own
  // UsedNonce table — defense-in-depth against a Vouchflow bug or a
  // bundle replayed at us by a misbehaving client.
  if (await deps.isNonceUsed(claims.session_id)) {
    return { result: { valid: false, reason: "nonce_replay" } };
  }

  let mandate: Mandate;
  try {
    mandate = verifier.parsePayload<Mandate>(bundle);
  } catch (err) {
    if (err instanceof VouchflowVerificationError) {
      return { result: { valid: false, reason: err.code } };
    }
    throw err;
  }

  // Lower-bound invariant: a mandate must NOT downgrade any context
  // below its DEFAULT_CONFIDENCE_REQUIREMENTS floor. Raising is fine
  // (a paranoid user requiring `high` for cancellation is legitimate).
  const invariantIssue = checkConfidenceLowerBound(mandate);
  if (invariantIssue !== null) {
    return { result: { valid: false, reason: invariantIssue } };
  }

  await deps.recordNonce(claims.session_id);
  return { result: { valid: true }, claims, mandate };
}

// Returns an error reason string if the mandate downgrades any
// confidence requirement below the spec floor, or null if the mandate
// is consistent with the lower-bound invariant.
//
// The mandate's `confidence_requirements` is keyed by ActionType (the
// runtime's narrower type); the floor map keys by CeremonyContext. We
// only enforce the invariant for the overlapping keys.
export function checkConfidenceLowerBound(mandate: Mandate): string | null {
  for (const [actionType, declared] of Object.entries(mandate.confidence_requirements)) {
    const ctx = actionType as CeremonyContext;
    const floor = DEFAULT_CONFIDENCE_REQUIREMENTS[ctx];
    if (floor === undefined) continue;
    if (!meets(declared, floor)) {
      return `mandate_downgrades_confidence:${actionType}:${declared}<${floor}`;
    }
  }
  return null;
}

const RANK: Record<ConfidenceLevel, number> = { low: 0, medium: 1, high: 2 };
function meets(actual: ConfidenceLevel, floor: ConfidenceLevel): boolean {
  return RANK[actual] >= RANK[floor];
}

// Re-export the canonicalize helper for callers that hand-construct
// the bundle's `payload` string (e.g. tests).
export { canonicalString };
