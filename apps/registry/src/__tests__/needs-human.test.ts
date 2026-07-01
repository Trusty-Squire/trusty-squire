// T6 — GET /admin/needs-human: the operator worklist. Rolls up demoted
// (rot) + quarantined (wall) skills with their reason so a sole operator
// targets what broke without crawling per-skill panels.

import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildServer } from "../server.js";
import { InMemorySkillStore } from "../skill-store-memory.js";
import { InMemoryBotFailureStore } from "../bot-failure-store-memory.js";
import { ManifestSigner } from "../signer.js";
import type { Skill } from "@trusty-squire/skill-schema";
import { SKILL_SCHEMA_VERSION } from "@trusty-squire/skill-schema";

const ADMIN_BEARER = "test-admin-bearer-9f8e7d6c";

function activeSkill(service: string): Skill {
  return {
    schema_version: SKILL_SCHEMA_VERSION,
    service,
    version: "v1",
    skill_id: `01NEEDH${service.toUpperCase().padEnd(19, "0").slice(0, 19)}`,
    signup_url: `https://${service}.example/signup`,
    oauth_provider: "google",
    steps: [
      { kind: "navigate", url: `https://${service}.example/signup`, provenance: { run_id: "r1", round_index: 0 } },
      { kind: "extract_via_copy_button", near_text_hint: "Copy", provenance: { run_id: "r1", round_index: 1 } },
    ],
    credentials: [
      { type: "api_key", shape_hint: "opaque", env_var_suggestion: "K", post_extract_validator: { min_length: 16, max_length: 256 } },
    ],
    source_run_ids: ["r1"],
    status: "active",
    replays_succeeded: 0,
    replays_failed: 0,
    consecutive_failures: 0,
    created_at: "2026-06-02T04:00:00.000Z",
    last_replayed_at: null,
    superseded_at: null,
    deleted_at: null,
  };
}

async function setup() {
  const { privateKey } = generateKeyPairSync("ed25519");
  const signer = ManifestSigner.fromKeyObject(privateKey, "test-signer");
  const store = new InMemorySkillStore();
  const server = await buildServer({ skillStore: store, botFailureStore: new InMemoryBotFailureStore(), signer, adminBearer: ADMIN_BEARER });
  const insertActive = (svc: string) =>
    store.insert({ skill: activeSkill(svc), signature: "x".repeat(64), signed_at: new Date(), signed_by: "test" });
  const id = (svc: string) => `01NEEDH${svc.toUpperCase().padEnd(19, "0").slice(0, 19)}`;
  const fail = (svc: string, kind: string) =>
    store.recordVerifierOutcome({ skill_id: id(svc), kind: "failure", failure_kind: kind, reason: kind });
  return { server, store, insertActive, fail, id };
}

async function worklist(server: Awaited<ReturnType<typeof setup>>["server"]) {
  const res = await server.inject({
    method: "GET",
    url: "/admin/needs-human",
    headers: { authorization: `Bearer ${ADMIN_BEARER}` },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as { ok: boolean; count: number; items: Array<{ service: string; status: string; reason: string | null; needs: string }> };
}

describe("GET /admin/needs-human (T6)", () => {
  it("requires the admin bearer", async () => {
    const { server } = await setup();
    const res = await server.inject({ method: "GET", url: "/admin/needs-human" });
    expect(res.statusCode).toBe(401);
    await server.close();
  });

  it("a rot skill downgrades to pending-review and does NOT need a human (self-heals)", async () => {
    const { server, insertActive, fail } = await setup();
    await insertActive("neon");
    await fail("neon", "step_failed");
    await fail("neon", "step_failed");
    await fail("neon", "validator_failed"); // 3rd rot → DOWNGRADE (reconcile edge 2), not demote
    const body = await worklist(server);
    // Rot no longer produces a human-worklist item: it downgrades to
    // pending-review (still served as a hint, re-proven by the verifier). Only
    // walls (quarantine) and operator demotes surface here now.
    expect(body.items.find((i) => i.service === "neon")).toBeUndefined();
    await server.close();
  });

  it("lists a wall-quarantined skill as manual", async () => {
    const { server, insertActive, fail } = await setup();
    await insertActive("cloudflare");
    await fail("cloudflare", "captcha_blocked"); // 1 wall → quarantined
    const body = await worklist(server);
    const cf = body.items.find((i) => i.service === "cloudflare");
    expect(cf?.status).toBe("quarantined");
    expect(cf?.reason).toBe("wall:captcha_blocked");
    expect(cf?.needs).toBe("manual");
    await server.close();
  });

  it("excludes healthy active skills from the worklist", async () => {
    const { server, insertActive, fail } = await setup();
    await insertActive("render"); // stays active
    await insertActive("neon");
    await fail("neon", "captcha_blocked"); // quarantined
    const body = await worklist(server);
    expect(body.items.find((i) => i.service === "render")).toBeUndefined();
    expect(body.items.find((i) => i.service === "neon")).toBeDefined();
    await server.close();
  });
});
