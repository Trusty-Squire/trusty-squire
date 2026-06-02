// T5 — the demotion→rediscovery handoff. A freshly-demoted (rot) skill's
// service must surface as a discovery candidate REGARDLESS of demand, so
// the chained loop re-skills it. A quarantined (wall) service must NOT —
// it's routed to the human pile.

import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildServer } from "../server.js";
import { InMemorySkillStore } from "../skill-store-memory.js";
import { InMemoryBotFailureStore } from "../bot-failure-store-memory.js";
import { ManifestSigner } from "../signer.js";
import type { Skill } from "@trusty-squire/skill-schema";
import { SKILL_SCHEMA_VERSION, type SkillStatus } from "@trusty-squire/skill-schema";

const ADMIN_BEARER = "test-admin-bearer-9f8e7d6c";

function skillFor(service: string, status: SkillStatus): Skill {
  return {
    schema_version: SKILL_SCHEMA_VERSION,
    service,
    version: "v1",
    skill_id: `01REDISC${service.toUpperCase().padEnd(18, "0").slice(0, 18)}`,
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
    status,
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
  const skillStore = new InMemorySkillStore();
  const botFailureStore = new InMemoryBotFailureStore();
  const server = await buildServer({ skillStore, botFailureStore, signer, adminBearer: ADMIN_BEARER });
  const insert = (svc: string, status: SkillStatus) =>
    skillStore.insert({ skill: skillFor(svc, status), signature: "x".repeat(64), signed_at: new Date(), signed_by: "test" });
  return { server, insert };
}

async function candidates(server: Awaited<ReturnType<typeof setup>>["server"]): Promise<Array<{ service: string; source?: string }>> {
  const res = await server.inject({
    method: "GET",
    url: "/admin/discovery-candidates",
    headers: { authorization: `Bearer ${ADMIN_BEARER}` },
  });
  expect(res.statusCode).toBe(200);
  return res.json().items;
}

describe("GET /admin/discovery-candidates — demotion→rediscovery (T5)", () => {
  it("surfaces a demoted service as a candidate with zero demand", async () => {
    const { server, insert } = await setup();
    await insert("neon", "demoted");
    const items = await candidates(server);
    const neon = items.find((i) => i.service === "neon");
    expect(neon).toBeDefined();
    expect(neon?.source).toBe("demoted");
    await server.close();
  });

  it("does NOT surface a quarantined (wall) service", async () => {
    const { server, insert } = await setup();
    await insert("openai", "quarantined");
    const items = await candidates(server);
    expect(items.find((i) => i.service === "openai")).toBeUndefined();
    await server.close();
  });

  it("does NOT surface a service with an active skill", async () => {
    const { server, insert } = await setup();
    await insert("render", "active");
    const items = await candidates(server);
    expect(items.find((i) => i.service === "render")).toBeUndefined();
    await server.close();
  });

  it("demoted candidates rank ahead of demand-only candidates", async () => {
    const { server, insert } = await setup();
    await insert("neon", "demoted");
    const items = await candidates(server);
    expect(items[0]?.service).toBe("neon");
    await server.close();
  });
});
