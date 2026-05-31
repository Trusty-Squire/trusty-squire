// runDiscover — tests cover env validation, alias creation,
// bot result mapping, and the auto-promote toggle. The actual
// universal bot (UniversalSignupBot.signup) is mocked because it
// drives Playwright + the LLM proxy.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDiscover } from "../discover.js";
import type { SignupResult, UniversalSignupRequest } from "../../../bot/index.js";
import type { InboxClient } from "../../../bot/inbox-client.js";

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

describe("runDiscover — env validation", () => {
  it("returns failed when machine token is missing", async () => {
    const result = await runDiscover(
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
    const result = await runDiscover(
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

describe("runDiscover — outcome mapping", () => {
  it("returns ok when the bot succeeds with credentials", async () => {
    const bot = stubBot({
      success: true,
      credentials: { api_key: "sk-test-discovery-credential-abc" },
      steps: ["did the thing"],
      via: "bot",
    } as SignupResult);
    const result = await runDiscover(
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
    const result = await runDiscover(
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
    const result = await runDiscover(
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
    const result = await runDiscover(
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

  it("returns failed (not blocked) on email_otp_required — inbox-poll pipeline failure is fixable, not a wall", async () => {
    const bot = stubBot({
      success: false,
      error: "email_otp_required: sent a code but the bot couldn't fetch it (reason=timeout)",
      steps: [],
    } as SignupResult);
    const result = await runDiscover(
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
  });

  it("returns failed (not blocked) on oauth_required (usually a wrong-URL nav bug)", async () => {
    const bot = stubBot({
      success: false,
      error: "oauth_required: no OAuth button found on page",
      steps: [],
    } as SignupResult);
    const result = await runDiscover(
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
  });

  it("returns failed (not blocked) on generic errors", async () => {
    const bot = stubBot({
      success: false,
      error: "no_credentials: post-OAuth navigation didn't surface a key",
      steps: [],
    } as SignupResult);
    const result = await runDiscover(
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
    const result = await runDiscover(
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
    const result = await runDiscover(
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

  it("forwards the YAML signupUrl to bot.signup (0.8.1-rc.3)", async () => {
    let capturedSignupUrl: string | undefined;
    const bot = {
      signup: async (request: UniversalSignupRequest) => {
        capturedSignupUrl = request.signupUrl;
        return {
          success: true,
          credentials: { api_key: "sk-test-yaml-url" },
          steps: [],
          via: "bot",
        } as SignupResult;
      },
    };
    const result = await runDiscover(
      { service: "ipinfo", signupUrl: "https://ipinfo.io/signup" },
      {
        machineToken: "tok",
        accountId: "acct",
        inboxClient: stubInbox(),
        bot,
        skipAutoPromote: true,
      },
    );
    expect(result.kind).toBe("ok");
    expect(capturedSignupUrl).toBe("https://ipinfo.io/signup");
  });
});

// 0.8.1 — auto-promote steps were pushed to the bot's step trail AFTER
// the discovery-bot's flush. They never reached stderr, so operators
// saw `promoted=0` in batch summaries with no diagnostic surface for
// why every successful capture failed to publish. Fix: a dedicated
// second flush of just the auto-promote-prefixed entries.
describe("runDiscover — auto-promote logging", () => {
  let savedRegistryUrl: string | undefined;
  let savedAccountId: string | undefined;
  let savedAutoPromote: string | undefined;
  beforeEach(() => {
    savedRegistryUrl = process.env.TRUSTY_SQUIRE_REGISTRY_URL;
    savedAccountId = process.env.TRUSTY_SQUIRE_ACCOUNT_ID;
    savedAutoPromote = process.env.TRUSTY_SQUIRE_AUTO_PROMOTE;
    // Bail runAutoPromote on the registry-URL check so the test
    // stays hermetic — no network, no signing keys, no filesystem
    // captures. The auto-promote function still writes a step to
    // the sink ("TRUSTY_SQUIRE_REGISTRY_URL is unset — no registry
    // to publish to.") which is what we want to assert reaches stderr.
    delete process.env.TRUSTY_SQUIRE_REGISTRY_URL;
    process.env.TRUSTY_SQUIRE_AUTO_PROMOTE = "1";
  });
  afterEach(() => {
    if (savedRegistryUrl === undefined) delete process.env.TRUSTY_SQUIRE_REGISTRY_URL;
    else process.env.TRUSTY_SQUIRE_REGISTRY_URL = savedRegistryUrl;
    if (savedAccountId === undefined) delete process.env.TRUSTY_SQUIRE_ACCOUNT_ID;
    else process.env.TRUSTY_SQUIRE_ACCOUNT_ID = savedAccountId;
    if (savedAutoPromote === undefined) delete process.env.TRUSTY_SQUIRE_AUTO_PROMOTE;
    else process.env.TRUSTY_SQUIRE_AUTO_PROMOTE = savedAutoPromote;
  });

  it("flushes auto-promote step entries to stderr after the bot trail", async () => {
    const bot = stubBot({
      success: true,
      credentials: { api_key: "sk-test-flush-12345" },
      steps: ["bot trail entry"],
      via: "bot",
    } as SignupResult);

    const captured: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr as { write: (s: string | Uint8Array, ...rest: unknown[]) => boolean }).write =
      ((s: string | Uint8Array): boolean => {
        captured.push(typeof s === "string" ? s : Buffer.from(s).toString("utf8"));
        return true;
      }) as never;
    try {
      const result = await runDiscover(
        { service: "flush-test" },
        {
          machineToken: "tok",
          accountId: "acct-flush",
          inboxClient: stubInbox(),
          bot,
          // skipAutoPromote NOT set — we want the real auto-promote path.
        },
      );
      expect(result.kind).toBe("ok");
    } finally {
      (process.stderr as { write: typeof origWrite }).write = origWrite;
    }

    const joined = captured.join("");
    // Auto-promote flush header + at least one auto-promote line.
    // The bot stub ignores the stepsSink (real Universal bot writes to
    // it), so we only assert the auto-promote-specific output here.
    // Under vitest NODE_ENV=test, resolveCaptureDir() returns null
    // before the registry-URL check fires, producing a different
    // (also-load-bearing) "capture directory is disabled" line — both
    // are valid auto-promote outputs, both prove the flush works.
    expect(joined).toMatch(/flush-test auto-promote/);
    expect(joined).toMatch(/\[auto-promote\]/);
  });
});
