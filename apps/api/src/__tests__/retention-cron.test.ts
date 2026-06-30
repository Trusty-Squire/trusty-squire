// Unit-tests the retention cron's decision math without hitting a real
// database. We feed in a fake auth Prisma client that records the where
// clauses it's asked to operate on; the test asserts the cutoffs are
// correct relative to the configured retention windows.

import { describe, expect, it } from "vitest";
import { RetentionCron } from "../services/retention-cron.js";

interface RecordedCall {
  table: string;
  op: "deleteMany";
  where: Record<string, unknown>;
}

function makeFakes(): {
  authPrisma: NonNullable<ConstructorParameters<typeof RetentionCron>[0]["authPrisma"]>;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  return {
    calls,
    authPrisma: {
      machineToken: {} as never,
      pairingToken: {
        deleteMany: async (args: { where: Record<string, unknown> }) => {
          calls.push({ table: "PairingToken", op: "deleteMany", where: args.where });
          return { count: 2 };
        },
      } as never,
      vaultAuditEvent: {
        deleteMany: async (args: { where: Record<string, unknown> }) => {
          calls.push({ table: "VaultAuditEvent", op: "deleteMany", where: args.where });
          return { count: 5 };
        },
      } as unknown as never,
    } as never,
  };
}

describe("RetentionCron", () => {
  it("computes correct cutoffs for each retention window", async () => {
    const now = new Date("2026-01-15T12:00:00Z");
    const { authPrisma, calls } = makeFakes();
    const cron = new RetentionCron({
      authPrisma,
      now: () => now,
      pairingTokenRetentionHours: 1,
      vaultAuditRetentionDays: 365,
    });

    const stats = await cron.runOnce();

    expect(stats.pairing_tokens_deleted).toBe(2);
    expect(stats.vault_audit_deleted).toBe(5);
    expect(stats.errors).toEqual([]);

    // Vault audit cutoff: now - 365 days
    const vaultAuditDelete = calls.find((c) => c.table === "VaultAuditEvent" && c.op === "deleteMany");
    expect(vaultAuditDelete).toBeDefined();
    const vaultWhere = vaultAuditDelete!.where["emitted_at"] as { lt: Date };
    expect(vaultWhere.lt).toEqual(new Date("2025-01-15T12:00:00Z"));

    // Pairing token cutoff: now - 1 hour
    const pairingDelete = calls.find((c) => c.table === "PairingToken");
    expect(pairingDelete).toBeDefined();
    const pairingWhere = pairingDelete!.where["created_at"] as { lt: Date };
    expect(pairingWhere.lt).toEqual(new Date("2026-01-15T11:00:00Z"));
  });

  it("aggregates errors per section without crashing", async () => {
    const now = new Date("2026-01-15T12:00:00Z");
    const cron = new RetentionCron({
      authPrisma: {
        machineToken: {} as never,
        pairingToken: {
          deleteMany: async () => {
            throw new Error("pairing boom");
          },
        } as never,
        vaultAuditEvent: {
          deleteMany: async () => {
            throw new Error("vault boom");
          },
        } as unknown as never,
      } as never,
      now: () => now,
    });

    const stats = await cron.runOnce();
    expect(stats.errors).toHaveLength(2);
    expect(stats.errors[0]).toMatch(/pairing/);
    expect(stats.errors[1]).toMatch(/vault audit/);
  });

  it("status() exposes last-run state", async () => {
    const now = new Date("2026-01-15T12:00:00Z");
    const { authPrisma } = makeFakes();
    const cron = new RetentionCron({ authPrisma, now: () => now });

    expect(cron.status().last_run_at).toBeNull();
    await cron.runOnce();
    expect(cron.status().last_run_at).toEqual(now);
    expect(cron.status().last_stats?.pairing_tokens_deleted).toBe(2);
  });

  it("does nothing harmful when the Prisma client is absent (in-memory mode)", async () => {
    const cron = new RetentionCron({
      authPrisma: undefined,
      now: () => new Date("2026-01-15T12:00:00Z"),
    });
    const stats = await cron.runOnce();
    expect(stats.pairing_tokens_deleted).toBe(0);
    expect(stats.vault_audit_deleted).toBe(0);
    expect(stats.errors).toEqual([]);
  });
});
