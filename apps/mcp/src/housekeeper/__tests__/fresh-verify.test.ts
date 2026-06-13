import { describe, expect, it, vi } from "vitest";
import { freshVerifyService, isHardFailure, meetsAgreement } from "../fresh-verify.js";
import type { VerifyIdentity } from "../identity-pool.js";

const ID = (id: string): VerifyIdentity => ({
  id,
  email: `${id}@trustysquire.ai`,
  profileDir: `/p/${id}`,
  providers: ["google"],
});
const POOL = [ID("verify-01"), ID("verify-02"), ID("verify-03")];
const POOL4 = [...POOL, ID("verify-04")];

describe("meetsAgreement", () => {
  it("needs >= agreement successes", () => {
    const o = (success: boolean) => ({ identityId: "x", success });
    expect(meetsAgreement([o(true), o(true)], 2)).toBe(true);
    expect(meetsAgreement([o(true), o(false)], 2)).toBe(false);
    expect(meetsAgreement([o(true)], 1)).toBe(true);
  });
});

describe("freshVerifyService", () => {
  it("promotes when 2 independent identities both succeed", async () => {
    const marked: string[] = [];
    const res = await freshVerifyService({
      service: "sentry",
      provider: "google",
      identities: POOL,
      usage: [],
      runSignup: async (i) => ({ success: true, credential: `key-${i.id}` }),
      markSpent: (id) => marked.push(id),
    });
    expect(res.kind).toBe("verified");
    expect(res.promoted).toBe(true);
    expect(res.outcomes.map((o) => o.identityId)).toEqual(["verify-01", "verify-02"]);
    expect(marked).toEqual(["verify-01", "verify-02"]); // both spent
  });

  it("does NOT promote when only one succeeds", async () => {
    const res = await freshVerifyService({
      service: "sentry",
      provider: "google",
      identities: POOL,
      usage: [],
      runSignup: async (i) =>
        i.id === "verify-01" ? { success: true, credential: "k" } : { success: false, reason: "form drift" },
      markSpent: () => undefined,
    });
    expect(res.promoted).toBe(false);
    expect(res.outcomes.filter((o) => o.success)).toHaveLength(1);
  });

  it("marks identities spent even on failure (one-shot)", async () => {
    const marked: string[] = [];
    await freshVerifyService({
      service: "sentry",
      provider: "google",
      identities: POOL,
      usage: [],
      runSignup: async () => ({ success: false, reason: "blocked" }),
      markSpent: (id) => marked.push(id),
    });
    expect(marked).toEqual(["verify-01", "verify-02"]);
  });

  it("a thrown runSignup is captured as a failure, not a crash", async () => {
    const res = await freshVerifyService({
      service: "sentry",
      provider: "google",
      identities: POOL,
      usage: [],
      runSignup: async (i) => {
        if (i.id === "verify-02") throw new Error("chrome wedged");
        return { success: true, credential: "k" };
      },
      markSpent: () => undefined,
    });
    expect(res.promoted).toBe(false);
    expect(res.outcomes[1]).toMatchObject({ identityId: "verify-02", success: false, reason: "chrome wedged" });
  });

  it("returns insufficient_identities when fewer than agreement are unspent", async () => {
    const usage = [
      { identityId: "verify-01", service: "sentry", at: "t" },
      { identityId: "verify-02", service: "sentry", at: "t" },
    ];
    const runSignup = vi.fn();
    const res = await freshVerifyService({
      service: "sentry",
      provider: "google",
      identities: POOL,
      usage,
      runSignup,
      markSpent: () => undefined,
    });
    expect(res.kind).toBe("insufficient_identities");
    expect(res.available).toBe(1);
    expect(res.promoted).toBe(false);
    expect(runSignup).not.toHaveBeenCalled(); // never burns the last identity on a doomed round
  });

  it("respects a custom agreement size", async () => {
    const res = await freshVerifyService({
      service: "x",
      provider: "google",
      agreement: 3,
      identities: POOL,
      usage: [],
      runSignup: async () => ({ success: true, credential: "k" }),
      markSpent: () => undefined,
    });
    expect(res.outcomes).toHaveLength(3);
    expect(res.promoted).toBe(true);
  });

  it("retryBudget spends an extra identity to clear a TRANSIENT flake", async () => {
    // verify-02 flakes (form drift), but the recipe reproduces: a 3rd identity
    // brings it to 2/2. Without retry this would hold at 1/2 — the variance bug.
    const marked: string[] = [];
    const res = await freshVerifyService({
      service: "x",
      provider: "google",
      retryBudget: 2,
      identities: POOL,
      usage: [],
      runSignup: async (i) =>
        i.id === "verify-02"
          ? { success: false, reason: "form drift mid-fill" }
          : { success: true, credential: `k-${i.id}` },
      markSpent: (id) => marked.push(id),
    });
    expect(res.promoted).toBe(true);
    expect(res.outcomes.filter((o) => o.success)).toHaveLength(2);
    expect(marked).toEqual(["verify-01", "verify-02", "verify-03"]); // flake + retry both spent
  });

  it("retryBudget stops once the agreement bar is met (no wasted identities)", async () => {
    const marked: string[] = [];
    const res = await freshVerifyService({
      service: "x",
      provider: "google",
      retryBudget: 2,
      identities: POOL4,
      usage: [],
      runSignup: async () => ({ success: true, credential: "k" }),
      markSpent: (id) => marked.push(id),
    });
    expect(res.promoted).toBe(true);
    expect(marked).toEqual(["verify-01", "verify-02"]); // stopped at 2-of-N, didn't burn the rest
  });

  it("a HARD wall short-circuits — does NOT burn the retry pool", async () => {
    const marked: string[] = [];
    const res = await freshVerifyService({
      service: "x",
      provider: "google",
      retryBudget: 2,
      identities: POOL4,
      usage: [],
      // anti_bot_blocked is deterministic — every identity hits it, so retrying
      // is wasted pool. Bail after the first.
      runSignup: async () => ({ success: false, reason: "anti_bot_blocked: turnstile wall" }),
      markSpent: (id) => marked.push(id),
    });
    expect(res.promoted).toBe(false);
    expect(marked).toEqual(["verify-01"]); // short-circuited, retry pool untouched
  });

  it("retries a TRANSIENT failure even with retryBudget but bails on the FIRST hard wall", async () => {
    // first identity flakes (transient) → retry; second hits a hard wall → stop.
    const marked: string[] = [];
    const res = await freshVerifyService({
      service: "x",
      provider: "google",
      retryBudget: 2,
      identities: POOL4,
      usage: [],
      runSignup: async (i) =>
        i.id === "verify-01"
          ? { success: false, reason: "transient onboarding stall" }
          : { success: false, reason: "needs_login: provider session missing" },
      markSpent: (id) => marked.push(id),
    });
    expect(res.promoted).toBe(false);
    expect(marked).toEqual(["verify-01", "verify-02"]); // flaked, retried once, then hard-bailed
  });
});

