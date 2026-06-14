// Fix B + Fix D1 — per-run, single-account profile isolation on the discover
// path, plus the clean-state retry on the anti-bot tail. The bot + identity
// pool are mocked; no browser launches. We assert:
//   • OAuth candidate → bot.signup gets profileDir + oauthAccountEmail from a
//     picked verify-pool robot, and recordSpent fires.
//   • OAuth pool exhaustion → a clear insufficient_identities outcome (no blind
//     shared-profile fallback).
//   • email/password candidate → an EPHEMERAL profileDir, NO oauthAccountEmail,
//     and the dir is reaped after the run.
//   • D1: anti_bot_blocked / oauth_session_not_persisted triggers exactly ONE
//     clean-state retry with a ROTATED identity; rot/step_failed does NOT retry.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { runDiscover, type IdentityPoolPort } from "../discover.js";
import type { SignupResult, UniversalSignupRequest } from "../../../bot/index.js";
import type { InboxClient } from "../../../bot/inbox-client.js";
import type { VerifyIdentity } from "../../identity-pool.js";

let savedMachineToken: string | undefined;
beforeEach(() => {
  savedMachineToken = process.env.TRUSTY_SQUIRE_MACHINE_TOKEN;
  process.env.TRUSTY_SQUIRE_MACHINE_TOKEN = "discovery-test-machine-token";
});
afterEach(() => {
  if (savedMachineToken === undefined) delete process.env.TRUSTY_SQUIRE_MACHINE_TOKEN;
  else process.env.TRUSTY_SQUIRE_MACHINE_TOKEN = savedMachineToken;
});

function stubInbox(aliasReturn = "alias@trustysquire.com") {
  return { createAlias: async () => aliasReturn } as unknown as {
    createAlias: InboxClient["createAlias"];
  };
}

function identity(id: string): VerifyIdentity {
  return {
    id,
    email: `${id}@trustysquire.ai`,
    profileDir: `/tmp/profiles/${id}`,
    providers: ["google"],
  };
}

// A pool backed by an in-memory unspent list + a spent log. pick() returns the
// first `n` unspent, mirroring the real picker's deterministic order.
function fakePool(available: VerifyIdentity[]): {
  port: IdentityPoolPort;
  spent: Array<{ id: string; service: string }>;
} {
  const spent: Array<{ id: string; service: string }> = [];
  const port: IdentityPoolPort = {
    pick: (service, n) =>
      available
        .filter((i) => !spent.some((s) => s.id === i.id && s.service === service))
        .slice(0, n),
    markSpent: (id, service) => {
      if (!spent.some((s) => s.id === id && s.service === service)) {
        spent.push({ id, service });
      }
    },
  };
  return { port, spent };
}

// Records every bot.signup request so we can assert the profile binding.
function recordingBot(results: SignupResult[]) {
  const requests: UniversalSignupRequest[] = [];
  let call = 0;
  return {
    requests,
    bot: {
      signup: async (req: UniversalSignupRequest): Promise<SignupResult> => {
        requests.push(req);
        const r = results[Math.min(call, results.length - 1)];
        call += 1;
        return r!;
      },
    },
  };
}

const ok: SignupResult = {
  success: true,
  credentials: { api_key: "sk-test-isolation-credential" },
  steps: [],
  via: "bot",
};

describe("runDiscover — Fix B: OAuth profile isolation", () => {
  it("passes profileDir + oauthAccountEmail from a picked identity and records it spent", async () => {
    const { port, spent } = fakePool([identity("verify-01"), identity("verify-02")]);
    const { requests, bot } = recordingBot([ok]);

    const outcome = await runDiscover(
      { service: "sentry", oauthProvider: "google" },
      {
        machineToken: "tok",
        accountId: "acct",
        inboxClient: stubInbox(),
        bot,
        identityPool: port,
        skipAutoPromote: true,
      },
    );

    expect(outcome.kind).toBe("ok");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.profileDir).toBe("/tmp/profiles/verify-01");
    expect(requests[0]?.oauthAccountEmail).toBe("verify-01@trustysquire.ai");
    expect(spent).toEqual([{ id: "verify-01", service: "sentry" }]);
  });

  it("surfaces insufficient_identities when the pool is exhausted (no blind fallback)", async () => {
    const { port } = fakePool([]); // no unspent robots
    const { requests, bot } = recordingBot([ok]);

    const outcome = await runDiscover(
      { service: "sentry", oauthProvider: "google" },
      {
        machineToken: "tok",
        accountId: "acct",
        inboxClient: stubInbox(),
        bot,
        identityPool: port,
        skipAutoPromote: true,
      },
    );

    expect(outcome.kind).toBe("failed");
    expect((outcome as { reason: string }).reason).toMatch(/insufficient_identities/);
    // The bot was NEVER launched — we don't fall back to the shared profile.
    expect(requests).toHaveLength(0);
  });

  it("github OAuth keeps the shared-profile fallback (no identity, no ephemeral dir)", async () => {
    const { port, spent } = fakePool([identity("verify-01")]);
    const { requests, bot } = recordingBot([ok]);

    const outcome = await runDiscover(
      { service: "vercel", oauthProvider: "github" },
      {
        machineToken: "tok",
        accountId: "acct",
        inboxClient: stubInbox(),
        bot,
        identityPool: port,
        skipAutoPromote: true,
      },
    );

    expect(outcome.kind).toBe("ok");
    expect(requests[0]?.oauthAccountEmail).toBeUndefined();
    // github → ephemeral throwaway dir (clean state), not a pool robot.
    expect(requests[0]?.profileDir).toMatch(/profiles\/discover-vercel-/);
    expect(spent).toEqual([]); // no robot consumed
  });
});

