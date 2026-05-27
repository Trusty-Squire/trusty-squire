import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  sendMessage,
  buildDailyDigest,
  buildCrashAlert,
  resolveChatIdFromUpdates,
} from "../telegram.mjs";

describe("buildDailyDigest", () => {
  it("includes all sections with non-empty arrays", () => {
    const msg = buildDailyDigest({
      date: "2026-05-24",
      budget: "daily budget: ~$0.15 / $5.00 (3%) — 12 attempts, 250 LLM calls",
      succeeded: ["ipinfo", "openrouter"],
      demoted: ["railway"],
      newCaptures: ["postmark"],
      pendingReview: ["resend", "sentry"],
      inBackoff: ["railway", "vercel"],
      recentFailures: [
        { slug: "railway", status: "captcha_blocked", error: "turnstile timeout" },
      ],
    });

    expect(msg).toContain("📋 Harvester daily digest — 2026-05-24");
    expect(msg).toContain("💰 daily budget");
    expect(msg).toContain("✅ Succeeded: 2");
    expect(msg).toContain("ipinfo, openrouter");
    expect(msg).toContain("⚠️  In backoff: 2");
    expect(msg).toContain("🆕 New captures: 1");
    expect(msg).toContain("👀 Pending review: 2");
    expect(msg).toContain("resend, sentry");
    expect(msg).toContain("❌ Demoted today: 1");
    expect(msg).toContain("Recent failures:");
    expect(msg).toContain("railway: captcha_blocked — turnstile timeout");
  });

  it("renders zero counts cleanly with no slug lists", () => {
    const msg = buildDailyDigest({
      date: "2026-05-24",
      budget: "daily budget: ~$0.00 / $5.00 (0%) — 0 attempts, 0 LLM calls",
      succeeded: [],
      demoted: [],
      newCaptures: [],
      inBackoff: [],
      recentFailures: [],
    });
    expect(msg).toContain("✅ Succeeded: 0");
    expect(msg).not.toMatch(/Succeeded: 0\n   /);  // no empty list line
    expect(msg).not.toContain("Recent failures:");
  });

  it("truncates long error messages in recent failures", () => {
    const longErr = "x".repeat(200);
    const msg = buildDailyDigest({
      date: "2026-05-24",
      succeeded: [],
      demoted: [],
      newCaptures: [],
      inBackoff: [],
      recentFailures: [{ slug: "s", status: "failed", error: longErr }],
    });
    // Should be sliced to 80 chars max
    expect(msg).toContain("x".repeat(80));
    expect(msg).not.toContain("x".repeat(81));
  });

  it("caps recent failures at 5", () => {
    const fails = Array.from({ length: 10 }, (_, i) => ({
      slug: `svc${i}`, status: "failed", error: "e",
    }));
    const msg = buildDailyDigest({
      date: "2026-05-24",
      succeeded: [], demoted: [], newCaptures: [], inBackoff: [],
      recentFailures: fails,
    });
    expect(msg).toContain("svc0");
    expect(msg).toContain("svc4");
    expect(msg).not.toContain("svc5");
  });
});

describe("buildCrashAlert", () => {
  it("includes component + signature at minimum", () => {
    const msg = buildCrashAlert("ingest.mjs", "ENOENT-halts-dir");
    expect(msg).toContain("🚨 Harvester crash alert");
    expect(msg).toContain("Component: ingest.mjs");
    expect(msg).toContain("Signature: ENOENT-halts-dir");
  });

  it("includes optional fields when provided", () => {
    const msg = buildCrashAlert("ingest.mjs", "parse-fail", {
      service: "railway",
      stage: "load-report",
      message: "Unexpected end of JSON input",
      runId: "run-abc123",
    });
    expect(msg).toContain("Service: railway");
    expect(msg).toContain("Stage: load-report");
    expect(msg).toContain("Message: Unexpected end of JSON input");
    expect(msg).toContain("Run: run-abc123");
  });

  it("truncates very long messages", () => {
    const longMsg = "y".repeat(500);
    const out = buildCrashAlert("c", "s", { message: longMsg });
    expect(out).toContain("y".repeat(200));
    expect(out).not.toContain("y".repeat(201));
  });
});

describe("sendMessage (no token)", () => {
  let stderrSpy;
  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it("returns false and prints to stderr when no token is configured", async () => {
    const ok = await sendMessage("hello", { token: undefined });
    expect(ok).toBe(false);
    expect(stderrSpy).toHaveBeenCalled();
    const printed = stderrSpy.mock.calls.map((c) => c[0]).join("");
    expect(printed).toContain("no TELEGRAM_BOT_TOKEN");
    expect(printed).toContain("hello");
  });

  it("returns false and prints to stderr when token is empty string", async () => {
    const ok = await sendMessage("hello", { token: "" });
    expect(ok).toBe(false);
  });
});

describe("resolveChatIdFromUpdates (mocked fetch)", () => {
  let fetchSpy;
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("returns null when getUpdates returns empty result", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true, result: [] }),
    });
    expect(await resolveChatIdFromUpdates("token")).toBeNull();
  });

  it("returns the most recent message's chat.id", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        ok: true,
        result: [
          { update_id: 1, message: { chat: { id: 111 } } },
          { update_id: 2, message: { chat: { id: 222 } } },
          { update_id: 3, message: { chat: { id: 333 } } },
        ],
      }),
    });
    expect(await resolveChatIdFromUpdates("token")).toBe(333);
  });

  it("returns null on network failure", async () => {
    fetchSpy.mockRejectedValue(new Error("network down"));
    expect(await resolveChatIdFromUpdates("token")).toBeNull();
  });

  it("returns null on non-2xx response", async () => {
    fetchSpy.mockResolvedValue({ ok: false, json: () => Promise.resolve({}) });
    expect(await resolveChatIdFromUpdates("token")).toBeNull();
  });
});
