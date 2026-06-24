// D2.D — handleReplay routes an OAuth-based skill through the fresh-identity
// confidence sampler when one is wired, and falls back to single-account replay
// otherwise. The fresh path reports its own verdict to the registry and hands
// back the transition, which the batch summary surfaces.

import { describe, expect, it, vi } from "vitest";
import type { Skill } from "@trusty-squire/skill-schema";
import { SKILL_SCHEMA_VERSION } from "@trusty-squire/skill-schema";
import { handleReplay, type FreshVerifyRunner, type SignupProbeRunner } from "../verify.js";
import type { HousekeeperOpts } from "../../orchestrator.js";
import type { HousekeeperTask } from "../../queues/index.js";
import type { ReplayOutcome } from "../../../bot/replay-skill.js";
import type { RunFreshVerifyResult } from "../fresh-verify.js";

function oauthSkill(provider: "google" | "github" | null): Skill {
  return {
    schema_version: SKILL_SCHEMA_VERSION,
    service: "fresh-svc",
    version: "v1",
    skill_id: "01ROUTE000000000000000001",
    signup_url: "https://fresh.example/signup",
    oauth_provider: provider,
    steps: [
      { kind: "navigate", url: "https://fresh.example/signup", provenance: { run_id: "r1", round_index: 0 } },
      { kind: "extract_via_copy_button", near_text_hint: "Copy", provenance: { run_id: "r1", round_index: 1 } },
    ],
    credentials: [
      {
        type: "api_key",
        shape_hint: "opaque",
        env_var_suggestion: "FRESH_API_KEY",
        post_extract_validator: { min_length: 16, max_length: 256 },
      },
    ],
    source_run_ids: ["r1"],
    status: "pending-review",
    replays_succeeded: 0,
    replays_failed: 0,
    consecutive_failures: 0,
    created_at: "2026-06-02T04:00:00.000Z",
    last_replayed_at: null,
    superseded_at: null,
    deleted_at: null,
  };
}

const TASK: Extract<HousekeeperTask, { kind: "replay" }> = {
  kind: "replay",
  queueItem: {
    skill_id: "01ROUTE000000000000000001",
    service: "fresh-svc",
    version: "v1",
    status: "pending-review",
    verifier_succeeded: 0,
    verifier_failed: 0,
    consecutive_verifier_failures: 0,
    last_verified_at: null,
    next_freshness_due_at: null,
  },
};

function baseOpts(over: Partial<HousekeeperOpts> = {}): HousekeeperOpts {
  const skill = oauthSkill("google");
  const client = {
    fetchSkill: vi.fn(async () => skill),
    postOutcome: vi.fn(async () => ({
      transition: "none" as const,
      status: "pending-review",
      verifier_succeeded: 0,
      verifier_failed: 0,
      consecutive_verifier_failures: 0,
      next_freshness_due_at: null,
    })),
  } as unknown as HousekeeperOpts["client"];
  // Single-account replay that always succeeds — so we can detect when the fresh
  // path was taken INSTEAD (its reason string is distinctive).
  const replay = vi.fn(
    async (): Promise<ReplayOutcome> => ({ kind: "ok", via: "copy_button", credential: "k".repeat(20) }),
  );
  return {
    queue: { name: "verifier", fetch: async () => [] },
    client,
    replay,
    ...over,
  };
}

const noLog = () => undefined;

