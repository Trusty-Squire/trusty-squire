// audit_log read-side shaping: a trail dominated by identical proxy-egress
// calls has to render as a handful of rollups with the security-relevant
// lifecycle events and the anomalies still visible, without losing the raw
// stream or the original filters.

import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../api-client.js";
import { auditLogTool } from "../audit-log.js";
import {
  anomalyReason,
  buildEgressRollups,
  buildGrantTotals,
  decodeRollupId,
  encodeRollupId,
  type AuditEvent,
} from "../audit-rollup.js";

const REF = "vault://acct/openrouter";
const HOST = "openrouter.ai";
const T0 = Date.parse("2026-09-03T10:00:00.000Z");

function at(offsetMs: number): string {
  return new Date(T0 + offsetMs).toISOString();
}

// Newest-first, exactly as the server hands the trail back.
function egressBurst(
  count: number,
  opts: { status?: number; startOffsetMs?: number; stepMs?: number; bytes?: number } = {},
): AuditEvent[] {
  const step = opts.stepMs ?? 1_000;
  const start = opts.startOffsetMs ?? 0;
  return Array.from({ length: count }, (_, i) => ({
    id: `p${start}_${i}`,
    type: "vault.proxy_executed",
    emitted_at: at(start - i * step),
    reference: REF,
    requester: "agent",
    target_host: HOST,
    response_status: opts.status ?? 200,
    response_size: opts.bytes ?? 100,
  }));
}

function mockApi(over: Partial<ApiClient>): ApiClient {
  return over as ApiClient;
}

// A single-page listAudit stub: honors `type` / `reference` / `limit` / `before`
// the same way the route does, so filter pass-through is actually exercised.
function pagedApi(all: AuditEvent[], extra: Partial<ApiClient> = {}) {
  const listAudit = vi.fn(
    async (input: { limit?: number; before?: string; type?: string; reference?: string }) => {
      // The route always hands back a newest-first trail; keyset paging is only
      // coherent against that order.
      let rows = [...all].sort((a, b) => Date.parse(b.emitted_at) - Date.parse(a.emitted_at));
      if (input.type !== undefined) rows = rows.filter((e) => e.type === input.type);
      if (input.reference !== undefined) rows = rows.filter((e) => e.reference === input.reference);
      if (input.before !== undefined) {
        const cutoff = Date.parse(input.before);
        rows = rows.filter((e) => Date.parse(e.emitted_at) < cutoff);
      }
      const limit = input.limit ?? 50;
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return {
        events: page,
        next_before: page.length === limit && last !== undefined ? last.emitted_at : null,
      };
    },
  );
  return {
    api: mockApi({ listAudit, ...extra } as Partial<ApiClient>),
    listAudit,
  };
}

interface LedgerResult {
  view: string;
  events: AuditEvent[];
  events_total: number;
  anomaly_count: number;
  scanned: number;
  egress: {
    calls: number;
    rollups: Array<{
      id: string;
      reference: string;
      target_host: string;
      count: number;
      status_breakdown: Record<string, number>;
      total_bytes: number;
      from: string;
      to: string;
      anomaly_count: number;
      grants: Array<{ grant_id: string; label?: string }>;
    }>;
  };
  grant_totals: Array<{
    grant_id: string;
    calls: number;
    total_bytes: number;
    last_used_at: string | null;
  }>;
  summary: string[];
}

async function runLedger(
  api: ApiClient,
  args: Record<string, unknown> = {},
): Promise<LedgerResult> {
  const parsed = auditLogTool.inputSchema.parse(args);
  return (await auditLogTool.handler(parsed, api)) as unknown as LedgerResult;
}

