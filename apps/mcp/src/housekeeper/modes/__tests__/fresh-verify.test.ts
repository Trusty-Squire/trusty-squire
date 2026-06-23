import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Skill } from "@trusty-squire/skill-schema";
import { SKILL_SCHEMA_VERSION } from "@trusty-squire/skill-schema";
import type { VerifyIdentity, UsageRecord } from "../../identity-pool.js";
import { runFreshVerify } from "../fresh-verify.js";

const originalPoolDir = process.env.TRUSTY_SQUIRE_VERIFY_POOL_DIR;

afterEach(() => {
  if (originalPoolDir === undefined) {
    delete process.env.TRUSTY_SQUIRE_VERIFY_POOL_DIR;
  } else {
    process.env.TRUSTY_SQUIRE_VERIFY_POOL_DIR = originalPoolDir;
  }
});

function identity(id: string): VerifyIdentity {
  return {
    id,
    email: `${id}@trustysquire.ai`,
    profileDir: `/tmp/${id}`,
    providers: ["google"],
  };
}

function skill(): Skill {
  return {
    schema_version: SKILL_SCHEMA_VERSION,
    service: "arize",
    version: "v1",
    skill_id: "01FRESHVERIFYREPLAYONLY000001",
    signup_url: "https://app.arize.com/auth/join",
    oauth_provider: "google",
    steps: [
      {
        kind: "navigate",
        url: "https://app.arize.com/auth/join",
        provenance: { run_id: "r1", round_index: 0 },
      },
      {
        kind: "extract_via_copy_button",
        near_text_hint: "Copy",
        provenance: { run_id: "r1", round_index: 1 },
      },
    ],
    credentials: [
      {
        type: "api_key",
        shape_hint: "opaque",
        env_var_suggestion: "ARIZE_API_KEY",
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

describe("runFreshVerify", () => {
  it("returning-profile mode replays with the shared profile and never posts a fresh verifier outcome", async () => {
    const storedSkill = skill();
    const replay = vi.fn(async () => ({
      kind: "ok" as const,
      via: "copy_button" as const,
      credential: "k".repeat(32),
    }));
    const postOutcome = vi.fn();

    const result = await runFreshVerify(
      {
        service: "arize",
        skill: storedSkill,
        skillId: storedSkill.skill_id,
        profileMode: "returning",
      },
      {
        replay,
        registry: { postOutcome },
        poolConfigured: () => false,
        log: () => undefined,
      },
    );

    expect(replay).toHaveBeenCalledOnce();
    expect(replay).toHaveBeenCalledWith(
      expect.objectContaining({
        skill: storedSkill,
        identity: expect.objectContaining({
          id: "returning-profile",
          email: "returning-profile@local",
          providers: ["google"],
        }),
        emailAlias: expect.stringMatching(/^returning\./),
        preferredOAuthProvider: "google",
      }),
    );
    expect(postOutcome).not.toHaveBeenCalled();
    expect(result.kind).toBe("returning_verified");
    if (result.kind !== "returning_verified") throw new Error("expected returning_verified");
    expect(result.success).toBe(true);
  });

  it("returning-profile mode refuses show-once credentials instead of false-green replaying old state", async () => {
    const storedSkill = skill();
    storedSkill.credentials[0] = {
      ...storedSkill.credentials[0]!,
      visibility: "show_once_at_creation",
    };
    const replay = vi.fn(async () => ({
      kind: "ok" as const,
      via: "copy_button" as const,
      credential: "k".repeat(32),
    }));
    const postOutcome = vi.fn();

    const result = await runFreshVerify(
      {
        service: "arize",
        skill: storedSkill,
        skillId: storedSkill.skill_id,
        profileMode: "returning",
      },
      {
        replay,
        registry: { postOutcome },
        poolConfigured: () => false,
        log: () => undefined,
      },
    );

    expect(replay).not.toHaveBeenCalled();
    expect(postOutcome).not.toHaveBeenCalled();
    expect(result.kind).toBe("returning_verified");
    if (result.kind !== "returning_verified") throw new Error("expected returning_verified");
    expect(result.success).toBe(false);
    expect(result.reason).toContain("show_once_renewal_required");
    expect(result.reason).toContain("ARIZE_API_KEY");
  });

  it("returning-profile mode allows show-once credentials when the stored skill creates a fresh key", async () => {
    const storedSkill = skill();
    storedSkill.credentials[0] = {
      ...storedSkill.credentials[0]!,
      visibility: "show_once_at_creation",
    };
    storedSkill.steps.splice(1, 0, {
      kind: "click",
      text_match: "Create API Key",
      role_hint: "button",
      provenance: { run_id: "r1", round_index: 1 },
    });
    const replay = vi.fn(async () => ({
      kind: "ok" as const,
      via: "regex" as const,
      credential: "k".repeat(32),
    }));

    const result = await runFreshVerify(
      {
        service: "arize",
        skill: storedSkill,
        skillId: storedSkill.skill_id,
        profileMode: "returning",
      },
      {
        replay,
        poolConfigured: () => false,
        log: () => undefined,
      },
    );

    expect(replay).toHaveBeenCalledOnce();
    expect(result.kind).toBe("returning_verified");
    if (result.kind !== "returning_verified") throw new Error("expected returning_verified");
    expect(result.success).toBe(true);
  });

  it("returning-profile mode passes an explicit provider preference into replay", async () => {
    const storedSkill = { ...skill(), oauth_provider: null };
    const replay = vi.fn(async () => ({
      kind: "needs_login" as const,
      provider: "github" as const,
      stepIndex: 0,
    }));

    await runFreshVerify(
      {
        service: "arize",
        skill: storedSkill,
        oauthProvider: "github",
        profileMode: "returning",
      },
      {
        replay,
        poolConfigured: () => false,
        log: () => undefined,
      },
    );

    expect(replay).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: expect.objectContaining({ providers: ["github"] }),
        preferredOAuthProvider: "github",
      }),
    );
  });

  it("returning-profile mode surfaces replay failure without requiring the robot pool", async () => {
    const replay = vi.fn(async () => ({
      kind: "extraction_failed" as const,
      stepIndex: 1,
      reason: "No Copy button on page",
    }));

    const result = await runFreshVerify(
      {
        service: "arize",
        skill: skill(),
        profileMode: "returning",
      },
      {
        replay,
        poolConfigured: () => false,
        log: () => undefined,
      },
    );

    expect(replay).toHaveBeenCalledOnce();
    expect(result.kind).toBe("returning_verified");
    if (result.kind !== "returning_verified") throw new Error("expected returning_verified");
    expect(result.success).toBe(false);
    expect(result.reason).toContain("extraction_failed");
  });

  it("replays the stored skill after replenish instead of invoking planner signup", async () => {
    process.env.TRUSTY_SQUIRE_VERIFY_POOL_DIR = mkdtempSync(
      join(tmpdir(), "fresh-verify-mode-"),
    );
    const fresh = identity(`verify-${Date.now().toString(36)}`);
    const spentPool: {
      identities: VerifyIdentity[];
      usage: UsageRecord[];
    } = {
      identities: [fresh],
      usage: [{ identityId: fresh.id, service: "arize", at: "t" }],
    };
    const freshPool: {
      identities: VerifyIdentity[];
      usage: UsageRecord[];
    } = { identities: [fresh], usage: [] };
    const loadPool = vi
      .fn<() => { identities: VerifyIdentity[]; usage: UsageRecord[] }>()
      .mockReturnValueOnce(spentPool)
      .mockReturnValueOnce(freshPool);
    const replenish = vi.fn(async () => " · pool +1 fresh");
    const logs: string[] = [];
    const replay = vi.fn(async () => ({
      kind: "ok" as const,
      via: "regex" as const,
      credential: "k".repeat(32),
    }));
    const storedSkill = skill();

    const result = await runFreshVerify(
      {
        service: "arize",
        skill: storedSkill,
        confidence: { promoteFloor: 0.1, rejectCeiling: 0.05, maxSamples: 1 },
      },
      {
        machineToken: "machine-token",
        accountId: "acct-1",
        replay,
        inboxClient: { createAlias: vi.fn(async () => "verify@example.com") },
        poolConfigured: () => true,
        loadPool,
        replenish,
        log: (line) => logs.push(line),
      },
    );

    expect(replenish).toHaveBeenCalledOnce();
    expect(loadPool).toHaveBeenCalledTimes(2);
    expect(replay, JSON.stringify({ result, logs }, null, 2)).toHaveBeenCalledOnce();
    expect(replay).toHaveBeenCalledWith({
      skill: storedSkill,
      identity: fresh,
      emailAlias: "verify@example.com",
      preferredOAuthProvider: "google",
      fetchEmailCode: expect.any(Function),
    });
    expect(result.kind).toBe("verified");
    if (result.kind !== "verified") throw new Error("expected verified");
    expect(result.successes).toBe(1);
  });

  it("fetches the stored skill by id when the caller only supplies skillId", async () => {
    process.env.TRUSTY_SQUIRE_VERIFY_POOL_DIR = mkdtempSync(
      join(tmpdir(), "fresh-verify-mode-"),
    );
    const fresh = identity(`verify-${Date.now().toString(36)}`);
    const storedSkill = skill();
    const fetchSkill = vi.fn(async () => storedSkill);
    const replay = vi.fn(async () => ({
      kind: "ok" as const,
      via: "copy_button" as const,
      credential: "k".repeat(32),
    }));

    const result = await runFreshVerify(
      {
        service: "arize",
        skillId: storedSkill.skill_id,
        confidence: { promoteFloor: 0.1, rejectCeiling: 0.05, maxSamples: 1 },
      },
      {
        machineToken: "machine-token",
        accountId: "acct-1",
        fetchSkill,
        replay,
        inboxClient: { createAlias: vi.fn(async () => "verify@example.com") },
        poolConfigured: () => true,
        loadPool: () => ({ identities: [fresh], usage: [] }),
        log: () => undefined,
      },
    );

    expect(fetchSkill).toHaveBeenCalledWith(storedSkill.skill_id);
    expect(replay).toHaveBeenCalledOnce();
    expect(result.kind).toBe("verified");
  });

  it("replenishes and retries once when all sampled robots produce non-observations", async () => {
    process.env.TRUSTY_SQUIRE_VERIFY_POOL_DIR = mkdtempSync(
      join(tmpdir(), "fresh-verify-mode-"),
    );
    const staleA = identity(`verify-${Date.now().toString(36)}a`);
    const staleB = identity(`verify-${Date.now().toString(36)}b`);
    const fresh = identity(`verify-${Date.now().toString(36)}c`);
    const loadPool = vi
      .fn<() => { identities: VerifyIdentity[]; usage: UsageRecord[] }>()
      .mockReturnValueOnce({ identities: [staleA, staleB], usage: [] })
      .mockReturnValueOnce({ identities: [fresh], usage: [] });
    const replenish = vi.fn(async () => " · pool rotated");
    const replay = vi
      .fn()
      .mockResolvedValueOnce({
        kind: "step_failed",
        stepIndex: 3,
        reason: "[returning-user: authenticated session diverged from fresh-signup capture]",
        capturedStep: {
          kind: "click",
          text_match: "Continue",
          provenance: { run_id: "r1", round_index: 3 },
        },
      })
      .mockResolvedValueOnce({
        kind: "step_failed",
        stepIndex: 3,
        reason: "[returning-user: authenticated session diverged from fresh-signup capture]",
        capturedStep: {
          kind: "click",
          text_match: "Continue",
          provenance: { run_id: "r1", round_index: 3 },
        },
      })
      .mockResolvedValueOnce({
        kind: "ok",
        via: "regex",
        credential: "k".repeat(32),
      });

    const result = await runFreshVerify(
      {
        service: "arize",
        skill: skill(),
        confidence: { promoteFloor: 0.1, rejectCeiling: 0.05, maxSamples: 1 },
      },
      {
        machineToken: "machine-token",
        accountId: "acct-1",
        replay,
        inboxClient: { createAlias: vi.fn(async () => "verify@example.com") },
        poolConfigured: () => true,
        loadPool,
        replenish,
        log: () => undefined,
      },
    );

    expect(replenish).toHaveBeenCalledOnce();
    expect(loadPool).toHaveBeenCalledTimes(2);
    expect(replay).toHaveBeenCalledTimes(3);
    expect(result.kind).toBe("verified");
    if (result.kind !== "verified") throw new Error("expected verified");
    expect(result.verdict).toBe("promote");
    expect(result.successes).toBe(1);
  });

  it("does not replenish when the hold is a provider/session capability blocker", async () => {
    process.env.TRUSTY_SQUIRE_VERIFY_POOL_DIR = mkdtempSync(
      join(tmpdir(), "fresh-verify-mode-"),
    );
    const fresh = identity(`verify-${Date.now().toString(36)}`);
    const loadPool = vi.fn<() => { identities: VerifyIdentity[]; usage: UsageRecord[] }>()
      .mockReturnValue({ identities: [fresh], usage: [] });
    const replenish = vi.fn(async () => " · pool rotated");
    const replay = vi.fn(async () => ({
      kind: "needs_login" as const,
      provider: "github" as const,
      stepIndex: 0,
    }));

    const result = await runFreshVerify(
      {
        service: "arize",
        skill: skill(),
        confidence: { promoteFloor: 0.1, rejectCeiling: 0.05, maxSamples: 4 },
      },
      {
        machineToken: "machine-token",
        accountId: "acct-1",
        replay,
        inboxClient: { createAlias: vi.fn(async () => "verify@example.com") },
        poolConfigured: () => true,
        loadPool,
        replenish,
        log: () => undefined,
      },
    );

    expect(replenish).not.toHaveBeenCalled();
    expect(loadPool).toHaveBeenCalledOnce();
    expect(replay).toHaveBeenCalledOnce();
    expect(result.kind).toBe("verified");
    if (result.kind !== "verified") throw new Error("expected verified");
    expect(result.verdict).toBe("hold");
    expect(result.samples).toBe(0);
  });

  it("reports stored replay failures with the underlying failure kind", async () => {
    process.env.TRUSTY_SQUIRE_VERIFY_POOL_DIR = mkdtempSync(
      join(tmpdir(), "fresh-verify-mode-"),
    );
    const fresh = identity(`verify-${Date.now().toString(36)}`);
    const storedSkill = skill();
    const replay = vi.fn(async () => ({
      kind: "step_failed" as const,
      stepIndex: 4,
      reason: "target is disabled",
      capturedStep: {
        kind: "click" as const,
        text_match: "Create account",
        provenance: { run_id: "r1", round_index: 4 },
      },
    }));
    const postOutcome = vi.fn(async () => ({
      transition: "none" as const,
      status: "pending-review" as const,
      verifier_succeeded: 0,
      verifier_failed: 1,
      consecutive_verifier_failures: 1,
      next_freshness_due_at: null,
    }));

    const result = await runFreshVerify(
      {
        service: "arize",
        skill: storedSkill,
        skillId: storedSkill.skill_id,
        confidence: { promoteFloor: 0.1, rejectCeiling: 0.05, maxSamples: 1 },
      },
      {
        machineToken: "machine-token",
        accountId: "acct-1",
        replay,
        inboxClient: { createAlias: vi.fn(async () => "verify@example.com") },
        poolConfigured: () => true,
        loadPool: () => ({ identities: [fresh], usage: [] }),
        registry: { postOutcome },
        log: () => undefined,
      },
    );

    expect(result.kind).toBe("verified");
    if (result.kind !== "verified") throw new Error("expected verified");
    expect(result.verdict).toBe("reject");
    expect(postOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        skill_id: storedSkill.skill_id,
        kind: "failure",
        verdict: "reject",
        samples: 1,
        successes: 0,
        failures: 1,
        failure_kind: "step_failed",
      }),
    );
  });
});
