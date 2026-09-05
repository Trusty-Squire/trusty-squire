// Retention cron — runs every hour inside the API process.
//
// Schedule:
//   Hourly:
//     - Delete PairingToken older than 1h
//     - Delete VaultAuditEvent older than 365d
//     - Delete PaymentAuditEvent older than 365d
//     - Delete PendingPaymentApproval rows past expires_at
//     - Delete CredentialMutationApproval rows past expires_at
//     - Settle + audit, then delete, CredentialFetchApproval rows past
//       expires_at (an abandoned reveal is a terminal outcome, not a row that
//       merely ages out)
//     - Delete TelegramLinkToken rows past expires_at
//
// Running this in-process is fine for v1: one machine, one schedule.
// When we shard the API, move this to a separate worker or use
// pg_cron.

import type { VaultAuditStore } from "@trusty-squire/vault";
import type { ApiPrismaClient } from "./api-prisma-client.js";
import { recordCredentialFetchOutcome } from "./credential-fetch-audit.js";

const HOUR_MS = 60 * 60 * 1000;
// Rows settled per fetch-approval sweep. Bounded because settling writes an
// audit row each; the hourly cadence drains any realistic backlog.
const RETENTION_BATCH = 500;
const DAY_MS = 24 * HOUR_MS;
// Settlement marker written BEFORE the terminal audit and cleared to `expired`
// after it lands. A row wearing it is settled but not yet in the ledger, which
// is what makes the audit write retryable instead of a single chance to record
// an event whose only other evidence is the row itself.
const EXPIRED_UNAUDITED = "expired_unaudited";

export interface RetentionCronDeps {
  authPrisma?: ApiPrismaClient | undefined;
  // Required to sweep fetch approvals: a lapsed reveal must be SETTLED in the
  // ledger before its row is deleted, or "every fetch outcome is audited"
  // silently stops being true for every approval nobody came back for.
  vaultAuditStore?: VaultAuditStore | undefined;
  // Test seam.
  now?: () => Date;
  // Tunables (env-overridable in production).
  pairingTokenRetentionHours?: number;
  vaultAuditRetentionDays?: number;
}

export interface RetentionCronStats {
  pairing_tokens_deleted: number;
  vault_audit_deleted: number;
  payment_audit_deleted: number;
  payment_approvals_deleted: number;
  credential_mutation_approvals_deleted: number;
  credential_fetch_approvals_deleted: number;
  telegram_link_tokens_deleted: number;
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
    this.pairingTokenRetentionHours =
      deps.pairingTokenRetentionHours ??
      Number.parseInt(process.env.PAIRING_TOKEN_RETENTION_HOURS ?? "1", 10);
    // Vault audit is the security event trail (who-touched-my-keys), so
    // it's kept far longer than ops telemetry — a year by default. Long
    // enough to be useful for an after-the-fact compromise investigation,
    // bounded so the table doesn't grow without limit.
    this.vaultAuditRetentionDays =
      deps.vaultAuditRetentionDays ??
      Number.parseInt(process.env.VAULT_AUDIT_RETENTION_DAYS ?? "365", 10);
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

