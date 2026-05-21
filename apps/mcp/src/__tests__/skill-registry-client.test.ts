// Tests for the Tier-2 skill registry HTTP client.
//
// Strategy: inject a mock `fetchFn` and exercise every branch of
// fetchActiveSkill + postReplayOutcome. No network, no Fastify.
// The shape of "success body" matches what GET /skills/:service
// actually returns from apps/registry-api/src/routes/skills.ts.

import { describe, expect, it } from "vitest";
import type { Skill } from "@trusty-squire/adapter-sdk";
import {
  SkillRegistryClient,
  clientFromEnv,
  generateProvisionId,
} from "../skill-registry-client.js";

// ── Test fixtures ────────────────────────────────────────────────────

/** A minimal Skill that round-trips through SkillSchema. */
function makeSkill(overrides: Partial<Skill> = {}): Skill {
  const provenance = { run_id: "run_test_1", round_index: 0 };
  return {
    schema_version: 1,
    skill_id: "01HQXY8K2N4P6R8T0V2W4Y6Z80",
    service: "railway",
    version: "v1",
    signup_url: "https://railway.app/login",
    oauth_provider: null,
    steps: [
      {
        kind: "navigate",
        url: "https://railway.app/login",
        provenance,
      },
    ],
    credentials: [
      {
        type: "api_key",
        shape_hint: "uuid",
        env_var_suggestion: "RAILWAY_API_KEY",
        post_extract_validator: {
          min_length: 16,
          max_length: 128,
        },
      },
    ],
    source_run_ids: ["run_test_1"],
    status: "active",
    replays_succeeded: 0,
    replays_failed: 0,
    consecutive_failures: 0,
    created_at: "2026-05-21T00:00:00.000Z",
    last_replayed_at: null,
    superseded_at: null,
    deleted_at: null,
    ...overrides,
  } as Skill;
}

/** Build a Response-like object from a status + body. */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain" },
  });
}

/** Compose a typed fetch-mock from a list of (url-match -> response). */
type FetchHandler = (url: string, init?: RequestInit) => Promise<Response>;
function mockFetch(handler: FetchHandler): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    return handler(url, init);
  }) as typeof globalThis.fetch;
}

// ── fetchActiveSkill ────────────────────────────────────────────────

