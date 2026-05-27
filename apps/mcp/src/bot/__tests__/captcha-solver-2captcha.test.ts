// TwoCaptchaSolver — unit tests against canned fetch responses.
// No real network; the solver's poll loop is exercised with stub
// sleep + fetch so the test runs in milliseconds.

import { describe, expect, it, vi } from "vitest";
import { TwoCaptchaSolver } from "../captcha-solver-2captcha.js";

function mockFetch(scenario: {
  inResponse?: { status?: number; body?: unknown };
  resResponses?: Array<{ status?: number; body?: unknown }>;
  inThrows?: Error;
}): typeof globalThis.fetch {
  let resIdx = 0;
  return vi.fn(async (url: string | URL | Request) => {
    const u = typeof url === "string" ? url : url.toString();
    if (u.includes("/in.php")) {
      if (scenario.inThrows !== undefined) throw scenario.inThrows;
      const r = scenario.inResponse ?? { body: { status: 1, request: "test-id" } };
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
    }
    if (u.includes("/res.php")) {
      const r = scenario.resResponses?.[resIdx];
      resIdx += 1;
      if (r === undefined) {
        return new Response(
          JSON.stringify({ status: 0, request: "CAPCHA_NOT_READY" }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
    }
    throw new Error(`unexpected fetch ${u}`);
  }) as unknown as typeof globalThis.fetch;
}

const noSleep = (_ms: number) => Promise.resolve();

describe("TwoCaptchaSolver — env gating", () => {
  it("isAvailable() is false when no api key", () => {
    const solver = new TwoCaptchaSolver({ apiKey: "" });
    expect(solver.isAvailable()).toBe(false);
  });
  it("isAvailable() is true when api key set", () => {
    const solver = new TwoCaptchaSolver({ apiKey: "k123" });
    expect(solver.isAvailable()).toBe(true);
  });
  it("solveRecaptchaV2() short-circuits to no_key without an API key", async () => {
    const fetchFn = vi.fn() as unknown as typeof globalThis.fetch;
    const solver = new TwoCaptchaSolver({ apiKey: "", fetchFn });
    const res = await solver.solveRecaptchaV2({
      sitekey: "x",
      pageUrl: "https://x.com",
    });
    expect(res).toEqual({ kind: "no_key" });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("TwoCaptchaSolver — happy path", () => {
  it("returns a token after a single poll", async () => {
    const fetchFn = mockFetch({
      inResponse: { body: { status: 1, request: "abc123" } },
      resResponses: [{ body: { status: 1, request: "the-token-bytes" } }],
    });
    const solver = new TwoCaptchaSolver({
      apiKey: "k",
      fetchFn,
      sleepFn: noSleep,
    });
    const res = await solver.solveRecaptchaV2({
      sitekey: "6Le-test",
      pageUrl: "https://target.example/",
    });
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") throw new Error("expected ok");
    expect(res.token).toBe("the-token-bytes");
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("polls past NOT_READY responses before returning the token", async () => {
    const fetchFn = mockFetch({
      inResponse: { body: { status: 1, request: "abc123" } },
      resResponses: [
        { body: { status: 0, request: "CAPCHA_NOT_READY" } },
        { body: { status: 0, request: "CAPCHA_NOT_READY" } },
        { body: { status: 1, request: "the-token" } },
      ],
    });
    const solver = new TwoCaptchaSolver({
      apiKey: "k",
      fetchFn,
      sleepFn: noSleep,
    });
    const res = await solver.solveRecaptchaV2({
      sitekey: "x",
      pageUrl: "https://x.example/",
    });
    expect(res).toMatchObject({ kind: "ok", token: "the-token" });
  });
});

describe("TwoCaptchaSolver — failure modes", () => {
  it("submission_failed when in.php returns status=0 (invalid key)", async () => {
    const fetchFn = mockFetch({
      inResponse: {
        body: { status: 0, request: "ERROR_KEY_DOES_NOT_EXIST" },
      },
    });
    const solver = new TwoCaptchaSolver({
      apiKey: "k",
      fetchFn,
      sleepFn: noSleep,
    });
    const res = await solver.solveRecaptchaV2({
      sitekey: "x",
      pageUrl: "https://x.example/",
    });
    expect(res.kind).toBe("submission_failed");
    expect((res as { reason: string }).reason).toBe("ERROR_KEY_DOES_NOT_EXIST");
  });

  it("submission_failed when in.php throws", async () => {
    const fetchFn = mockFetch({
      inThrows: new Error("ECONNREFUSED"),
    });
    const solver = new TwoCaptchaSolver({
      apiKey: "k",
      fetchFn,
      sleepFn: noSleep,
    });
    const res = await solver.solveRecaptchaV2({
      sitekey: "x",
      pageUrl: "https://x.example/",
    });
    expect(res.kind).toBe("submission_failed");
    expect((res as { reason: string }).reason).toMatch(/ECONNREFUSED/);
  });

  it("solver_error on a non-NOT_READY status=0 response", async () => {
    const fetchFn = mockFetch({
      inResponse: { body: { status: 1, request: "abc" } },
      resResponses: [{ body: { status: 0, request: "ERROR_CAPTCHA_UNSOLVABLE" } }],
    });
    const solver = new TwoCaptchaSolver({
      apiKey: "k",
      fetchFn,
      sleepFn: noSleep,
    });
    const res = await solver.solveRecaptchaV2({
      sitekey: "x",
      pageUrl: "https://x.example/",
    });
    expect(res.kind).toBe("solver_error");
    expect((res as { reason: string }).reason).toBe("ERROR_CAPTCHA_UNSOLVABLE");
  });

  it("solve_timeout when polling exhausts the deadline", async () => {
    // Always returns NOT_READY; deadline is 50ms — first poll lands
    // before the deadline check kicks in, then the second iteration
    // gates past.
    const fetchFn = mockFetch({
      inResponse: { body: { status: 1, request: "abc" } },
      // No resResponses — mock falls through to NOT_READY default.
    });
    const slowSleep = async (ms: number) => {
      // Advance the loop's perceived time without actually waiting.
      await new Promise((r) => setTimeout(r, 0));
      void ms;
    };
    const solver = new TwoCaptchaSolver({
      apiKey: "k",
      fetchFn,
      sleepFn: slowSleep,
      resTimeoutMs: 0, // first poll → deadline exceeded immediately
    });
    const res = await solver.solveRecaptchaV2({
      sitekey: "x",
      pageUrl: "https://x.example/",
    });
    expect(res.kind).toBe("solve_timeout");
  });
});