  // A fetch approval nobody ever came back for is still a terminal outcome of a
  // raw-disclosure request, so the row cannot simply be swept: it is settled as
  // `expired` and audited FIRST, and only rows whose audit write succeeded are
  // deleted. Ordering it the other way would lose the event permanently — the
  // row is the only remaining evidence that the request existed.
  //
  // Two races decide whether a row may be settled and whether it may be
  // deleted, and they are NOT the same question:
  //
  //   * the conditional update is the settlement fence. Its `count` is the
  //     answer to "did I settle this?" — approve/deny/claim can land between
  //     the scan and the update, and a sweep that ignored the count would
  //     record an expiry that never happened and delete the real terminal row;
  //   * the audit write is the deletion fence. The row is parked at
  //     EXPIRED_UNAUDITED until its audit persists, and only then becomes
  //     deletable. A row settled straight to `expired` before the audit write
  //     is indistinguishable, on the next run, from one already audited — so a
  //     transient audit-store failure would delete it and erase the event.
  private async sweepCredentialFetchApprovals(
    prisma: ApiPrismaClient,
    startedAt: Date,
  ): Promise<number> {
    const lapsed = await prisma.credentialFetchApproval.findMany({
      where: { expires_at: { lt: startedAt } },
      take: RETENTION_BATCH,
    });
    const deletable: string[] = [];
    for (const row of lapsed) {
      // Settled by an earlier sweep whose audit write did not land. It is ours
      // already — retry the audit, do not re-run the settlement fence.
      const awaitingAudit = row.status === "failed" && row.failure_code === EXPIRED_UNAUDITED;
      if (row.status === "pending" || row.status === "approved" || awaitingAudit) {
        const auditStore = this.deps.vaultAuditStore;
        // No audit sink wired (in-memory dev): leave the row rather than delete
        // an unsettled reveal without a trace of it.
        if (auditStore === undefined) continue;
        if (!awaitingAudit) {
          const settled = await prisma.credentialFetchApproval.updateMany({
            where: { id: row.id, status: { in: ["pending", "approved"] } },
            data: { status: "failed", failure_code: EXPIRED_UNAUDITED },
          });
          // Lost the race: approve, deny or claim settled this row between the
          // scan and here, and wrote its own terminal audit. There was no
          // expiry to record, and the status we read is stale — leave the row
          // for the next sweep to delete against its real terminal state.
          if (settled.count === 0) continue;
        }
        await recordCredentialFetchOutcome(
          auditStore,
          {
            id: row.id,
            accountId: row.account_id,
            credentialReference: row.credential_reference,
            credentialService: row.credential_service,
            credentialLabel: row.credential_label,
            requesterKind: row.requester_kind === "web" ? "web" : "agent",
          },
          "expired",
        );
        // Audited. Only now may the row be deleted; until this lands, a later
        // sweep re-enters the branch above rather than sweeping it away.
        await prisma.credentialFetchApproval.updateMany({
          where: { id: row.id, failure_code: EXPIRED_UNAUDITED },
          data: { failure_code: "expired" },
        });
      }
      deletable.push(row.id);
    }
    if (deletable.length === 0) return 0;
    const deleted = await prisma.credentialFetchApproval.deleteMany({
      where: { id: { in: deletable } },
    });
    return deleted.count;
  }

  // Single run. Public so ops can trigger it via an admin endpoint if
  // needed, and so tests can drive it deterministically.
  async runOnce(): Promise<RetentionCronStats> {
    const startedAt = this.now();
    const stats: RetentionCronStats = {
      pairing_tokens_deleted: 0,
      vault_audit_deleted: 0,
      payment_audit_deleted: 0,
      payment_approvals_deleted: 0,
      credential_mutation_approvals_deleted: 0,
      credential_fetch_approvals_deleted: 0,
      telegram_link_tokens_deleted: 0,
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
        const r = await (
          this.deps.authPrisma.vaultAuditEvent as unknown as {
            deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }>;
          }
        ).deleteMany({ where: { emitted_at: { lt: vaultAuditCutoff } } });
        stats.vault_audit_deleted = r.count;
      } catch (err) {
        stats.errors.push(
          `vault audit delete: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      try {
        const r = await this.deps.authPrisma.paymentAuditEvent.deleteMany({
          where: { created_at: { lt: vaultAuditCutoff } },
        });
        stats.payment_audit_deleted = r.count;
      } catch (err) {
        stats.errors.push(
          `payment audit delete: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      try {
        const r = await this.deps.authPrisma.pendingPaymentApproval.deleteMany({
          where: { expires_at: { lt: startedAt } },
        });
        stats.payment_approvals_deleted = r.count;
      } catch (err) {
        stats.errors.push(
          `payment approval delete: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      try {
        const r = await this.deps.authPrisma.credentialMutationApproval.deleteMany({
          where: { expires_at: { lt: startedAt } },
        });
        stats.credential_mutation_approvals_deleted = r.count;
      } catch (err) {
        stats.errors.push(
          `credential mutation approval delete: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      try {
        stats.credential_fetch_approvals_deleted = await this.sweepCredentialFetchApprovals(
          this.deps.authPrisma,
          startedAt,
        );
      } catch (err) {
        stats.errors.push(
          `credential fetch approval delete: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      try {
        const r = await this.deps.authPrisma.telegramLinkToken.deleteMany({
          where: { expires_at: { lt: startedAt } },
        });
        stats.telegram_link_tokens_deleted = r.count;
      } catch (err) {
        stats.errors.push(
          `telegram link token delete: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    stats.duration_ms = this.now().getTime() - startedAt.getTime();
    this.lastRunAt = startedAt;
    this.lastStats = stats;
    return stats;
  }
}
