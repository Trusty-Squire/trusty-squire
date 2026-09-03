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
  // Gap that splits one egress burst from the next, in minutes.
  window_minutes: z.number().int().min(1).max(1440).optional(),
  // A rollup `id` from a ledger response — returns that rollup's individual calls.
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
  (\`anomaly:true\` with an \`anomaly_reason\` — non-2xx, 429, proxy error,
  rejected call). Routine successful egress is NOT listed here.
- \`egress.rollups\` — routine proxied calls collapsed per credential x target
  host x burst: count, status breakdown, total bytes, first/last timestamp,
  and the grants covering that window. Pass a rollup's \`id\` back as
  \`expand\` to see its individual calls.
- \`grant_totals\` — per egress grant: cumulative calls, bytes, last used.
- \`summary\` — one human-readable line per rollup / headline.

Escape hatches and filters: \`view:"raw"\` returns the flat unaggregated page
(the original shape). \`type\` (an event kind), \`reference\` (a single
credential), \`limit\` (rows, default ${DEFAULT_LIMIT}, max 200), \`before\`
(keyset cursor from \`next_before\`), \`scan\` (raw events read before shaping,
default ${DEFAULT_SCAN}, max 2000) and \`window_minutes\` (burst gap, default
${DEFAULT_WINDOW_MINUTES}) all still apply.`;

export const auditLogTool: Tool<AuditLogArgs> = {
  name: "audit_log",
  description: DESCRIPTION,
  inputSchema,
  jsonInputSchema: {
    type: "object",
    properties: {
      limit: { type: "number" },
      before: { type: "string" },
      type: { type: "string" },
      reference: { type: "string" },
      view: { type: "string", enum: ["ledger", "raw"] },
      scan: { type: "number" },
      window_minutes: { type: "number" },
      expand: { type: "string" },
    },
  },
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
  const egressCalls = events.filter(isEgressCall);
  const grants = await loadGrants(api, egressCalls.length > 0);

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
  });
  const grantTotals = grants === null ? [] : buildGrantTotals(events, grants);

  const oldest = events[events.length - 1];
  const newest = events[0];
  return {
    view: "ledger",
    window: {
      from: oldest?.emitted_at ?? null,
      to: newest?.emitted_at ?? null,
    },
    scanned: events.length,
    // More history exists past the scan — page it with `before: next_before`.
    truncated: next_before !== null,
    next_before,
    events: ledgerRows.slice(0, limit),
    events_total: ledgerRows.length,
    events_truncated: ledgerRows.length > limit,
    anomaly_count: anomalyCount,
    egress: {
      calls: egressCalls.length,
      rolled_up_into: rollups.length,
      window_minutes: windowMinutes,
      rollups,
      ...(rollups.length > 0
        ? {
            hint: 'Pass a rollup\'s `id` as `expand` to list its individual calls, or view:"raw" for the flat stream.',
          }
        : {}),
    },
    grant_totals: grantTotals,
    // Honest about what read-side attribution can and cannot know: the write
    // side records no grant id on a proxied call, so these totals count egress
    // on the grant's credential during its lifetime and include any direct
    // use_credential traffic on that same credential.
    attribution:
      grants === null
        ? "grants_unavailable"
        : "by_credential_reference_within_grant_lifetime (may include direct use_credential calls; per-event grant attribution is a planned follow-up)",
    summary: summarize(ledgerRows.length, anomalyCount, rollups, egressCalls.length),
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

// Drill-down: the individual calls behind one rollup id. Stateless — the id
// carries (reference, host, window), so no server-side rollup state is needed.
async function expandRollup(
  api: ApiClient,
  args: AuditLogArgs,
  expand: string,
): Promise<Record<string, unknown>> {
  const key = decodeRollupId(expand);
  if (key === null) {
    throw new Error(
      "audit_log expand expects a rollup `id` from a ledger response (rollup_…). Call audit_log with no expand first.",
    );
  }
  const limit = args.limit ?? DEFAULT_LIMIT;
  const scan = Math.max(args.scan ?? DEFAULT_SCAN, limit);
  const from = Date.parse(key.from);
  const to = Date.parse(key.to);
  // `before` is exclusive on the server; nudge past the newest member so the
  // rollup's own upper bound is included.
  const cursor = Number.isNaN(to) ? undefined : new Date(to + 1).toISOString();

  const { events } = await scanEvents(
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
  return {
    view: "expand",
    rollup: { id: expand, ...key },
    calls: calls.slice(0, limit).map((event) => {
      const reason = anomalyReason(event);
      return reason === null ? event : { ...event, anomaly: true, anomaly_reason: reason };
    }),
    calls_total: calls.length,
    calls_truncated: calls.length > limit,
    // Raise `limit` (max 200) or narrow `window_minutes` on the ledger call to
    // see the rest of a very large burst.
    scanned: events.length,
  };
}

// Re-exported for the web/CLI surfaces and tests that shape the same trail.
export { normalizeAuditType };
