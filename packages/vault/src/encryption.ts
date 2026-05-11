// AES-256-GCM envelope encryption primitives.
//
// Wire format for every encrypted blob in this package is:
//   iv (12 bytes) || ciphertext || auth_tag (16 bytes)
// Concatenated this way so a row can carry one Bytes column instead of
// three (Prisma schema), and so it's structurally impossible to use the
// ciphertext without its tag (the tag is what makes GCM
// authentication-secure — losing it = silent forgery acceptance).

import { Buffer } from "node:buffer";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

export class EncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EncryptionError";
  }
}

export function generateKey(): Buffer {
  return randomBytes(KEY_LEN);
}

// Encrypt with AES-256-GCM. AAD is bound into the auth tag — any
// mismatch on decrypt → exception. Used to bind a ciphertext to its
// (reference, account_id, role) so a swapped blob fails authentication.
export function encryptAesGcm(key: Buffer, plaintext: Buffer, aad?: Buffer): Buffer {
  if (key.length !== KEY_LEN) {
    throw new EncryptionError(`key must be ${KEY_LEN} bytes, got ${key.length}`);
  }
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  if (aad !== undefined) cipher.setAAD(aad);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, encrypted, tag]);
}

export function decryptAesGcm(key: Buffer, blob: Buffer, aad?: Buffer): Buffer {
  if (key.length !== KEY_LEN) {
    throw new EncryptionError(`key must be ${KEY_LEN} bytes, got ${key.length}`);
  }
  if (blob.length < IV_LEN + TAG_LEN) {
    throw new EncryptionError(
      `blob too short (need iv+tag = ${IV_LEN + TAG_LEN}, got ${blob.length})`,
    );
  }
  const iv = blob.subarray(0, IV_LEN);
  const tag = blob.subarray(blob.length - TAG_LEN);
  const ciphertext = blob.subarray(IV_LEN, blob.length - TAG_LEN);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  if (aad !== undefined) decipher.setAAD(aad);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (err) {
    throw new EncryptionError(
      `authenticated decryption failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// AAD constructors — keep the format stable across the vault so
// cross-credential blob swaps are caught.
export function aadForValue(reference: string, accountId: string): Buffer {
  return Buffer.from(`vault.value|${reference}|${accountId}`, "utf8");
}

export function aadForDek(reference: string, accountId: string): Buffer {
  return Buffer.from(`vault.dek|${reference}|${accountId}`, "utf8");
}
