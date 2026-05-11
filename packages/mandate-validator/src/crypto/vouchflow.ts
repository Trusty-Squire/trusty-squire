// Ed25519 (Vouchflow mobile) signature verification.
//
// Public keys arrive as base64url-encoded raw 32-byte points. Node's
// crypto.createPublicKey wants SPKI DER, so we wrap the raw bytes with
// the fixed 12-byte Ed25519 SPKI prefix per RFC 8410 §4. Signatures are
// 64 raw bytes, base64url-encoded.

import { Buffer } from "node:buffer";
import { createPublicKey, verify as nodeVerify } from "node:crypto";
import { base64UrlDecode } from "./base64url.js";

const ED25519_SPKI_PREFIX = Uint8Array.from([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
]);

export class Ed25519VerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Ed25519VerificationError";
  }
}

export function verifyEd25519(
  publicKeyB64Url: string,
  message: Uint8Array,
  signatureB64Url: string,
): boolean {
  const rawKey = base64UrlDecode(publicKeyB64Url);
  if (rawKey.length !== 32) {
    throw new Ed25519VerificationError(
      `public key must be 32 raw bytes, got ${rawKey.length}`,
    );
  }
  const sig = base64UrlDecode(signatureB64Url);
  if (sig.length !== 64) {
    return false;
  }

  const spki = new Uint8Array(ED25519_SPKI_PREFIX.length + rawKey.length);
  spki.set(ED25519_SPKI_PREFIX, 0);
  spki.set(rawKey, ED25519_SPKI_PREFIX.length);

  const keyObject = createPublicKey({
    key: Buffer.from(spki),
    format: "der",
    type: "spki",
  });

  // Ed25519 uses pure EdDSA (PureEdDSA per RFC 8032); verify takes the
  // raw message, not a hash. Algorithm parameter is null.
  return nodeVerify(null, Buffer.from(message), keyObject, Buffer.from(sig));
}
