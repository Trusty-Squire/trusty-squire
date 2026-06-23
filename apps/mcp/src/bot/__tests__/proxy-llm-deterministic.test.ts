// Fix C — ProxyLLMClient wire behavior for the deterministic planner path.
//
// Contract pinned here:
//   1. deterministic=true → the POST body carries deterministic:true and a
//      seed (defaulting to 1 when the caller doesn't supply one).
//   2. deterministic unset → NO deterministic/seed keys in the body (older
//      non-planner behavior, server interop preserved).
//   3. resolved_model / resolved_provider from the proxy reply are surfaced
//      on the LLMResponse (Fix C4 capture-attribution).

import { afterEach, describe, expect, it, vi } from "vitest";
import { ProxyLLMClient } from "../llm-client.js";

const ORIGINAL_FETCH = globalThis.fetch;

function newClient(): ProxyLLMClient {
  return new ProxyLLMClient({
    apiBaseUrl: "https://api.example.test",
    machineToken: "mt-test",
    tier: "cheap",
  });
}

const BASE_REQUEST = {
  system: "you are a planner",
  user: [{ kind: "text" as const, text: "hi" }],
  max_tokens: 64,
};

function okReply(extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ text: "ok", backend: "proxy:m", ...extra }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("ProxyLLMClient — deterministic planner wire (Fix C)", () => {
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it("forwards deterministic:true + default seed 1 when the request is deterministic", async () => {
    let sent: Record<string, unknown> = {};
    const fetchMock = vi.fn(async (_url: unknown, init: unknown) => {
      sent = JSON.parse(String((init as { body?: string }).body ?? "{}"));
      return okReply();
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await newClient().createMessage({ ...BASE_REQUEST, temperature: 0, deterministic: true });
    expect(sent.deterministic).toBe(true);
    expect(sent.seed).toBe(1);
  });

  it("forwards the caller-supplied seed when present", async () => {
    let sent: Record<string, unknown> = {};
    globalThis.fetch = vi.fn(async (_url: unknown, init: unknown) => {
      sent = JSON.parse(String((init as { body?: string }).body ?? "{}"));
      return okReply();
    }) as unknown as typeof fetch;

    await newClient().createMessage({ ...BASE_REQUEST, deterministic: true, seed: 42 });
    expect(sent.seed).toBe(42);
  });

  it("omits deterministic + seed for non-planner calls", async () => {
    let sent: Record<string, unknown> = {};
    globalThis.fetch = vi.fn(async (_url: unknown, init: unknown) => {
      sent = JSON.parse(String((init as { body?: string }).body ?? "{}"));
      return okReply();
    }) as unknown as typeof fetch;

    await newClient().createMessage({ ...BASE_REQUEST, temperature: 0 });
    expect("deterministic" in sent).toBe(false);
    expect("seed" in sent).toBe(false);
  });

  it("surfaces resolved_model + resolved_provider from the reply (Fix C4)", async () => {
    globalThis.fetch = vi.fn(async () =>
      okReply({
        resolved_model: "google/gemini-2.0-flash-001",
        resolved_provider: "Google AI Studio",
      }),
    ) as unknown as typeof fetch;

    const resp = await newClient().createMessage({ ...BASE_REQUEST, deterministic: true });
    expect(resp.resolved_model).toBe("google/gemini-2.0-flash-001");
    expect(resp.resolved_provider).toBe("Google AI Studio");
  });

  it("leaves resolved_* undefined when the reply omits them (older server)", async () => {
    globalThis.fetch = vi.fn(async () => okReply()) as unknown as typeof fetch;
    const resp = await newClient().createMessage({ ...BASE_REQUEST, deterministic: true });
    expect(resp.resolved_model).toBeUndefined();
    expect(resp.resolved_provider).toBeUndefined();
  });
});
