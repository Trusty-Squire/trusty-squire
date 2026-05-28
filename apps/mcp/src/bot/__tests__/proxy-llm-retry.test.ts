// Covers ProxyLLMClient's retry-with-backoff on transient upstream
// errors. The rc.3 overnight batch surfaced a recurring failure shape:
// the free-tier proxy returned 502 with
// {"error":"upstream_error","upstream_status":429} on burst load, the
// planner counted that as a failed call, and after 4 such in a row the
// bot bailed `oauth_onboarding_failed` even though the dashboard would
// have surrendered the API key on the next planner pass.
//
// Contract pinned here:
//   1. 502/503/504 + network errors → up to 3 retries with backoff.
//   2. 429 from the proxy itself → fail fast (per-machine-token cap).
//   3. 200 success → return the parsed body.
//   4. 200 with an "upstream_*" error envelope → retry (defensive).
//   5. Non-retryable 4xx (400/401) → fail fast.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProxyLLMClient } from "../llm-client.js";

const ORIGINAL_FETCH = globalThis.fetch;

function mockResponse(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json" },
  });
}

function newClient(): ProxyLLMClient {
  return new ProxyLLMClient({
    apiBaseUrl: "https://api.example.test",
    machineToken: "mt-test",
    tier: "free",
  });
}

const REQUEST_FIXTURE = {
  system: "you are a planner",
  user: [{ kind: "text" as const, text: "hi" }],
  max_tokens: 64,
};

describe("ProxyLLMClient — retry on transient upstream errors", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it("succeeds on the first attempt without backoff", async () => {
    const fetchMock = vi.fn(async () =>
      mockResponse(
        200,
        JSON.stringify({ text: "ok", backend: "google/gemini" }),
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const resp = await newClient().createMessage(REQUEST_FIXTURE);
    expect(resp.text).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries 502 upstream_error and returns the eventual success", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        mockResponse(
          502,
          JSON.stringify({ error: "upstream_error", upstream_status: 429 }),
        ),
      )
      .mockResolvedValueOnce(
        mockResponse(
          502,
          JSON.stringify({ error: "upstream_unreachable" }),
        ),
      )
      .mockResolvedValueOnce(
        mockResponse(200, JSON.stringify({ text: "ok" })),
      );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const promise = newClient().createMessage(REQUEST_FIXTURE);
    // Advance through both backoffs (250ms + 500ms).
    await vi.advanceTimersByTimeAsync(250);
    await vi.advanceTimersByTimeAsync(500);
    const resp = await promise;

    expect(resp.text).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries network errors (fetch rejection) the same way", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(
        mockResponse(200, JSON.stringify({ text: "ok" })),
      );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const promise = newClient().createMessage(REQUEST_FIXTURE);
    await vi.advanceTimersByTimeAsync(250);
    const resp = await promise;
    expect(resp.text).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up after 4 attempts (1 initial + 3 retries) on persistent 502", async () => {
    const fetchMock = vi.fn(async () =>
      mockResponse(
        502,
        JSON.stringify({ error: "upstream_error", upstream_status: 429 }),
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const promise = newClient().createMessage(REQUEST_FIXTURE);
    // Attach the assertion BEFORE advancing timers so the rejection
    // has a handler when it fires (avoids unhandled-rejection warnings
    // — the call site here is fully synchronous, but the eventual
    // `throw lastErr` runs after the last setTimeout resolves).
    const assertion = expect(promise).rejects.toThrow(/502/);
    // Drain all backoffs (250 + 500 + 1000 = 1750ms).
    await vi.advanceTimersByTimeAsync(2000);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("fails fast on 429 from the proxy itself (no retry)", async () => {
    const fetchMock = vi.fn(async () =>
      mockResponse(429, JSON.stringify({ hourly_limit: 150 })),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(newClient().createMessage(REQUEST_FIXTURE)).rejects.toThrow(
      /rate-limited/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails fast on a non-retryable 4xx (e.g. 401 unauthorized)", async () => {
    const fetchMock = vi.fn(async () =>
      mockResponse(401, JSON.stringify({ error: "unauthorized" })),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(newClient().createMessage(REQUEST_FIXTURE)).rejects.toThrow(
      /401/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // 0.8.2-rc.7 — Per-request AbortController timeout. The rc.6 batch
  // surfaced that the proxy can hang the bot for minutes when the
  // upstream is degraded but stays connected (no 502, just slow). The
  // fix bounds each attempt with a 45s timeout (default; overridable
  // via PROXY_REQUEST_TIMEOUT_MS). When the timeout fires, the fetch
  // throws AbortError which the existing retry path catches and
  // surfaces the same way a network error does.
  it("aborts a stalled attempt and retries on the next one", async () => {
    let callCount = 0;
    const fetchMock = vi.fn(
      async (
        _url: string,
        init: RequestInit & { signal?: AbortSignal },
      ): Promise<Response> => {
        callCount += 1;
        if (callCount === 1) {
          // Stall — only rejects when the AbortController fires.
          return new Promise((_resolve, reject) => {
            const sig = init.signal;
            if (sig !== undefined) {
              sig.addEventListener("abort", () => {
                const err = new Error("aborted");
                err.name = "AbortError";
                reject(err);
              });
            }
          });
        }
        return mockResponse(200, JSON.stringify({ text: "ok" }));
      },
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const promise = newClient().createMessage(REQUEST_FIXTURE);
    // Drive: the default 45000ms abort timer fires (we configured
    // fake timers, so this is instantaneous in test time), then the
    // 250ms backoff before the second attempt.
    await vi.advanceTimersByTimeAsync(45000);
    await vi.advanceTimersByTimeAsync(250);
    const resp = await promise;
    expect(resp.text).toBe("ok");
    expect(callCount).toBe(2);
  });

  it("retries on a 200 carrying an upstream-error envelope (defensive)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        mockResponse(
          200,
          JSON.stringify({ error: "upstream_error", upstream_status: 503 }),
        ),
      )
      .mockResolvedValueOnce(
        mockResponse(200, JSON.stringify({ text: "ok" })),
      );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const promise = newClient().createMessage(REQUEST_FIXTURE);
    await vi.advanceTimersByTimeAsync(250);
    const resp = await promise;
    expect(resp.text).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
