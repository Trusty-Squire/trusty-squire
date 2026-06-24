import { describe, expect, it, vi } from "vitest";
import {
  classifyAttempt,
  evaluateConfidence,
  freshVerifyService,
  isHardFailure,
  isNonObservation,
  isNonRedrawableNonObservation,
  NEEDS_LOGIN_REDRAW_CAP,
  nonObservationRequiredProvider,
  wilsonInterval,
  DEFAULT_PROMOTE_FLOOR,
  DEFAULT_REJECT_CEILING,
  DEFAULT_MAX_SAMPLES,
} from "../fresh-verify.js";
import {
  claimIdentity,
  releaseIdentity,
  type VerifyIdentity,
} from "../identity-pool.js";

const ID = (
  id: string,
  providers: VerifyIdentity["providers"] = ["google"],
): VerifyIdentity => ({
  id,
  email: `${id}@trustysquire.ai`,
  profileDir: `/p/${id}`,
  providers,
});
const POOL = [ID("verify-01"), ID("verify-02"), ID("verify-03")];
const POOL4 = [...POOL, ID("verify-04")];
const POOL8 = [...POOL4, ID("verify-05"), ID("verify-06"), ID("verify-07"), ID("verify-08")];

// The default bounds the production runner uses (until tuned).
const DEFAULTS = {
  promoteFloor: DEFAULT_PROMOTE_FLOOR,
  rejectCeiling: DEFAULT_REJECT_CEILING,
  maxSamples: DEFAULT_MAX_SAMPLES,
};

// ── D2.A: the pure sampler ───────────────────────────────────────────────────

describe("wilsonInterval", () => {
  it("n=0 → full uncertainty [0,1]", () => {
    expect(wilsonInterval(0, 0)).toEqual({ lcb: 0, ucb: 1 });
  });
  it("monotone: more successes raises the lower bound", () => {
    const a = wilsonInterval(2, 0);
    const b = wilsonInterval(4, 0);
    expect(b.lcb).toBeGreaterThan(a.lcb);
  });
  it("stays within [0,1]", () => {
    for (const [s, f] of [[1, 0], [0, 1], [3, 1], [10, 2]] as const) {
      const { lcb, ucb } = wilsonInterval(s, f);
      expect(lcb).toBeGreaterThanOrEqual(0);
      expect(ucb).toBeLessThanOrEqual(1);
      expect(lcb).toBeLessThanOrEqual(ucb);
    }
  });
});

describe("evaluateConfidence", () => {
  it("1/1 → promote by default (registry threshold is one clean fresh replay)", () => {
    const r = evaluateConfidence(1, 0, { ...DEFAULTS, drawsRemaining: 3 });
    expect(r.verdict).toBe("promote");
    expect(r.lcb).toBeGreaterThan(DEFAULT_PROMOTE_FLOOR);
  });

  it("2/2 → promote (LCB clears the floor)", () => {
    const r = evaluateConfidence(2, 0, { ...DEFAULTS, drawsRemaining: 2 });
    expect(r.verdict).toBe("promote");
    expect(r.lcb).toBeGreaterThan(DEFAULT_PROMOTE_FLOOR);
  });

  it("1/2 → sample_more (interval still straddles both thresholds)", () => {
    const r = evaluateConfidence(1, 1, { ...DEFAULTS, drawsRemaining: 2 });
    expect(r.verdict).toBe("sample_more");
  });

  it("0/2 → sample_more or reject per the UCB, never promote", () => {
    const r = evaluateConfidence(0, 2, { ...DEFAULTS, drawsRemaining: 2 });
    expect(["sample_more", "reject"]).toContain(r.verdict);
    expect(r.verdict).not.toBe("promote");
  });

  it("2/4 is NOT the same confidence as 2/2 (count ≠ confidence)", () => {
    const twoOfTwo = evaluateConfidence(2, 0, { ...DEFAULTS, drawsRemaining: 0 });
    const twoOfFour = evaluateConfidence(2, 2, { ...DEFAULTS, drawsRemaining: 0 });
    // The whole point of D2: same success COUNT, different verdict + LCB.
    expect(twoOfFour.lcb).toBeLessThan(twoOfTwo.lcb);
    expect(twoOfTwo.verdict).toBe("promote");
    expect(twoOfFour.verdict).not.toBe("promote");
  });

  it("pool/budget exhausted before convergence → hold (NOT reject)", () => {
    // 1✓/1✗: interval is wide, neither threshold cleared, and no draws left.
    const r = evaluateConfidence(1, 1, { ...DEFAULTS, drawsRemaining: 0 });
    expect(r.verdict).toBe("hold");
  });

  it("full informative budget with zero successes rejects instead of holding", () => {
    const r = evaluateConfidence(0, DEFAULT_MAX_SAMPLES, { ...DEFAULTS, drawsRemaining: 0 });
    expect(r.verdict).toBe("reject");
  });

  it("a strongly-failing posterior with budget left can reject on the UCB", () => {
    // 0/5 with a higher reject ceiling clears UCB < ceiling.
    const r = evaluateConfidence(0, 5, {
      promoteFloor: 0.6,
      rejectCeiling: 0.5,
      maxSamples: 8,
      drawsRemaining: 3,
    });
    expect(r.verdict).toBe("reject");
  });
});

