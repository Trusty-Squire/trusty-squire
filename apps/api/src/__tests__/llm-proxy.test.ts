// Verifies the LLM proxy at /v1/llm/chat:
//   1. Rejects requests without a machine token
//   2. Enforces the per-machine-token rolling rate limit
//   3. Returns 503 when OPENROUTER_API_KEY is unset
//
// We don't hit real OpenRouter — the test patches fetch via a server-
// scoped override. (Vitest's globalThis.fetch swap works here because
// the route calls the global.)

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { buildServer } from "../server.js";
import { buildInMemoryDeps } from "../services/deps.js";
import type { FastifyInstance } from "fastify";

const JSON_HEADERS = { "content-type": "application/json" };

const VALID_BODY = {
  system: "test",
  user: [{ kind: "text", text: "hi" }],
  max_tokens: 50,
};

describe("/v1/llm/chat", () => {
  let app: FastifyInstance;
  let machine_token: string;
  let originalFetch: typeof fetch;
  let originalKey: string | undefined;

  beforeEach(async () => {
    originalKey = process.env["OPENROUTER_API_KEY"];
    process.env["OPENROUTER_API_KEY"] = "test-or-key";
    const deps = buildInMemoryDeps({
      sessionSecret: "test-secret-not-used",
    });
    app = await buildServer({ deps });
    const issue = await app.inject({ method: "POST", url: "/v1/install" });
    machine_token = (issue.json() as { machine_token: string }).machine_token;
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) {
      delete process.env["OPENROUTER_API_KEY"];
    } else {
      process.env["OPENROUTER_API_KEY"] = originalKey;
    }
  });

  it("rejects requests without a machine token", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/llm/chat",
      headers: JSON_HEADERS,
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(401);
  });

  it("forwards to OpenRouter and returns the reply", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "hello back" } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
          model: "google/gemini-flash-1.5",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ) as unknown as typeof fetch;

    const res = await app.inject({
      method: "POST",
      url: "/v1/llm/chat",
      headers: { ...JSON_HEADERS, "x-machine-token": machine_token },
      payload: VALID_BODY,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      text: "hello back",
      backend: "proxy:google/gemini-flash-1.5",
      input_tokens: 10,
      output_tokens: 5,
    });
  });

  it("returns 502 when OpenRouter is unreachable", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) as unknown as typeof fetch;
    const res = await app.inject({
      method: "POST",
      url: "/v1/llm/chat",
      headers: { ...JSON_HEADERS, "x-machine-token": machine_token },
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: "upstream_unreachable" });
  });

  it("enforces per-machine-token rate limit", async () => {
    // The default tracker has a 150/hour limit. We can't realistically
    // make 151 calls in a unit test, so we cheat by reaching into the
    // tracker directly via the deps it was built with.
    const deps = buildInMemoryDeps({
      sessionSecret: "test-secret-not-used",
    });
    const tightApp = await buildServer({ deps });
    const issue = await tightApp.inject({ method: "POST", url: "/v1/install" });
    const token = (issue.json() as { machine_token: string }).machine_token;

    // Manually saturate the tracker: 150 timestamps in the last hour.
    const now = Date.now();
    for (let i = 0; i < 150; i++) {
      deps.llmUsageTracker.record(token, new Date(now - i * 1000));
    }

    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }), {
        status: 200,
      }),
    ) as unknown as typeof fetch;

    const res = await tightApp.inject({
      method: "POST",
      url: "/v1/llm/chat",
      headers: { ...JSON_HEADERS, "x-machine-token": token },
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ error: "llm_rate_limited", hourly_limit: 150 });
  });

  // Schema regression net (rc.10 fix). The bot's browser.screenshot()
  // emits JPEG (quality=70) for ~10x smaller payloads; previously the
  // proxy's Zod schema only accepted PNG, which rejected every
  // post-verify planner call from the bot. Cover both formats so a
  // future schema tightening can't silently break the bot again.
  it("accepts an image block with media_type=image/png", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok" } }],
          usage: { prompt_tokens: 5, completion_tokens: 2 },
          model: "google/gemini-flash-1.5",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ) as unknown as typeof fetch;
    const res = await app.inject({
      method: "POST",
      url: "/v1/llm/chat",
      headers: { ...JSON_HEADERS, "x-machine-token": machine_token },
      payload: {
        system: "test",
        user: [{ kind: "image", media_type: "image/png", data_base64: "AAAA" }],
        max_tokens: 50,
      },
    });
    expect(res.statusCode).toBe(200);
  });

  it("accepts an image block with media_type=image/jpeg (bot uses this)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok" } }],
          usage: { prompt_tokens: 5, completion_tokens: 2 },
          model: "google/gemini-flash-1.5",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ) as unknown as typeof fetch;
    const res = await app.inject({
      method: "POST",
      url: "/v1/llm/chat",
      headers: { ...JSON_HEADERS, "x-machine-token": machine_token },
      payload: {
        system: "test",
        user: [{ kind: "image", media_type: "image/jpeg", data_base64: "AAAA" }],
        max_tokens: 50,
      },
    });
    expect(res.statusCode).toBe(200);
  });

  it("rejects an image block with an unsupported media_type", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/llm/chat",
      headers: { ...JSON_HEADERS, "x-machine-token": machine_token },
      payload: {
        system: "test",
        user: [{ kind: "image", media_type: "image/webp", data_base64: "AAAA" }],
        max_tokens: 50,
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("retries free-tier WITHOUT openrouter/free when first call returns empty content", async () => {
    // 0.8.2-rc.10: reasoning-style free models routed by openrouter/free
    // sometimes return HTTP 200 with empty content. The proxy detects
    // this + retries with the router dropped from the chain, so the
    // cheap paid backstop serves the response.
    const captures: Array<Record<string, unknown>> = [];
    let call = 0;
    globalThis.fetch = vi.fn().mockImplementation(async (_url, init) => {
      const body = JSON.parse(String((init as { body?: string }).body ?? "{}"));
      captures.push(body);
      call += 1;
      if (call === 1) {
        // First call: 200 with empty content (the reasoning-model
        // failure mode we're guarding against).
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: null } }],
            model: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      // Retry: cheap backstop replies normally.
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok from backstop" } }],
          model: "google/gemini-flash-1.5-8b",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const res = await app.inject({
      method: "POST",
      url: "/v1/llm/chat",
      headers: { ...JSON_HEADERS, "x-machine-token": machine_token },
      payload: { ...VALID_BODY, tier: "free" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { text: string; backend: string };
    expect(body.text).toBe("ok from backstop");
    expect(body.backend).toBe("proxy:google/gemini-flash-1.5-8b");

    // Exactly two upstream calls — first with the full chain, second
    // with the router dropped (cheap backstop becomes primary).
    expect(captures).toHaveLength(2);
    expect(captures[0]!.model).toBe("openrouter/free");
    expect(captures[1]!.model).toBe("google/gemini-flash-1.5-8b");
    expect(captures[1]!.models).toEqual([
      "google/gemini-flash-1.5-8b",
      "google/gemini-2.0-flash-001",
    ]);
  });

  it("attaches provider.ignore on free-tier requests when LLM_PROXY_FREE_IGNORE_PROVIDERS is set", async () => {
    // The provider blacklist needs to be set BEFORE the route module
    // is imported (the const is evaluated at module-load time). The
    // existing buildServer() in beforeEach already loaded with empty
    // ignore, so we rebuild here with the env var in place.
    process.env.LLM_PROXY_FREE_IGNORE_PROVIDERS = "Nvidia,Moonshot";
    vi.resetModules();
    const captured: { body?: Record<string, unknown> } = {};
    globalThis.fetch = vi.fn().mockImplementation(async (_url, init) => {
      captured.body = JSON.parse(String((init as { body?: string }).body ?? "{}"));
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok" } }],
          model: "google/gemma-4-31b-it:free",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    // Rebuild the server so it picks up the new env value.
    const { buildServer: buildServer2 } = await import("../server.js");
    const { buildInMemoryDeps: depsBuilder } = await import("../services/deps.js");
    const app2 = await buildServer2({
      deps: depsBuilder({ sessionSecret: "s", pollIntervalMs: 1 }),
    });

    const tok = (await app2.inject({ method: "POST", url: "/v1/install" }).then((r) =>
      r.json() as { machine_token: string },
    )).machine_token;
    const res = await app2.inject({
      method: "POST",
      url: "/v1/llm/chat",
      headers: { ...JSON_HEADERS, "x-machine-token": tok },
      payload: { ...VALID_BODY, tier: "free" },
    });
    expect(res.statusCode).toBe(200);
    expect(captured.body!["provider"]).toEqual({ ignore: ["Nvidia", "Moonshot"] });

    await app2.close();
    delete process.env.LLM_PROXY_FREE_IGNORE_PROVIDERS;
  });

  it("routes tier=free to the free-tier chain (free→free→paid)", async () => {
    const captured: { body?: Record<string, unknown> } = {};
    globalThis.fetch = vi.fn().mockImplementation(async (_url, init) => {
      captured.body = JSON.parse(String((init as { body?: string }).body ?? "{}"));
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok" } }],
          model: "google/gemini-2.0-flash-exp:free",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const res = await app.inject({
      method: "POST",
      url: "/v1/llm/chat",
      headers: { ...JSON_HEADERS, "x-machine-token": machine_token },
      payload: { ...VALID_BODY, tier: "free" },
    });
    expect(res.statusCode).toBe(200);
    const sent = captured.body!;
    // 0.8.2-rc.9: free-tier primary is OpenRouter's curated router
    // model `openrouter/free` (handles upstream model sunset
    // automatically) with a cheap paid backstop + the paid escape.
    expect(sent["model"]).toBe("openrouter/free");
    expect(sent["models"]).toEqual([
      "openrouter/free",
      "google/gemini-flash-1.5-8b",
      "google/gemini-2.0-flash-001",
    ]);
  });

  it("tier=premium uses GPT-4o and NO fallback chain", async () => {
    const captured: { body?: Record<string, unknown> } = {};
    globalThis.fetch = vi.fn().mockImplementation(async (_url, init) => {
      captured.body = JSON.parse(String((init as { body?: string }).body ?? "{}"));
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "ok" } }], model: "openai/gpt-4o" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const res = await app.inject({
      method: "POST",
      url: "/v1/llm/chat",
      headers: { ...JSON_HEADERS, "x-machine-token": machine_token },
      payload: { ...VALID_BODY, tier: "premium" },
    });
    expect(res.statusCode).toBe(200);
    expect(captured.body!["model"]).toBe("openai/gpt-4o");
    // No fallback array on premium — failure of the parse-failure
    // retry is itself the signal, not something to paper over.
    expect(captured.body!["models"]).toBeUndefined();
  });

  it("returns 503 when OPENROUTER_API_KEY is unset", async () => {
    delete process.env["OPENROUTER_API_KEY"];
    const deps = buildInMemoryDeps({
      sessionSecret: "test-secret-not-used",
    });
    const blindApp = await buildServer({ deps });
    const issue = await blindApp.inject({ method: "POST", url: "/v1/install" });
    const token = (issue.json() as { machine_token: string }).machine_token;

    const res = await blindApp.inject({
      method: "POST",
      url: "/v1/llm/chat",
      headers: { ...JSON_HEADERS, "x-machine-token": token },
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: "llm_proxy_not_configured" });
  });

  // A1 — the navigation planner sends temperature 0 for deterministic
  // decisions; the proxy must forward it to OpenRouter (and omit it otherwise
  // so non-planner callers keep the provider default).
  function okOpenRouter(): ReturnType<typeof vi.fn> {
    return vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
          model: "google/gemini-flash-1.5",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  }

  it("forwards temperature to OpenRouter when the body sets it", async () => {
    const fetchMock = okOpenRouter();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const res = await app.inject({
      method: "POST",
      url: "/v1/llm/chat",
      headers: { ...JSON_HEADERS, "x-machine-token": machine_token },
      payload: { ...VALID_BODY, temperature: 0 },
    });
    expect(res.statusCode).toBe(200);
    const orBody = JSON.parse((fetchMock.mock.calls[0]?.[1] as { body: string }).body);
    expect(orBody).toMatchObject({ temperature: 0 });
  });

  it("omits temperature from the OpenRouter body when unset", async () => {
    const fetchMock = okOpenRouter();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const res = await app.inject({
      method: "POST",
      url: "/v1/llm/chat",
      headers: { ...JSON_HEADERS, "x-machine-token": machine_token },
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(200);
    const orBody = JSON.parse((fetchMock.mock.calls[0]?.[1] as { body: string }).body);
    expect("temperature" in orBody).toBe(false);
  });

  // Fix C — deterministic planner path. When the body sets
  // deterministic=true the proxy must pin a SINGLE model (no `models`
  // routing array, never the free-tier router), pin the backend provider
  // with allow_fallbacks:false, and forward the seed.
  it("deterministic=true pins a single model + provider + seed (no models array)", async () => {
    const fetchMock = okOpenRouter();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const res = await app.inject({
      method: "POST",
      url: "/v1/llm/chat",
      headers: { ...JSON_HEADERS, "x-machine-token": machine_token },
      payload: { ...VALID_BODY, temperature: 0, deterministic: true, seed: 1 },
    });
    expect(res.statusCode).toBe(200);
    const orBody = JSON.parse((fetchMock.mock.calls[0]?.[1] as { body: string }).body);
    // Single pinned planner model — default gemini-2.0-flash-001.
    expect(orBody.model).toBe("google/gemini-2.0-flash-001");
    // NO routing array — that's the lottery we're killing.
    expect("models" in orBody).toBe(false);
    // Provider pin with fallbacks off.
    expect(orBody.provider).toEqual({
      order: ["google-vertex", "google-ai-studio"],
      allow_fallbacks: false,
    });
    expect(orBody.seed).toBe(1);
  });

  it("deterministic ignores tier=free (never the per-call free router)", async () => {
    const fetchMock = okOpenRouter();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const res = await app.inject({
      method: "POST",
      url: "/v1/llm/chat",
      headers: { ...JSON_HEADERS, "x-machine-token": machine_token },
      payload: { ...VALID_BODY, tier: "free", deterministic: true, seed: 1 },
    });
    expect(res.statusCode).toBe(200);
    const orBody = JSON.parse((fetchMock.mock.calls[0]?.[1] as { body: string }).body);
    // Pinned planner model, NOT openrouter/free, and no free chain.
    expect(orBody.model).toBe("google/gemini-2.0-flash-001");
    expect("models" in orBody).toBe(false);
  });

  it("non-deterministic cheap requests keep the models array + no seed/provider", async () => {
    const fetchMock = okOpenRouter();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const res = await app.inject({
      method: "POST",
      url: "/v1/llm/chat",
      headers: { ...JSON_HEADERS, "x-machine-token": machine_token },
      // No deterministic flag — default cheap tier behavior is unchanged.
      payload: { ...VALID_BODY },
    });
    expect(res.statusCode).toBe(200);
    const orBody = JSON.parse((fetchMock.mock.calls[0]?.[1] as { body: string }).body);
    expect(orBody.model).toBe("google/gemini-flash-1.5");
    expect(orBody.models).toEqual([
      "google/gemini-flash-1.5",
      "google/gemini-flash-1.5-8b",
      "openai/gpt-4o-mini",
    ]);
    expect("seed" in orBody).toBe(false);
    expect("provider" in orBody).toBe(false);
  });

  it("deterministic HARD-failure escapes to a single alternate model (no provider pin)", async () => {
    // The pinned model+provider returns a 502 on the first call; the
    // escape must retry once with a single alternate model and NO
    // provider pin so a provider outage doesn't dead-stop the planner.
    const captures: Array<Record<string, unknown>> = [];
    let call = 0;
    globalThis.fetch = vi.fn().mockImplementation(async (_url, init) => {
      captures.push(JSON.parse(String((init as { body?: string }).body ?? "{}")));
      call += 1;
      if (call === 1) {
        return new Response("provider unavailable", { status: 502 });
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "escape reply" } }],
          model: "google/gemini-2.0-flash-001",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const res = await app.inject({
      method: "POST",
      url: "/v1/llm/chat",
      headers: { ...JSON_HEADERS, "x-machine-token": machine_token },
      payload: { ...VALID_BODY, deterministic: true, seed: 1 },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { text: string }).text).toBe("escape reply");
    expect(captures).toHaveLength(2);
    // First call: pinned provider. Escape call: provider pin stripped.
    expect("provider" in captures[0]!).toBe(true);
    expect("provider" in captures[1]!).toBe(false);
    expect("seed" in captures[1]!).toBe(false);
  });

  it("deterministic does NOT escape on a successful-but-different reply", async () => {
    // The whole point of determinism: a successful reply is honored as-is,
    // even though it could differ from a prior run. Only a HARD failure
    // (error/empty) triggers the escape — so exactly one upstream call.
    const fetchMock = okOpenRouter();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const res = await app.inject({
      method: "POST",
      url: "/v1/llm/chat",
      headers: { ...JSON_HEADERS, "x-machine-token": machine_token },
      payload: { ...VALID_BODY, deterministic: true, seed: 1 },
    });
    expect(res.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces resolved_model + resolved_provider from the OpenRouter reply (Fix C4)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok" } }],
          model: "google/gemini-2.0-flash-001",
          provider: "Google AI Studio",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ) as unknown as typeof fetch;
    const res = await app.inject({
      method: "POST",
      url: "/v1/llm/chat",
      headers: { ...JSON_HEADERS, "x-machine-token": machine_token },
      payload: { ...VALID_BODY, deterministic: true, seed: 1 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      resolved_model: "google/gemini-2.0-flash-001",
      resolved_provider: "Google AI Studio",
    });
  });

  describe("GET /v1/llm/credits", () => {
  it("returns the operator's remaining OpenRouter balance", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { total_credits: 50, total_usage: 12.5 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof fetch;
    const res = await app.inject({
      method: "GET",
      url: "/v1/llm/credits",
      headers: { "x-machine-token": machine_token },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ total_credits: 50, total_usage: 12.5, remaining: 37.5 });
  });

  it("rejects requests without a machine token", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/llm/credits" });
    expect(res.statusCode).toBe(401);
  });

  it("returns 502 when OpenRouter's credits endpoint errors", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("nope", { status: 402 }),
    ) as unknown as typeof fetch;
    const res = await app.inject({
      method: "GET",
      url: "/v1/llm/credits",
      headers: { "x-machine-token": machine_token },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: "upstream_error", upstream_status: 402 });
  });
  });
});
