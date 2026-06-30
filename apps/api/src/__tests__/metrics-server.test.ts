import { afterEach, describe, expect, it } from "vitest";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { startMetricsServer } from "../metrics-server.js";
import type { MetricsSnapshot } from "../services/metrics.js";

const SNAPSHOT: MetricsSnapshot = {
  accounts_total: 3,
  machine_tokens_total: 4,
  residential_installs_total: 1,
  credentials_total: 2,
  egress_grants_total: 1,
  egress_grants_active: 1,
  llm_events_total: 0,
  captcha_events_total: 0,
  vault_audit_events_total: 0,
  db_up: 1,
};

let server: http.Server | null = null;

afterEach(async () => {
  if (server !== null) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
  }
});

function portOf(s: http.Server): number {
  const addr = s.address() as AddressInfo;
  return addr.port;
}

async function startOnEphemeral(
  collect: () => Promise<MetricsSnapshot>,
): Promise<number> {
  // port 0 → OS picks a free port; wait for the listener to be bound.
  server = startMetricsServer({ port: 0, collect, version: "9.9.9" });
  await new Promise<void>((resolve) => server?.once("listening", () => resolve()));
  return portOf(server);
}

describe("startMetricsServer", () => {
  it("GET /metrics → 200 text exposition containing the gauges", async () => {
    const port = await startOnEphemeral(() => Promise.resolve(SNAPSHOT));
    const res = await fetch(`http://127.0.0.1:${port}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; version=0.0.4");
    const body = await res.text();
    expect(body).toContain("squire_accounts_total 3");
    expect(body).toContain('squire_build_info{version="9.9.9"} 1');
  });

  it("any other path → 404", async () => {
    const port = await startOnEphemeral(() => Promise.resolve(SNAPSHOT));
    const res = await fetch(`http://127.0.0.1:${port}/other`);
    expect(res.status).toBe(404);
  });

  it("collect error → 503", async () => {
    const port = await startOnEphemeral(() => Promise.reject(new Error("db wedged")));
    const res = await fetch(`http://127.0.0.1:${port}/metrics`);
    expect(res.status).toBe(503);
  });
});
