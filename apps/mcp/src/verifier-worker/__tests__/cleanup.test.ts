// Token-cleanup runner — closed-loop strategy Phase 4.
//
// Covers: api_delete strategy, dashboard_steps strategy, the
// no-strategy / no-credential skips, and the 404-is-success behavior
// (services treat already-deleted tokens as 404 rather than 200, so
// we accept it).

import { describe, expect, it, vi } from "vitest";
import { runCleanup } from "../cleanup.js";
import type { Skill } from "@trusty-squire/adapter-sdk";
import { SKILL_SCHEMA_VERSION } from "@trusty-squire/adapter-sdk";

function baseSkill(extra: Partial<Skill> = {}): Skill {
  return {
    schema_version: SKILL_SCHEMA_VERSION,
    service: "openrouter",
    version: "v1",
    skill_id: "01CLEAN00000000000000000XX",
    signup_url: "https://openrouter.ai/signup",
    oauth_provider: "google",
    steps: [
      {
        kind: "navigate",
        url: "https://openrouter.ai/signup",
        provenance: { run_id: "r1", round_index: 0 },
      },
      {
        kind: "extract_via_copy_button",
        near_text_hint: "Copy",
        provenance: { run_id: "r1", round_index: 1 },
      },
    ],
    credentials: [
      {
        type: "api_key",
        shape_hint: "opaque",
        env_var_suggestion: "OPENROUTER_API_KEY",
        post_extract_validator: { min_length: 16, max_length: 256 },
      },
    ],
    source_run_ids: ["r1"],
    status: "active",
    replays_succeeded: 0,
    replays_failed: 0,
    consecutive_failures: 0,
    created_at: "2026-05-21T04:00:00.000Z",
    last_replayed_at: null,
    superseded_at: null,
    deleted_at: null,
    ...extra,
  } as Skill;
}

describe("runCleanup — skip cases", () => {
  it("returns skipped/no_strategy when token_cleanup is unset", async () => {
    const result = await runCleanup({
      skill: baseSkill(),
      credential: "sk-or-test-credential-value-abc",
    });
    expect(result).toEqual({ kind: "skipped", reason: "no_strategy" });
  });

  it("returns skipped/no_strategy when strategy is 'none'", async () => {
    const skill = baseSkill({ token_cleanup: { strategy: "none" } as never });
    const result = await runCleanup({
      skill,
      credential: "sk-or-test-credential-value-abc",
    });
    expect(result).toEqual({ kind: "skipped", reason: "no_strategy" });
  });

  it("returns skipped/no_credential when credential is empty", async () => {
    const skill = baseSkill({
      token_cleanup: {
        strategy: "api_delete",
        url_template: "https://openrouter.ai/api/v1/keys/${TOKEN_ID}",
        method: "DELETE",
        auth_scheme: "bearer_self",
      } as never,
    });
    const result = await runCleanup({ skill, credential: "" });
    expect(result).toEqual({ kind: "skipped", reason: "no_credential" });
  });
});