describe("runDiscover — Fix B: email/password ephemeral profile", () => {
  it("uses an ephemeral profileDir, no oauthAccountEmail, and reaps the dir afterward", async () => {
    const { port } = fakePool([identity("verify-01")]);
    const { requests, bot } = recordingBot([ok]);

    const outcome = await runDiscover(
      { service: "ipinfo" }, // no oauthProvider → email/password path
      {
        machineToken: "tok",
        accountId: "acct",
        inboxClient: stubInbox(),
        bot,
        identityPool: port,
        skipAutoPromote: true,
      },
    );

    expect(outcome.kind).toBe("ok");
    expect(requests[0]?.oauthAccountEmail).toBeUndefined();
    const dir = requests[0]?.profileDir;
    expect(dir).toBeDefined();
    expect(dir).toMatch(/profiles\/discover-ipinfo-/);
    // Cleanup ran in the finally — the throwaway dir no longer exists.
    expect(existsSync(dir!)).toBe(false);
  });
});

describe("runDiscover — Fix D1: clean-state retry on the anti-bot tail", () => {
  const antiBot: SignupResult = {
    success: false,
    error: "anti_bot_blocked: Cloudflare on SSO callback",
    steps: [],
  };
  const oauthDrop: SignupResult = {
    success: false,
    error: "oauth_session_not_persisted: page bounced back to login",
    steps: [],
  };
  const rot: SignupResult = {
    success: false,
    error: "step_failed: selector no longer matches",
    steps: [],
  };

  it("retries ONCE with a rotated identity on anti_bot_blocked, then succeeds", async () => {
    const { port, spent } = fakePool([identity("verify-01"), identity("verify-02")]);
    const { requests, bot } = recordingBot([antiBot, ok]);

    const outcome = await runDiscover(
      { service: "turso", oauthProvider: "google" },
      {
        machineToken: "tok",
        accountId: "acct",
        inboxClient: stubInbox(),
        bot,
        identityPool: port,
        skipAutoPromote: true,
      },
    );

    expect(outcome.kind).toBe("ok");
    // Exactly two attempts — first + one retry.
    expect(requests).toHaveLength(2);
    // Rotated to a DIFFERENT robot on the retry.
    expect(requests[0]?.oauthAccountEmail).toBe("verify-01@trustysquire.ai");
    expect(requests[1]?.oauthAccountEmail).toBe("verify-02@trustysquire.ai");
    // Both consumed robots recorded spent.
    expect(spent).toEqual([
      { id: "verify-01", service: "turso" },
      { id: "verify-02", service: "turso" },
    ]);
  });

  it("retries on oauth_session_not_persisted and caps at ONE retry", async () => {
    const { port } = fakePool([identity("verify-01"), identity("verify-02"), identity("verify-03")]);
    // Both attempts bounce — the retry must NOT chain into a third attempt.
    const { requests, bot } = recordingBot([oauthDrop, oauthDrop]);

    const outcome = await runDiscover(
      { service: "predibase", oauthProvider: "google" },
      {
        machineToken: "tok",
        accountId: "acct",
        inboxClient: stubInbox(),
        bot,
        identityPool: port,
        skipAutoPromote: true,
      },
    );

    // oauth_session_not_persisted is a known transient → failed (not blocked).
    expect(outcome.kind).toBe("failed");
    expect(requests).toHaveLength(2); // one retry only
  });

  it("does NOT retry a deterministic rot/step_failed result", async () => {
    const { port } = fakePool([identity("verify-01"), identity("verify-02")]);
    const { requests, bot } = recordingBot([rot, ok]);

    const outcome = await runDiscover(
      { service: "svc", oauthProvider: "google" },
      {
        machineToken: "tok",
        accountId: "acct",
        inboxClient: stubInbox(),
        bot,
        identityPool: port,
        skipAutoPromote: true,
      },
    );

    expect(outcome.kind).toBe("failed");
    expect(requests).toHaveLength(1); // no retry
  });

  it("D1 retry reaps BOTH ephemeral dirs for email/password services", async () => {
    const { port } = fakePool([]);
    const { requests, bot } = recordingBot([antiBot, ok]);

    const outcome = await runDiscover(
      { service: "ipinfo" }, // email/password → ephemeral dirs
      {
        machineToken: "tok",
        accountId: "acct",
        inboxClient: stubInbox(),
        bot,
        identityPool: port,
        skipAutoPromote: true,
      },
    );

    expect(outcome.kind).toBe("ok");
    expect(requests).toHaveLength(2);
    // Two distinct ephemeral dirs, both gone after the run.
    const dir1 = requests[0]?.profileDir;
    const dir2 = requests[1]?.profileDir;
    expect(dir1).toBeDefined();
    expect(dir2).toBeDefined();
    expect(dir1).not.toBe(dir2);
    expect(existsSync(dir1!)).toBe(false);
    expect(existsSync(dir2!)).toBe(false);
  });
});
