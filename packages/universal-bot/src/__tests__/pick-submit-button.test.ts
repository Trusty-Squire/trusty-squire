// Covers pickSubmitButtonIndex — the scorer that disambiguates a submit
// selector matching several button[type=submit]. Signup pages render
// OAuth buttons ("Continue with Google" / "GitHub") as submit-typed
// buttons next to the real one; a generic selector then resolves to
// all of them and a strict-mode Playwright locator throws.
//
// Regression test for the Resend signup that submitted nothing because
// the selector resolved to 3 buttons (TODOS.md S2).

import { describe, expect, it } from "vitest";
import { pickSubmitButtonIndex } from "../browser.js";

describe("pickSubmitButtonIndex", () => {
  it("picks 'Create account' over OAuth buttons (the Resend case)", () => {
    expect(
      pickSubmitButtonIndex([
        "Continue with Google",
        "Continue with GitHub",
        "Create account",
      ]),
    ).toBe(2);
  });

  it("picks the real submit regardless of position", () => {
    expect(pickSubmitButtonIndex(["Sign up", "Continue with Google"])).toBe(0);
  });

  it("returns null when every candidate is an OAuth button", () => {
    // OAuth-only signup page — nothing to click; clickSubmit() must
    // surface this as submit_failed rather than mis-click an OAuth flow.
    expect(
      pickSubmitButtonIndex(["Continue with Google", "Continue with GitHub"]),
    ).toBeNull();
  });

  it("does not mistake a sign-in button for the signup submit", () => {
    expect(pickSubmitButtonIndex(["Log in", "Sign in"])).toBeNull();
  });

  it("handles register / get started / create your account variants", () => {
    expect(pickSubmitButtonIndex(["Register"])).toBe(0);
    expect(pickSubmitButtonIndex(["Get started"])).toBe(0);
    expect(pickSubmitButtonIndex(["Create your account"])).toBe(0);
  });

  it("falls back to a bare 'Continue' submit when no stronger signal", () => {
    expect(pickSubmitButtonIndex(["Continue"])).toBe(0);
  });

  it("tolerates whitespace and mixed case", () => {
    expect(
      pickSubmitButtonIndex(["  CONTINUE WITH GOOGLE  ", "  Create Account  "]),
    ).toBe(1);
  });

  it("returns null for an empty candidate list", () => {
    expect(pickSubmitButtonIndex([])).toBeNull();
  });
});