describe("isHardFailure", () => {
  it("treats deterministic walls as hard (no retry)", () => {
    expect(isHardFailure("anti_bot_blocked: turnstile")).toBe(true);
    expect(isHardFailure("needs_login: session gone")).toBe(true);
    expect(isHardFailure("no_signup_link")).toBe(true);
    expect(isHardFailure("captcha_blocked")).toBe(true);
    expect(isHardFailure("oauth_required")).toBe(true);
    // Post-OAuth wizard nav wall — deterministic, 0% rescue.
    expect(isHardFailure("oauth_onboarding_failed: could not reach an API key")).toBe(true);
  });

  it("treats timing/form flakes as transient (retry-worthy)", () => {
    expect(isHardFailure("form drift mid-fill")).toBe(false);
    expect(isHardFailure("signup_failed")).toBe(false);
    expect(isHardFailure("chrome wedged")).toBe(false);
    expect(isHardFailure(undefined)).toBe(false);
  });

  it("keeps the variance-prone OAuth codes transient (real promotions came from retrying these)", () => {
    // gladia promoted after verify-01 hit oauth_loop_detected; clarifai promoted
    // after verify-03 hit oauth_session_not_persisted. Making these hard would
    // short-circuit those rescues — they MUST keep retrying.
    expect(isHardFailure("oauth_loop_detected: redirect bounce")).toBe(false);
    expect(isHardFailure("oauth_session_not_persisted: callback never settled")).toBe(false);
    expect(isHardFailure("oauth_consent_needs_review: re-check")).toBe(false);
  });
});
