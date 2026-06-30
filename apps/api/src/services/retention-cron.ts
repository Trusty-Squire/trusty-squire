// Retention cron — runs every hour inside the API process.
//
// Schedule:
//   Hourly:
//     - Delete PairingToken older than 1h
//     - Delete VaultAuditEvent older than 365d
//
// Running this in-process is fine for v1: one machine, one schedule.
// When we shard the API, move this to a separate worker or use
// pg_cron.

import type { ApiPrismaClient } from "./api-prisma-client.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export interface RetentionCronDeps {
  authPrisma?: ApiPrismaClient | undefined;
  // Test seam.
  now?: () => Date;
  // Tunables (env-overridable in production).
  pairingTokenRetentionHours?: number;
  vaultAuditRetentionDays?: number;
}

export interface RetentionCronStats {
  pairing_tokens_deleted: number;
  vault_audit_deleted: number;
  duration_ms: number;
  errors: string[];
}

export class RetentionCron {
  private readonly now: () => Date;
  private readonly pairingTokenRetentionHours: number;
  private readonly vaultAuditRetentionDays: number;
  private timer: NodeJS.Timeout | null = null;
  private lastRunAt: Date | null = null;
  private lastStats: RetentionCronStats | null = null;

  constructor(private readonly deps: RetentionCronDeps) {
    this.now = deps.now ?? (() => new Date());
    this.pairingTokenRetentionHours = deps.pairingTokenRetentionHours
      ?? Number.parseInt(process.env.PAIRING_TOKEN_RETENTION_HOURS ?? "1", 10);
    // Vault audit is the security event trail (who-touched-my-keys), so
    // it's kept far longer than ops telemetry — a year by default. Long
    // enough to be useful for an after-the-fact compromise investigation,
    // bounded so the table doesn't grow without limit.
    this.vaultAuditRetentionDays = deps.vaultAuditRetentionDays
      ?? Number.parseInt(process.env.VAULT_AUDIT_RETENTION_DAYS ?? "365", 10);
  }

  // Starts the hourly schedule. Idempotent; calling start() while
  // already running is a no-op.
  start(): void {
    if (this.timer !== null) return;
    // Fire once at startup so a freshly-deployed instance catches up.
    // Don't await — we don't want to block server startup on the cron.
    void this.runOnceWithLog();
    this.timer = setInterval(() => {
      void this.runOnceWithLog();
    }, HOUR_MS);
    // Don't keep the event loop alive solely for the cron — when the
    // server shuts down, this timer doesn't prevent exit.
    this.timer.unref?.();
  }

  private async runOnceWithLog(): Promise<void> {
    const stats = await this.runOnce();
    // Log a single structured line per run so it shows up in fly logs.
    // We avoid pulling in a logger dependency here — plain console.log
    // gets routed correctly by Fastify's stdout pipeline.
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        component: "retention-cron",
        ...stats,
      }),
    );
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  status(): { last_run_at: Date | null; last_stats: RetentionCronStats | null } {
    return { last_run_at: this.lastRunAt, last_stats: this.lastStats };
  }

  // Single run. Public so ops can trigger it via an admin endpoint if
  // needed, and so tests can drive it deterministically.
  async runOnce(): Promise<RetentionCronStats> {
    const startedAt = this.now();
    const stats: RetentionCronStats = {
      pairing_tokens_deleted: 0,
      vault_audit_deleted: 0,
      duration_ms: 0,
      errors: [],
    };

    const pairingCutoff = new Date(startedAt.getTime() - this.pairingTokenRetentionHours * HOUR_MS);
    const vaultAuditCutoff = new Date(startedAt.getTime() - this.vaultAuditRetentionDays * DAY_MS);

    if (this.deps.authPrisma !== undefined) {
      try {
        const r = await this.deps.authPrisma.pairingToken.deleteMany({
          where: { created_at: { lt: pairingCutoff } } as Record<string, unknown>,
        });
        stats.pairing_tokens_deleted = r.count;
      } catch (err) {
        stats.errors.push(`pairing sweep: ${err instanceof Error ? err.message : String(err)}`);
      }

      // Vault audit trail. Append-only security log; rows past the
      // retention horizon are pure history and get trimmed so the table
      // doesn't grow unbounded (it never had a sweep before). Uses
      // emitted_at, which is indexed alongside (account_id, type).
      try {
        const r = await (this.deps.authPrisma.vaultAuditEvent as unknown as {
          deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }>;
        }).deleteMany({ where: { emitted_at: { lt: vaultAuditCutoff } } });
        stats.vault_audit_deleted = r.count;
      } catch (err) {
        stats.errors.push(`vault audit delete: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    stats.duration_ms = this.now().getTime() - startedAt.getTime();
    this.lastRunAt = startedAt;
    this.lastStats = stats;
    return stats;
  }
}
