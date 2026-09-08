// Read-side shaping for the vault audit ledger.
//
// The raw trail is a flat per-request stream: every proxied egress call is its
// own `vault.proxy_executed` row with the same reference/host/requester, so a
// few hundred LLM inferences bury the handful of events a human actually
// audits (a credential stored/rotated/deleted, a payment, a rejected call).
// This module groups that stream without touching how events are recorded:
//
//   - routine egress   -> collapsed into per (reference x host x burst) rollups
//   - lifecycle events -> kept as individual ledger rows (the default view)
//   - anomalies        -> pulled back OUT of the aggregate and marked, so a 429
//                         or a rejected call is never hidden by a rollup
//
// New proxy rows carry their grant id directly. Historical rows remain
// readable and use the prior credential-within-grant-lifetime fallback.

export interface AuditEvent {
  id: string;
  type: string;
  emitted_at: string;
  [key: string]: unknown;
}

export interface EgressGrantSummary {
  grant_id: string;
  credential_ref: string;
  created_at: string;
  revoked_at: string | null;
  rate_limit_per_hour?: number | null;
  spend_cap_usd?: number | null;
}

export interface RollupKey {
  reference: string;
  target_host: string;
  from: string;
  to: string;
}

export interface EgressRollup extends RollupKey {
  // Opaque handle a caller feeds back as `expand` to get the individual calls.
  id: string;
  count: number;
  // e.g. { "200": 243, "429": 2 } — every call in the window, anomalies
  // included, so the totals are true totals and not "the successful ones".
  status_breakdown: Record<string, number>;
  error_count: number;
  anomaly_count: number;
  total_bytes: number;
  grants: Array<{ grant_id: string; label?: string }>;
}

export interface GrantTotals {
  grant_id: string;
  credential_ref: string;
  calls: number;
  total_bytes: number;
  last_used_at: string | null;
  status_breakdown: Record<string, number>;
  anomaly_count: number;
  revoked_at: string | null;
  rate_limit_per_hour?: number | null;
  spend_cap_usd?: number | null;
}

// The write side records `vault.proxy_executed`; some callers and fixtures use
// the bare kind. Normalize so classification never depends on the prefix.
export function normalizeAuditType(type: string): string {
  return type.startsWith("vault.") ? type.slice("vault.".length) : type;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function hasStructuredAttribution(event: AuditEvent): boolean {
  const value = event.attribution;
  return (
    value !== null &&
    typeof value === "object" &&
    (value as Record<string, unknown>).caller_missing !== true
  );
}

/** Why this row is actionable, or null when it is routine. */
export function anomalyReason(event: AuditEvent): string | null {
  const kind = normalizeAuditType(event.type);
  if (kind === "proxy_rejected") return "proxy_rejected";
  const outcome = str(event.outcome);
  if (outcome !== null && outcome !== "success") return `outcome_${outcome}`;
  if (kind === "proxy_executed") {
    if (str(event.proxy_error) !== null) return "proxy_error";
    const status = num(event.response_status);
    // No status and no error means we cannot show the call succeeded; only
    // verifiably-2xx traffic is allowed to disappear into an aggregate.
    if (status === null) return "unknown_status";
    if (status === 429) return "rate_limited";
    if (status < 200 || status >= 300) return `http_${status}`;
  }
  const paymentStatus = str(event.payment_status);
  if (paymentStatus !== null && !/^(approved|succeeded|success|captured)$/i.test(paymentStatus)) {
    return `payment_${paymentStatus.toLowerCase()}`;
  }
  return null;
}

/** proxy_executed rows are the high-volume class the rollups collapse. */
export function isEgressCall(event: AuditEvent): boolean {
  return normalizeAuditType(event.type) === "proxy_executed";
}

const ROLLUP_PREFIX = "rollup_";

export function encodeRollupId(key: RollupKey): string {
  const packed = JSON.stringify([key.reference, key.target_host, key.from, key.to]);
  return ROLLUP_PREFIX + Buffer.from(packed, "utf8").toString("base64url");
}

export function decodeRollupId(id: string): RollupKey | null {
  if (!id.startsWith(ROLLUP_PREFIX)) return null;
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(id.slice(ROLLUP_PREFIX.length), "base64url").toString("utf8"),
    );
    if (!Array.isArray(parsed) || parsed.length !== 4) return null;
    const [reference, target_host, from, to] = parsed;
    if (
      typeof reference !== "string" ||
      typeof target_host !== "string" ||
      typeof from !== "string" ||
      typeof to !== "string"
    ) {
      return null;
    }
    return { reference, target_host, from, to };
  } catch {
    return null;
  }
}