describe("SkillRegistryClient.fetchActiveSkill", () => {
  it("returns kind=found when the registry returns a valid signed skill", async () => {
    const skill = makeSkill();
    const fetchFn = mockFetch(async (url) => {
      expect(url).toBe("https://registry.test/skills/railway");
      return jsonResponse(200, {
        ok: true,
        service: "Railway",
        signed_by: "registry@trustysquire.com",
        signature: "sig",
        skill,
        counters: {
          replays_succeeded: 3,
          replays_failed: 1,
          consecutive_failures: 0,
        },
      });
    });

    const client = new SkillRegistryClient({
      baseUrl: "https://registry.test",
      accountId: "acct-1",
      fetchFn,
      cacheTtlMs: 0,
    });

    const outcome = await client.fetchActiveSkill("railway", "prov_test_1");

    expect(outcome.kind).toBe("found");
    if (outcome.kind !== "found") return;
    expect(outcome.result.skill.skill_id).toBe(skill.skill_id);
    expect(outcome.result.signed_by).toBe("registry@trustysquire.com");
    expect(outcome.result.counters.replays_succeeded).toBe(3);
    expect(outcome.result.counters.replays_failed).toBe(1);
  });

  it("returns kind=not_found on 404", async () => {
    const fetchFn = mockFetch(async () => jsonResponse(404, { ok: false }));
    const client = new SkillRegistryClient({
      baseUrl: "https://registry.test",
      accountId: "acct-1",
      fetchFn,
    });

    const outcome = await client.fetchActiveSkill("unknown", "prov_test_1");
    expect(outcome.kind).toBe("not_found");
  });

  it("returns kind=unavailable on 500", async () => {
    const fetchFn = mockFetch(async () => jsonResponse(500, { ok: false }));
    const client = new SkillRegistryClient({
      baseUrl: "https://registry.test",
      accountId: "acct-1",
      fetchFn,
    });

    const outcome = await client.fetchActiveSkill("railway", "prov_test_1");
    expect(outcome.kind).toBe("unavailable");
    if (outcome.kind !== "unavailable") return;
    expect(outcome.reason).toMatch(/HTTP 500/);
  });

  it("returns kind=unavailable on network error", async () => {
    const fetchFn = mockFetch(async () => {
      throw new Error("ECONNREFUSED");
    });
    const client = new SkillRegistryClient({
      baseUrl: "https://registry.test",
      accountId: "acct-1",
      fetchFn,
    });

    const outcome = await client.fetchActiveSkill("railway", "prov_test_1");
    expect(outcome.kind).toBe("unavailable");
    if (outcome.kind !== "unavailable") return;
    expect(outcome.reason).toMatch(/ECONNREFUSED/);
  });

  it("returns kind=unavailable on malformed JSON", async () => {
    const fetchFn = mockFetch(async () => textResponse(200, "<html>not json</html>"));
    const client = new SkillRegistryClient({
      baseUrl: "https://registry.test",
      accountId: "acct-1",
      fetchFn,
    });

    const outcome = await client.fetchActiveSkill("railway", "prov_test_1");
    expect(outcome.kind).toBe("unavailable");
    if (outcome.kind !== "unavailable") return;
    expect(outcome.reason).toMatch(/malformed JSON/);
  });

  it("returns kind=unavailable when skill fails schema validation", async () => {
    const fetchFn = mockFetch(async () =>
      jsonResponse(200, {
        signed_by: "x",
        skill: { schema_version: 999, garbage: true },
      }),
    );
    const client = new SkillRegistryClient({
      baseUrl: "https://registry.test",
      accountId: "acct-1",
      fetchFn,
    });

    const outcome = await client.fetchActiveSkill("railway", "prov_test_1");
    expect(outcome.kind).toBe("unavailable");
    if (outcome.kind !== "unavailable") return;
    expect(outcome.reason).toMatch(/schema validation/);
  });

  it("returns kind=unavailable when envelope is missing required fields", async () => {
    const fetchFn = mockFetch(async () =>
      jsonResponse(200, { ok: true, only_metadata: true }),
    );
    const client = new SkillRegistryClient({
      baseUrl: "https://registry.test",
      accountId: "acct-1",
      fetchFn,
    });

    const outcome = await client.fetchActiveSkill("railway", "prov_test_1");
    expect(outcome.kind).toBe("unavailable");
    if (outcome.kind !== "unavailable") return;
    expect(outcome.reason).toMatch(/missing skill or signed_by/);
  });

  it("times out via withTimeout when fetch hangs longer than timeoutMs", async () => {
    const fetchFn = mockFetch(
      () => new Promise(() => {}), // never resolves
    );
    const client = new SkillRegistryClient({
      baseUrl: "https://registry.test",
      accountId: "acct-1",
      fetchFn,
      timeoutMs: 20,
    });

    const outcome = await client.fetchActiveSkill("railway", "prov_test_1");
    expect(outcome.kind).toBe("unavailable");
    if (outcome.kind !== "unavailable") return;
    expect(outcome.reason).toMatch(/timed out/);
  });

  it("sends x-account-id and x-provision-id headers", async () => {
    let capturedInit: RequestInit | undefined;
    const fetchFn = mockFetch(async (_url, init) => {
      capturedInit = init;
      return jsonResponse(200, {
        signed_by: "x",
        skill: makeSkill(),
      });
    });
    const client = new SkillRegistryClient({
      baseUrl: "https://registry.test",
      accountId: "acct-42",
      fetchFn,
      cacheTtlMs: 0,
    });

    await client.fetchActiveSkill("railway", "prov_xyz");

    expect(capturedInit).toBeDefined();
    const headers = capturedInit!.headers as Record<string, string>;
    expect(headers["x-account-id"]).toBe("acct-42");
    expect(headers["x-provision-id"]).toBe("prov_xyz");
  });
});

// ── Cache behaviour ─────────────────────────────────────────────────

