// Operator dashboard — closed-loop Phase 7.
//
// The dashboard is server-rendered HTML; tests assert on substring
// presence rather than DOM structure — keeps the tests resilient to
// CSS / markup tweaks without losing coverage of the data flow.

import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { buildServer } from "../server.js";
import { InMemorySkillStore } from "../skill-store-memory.js";
import { InMemoryBotFailureStore } from "../bot-failure-store-memory.js";
import { ManifestSigner } from "../signer.js";
import type { Skill } from "@trusty-squire/skill-schema";
import { SKILL_SCHEMA_VERSION } from "@trusty-squire/skill-schema";

const ADMIN_BEARER = "test-admin-bearer-9f8e7d6c";

function build() {
  const { privateKey } = generateKeyPairSync("ed25519");
  const signer = ManifestSigner.fromKeyObject(privateKey, "test-signer");
  const skillStore = new InMemorySkillStore();
  const botFailureStore = new InMemoryBotFailureStore();
  return {
    skillStore,
    botFailureStore,
    signer,
    build: () =>
      buildServer({
        skillStore,
        botFailureStore,
        signer,
        adminBearer: ADMIN_BEARER,
      }),
  };
}

function activeSkill(suffix: string, service: string): Skill {
  return {
    schema_version: SKILL_SCHEMA_VERSION,
    service,
    version: "v1",
    skill_id: `01ACTIVE00000000000000${suffix}`,
    signup_url: `https://${service}.example/signup`,
    oauth_provider: "google",
    steps: [
      {
        kind: "navigate",
        url: `https://${service}.example/signup`,
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
        env_var_suggestion: "K",
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
}

function pendingSkill(suffix: string, service: string): Skill {
  return { ...activeSkill(suffix, service), status: "pending-review", skill_id: `01PEND00000000000000000${suffix}` };
}

describe("GET /admin (dashboard)", () => {
  it("returns 401 when no bearer is presented", async () => {
    const { build: make } = build();
    const server = await make();
    const res = await server.inject({ method: "GET", url: "/admin" });
    expect(res.statusCode).toBe(401);
    await server.close();
  });

  it("returns 401 when the bearer is wrong (header)", async () => {
    const { build: make } = build();
    const server = await make();
    const res = await server.inject({
      method: "GET",
      url: "/admin",
      headers: { authorization: "Bearer wrong" },
    });
    expect(res.statusCode).toBe(401);
    await server.close();
  });

  it("accepts the bearer via Authorization header", async () => {
    const { build: make } = build();
    const server = await make();
    const res = await server.inject({
      method: "GET",
      url: "/admin",
      headers: { authorization: `Bearer ${ADMIN_BEARER}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    await server.close();
  });

  it("accepts the bearer via ?bearer= query string (browser bookmark path)", async () => {
    const { build: make } = build();
    const server = await make();
    const res = await server.inject({
      method: "GET",
      url: `/admin?bearer=${ADMIN_BEARER}`,
    });
    expect(res.statusCode).toBe(200);
    await server.close();
  });

  it("renders all four section headers (empty state)", async () => {
    const { build: make } = build();
    const server = await make();
    const res = await server.inject({
      method: "GET",
      url: `/admin?bearer=${ADMIN_BEARER}`,
    });
    expect(res.body).toContain("Trusty Squire — Registry Admin");
    expect(res.body).toContain('id="active"');
    expect(res.body).toContain('id="pending"');
    expect(res.body).toContain('id="freshness"');
    expect(res.body).toContain('id="discovery"');
    expect(res.body).toContain('id="demoted"');
    expect(res.body).toContain("No active skills yet.");
    expect(res.body).toContain("No skills currently pending review.");
    await server.close();
  });

  it("renders an active skill row when one exists", async () => {
    const { skillStore, build: make } = build();
    const server = await make();
    await skillStore.insert({
      skill: activeSkill("X", "openrouter"),
      signature: "x".repeat(64),
      signed_at: new Date(),
      signed_by: "test",
    });
    const res = await server.inject({
      method: "GET",
      url: `/admin?bearer=${ADMIN_BEARER}`,
    });
    expect(res.body).toContain("openrouter");
    // The dashboard renders the skill id truncated to 10 chars.
    expect(res.body).toContain("01ACTIVE00");
    await server.close();
  });

  it("renders a pending-review skill in the pending section", async () => {
    const { skillStore, build: make } = build();
    const server = await make();
    await skillStore.insert({
      skill: pendingSkill("Y", "perplexity"),
      signature: "x".repeat(64),
      signed_at: new Date(),
      signed_by: "test",
    });
    const res = await server.inject({
      method: "GET",
      url: `/admin?bearer=${ADMIN_BEARER}`,
    });
    expect(res.body).toContain("perplexity");
    expect(res.body).toContain("0/1"); // verifier_succeeded / threshold
    await server.close();
  });

  it("renders discovery candidates from telemetry rows", async () => {
    const { botFailureStore, build: make } = build();
    const server = await make();
    // Three distinct accounts fail on `mysteryservice` → discovery candidate.
    for (const acct of ["a", "b", "c"]) {
      await botFailureStore.insert({
        service: "mysteryservice",
        error_kind: "no_credentials",
        reason: "test",
        account_id: acct,
        mcp_version: "0.6.15-rc.39",
      });
    }
    const res = await server.inject({
      method: "GET",
      url: `/admin?bearer=${ADMIN_BEARER}`,
    });
    expect(res.body).toContain("mysteryservice");
    expect(res.body).toContain("no_credentials");
    await server.close();
  });

  it("escapes HTML in service names to prevent XSS", async () => {
    const { skillStore, build: make } = build();
    const server = await make();
    // Service names are slug-validated by the schema so a real attack
    // can't land here. The test still asserts the escaper is in path —
    // future code that bypasses schema validation wouldn't catch us
    // off guard.
    await skillStore.insert({
      skill: { ...activeSkill("Z", "openrouter"), version: "v1<script>alert(1)</script>" } as never,
      signature: "x".repeat(64),
      signed_at: new Date(),
      signed_by: "test",
    });
    const res = await server.inject({
      method: "GET",
      url: `/admin?bearer=${ADMIN_BEARER}`,
    });
    expect(res.body).not.toContain("<script>alert(1)</script>");
    expect(res.body).toMatch(/v1&lt;script&gt;/);
    await server.close();
  });
});