describe("audit_log ledger view", () => {
  it("collapses a page of identical egress calls into one rollup", async () => {
    const { api } = pagedApi(egressBurst(245));
    const res = await runLedger(api);

    expect(res.view).toBe("ledger");
    expect(res.egress.calls).toBe(245);
    expect(res.egress.rollups).toHaveLength(1);
    const rollup = res.egress.rollups[0]!;
    expect(rollup.count).toBe(245);
    expect(rollup.status_breakdown).toEqual({ "200": 245 });
    expect(rollup.total_bytes).toBe(24_500);
    expect(rollup.reference).toBe(REF);
    expect(rollup.target_host).toBe(HOST);
    expect(Date.parse(rollup.from)).toBeLessThan(Date.parse(rollup.to));
    // Routine successful egress does not appear as individual ledger rows.
    expect(res.events).toHaveLength(0);
    expect(res.summary[0]).toContain("245 egress call(s) in 1 rollup(s)");
  });

  it("foregrounds lifecycle events buried under egress noise", async () => {
    const stored: AuditEvent = {
      id: "s1",
      type: "vault.credential_stored",
      emitted_at: at(-500_000),
      reference: REF,
      requester: "user",
      service: "OpenRouter",
    };
    const { api } = pagedApi([...egressBurst(300), stored]);
    const res = await runLedger(api);

    expect(res.events.map((e) => e.id)).toEqual(["s1"]);
    expect(res.events_total).toBe(1);
    expect(res.egress.rollups).toHaveLength(1);
  });

  it("pulls 429s and rejected calls out of the aggregate and marks them", async () => {
    const rateLimited: AuditEvent = {
      ...egressBurst(1, { status: 429, startOffsetMs: -5_000 })[0]!,
      id: "rl1",
    };
    const rejected: AuditEvent = {
      id: "rj1",
      type: "vault.proxy_rejected",
      emitted_at: at(-6_000),
      reference: REF,
      requester: "agent",
      target_host: "evil.example",
    };
    const { api } = pagedApi([...egressBurst(200), rateLimited, rejected]);
    const res = await runLedger(api);

    expect(res.anomaly_count).toBe(2);
    const byId = new Map(res.events.map((e) => [e.id, e]));
    expect(byId.get("rl1")?.anomaly).toBe(true);
    expect(byId.get("rl1")?.anomaly_reason).toBe("rate_limited");
    expect(byId.get("rj1")?.anomaly_reason).toBe("proxy_rejected");
    // The 429 is still counted in its rollup's totals, so the counts are true totals.
    const rollup = res.egress.rollups.find((r) => r.target_host === HOST)!;
    expect(rollup.count).toBe(201);
    expect(rollup.status_breakdown["429"]).toBe(1);
    expect(rollup.anomaly_count).toBe(1);
  });

  it("splits bursts separated by more than the window", async () => {
    const events = [...egressBurst(3), ...egressBurst(3, { startOffsetMs: -3 * 3_600_000 })];
    const { api } = pagedApi(events);
    const res = await runLedger(api, { window_minutes: 60 });
    expect(res.egress.rollups).toHaveLength(2);
    expect(res.egress.rollups.map((r) => r.count)).toEqual([3, 3]);
  });

  it("reports per-grant running totals for an egress grant", async () => {
    const listEgressGrants = vi.fn().mockResolvedValue({
      grants: [
        {
          grant_id: "g1",
          credential_ref: REF,
          rate_limit_per_hour: null,
          spend_cap_usd: null,
          created_at: at(-1_000_000),
          revoked_at: null,
        },
      ],
    });
    const minted: AuditEvent = {
      id: "m1",
      type: "vault.grant_minted",
      emitted_at: at(-1_000_000),
      reference: REF,
      requester: "agent",
      grant_id: "g1",
      label: "openrouter-prod",
    };
    const { api } = pagedApi([...egressBurst(10, { bytes: 500 }), minted], { listEgressGrants });
    const res = await runLedger(api);

    expect(res.grant_totals).toHaveLength(1);
    const totals = res.grant_totals[0]!;
    expect(totals.grant_id).toBe("g1");
    expect(totals.calls).toBe(10);
    expect(totals.total_bytes).toBe(5_000);
    expect(totals.last_used_at).toBe(at(0));
    expect(res.egress.rollups[0]!.grants).toEqual([{ grant_id: "g1", label: "openrouter-prod" }]);
  });

  it("survives an egress-grant lookup failure", async () => {
    const listEgressGrants = vi.fn().mockRejectedValue(new Error("grants down"));
    const { api } = pagedApi(egressBurst(5), { listEgressGrants });
    const res = (await runLedger(api)) as LedgerResult & { attribution: string };
    expect(res.egress.rollups).toHaveLength(1);
    expect(res.grant_totals).toEqual([]);
    expect(res.attribution).toBe("grants_unavailable");
  });

  it("scans deeper than one server page to see past the egress noise", async () => {
    const stored: AuditEvent = {
      id: "s1",
      type: "vault.credential_rotated",
      emitted_at: at(-900_000),
      reference: REF,
      requester: "user",
    };
    const { api, listAudit } = pagedApi([...egressBurst(400), stored]);
    const res = await runLedger(api);
    expect(listAudit.mock.calls.length).toBeGreaterThan(1);
    expect(res.scanned).toBe(401);
    expect(res.events.map((e) => e.id)).toEqual(["s1"]);
  });
});