// ── D2.B: attempt → observation mapping ──────────────────────────────────────

describe("classifyAttempt", () => {
  it("a credential is an informative success", () => {
    expect(classifyAttempt({ success: true })).toBe("informative_success");
  });
  it("a deterministic wall is a hard wall", () => {
    expect(classifyAttempt({ success: false, reason: "anti_bot_blocked: turnstile" })).toBe(
      "hard_wall",
    );
    expect(
      classifyAttempt({ success: false, reason: "onboarding_blocked: manual approval" }),
    ).toBe("hard_wall");
  });
  it("a transient flake is a non-observation", () => {
    expect(classifyAttempt({ success: false, reason: "form drift mid-fill" })).toBe(
      "non_observation",
    );
    expect(classifyAttempt({ success: false, reason: "nav_timeout: tunnel stall" })).toBe(
      "non_observation",
    );
    expect(
      classifyAttempt({ success: false, reason: "oauth_loop_detected: redirect bounce" }),
    ).toBe("non_observation");
    expect(
      classifyAttempt({ success: false, reason: "oauth_onboarding_failed: dashboard took a bad path" }),
    ).toBe("non_observation");
    expect(
      classifyAttempt({ success: false, reason: "verification_not_sent: email did not arrive in time" }),
    ).toBe("non_observation");
    expect(classifyAttempt({ success: false, reason: "needs_login: session gone" })).toBe(
      "non_observation",
    );
    expect(
      classifyAttempt({ success: false, reason: "needs_oauth_provider_session: google profile stale" }),
    ).toBe("non_observation");
    expect(classifyAttempt({ success: false, reason: "run_timeout: exceeded 600s" })).toBe(
      "non_observation",
    );
    expect(
      classifyAttempt({
        success: false,
        reason: "bot Chrome profile is held by another run (a login or signup); retry shortly",
      }),
    ).toBe("non_observation");
    expect(
      classifyAttempt({
        success: false,
        reason:
          "stored-skill replay step_failed step=3 No email verification code arrived. [returning-user: authenticated session diverged from fresh-signup capture]",
      }),
    ).toBe("non_observation");
  });
  it("anything else (genuine rot) is an informative failure", () => {
    expect(classifyAttempt({ success: false, reason: "step_failed step=3 button gone" })).toBe(
      "informative_failure",
    );
    expect(classifyAttempt({ success: false, reason: "validator_failed: wrong key shape" })).toBe(
      "informative_failure",
    );
  });
});