describe("SkillRegistryClient cache", () => {
  it("serves the same service from cache within TTL", async () => {
    let calls = 0;
    const fetchFn = mockFetch(async () => {
      calls += 1;
      return jsonResponse(200, {
        signed_by: "x",
        skill: makeSkill(),
      });
    });
    const client = new SkillRegistryClient({
      baseUrl: "https://registry.test",
      accountId: "a",
      fetchFn,
      cacheTtlMs: 60_000,
    });

    await client.fetchActiveSkill("railway", "p1");
    await client.fetchActiveSkill("railway", "p2");
    await client.fetchActiveSkill("railway", "p3");

    expect(calls).toBe(1);
  });

  it("re-fetches after the cache TTL expires", async () => {
    let calls = 0;
    const fetchFn = mockFetch(async () => {
      calls += 1;
      return jsonResponse(200, {
        signed_by: "x",
        skill: makeSkill(),
      });
    });
    const client = new SkillRegistryClient({
      baseUrl: "https://registry.test",
      accountId: "a",
      fetchFn,
      cacheTtlMs: 5, // 5ms
    });

    await client.fetchActiveSkill("railway", "p1");
    await new Promise((r) => setTimeout(r, 15));
    await client.fetchActiveSkill("railway", "p2");

    expect(calls).toBe(2);
  });

  it("does not cache when cacheTtlMs is 0", async () => {
    let calls = 0;
    const fetchFn = mockFetch(async () => {
      calls += 1;
      return jsonResponse(200, {
        signed_by: "x",
        skill: makeSkill(),
      });
    });
    const client = new SkillRegistryClient({
      baseUrl: "https://registry.test",
      accountId: "a",
      fetchFn,
      cacheTtlMs: 0,
    });

    await client.fetchActiveSkill("railway", "p1");
    await client.fetchActiveSkill("railway", "p2");

    expect(calls).toBe(2);
  });

  it("does not cache unavailable / not_found outcomes", async () => {
    let calls = 0;
    let nextStatus = 500;
    const fetchFn = mockFetch(async () => {
      calls += 1;
      const s = nextStatus;
      nextStatus = 200; // second call returns success
      if (s === 500) return jsonResponse(500, { ok: false });
      return jsonResponse(200, {
        signed_by: "x",
        skill: makeSkill(),
      });
    });
    const client = new SkillRegistryClient({
      baseUrl: "https://registry.test",
      accountId: "a",
      fetchFn,
      cacheTtlMs: 60_000,
    });

    const first = await client.fetchActiveSkill("railway", "p1");
    expect(first.kind).toBe("unavailable");

    const second = await client.fetchActiveSkill("railway", "p2");
    expect(second.kind).toBe("found");
    expect(calls).toBe(2);
  });

  it("invalidateCache forces a re-fetch", async () => {
    let calls = 0;
    const fetchFn = mockFetch(async () => {
      calls += 1;
      return jsonResponse(200, {
        signed_by: "x",
        skill: makeSkill(),
      });
    });
    const client = new SkillRegistryClient({
      baseUrl: "https://registry.test",
      accountId: "a",
      fetchFn,
      cacheTtlMs: 60_000,
    });

    await client.fetchActiveSkill("railway", "p1");
    client.invalidateCache("railway");
    await client.fetchActiveSkill("railway", "p2");

    expect(calls).toBe(2);
  });

  it("caches per service — invalidate one does not evict another", async () => {
    let calls = 0;
    const fetchFn = mockFetch(async () => {
      calls += 1;
      return jsonResponse(200, {
        signed_by: "x",
        skill: makeSkill(),
      });
    });
    const client = new SkillRegistryClient({
      baseUrl: "https://registry.test",
      accountId: "a",
      fetchFn,
      cacheTtlMs: 60_000,
    });

    await client.fetchActiveSkill("railway", "p1");
    await client.fetchActiveSkill("supabase", "p2");
    expect(calls).toBe(2);

    client.invalidateCache("railway");
    await client.fetchActiveSkill("railway", "p3"); // re-fetch
    await client.fetchActiveSkill("supabase", "p4"); // still cached
    expect(calls).toBe(3);
  });
});

// ── postReplayOutcome ───────────────────────────────────────────────