describe("audit_log drill-down", () => {
  it("expands a rollup back to its individual calls", async () => {
    const { api } = pagedApi(egressBurst(12));
    const ledger = await runLedger(api);
    const id = ledger.egress.rollups[0]!.id;

    const parsed = auditLogTool.inputSchema.parse({ expand: id });
    const res = (await auditLogTool.handler(parsed, api)) as unknown as {
      view: string;
      calls: AuditEvent[];
      calls_total: number;
      rollup: { reference: string; target_host: string };
    };
    expect(res.view).toBe("expand");
    expect(res.calls_total).toBe(12);
    expect(res.calls).toHaveLength(12);
    expect(res.rollup.reference).toBe(REF);
    expect(res.rollup.target_host).toBe(HOST);
  });

  it("stops paging once it is older than the rollup window", async () => {
    // A short burst sitting on top of a long history for the same credential:
    // the drill-down must not walk the whole trail to rebuild one window.
    const burst = egressBurst(5);
    const ancient = egressBurst(600, { startOffsetMs: -10 * 3_600_000 });
    const { api, listAudit } = pagedApi([...burst, ...ancient]);
    const ledger = await runLedger(api, { scan: 200 });
    const newest = ledger.egress.rollups.find((r) => r.count === 5)!;

    listAudit.mockClear();
    const parsed = auditLogTool.inputSchema.parse({ expand: newest.id });
    const res = (await auditLogTool.handler(parsed, api)) as unknown as {
      calls_total: number;
      scanned: number;
    };
    expect(res.calls_total).toBe(5);
    expect(listAudit).toHaveBeenCalledTimes(1);
    expect(res.scanned).toBeLessThanOrEqual(200);
  });

  it("rejects a rollup id it did not mint", async () => {
    const { api } = pagedApi([]);
    const parsed = auditLogTool.inputSchema.parse({ expand: "not-a-rollup" });
    await expect(auditLogTool.handler(parsed, api)).rejects.toThrow(/rollup/i);
  });

  it("round-trips a rollup id", () => {
    const key = { reference: REF, target_host: HOST, from: at(-1000), to: at(0) };
    expect(decodeRollupId(encodeRollupId(key))).toEqual(key);
    expect(decodeRollupId("rollup_zzz")).toBeNull();
  });
});

describe("audit_log backward compatibility", () => {
  it("view:raw returns the flat server page unchanged", async () => {
    const { api, listAudit } = pagedApi(egressBurst(10));
    const parsed = auditLogTool.inputSchema.parse({
      view: "raw",
      limit: 3,
      type: "vault.proxy_executed",
    });
    const res = (await auditLogTool.handler(parsed, api)) as unknown as {
      view: string;
      events: AuditEvent[];
      next_before: string | null;
    };
    expect(res.view).toBe("raw");
    expect(res.events).toHaveLength(3);
    expect(res.next_before).not.toBeNull();
    expect(listAudit).toHaveBeenCalledWith({ limit: 3, type: "vault.proxy_executed" });
  });

  it("still honors type / reference / before filters in the ledger view", async () => {
    const other: AuditEvent = {
      id: "o1",
      type: "vault.credential_stored",
      emitted_at: at(-10_000),
      reference: "vault://acct/other",
      requester: "user",
    };
    const { api, listAudit } = pagedApi([...egressBurst(4), other]);
    const res = await runLedger(api, { reference: "vault://acct/other", before: at(0) });
    expect(listAudit).toHaveBeenCalledWith(
      expect.objectContaining({ reference: "vault://acct/other", before: at(0) }),
    );
    expect(res.events.map((e) => e.id)).toEqual(["o1"]);
    expect(res.egress.calls).toBe(0);
  });

  it("still rejects an out-of-range limit and requires a session", async () => {
    expect(() => auditLogTool.inputSchema.parse({ limit: 9999 })).toThrow();
    await expect(auditLogTool.handler({}, null)).rejects.toThrow(/Trusty Squire session/);
    expect(auditLogTool.annotations?.readOnlyHint).toBe(true);
  });
});

describe("audit_log classification helpers", () => {
  it("treats only verifiably-2xx egress as routine", () => {
    expect(anomalyReason(egressBurst(1)[0]!)).toBeNull();
    expect(anomalyReason(egressBurst(1, { status: 500 })[0]!)).toBe("http_500");
    expect(anomalyReason({ ...egressBurst(1)[0]!, response_status: undefined })).toBe(
      "unknown_status",
    );
    expect(anomalyReason({ ...egressBurst(1)[0]!, proxy_error: "ECONNRESET" })).toBe("proxy_error");
    expect(
      anomalyReason({
        id: "r1",
        type: "vault.credential_retrieved",
        emitted_at: at(0),
        outcome: "rate_limited",
      }),
    ).toBe("outcome_rate_limited");
  });

  it("only attributes egress inside a grant's lifetime", () => {
    const events = [...egressBurst(3), ...egressBurst(3, { startOffsetMs: -100_000 })];
    const totals = buildGrantTotals(events, [
      {
        grant_id: "g1",
        credential_ref: REF,
        created_at: at(-50_000),
        revoked_at: null,
      },
    ]);
    expect(totals[0]!.calls).toBe(3);
  });

  it("groups by target host as well as credential", () => {
    const other = egressBurst(2).map((e) => ({
      ...e,
      id: `x${e.id}`,
      target_host: "api.other.dev",
    }));
    const rollups = buildEgressRollups([...egressBurst(2), ...other], { windowMinutes: 60 });
    expect(rollups).toHaveLength(2);
    expect(new Set(rollups.map((r) => r.target_host))).toEqual(new Set([HOST, "api.other.dev"]));
  });
});
