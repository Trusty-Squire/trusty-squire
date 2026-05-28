// Admin routes — the verifier worker's contract with the registry.
//
// Coverage:
//   - 503 when REGISTRY_ADMIN_BEARER is unset (admin not configured)
//   - 401 when the bearer is wrong or missing
//   - GET /admin/verifier/queue returns pending-review skills first,
//     then freshness-due active skills
//   - POST /admin/skills/:id/verifier-outcome bumps verifier_succeeded
//     atomically and promotes at threshold (N=2)
//   - 3 consecutive verifier failures on pending-review → retired
//   - 3 consecutive verifier failures on active → demoted +
//     next_freshness_due_at cleared
//   - 404 for an unknown skill_id

import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { buildServer } from "../server.js";
import { InMemorySkillStore } from "../skill-store-memory.js";
import { ManifestSigner } from "../signer.js";
import type { Skill } from "@trusty-squire/adapter-sdk";
import { SKILL_SCHEMA_VERSION } from "@trusty-squire/adapter-sdk";

const ADMIN_BEARER = "test-admin-bearer-9f8e7d6c";

function buildAdminServer(opts: { adminBearer?: string; demotionWebhookUrl?: string; fetchFn?: typeof globalThis.fetch } = {}) {
  const { privateKey } = generateKeyPairSync("ed25519");
  const signer = ManifestSigner.fromKeyObject(privateKey, "test-signer");
  const skillStore = new InMemorySkillStore();
  return {
    skillStore,
    signer,
    build: () =>
      buildServer({
        skillStore,
        signer,
        adminBearer: opts.adminBearer ?? ADMIN_BEARER,
        ...(opts.demotionWebhookUrl !== undefined
          ? { demotionWebhookUrl: opts.demotionWebhookUrl }
          : {}),
        ...(opts.fetchFn !== undefined ? { fetchFn: opts.fetchFn } : {}),
      }),
  };
}

function pendingSkill(id: string, service: string = "openrouter"): Skill {
  return {
    schema_version: SKILL_SCHEMA_VERSION,
    service,
    version: "v1",
    skill_id: id,
    signup_url: `https://${service}.example.com/signup`,
    oauth_provider: "google",
    steps: [
      {
        kind: "navigate",
        url: `https://${service}.example.com/signup`,
        provenance: { run_id: `run-${id}`, round_index: 0 },
      },
      {
        kind: "extract_via_copy_button",
        near_text_hint: "Copy",
        provenance: { run_id: `run-${id}`, round_index: 1 },
      },
    ],
    credentials: [
      {
        type: "api_key",
        shape_hint: "opaque",
        env_var_suggestion: `${service.toUpperCase()}_API_KEY`,
        post_extract_validator: { min_length: 16, max_length: 256 },
      },
    ],
    source_run_ids: [`run-${id}`],
    status: "pending-review",
    replays_succeeded: 0,
    replays_failed: 0,
    consecutive_failures: 0,
    created_at: "2026-05-21T04:00:00.000Z",
    last_replayed_at: null,
    superseded_at: null,
    deleted_at: null,
  };
}

const skillIdPrefix = "01HVERIF000000000000000000";

function id(suffix: string): string {
  return (skillIdPrefix + suffix).slice(0, 26);
}