describe("runCleanup — api_delete", () => {
  it("sends DELETE with Authorization: Bearer <token>", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      seen.url = typeof url === "string" ? url : url.toString();
      seen.init = init;
      // 204 responses must not carry a body — undici's Response()
      // constructor throws TypeError if you pass one.
      return new Response(null, { status: 204 });
    }) as unknown as typeof globalThis.fetch;

    const skill = baseSkill({
      token_cleanup: {
        strategy: "api_delete",
        url_template: "https://openrouter.ai/api/v1/keys/${TOKEN_ID}",
        method: "DELETE",
        auth_scheme: "bearer_self",
      } as never,
    });
    const result = await runCleanup({
      skill,
      credential: "sk-or-v1-test-token-abc123",
      templateValues: { TOKEN_ID: "tok_42" },
      fetchFn,
    });
    expect(result).toMatchObject({ kind: "ok", strategy: "api_delete", status: 204 });
    expect(seen.url).toBe("https://openrouter.ai/api/v1/keys/tok_42");
    expect(seen.init!.method).toBe("DELETE");
    expect((seen.init!.headers as Record<string, string>)["authorization"]).toBe(
      "Bearer sk-or-v1-test-token-abc123",
    );
  });

  it("uses X-API-Key header when auth_scheme=api_key_header", async () => {
    const seen: { headers?: Record<string, string> } = {};
    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      seen.headers = init?.headers as Record<string, string>;
      return new Response("", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const skill = baseSkill({
      token_cleanup: {
        strategy: "api_delete",
        url_template: "https://api.example.com/tokens/revoke",
        method: "POST",
        auth_scheme: "api_key_header",
      } as never,
    });
    await runCleanup({
      skill,
      credential: "service-specific-key",
      fetchFn,
    });
    expect(seen.headers!["x-api-key"]).toBe("service-specific-key");
    expect(seen.headers!["authorization"]).toBeUndefined();
  });

  it("treats 404 as success (already-deleted)", async () => {
    const fetchFn = vi.fn(async () => new Response("", { status: 404 })) as unknown as typeof globalThis.fetch;
    const skill = baseSkill({
      token_cleanup: {
        strategy: "api_delete",
        url_template: "https://api.example.com/tokens/${TOKEN_ID}",
        method: "DELETE",
        auth_scheme: "bearer_self",
      } as never,
    });
    const result = await runCleanup({
      skill,
      credential: "sk-test",
      templateValues: { TOKEN_ID: "abc" },
      fetchFn,
    });
    expect(result).toMatchObject({ kind: "ok", status: 404 });
  });

  it("returns failed on a 500 (server error)", async () => {
    const fetchFn = vi.fn(async () =>
      new Response("Internal Server Error", { status: 500 }),
    ) as unknown as typeof globalThis.fetch;
    const skill = baseSkill({
      token_cleanup: {
        strategy: "api_delete",
        url_template: "https://api.example.com/tokens/${TOKEN_ID}",
        method: "DELETE",
        auth_scheme: "bearer_self",
      } as never,
    });
    const result = await runCleanup({
      skill,
      credential: "sk-test",
      templateValues: { TOKEN_ID: "abc" },
      fetchFn,
    });
    expect(result.kind).toBe("failed");
    expect((result as { reason: string }).reason).toMatch(/HTTP 500/);
  });

  it("returns failed when fetch throws (network error)", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof globalThis.fetch;
    const skill = baseSkill({
      token_cleanup: {
        strategy: "api_delete",
        url_template: "https://api.example.com/tokens/${TOKEN_ID}",
        method: "DELETE",
        auth_scheme: "bearer_self",
      } as never,
    });
    const result = await runCleanup({
      skill,
      credential: "sk-test",
      templateValues: { TOKEN_ID: "abc" },
      fetchFn,
    });
    expect(result.kind).toBe("failed");
    expect((result as { reason: string }).reason).toMatch(/ECONNREFUSED/);
  });

  it("substitutes MISSING_<KEY> when a template var is unprovided (loud)", async () => {
    let seenUrl: string | undefined;
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      seenUrl = typeof url === "string" ? url : url.toString();
      return new Response("", { status: 204 });
    }) as unknown as typeof globalThis.fetch;
    const skill = baseSkill({
      token_cleanup: {
        strategy: "api_delete",
        url_template: "https://api.example.com/tokens/${TOKEN_ID}",
        method: "DELETE",
        auth_scheme: "bearer_self",
      } as never,
    });
    await runCleanup({
      skill,
      credential: "sk-test",
      // No templateValues — TOKEN_ID is missing
      fetchFn,
    });
    expect(seenUrl).toBe("https://api.example.com/tokens/MISSING_TOKEN_ID");
  });
});

describe("runCleanup — dashboard_steps", () => {
  it("delegates to runDashboardCleanup when provided", async () => {
    const skill = baseSkill({
      token_cleanup: {
        strategy: "dashboard_steps",
        steps: [
          {
            kind: "navigate",
            url: "https://dashboard.example.com/tokens",
            provenance: { run_id: "r1", round_index: 0 },
          },
        ],
      } as never,
    });
    const result = await runCleanup({
      skill,
      credential: "sk-test",
      runDashboardCleanup: async (steps) => {
        expect(steps).toHaveLength(1);
        return { kind: "ok", strategy: "dashboard_steps" };
      },
    });
    expect(result).toEqual({ kind: "ok", strategy: "dashboard_steps" });
  });

  it("returns skipped/no_strategy if runDashboardCleanup is not provided", async () => {
    const skill = baseSkill({
      token_cleanup: {
        strategy: "dashboard_steps",
        steps: [
          {
            kind: "navigate",
            url: "https://dashboard.example.com/tokens",
            provenance: { run_id: "r1", round_index: 0 },
          },
        ],
      } as never,
    });
    const result = await runCleanup({ skill, credential: "sk-test" });
    expect(result).toEqual({ kind: "skipped", reason: "no_strategy" });
  });

  it("wraps thrown errors as failed/dashboard_steps", async () => {
    const skill = baseSkill({
      token_cleanup: {
        strategy: "dashboard_steps",
        steps: [
          {
            kind: "navigate",
            url: "https://dashboard.example.com/tokens",
            provenance: { run_id: "r1", round_index: 0 },
          },
        ],
      } as never,
    });
    const result = await runCleanup({
      skill,
      credential: "sk-test",
      runDashboardCleanup: async () => {
        throw new Error("planner exploded");
      },
    });
    expect(result.kind).toBe("failed");
    expect((result as { reason: string }).reason).toMatch(/planner exploded/);
  });
});
