import { z } from "zod";
import { assertApi, type Tool } from "./index.js";
import { ALWAYS_LOAD_META } from "./always-load.js";
import type { ApiClient } from "../api-client.js";
import {
  anomalyReason,
  buildEgressRollups,
  buildGrantTotals,
  decodeRollupId,
  describeStatuses,
  formatBytes,
  grantLabels,
  isEgressCall,
  normalizeAuditType,
  type AuditEvent,
  type EgressGrantSummary,
  type DailyTotal,
} from "./audit-rollup.js";

// The who-touched-my-keys ledger. Every vault action — stored / retrieved /
// rotated / deleted / proxy_executed / proxy_rejected — newest first, keyset-
// paginated by the `before` cursor. Payloads carry NO secret values; this is
// strictly less than what list_credentials already exposes, so the account's
// own agent can read it (same account boundary as the human's web UI).
//
// Read-side shaping (see audit-rollup.ts): the default `ledger` view keeps the
// security-relevant lifecycle events as rows, collapses routine egress traffic
// into per (credential x host x burst) rollups, and pulls anomalies back out of
// those rollups so a 429 or a rejected call is never hidden. `view: "raw"` is
// the unaggregated escape hatch and returns exactly the server's page.
const inputSchema = z.object({
  limit: z.number().int().min(1).max(200).optional(),
  before: z.string().min(1).optional(),
  type: z.string().min(1).optional(),
  reference: z.string().min(1).optional(),
  // "ledger" (default) groups; "raw" is the flat per-request stream.
  view: z.enum(["ledger", "raw"]).optional(),
  // How many raw events the ledger view reads before shaping them. The point
  // of the rollup is to see past a page of near-identical egress calls, so the
  // scan is deliberately deeper than `limit`.
  scan: z.number().int().min(1).max(2000).optional(),
  // Historical per-call rows retain the old burst grouping.
  window_minutes: z.number().int().min(1).max(1440).optional(),
  // A rollup `id` from a ledger response — returns daily totals or historical calls.
  expand: z.string().min(1).optional(),
});

type AuditLogArgs = z.infer<typeof inputSchema>;

const DEFAULT_LIMIT = 50;
const DEFAULT_SCAN = 500;
const DEFAULT_WINDOW_MINUTES = 60;
const API_PAGE_MAX = 200;

const DESCRIPTION = `Read the vault audit ledger — "show me everything that touched my keys."
Account-scoped, newest-first, NO secret values ever.

By default (\`view:"ledger"\`) the response is SHAPED so it is readable:
- \`events\` — the security ledger: credential stored / rotated / deleted /
  edited, grants minted / revoked, payments, plus every ANOMALY
  (\`anomaly:true\` with an \`anomaly_reason\` — HTTP 4xx/5xx, proxy error,
  rejected call). Routine successful egress is NOT listed here.
- \`egress.rollups\` — successful proxied calls collapsed per credential x
  target host x UTC day: count, status breakdown, total bytes, first/last
  timestamp, and grants. Historical calls retain burst grouping. Pass \`id\`
  as \`expand\` to see daily totals or historical calls.
- \`grant_totals\` — per egress grant: cumulative calls, bytes, last used.
- \`summary\` — one human-readable line per rollup / headline.

Escape hatches and filters: \`view:"raw"\` returns the flat unaggregated page
(individual security and failed-call rows). \`type\` (an event kind), \`reference\` (a single
credential), \`limit\` (rows, default ${DEFAULT_LIMIT}, max 200), \`before\`
(keyset cursor from \`next_before\`), \`scan\` (source rows read before shaping,
default ${DEFAULT_SCAN}, max 2000) and \`window_minutes\` (historical burst gap,
default ${DEFAULT_WINDOW_MINUTES}) are available.`;

export const auditLogTool: Tool<AuditLogArgs> = {
  name: "audit_log",
  description: DESCRIPTION,
  inputSchema,
  annotations: { readOnlyHint: true },
  meta: ALWAYS_LOAD_META,
  async handler(args, api) {
    assertApi(api);
    if (args.expand !== undefined) return expandRollup(api, args, args.expand);
    if (args.view === "raw") {
      const page = await api.listAudit(passthroughFilters(args));
      return { view: "raw", ...page };
    }
    return buildLedgerView(api, args);
  },
};

function passthroughFilters(args: AuditLogArgs): {
  limit?: number;
  before?: string;
  type?: string;
  reference?: string;
} {
  return {
    ...(args.limit !== undefined ? { limit: args.limit } : {}),
    ...(args.before !== undefined ? { before: args.before } : {}),
    ...(args.type !== undefined ? { type: args.type } : {}),
    ...(args.reference !== undefined ? { reference: args.reference } : {}),
  };
}