describe("freshVerifyService (sampler-driven)", () => {
  it("promotes when independent fresh signups clear the LCB floor", async () => {
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
    expect(res.verdict).toBe("promote");
    expect(res.promoted).toBe(true);
    expect(res.passRateLcb).toBeGreaterThan(DEFAULT_PROMOTE_FLOOR);
  });

  it("does NOT promote mixed 1✗/1✓ — HOLD on insufficient signal", async () => {
    // verify-01 genuinely rots, verify-02 succeeds: 1✗/1✓, no draws left → hold.
    const res = await freshVerifyService({
      service: "sentry",
      provider: "google",
      identities: [ID("verify-01"), ID("verify-02")],
      usage: [],
      runSignup: async (i) =>
        i.id === "verify-01"
          ? { success: false, reason: "step_failed: button gone" }
          : { success: true, credential: "k" },
      markSpent: () => undefined,
    });
    expect(res.verdict).toBe("hold");
    expect(res.promoted).toBe(false);
    expect(res.successes).toBe(1);
    expect(res.failures).toBe(1);
  });

  it("a transient flake is DROPPED as a non-observation and another identity is drawn", async () => {
    // verify-01 flakes (transient) — must NOT count; the recipe then proves out
    // on the next informative success.
    const marked: string[] = [];
    const res = await freshVerifyService({
      service: "x",
      provider: "google",
      identities: POOL4,
      usage: [],
      runSignup: async (i) =>
        i.id === "verify-01"
          ? { success: false, reason: "form drift mid-fill" }
          : { success: true, credential: `k-${i.id}` },
      markSpent: (id) => marked.push(id),
    });
    expect(res.verdict).toBe("promote");
    // The flake did not move the posterior (0 failures recorded).
    expect(res.failures).toBe(0);
    expect(res.successes).toBeGreaterThanOrEqual(1);
    // verify-01 was still spent (it created/attempted an account).
    expect(marked[0]).toBe("verify-01");
  });

  it("a provider/session blocker reroutes to a capable identity when the pool has one", async () => {
    const marked: string[] = [];
    const runSignup = vi.fn(async (identity: VerifyIdentity) =>
      identity.providers.includes("github")
        ? { success: true, credential: "k-github" }
        : {
            success: false,
            reason: "needs_login: stored-skill replay provider=github step=0",
          },
    );
    const res = await freshVerifyService({
      service: "replicate",
      provider: "google",
      identities: [ID("verify-01"), ID("verify-gh", ["github"])],
      usage: [],
      runSignup,
      markSpent: (id) => marked.push(id),
    });

    expect(res.kind).toBe("verified");
    expect(res.verdict).toBe("promote");
    expect(res.samples).toBe(1);
    expect(res.outcomes).toHaveLength(2);
    expect(runSignup).toHaveBeenCalledTimes(2);
    expect(marked).toEqual(["verify-01", "verify-gh"]);
  });

  it("a provider/session blocker holds after one robot when no capable identity exists", async () => {
    const marked: string[] = [];
    const runSignup = vi.fn(async () => ({
      success: false,
      reason: "needs_login: stored-skill replay provider=github step=0",
    }));
    const res = await freshVerifyService({
      service: "replicate",
      provider: "google",
      identities: POOL4,
      usage: [],
      runSignup,
      markSpent: (id) => marked.push(id),
    });

    expect(res.kind).toBe("verified");
    expect(res.verdict).toBe("hold");
    expect(res.samples).toBe(0);
    expect(res.outcomes).toHaveLength(1);
    expect(runSignup).toHaveBeenCalledOnce();
    expect(marked).toEqual(["verify-01"]);
  });

  it("same-provider needs_login is redrawable: skips the session-stale robot and promotes", async () => {
    // MEASURED 2026-06-24 (meilisearch): one pool yields chooser robots (live
    // session → pass) AND identifier robots (needs_login) for the SAME provider.
    // The stale first draw must NOT hold the whole skill — redraw and promote.
    const marked: string[] = [];
    let call = 0;
    const runSignup = vi.fn(async () => {
      call += 1;
      return call === 1
        ? { success: false, reason: "needs_login: stored-skill replay provider=google step=1" }
        : { success: true, credential: "k-meili" };
    });
    const res = await freshVerifyService({
      service: "meilisearch",
      provider: "google",
      identities: POOL8,
      usage: [],
      runSignup,
      markSpent: (id) => marked.push(id),
    });

    expect(res.kind).toBe("verified");
    expect(res.verdict).toBe("promote");
    expect(runSignup).toHaveBeenCalledTimes(2);
  });

  it("same-provider needs_login holds at the redraw cap WITHOUT draining the pool", async () => {
    // A service where NO robot has the session must not burn all 8 — the cap
    // bounds the login draws well below pool size.
    const marked: string[] = [];
    const runSignup = vi.fn(async () => ({
      success: false,
      reason: "needs_login: stored-skill replay provider=google step=1",
    }));
    const res = await freshVerifyService({
      service: "meilisearch",
      provider: "google",
      identities: POOL8,
      usage: [],
      runSignup,
      markSpent: (id) => marked.push(id),
    });

    expect(res.verdict).toBe("hold");
    expect(res.samples).toBe(0); // non-observations never move the posterior
    expect(runSignup).toHaveBeenCalledTimes(NEEDS_LOGIN_REDRAW_CAP);
    expect(marked.length).toBeLessThan(POOL8.length);
  });

  it("one HARD wall holds; two independent HARD walls reject", async () => {
    const marked: string[] = [];
    const res = await freshVerifyService({
      service: "x",
      provider: "google",
      identities: [ID("verify-01")],
      usage: [],
      runSignup: async () => ({ success: false, reason: "anti_bot_blocked: turnstile wall" }),
      markSpent: (id) => marked.push(id),
    });
    expect(res.verdict).toBe("hold");
    expect(res.promoted).toBe(false);
    expect(res.failureKind).toBe("anti_bot_blocked");
    expect(marked).toEqual(["verify-01"]);

    const marked2: string[] = [];
    const res2 = await freshVerifyService({
      service: "x",
      provider: "google",
      identities: [ID("verify-01"), ID("verify-02")],
      usage: [],
      runSignup: async () => ({ success: false, reason: "anti_bot_blocked: turnstile wall" }),
      markSpent: (id) => marked2.push(id),
    });
    expect(res2.verdict).toBe("reject");
    expect(res2.promoted).toBe(false);
    expect(res2.failureKind).toBe("anti_bot_blocked");
    expect(marked2).toEqual(["verify-01", "verify-02"]);
  });

  it("genuine rot across identities counts and drives toward reject (high reject ceiling)", async () => {
    const res = await freshVerifyService({
      service: "x",
      provider: "google",
      confidence: { promoteFloor: 0.6, rejectCeiling: 0.5, maxSamples: 8 },
      identities: POOL8,
      usage: [],
      runSignup: async () => ({ success: false, reason: "validator_failed: wrong shape" }),
      markSpent: () => undefined,
    });
    expect(res.verdict).toBe("reject");
    expect(res.failures).toBeGreaterThanOrEqual(2);
    expect(res.failureKind).toBe("validator_failed");
  });

  it("genuine rot across the full default budget rejects, not HOLDs", async () => {
    const res = await freshVerifyService({
      service: "x",
      provider: "google",
      identities: POOL4,
      usage: [],
      runSignup: async () => ({ success: false, reason: "step_failed: submit disabled" }),
      markSpent: () => undefined,
    });
    expect(res.verdict).toBe("reject");
    expect(res.successes).toBe(0);
    expect(res.failures).toBe(DEFAULT_MAX_SAMPLES);
    expect(res.failureKind).toBe("step_failed");
  });

  it("a thrown runSignup is captured as a failure observation, not a crash", async () => {
    const res = await freshVerifyService({
      service: "sentry",
      provider: "google",
      identities: POOL,
      usage: [],
      runSignup: async (i) => {
        if (i.id === "verify-01") throw new Error("chrome wedged");
        return { success: true, credential: "k" };
      },
      markSpent: () => undefined,
    });
    // "chrome wedged" matches the non-observation phrase set → dropped, not counted.
    const first = res.outcomes.find((o) => o.identityId === "verify-01");
    expect(first?.observation).toBe("non_observation");
  });

  it("returns insufficient_identities when the pool is fully spent", async () => {
    const usage = POOL.map((p) => ({ identityId: p.id, service: "sentry", at: "t" }));
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
    expect(res.available).toBe(0);
    expect(res.verdict).toBe("hold");
    expect(runSignup).not.toHaveBeenCalled();
  });

  it("does not use an identity that is already leased by another verifier task", async () => {
    expect(claimIdentity("verify-01")).toBe(true);
    try {
      const used: string[] = [];
      const res = await freshVerifyService({
        service: "sentry",
        provider: "google",
        identities: POOL,
        usage: [],
        runSignup: async (i) => {
          used.push(i.id);
          return { success: true, credential: `key-${i.id}` };
        },
        markSpent: () => undefined,
      });
      expect(res.kind).toBe("verified");
      expect(used).not.toContain("verify-01");
      expect(used[0]).toBe("verify-02");
    } finally {
      releaseIdentity("verify-01");
    }
  });

  it("custom confidence bounds are honored", async () => {
    // A lower floor lets a 1/1 promote (LCB of 1/1 ≈ 0.21 with z=1.96 still
    // wouldn't clear 0.6, but does clear a 0.1 floor).
    const res = await freshVerifyService({
      service: "x",
      provider: "google",
      confidence: { promoteFloor: 0.1, rejectCeiling: 0.05, maxSamples: 1 },
      identities: POOL,
      usage: [],
      runSignup: async () => ({ success: true, credential: "k" }),
      markSpent: () => undefined,
    });
    expect(res.verdict).toBe("promote");
    expect(res.samples).toBe(1);
  });
});

