import { describe, it, expect } from "vitest";
import {
  isMaskedDisplay,
  MASKED_DISPLAY_RE,
  looksLikeCodeIdentifier,
  isCredentialNoise,
  findCredentialTokens,
  looksLikeCredentialToken,
  looksLikeCredentialValue,
} from "../credential-shape.js";

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
    expect(isMaskedDisplay("sk-or-v1-1687…")).toBe(true);
    expect(isMaskedDisplay("sk-or-v1-1687...")).toBe(true);
  });
  it("does NOT flag a real unmasked key", () => {
    expect(isMaskedDisplay("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")).toBe(false);
    expect(isMaskedDisplay("re_8sZ2k9QwErTyUiOpAsDfGhJk")).toBe(false);
    expect(isMaskedDisplay("phx_aBcD1234")).toBe(false);
  });
  it("does NOT flag a JWT (single dots, not 3+ consecutive)", () => {
    expect(isMaskedDisplay("eyJabc.eyJdef.sig123")).toBe(false);
  });
  it("exports MASKED_DISPLAY_RE so the in-page browser.ts mirror can stay in sync", () => {
    expect(MASKED_DISPLAY_RE.source).toBe("[•●⬤]|\\*{3,}|…|\\.{3,}");
  });
});

describe("looksLikeCodeIdentifier (reject the X-tombstone JS function name leak)", () => {
  it("rejects a dotted member-access token", () => {
    expect(looksLikeCodeIdentifier("loader.tweetUnavailableTombstoneHandler")).toBe(true);
  });
  it("does NOT reject a JWT (eyJ prefix)", () => {
    expect(looksLikeCodeIdentifier("eyJhbGci.eyJzdWIi.sig")).toBe(false);
  });
  it("does NOT reject an underscore/dash key", () => {
    expect(looksLikeCodeIdentifier("sk_live_aBc123")).toBe(false);
  });
});

describe("isCredentialNoise (reject non-key page text)", () => {
  it("rejects whitespace, dates, emails, labels, versions, urls, dogfood slugs", () => {
    expect(isCredentialNoise("Hi there, welcome")).toBe(true);
    expect(isCredentialNoise("2026-06-23")).toBe(true);
    expect(isCredentialNoise("06/23/2026")).toBe(true);
    expect(isCredentialNoise("user@example.com")).toBe(true);
    expect(isCredentialNoise("Owner:")).toBe(true);
    expect(isCredentialNoise("v1.2.3")).toBe(true);
    expect(isCredentialNoise("https://example.com/x")).toBe(true);
    expect(isCredentialNoise("trusty-squire-dogfood-20260625")).toBe(true);
  });
  it("now also rejects a masked display (the unified mask check — previously only ellipsis)", () => {
    expect(isCredentialNoise("••••3f")).toBe(true);
    expect(isCredentialNoise("sk-or-v1-1687…")).toBe(true);
  });
  it("does NOT reject a real key", () => {
    expect(isCredentialNoise("re_8sZ2k9QwErTyUiOpAsDfGhJk")).toBe(false);
  });
});

describe("findCredentialTokens / looksLikeCredentialToken (multi-cred surfacing)", () => {
  it("finds a vendor-prefixed key carrying a digit", () => {
    expect(findCredentialTokens("vsk_sandbox_write_aB3kLm9PqRs")).toContain("vsk_sandbox_write_aB3kLm9PqRs");
  });
  it("accepts a multi-segment vendor key (Luma)", () => {
    expect(looksLikeCredentialToken("luma-api-4Y7FDyM2pQ8xKw")).toBe(true);
  });
  it("rejects a word-word-word-date slug", () => {
    expect(looksLikeCredentialToken("trusty-squire-dogfood-20260625")).toBe(false);
  });
});

describe("looksLikeCredentialValue (the tight host-side gate, distinct from the loose in-page collector)", () => {
  it("accepts a JWT, a UUID, and a vendor token", () => {
    expect(looksLikeCredentialValue("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.aBcDeF")).toBe(true);
    expect(looksLikeCredentialValue("123e4567-e89b-12d3-a456-426614174000")).toBe(true);
    expect(looksLikeCredentialValue("vsk_live_aB3kLm9PqRsTuV")).toBe(true);
  });
  it("rejects short / noise / code-identifier / masked", () => {
    expect(looksLikeCredentialValue("short")).toBe(false);
    expect(looksLikeCredentialValue("2026-06-23")).toBe(false);
    expect(looksLikeCredentialValue("loader.tweetTombstone")).toBe(false);
    expect(looksLikeCredentialValue("GOCSPX-••••3f")).toBe(false);
  });
});
