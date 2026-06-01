// T3 — dispatch resolution for the unified ProvisionEvent emit.
// These are the pure decision functions behind the router's single
// emit point; the fail-open registry/bot plumbing around them is
// fire-and-forget and intentionally not asserted here.

import { describe, expect, it } from "vitest";
import { resolveDispatch, finalOutcomeOf } from "../provision-any.js";

describe("resolveDispatch", () => {
  it("replay served → replay / replay / ok", () => {
    expect(resolveDispatch(true, true)).toEqual({
      initialStrategy: "replay",
      finalStrategy: "replay",
      replayOutcome: "ok",
    });
  });

  it("replay attempted but fell back to bot → replay / bot / miss", () => {
    // The tricky case the design called out: one row must capture both
    // "replay was tried" and "bot ultimately served it".
    expect(resolveDispatch(false, true)).toEqual({
      initialStrategy: "replay",
      finalStrategy: "bot",
      replayOutcome: "miss",
    });
  });

  it("no skill, bot direct → bot / bot / na", () => {
    expect(resolveDispatch(false, false)).toEqual({
      initialStrategy: "bot",
      finalStrategy: "bot",
      replayOutcome: "na",
    });
  });

  it("served wins even if the attempted flag is somehow false", () => {
    expect(resolveDispatch(true, false)).toEqual({
      initialStrategy: "replay",
      finalStrategy: "replay",
      replayOutcome: "ok",
    });
  });
});

describe("finalOutcomeOf", () => {
  it("success → ok", () => {
    expect(finalOutcomeOf({ success: true })).toBe("ok");
  });

  it("wall failure kinds → blocked", () => {
    for (const kind of ["captcha_blocked", "anti_bot_blocked", "captcha"]) {
      expect(finalOutcomeOf({ success: false, error: kind })).toBe("blocked");
    }
  });

  it("non-wall failures → failed", () => {
    expect(finalOutcomeOf({ success: false, error: "verification_not_sent" })).toBe("failed");
    expect(finalOutcomeOf({ success: false, error: "oauth_required" })).toBe("failed");
  });

  it("failure with no error string → failed (not blocked)", () => {
    expect(finalOutcomeOf({ success: false })).toBe("failed");
  });
});
