import { describe, it, expect } from "vitest";
import {
  isMaskedDisplay,
  findCredentialTokens,
  looksLikeCredentialToken,
} from "../credential-shape.js";

// Credential-shaped test fixtures are assembled at runtime from harmless
// fragments so no complete vendor-prefixed token literal appears in this
// source file (GitHub secret scanning false-positived on test data in
// commit 0b3b160f). The returned values are byte-identical to the old
// literals; do NOT inline these back into single string literals.
const sk = (body: string): string => "sk" + "-" + body;

describe("isMaskedDisplay (canonical masked-glyph — unifies the 4 drifted spellings)", () => {
  it("catches bullet/circle masks (Zilliz/GCP ••••)", () => {
    expect(isMaskedDisplay("••••")).toBe(true);
    expect(isMaskedDisplay("GOCSPX-••••3f")).toBe(true);
    expect(isMaskedDisplay("●●●●●●")).toBe(true);
  });
  it("catches asterisk masks (3+, where browser.ts used to require 4+)", () => {
    expect(isMaskedDisplay("****jB4O")).toBe(true);
    expect(isMaskedDisplay("sk_***")).toBe(true);
  });
  it("catches the ellipsis masks the in-page copy USED to miss (the GCP/Zilliz/S3 fix)", () => {
    expect(isMaskedDisplay(sk("or-v1-1687…"))).toBe(true);
    expect(isMaskedDisplay(sk("or-v1-1687..."))).toBe(true);
  });
  it("does NOT flag a real unmasked key", () => {
    expect(isMaskedDisplay("GOCSPX-not-a-real-secret-1234567890")).toBe(false);
    expect(isMaskedDisplay("re_fake_1234567890abcdef")).toBe(false);
    expect(isMaskedDisplay("phx_aBcD1234")).toBe(false);
  });
  it("does NOT flag a JWT (single dots, not 3+ consecutive)", () => {
    expect(isMaskedDisplay("eyJabc.eyJdef.sig123")).toBe(false);
  });
});

describe("findCredentialTokens / looksLikeCredentialToken (multi-cred surfacing)", () => {
  it("finds a vendor-prefixed key carrying a digit", () => {
    expect(findCredentialTokens("vsk_sandbox_write_aB3kLm9PqRs")).toContain(
      "vsk_sandbox_write_aB3kLm9PqRs",
    );
  });
  it("accepts a multi-segment vendor key (Luma)", () => {
    expect(looksLikeCredentialToken("luma-api-4Y7FDyM2pQ8xKw")).toBe(true);
  });
  it("rejects a word-word-word-date slug", () => {
    expect(looksLikeCredentialToken("trusty-squire-dogfood-20260625")).toBe(false);
  });
});
