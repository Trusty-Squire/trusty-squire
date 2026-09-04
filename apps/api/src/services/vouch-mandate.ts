// Shared Vouchflow mandate verification for every approval-backed action.
// Payment and credential mutation deliberately enter through this one
// cryptographic boundary so a new approval kind cannot accidentally settle
// for merely decoding a JWS or comparing an unsigned payload.

import { createHash, timingSafeEqual } from "node:crypto";
import canonicalize from "canonicalize";
import { createLocalJWKSet, decodeJwt, jwtVerify, type JSONWebKeySet, type JWTPayload } from "jose";

export const PAYMENT_VOUCH_CONTEXT = "purchase";
export const CREDENTIAL_MUTATION_VOUCH_CONTEXT = "vault_credential_mutation";

export type VouchMandateFailureCode =
  | "vouchflow_expected_audience_unset"
  | "jwks_fetch_failed"
  | "jwks_fetch_timeout"
  | "invalid_jwks"
  | "missing_payload_sha256"
  | "invalid_payload_sha256"
  | "payload_hash_mismatch"
  | "invalid_mandate_context"
  | "insufficient_mandate_confidence"
  | "mandate_assertion_expired"
  | "mandate_verification_failed";

export class VouchMandateVerificationError extends Error {
  constructor(public readonly code: VouchMandateFailureCode) {
    super(code);
    this.name = "VouchMandateVerificationError";
  }
}

export interface VouchMandateVerificationInput {
  jws: string;
  expectedPayloadHash: Uint8Array;
  expectedContext: string;
  expectedAudience: string;
  /** The API already verified this exact, nonce-bound candidate at submission. */
  previouslyVerifiedRelay?: boolean;
}

export type VouchMandateVerifier = (input: VouchMandateVerificationInput) => Promise<JWTPayload>;

// The longest approval is the JIT card flow (18 minutes). A Vouchflow web
// assertion is intentionally much shorter-lived, so an assertion verified at
// submission may expire while it waits in the authenticated relay for the
// operator to resume. This window never applies to first acceptance.
export const MAX_PREVERIFIED_MANDATE_RELAY_MS = 18 * 60 * 1_000;

function isJwtExpired(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "ERR_JWT_EXPIRED"
  );
}

async function verifySignedAssertion(
  input: VouchMandateVerificationInput,
  jwks: ReturnType<typeof createLocalJWKSet>,
): Promise<JWTPayload> {
  const options = {
    issuer: "https://vouchflow.dev",
    audience: input.expectedAudience,
  } as const;
  try {
    return (await jwtVerify(input.jws, jwks, options)).payload;
  } catch (error) {
    if (!input.previouslyVerifiedRelay || !isJwtExpired(error)) throw error;

    // Decoding chooses a point inside the signed validity interval only. The
    // second jwtVerify still validates signature, issuer, audience, nbf, and
    // every binding below. Bad or excessively old assertions remain rejected.
    const decoded = decodeJwt(input.jws);
    const issuedAt = decoded.iat;
    const expiresAt = decoded.exp;
    const now = Date.now();
    if (
      !Number.isSafeInteger(issuedAt) ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt! <= issuedAt! ||
      now - expiresAt! * 1_000 > MAX_PREVERIFIED_MANDATE_RELAY_MS
    ) {
      throw new VouchMandateVerificationError("mandate_assertion_expired");
    }
    return (
      await jwtVerify(input.jws, jwks, {
        ...options,
        currentDate: new Date((expiresAt! - 1) * 1_000),
      })
    ).payload;
  }
}

function decodePayloadHash(claim: unknown): Uint8Array {
  if (typeof claim !== "string") {
    throw new VouchMandateVerificationError("missing_payload_sha256");
  }
  let bytes: Uint8Array;
  if (/^[0-9a-fA-F]{64}$/.test(claim)) {
    bytes = new Uint8Array(Buffer.from(claim, "hex"));
  } else if (/^[A-Za-z0-9_-]{43}$/.test(claim)) {
    bytes = new Uint8Array(Buffer.from(claim, "base64url"));
  } else {
    throw new VouchMandateVerificationError("invalid_payload_sha256");
  }
  if (bytes.byteLength !== 32) {
    throw new VouchMandateVerificationError("invalid_payload_sha256");
  }
  return bytes;
}

function confidenceAtLeastLow(value: unknown): boolean {
  return value === "low" || value === "medium" || value === "high";
}

export function canonicalVouchPayload(payload: unknown): string {
  const canonical = canonicalize(payload);
  if (canonical === undefined) throw new Error("vouch_payload_not_canonicalizable");
  return canonical;
}

export function hashVouchPayload(payload: unknown): Buffer {
  return createHash("sha256").update(canonicalVouchPayload(payload), "utf8").digest();
}

export function createVouchMandateVerifier(
  fetchImpl: typeof fetch = fetch,
  apiBase = process.env.VOUCHFLOW_API_BASE ?? "https://api.vouchflow.dev",
): VouchMandateVerifier {
  return async (input) => {
    if (input.expectedAudience.trim().length === 0) {
      throw new VouchMandateVerificationError("vouchflow_expected_audience_unset");
    }
    const jwksUrl = `${apiBase.replace(/\/+$/, "")}/.well-known/jwks.json`;
    const signal = AbortSignal.timeout(5_000);
    let response: Response;
    try {
      response = await fetchImpl(jwksUrl, {
        method: "GET",
        headers: { accept: "application/json" },
        signal,
      });
    } catch {
      throw new VouchMandateVerificationError(
        signal.aborted ? "jwks_fetch_timeout" : "jwks_fetch_failed",
      );
    }
    if (!response.ok) throw new VouchMandateVerificationError("jwks_fetch_failed");
    const body = (await response.json()) as unknown;
    if (
      body === null ||
      typeof body !== "object" ||
      !("keys" in body) ||
      !Array.isArray((body as { keys: unknown }).keys)
    ) {
      throw new VouchMandateVerificationError("invalid_jwks");
    }

    try {
      const payload = await verifySignedAssertion(input, createLocalJWKSet(body as JSONWebKeySet));
      const signedHash = decodePayloadHash(payload.payload_sha256);
      if (
        input.expectedPayloadHash.byteLength !== signedHash.byteLength ||
        !timingSafeEqual(Buffer.from(input.expectedPayloadHash), Buffer.from(signedHash))
      ) {
        throw new VouchMandateVerificationError("payload_hash_mismatch");
      }
      if (payload.context !== input.expectedContext) {
        throw new VouchMandateVerificationError("invalid_mandate_context");
      }
      if (!confidenceAtLeastLow(payload.confidence)) {
        throw new VouchMandateVerificationError("insufficient_mandate_confidence");
      }
      return payload;
    } catch (error) {
      if (error instanceof VouchMandateVerificationError) throw error;
      throw new VouchMandateVerificationError("mandate_verification_failed");
    }
  };
}
