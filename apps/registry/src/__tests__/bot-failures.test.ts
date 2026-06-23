// Closed-loop Phase 5 — universal-bot failure telemetry + discovery
// candidate aggregation.
//
// Coverage:
//   - POST /v1/telemetry/universal-bot-failure inserts a row
//   - Bad payload → 400
//   - GET /admin/discovery-candidates returns services with ≥3 distinct
//     account failures in the lookback window
//   - Services with active skills are excluded from candidates
//   - 401 when the admin bearer is missing/wrong on the GET

import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { buildServer } from "../server.js";
import { InMemorySkillStore } from "../skill-store-memory.js";
import { InMemoryBotFailureStore } from "../bot-failure-store-memory.js";
import { ManifestSigner } from "../signer.js";
import type { Skill } from "@trusty-squire/skill-schema";
import { SKILL_SCHEMA_VERSION } from "@trusty-squire/skill-schema";

const ADMIN_BEARER = "test-admin-bearer-9f8e7d6c";

function build(opts: { withSkill?: Skill } = {}) {
  const { privateKey } = generateKeyPairSync("ed25519");
  const signer = ManifestSigner.fromKeyObject(privateKey, "test-signer");
  const skillStore = new InMemorySkillStore();
  const botFailureStore = new InMemoryBotFailureStore();
  return {
    skillStore,
    botFailureStore,
    signer,
    build: async () => {
      const server = await buildServer({
        skillStore,
        botFailureStore,
        signer,
        adminBearer: ADMIN_BEARER,
      });
      if (opts.withSkill !== undefined) {
        await skillStore.insert({
          skill: opts.withSkill,
          signature: "x".repeat(64),
          signed_at: new Date(),
          signed_by: "test",
        });
      }
      return server;
    },
  };
}

function postFailure(server: Awaited<ReturnType<ReturnType<typeof build>["build"]>>, body: Record<string, unknown>, accountId: string = "acct-default") {
  return server.inject({
    method: "POST",
    url: "/v1/telemetry/universal-bot-failure",
    headers: {
      "content-type": "application/json",
      "x-account-id": accountId,
    },
    payload: body,
  });
}

describe("POST /v1/telemetry/universal-bot-failure", () => {
  it("inserts a row and returns 201 with the id", async () => {
    const { build: makeServer } = build();
    const server = await makeServer();
    const res = await postFailure(server, {
      service: "deepseek",
      error_kind: "no_credentials",
      reason: "post-OAuth onboarding loop hit limit",
      mcp_version: "0.6.15-rc.39",
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ ok: true });
    expect(res.json().id).toBeTypeOf("string");
    await server.close();
  });

  it("normalizes the service slug (lowercase + dashes)", async () => {
    const { build: makeServer, botFailureStore } = build();
    const server = await makeServer();
    await postFailure(server, {
      service: "DeepSeek API",
      error_kind: "no_credentials",
      reason: "x",
      mcp_version: "0.6.15-rc.39",
    });
    const candidates = await botFailureStore.listDiscoveryCandidates({
      excludeServices: new Set(),
      minDistinct: 1,
    });
    expect(candidates.map((c) => c.service)).toContain("deepseek-api");
    await server.close();
  });

  it("rejects malformed payloads with 400", async () => {
    const { build: makeServer } = build();
    const server = await makeServer();
    const res = await postFailure(server, { error_kind: "x" });
    expect(res.statusCode).toBe(400);
    await server.close();
  });

  it("caps reason at 2000 chars", async () => {
    const { build: makeServer, botFailureStore } = build();
    const server = await makeServer();
    const longReason = "x".repeat(5000);
    await postFailure(server, {
      service: "bigreason",
      error_kind: "x",
      reason: longReason,
      mcp_version: "0.6.15-rc.39",
    });
    const candidates = await botFailureStore.listDiscoveryCandidates({
      excludeServices: new Set(),
      minDistinct: 1,
    });
    expect(candidates).toHaveLength(1);
    // Best signal we have without exposing the raw row API: at least
    // the row exists. The cap is verified in the in-memory store
    // directly via separate unit tests.
    await server.close();
  });
});

