// TwoCaptchaSolver — unit tests against canned fetch responses.
// No real network; the solver's poll loop is exercised with stub
// sleep + fetch so the test runs in milliseconds.

import { describe, expect, it, vi } from "vitest";
import {
  TwoCaptchaSolver,
  type TwoCaptchaVaultProxy,
  type TwoCaptchaVaultRequest,
} from "../captcha-solver-2captcha.js";

function mockFetch(scenario: {
  inResponse?: { status?: number; body?: unknown };
  resResponses?: Array<{ status?: number; body?: unknown }>;
  inThrows?: Error;
  createTaskResponse?: { status?: number; body?: unknown };
  taskResultResponses?: Array<{ status?: number; body?: unknown }>;
}): typeof globalThis.fetch {
  let resIdx = 0;
  let taskIdx = 0;
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
    if (u.includes("/createTask")) {
      const r = scenario.createTaskResponse ?? { body: { errorId: 0, taskId: 321 } };
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
    }
    if (u.includes("/getTaskResult")) {
      const r = scenario.taskResultResponses?.[taskIdx];
      taskIdx += 1;
      if (r === undefined) {
        return new Response(
          JSON.stringify({ errorId: 0, status: "processing" }),
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

  it("passes the invisible flag for invisible reCAPTCHA", async () => {
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
      invisible: true,
    });

    expect(res.kind).toBe("ok");
    const firstUrl = String(vi.mocked(fetchFn).mock.calls[0]?.[0]);
    expect(firstUrl).toContain("invisible=1");
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

  it("passes hCaptcha invisible mode and browser user agent when provided", async () => {
    const fetchFn = mockFetch({
      inResponse: { body: { status: 1, request: "h-id" } },
      resResponses: [{ body: { status: 1, request: "h-token" } }],
    });
    const solver = new TwoCaptchaSolver({
      apiKey: "k",
      fetchFn,
      sleepFn: noSleep,
    });
    const res = await solver.solveHcaptcha({
      sitekey: "89378a0b-0942-4717-89fc-52e01acddedd",
      pageUrl: "https://dashboard.example/register",
      invisible: true,
      userAgent: "Mozilla/5.0 Test Browser",
      data: "rqdata-bytes",
    });
    expect(res).toMatchObject({ kind: "ok", token: "h-token" });
    const firstCall = vi.mocked(fetchFn).mock.calls[0]?.[0]?.toString() ?? "";
    const url = new URL(firstCall);
    expect(url.searchParams.get("method")).toBe("hcaptcha");
    expect(url.searchParams.get("invisible")).toBe("1");
    expect(url.searchParams.get("userAgent")).toBe("Mozilla/5.0 Test Browser");
    expect(url.searchParams.get("data")).toBe("rqdata-bytes");
  });

  it("submits a coordinate image task and returns click points", async () => {
    const fetchFn = mockFetch({
      createTaskResponse: { body: { errorId: 0, taskId: 777 } },
      taskResultResponses: [
        { body: { errorId: 0, status: "processing" } },
        {
          body: {
            errorId: 0,
            status: "ready",
            solution: { coordinates: [{ x: 42, y: 91 }, { x: "205", y: "310" }] },
          },
        },
      ],
    });
    const solver = new TwoCaptchaSolver({
      apiKey: "k",
      fetchFn,
      sleepFn: noSleep,
    });
    const res = await solver.solveCoordinates({
      imageBase64: "png-base64",
      comment: "Click matching tiles",
      minClicks: 1,
      maxClicks: 5,
    });
    expect(res).toMatchObject({
      kind: "ok",
      coordinates: [{ x: 42, y: 91 }, { x: 205, y: 310 }],
    });

    const createBody = JSON.parse(
      vi.mocked(fetchFn).mock.calls[0]?.[1]?.body as string,
    ) as {
      clientKey: string;
      task: {
        type: string;
        body: string;
        comment: string;
        minClicks: number;
        maxClicks: number;
      };
    };
    expect(createBody.clientKey).toBe("k");
    expect(createBody.task).toEqual({
      type: "CoordinatesTask",
      body: "png-base64",
      comment: "Click matching tiles",
      minClicks: 1,
      maxClicks: 5,
    });
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

  it("solver_error when a coordinate task is rejected by the worker pool", async () => {
    const fetchFn = mockFetch({
      createTaskResponse: { body: { errorId: 0, taskId: 778 } },
      taskResultResponses: [
        {
          body: {
            errorId: 1,
            errorCode: "ERROR_CAPTCHA_UNSOLVABLE",
          },
        },
      ],
    });
    const solver = new TwoCaptchaSolver({
      apiKey: "k",
      fetchFn,
      sleepFn: noSleep,
    });
    const res = await solver.solveCoordinates({ imageBase64: "png-base64" });
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

// A TwoCaptchaVaultProxy that answers like the 2Captcha API, records every
// request, and (critically) never receives a raw key — the key would be
// injected server-side by use_credential, so the solver must hand the proxy the
// key's LOCATION (keyInjection), not its value.
function mockVaultProxy(scenario: {
  resResponses?: Array<{ status?: number; body?: unknown }>;
  taskResultResponses?: Array<{ status?: number; body?: unknown }>;
  createTaskBody?: unknown;
}): { proxy: TwoCaptchaVaultProxy; calls: TwoCaptchaVaultRequest[] } {
  const calls: TwoCaptchaVaultRequest[] = [];
  let resIdx = 0;
  let taskIdx = 0;
  const wrap = (body: unknown, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
  const proxy: TwoCaptchaVaultProxy = {
    async request(req) {
      calls.push(req);
      if (req.url.includes("/in.php")) return wrap({ status: 1, request: "vault-id" });
      if (req.url.includes("/res.php")) {
        const r = scenario.resResponses?.[resIdx];
        resIdx += 1;
        return wrap(r?.body ?? { status: 0, request: "CAPCHA_NOT_READY" }, r?.status ?? 200);
      }
      if (req.url.includes("/createTask"))
        return wrap(scenario.createTaskBody ?? { errorId: 0, taskId: 999 });
      if (req.url.includes("/getTaskResult")) {
        const r = scenario.taskResultResponses?.[taskIdx];
        taskIdx += 1;
        return wrap(r?.body ?? { errorId: 0, status: "processing" }, r?.status ?? 200);
      }
      throw new Error(`unexpected proxy request ${req.url}`);
    },
  };
  return { proxy, calls };
}

describe("TwoCaptchaSolver — vault proxy transport", () => {
  it("isAvailable() is true with a vault proxy and no raw key", () => {
    const { proxy } = mockVaultProxy({});
    const solver = new TwoCaptchaSolver({ apiKey: "", vaultProxy: proxy });
    expect(solver.isAvailable()).toBe(true);
  });

  it("solves reCAPTCHA v2 through the proxy, never touching fetch or holding the key", async () => {
    const fetchFn = vi.fn() as unknown as typeof globalThis.fetch;
    const { proxy, calls } = mockVaultProxy({
      resResponses: [{ body: { status: 1, request: "vault-token" } }],
    });
    const solver = new TwoCaptchaSolver({ vaultProxy: proxy, fetchFn, sleepFn: noSleep });
    const res = await solver.solveRecaptchaV2({ sitekey: "6Le-x", pageUrl: "https://t.example/" });
    expect(res).toMatchObject({ kind: "ok", token: "vault-token" });
    // The raw fetch path is bypassed entirely.
    expect(fetchFn).not.toHaveBeenCalled();
    // in.php submit: key goes in the query as `key`, never inlined as a value.
    const submit = calls.find((c) => c.url.includes("/in.php"));
    expect(submit?.keyInjection).toEqual({ in: "query", name: "key" });
    expect(submit?.query).toMatchObject({ method: "userrecaptcha", googlekey: "6Le-x", json: "1" });
    // The key is NOT in the query — the proxy injects it server-side under `key`.
    expect(submit?.query).not.toHaveProperty("key");
    // res.php poll carries the same query-key injection.
    const poll = calls.find((c) => c.url.includes("/res.php"));
    expect(poll?.keyInjection).toEqual({ in: "query", name: "key" });
    expect(poll?.query).toMatchObject({ action: "get", id: "vault-id", json: "1" });
  });

  it("routes the coordinates (createTask) flow through the proxy with body-key injection", async () => {
    const { proxy, calls } = mockVaultProxy({
      createTaskBody: { errorId: 0, taskId: 42 },
      taskResultResponses: [
        { body: { errorId: 0, status: "ready", solution: { coordinates: [{ x: 10, y: 20 }] } } },
      ],
    });
    const solver = new TwoCaptchaSolver({ vaultProxy: proxy, sleepFn: noSleep });
    const res = await solver.solveCoordinates({ imageBase64: "aGVsbG8=" });
    expect(res).toMatchObject({ kind: "ok", coordinates: [{ x: 10, y: 20 }] });
    const create = calls.find((c) => c.url.includes("/createTask"));
    expect(create?.keyInjection).toEqual({ in: "body", name: "clientKey" });
    // The task payload is present; the clientKey is the proxy's job, not in jsonBody.
    expect(JSON.stringify(create?.jsonBody)).toContain("CoordinatesTask");
    expect(create?.jsonBody).not.toHaveProperty("clientKey");
  });
});
