import { describe, it, expect } from "vitest";
import {
  deriveBlockReason,
  recordBlock,
  clearBlock,
  isEligibleByBlock,
  bumpPostBlockAttempts,
  listActiveBlocks,
} from "../blocks.mjs";

const T0 = Date.parse("2026-05-24T12:00:00Z");
const DAY = 86_400_000;

describe("deriveBlockReason", () => {
  it.each([
    [{ status: "payment_required" }, "needs_payment"],
    [{ status: "oauth_required" }, "needs_oauth_provider_session"],
    [{ status: "needs_login" }, "needs_login"],
    [{ status: "oauth_consent_needs_review" }, "needs_oauth_consent_review"],
    [{ status: "onboarding_blocked" }, "needs_onboarding_review"],
  ])("status %j → reason %s", (final, expected) => {
    expect(deriveBlockReason(final)).toBe(expected);
  });

  it("phone-verification text → needs_phone", () => {
    expect(deriveBlockReason({ status: "failed", error: "Phone verification required" }))
      .toBe("needs_phone");
    expect(deriveBlockReason({ status: "failed", error: "please verify your phone" }))
      .toBe("needs_phone");
  });

  it("SMS-required text → needs_sms", () => {
    expect(deriveBlockReason({ status: "failed", error: "SMS-required gate at checkout" }))
      .toBe("needs_sms");
  });

  it("unrelated failure returns null", () => {
    expect(deriveBlockReason({ status: "captcha_blocked" })).toBeNull();
    expect(deriveBlockReason({ status: "failed", error: "generic failure" })).toBeNull();
    expect(deriveBlockReason(null)).toBeNull();
  });
});

describe("recordBlock", () => {
  it("creates a fresh block entry", () => {
    const state = recordBlock({}, "vercel", "needs_phone", T0);
    expect(state.vercel.blocked_reason).toBe("needs_phone");
    expect(state.vercel.blocked_at).toBe("2026-05-24T12:00:00.000Z");
    const untilMs = Date.parse(state.vercel.blocked_until);
    expect(untilMs).toBe(T0 + 30 * DAY);
    expect(state.vercel.attempts_after_block).toBe(0);
  });

  it("preserves attempts_after_block when re-recording the same reason", () => {
    let s = recordBlock({}, "vercel", "needs_phone", T0);
    s = bumpPostBlockAttempts(s, "vercel");
    expect(s.vercel.attempts_after_block).toBe(1);
    // Recording same reason again — should keep the retry counter
    s = recordBlock(s, "vercel", "needs_phone", T0 + DAY);
    expect(s.vercel.attempts_after_block).toBe(1);
  });

  it("resets retry counter when reason changes (new block kind)", () => {
    let s = recordBlock({}, "vercel", "needs_phone", T0);
    s = bumpPostBlockAttempts(s, "vercel");
    s = recordBlock(s, "vercel", "needs_payment", T0 + DAY);
    expect(s.vercel.blocked_reason).toBe("needs_payment");
    expect(s.vercel.attempts_after_block).toBe(0);
  });

  it("does not mutate input state", () => {
    const initial = {};
    const snapshot = JSON.stringify(initial);
    recordBlock(initial, "x", "needs_phone", T0);
    expect(JSON.stringify(initial)).toBe(snapshot);
  });
});

describe("clearBlock", () => {
  it("removes the slug from state", () => {
    let s = recordBlock({}, "vercel", "needs_phone", T0);
    s = clearBlock(s, "vercel");
    expect(s.vercel).toBeUndefined();
  });

  it("is a no-op when slug isn't in state", () => {
    const state = { mailersend: { blocked_reason: "needs_phone" } };
    const after = clearBlock(state, "vercel");
    expect(after).toEqual(state);
  });
});

describe("isEligibleByBlock", () => {
  it("eligible when no block recorded", () => {
    expect(isEligibleByBlock({}, "x", T0).eligible).toBe(true);
  });

  it("NOT eligible during the 30d block window", () => {
    const s = recordBlock({}, "vercel", "needs_phone", T0);
    // 15d into the block
    const verdict = isEligibleByBlock(s, "vercel", T0 + 15 * DAY);
    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toMatch(/external block.*needs_phone/);
    expect(verdict.reason).toMatch(/\d+d until retry/);
  });

  it("eligible exactly at blocked_until (cooldown elapsed)", () => {
    const s = recordBlock({}, "vercel", "needs_phone", T0);
    const verdict = isEligibleByBlock(s, "vercel", T0 + 30 * DAY);
    expect(verdict.eligible).toBe(true);
    expect(verdict.reason).toMatch(/post-block retry/);
  });

  it("NOT eligible after post-block retry cap exhausted", () => {
    let s = recordBlock({}, "vercel", "needs_phone", T0);
    s = bumpPostBlockAttempts(s, "vercel");
    // 31d in — cooldown elapsed but we've used our 1 retry
    const verdict = isEligibleByBlock(s, "vercel", T0 + 31 * DAY);
    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toMatch(/needs operator/);
  });
});

describe("listActiveBlocks", () => {
  it("returns slugs with blocked_until in the future, sorted by soonest expiry", () => {
    let s = recordBlock({}, "alpha", "needs_phone", T0);
    s = recordBlock(s, "beta", "needs_phone", T0 + 5 * DAY);  // expires later
    s = recordBlock(s, "gamma", "needs_phone", T0 - 60 * DAY); // already expired
    const active = listActiveBlocks(s, T0 + 10 * DAY);
    expect(active.map((e) => e.slug)).toEqual(["alpha", "beta"]);
  });

  it("returns empty when nothing active", () => {
    expect(listActiveBlocks({}, T0)).toEqual([]);
  });
});
