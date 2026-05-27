// Notifier tests. LogNotifier always-on output shape, TelegramNotifier
// token-missing fallback + formatted message structure. GitHubIssue
// notifier shells out to `gh` so it's tested via spawnFn injection.

import { describe, expect, it, vi } from "vitest";
import { LogNotifier } from "../notifier.js";
import { TelegramNotifier } from "../telegram-notifier.js";
import { GithubIssueNotifier } from "../github-issue-notifier.js";

describe("LogNotifier", () => {
  it("emits one line per event with the queue + service + outcome", async () => {
    const lines: string[] = [];
    const n = new LogNotifier((l) => lines.push(l));
    await n.notify({
      kind: "discover_outcome",
      queue: "discovery",
      service: "perplexity",
      outcome: "ok",
      reason: "signed up via bot",
      meta: { distinct_failures: 3, top_error_kind: "no_credentials", most_recent_at: "2026-05-26T00:00:00Z" },
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("[discover]");
    expect(lines[0]).toContain("queue=discovery");
    expect(lines[0]).toContain("service=perplexity");
    expect(lines[0]).toContain("outcome=ok");
    expect(lines[0]).toContain("users=3");
  });

  it("emits replay events with skill_id + transition", async () => {
    const lines: string[] = [];
    const n = new LogNotifier((l) => lines.push(l));
    await n.notify({
      kind: "replay_outcome",
      queue: "verifier",
      service: "openrouter",
      skill_id: "01OPENROUTER000000000000XX",
      outcome: "success",
      transition: "promoted",
      reason: "ok via=copy_button",
    });
    expect(lines[0]).toContain("[replay]");
    expect(lines[0]).toContain("transition=promoted");
    expect(lines[0]).toContain("skill_id=01OPENROUTER000000000000XX");
  });
});

describe("TelegramNotifier — token missing", () => {
  it("writes the message to stderr without crashing", async () => {
    const lines: string[] = [];
    const n = new TelegramNotifier({
      token: "",
      write: (l) => lines.push(l),
    });
    await n.notify({
      kind: "discover_outcome",
      queue: "test",
      service: "x",
      outcome: "ok",
      reason: "y",
    });
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).toMatch(/no TELEGRAM_BOT_TOKEN/);
    expect(lines.join("\n")).toMatch(/Discover \[test\] x/);
  });
});

describe("TelegramNotifier — happy path", () => {
  it("POSTs sendMessage with the formatted text and a cached chat_id", async () => {
    const calls: Array<{ url: string; body?: unknown }> = [];
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.toString();
      calls.push({
        url: u,
        body: init?.body !== undefined ? JSON.parse(init.body as string) : undefined,
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const n = new TelegramNotifier({
      token: "abc",
      chatId: 4242,
      fetchFn,
    });
    await n.notify({
      kind: "replay_outcome",
      queue: "verifier",
      service: "openrouter",
      skill_id: "01TEST0000000000000000000A",
      outcome: "success",
      transition: "promoted",
      reason: "ok via=copy_button",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toMatch(/sendMessage$/);
    const body = calls[0]!.body as { chat_id: number; text: string };
    expect(body.chat_id).toBe(4242);
    expect(body.text).toMatch(/Replay \[verifier\] openrouter/);
    expect(body.text).toMatch(/Transition: promoted/);
  });
});

describe("GithubIssueNotifier — gh CLI unavailable", () => {
  it("no-ops with a warning when `gh auth status` fails", async () => {
    const lines: string[] = [];
    const spawnFn = vi.fn(() =>
      // first call is `gh auth status` — return non-zero
      ({ status: 1, stdout: "", stderr: "not authenticated", signal: null, output: [], pid: 0 }),
    ) as never;
    const n = new GithubIssueNotifier({
      spawnFn,
      write: (l) => lines.push(l),
    });
    await n.notify({
      kind: "discover_outcome",
      queue: "discovery",
      service: "openrouter",
      outcome: "ok",
      reason: "ok",
    });
    expect(lines.join("\n")).toMatch(/gh CLI not authenticated/);
    // Only the auth-status call should have fired (the second call,
    // findIssueForSlug, is gated by availability).
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });
});