function ms(iso: string): number {
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function bump(into: Record<string, number>, key: string): void {
  into[key] = (into[key] ?? 0) + 1;
}

/**
 * Cluster egress calls by (reference x target host), splitting a cluster
 * whenever the gap between adjacent calls exceeds `windowMinutes`. A burst
 * stays one row; a call an hour later starts a new one, so the window a rollup
 * reports is a real burst rather than an arbitrary clock bucket.
 *
 * `events` is newest-first (the ledger's own order); the returned rollups keep
 * that order.
 */
export function buildEgressRollups(
  events: readonly AuditEvent[],
  options: {
    windowMinutes: number;
    grants?: readonly EgressGrantSummary[];
    labels?: Map<string, string>;
  },
): EgressRollup[] {
  const gapMs = options.windowMinutes * 60_000;
  const clusters = new Map<string, AuditEvent[][]>();
  for (const event of events) {
    if (!isEgressCall(event)) continue;
    const reference = str(event.reference) ?? "(unknown)";
    const host = str(event.target_host) ?? "(unknown)";
    const key = `${reference}\0${host}`;
    const groups = clusters.get(key) ?? [];
    const open = groups[groups.length - 1];
    // Newest-first input: an event joins the open cluster while it is within
    // the gap of that cluster's oldest member so far.
    const openOldest = open?.[open.length - 1];
    if (
      open !== undefined &&
      openOldest !== undefined &&
      ms(openOldest.emitted_at) - ms(event.emitted_at) <= gapMs
    ) {
      open.push(event);
    } else {
      groups.push([event]);
    }
    clusters.set(key, groups);
  }

  const rollups: EgressRollup[] = [];
  for (const groups of clusters.values()) {
    for (const group of groups) {
      const newest = group[0];
      const oldest = group[group.length - 1];
      if (newest === undefined || oldest === undefined) continue;
      const reference = str(newest.reference) ?? "(unknown)";
      const target_host = str(newest.target_host) ?? "(unknown)";
      const statuses: Record<string, number> = {};
      let bytes = 0;
      let errors = 0;
      let anomalies = 0;
      for (const event of group) {
        const status = num(event.response_status);
        bump(statuses, status === null ? "unknown" : String(status));
        bytes += num(event.response_size) ?? 0;
        if (str(event.proxy_error) !== null) errors += 1;
        if (anomalyReason(event) !== null) anomalies += 1;
      }
      const key: RollupKey = {
        reference,
        target_host,
        from: oldest.emitted_at,
        to: newest.emitted_at,
      };
      const exactGrantIds = new Set(
        group.map((event) => str(event.grant_id)).filter((id): id is string => id !== null),
      );
      const hasPerEventAttribution = group.some(hasStructuredAttribution);
      const matchingGrants =
        exactGrantIds.size > 0 || hasPerEventAttribution
          ? (options.grants ?? []).filter((grant) => exactGrantIds.has(grant.grant_id))
          : grantsForWindow(options.grants ?? [], reference, key.from, key.to);
      rollups.push({
        ...key,
        id: encodeRollupId(key),
        count: group.length,
        status_breakdown: statuses,
        error_count: errors,
        anomaly_count: anomalies,
        total_bytes: bytes,
        grants: matchingGrants.map((g) => {
          const label = options.labels?.get(g.grant_id);
          return label !== undefined ? { grant_id: g.grant_id, label } : { grant_id: g.grant_id };
        }),
      });
    }
  }
  rollups.sort((a, b) => ms(b.to) - ms(a.to));
  return rollups;
}

function grantsForWindow(
  grants: readonly EgressGrantSummary[],
  reference: string,
  from: string,
  to: string,
): EgressGrantSummary[] {
  return grants.filter(
    (g) =>
      g.credential_ref === reference &&
      ms(g.created_at) <= ms(to) &&
      (g.revoked_at === null || ms(g.revoked_at) >= ms(from)),
  );
}

/**
 * Rolling per-grant totals so a human never sums rows by hand.
 *
 * New rows match the exact grant id. Rows written before provenance existed
 * retain the credential/lifetime fallback so historical totals stay readable.
 */
export function buildGrantTotals(
  events: readonly AuditEvent[],
  grants: readonly EgressGrantSummary[],
): GrantTotals[] {
  return (
    grants
      .map((grant) => {
        const statuses: Record<string, number> = {};
        let calls = 0;
        let bytes = 0;
        let anomalies = 0;
        let lastUsed: string | null = null;
        for (const event of events) {
          if (!isEgressCall(event)) continue;
          const eventGrantId = str(event.grant_id);
          if (eventGrantId !== null && eventGrantId !== grant.grant_id) continue;
          if (eventGrantId === null && hasStructuredAttribution(event)) continue;
          if (str(event.reference) !== grant.credential_ref) continue;
          const at = ms(event.emitted_at);
          if (at < ms(grant.created_at)) continue;
          if (grant.revoked_at !== null && at > ms(grant.revoked_at)) continue;
          calls += 1;
          bytes += num(event.response_size) ?? 0;
          const status = num(event.response_status);
          bump(statuses, status === null ? "unknown" : String(status));
          if (anomalyReason(event) !== null) anomalies += 1;
          if (lastUsed === null || at > ms(lastUsed)) lastUsed = event.emitted_at;
        }
        return {
          grant_id: grant.grant_id,
          credential_ref: grant.credential_ref,
          calls,
          total_bytes: bytes,
          last_used_at: lastUsed,
          status_breakdown: statuses,
          anomaly_count: anomalies,
          revoked_at: grant.revoked_at,
          ...(grant.rate_limit_per_hour !== undefined
            ? { rate_limit_per_hour: grant.rate_limit_per_hour }
            : {}),
          ...(grant.spend_cap_usd !== undefined ? { spend_cap_usd: grant.spend_cap_usd } : {}),
        };
      })
      // A live grant is worth showing even at zero calls (it is standing access);
      // a revoked one with no traffic in the scanned window is just noise.
      .filter((t) => t.calls > 0 || t.revoked_at === null)
  );
}

/** Grant labels recorded on the grant_minted lifecycle event, when in scan. */
export function grantLabels(events: readonly AuditEvent[]): Map<string, string> {
  const labels = new Map<string, string>();
  for (const event of events) {
    if (normalizeAuditType(event.type) !== "grant_minted") continue;
    const id = str(event.grant_id);
    const label = str(event.label) ?? str(event.service);
    if (id !== null && label !== null && !labels.has(id)) labels.set(id, label);
  }
  return labels;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function describeStatuses(breakdown: Record<string, number>): string {
  return Object.entries(breakdown)
    .sort((a, b) => b[1] - a[1])
    .map(([status, count]) => `${count}x${status}`)
    .join(" / ");
}
