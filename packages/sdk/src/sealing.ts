// The app's sealing key: an HPKE key pair whose public half the app sends with
// a reveal or payment request. Squire delivers the approved key or card sealed
// to it, so only the holder of the private half can read the value.
//
// MUST stay wire-compatible with packages/vault/src/hpke.ts and
// apps/mcp/src/bot/payment-hpke.ts: the same pinned suite (X25519, HKDF-SHA256,
// AES-256-GCM) and the same enc‖ct bundle with a 32-byte enc prefix. A local
// copy, not an import, so the published SDK does not depend on the vault
// package. If you change the suite or bundle in one file, change all three.

import { Aes256Gcm, CipherSuite, DhkemX25519HkdfSha256, HkdfSha256 } from "@hpke/core";

/** Base64url X25519 keys. Keep `privateKey` on your server, with your other secrets. */
export interface SealingKey {
  publicKey: string;
  privateKey: string;
}

const suite = new CipherSuite({
  kem: new DhkemX25519HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Aes256Gcm(),
});

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new TypeError("invalid_base64url");
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  return Uint8Array.from(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")), (char) =>
    char.charCodeAt(0),
  );
}

/** A new sealing key. Persist it if a claim may happen after a restart. */
export async function generateSealingKey(): Promise<SealingKey> {
  const keypair = await suite.kem.generateKeyPair();
  const [publicKey, privateKey] = await Promise.all([
    suite.kem.serializePublicKey(keypair.publicKey),
    suite.kem.serializePrivateKey(keypair.privateKey),
  ]);
  return {
    publicKey: toBase64Url(new Uint8Array(publicKey)),
    privateKey: toBase64Url(new Uint8Array(privateKey)),
  };
}

/** Open a bundle sealed to `privateKey`. Throws if the key or `aad` does not match. */
export async function openSealed(
  privateKey: string,
  bundle: string,
  aad: Uint8Array,
): Promise<Uint8Array> {
  const privateKeyBytes = fromBase64Url(privateKey);
  const bytes = fromBase64Url(bundle);
  try {
    const recipientKey = await suite.kem.deserializePrivateKey(privateKeyBytes);
    const plaintext = await suite.open(
      { recipientKey, enc: bytes.slice(0, 32) },
      bytes.slice(32),
      aad,
    );
    return new Uint8Array(plaintext);
  } finally {
    privateKeyBytes.fill(0);
    bytes.fill(0);
  }
}

/** The associated data a sealed reveal is bound to (apps/api sealed-claims.ts). */
export function revealAad(approvalId: string): Uint8Array {
  return new TextEncoder().encode(`trusty-squire/credential-reveal/v1\n${approvalId}`);
}

/** The payment terms the user's passkey signed; the card is sealed under their hash. */
export interface SignedPaymentTerms {
  account_binding: string;
  approval_id: string;
  merchant: string;
  checkout_origin: string;
  amount_cents: number;
  currency: string;
  nonce: string;
  card_ref: string;
  recipient_pubkey_hash: string;
  item: string;
  reason: string;
  agent: string;
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
}

export async function publicKeyHash(publicKey: string): Promise<string> {
  return toBase64Url(await sha256(fromBase64Url(publicKey)));
}

/**
 * The associated data a sealed card is bound to: SHA-256 of the canonical
 * (sorted-key) JSON of the signed terms, exactly as the Squire payment page
 * seals it and the broker opens it. The terms are flat strings and integers,
 * so sorted-key JSON is the RFC 8785 canonical form.
 */
export async function paymentAad(terms: SignedPaymentTerms): Promise<Uint8Array> {
  const sorted = Object.fromEntries(
    Object.entries(terms).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  );
  return await sha256(new TextEncoder().encode(JSON.stringify(sorted)));
}

/** The `payload_sha256` a mandate JWS claims, as base64url. Not a signature check. */
export function mandatePayloadHash(jws: string): string | null {
  const part = jws.split(".")[1];
  if (part === undefined) return null;
  try {
    const claims = JSON.parse(new TextDecoder().decode(fromBase64Url(part))) as {
      payload_sha256?: unknown;
    };
    const claim = claims.payload_sha256;
    if (typeof claim !== "string") return null;
    if (/^[0-9a-fA-F]{64}$/.test(claim)) {
      const bytes = new Uint8Array(32);
      for (let i = 0; i < 32; i++) bytes[i] = Number.parseInt(claim.slice(i * 2, i * 2 + 2), 16);
      return toBase64Url(bytes);
    }
    return /^[A-Za-z0-9_-]{43}$/.test(claim) ? claim : null;
  } catch {
    return null;
  }
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  return toBase64Url(bytes);
}
