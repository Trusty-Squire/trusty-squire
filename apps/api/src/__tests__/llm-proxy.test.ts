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
import { loadVouchflowConfig } from "../config/vouchflow.js";
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
      customerId: loadVouchflowConfig().customerId,
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
      customerId: loadVouchflowConfig().customerId,
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

  it("returns 503 when OPENROUTER_API_KEY is unset", async () => {
    delete process.env["OPENROUTER_API_KEY"];
    const deps = buildInMemoryDeps({
      sessionSecret: "test-secret-not-used",
      customerId: loadVouchflowConfig().customerId,
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
});
