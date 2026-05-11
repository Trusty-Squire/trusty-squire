// AES-256-GCM round-trip + tamper-resistance tests. 100% coverage on
// encryption.ts is part of the chunk-6 acceptance criteria.

import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  EncryptionError,
  aadForDek,
  aadForValue,
  decryptAesGcm,
  encryptAesGcm,
  generateKey,
} from "../encryption.js";

describe("encryptAesGcm / decryptAesGcm", () => {
  it("round-trips arbitrary plaintext", () => {
    const key = generateKey();
    const message = Buffer.from("hello world", "utf8");
    const blob = encryptAesGcm(key, message);
    const decoded = decryptAesGcm(key, blob);
    expect(decoded.toString("utf8")).toBe("hello world");
  });

  it("ciphertext changes per encryption (random IV)", () => {
    const key = generateKey();
    const message = Buffer.from("repeatable", "utf8");
    const a = encryptAesGcm(key, message);
    const b = encryptAesGcm(key, message);
    expect(Buffer.compare(a, b)).not.toBe(0);
    // First 12 bytes are the IV; should differ.
    expect(Buffer.compare(a.subarray(0, 12), b.subarray(0, 12))).not.toBe(0);
  });

  it("tampered ciphertext → decrypt fails (auth tag mismatch)", () => {
    const key = generateKey();
    const blob = encryptAesGcm(key, Buffer.from("secret", "utf8"));
    // Flip a byte in the encrypted middle (not in the IV or tag — flipping
    // those would also fail, but this confirms inner-ciphertext tampering).
    const tampered = Buffer.from(blob);
    tampered[12] = (tampered[12]! ^ 0xff) & 0xff;
    expect(() => decryptAesGcm(key, tampered)).toThrow(EncryptionError);
  });

  it("AAD mismatch → decrypt fails", () => {
    const key = generateKey();
    const aadIn = Buffer.from("vault.value|ref-1|acct-1", "utf8");
    const aadWrong = Buffer.from("vault.value|ref-2|acct-1", "utf8");
    const blob = encryptAesGcm(key, Buffer.from("secret", "utf8"), aadIn);
    expect(() => decryptAesGcm(key, blob, aadWrong)).toThrow(EncryptionError);
  });

  it("wrong KEK → decrypt fails", () => {
    const blob = encryptAesGcm(generateKey(), Buffer.from("secret", "utf8"));
    expect(() => decryptAesGcm(generateKey(), blob)).toThrow(EncryptionError);
  });

  it("rejects keys of incorrect length", () => {
    const shortKey = randomBytes(16);
    expect(() => encryptAesGcm(shortKey, Buffer.from("x"))).toThrow(EncryptionError);
    const goodBlob = encryptAesGcm(generateKey(), Buffer.from("x"));
    expect(() => decryptAesGcm(shortKey, goodBlob)).toThrow(EncryptionError);
  });

  it("rejects blobs shorter than iv+tag", () => {
    const key = generateKey();
    expect(() => decryptAesGcm(key, Buffer.alloc(10))).toThrow(/blob too short/);
  });

  it("AAD constructors produce stable, distinct strings per role", () => {
    expect(aadForValue("ref", "acct").toString("utf8")).toBe("vault.value|ref|acct");
    expect(aadForDek("ref", "acct").toString("utf8")).toBe("vault.dek|ref|acct");
    // Cross-role swap must not authenticate.
    const key = generateKey();
    const blob = encryptAesGcm(key, Buffer.from("data", "utf8"), aadForValue("ref", "acct"));
    expect(() => decryptAesGcm(key, blob, aadForDek("ref", "acct"))).toThrow(EncryptionError);
  });

  it("generateKey returns 32 random bytes", () => {
    const a = generateKey();
    const b = generateKey();
    expect(a).toHaveLength(32);
    expect(b).toHaveLength(32);
    expect(Buffer.compare(a, b)).not.toBe(0);
  });
});
