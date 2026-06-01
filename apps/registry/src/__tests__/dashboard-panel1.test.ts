// T-F2 — Panel 1 render (acquisition funnel + engagement tile) and the
// ProvisionEvent distinct-account stage methods.

import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { buildServer } from "../server.js";
import { InMemorySkillStore } from "../skill-store-memory.js";
import { InMemoryProvisionEventStore } from "../provision-event-store.js";
import { ManifestSigner } from "../signer.js";

const ADMIN_BEARER = "panel1-bearer-abc123";

const apiUp = (async () =>
  new Response(
    JSON.stringify({
      window_start: "2026-05-02T00:00:00.000Z",
      window_end: "2026-06-01T00:00:00.000Z",
      as_of: "2026-06-01T00:00:00.000Z",
      tokens_issued: 2310,
      accounts_created: 1540,
      new_accounts_series: [],
      npm_downloads: 18400,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  )) as unknown as typeof fetch;

const apiDown = (async () => new Response("err", { status: 500 })) as unknown as typeof fetch;

const ev = (over: Partial<Parameters<InMemoryProvisionEventStore["record"]>[0]>) => ({
  service: "svc",
  status: "success" as const,
  account_id: "acct",
  mcp_version: "0.9.0",
  ...over,
});

function build(funnelFetchFn: typeof fetch, withToken = true) {
  const { privateKey } = generateKeyPairSync("ed25519");
  const signer = ManifestSigner.fromKeyObject(privateKey, "test-signer");
  const eventStore = new InMemoryProvisionEventStore();
  return {
    eventStore,
    build: () =>
      buildServer({
        skillStore: new InMemorySkillStore(),
        signer,
        provisionEventStore: eventStore,
        adminBearer: ADMIN_BEARER,
        funnelFetchFn,
        ...(withToken ? { funnelMetricsToken: "ftok", apiBase: "https://api.test" } : {}),
      }),
  };
}

async function getAdmin(server: Awaited<ReturnType<ReturnType<typeof build>["build"]>>) {
  return server.inject({ method: "GET", url: `/admin?bearer=${ADMIN_BEARER}` });
}

describe("Panel 1 — acquisition funnel render", () => {
  it("renders API-side rows + registry stages + engagement tile when the API is up", async () => {
    const { eventStore, build: b } = build(apiUp);
    await eventStore.record(ev({ account_id: "a1", status: "success" }));
    await eventStore.record(ev({ account_id: "a2", status: "failed", failure_kind: "verification_not_sent" }));
    const res = await getAdmin(await b());
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Acquisition funnel");
    expect(res.body).toContain("18,400"); // npm downloads (toLocaleString)
    expect(res.body).toContain("tokens issued");
    expect(res.body).toContain("2,310");
    expect(res.body).toContain("accounts created");
    expect(res.body).toContain("activated");
    expect(res.body).toContain("succeeded");
    // Engagement tile (separate from the funnel).
    expect(res.body).toContain("Engagement");
    expect(res.body).toContain("WAU");
    expect(res.body).toContain("MAU");
    expect(res.body).not.toContain("API metrics unavailable");
  });

  it("fail-soft: API down → API rows 'unavailable' + note, registry stages still render", async () => {
    const { eventStore, build: b } = build(apiDown);
    await eventStore.record(ev({ account_id: "a1", status: "success" }));
    const res = await getAdmin(await b());
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Acquisition funnel");
    expect(res.body).toContain("unavailable");
    expect(res.body).toContain("API metrics unavailable");
    // registry-side stages still present
    expect(res.body).toContain("activated");
    expect(res.body).toContain("Engagement");
  });
});

describe("ProvisionEvent distinct-account stage methods", () => {
  const DAY = 86_400_000;

  it("activeAccounts counts distinct account_id in the window", async () => {
    const store = new InMemoryProvisionEventStore();
    await store.record(ev({ account_id: "a1" }));
    await store.record(ev({ account_id: "a1" })); // same account, dedup
    await store.record(ev({ account_id: "a2", status: "failed" }));
    expect(await store.activeAccounts(30 * DAY)).toBe(2);
  });

  it("succeededAccounts counts only distinct accounts with a success", async () => {
    const store = new InMemoryProvisionEventStore();
    await store.record(ev({ account_id: "a1", status: "success" }));
    await store.record(ev({ account_id: "a2", status: "failed" }));
    await store.record(ev({ account_id: "a3", status: "success" }));
    expect(await store.succeededAccounts(30 * DAY)).toBe(2);
  });
});
