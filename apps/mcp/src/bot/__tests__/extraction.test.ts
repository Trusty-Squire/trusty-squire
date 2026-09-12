// Unit tests for the pure extraction decision primitives (strangler slice 4 —
// docs/ARCHITECTURE.md). Browser-free. Pins first-hit selection and final
// resolution.

import { describe, expect, it } from "vitest";
import {
  accumulateCandidate,
  hasFullHit,
  initialExtractionState,
  resolveExtraction,
  type CandidateClass,
  type ExtractionState,
} from "../extraction.js";

// Credential-shaped test fixtures are assembled at runtime from harmless
// fragments so no complete vendor-prefixed token literal appears in this
// source file (GitHub secret scanning false-positived on test data in
// commit 0b3b160f). The returned values are byte-identical to the old
// literals; do NOT inline these back into single string literals.
const sk = (body: string): string => "sk" + "-" + body;

const S = (patch: Partial<ExtractionState> = {}): ExtractionState => ({
  ...initialExtractionState(),
  ...patch,
});
const full = (value: string): CandidateClass => ({ kind: "full", value });
const none: CandidateClass = { kind: "none" };

describe("accumulateCandidate", () => {
  it("a full hit sets apiKey and is terminal", () => {
    const s = accumulateCandidate(S(), full(sk("real-abcdefghijklmnop")));
    expect(s.apiKey).toBe(sk("real-abcdefghijklmnop"));
    expect(hasFullHit(s)).toBe(true);
  });
  it("the FIRST full hit wins — a later full cannot override it", () => {
    let s = accumulateCandidate(S(), full(sk("first-aaaaaaaaaaaaaa")));
    s = accumulateCandidate(s, full(sk("second-bbbbbbbbbbbbbb")));
    expect(s.apiKey).toBe(sk("first-aaaaaaaaaaaaaa"));
  });
  it("a 'none' candidate is a no-op", () => {
    expect(accumulateCandidate(S(), none)).toEqual(S());
  });
});

describe("resolveExtraction", () => {
  it("a full key resolves to {api_key}", () => {
    expect(resolveExtraction(S({ apiKey: sk("real-abcdefghij") }))).toEqual({
      api_key: sk("real-abcdefghij"),
    });
  });
  it("nothing found resolves to {} (keep navigating)", () => {
    expect(resolveExtraction(S())).toEqual({});
  });
});
