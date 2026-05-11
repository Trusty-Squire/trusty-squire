// ECDSA-P256 (WebAuthn / ES256) signature verification.
//
// Public keys arrive as base64url-encoded SPKI DER (the standard
// WebAuthn export). Signatures arrive as either DER-encoded ASN.1
// (Chrome on macOS, common for WebAuthn assertions) or raw r||s
// concatenation (some Android stacks, ECDSA "ieee-p1363" form).
//
// Decision per chunk-4 open question #1: accept both, normalise the
// dsaEncoding flag at verify time. P-256 raw signatures are exactly
// 64 bytes; DER signatures start with 0x30 (SEQUENCE) and vary in
// length (typically 70–72 bytes).

import { Buffer } from "node:buffer";
import { createPublicKey, verify as nodeVerify } from "node:crypto";
import { base64UrlDecode } from "./base64url.js";

export class Es256VerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Es256VerificationError";
  }
}

const RAW_P256_SIG_LEN = 64;
const DER_SEQUENCE_TAG = 0x30;

export function verifyEs256(
  publicKeySpkiB64Url: string,
  message: Uint8Array,
  signatureB64Url: string,
): boolean {
  const spki = base64UrlDecode(publicKeySpkiB64Url);
  const sig = base64UrlDecode(signatureB64Url);

  let keyObject;
  try {
    keyObject = createPublicKey({ key: Buffer.from(spki), format: "der", type: "spki" });
  } catch (err) {
    throw new Es256VerificationError(
      `unparseable SPKI: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const dsaEncoding = detectSignatureEncoding(sig);
  if (dsaEncoding === null) return false;

  return nodeVerify(
    "sha256",
    Buffer.from(message),
    { key: keyObject, dsaEncoding },
    Buffer.from(sig),
  );
}

// Returns null when the signature isn't either of the two accepted
// shapes — caller treats that as a verification failure rather than an
// exception (a malformed sig from the wire shouldn't crash the runtime).
export function detectSignatureEncoding(
  sig: Uint8Array,
): "der" | "ieee-p1363" | null {
  if (sig.length === RAW_P256_SIG_LEN) return "ieee-p1363";
  if (sig.length > 0 && sig[0] === DER_SEQUENCE_TAG) return "der";
  return null;
}
