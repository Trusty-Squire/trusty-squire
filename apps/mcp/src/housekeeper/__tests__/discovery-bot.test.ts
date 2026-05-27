// runDiscoveryBot — tests cover env validation, alias creation,
// bot result mapping, and the auto-promote toggle. The actual
// universal bot (UniversalSignupBot.signup) is mocked because it
// drives Playwright + the LLM proxy.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDiscoveryBot } from "../discovery-bot.js";
import type { SignupResult } from "../../bot/types.js";
import type { InboxClient } from "../../bot/inbox-client.js";

// pickLLMPair reads TRUSTY_SQUIRE_MACHINE_TOKEN from env to route to
// the ProxyLLMClient. The tests don't care which LLM is chosen (the
// bot is stubbed) — they just need pickLLMPair to NOT throw on a
// missing backend. A throwaway token routes it cleanly.
let savedMachineToken: string | undefined;
beforeEach(() => {
  savedMachineToken = process.env.TRUSTY_SQUIRE_MACHINE_TOKEN;
  process.env.TRUSTY_SQUIRE_MACHINE_TOKEN = "discovery-test-machine-token";
});
afterEach(() => {
  if (savedMachineToken === undefined) {
    delete process.env.TRUSTY_SQUIRE_MACHINE_TOKEN;
  } else {
    process.env.TRUSTY_SQUIRE_MACHINE_TOKEN = savedMachineToken;
  }
});

function stubInbox(aliasReturn: string = "alias@trustysquire.com") {
  return {
    createAlias: async () => aliasReturn,
  } as unknown as { createAlias: InboxClient["createAlias"] };
}

function stubBot(result: SignupResult) {
  return {
    signup: async (): Promise<SignupResult> => result,
  };
}

describe("runDiscoveryBot — env validation", () => {
  it("returns failed when machine token is missing", async () => {
    const result = await runDiscoveryBot(
      { service: "test" },
      {
        machineToken: "",
        accountId: "acct-1",
      },
    );
    expect(result.kind).toBe("failed");
    expect((result as { reason: string }).reason).toMatch(/TRUSTY_SQUIRE_MACHINE_TOKEN/);
  });

  it("returns failed when account id is missing", async () => {
    const result = await runDiscoveryBot(
      { service: "test" },
      {
        machineToken: "tok-1",
        accountId: "",
      },
    );
    expect(result.kind).toBe("failed");
    expect((result as { reason: string }).reason).toMatch(/TRUSTY_SQUIRE_ACCOUNT_ID/);
  });
});

describe("runDiscoveryBot — outcome mapping", () => {
  it("returns ok when the bot succeeds with credentials", async () => {
    const bot = stubBot({
      success: true,
      credentials: { api_key: "sk-test-discovery-credential-abc" },
      steps: ["did the thing"],
      via: "bot",
    } as SignupResult);
    const result = await runDiscoveryBot(
      { service: "newservice" },
      {
        machineToken: "tok",
        accountId: "acct",
        inboxClient: stubInbox(),
        bot,
        skipAutoPromote: true,
      },
    );
    expect(result.kind).toBe("ok");
    expect((result as { reason: string }).reason).toMatch(/signed up/);
  });

  it("returns blocked on onboarding_blocked", async () => {
    const bot = stubBot({
      success: false,
      error: "onboarding_blocked: billing wall",
      steps: [],
    } as SignupResult);
    const result = await runDiscoveryBot(
      { service: "koyeb" },
      {
        machineToken: "tok",
        accountId: "acct",
        inboxClient: stubInbox(),
        bot,
        skipAutoPromote: true,
      },
    );
    expect(result.kind).toBe("blocked");
    expect((result as { reason: string }).reason).toMatch(/onboarding_blocked/);
  });

  it("returns blocked on anti_bot_blocked", async () => {
    const bot = stubBot({
      success: false,
      error: "anti_bot_blocked: Cloudflare on SSO callback",
      steps: [],
    } as SignupResult);
    const result = await runDiscoveryBot(
      { service: "turso" },
      {
        machineToken: "tok",
        accountId: "acct",
        inboxClient: stubInbox(),
        bot,
        skipAutoPromote: true,
      },
    );
    expect(result.kind).toBe("blocked");
  });

  it("returns blocked on captcha_blocked", async () => {
    const bot = stubBot({
      success: false,
      error: "captcha_blocked: Turnstile checkbox",
      steps: [],
    } as SignupResult);
    const result = await runDiscoveryBot(
      { service: "svc" },
      {
        machineToken: "tok",
        accountId: "acct",
        inboxClient: stubInbox(),
        bot,
        skipAutoPromote: true,
      },
    );
    expect(result.kind).toBe("blocked");
  });

  it("returns failed (not blocked) on generic errors", async () => {
    const bot = stubBot({
      success: false,
      error: "no_credentials: post-OAuth navigation didn't surface a key",
      steps: [],
    } as SignupResult);
    const result = await runDiscoveryBot(
      { service: "svc" },
      {
        machineToken: "tok",
        accountId: "acct",
        inboxClient: stubInbox(),
        bot,
        skipAutoPromote: true,
      },
    );
    expect(result.kind).toBe("failed");
    expect((result as { reason: string }).reason).toMatch(/no_credentials/);
  });

  it("returns failed when the bot throws", async () => {
    const bot = {
      signup: async () => {
        throw new Error("playwright launch failed");
      },
    };
    const result = await runDiscoveryBot(
      { service: "svc" },
      {
        machineToken: "tok",
        accountId: "acct",
        inboxClient: stubInbox(),
        bot: bot as never,
        skipAutoPromote: true,
      },
    );
    expect(result.kind).toBe("failed");
    expect((result as { reason: string }).reason).toMatch(/bot crash.*playwright/);
  });

  it("returns failed when createAlias throws", async () => {
    const inbox = {
      createAlias: async () => {
        throw new Error("inbox 503");
      },
    };
    const result = await runDiscoveryBot(
      { service: "svc" },
      {
        machineToken: "tok",
        accountId: "acct",
        inboxClient: inbox as never,
        skipAutoPromote: true,
      },
    );
    expect(result.kind).toBe("failed");
    expect((result as { reason: string }).reason).toMatch(/createAlias.*inbox 503/);
  });
});