describe("GET /admin/discovery-candidates", () => {
  it("returns services with ≥3 distinct account failures", async () => {
    const { build: makeServer } = build();
    const server = await makeServer();
    // 3 distinct accounts fail on the same service.
    for (const acct of ["a", "b", "c"]) {
      await postFailure(
        server,
        {
          service: "perplexity",
          error_kind: "no_credentials",
          reason: "test",
          mcp_version: "0.6.15-rc.39",
        },
        acct,
      );
    }
    const res = await server.inject({
      method: "GET",
      url: "/admin/discovery-candidates",
      headers: { authorization: `Bearer ${ADMIN_BEARER}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      service: "perplexity",
      distinct_failures: 3,
      top_error_kind: "no_credentials",
    });
    await server.close();
  });

  it("requires ≥3 distinct accounts by default — 2 isn't enough", async () => {
    const { build: makeServer } = build();
    const server = await makeServer();
    for (const acct of ["a", "b"]) {
      await postFailure(server, {
        service: "lonely",
        error_kind: "no_credentials",
        reason: "test",
        mcp_version: "0.6.15-rc.39",
      }, acct);
    }
    const res = await server.inject({
      method: "GET",
      url: "/admin/discovery-candidates",
      headers: { authorization: `Bearer ${ADMIN_BEARER}` },
    });
    expect(res.json().items).toHaveLength(0);
    await server.close();
  });

  it("3 reports from the SAME account does NOT qualify (distinct gate)", async () => {
    const { build: makeServer } = build();
    const server = await makeServer();
    for (let i = 0; i < 3; i++) {
      await postFailure(server, {
        service: "loudone",
        error_kind: "x",
        reason: "test",
        mcp_version: "0.6.15-rc.39",
      }, "same-acct");
    }
    const res = await server.inject({
      method: "GET",
      url: "/admin/discovery-candidates",
      headers: { authorization: `Bearer ${ADMIN_BEARER}` },
    });
    expect(res.json().items).toHaveLength(0);
    await server.close();
  });

  it("excludes services that already have an active skill", async () => {
    // openrouter has an active skill in this fixture — even with 3
    // user failures it should NOT show up as a discovery candidate.
    const openrouterSkill: Skill = {
      schema_version: SKILL_SCHEMA_VERSION,
      service: "openrouter",
      version: "v1",
      skill_id: "01OPENROUTER000000000000XX",
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
    };
    const { build: makeServer } = build({ withSkill: openrouterSkill });
    const server = await makeServer();
    for (const acct of ["a", "b", "c", "d"]) {
      await postFailure(server, {
        service: "openrouter",
        error_kind: "no_credentials",
        reason: "test",
        mcp_version: "0.6.15-rc.39",
      }, acct);
    }
    const res = await server.inject({
      method: "GET",
      url: "/admin/discovery-candidates",
      headers: { authorization: `Bearer ${ADMIN_BEARER}` },
    });
    const items = (res.json() as { items: Array<{ service: string }> }).items;
    expect(items.find((i) => i.service === "openrouter")).toBeUndefined();
    await server.close();
  });

  it("excludes legacy alias failures when the canonical service has an active skill", async () => {
    const anthropicSkill: Skill = {
      schema_version: SKILL_SCHEMA_VERSION,
      service: "anthropic-api",
      version: "v1",
      skill_id: "01ANTHRPCAP000000000000XX",
      signup_url: "https://platform.claude.com/dashboard",
      oauth_provider: null,
      steps: [
        {
          kind: "navigate",
          url: "https://platform.claude.com/dashboard",
          provenance: { run_id: "r1", round_index: 0 },
        },
        {
          kind: "extract_via_copy_button",
          near_text_hint: "Copy key",
          provenance: { run_id: "r1", round_index: 1 },
        },
      ],
      credentials: [
        {
          type: "api_key",
          shape_hint: "opaque",
          env_var_suggestion: "ANTHROPIC_API_KEY",
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
    };
    const { build: makeServer } = build({ withSkill: anthropicSkill });
    const server = await makeServer();
    for (const acct of ["a", "b", "c"]) {
      await postFailure(server, {
        service: "anthropic",
        error_kind: "no_credentials",
        reason: "legacy duplicate should be suppressed",
        mcp_version: "0.6.15-rc.39",
      }, acct);
    }
    const res = await server.inject({
      method: "GET",
      url: "/admin/discovery-candidates",
      headers: { authorization: `Bearer ${ADMIN_BEARER}` },
    });
    const items = (res.json() as { items: Array<{ service: string }> }).items;
    expect(items.find((i) => i.service === "anthropic")).toBeUndefined();
    await server.close();
  });

  it("returns 401 without admin bearer", async () => {
    const { build: makeServer } = build();
    const server = await makeServer();
    const res = await server.inject({
      method: "GET",
      url: "/admin/discovery-candidates",
    });
    expect(res.statusCode).toBe(401);
    await server.close();
  });
});
