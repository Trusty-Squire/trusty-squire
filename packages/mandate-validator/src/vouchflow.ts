// Vouchflow signPayload bundle verification.
//
// Replaces direct WebAuthn / Ed25519 / ES256 signature handling for the
// mandate + delta flows. The contract (from vouchflow-signpayload-rfc.md
// §4 + Appendix A): the client SDK returns a bundle `{ payload, context,
// assertion, ... }` where `assertion` is a JWS signed by Vouchflow's
// verifier key over claims including `payload_sha256` and `context`.
//
// Our backend verifies the JWS against Vouchflow's published JWKs,
// recomputes the payload hash, checks the context matches, and enforces
// a confidence floor. We DO NOT trust the bundle's top-level
// `confidence` / `signing_device_id` / `device_token` fields — only
// the JWS claims are authoritative.

import { createHash } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { ConfidenceLevel, ValidationResult } from "./types.js";

// Type alias: jose's verify-getter shape. Both createRemoteJWKSet and
// createLocalJWKSet return functions matching this signature; the
// remote variant adds runtime control methods (`reload`, `fresh`,
// etc.) but we don't use those.
type JWKSGetter = Parameters<typeof jwtVerify>[1];

const JWKS_URL = new URL("https://vouchflow.dev/.well-known/jwks.json");
const ISSUER = "https://vouchflow.dev";

const DEFAULT_CACHE_MAX_AGE_MS = 60 * 60 * 1000; // 1h per RFC
const DEFAULT_COOLDOWN_MS = 30 * 1000;

export interface VouchflowSignedBundle {
  payload: string; // canonicalized JSON string
  context: string;
  assertion: string; // JWS
  // The remaining top-level fields are informational only — never trust
  // them; read from the verified JWS claims.
  signingDeviceId: string;
  deviceToken: string;
  confidence: ConfidenceLevel;
  signedAt: string;
  platform: "ios" | "android" | "web";
}

export interface VouchflowVerifiedClaims {
  v: 1;
  iss: string;
  aud: string;
  iat: number;
  exp: number;
  context: string;
  device_token: string;
  signing_device_id: string;
  confidence: ConfidenceLevel;
  platform: "ios" | "android" | "web";
  payload_sha256: string; // hex
  session_id: string;
}

export interface VouchflowVerifierConfig {
  customerId: string;
  // Tests override these. Production uses the defaults.
  jwks?: JWKSGetter;
  now?: () => Date;
}

export class VouchflowVerificationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "VouchflowVerificationError";
  }
}

export class VouchflowVerifier {
  private readonly jwks: JWKSGetter;
  private readonly customerId: string;
  private readonly now: () => Date;

  constructor(config: VouchflowVerifierConfig) {
    this.customerId = config.customerId;
    this.jwks =
      config.jwks ??
      createRemoteJWKSet(JWKS_URL, {
        cacheMaxAge: DEFAULT_CACHE_MAX_AGE_MS,
        cooldownDuration: DEFAULT_COOLDOWN_MS,
      });
    this.now = config.now ?? (() => new Date());
  }

  // Verify a bundle against Vouchflow's JWKs + the expected context +
  // confidence floor. Returns the verified claims (authoritative) on
  // success. Each failure mode is reported with a stable error code
  // (`code`) so callers can map them to HTTP status / audit categories.
  async verify(
    bundle: VouchflowSignedBundle,
    expectedContext: string,
    minConfidence: ConfidenceLevel,
  ): Promise<VouchflowVerifiedClaims> {
    let claims: JWTPayload;
    try {
      const { payload } = await jwtVerify(bundle.assertion, this.jwks, {
        issuer: ISSUER,
        audience: this.customerId,
        currentDate: this.now(),
      });
      claims = payload;
    } catch (err) {
      throw new VouchflowVerificationError(
        "jws_verification_failed",
        `JWS verification failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (typeof claims.context !== "string" || claims.context !== expectedContext) {
      throw new VouchflowVerificationError(
        "context_mismatch",
        `bundle authorized '${String(claims.context)}', expected '${expectedContext}'`,
      );
    }

    const expectedHash = sha256Hex(bundle.payload);
    if (typeof claims.payload_sha256 !== "string" || claims.payload_sha256 !== expectedHash) {
      throw new VouchflowVerificationError(
        "payload_tampering",
        "payload sha256 does not match the JWS claim",
      );
    }

    const actualConfidence = claims.confidence as ConfidenceLevel;
    if (!isValidConfidence(actualConfidence)) {
      throw new VouchflowVerificationError(
        "invalid_confidence",
        `bundle confidence '${String(actualConfidence)}' is not a known level`,
      );
    }
    if (!confidenceMeets(actualConfidence, minConfidence)) {
      throw new VouchflowVerificationError(
        "confidence_too_low",
        `bundle confidence '${actualConfidence}' below required '${minConfidence}'`,
      );
    }

    // jose enforces iat/exp via JWS validation — no explicit check needed.
    // Belt-and-braces: a forged claim with an unparseable iat would have
    // failed verification already.

    return castClaims(claims);
  }

  // Parse the bundle's payload string into the application's type
  // ONLY after verifying the bundle. Calling this before verify() is
  // a misuse — the canonical string is attacker-controlled until the
  // JWS proves otherwise.
  parsePayload<T>(bundle: VouchflowSignedBundle): T {
    try {
      return JSON.parse(bundle.payload) as T;
    } catch (err) {
      throw new VouchflowVerificationError(
        "payload_not_json",
        `bundle.payload is not parseable JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

const CONFIDENCE_RANK: Record<ConfidenceLevel, number> = { low: 0, medium: 1, high: 2 };

export function confidenceMeets(actual: ConfidenceLevel, required: ConfidenceLevel): boolean {
  return CONFIDENCE_RANK[actual] >= CONFIDENCE_RANK[required];
}

function isValidConfidence(c: unknown): c is ConfidenceLevel {
  return c === "low" || c === "medium" || c === "high";
}

function castClaims(claims: JWTPayload): VouchflowVerifiedClaims {
  return {
    v: 1,
    iss: claims.iss as string,
    aud: claims.aud as string,
    iat: claims.iat as number,
    exp: claims.exp as number,
    context: claims.context as string,
    device_token: claims.device_token as string,
    signing_device_id: claims.signing_device_id as string,
    confidence: claims.confidence as ConfidenceLevel,
    platform: claims.platform as "ios" | "android" | "web",
    payload_sha256: claims.payload_sha256 as string,
    session_id: claims.session_id as string,
  };
}

// Convenience: turn a VouchflowVerificationError into the same
// ValidationResult shape the mandate/delta verifiers already use.
export function toValidationResult(err: unknown): ValidationResult {
  if (err instanceof VouchflowVerificationError) {
    return { valid: false, reason: err.code };
  }
  return {
    valid: false,
    reason: `vouchflow_error: ${err instanceof Error ? err.message : String(err)}`,
  };
}
