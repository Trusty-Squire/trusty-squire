// HKDF derivation tests. Chunk-6 acceptance: 100% coverage.

import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { KekDerivationError, deriveSessionKEK } from "../kek-derivation.js";

const ACCOUNT_KEK = Buffer.from(
  "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
  "hex",
);

describe("deriveSessionKEK", () => {
  it("returns exactly 32 bytes", async () => {
    const out = await deriveSessionKEK(ACCOUNT_KEK, Buffer.from("nonce-1", "utf8"));
    expect(out).toHaveLength(32);
  });

  it("same KEK + same nonce → same session KEK (deterministic)", async () => {
    const a = await deriveSessionKEK(ACCOUNT_KEK, Buffer.from("nonce", "utf8"));
    const b = await deriveSessionKEK(ACCOUNT_KEK, Buffer.from("nonce", "utf8"));
    expect(Buffer.compare(a, b)).toBe(0);
  });

  it("same KEK + different nonces → different session KEKs", async () => {
    const a = await deriveSessionKEK(ACCOUNT_KEK, Buffer.from("nonce-a", "utf8"));
    const b = await deriveSessionKEK(ACCOUNT_KEK, Buffer.from("nonce-b", "utf8"));
    expect(Buffer.compare(a, b)).not.toBe(0);
  });

  it("different KEKs + same nonce → different session KEKs", async () => {
    const otherKek = Buffer.from(
      "ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100",
      "hex",
    );
    const a = await deriveSessionKEK(ACCOUNT_KEK, Buffer.from("nonce", "utf8"));
    const b = await deriveSessionKEK(otherKek, Buffer.from("nonce", "utf8"));
    expect(Buffer.compare(a, b)).not.toBe(0);
  });

  it("rejects empty accountKEK", async () => {
    await expect(deriveSessionKEK(Buffer.alloc(0), Buffer.from("nonce"))).rejects.toThrow(
      KekDerivationError,
    );
  });

  it("rejects empty deviceSignedNonce", async () => {
    await expect(deriveSessionKEK(ACCOUNT_KEK, Buffer.alloc(0))).rejects.toThrow(
      KekDerivationError,
    );
  });
});
