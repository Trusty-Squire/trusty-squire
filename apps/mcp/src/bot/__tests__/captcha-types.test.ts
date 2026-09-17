// Type-level + shape tests for CaptchaSolveResult discriminated
// union. End-to-end captcha solving is covered by real-service signup
// tests (Postmark, Resend) rather than mocking out an iframe widget
// here.

import { describe, expect, it } from "vitest";
import type { CaptchaSolveResult, CaptchaKind } from "../captcha.js";
import { isRecaptchaCheckboxFrameUrl } from "../captcha.js";

describe("isRecaptchaCheckboxFrameUrl", () => {
  it("accepts the normal-size api2/anchor checkbox frame", () => {
    expect(
      isRecaptchaCheckboxFrameUrl(
        "https://www.google.com/recaptcha/api2/anchor?ar=1&k=6LenZ0EUAAAAADh8FOnx3APzeEQxffiRaD9rcYs1&co=aHR0cHM6Ly93d3cua2FnZ2xlLmNvbQ&hl=en&v=vite&size=normal",
      ),
    ).toBe(true);
  });

  it("accepts the api2/anchor frame with no size param (Kaggle's shape)", () => {
    expect(
      isRecaptchaCheckboxFrameUrl(
        "https://www.google.com/recaptcha/api2/anchor?ar=1&k=6LenZ0EUAAAAADh8FOnx3APzeEQxffiRaD9rcYs1",
      ),
    ).toBe(true);
  });

  it("accepts the recaptcha.net mirror and the enterprise anchor", () => {
    expect(
      isRecaptchaCheckboxFrameUrl("https://api.recaptcha.net/recaptcha/api2/anchor?k=6Lk"),
    ).toBe(true);
    expect(
      isRecaptchaCheckboxFrameUrl("https://www.google.com/recaptcha/enterprise/anchor?k=6Lk"),
    ).toBe(true);
  });

  it("refuses the invisible anchor — it has no checkbox", () => {
    expect(
      isRecaptchaCheckboxFrameUrl(
        "https://www.google.com/recaptcha/api2/anchor?k=6Lk&size=invisible",
      ),
    ).toBe(false);
  });

  it("refuses the challenge frame and non-recaptcha captcha frames", () => {
    expect(isRecaptchaCheckboxFrameUrl("https://www.google.com/recaptcha/api2/bframe?k=6Lk")).toBe(
      false,
    );
    expect(
      isRecaptchaCheckboxFrameUrl("https://newassets.hcaptcha.com/captcha/v1/frame#frame=checkbox"),
    ).toBe(false);
    expect(
      isRecaptchaCheckboxFrameUrl("https://challenges.cloudflare.com/turnstile/v0/api.js"),
    ).toBe(false);
  });

  it("refuses garbage", () => {
    expect(isRecaptchaCheckboxFrameUrl("")).toBe(false);
    expect(isRecaptchaCheckboxFrameUrl("not a url")).toBe(false);
    expect(
      isRecaptchaCheckboxFrameUrl("https://evil.example.com/recaptcha/api2/anchor?k=6Lk"),
    ).toBe(false);
  });
});

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
