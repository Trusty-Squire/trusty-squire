// Panel 1 acquisition-funnel: API-side counts (accounts + machine
// tokens) for GET /v1/admin/funnel. See
// docs/ARCHITECTURE.md. Counts only, no PII — the
// registry stitches these together with its own ProvisionEvent stages.

import type { ApiPrismaClient } from "./api-prisma-client.js";

export interface FunnelWindow {
  start: Date;
  end: Date;
}

export interface NewAccountsDay {
  date: string; // YYYY-MM-DD (UTC)
  count: number;
}

export interface FunnelApiCounts {
  tokens_issued: number; // MachineToken.created_at in window (NOT "installs")
  // Real external installs: MachineToken with asn_class='residential' in the
  // window. tokens_issued is dominated by our own datacenter/infra tokens
  // (housekeeper, CI, dev re-installs), so this is the honest adoption signal.
  residential_installs: number;
  accounts_created: number; // Account.created_at in window
  new_accounts_series: NewAccountsDay[];
}

export interface FunnelStatsStore {
  // `excludeAccountIds` drops test/demo/seed accounts from the account
  // counts so internal usage doesn't inflate the funnel.
  apiCounts(window: FunnelWindow, excludeAccountIds: readonly string[]): Promise<FunnelApiCounts>;
}

// Pure: bucket account-creation timestamps into per-UTC-day counts,
// ascending by date. Exported for unit testing.
export function bucketByDay(dates: readonly Date[]): NewAccountsDay[] {
  const buckets = new Map<string, number>();
  for (const d of dates) {
    const key = d.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  return [...buckets.entries()]
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

function accountWhere(window: FunnelWindow, excludeAccountIds: readonly string[]): Record<string, unknown> {
  const where: Record<string, unknown> = {
    created_at: { gte: window.start, lte: window.end },
  };
  if (excludeAccountIds.length > 0) {
    where.id = { notIn: [...excludeAccountIds] };
  }
  return where;
}

export class PrismaFunnelStatsStore implements FunnelStatsStore {
  constructor(private readonly prisma: ApiPrismaClient) {}

  async apiCounts(window: FunnelWindow, excludeAccountIds: readonly string[]): Promise<FunnelApiCounts> {
    const where = accountWhere(window, excludeAccountIds);
    const [tokens_issued, residential_installs, accounts_created, rows] = await Promise.all([
      this.prisma.machineToken.count({
        where: { created_at: { gte: window.start, lte: window.end } },
      }),
      this.prisma.machineToken.count({
        where: {
          created_at: { gte: window.start, lte: window.end },
          asn_class: "residential",
        },
      }),
      this.prisma.account.count({ where }),
      this.prisma.account.findMany({ where, orderBy: { created_at: "asc" } }),
    ]);
    return {
      tokens_issued,
      residential_installs,
      accounts_created,
      new_accounts_series: bucketByDay(rows.map((r) => r.created_at)),
    };
  }
}

// No-DB fallback (local dev / in-memory deps). The funnel is a
// production operator feature; without AUTH_DATABASE_URL it reports
// zeros rather than failing the endpoint.
export class ZeroFunnelStatsStore implements FunnelStatsStore {
  async apiCounts(): Promise<FunnelApiCounts> {
    return { tokens_issued: 0, residential_installs: 0, accounts_created: 0, new_accounts_series: [] };
  }
}
