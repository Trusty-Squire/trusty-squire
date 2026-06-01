// T44 — SkillRegistryClient.fetchServiceHealth + recordProvisionEvent
// tests. Use a mock fetch to assert request shape + response handling.

import { describe, expect, it, vi } from "vitest";
import {
  SkillRegistryClient,
  type ServiceHealthResponse,
} from "../skill-registry-client.js";

function mockFetch(
  handler: (input: { url: string; init: RequestInit }) => Promise<Response> | Response,
): typeof fetch {
  return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    return handler({ url: url.toString(), init: init ?? {} });
  }) as unknown as typeof fetch;
}

function makeClient(fetchFn: typeof fetch): SkillRegistryClient {
  return new SkillRegistryClient({
    baseUrl: "https://reg.example.com",
    accountId: "acct-test",
    fetchFn,
  });
}

describe("fetchServiceHealth", () => {
  it("hits /v1/services/<slug>/health when peers is empty", async () => {
    const seenUrls: string[] = [];
    const fetch = mockFetch(async ({ url }) => {
      seenUrls.push(url);
      const body: ServiceHealthResponse = {
        service: "vercel",
        state: "working",
        compat_score: 0.8,
        has_active_skill: false,
        successful_count: 1,
        failed_count: 0,
        last_attempt_at: new Date().toISOString(),
        alternates: [],
      };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const client = makeClient(fetch);
    const out = await client.fetchServiceHealth("vercel");
    expect(out.kind).toBe("ok");
    expect(seenUrls[0]).toBe("https://reg.example.com/v1/services/vercel/health");
    if (out.kind === "ok") {
      expect(out.health.state).toBe("working");
    }
  });

  it("includes peers as a comma-separated query when provided", async () => {
    const seenUrls: string[] = [];
    const fetch = mockFetch(async ({ url }) => {
      seenUrls.push(url);
      return new Response(
        JSON.stringify({
          service: "vercel",
          state: "hard-block",
          compat_score: -3,
          has_active_skill: false,
          successful_count: 0,
          failed_count: 3,
          last_attempt_at: null,
          alternates: [
            { service: "render", state: "skill-active", compat_score: 4, has_active_skill: true },
          ],
        } satisfies ServiceHealthResponse),
        { status: 200 },
      );
    });
    const client = makeClient(fetch);
    const out = await client.fetchServiceHealth("vercel", ["render", "railway"]);
    expect(seenUrls[0]).toContain("/v1/services/vercel/health?peers=render,railway");
    if (out.kind === "ok") {
      expect(out.health.alternates).toHaveLength(1);
      expect(out.health.alternates[0]?.service).toBe("render");
    }
  });

  it("returns unavailable on HTTP error", async () => {
    const fetch = mockFetch(async () => new Response("server down", { status: 503 }));
    const client = makeClient(fetch);
    const out = await client.fetchServiceHealth("vercel");
    expect(out.kind).toBe("unavailable");
    if (out.kind === "unavailable") {
      expect(out.reason).toContain("503");
    }
  });

  it("returns unavailable on a malformed JSON body", async () => {
    const fetch = mockFetch(
      async () => new Response("not-json", { status: 200, headers: { "content-type": "text/plain" } }),
    );
    const client = makeClient(fetch);
    const out = await client.fetchServiceHealth("vercel");
    expect(out.kind).toBe("unavailable");
  });
});

describe("recordProvisionEvent", () => {
  it("POSTs the outcome with the expected body shape", async () => {
    let captured: { url: string; body: unknown } | null = null;
    const fetch = mockFetch(async ({ url, init }) => {
      captured = { url, body: JSON.parse(String(init.body)) };
      return new Response(JSON.stringify({ id: "att-123" }), { status: 201 });
    });
    const client = makeClient(fetch);
    const out = await client.recordProvisionEvent({
      service: "vercel",
      status: "failed",
      failureKind: "verification_not_sent",
      signupUrl: "https://vercel.com/signup",
      mcpVersion: "0.7.18",
    });
    expect(out.kind).toBe("ok");
    expect(captured).not.toBeNull();
    expect(captured!.url).toBe("https://reg.example.com/v1/services/vercel/attempts");
    expect(captured!.body).toEqual({
      status: "failed",
      failure_kind: "verification_not_sent",
      signup_url: "https://vercel.com/signup",
      mcp_version: "0.7.18",
    });
  });

  it("omits optional fields when not provided", async () => {
    let body: Record<string, unknown> | null = null;
    const fetch = mockFetch(async ({ init }) => {
      body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ id: "att-1" }), { status: 201 });
    });
    const client = makeClient(fetch);
    await client.recordProvisionEvent({
      service: "vercel",
      status: "success",
      mcpVersion: "0.7.18",
    });
    expect(body).toEqual({ status: "success", mcp_version: "0.7.18" });
  });

  it("serializes dispatch + cost fields when provided", async () => {
    let body: Record<string, unknown> | null = null;
    const fetch = mockFetch(async ({ init }) => {
      body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ id: "att-2" }), { status: 201 });
    });
    const client = makeClient(fetch);
    await client.recordProvisionEvent({
      service: "resend",
      status: "success",
      initialStrategy: "replay",
      finalStrategy: "replay",
      replayOutcome: "ok",
      finalOutcome: "ok",
      llmCost: 0,
      captchaCost: 0,
      durationMs: 31000,
      provisionId: "prov_x1",
      mcpVersion: "0.9.0",
    });
    expect(body).toEqual({
      status: "success",
      initial_strategy: "replay",
      final_strategy: "replay",
      replay_outcome: "ok",
      final_outcome: "ok",
      provision_id: "prov_x1",
      llm_cost: 0,
      captcha_cost: 0,
      duration_ms: 31000,
      mcp_version: "0.9.0",
    });
  });

  it("returns unavailable when the registry returns 4xx/5xx", async () => {
    const fetch = mockFetch(async () => new Response("bad", { status: 500 }));
    const client = makeClient(fetch);
    const out = await client.recordProvisionEvent({
      service: "vercel",
      status: "success",
      mcpVersion: "0.7.18",
    });
    expect(out.kind).toBe("unavailable");
    if (out.kind === "unavailable") {
      expect(out.reason).toContain("500");
    }
  });
});
