// provision-gate-dossier.test.ts — the registry half of the refuse-walled
// e2e. Proves GET /v1/services/:slug/dossier serves the exact ServiceState
// contract the MCP refuse-gate consumes (wall_classification + last_failure_kind),
// produced the real way: a failed phone attempt drives the projection, the heal
// overlay marks the wall. The MCP side (provision-gate.test.ts) proves the
// client parses this shape and the gate refuses on it.

import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { buildServer } from "../server.js";
import { InMemorySkillStore } from "../skill-store-memory.js";
import { InMemoryProvisionEventStore } from "../provision-event-store.js";
import { InMemoryServiceStateStore } from "../service-state-store.js";
import { ManifestSigner } from "../signer.js";

async function harness() {
  const { privateKey } = generateKeyPairSync("ed25519");
  const stateStore = new InMemoryServiceStateStore();
  const server = await buildServer({
    skillStore: new InMemorySkillStore(),
    signer: ManifestSigner.fromKeyObject(privateKey, "test-signer"),
    provisionEventStore: new InMemoryProvisionEventStore(),
    serviceStateStore: stateStore,
  });
  return { server, stateStore };
}

describe("GET /dossier serves the refuse-gate's ServiceState contract", () => {
  it("a phone failure + heal wall overlay surfaces wall_classification + last_failure_kind", async () => {
    const { server, stateStore } = await harness();

    // 1. The bot reports a phone-gated failure — drives the projection.
    const post = await server.inject({
      method: "POST",
      url: "/v1/services/stripe/attempts",
      payload: { status: "failed", failure_kind: "phone", mcp_version: "test" },
    });
    expect(post.statusCode).toBe(201);

    // 2. The heal pass marks it a (falsified) wall — the overlay half.
    await stateStore.patchOverlay("stripe", { wall_classification: "wall" });

    // 3. The dossier serves both halves — exactly what the MCP client reads.
    const res = await server.inject({ method: "GET", url: "/v1/services/stripe/dossier" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      state: { wall_classification: string | null; last_failure_kind: string | null } | null;
    };
    expect(body.state).not.toBeNull();
    expect(body.state?.wall_classification).toBe("wall");
    expect(body.state?.last_failure_kind).toBe("phone");

    await server.close();
  });

  it("an unknown service returns state: null (the gate then fails open)", async () => {
    const { server } = await harness();
    const res = await server.inject({ method: "GET", url: "/v1/services/never-seen/dossier" });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { state: unknown }).state).toBeNull();
    await server.close();
  });
});
