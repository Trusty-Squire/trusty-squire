import { describe, expect, it, vi } from "vitest";
import { freshVerifyService, meetsAgreement } from "../fresh-verify.js";
import type { VerifyIdentity } from "../identity-pool.js";

const ID = (id: string): VerifyIdentity => ({
  id,
  email: `${id}@trustysquire.ai`,
  profileDir: `/p/${id}`,
  providers: ["google"],
});
const POOL = [ID("verify-01"), ID("verify-02"), ID("verify-03")];

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
});