// Page the server's keyset cursor until `scan` events are read or the trail
// ends. Returns the cursor to continue from, so a caller can keep walking back.
async function scanEvents(
  api: ApiClient,
  filters: { before?: string; type?: string; reference?: string },
  scan: number,
  // Stop paging once the trail is older than this (epoch ms). The drill-down
  // knows its window's lower bound, so it should not walk a credential's whole
  // history to rebuild one burst.
  until?: number,
): Promise<{ events: AuditEvent[]; next_before: string | null }> {
  const events: AuditEvent[] = [];
  let cursor = filters.before ?? null;
  for (;;) {
    const page = await api.listAudit({
      limit: Math.min(API_PAGE_MAX, scan - events.length),
      ...(cursor !== null ? { before: cursor } : {}),
      ...(filters.type !== undefined ? { type: filters.type } : {}),
      ...(filters.reference !== undefined ? { reference: filters.reference } : {}),
    });
    events.push(...page.events);
    cursor = page.next_before;
    if (cursor === null || page.events.length === 0 || events.length >= scan) break;
    if (until !== undefined && Date.parse(cursor) < until) break;
  }
  return { events, next_before: cursor };
}

// Egress grants give the rollups their "which standing access spent this key"
// context. Best-effort: an account with no egress at all should not pay for the
// extra call, and a failure here must not sink the whole ledger read.
async function loadGrants(api: ApiClient, needed: boolean): Promise<EgressGrantSummary[] | null> {
  if (!needed) return [];
  try {
    const { grants } = await api.listEgressGrants();
    return grants.map((g) => ({
      grant_id: g.grant_id,
      credential_ref: g.credential_ref,
      created_at: g.created_at,
      revoked_at: g.revoked_at,
      rate_limit_per_hour: g.rate_limit_per_hour,
      spend_cap_usd: g.spend_cap_usd,
    }));
  } catch {
    return null;
  }
}

async function buildLedgerView(
  api: ApiClient,
  args: AuditLogArgs,
): Promise<Record<string, unknown>> {
  const limit = args.limit ?? DEFAULT_LIMIT;
  const scan = Math.max(args.scan ?? DEFAULT_SCAN, limit);
  const windowMinutes = args.window_minutes ?? DEFAULT_WINDOW_MINUTES;

  const { events, next_before } = await scanEvents(
    api,
    {
      ...(args.before !== undefined ? { before: args.before } : {}),
      ...(args.type !== undefined ? { type: args.type } : {}),
      ...(args.reference !== undefined ? { reference: args.reference } : {}),
    },
    scan,
  );
  const dailyPage =
    (args.type === undefined || normalizeAuditType(args.type) === "proxy_executed") &&
    typeof api.listAuditDaily === "function"
      ? await api.listAuditDaily({
          limit: scan,
          ...(args.before !== undefined ? { before: args.before } : {}),
          ...(args.reference !== undefined ? { reference: args.reference } : {}),
        })
      : { totals: [] as DailyTotal[], next_before: null };
  const dailyTotals = dailyPage.totals;
  const egressCalls = events.filter(isEgressCall);
  const grants = await loadGrants(api, egressCalls.length > 0 || dailyTotals.length > 0);

  // Ledger rows: everything that is not routine egress. An egress call that
  // failed, was rate-limited, or errored is pulled back out of the aggregate
  // and marked, so the actionable rows are visible without expanding anything.
  const ledgerRows: AuditEvent[] = [];
  let anomalyCount = 0;
  for (const event of events) {
    const reason = anomalyReason(event);
    if (reason !== null) anomalyCount += 1;
    if (isEgressCall(event) && reason === null) continue;
    ledgerRows.push(reason === null ? event : { ...event, anomaly: true, anomaly_reason: reason });
  }

  const labels = grantLabels(events);
  const rollups = buildEgressRollups(events, {
    windowMinutes,
    ...(grants !== null ? { grants } : {}),
    labels,
    dailyTotals,
  });
  const grantTotals = grants === null ? [] : buildGrantTotals(events, grants, dailyTotals);

  const times = [...events.map((e) => e.emitted_at), ...dailyTotals.map((t) => t.last_at)].sort();
  const oldest = times[0];
  const newest = times.at(-1);
  // A single timestamp cursor cannot encode independent stream positions.
  // Resume from the newer cursor so no unseen row is skipped; a later page
  // may repeat a few rows from the stream that advanced further.
  const cursor =
    [next_before, dailyPage.next_before]
      .filter((v): v is string => v !== null)
      .sort()
      .at(-1) ?? null;
  return {
    view: "ledger",
    window: {
      from: oldest ?? null,
      to: newest ?? null,
    },
    scanned: events.length + dailyTotals.length,
    // More history exists past the scan — page it with `before: next_before`.
    truncated: cursor !== null,
    next_before: cursor,
    events: ledgerRows.slice(0, limit),
    events_total: ledgerRows.length,
    events_truncated: ledgerRows.length > limit,
    anomaly_count: anomalyCount,
    egress: {
      calls: egressCalls.length + dailyTotals.reduce((n, t) => n + t.calls, 0),
      rolled_up_into: rollups.length,
      window_minutes: windowMinutes,
      rollups,
      ...(rollups.length > 0
        ? {
            hint: "Pass a rollup's `id` as `expand` to inspect daily totals or historical calls.",
          }
        : {}),
    },
    grant_totals: grantTotals,
    attribution:
      grants === null
        ? "grants_unavailable"
        : "per_event (historical rows without provenance use credential-reference/lifetime fallback)",
    summary: summarize(
      ledgerRows.length,
      anomalyCount,
      rollups,
      egressCalls.length + dailyTotals.reduce((n, t) => n + t.calls, 0),
    ),
  };
}

