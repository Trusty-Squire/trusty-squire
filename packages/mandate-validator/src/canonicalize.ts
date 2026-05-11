// RFC 8785 JSON Canonicalization Scheme (JCS) wrapper.
//
// Why a wrapper: signing must operate on bytes, and every caller wants
// the same bytes for the same input. We delegate the actual JCS rules
// (lexical key sorting, NFC string normalisation, IEEE 754 number
// canonicalisation) to the well-tested `canonicalize` npm package.

import canonicalize from "canonicalize";

export class CanonicalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalizationError";
  }
}

export function canonicalString(value: unknown): string {
  let out: string | undefined;
  try {
    const result = canonicalize(value);
    if (typeof result === "string") out = result;
  } catch (err) {
    // Cycles → RangeError (stack overflow) inside the recursive canonicalize.
    // BigInt → TypeError. Unify all of these under our package error so
    // callers don't have to switch on Node's error catalog.
    throw new CanonicalizationError(
      `input could not be canonicalized: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (out === undefined) {
    throw new CanonicalizationError("canonicalize returned a non-string value");
  }
  return out;
}

export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalString(value));
}
