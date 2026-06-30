// App-level funnel + health gauges for Fly's managed Prometheus/Grafana.
//
// These are counts-only business/adoption numbers (no PII, no secret
// material). They are deliberately served on a SEPARATE private port
// (see metrics-server.ts) that is NOT declared in fly.toml's
// [http_service], so they are reachable only over Fly's 6PN private
// network — never publicly routable. The point is to surface funnel +
// health in the same Grafana that already has HTTP/infra metrics,
// without exposing the production DB.

import type { ApiPrismaClient } from "./api-prisma-client.js";

export interface MetricsSnapshot {
  accounts_total: number;
  machine_tokens_total: number;
  residential_installs_total: number;
  credentials_total: number;
  egress_grants_total: number;
  egress_grants_active: number;
  llm_events_total: number;
  captcha_events_total: number;
  vault_audit_events_total: number;
  db_up: number; // 0 or 1
}

const ZERO_SNAPSHOT: MetricsSnapshot = {
  accounts_total: 0,
  machine_tokens_total: 0,
  residential_installs_total: 0,
  credentials_total: 0,
  egress_grants_total: 0,
  egress_grants_active: 0,
  llm_events_total: 0,
  captcha_events_total: 0,
  vault_audit_events_total: 0,
  db_up: 0,
};

export async function collectMetrics(
  prisma: ApiPrismaClient,
  pingDb: () => Promise<boolean>,
): Promise<MetricsSnapshot> {
  // Gate the counts on a cheap liveness probe: a wedged DB (the 256MB OOM
  // failure mode) would otherwise make every count() hang until timeout.
  // Report db_up=0 + zeros instead of throwing, so the scrape still gets a
  // 200 with an honest signal Grafana can alert on.
  const up = await pingDb();
  if (!up) return { ...ZERO_SNAPSHOT, db_up: 0 };

  const [
    accounts_total,
    machine_tokens_total,
    residential_installs_total,
    credentials_total,
    egress_grants_total,
    egress_grants_active,
    llm_events_total,
    captcha_events_total,
    vault_audit_events_total,
  ] = await Promise.all([
    prisma.account.count({ where: {} }),
    prisma.machineToken.count({ where: {} }),
    prisma.machineToken.count({ where: { asn_class: "residential" } }),
    prisma.credential.count(),
    prisma.egressGrant.count(),
    prisma.egressGrant.count({ where: { revoked_at: null } }),
    prisma.lLMUsageEvent.count(),
    prisma.captchaEvent.count(),
    prisma.vaultAuditEvent.count(),
  ]);

  return {
    accounts_total,
    machine_tokens_total,
    residential_installs_total,
    credentials_total,
    egress_grants_total,
    egress_grants_active,
    llm_events_total,
    captcha_events_total,
    vault_audit_events_total,
    db_up: 1,
  };
}

// Per-gauge HELP text, in emit order. Keeping the order fixed makes the
// golden test stable and the scrape output diff-friendly.
const GAUGES: ReadonlyArray<{ key: keyof MetricsSnapshot; help: string }> = [
  { key: "accounts_total", help: "Total accounts created." },
  { key: "machine_tokens_total", help: "Total machine tokens issued (installs incl. infra/CI)." },
  { key: "residential_installs_total", help: "Machine tokens from residential ASNs (honest external-install signal)." },
  { key: "credentials_total", help: "Total credentials stored in the vault." },
  { key: "egress_grants_total", help: "Total egress grants ever minted." },
  { key: "egress_grants_active", help: "Egress grants not yet revoked." },
  { key: "llm_events_total", help: "Total LLM proxy usage events recorded." },
  { key: "captcha_events_total", help: "Total captcha encounters recorded." },
  { key: "vault_audit_events_total", help: "Total vault audit-trail events recorded." },
  { key: "db_up", help: "1 if the database answered the liveness probe, else 0." },
];

// Escape a string for use as a Prometheus label value: backslash first
// (so we don't double-escape the escapes we add), then double-quote and
// newline (the three chars the text exposition format requires escaped).
function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

// Pure: render a snapshot as Prometheus text exposition format (v0.0.4).
export function renderPrometheus(m: MetricsSnapshot, version: string): string {
  const lines: string[] = [];
  for (const { key, help } of GAUGES) {
    const name = `squire_${key}`;
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} gauge`);
    lines.push(`${name} ${m[key]}`);
  }
  lines.push("# HELP squire_build_info Build metadata; value is always 1, version carried as a label.");
  lines.push("# TYPE squire_build_info gauge");
  lines.push(`squire_build_info{version="${escapeLabelValue(version)}"} 1`);
  // Trailing newline — Prometheus tolerates its absence but the format
  // is line-oriented and tooling expects each sample to end in \n.
  return lines.join("\n") + "\n";
}

// Memoize the last snapshot for ttlMs so frequent scrapes (Prometheus
// defaults to 15s) don't hit the DB on every request. `now` is injected
// so the cache window is deterministically testable.
export function makeCachedCollector(
  collect: () => Promise<MetricsSnapshot>,
  ttlMs: number,
  now: () => number,
): () => Promise<MetricsSnapshot> {
  let cached: { at: number; snapshot: MetricsSnapshot } | null = null;
  return async (): Promise<MetricsSnapshot> => {
    const t = now();
    if (cached !== null && t - cached.at < ttlMs) return cached.snapshot;
    const snapshot = await collect();
    cached = { at: t, snapshot };
    return snapshot;
  };
}