// ── failure-reason classifiers ───────────────────────────────────────────────

describe("isHardFailure", () => {
  it("treats deterministic walls as hard", () => {
    expect(isHardFailure("anti_bot_blocked: turnstile")).toBe(true);
    expect(isHardFailure("no_signup_link")).toBe(true);
    expect(isHardFailure("captcha_blocked")).toBe(true);
    expect(isHardFailure("oauth_required")).toBe(true);
  });
  it("flakes and genuine rot are NOT hard", () => {
    expect(isHardFailure("form drift mid-fill")).toBe(false);
    expect(isHardFailure("oauth_onboarding_failed: could not reach an API key")).toBe(false);
    expect(isHardFailure("verification_not_sent: email did not arrive")).toBe(false);
    expect(isHardFailure("needs_login: session gone")).toBe(false);
    expect(isHardFailure("step_failed: button gone")).toBe(false);
    expect(isHardFailure(undefined)).toBe(false);
  });
});

describe("isNonObservation", () => {
  it("variance-prone OAuth codes are non-observations (real promotions came from re-drawing)", () => {
    expect(isNonObservation("needs_login: profile signed out")).toBe(true);
    expect(isNonObservation("needs_oauth_provider_session: google profile stale")).toBe(true);
    expect(isNonObservation("oauth_loop_detected: redirect bounce")).toBe(true);
    expect(isNonObservation("oauth_session_not_persisted: callback never settled")).toBe(true);
    expect(isNonObservation("oauth_consent_needs_review: re-check")).toBe(true);
  });
  it("transient/timing/network are non-observations", () => {
    expect(isNonObservation("nav_timeout: 60s")).toBe(true);
    expect(isNonObservation("navigation timeout exceeded")).toBe(true);
    expect(isNonObservation("transient onboarding stall")).toBe(true);
  });
  it("genuine rot is NOT a non-observation (it must move the posterior)", () => {
    expect(isNonObservation("step_failed: button gone")).toBe(false);
    expect(isNonObservation("validator_failed: wrong key")).toBe(false);
    expect(isNonObservation(undefined)).toBe(false);
  });
});