describe("SkillRegistryClient.postReplayOutcome", () => {
  it("posts the outcome and returns kind=ok", async () => {
    let capturedBody: string | undefined;
    let capturedUrl: string | undefined;
    const fetchFn = mockFetch(async (url, init) => {
      capturedUrl = url;
      capturedBody = init?.body as string;
      return jsonResponse(200, { ok: true, demoted: false });
    });
    const client = new SkillRegistryClient({
      baseUrl: "https://registry.test",
      accountId: "acct-1",
      fetchFn,
    });

    const result = await client.postReplayOutcome({
      skill_id: "skill_railway_a1b2c3d4",
      outcome: "ok",
      reason: "all steps green",
      provision_id: "prov_test_1",
    });

    expect(result.kind).toBe("ok");
    expect(result.demoted).toBe(false);
    expect(capturedUrl).toBe(
      "https://registry.test/skills/skill_railway_a1b2c3d4/replay-outcome",
    );
    const parsed = JSON.parse(capturedBody!);
    expect(parsed.outcome).toBe("ok");
    expect(parsed.reason).toBe("all steps green");
  });

  it("surfaces demoted=true when registry auto-demotes", async () => {
    const fetchFn = mockFetch(async () =>
      jsonResponse(200, { ok: true, demoted: true }),
    );
    const client = new SkillRegistryClient({
      baseUrl: "https://registry.test",
      accountId: "acct-1",
      fetchFn,
    });

    const result = await client.postReplayOutcome({
      skill_id: "skill_x",
      outcome: "step_failed",
      reason: "third strike",
      provision_id: "prov_1",
    });

    expect(result.kind).toBe("ok");
    expect(result.demoted).toBe(true);
  });

  it("returns kind=rate_limited on 429", async () => {
    const fetchFn = mockFetch(async () => jsonResponse(429, { ok: false }));
    const client = new SkillRegistryClient({
      baseUrl: "https://registry.test",
      accountId: "acct-1",
      fetchFn,
    });

    const result = await client.postReplayOutcome({
      skill_id: "skill_x",
      outcome: "ok",
      reason: "x",
      provision_id: "p",
    });

    expect(result.kind).toBe("rate_limited");
  });

  it("returns kind=skill_not_found on 404", async () => {
    const fetchFn = mockFetch(async () => jsonResponse(404, { ok: false }));
    const client = new SkillRegistryClient({
      baseUrl: "https://registry.test",
      accountId: "acct-1",
      fetchFn,
    });

    const result = await client.postReplayOutcome({
      skill_id: "skill_missing",
      outcome: "ok",
      reason: "x",
      provision_id: "p",
    });

    expect(result.kind).toBe("skill_not_found");
  });

  it("returns kind=unavailable on network error", async () => {
    const fetchFn = mockFetch(async () => {
      throw new Error("ETIMEDOUT");
    });
    const client = new SkillRegistryClient({
      baseUrl: "https://registry.test",
      accountId: "acct-1",
      fetchFn,
    });

    const result = await client.postReplayOutcome({
      skill_id: "skill_x",
      outcome: "ok",
      reason: "x",
      provision_id: "p",
    });

    expect(result.kind).toBe("unavailable");
    expect(result.reason).toMatch(/ETIMEDOUT/);
  });

  it("includes step_index in payload when provided", async () => {
    let capturedBody: string | undefined;
    const fetchFn = mockFetch(async (_url, init) => {
      capturedBody = init?.body as string;
      return jsonResponse(200, { ok: true });
    });
    const client = new SkillRegistryClient({
      baseUrl: "https://registry.test",
      accountId: "acct-1",
      fetchFn,
    });

    await client.postReplayOutcome({
      skill_id: "skill_x",
      outcome: "step_failed",
      reason: "click click click",
      step_index: 3,
      provision_id: "p",
    });

    const parsed = JSON.parse(capturedBody!);
    expect(parsed.step_index).toBe(3);
  });

  it("omits step_index when undefined", async () => {
    let capturedBody: string | undefined;
    const fetchFn = mockFetch(async (_url, init) => {
      capturedBody = init?.body as string;
      return jsonResponse(200, { ok: true });
    });
    const client = new SkillRegistryClient({
      baseUrl: "https://registry.test",
      accountId: "acct-1",
      fetchFn,
    });

    await client.postReplayOutcome({
      skill_id: "skill_x",
      outcome: "ok",
      reason: "x",
      provision_id: "p",
    });

    const parsed = JSON.parse(capturedBody!);
    expect("step_index" in parsed).toBe(false);
  });
});

// ── Factory + helpers ───────────────────────────────────────────────

describe("clientFromEnv", () => {
  it("returns null when TRUSTY_SQUIRE_REGISTRY_URL is unset", () => {
    const prev = process.env.TRUSTY_SQUIRE_REGISTRY_URL;
    delete process.env.TRUSTY_SQUIRE_REGISTRY_URL;
    try {
      expect(clientFromEnv("acct-1")).toBeNull();
    } finally {
      if (prev !== undefined) process.env.TRUSTY_SQUIRE_REGISTRY_URL = prev;
    }
  });

  it("returns null when TRUSTY_SQUIRE_REGISTRY_URL is empty", () => {
    const prev = process.env.TRUSTY_SQUIRE_REGISTRY_URL;
    process.env.TRUSTY_SQUIRE_REGISTRY_URL = "";
    try {
      expect(clientFromEnv("acct-1")).toBeNull();
    } finally {
      if (prev !== undefined) process.env.TRUSTY_SQUIRE_REGISTRY_URL = prev;
      else delete process.env.TRUSTY_SQUIRE_REGISTRY_URL;
    }
  });

  it("returns a client when the URL is set", () => {
    const prev = process.env.TRUSTY_SQUIRE_REGISTRY_URL;
    process.env.TRUSTY_SQUIRE_REGISTRY_URL = "https://registry.test";
    try {
      const c = clientFromEnv("acct-1");
      expect(c).not.toBeNull();
      expect(c).toBeInstanceOf(SkillRegistryClient);
    } finally {
      if (prev !== undefined) process.env.TRUSTY_SQUIRE_REGISTRY_URL = prev;
      else delete process.env.TRUSTY_SQUIRE_REGISTRY_URL;
    }
  });
});

describe("generateProvisionId", () => {
  it("produces ids matching the prov_<ts>_<tail> shape", () => {
    const id = generateProvisionId();
    expect(id).toMatch(/^prov_[a-z0-9]+_[a-z0-9]+$/);
  });

  it("produces unique ids on consecutive calls", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 20; i++) ids.add(generateProvisionId());
    // Allow rare timestamp+random collision, but should be ~all unique.
    expect(ids.size).toBeGreaterThan(15);
  });
});