describe("admin: auth gate", () => {
  it("returns 503 when no admin bearer is configured", async () => {
    const { build } = buildAdminServer({ adminBearer: "" });
    const server = await build();
    const res = await server.inject({ method: "GET", url: "/admin/verifier/queue" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ ok: false, error: "admin_not_configured" });
    await server.close();
  });

  it("returns 401 when the bearer is missing", async () => {
    const { build } = buildAdminServer();
    const server = await build();
    const res = await server.inject({ method: "GET", url: "/admin/verifier/queue" });
    expect(res.statusCode).toBe(401);
    await server.close();
  });

  it("returns 401 when the bearer is wrong", async () => {
    const { build } = buildAdminServer();
    const server = await build();
    const res = await server.inject({
      method: "GET",
      url: "/admin/verifier/queue",
      headers: { authorization: "Bearer wrong-bearer" },
    });
    expect(res.statusCode).toBe(401);
    await server.close();
  });

  it("accepts the correct bearer", async () => {
    const { build } = buildAdminServer();
    const server = await build();
    const res = await server.inject({
      method: "GET",
      url: "/admin/verifier/queue",
      headers: { authorization: `Bearer ${ADMIN_BEARER}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, items: [] });
    await server.close();
  });
});

describe("GET /admin/verifier/queue", () => {
  it("surfaces pending-review skills awaiting promotion", async () => {
    const { skillStore, build } = buildAdminServer();
    const server = await build();
    await skillStore.insert({
      skill: pendingSkill(id("A1")),
      signature: "x".repeat(64),
      signed_at: new Date(),
      signed_by: "test",
    });

    const res = await server.inject({
      method: "GET",
      url: "/admin/verifier/queue",
      headers: { authorization: `Bearer ${ADMIN_BEARER}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].status).toBe("pending-review");
    expect(body.items[0].verifier_succeeded).toBe(0);
    await server.close();
  });

  it("does NOT surface skills that already passed the threshold", async () => {
    const { skillStore, build } = buildAdminServer();
    const server = await build();
    await skillStore.insert({
      skill: pendingSkill(id("A2")),
      signature: "x".repeat(64),
      signed_at: new Date(),
      signed_by: "test",
    });
    // Two successes — promoted on the second.
    await skillStore.recordVerifierOutcome({
      skill_id: id("A2"),
      kind: "success",
      reason: "first success",
    });
    await skillStore.recordVerifierOutcome({
      skill_id: id("A2"),
      kind: "success",
      reason: "second success",
    });

    const res = await server.inject({
      method: "GET",
      url: "/admin/verifier/queue",
      headers: { authorization: `Bearer ${ADMIN_BEARER}` },
    });
    expect(res.json().items).toHaveLength(0);
    await server.close();
  });
});

describe("POST /admin/skills/:id/verifier-outcome", () => {
  it("404s on an unknown skill_id", async () => {
    const { build } = buildAdminServer();
    const server = await build();
    const res = await server.inject({
      method: "POST",
      url: "/admin/skills/01UNKNOWN000000000000000XX/verifier-outcome",
      headers: { authorization: `Bearer ${ADMIN_BEARER}` },
      payload: { kind: "success", reason: "test" },
    });
    expect(res.statusCode).toBe(404);
    await server.close();
  });

  it("bumps counters without changing status on a single success", async () => {
    const { skillStore, build } = buildAdminServer();
    const server = await build();
    const skillId = id("B1");
    await skillStore.insert({
      skill: pendingSkill(skillId),
      signature: "x".repeat(64),
      signed_at: new Date(),
      signed_by: "test",
    });

    const res = await server.inject({
      method: "POST",
      url: `/admin/skills/${skillId}/verifier-outcome`,
      headers: { authorization: `Bearer ${ADMIN_BEARER}` },
      payload: { kind: "success", reason: "first run passed", duration_ms: 12000 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.transition).toBe("none");
    expect(body.status).toBe("pending-review");
    expect(body.verifier_succeeded).toBe(1);
    expect(body.last_verified_at).not.toBeNull();
    await server.close();
  });

  it("promotes pending-review → active on the second success (N=2)", async () => {
    const { skillStore, build } = buildAdminServer();
    const server = await build();
    const skillId = id("B2");
    await skillStore.insert({
      skill: pendingSkill(skillId),
      signature: "x".repeat(64),
      signed_at: new Date(),
      signed_by: "test",
    });

    await server.inject({
      method: "POST",
      url: `/admin/skills/${skillId}/verifier-outcome`,
      headers: { authorization: `Bearer ${ADMIN_BEARER}` },
      payload: { kind: "success", reason: "1/2" },
    });
    const res = await server.inject({
      method: "POST",
      url: `/admin/skills/${skillId}/verifier-outcome`,
      headers: { authorization: `Bearer ${ADMIN_BEARER}` },
      payload: { kind: "success", reason: "2/2 — promote" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.transition).toBe("promoted");
    expect(body.status).toBe("active");
    expect(body.verifier_succeeded).toBe(2);
    expect(body.next_freshness_due_at).not.toBeNull();
    await server.close();
  });

  it("retires pending-review after 3 consecutive failures", async () => {
    const { skillStore, build } = buildAdminServer();
    const server = await build();
    const skillId = id("B3");
    await skillStore.insert({
      skill: pendingSkill(skillId),
      signature: "x".repeat(64),
      signed_at: new Date(),
      signed_by: "test",
    });

    let lastBody: { transition: string; status: string } | undefined;
    for (let i = 0; i < 3; i++) {
      const res = await server.inject({
        method: "POST",
        url: `/admin/skills/${skillId}/verifier-outcome`,
        headers: { authorization: `Bearer ${ADMIN_BEARER}` },
        payload: { kind: "failure", reason: `fail ${i + 1}` },
      });
      lastBody = res.json();
    }
    expect(lastBody!.transition).toBe("retired");
    // After retire the skill is deleted_at != null; status is still
    // "pending-review" on the record but the deleted_at flag hides it.
    await server.close();
  });

  it("demotes active after 3 consecutive verifier failures", async () => {
    const { skillStore, build } = buildAdminServer();
    const server = await build();
    const skillId = id("B4");
    // Insert as pending-review then promote it through two successes.
    await skillStore.insert({
      skill: pendingSkill(skillId),
      signature: "x".repeat(64),
      signed_at: new Date(),
      signed_by: "test",
    });
    await skillStore.recordVerifierOutcome({
      skill_id: skillId,
      kind: "success",
      reason: "p1",
    });
    await skillStore.recordVerifierOutcome({
      skill_id: skillId,
      kind: "success",
      reason: "p2 — promotes",
    });

    let lastBody: { transition: string; status: string; next_freshness_due_at: string | null } | undefined;
    for (let i = 0; i < 3; i++) {
      const res = await server.inject({
        method: "POST",
        url: `/admin/skills/${skillId}/verifier-outcome`,
        headers: { authorization: `Bearer ${ADMIN_BEARER}` },
        payload: { kind: "failure", reason: `regression ${i + 1}` },
      });
      lastBody = res.json();
    }
    expect(lastBody!.transition).toBe("demoted");
    expect(lastBody!.status).toBe("demoted");
    expect(lastBody!.next_freshness_due_at).toBeNull();
    await server.close();
  });

  it("fires the demotion webhook on retire / demote transitions only", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: typeof url === "string" ? url : url.toString(),
        body: init?.body !== undefined ? JSON.parse(init.body as string) : undefined,
      });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const { skillStore, build } = buildAdminServer({
      demotionWebhookUrl: "https://hook.example.com/x",
      fetchFn,
    });
    const server = await build();
    const skillId = id("B5");
    await skillStore.insert({
      skill: pendingSkill(skillId),
      signature: "x".repeat(64),
      signed_at: new Date(),
      signed_by: "test",
    });
    // Single success → no webhook (transition=none).
    await server.inject({
      method: "POST",
      url: `/admin/skills/${skillId}/verifier-outcome`,
      headers: { authorization: `Bearer ${ADMIN_BEARER}` },
      payload: { kind: "success", reason: "1/2" },
    });
    // Then three failures → retire (verifier_succeeded stays at 1
    // which is still under threshold, consecutive_failures hits 3).
    for (let i = 0; i < 3; i++) {
      await server.inject({
        method: "POST",
        url: `/admin/skills/${skillId}/verifier-outcome`,
        headers: { authorization: `Bearer ${ADMIN_BEARER}` },
        payload: { kind: "failure", reason: `fail ${i + 1}` },
      });
    }
    await new Promise((r) => setTimeout(r, 5));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://hook.example.com/x");
    const body = calls[0]!.body as { transition: string; source: string };
    expect(body.transition).toBe("retired");
    expect(body.source).toBe("verifier");
    await server.close();
  });

  it("rejects malformed bodies with 400", async () => {
    const { build } = buildAdminServer();
    const server = await build();
    const res = await server.inject({
      method: "POST",
      url: `/admin/skills/whatever/verifier-outcome`,
      headers: { authorization: `Bearer ${ADMIN_BEARER}` },
      payload: { kind: "ok", reason: "" },
    });
    expect(res.statusCode).toBe(400);
    await server.close();
  });

  it("REFUSES auto-promotion when the C11 phishing-vector gate trips", async () => {
    // Existing active skill for `frontier-svc` uses GitHub OAuth +
    // a legit signup_url. A new pending-review skill arrives for
    // the same service but with a DIFFERENT signup_url. The verifier
    // must NOT auto-promote it; an operator approval is required.
    const { skillStore, build } = buildAdminServer();
    const server = await build();
    const existingId = "01C11EXISTING000000000000A";
    const incomingId = "01C11INCOMING000000000000B";
    const existing: Skill = {
      ...pendingSkill(existingId, "frontier-svc"),
      status: "active",
      signup_url: "https://frontier.example.com/signup",
    } as Skill;
    const incoming: Skill = {
      ...pendingSkill(incomingId, "frontier-svc"),
      status: "pending-review",
      signup_url: "https://attacker.example.com/signup",
    } as Skill;
    await skillStore.insert({
      skill: existing,
      signature: "x".repeat(64),
      signed_at: new Date(),
      signed_by: "test",
    });
    await skillStore.insert({
      skill: incoming,
      signature: "x".repeat(64),
      signed_at: new Date(),
      signed_by: "test",
    });
    // Two successes — should normally promote, but the C11 gate
    // should hold the skill in pending-review.
    await server.inject({
      method: "POST",
      url: `/admin/skills/${incomingId}/verifier-outcome`,
      headers: { authorization: `Bearer ${ADMIN_BEARER}` },
      payload: { kind: "success", reason: "1/2" },
    });
    const res = await server.inject({
      method: "POST",
      url: `/admin/skills/${incomingId}/verifier-outcome`,
      headers: { authorization: `Bearer ${ADMIN_BEARER}` },
      payload: { kind: "success", reason: "2/2 — would promote without gate" },
    });
    const body = res.json();
    expect(body.transition).toBe("none");
    expect(body.status).toBe("pending-review");
    expect(body.verifier_succeeded).toBe(2);
    await server.close();
  });
});

describe("/v1/telemetry/universal-bot-failure — auth gate (P1 fix)", () => {
  it("rejects requests without an x-account-id header (anonymous)", async () => {
    const { build } = buildAdminServer();
    const server = await build();
    const res = await server.inject({
      method: "POST",
      url: "/v1/telemetry/universal-bot-failure",
      headers: { "content-type": "application/json" },
      payload: {
        service: "test",
        error_kind: "x",
        reason: "y",
        mcp_version: "0.6.15-rc.39",
      },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ ok: false, error: "unauthorized" });
    await server.close();
  });

  it("accepts an authenticated account_id", async () => {
    const { build } = buildAdminServer();
    const server = await build();
    const res = await server.inject({
      method: "POST",
      url: "/v1/telemetry/universal-bot-failure",
      headers: { "content-type": "application/json", "x-account-id": "real-acct-id" },
      payload: {
        service: "test",
        error_kind: "x",
        reason: "y",
        mcp_version: "0.6.15-rc.39",
      },
    });
    expect(res.statusCode).toBe(201);
    await server.close();
  });
});