describe("isNonRedrawableNonObservation", () => {
  it("treats an explicit provider-session capability gap as non-redrawable", () => {
    expect(
      isNonRedrawableNonObservation("needs_oauth_provider_session: google profile stale"),
    ).toBe(true);
  });

  it("does NOT mark needs_login non-redrawable — the sampler decides per-provider", () => {
    // needs_login is per-robot session-freshness variance, not a uniform gap
    // (MEASURED 2026-06-24). Same-provider → bounded redraw; cross-provider →
    // reroute/HOLD — both decided in the sampler, not this pure classifier.
    expect(
      isNonRedrawableNonObservation("needs_login: stored-skill replay provider=google step=1"),
    ).toBe(false);
    expect(
      isNonRedrawableNonObservation("needs_login: stored-skill replay provider=github step=0"),
    ).toBe(false);
  });

  it("keeps stale returning-user divergence redrawable by pool rotation", () => {
    expect(
      isNonRedrawableNonObservation(
        "step_failed: stored-skill replay step=3 [returning-user: authenticated session diverged from fresh-signup capture]",
      ),
    ).toBe(false);
    expect(isNonRedrawableNonObservation("nav_timeout: tunnel stall")).toBe(false);
  });
});

describe("nonObservationRequiredProvider", () => {
  it("extracts the provider required by a replay blocker", () => {
    expect(
      nonObservationRequiredProvider("needs_login: stored-skill replay provider=github step=0"),
    ).toBe("github");
    expect(nonObservationRequiredProvider("needs_oauth_provider_session: google profile stale")).toBe(
      "google",
    );
    expect(nonObservationRequiredProvider("nav_timeout: tunnel stall")).toBeUndefined();
  });
});
