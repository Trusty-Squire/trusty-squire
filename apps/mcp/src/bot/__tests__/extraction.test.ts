// Unit tests for the pure extraction decision primitives (strangler slice 4 —
// docs/ARCHITECTURE.md). Browser-free. Pins the truncated-vs-full priority
// (the S3 masked-key trap) + the final resolution that extractCredentials owns.

import { describe, expect, it } from "vitest";
import {
  accumulateCandidate,
  hasFullHit,
  initialExtractionState,
  resolveExtraction,
  type CandidateClass,
  type ExtractionState,
} from "../extraction.js";

const S = (patch: Partial<ExtractionState> = {}): ExtractionState => ({ ...initialExtractionState(), ...patch });
const full = (value: string): CandidateClass => ({ kind: "full", value });
const trunc = (value: string): CandidateClass => ({ kind: "truncated", value });
const none: CandidateClass = { kind: "none" };

describe("accumulateCandidate", () => {
  it("a full hit sets apiKey and is terminal", () => {
    const s = accumulateCandidate(S(), full("sk-real-abcdefghijklmnop"));
    expect(s.apiKey).toBe("sk-real-abcdefghijklmnop");
    expect(hasFullHit(s)).toBe(true);
  });
  it("the FIRST full hit wins — a later full cannot override it", () => {
    let s = accumulateCandidate(S(), full("sk-first-aaaaaaaaaaaaaa"));
    s = accumulateCandidate(s, full("sk-second-bbbbbbbbbbbbbb"));
    expect(s.apiKey).toBe("sk-first-aaaaaaaaaaaaaa");
  });
  it("a truncated hit is remembered but is NOT terminal", () => {
    const s = accumulateCandidate(S(), trunc("sk-or-v1-1687"));
    expect(s.apiKey).toBeNull();
    expect(s.truncatedHit).toBe("sk-or-v1-1687");
    expect(hasFullHit(s)).toBe(false);
  });
  it("the FIRST truncated wins (truncatedHit ?? hit) — a later truncated is ignored", () => {
    let s = accumulateCandidate(S(), trunc("sk-aaa-111"));
    s = accumulateCandidate(s, trunc("sk-bbb-222"));
    expect(s.truncatedHit).toBe("sk-aaa-111");
  });
  it("a full hit found AFTER a truncated one wins (the clipboard recovery case)", () => {
    let s = accumulateCandidate(S(), trunc("sk-or-v1-1687"));
    s = accumulateCandidate(s, full("sk-or-v1-1687fullsecretvalue"));
    expect(s.apiKey).toBe("sk-or-v1-1687fullsecretvalue");
    expect(hasFullHit(s)).toBe(true);
  });
  it("once a full hit exists, later truncated candidates are ignored", () => {
    let s = accumulateCandidate(S({ apiKey: "sk-good-xxxxxxxxxxxx" }), trunc("sk-bad-1687"));
    expect(s.apiKey).toBe("sk-good-xxxxxxxxxxxx");
    expect(s.truncatedHit).toBeNull();
  });
  it("a 'none' candidate is a no-op", () => {
    expect(accumulateCandidate(S(), none)).toEqual(S());
  });
});

describe("resolveExtraction", () => {
  it("a full key resolves to {api_key}", () => {
    expect(resolveExtraction(S({ apiKey: "sk-real-abcdefghij" }))).toEqual({ api_key: "sk-real-abcdefghij" });
  });
  it("only a truncated stub resolves to {api_key_truncated} (honest partial)", () => {
    expect(resolveExtraction(S({ truncatedHit: "sk-or-v1-1687" }))).toEqual({ api_key_truncated: "sk-or-v1-1687" });
  });
  it("a full key takes priority over a truncated stub", () => {
    expect(resolveExtraction(S({ apiKey: "sk-full-xxxx", truncatedHit: "sk-trunc-1687" }))).toEqual({ api_key: "sk-full-xxxx" });
  });
  it("nothing found resolves to {} (keep navigating)", () => {
    expect(resolveExtraction(S())).toEqual({});
  });
});
