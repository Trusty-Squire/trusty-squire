// T5 + T6 — operator dashboard Panel 2 (cache-hit + demand) and the
// demand-merged discovery-candidates endpoint. Assert on substring
// presence (markup-resilient), like the other dashboard tests.

import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { buildServer } from "../server.js";
import { InMemorySkillStore } from "../skill-store-memory.js";
import { InMemoryProvisionEventStore } from "../provision-event-store.js";
import { ManifestSigner } from "../signer.js";

const ADMIN_BEARER = "panel2-admin-bearer-1234";

function build() {
  const { privateKey } = generateKeyPairSync("ed25519");
  const signer = ManifestSigner.fromKeyObject(privateKey, "test-signer");
  const skillStore = new InMemorySkillStore();
  const eventStore = new InMemoryProvisionEventStore();
  return {
    eventStore,
    build: () =>
      buildServer({ skillStore, signer, provisionEventStore: eventStore, adminBearer: ADMIN_BEARER }),
  };
}

const ev = (over: Partial<Parameters<InMemoryProvisionEventStore["record"]>[0]>) => ({
  service: "svc",
  status: "success" as const,
  account_id: "acct",
  mcp_version: "0.9.0",
  ...over,
});

async function getAdmin(server: Awaited<ReturnType<ReturnType<typeof build>["build"]>>) {
  return server.inject({ method: "GET", url: `/admin?bearer=${ADMIN_BEARER}` });
}

describe("dashboard — cache-hit panel", () => {
  it("shows the empty state when no events exist", async () => {
    const { build: b } = build();
    const res = await getAdmin(await b());
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("No provisions recorded yet");
  });

  it("renders the dispatch split + low-sample caveat at small N", async () => {
    const { eventStore, build: b } = build();
    await eventStore.record(ev({ initial_strategy: "replay", final_strategy: "replay", replay_outcome: "ok" }));
    await eventStore.record(ev({ initial_strategy: "replay", final_strategy: "bot", replay_outcome: "miss" }));
    await eventStore.record(ev({ status: "failed", initial_strategy: "bot", final_strategy: "bot" }));
    const res = await getAdmin(await b());
    expect(res.body).toContain("Dispatch split");
    expect(res.body).toContain("replay-served");
    expect(res.body).toContain("low sample (N=3)");
  });
});

describe("dashboard — demand panel", () => {
  it("tags a high-demand, no-skill, non-walled service as a harvest candidate", async () => {
    const { eventStore, build: b } = build();
    for (let i = 0; i < 5; i++) {
      await eventStore.record(ev({ service: "supabase", final_strategy: "bot", initial_strategy: "bot" }));
    }
    const res = await getAdmin(await b());
    expect(res.body).toContain("Demand distribution");
    expect(res.body).toContain("supabase");
    // Assert the actual tag markup, not the phrase (the section desc
    // also contains the words "harvest candidate").
    expect(res.body).toContain('class="tag-harvest"');
  });

  it("does NOT tag a wall-dominated service as a harvest candidate", async () => {
    const { eventStore, build: b } = build();
    // 4 failures, all captcha walls → wall_ratio 1.0 → no tag.
    for (let i = 0; i < 4; i++) {
      await eventStore.record(
        ev({ service: "cloudflare", status: "failed", failure_kind: "captcha_blocked", final_strategy: "bot", initial_strategy: "bot" }),
      );
    }
    const res = await getAdmin(await b());
    expect(res.body).toContain("cloudflare");
    // No actual harvest tag rendered (the phrase still appears in the
    // section description, so assert on the tag markup specifically).
    expect(res.body).not.toContain('class="tag-harvest"');
  });
});

describe("GET /admin/discovery-candidates — demand merge (T6)", () => {
  it("surfaces a demand-only service (no failures) with its volume", async () => {
    const { eventStore, build: b } = build();
    for (let i = 0; i < 6; i++) {
      await eventStore.record(ev({ service: "railway", final_strategy: "bot", initial_strategy: "bot" }));
    }
    const server = await b();
    const res = await server.inject({
      method: "GET",
      url: "/admin/discovery-candidates",
      headers: { authorization: `Bearer ${ADMIN_BEARER}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const railway = body.items.find((i: { service: string }) => i.service === "railway");
    expect(railway).toBeDefined();
    expect(railway.volume).toBe(6);
    expect(railway.source).toBe("demand");
  });
});
