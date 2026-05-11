// InboxService tests — alias lifecycle + polling semantics.
//
// Time is fully injectable: a virtual clock advances by `pollIntervalMs`
// on every sleep call. That keeps tests fast and deterministic without
// needing fake timers from vitest.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AliasInactiveError,
  EmailTimeoutError,
  InboxService,
  InMemoryAliasStore,
  InMemoryEmailStore,
  buildReceivedEmail,
  type ReceivedEmail,
} from "../index.js";

const NOW = new Date("2026-05-10T08:00:00.000Z");
const ACCOUNT = "01HACCOUNTAAAAAAAAAAAAAAAA";
const RUN = "01HRUNAAAAAAAAAAAAAAAAAAAA";
const SERVICE = "resend";

interface Harness {
  service: InboxService;
  alias: string;
  aliasStore: InMemoryAliasStore;
  emailStore: InMemoryEmailStore;
  advance: (ms: number) => void;
  sleep: ReturnType<typeof vi.fn<[ms: number], Promise<void>>>;
}

async function setup(): Promise<Harness> {
  const aliasStore = new InMemoryAliasStore();
  const emailStore = new InMemoryEmailStore();
  let virtualNow = NOW.getTime();
  const sleep = vi.fn(async (ms: number) => {
    virtualNow += ms;
  });
  const service = new InboxService({
    aliasStore,
    emailStore,
    sleep: sleep as unknown as (ms: number) => Promise<void>,
    now: () => new Date(virtualNow),
    domain: "test.local",
    pollIntervalMs: 100,
  });
  const alias = await service.createAlias({
    account_id: ACCOUNT,
    run_id: RUN,
    service: SERVICE,
  });
  return {
    service,
    alias,
    aliasStore,
    emailStore,
    advance: (ms: number) => {
      virtualNow += ms;
    },
    sleep,
  };
}

function deliver(
  store: InMemoryEmailStore,
  alias: string,
  overrides: Partial<ReceivedEmail> = {},
): Promise<{ inserted: boolean }> {
  const email = buildReceivedEmail({
    alias,
    associated_run_id: RUN,
    message_id: `msg-${Math.random()}`,
    from_address: "noreply@resend.com",
    from_domain: "resend.com",
    subject: "Verify your email",
    s3_raw_uri: "s3://bucket/key",
    body_text: "Your code is 482915. Click https://resend.com/verify?token=abc",
    body_html: null,
    parsed_links: ["https://resend.com/verify?token=abc"],
    parsed_codes: ["482915"],
    received_at: new Date(),
    ...overrides,
  });
  return store.insertIfAbsent(email);
}

describe("InboxService.createAlias", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers a unique alias per (account, service, run)", async () => {
    const { alias } = await setup();
    expect(alias).toMatch(/\.resend\.run-/);
  });

  it("alias record carries 24h expiry by default", async () => {
    const { alias, aliasStore } = await setup();
    const rec = await aliasStore.find(alias);
    expect(rec?.expires_at.getTime()).toBe(NOW.getTime() + 24 * 60 * 60 * 1000);
  });
});