describe("D2.D handleReplay → fresh-verify routing", () => {
  it("routes an OAuth skill through the fresh-verify sampler when wired", async () => {
    const freshVerify: FreshVerifyRunner = vi.fn(
      async (): Promise<RunFreshVerifyResult> => ({
        kind: "verified",
        service: "fresh-svc",
        verdict: "promote",
        promoted: true,
        successes: 2,
        failures: 0,
        samples: 2,
        passRateLcb: 0.34,
        passRateUcb: 1,
        outcomes: [],
        transition: "promoted",
      }),
    );
    const opts = baseOpts({ freshVerify });
    const res = await handleReplay(TASK, opts, noLog);
    expect(freshVerify).toHaveBeenCalledOnce();
    // Single-account replay must NOT have run.
    expect(opts.replay).not.toHaveBeenCalled();
    expect(res).not.toBe("skipped");
    if (res === "skipped") throw new Error("unreachable");
    expect(res.outcome).toBe("success");
    expect(res.transition).toBe("promoted");
    expect(res.reason).toContain("fresh-verify promote");
  });

  it("a fresh-verify HOLD surfaces as a skipped task (no pass/fail)", async () => {
    const freshVerify: FreshVerifyRunner = vi.fn(
      async (): Promise<RunFreshVerifyResult> => ({
        kind: "verified",
        service: "fresh-svc",
        verdict: "hold",
        promoted: false,
        successes: 1,
        failures: 1,
        samples: 2,
        passRateLcb: 0.1,
        passRateUcb: 0.9,
        outcomes: [],
      }),
    );
    const res = await handleReplay(TASK, baseOpts({ freshVerify }), noLog);
    expect(res).toBe("skipped");
  });

  it("a fresh-verify REJECT surfaces as a failure with the reported transition", async () => {
    const freshVerify: FreshVerifyRunner = vi.fn(
      async (): Promise<RunFreshVerifyResult> => ({
        kind: "verified",
        service: "fresh-svc",
        verdict: "reject",
        promoted: false,
        successes: 0,
        failures: 1,
        samples: 1,
        passRateLcb: 0,
        passRateUcb: 0.79,
        failureKind: "anti_bot_blocked",
        outcomes: [],
        transition: "quarantined",
      }),
    );
    const res = await handleReplay(TASK, baseOpts({ freshVerify }), noLog);
    if (res === "skipped") throw new Error("unreachable");
    expect(res.outcome).toBe("failure");
    expect(res.transition).toBe("quarantined");
  });

  it("falls back to single-account replay when fresh pool is not configured", async () => {
    const freshVerify: FreshVerifyRunner = vi.fn(
      async (): Promise<RunFreshVerifyResult> => ({ kind: "not_configured", service: "fresh-svc" }),
    );
    const opts = baseOpts({ freshVerify });
    const res = await handleReplay(TASK, opts, noLog);
    // Fresh path consulted, returned not_configured → single-account replay ran.
    expect(freshVerify).toHaveBeenCalledOnce();
    expect(opts.replay).toHaveBeenCalledOnce();
    if (res === "skipped") throw new Error("unreachable");
    expect(res.outcome).toBe("success");
    expect(res.reason).not.toContain("fresh-verify");
  });

  it("skips instead of falling back to shared-profile replay when the fresh pool is exhausted", async () => {
    const freshVerify: FreshVerifyRunner = vi.fn(
      async (): Promise<RunFreshVerifyResult> => ({
        kind: "insufficient_identities",
        service: "fresh-svc",
        verdict: "hold",
        promoted: false,
        successes: 0,
        failures: 0,
        samples: 0,
        passRateLcb: 0,
        passRateUcb: 1,
        available: 0,
        outcomes: [],
      }),
    );
    const opts = baseOpts({ freshVerify });
    const res = await handleReplay(TASK, opts, noLog);
    expect(freshVerify).toHaveBeenCalledOnce();
    expect(opts.replay).not.toHaveBeenCalled();
    expect(res).toBe("skipped");
  });

  it("routes legacy skills through fresh-verify when oauth_provider is null but the graph has click_oauth_button", async () => {
    const skill: Skill = {
      ...oauthSkill(null),
      steps: [
        {
          kind: "click_oauth_button",
          provider: "google",
          text_match: "Continue with Google",
          provenance: { run_id: "r1", round_index: 0 },
        },
        {
          kind: "extract_via_copy_button",
          near_text_hint: "Copy",
          provenance: { run_id: "r1", round_index: 1 },
        },
      ],
    };
    const client = {
      fetchSkill: vi.fn(async () => skill),
      postOutcome: vi.fn(async () => ({
        transition: "none" as const,
        status: "pending-review",
        verifier_succeeded: 0,
        verifier_failed: 0,
        consecutive_verifier_failures: 0,
        next_freshness_due_at: null,
      })),
    } as unknown as HousekeeperOpts["client"];
    const freshVerify: FreshVerifyRunner = vi.fn(
      async (): Promise<RunFreshVerifyResult> => ({
        kind: "verified",
        service: "fresh-svc",
        verdict: "promote",
        promoted: true,
        successes: 2,
        failures: 0,
        samples: 2,
        passRateLcb: 0.34,
        passRateUcb: 1,
        outcomes: [],
        transition: "promoted",
      }),
    );
    const replay = vi.fn(
      async (): Promise<ReplayOutcome> => ({ kind: "ok", via: "copy_button", credential: "k".repeat(20) }),
    );
    const res = await handleReplay(
      TASK,
      {
        queue: { name: "verifier", fetch: async () => [] },
        client,
        replay,
        freshVerify,
      },
      noLog,
    );
    expect(freshVerify).toHaveBeenCalledWith({
      service: "fresh-svc",
      skillId: TASK.queueItem.skill_id,
      skill,
      signupUrl: skill.signup_url,
      oauthProvider: "google",
    });
    expect(replay).not.toHaveBeenCalled();
    if (res === "skipped") throw new Error("unreachable");
    expect(res.outcome).toBe("success");
  });

  it("reroutes through fresh-verify when stale replay discovers needs_login", async () => {
    const freshVerify: FreshVerifyRunner = vi.fn(
      async (): Promise<RunFreshVerifyResult> => ({
        kind: "verified",
        service: "fresh-svc",
        verdict: "promote",
        promoted: true,
        successes: 2,
        failures: 0,
        samples: 2,
        passRateLcb: 0.34,
        passRateUcb: 1,
        outcomes: [],
        transition: "promoted",
      }),
    );
    const replay = vi.fn(
      async (): Promise<ReplayOutcome> => ({
        kind: "needs_login",
        provider: "google",
        stepIndex: 0, afterOAuth: false,
      }),
    );
    const skill = oauthSkill(null);
    const client = {
      fetchSkill: vi.fn(async () => skill),
      postOutcome: vi.fn(async () => ({
        transition: "none" as const,
        status: "pending-review",
        verifier_succeeded: 0,
        verifier_failed: 0,
        consecutive_verifier_failures: 0,
        next_freshness_due_at: null,
      })),
    } as unknown as HousekeeperOpts["client"];
    const opts: HousekeeperOpts = {
      queue: { name: "verifier", fetch: async () => [] },
      client,
      replay,
      freshVerify,
    };
    const res = await handleReplay(TASK, opts, noLog);
    expect(replay).toHaveBeenCalledOnce();
    expect(freshVerify).toHaveBeenCalledWith({
      service: "fresh-svc",
      skillId: TASK.queueItem.skill_id,
      skill,
      signupUrl: "https://fresh.example/signup",
      oauthProvider: "google",
    });
    if (res === "skipped") throw new Error("unreachable");
    expect(res.outcome).toBe("success");
    expect(res.transition).toBe("promoted");
  });

  it("reroutes returning-user replay divergence through fresh-verify", async () => {
    const freshVerify: FreshVerifyRunner = vi.fn(
      async (): Promise<RunFreshVerifyResult> => ({
        kind: "verified",
        service: "fresh-svc",
        verdict: "promote",
        promoted: true,
        successes: 2,
        failures: 0,
        samples: 2,
        passRateLcb: 0.34,
        passRateUcb: 1,
        outcomes: [],
        transition: "promoted",
      }),
    );
    const replay = vi.fn(
      async (): Promise<ReplayOutcome> => ({
        kind: "step_failed",
        stepIndex: 18,
        reason:
          'No element matches text_match="Save". [returning-user: authenticated session diverged from fresh-signup capture (onboarding/nav element absent — not rot)]',
        capturedStep: {
          kind: "click",
          text_match: "Save",
          provenance: { run_id: "r1", round_index: 18 },
        },
      }),
    );
    const skill = oauthSkill(null);
    const client = {
      fetchSkill: vi.fn(async () => skill),
      postOutcome: vi.fn(async () => ({
        transition: "none" as const,
        status: "pending-review",
        verifier_succeeded: 0,
        verifier_failed: 0,
        consecutive_verifier_failures: 0,
        next_freshness_due_at: null,
      })),
    } as unknown as HousekeeperOpts["client"];
    const res = await handleReplay(
      TASK,
      {
        queue: { name: "verifier", fetch: async () => [] },
        client,
        replay,
        freshVerify,
      },
      noLog,
    );
    expect(replay).toHaveBeenCalledOnce();
    expect(freshVerify).toHaveBeenCalledWith({
      service: "fresh-svc",
      skillId: TASK.queueItem.skill_id,
      skill,
      signupUrl: "https://fresh.example/signup",
      oauthProvider: "google",
    });
    if (res === "skipped") throw new Error("unreachable");
    expect(res.outcome).toBe("success");
    expect(res.transition).toBe("promoted");
  });

  it("reroutes pending-review disabled-precondition replay brittleness through fresh-verify", async () => {
    const freshVerify: FreshVerifyRunner = vi.fn(
      async (): Promise<RunFreshVerifyResult> => ({
        kind: "verified",
        service: "fresh-svc",
        verdict: "promote",
        promoted: true,
        successes: 1,
        failures: 0,
        samples: 1,
        passRateLcb: 0.21,
        passRateUcb: 1,
        outcomes: [],
        transition: "promoted",
      }),
    );
    const replay = vi.fn(
      async (): Promise<ReplayOutcome> => ({
        kind: "step_failed",
        stepIndex: 5,
        reason:
          "target is disabled (HTML disabled or aria-disabled=true) after 6s — the click would no-op. A required precondition is unmet.",
        capturedStep: {
          kind: "click",
          text_match: "Create API key",
          provenance: { run_id: "r1", round_index: 5 },
        },
      }),
    );
    const skill = oauthSkill(null);
    const client = {
      fetchSkill: vi.fn(async () => skill),
      postOutcome: vi.fn(async () => ({
        transition: "none" as const,
        status: "pending-review",
        verifier_succeeded: 0,
        verifier_failed: 0,
        consecutive_verifier_failures: 0,
        next_freshness_due_at: null,
      })),
    } as unknown as HousekeeperOpts["client"];
    const res = await handleReplay(
      TASK,
      {
        queue: { name: "verifier", fetch: async () => [] },
        client,
        replay,
        freshVerify,
      },
      noLog,
    );
    expect(replay).toHaveBeenCalledOnce();
    expect(freshVerify).toHaveBeenCalledWith({
      service: "fresh-svc",
      skillId: TASK.queueItem.skill_id,
      skill,
      signupUrl: "https://fresh.example/signup",
      oauthProvider: "google",
    });
    if (res === "skipped") throw new Error("unreachable");
    expect(res.outcome).toBe("success");
    expect(res.transition).toBe("promoted");
  });

  it("reroutes pending-review stale selector replay through fresh-verify when the live probe sees OAuth", async () => {
    const freshVerify: FreshVerifyRunner = vi.fn(
      async (): Promise<RunFreshVerifyResult> => ({
        kind: "verified",
        service: "fresh-svc",
        verdict: "promote",
        promoted: true,
        successes: 1,
        failures: 0,
        samples: 1,
        passRateLcb: 0.21,
        passRateUcb: 1,
        outcomes: [],
        transition: "promoted",
      }),
    );
    const replay = vi.fn(
      async (): Promise<ReplayOutcome> => ({
        kind: "step_failed",
        stepIndex: 8,
        reason: 'No element matches text_match="Create"',
        capturedStep: {
          kind: "click",
          text_match: "Create",
          provenance: { run_id: "r1", round_index: 8 },
        },
      }),
    );
    const skill = oauthSkill(null);
    const client = {
      fetchSkill: vi.fn(async () => skill),
      postOutcome: vi.fn(async () => ({
        transition: "none" as const,
        status: "pending-review",
        verifier_succeeded: 0,
        verifier_failed: 0,
        consecutive_verifier_failures: 0,
        next_freshness_due_at: null,
      })),
    } as unknown as HousekeeperOpts["client"];
    const probe = vi.fn<SignupProbeRunner>(async () => ({
      providers: ["google"],
      has_email_signup: false,
      has_email_field: false,
      card_gate: false,
      interstitial: false,
      final_url: "https://fresh.example/signup",
      inventory_size: 3,
    }));
    const res = await handleReplay(
      TASK,
      {
        queue: { name: "verifier", fetch: async () => [] },
        client,
        replay,
        probe,
        freshVerify,
      },
      noLog,
    );
    expect(replay).toHaveBeenCalledOnce();
    expect(probe).toHaveBeenCalledOnce();
    expect(freshVerify).toHaveBeenCalledWith({
      service: "fresh-svc",
      skillId: TASK.queueItem.skill_id,
      skill,
      signupUrl: "https://fresh.example/signup",
      oauthProvider: "google",
    });
    expect(client.postOutcome).not.toHaveBeenCalled();
    if (res === "skipped") throw new Error("unreachable");
    expect(res.outcome).toBe("success");
    expect(res.transition).toBe("promoted");
  });

  it("does NOT route an email-only (oauth_provider=null) skill through fresh-verify", async () => {
    const skill = oauthSkill(null);
    const client = {
      fetchSkill: vi.fn(async () => skill),
      postOutcome: vi.fn(async () => ({
        transition: "none" as const,
        status: "pending-review",
        verifier_succeeded: 0,
        verifier_failed: 0,
        consecutive_verifier_failures: 0,
        next_freshness_due_at: null,
      })),
    } as unknown as HousekeeperOpts["client"];
    const freshVerify: FreshVerifyRunner = vi.fn();
    const replay = vi.fn(
      async (): Promise<ReplayOutcome> => ({ kind: "ok", via: "copy_button", credential: "k".repeat(20) }),
    );
    const opts: HousekeeperOpts = {
      queue: { name: "verifier", fetch: async () => [] },
      client,
      replay,
      freshVerify,
    };
    await handleReplay(TASK, opts, noLog);
    expect(freshVerify).not.toHaveBeenCalled();
    expect(replay).toHaveBeenCalledOnce();
  });
});
