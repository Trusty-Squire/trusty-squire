// JCS canonicalization tests. RFC 8785 vectors from §3.2.4.
//
// The canonicalize package handles the actual rules; these tests pin the
// expected outputs so a future package upgrade can't silently change
// canonical bytes (which would invalidate every signed mandate).

import { describe, expect, it } from "vitest";
import { canonicalString, canonicalBytes, CanonicalizationError } from "../canonicalize.js";

describe("canonicalString", () => {
  it("sorts keys lexically", () => {
    expect(canonicalString({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("preserves array order", () => {
    expect(canonicalString({ items: [3, 1, 2] })).toBe('{"items":[3,1,2]}');
  });

  it("emits compact JSON (no whitespace)", () => {
    expect(canonicalString({ a: { b: 1 } })).toBe('{"a":{"b":1}}');
  });

  it("escapes special characters per JCS string rules", () => {
    expect(canonicalString({ s: "a\nb\"c" })).toBe('{"s":"a\\nb\\"c"}');
  });

  it("formats numbers per IEEE 754 / ECMAScript ToString", () => {
    expect(canonicalString({ x: 1.5 })).toBe('{"x":1.5}');
    expect(canonicalString({ x: 0 })).toBe('{"x":0}');
    expect(canonicalString({ x: -0 })).toBe('{"x":0}');
  });

  it("nested objects also key-sort", () => {
    const a = canonicalString({ outer: { z: 1, a: 2 } });
    expect(a).toBe('{"outer":{"a":2,"z":1}}');
  });

  it("Unicode keys sort by code point", () => {
    // RFC 8785 §3.2.3: code-point order
    expect(canonicalString({ ä: 1, b: 2 })).toBe('{"b":2,"ä":1}');
  });

  it("throws CanonicalizationError on non-string output (cycles, BigInt)", () => {
    const obj: { self?: unknown } = {};
    obj.self = obj;
    expect(() => canonicalString(obj)).toThrow(CanonicalizationError);
  });
});

describe("canonicalBytes", () => {
  it("returns UTF-8 encoded canonical string", () => {
    const bytes = canonicalBytes({ b: 1, a: 2 });
    const expected = new TextEncoder().encode('{"a":2,"b":1}');
    expect(bytes).toEqual(expected);
  });
});