function summarize(
  ledgerRows: number,
  anomalies: number,
  rollups: ReturnType<typeof buildEgressRollups>,
  egressCalls: number,
): string[] {
  const lines = [
    `${ledgerRows} ledger event(s), ${anomalies} anomaly(ies), ${egressCalls} egress call(s) in ${rollups.length} rollup(s)`,
  ];
  for (const r of rollups.slice(0, 20)) {
    const marker = r.anomaly_count > 0 ? ` [${r.anomaly_count} anomaly]` : "";
    lines.push(
      `${r.target_host} via ${r.reference}: ${r.count} call(s) (${describeStatuses(r.status_breakdown)}), ${formatBytes(r.total_bytes)}, ${r.from} → ${r.to}${marker}`,
    );
  }
  return lines;
}

// Drill-down: daily totals or historical calls behind one rollup id. The id
// carries (reference, host, window), so no server-side state is needed.
async function expandRollup(
  api: ApiClient,
  args: AuditLogArgs,
  expand: string,
): Promise<Record<string, unknown>> {
  const key = decodeRollupId(expand);
  if (key === null) {
    throw new Error(
      "audit_log expand expects a rollup `id` from a ledger response (daily_… or rollup_…). Call audit_log with no expand first.",
    );
  }
  const limit = args.limit ?? DEFAULT_LIMIT;
  const scan = Math.max(args.scan ?? DEFAULT_SCAN, limit);
  const from = Date.parse(key.from);
  const to = Date.parse(key.to);
  // `before` is exclusive on the server; nudge past the newest member so the
  // rollup's own upper bound is included.
  const cursor = Number.isNaN(to) ? undefined : new Date(to + 1).toISOString();

  const { events } = key.daily
    ? { events: [] as AuditEvent[] }
    : await scanEvents(
        api,
        { reference: key.reference, ...(cursor !== undefined ? { before: cursor } : {}) },
        scan,
        Number.isNaN(from) ? undefined : from,
      );
  const calls = events.filter((event) => {
    if (!isEgressCall(event)) return false;
    if (event.target_host !== key.target_host) return false;
    const at = Date.parse(event.emitted_at);
    return !Number.isNaN(at) && at >= from && at <= to;
  });
  // Daily counters grow during the day; use the UTC day boundary rather than
  // the rollup's last-call timestamp so an older rollup id stays expandable.
  const dailyCursor = Number.isNaN(to)
    ? undefined
    : new Date(
        Date.UTC(
          new Date(to).getUTCFullYear(),
          new Date(to).getUTCMonth(),
          new Date(to).getUTCDate() + 1,
        ),
      ).toISOString();
  const dailyPage =
    key.daily && typeof api.listAuditDaily === "function"
      ? await api.listAuditDaily({
          reference: key.reference,
          ...(dailyCursor !== undefined ? { before: dailyCursor } : {}),
          limit: Math.min(scan, 2000),
        })
      : { totals: [] as DailyTotal[], next_before: null };
  const dailyTotals = dailyPage.totals.filter(
    (total) =>
      total.target_host === key.target_host &&
      total.day >= key.from.slice(0, 10) &&
      total.day <= key.to.slice(0, 10),
  );
  return {
    view: "expand",
    rollup: { id: expand, ...key },
    daily_totals: dailyTotals.slice(0, limit),
    calls: calls.slice(0, limit).map((event) => {
      const reason = anomalyReason(event);
      return reason === null ? event : { ...event, anomaly: true, anomaly_reason: reason };
    }),
    calls_total: calls.length + dailyTotals.reduce((n, t) => n + t.calls, 0),
    calls_truncated: calls.length > limit || dailyTotals.length > limit,
    // Raise `limit` (max 200) or narrow `window_minutes` on the ledger call to
    // see the rest of a very large burst.
    scanned: events.length + dailyTotals.length,
  };
}

// Re-exported for the web/CLI surfaces and tests that shape the same trail.
export { normalizeAuditType };