describe("InboxService.waitForEmail", () => {
  it("returns immediately when a matching email already exists", async () => {
    const h = await setup();
    await deliver(h.emailStore, h.alias);
    const found = await h.service.waitForEmail({
      alias: h.alias,
      matcher: { from: "resend.com" },
      timeout_seconds: 30,
    });
    expect(found.parsed_codes).toContain("482915");
    expect(h.sleep).not.toHaveBeenCalled();
  });

  it("times out cleanly when no match arrives", async () => {
    const h = await setup();
    await expect(
      h.service.waitForEmail({
        alias: h.alias,
        matcher: { from: "resend.com" },
        timeout_seconds: 1,
      }),
    ).rejects.toThrow(EmailTimeoutError);
    // pollIntervalMs=100 against 1000ms deadline → ~10 sleeps.
    expect(h.sleep).toHaveBeenCalled();
  });

  it("returns the most recent matching email when multiple exist", async () => {
    const h = await setup();
    await deliver(h.emailStore, h.alias, {
      message_id: "old@x",
      received_at: new Date(NOW.getTime() - 60_000),
      subject: "old",
    });
    await deliver(h.emailStore, h.alias, {
      message_id: "new@x",
      received_at: new Date(NOW.getTime()),
      subject: "new",
    });
    const found = await h.service.waitForEmail({
      alias: h.alias,
      matcher: { from: "resend.com" },
      timeout_seconds: 30,
    });
    expect(found.subject).toBe("new");
  });

  it("does not return a previously-consumed email", async () => {
    const h = await setup();
    await deliver(h.emailStore, h.alias);
    const first = await h.service.waitForEmail({
      alias: h.alias,
      matcher: { from: "resend.com" },
      timeout_seconds: 30,
    });
    expect(first).toBeDefined();
    await expect(
      h.service.waitForEmail({
        alias: h.alias,
        matcher: { from: "resend.com" },
        timeout_seconds: 1,
      }),
    ).rejects.toThrow(EmailTimeoutError);
  });

  it("matcher with subject regex filters correctly", async () => {
    const h = await setup();
    await deliver(h.emailStore, h.alias, {
      message_id: "noise@x",
      subject: "Marketing newsletter",
    });
    await deliver(h.emailStore, h.alias, {
      message_id: "verify@x",
      subject: "Verify your account",
    });
    const found = await h.service.waitForEmail({
      alias: h.alias,
      matcher: { subject: /verify/i },
      timeout_seconds: 30,
    });
    expect(found.subject).toBe("Verify your account");
  });

  it("matcher with body_contains filters correctly", async () => {
    const h = await setup();
    await deliver(h.emailStore, h.alias, {
      message_id: "code@x",
      body_text: "Your security code is 123456.",
    });
    const found = await h.service.waitForEmail({
      alias: h.alias,
      matcher: { body_contains: "security code" },
      timeout_seconds: 30,
    });
    expect(found.message_id).toBe("code@x");
  });

  it("revokeAlias prevents future waitForEmail calls", async () => {
    const h = await setup();
    await h.service.revokeAlias(h.alias);
    await expect(
      h.service.waitForEmail({
        alias: h.alias,
        matcher: { from: "resend.com" },
        timeout_seconds: 30,
      }),
    ).rejects.toThrow(AliasInactiveError);
  });

  it("expired alias rejects with AliasInactiveError", async () => {
    const h = await setup();
    h.advance(25 * 60 * 60 * 1000); // jump past the 24h TTL
    await expect(
      h.service.waitForEmail({
        alias: h.alias,
        matcher: { from: "resend.com" },
        timeout_seconds: 30,
      }),
    ).rejects.toThrow(AliasInactiveError);
  });
});

describe("InboxService.parseLink / parseCode", () => {
  it("parseLink returns the first link by default", async () => {
    const h = await setup();
    await deliver(h.emailStore, h.alias);
    const found = await h.service.waitForEmail({
      alias: h.alias,
      matcher: { from: "resend.com" },
      timeout_seconds: 30,
    });
    const link = await h.service.parseLink(found);
    expect(link).toBe("https://resend.com/verify?token=abc");
  });

  it("parseLink filters by pattern", async () => {
    const h = await setup();
    await deliver(h.emailStore, h.alias, {
      message_id: "two-links@x",
      parsed_links: [
        "https://resend.com/marketing/click",
        "https://resend.com/verify?token=xyz",
      ],
    });
    const found = await h.service.waitForEmail({
      alias: h.alias,
      matcher: { from: "resend.com" },
      timeout_seconds: 30,
    });
    const link = await h.service.parseLink(found, /verify/);
    expect(link).toBe("https://resend.com/verify?token=xyz");
  });

  it("parseCode returns the first parsed code by default", async () => {
    const h = await setup();
    await deliver(h.emailStore, h.alias);
    const found = await h.service.waitForEmail({
      alias: h.alias,
      matcher: { from: "resend.com" },
      timeout_seconds: 30,
    });
    expect(await h.service.parseCode(found)).toBe("482915");
  });

  it("parseCode with a custom pattern overrides defaults", async () => {
    const h = await setup();
    await deliver(h.emailStore, h.alias, {
      body_text: "Token: ABCD-1234",
      parsed_codes: [],
    });
    const found = await h.service.waitForEmail({
      alias: h.alias,
      matcher: { from: "resend.com" },
      timeout_seconds: 30,
    });
    expect(await h.service.parseCode(found, /Token:\s+([A-Z0-9-]+)/)).toBe("ABCD-1234");
  });
});
