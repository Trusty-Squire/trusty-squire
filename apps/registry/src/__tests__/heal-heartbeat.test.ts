// T10 — heal-pass heartbeat + the admin "self-healing loop" status panel.
// The pass POSTs /admin/heal-heartbeat after each run; the dashboard reads
// the latest + its age to show HEALTHY / DOWN.

import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildServer } from "../server.js";
import { InMemorySkillStore } from "../skill-store-memory.js";
import { InMemoryBotFailureStore } from "../bot-failure-store-memory.js";
import { ManifestSigner } from "../signer.js";

const ADMIN_BEARER = "test-admin-bearer-9f8e7d6c";

async function setup() {
  const { privateKey } = generateKeyPairSync("ed25519");
  const signer = ManifestSigner.fromKeyObject(privateKey, "test-signer");
  const store = new InMemorySkillStore();
  const server = await buildServer({
    skillStore: store,
    botFailureStore: new InMemoryBotFailureStore(),
    signer,
    adminBearer: ADMIN_BEARER,
    // SSO unset → bearer-only admin page.
    adminAuth: null,
  });
  return { server, store };
}

function postHeartbeat(server: Awaited<ReturnType<typeof setup>>["server"], body: unknown) {
  return server.inject({
    method: "POST",
    url: "/admin/heal-heartbeat",
    headers: { authorization: `Bearer ${ADMIN_BEARER}`, "content-type": "application/json" },
    payload: body,
  });
}

function dashboard(server: Awaited<ReturnType<typeof setup>>["server"]) {
  return server.inject({ method: "GET", url: `/admin?bearer=${ADMIN_BEARER}` });
}

describe("heal heartbeat + status panel (T10)", () => {
  it("requires the admin bearer to post", async () => {
    const { server } = await setup();
    const res = await server.inject({ method: "POST", url: "/admin/heal-heartbeat", payload: {} });
    expect(res.statusCode).toBe(401);
    await server.close();
  });

  it("records a heartbeat (201) and the dashboard shows HEALTHY + counts", async () => {
    const { server } = await setup();
    const post = await postHeartbeat(server, {
      verified: 12, demoted: 2, quarantined: 1, reskilled: 1, needs_human: 2, mcp_version: "0.8.14",
    });
    expect(post.statusCode).toBe(201);
    expect(post.json().ok).toBe(true);

    const page = await dashboard(server);
    expect(page.statusCode).toBe(200);
    const html = page.body;
    expect(html).toContain("Self-healing loop");
    expect(html).toContain("HEALTHY");
    expect(html).toContain("verified 12");
    expect(html).toContain("re-skilled 1");
    await server.close();
  });

  it("shows DOWN when no heal pass has ever reported", async () => {
    const { server } = await setup();
    const page = await dashboard(server);
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("DOWN");
    await server.close();
  });

  it("shows DOWN when the last heartbeat is stale (>26h)", async () => {
    const { server, store } = await setup();
    // Inject a heartbeat dated 30h ago.
    await store.recordHealRun({
      verified: 5, demoted: 0, quarantined: 0, reskilled: 0, needs_human: 0,
      now: new Date(Date.now() - 30 * 60 * 60 * 1000),
    });
    const page = await dashboard(server);
    expect(page.body).toContain("DOWN");
    await server.close();
  });

  it("coerces non-numeric heartbeat fields to 0", async () => {
    const { server } = await setup();
    const post = await postHeartbeat(server, { verified: "lots", demoted: -3 });
    expect(post.statusCode).toBe(201);
    const page = await dashboard(server);
    expect(page.body).toContain("verified 0");
    await server.close();
  });

  it("records the discovery objective + echoes the active-skill count, and the dashboard trends both", async () => {
    const { server } = await setup();
    // OF#2 — 3 of 10 discover attempts succeeded this pass.
    const post = await postHeartbeat(server, {
      verified: 4, demoted: 0, quarantined: 0, reskilled: 1, needs_human: 0,
      discover_attempted: 10, discover_succeeded: 3,
    });
    expect(post.statusCode).toBe(201);
    // OF#1 — the registry stamps + echoes the active-skill count (0 here, no
    // skills inserted in this bootstrap).
    expect(post.json().skills_active).toBe(0);

    const page = await dashboard(server);
    expect(page.statusCode).toBe(200);
    const html = page.body;
    // The Objective functions panel + the OF#2 rate (3/10 = 30%) trend.
    expect(html).toContain("Objective functions");
    expect(html).toContain("OF#1");
    expect(html).toContain("OF#2");
    expect(html).toContain("30.0%");
    expect(html).toContain("3/10");
    await server.close();
  });
});
