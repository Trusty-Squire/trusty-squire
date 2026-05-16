// Type-level + shape tests for CaptchaSolveResult discriminated
// union. End-to-end captcha solving is covered by real-service signup
// tests (Postmark, Resend) rather than mocking out an iframe widget
// here.

import { describe, expect, it } from "vitest";
import type {
  CaptchaSolveResult,
  CaptchaKind,
} from "../browser.js";

describe("CaptchaSolveResult shape", () => {
  it("found:false has no kind field", () => {
    const r: CaptchaSolveResult = { found: false };
    // TypeScript discriminates: when found is false, no kind access.
    expect(r.found).toBe(false);
  });

  it("found:true,solved:true carries kind", () => {
    const r: CaptchaSolveResult = { found: true, solved: true, kind: "turnstile" };
    expect(r.found).toBe(true);
    if (r.found) {
      expect(r.solved).toBe(true);
      expect(r.kind).toBe("turnstile");
    }
  });

  it("found:true,solved:false carries kind for diagnostics", () => {
    const r: CaptchaSolveResult = { found: true, solved: false, kind: "recaptcha" };
    if (r.found && !r.solved) {
      expect(r.kind).toBe("recaptcha");
    }
  });

  it("CaptchaKind union covers both providers", () => {
    const kinds: CaptchaKind[] = ["turnstile", "recaptcha"];
    expect(kinds).toHaveLength(2);
  });
});
