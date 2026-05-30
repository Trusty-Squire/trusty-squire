// Unit-tests the retention cron's decision math without hitting a real
// database. We feed in fake Prisma clients that record the where
// clauses they're asked to operate on; the test asserts the cutoffs
// are correct relative to the configured retention windows.

import { describe, expect, it } from "vitest";
import { RetentionCron } from "../services/retention-cron.js";

interface RecordedCall {
  table: string;
  op: "updateMany" | "deleteMany";
  where: Record<string, unknown>;
  data?: Record<string, unknown>;
}

function makeFakes(): {
  inboxPrisma: NonNullable<ConstructorParameters<typeof RetentionCron>[0]["inboxPrisma"]>;
  authPrisma: NonNullable<ConstructorParameters<typeof RetentionCron>[0]["authPrisma"]>;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  return {
    calls,
    inboxPrisma: {
      receivedEmail: {
        updateMany: async (args) => {
          calls.push({ table: "ReceivedEmail", op: "updateMany", where: args.where, data: args.data });
          return { count: 3 };
        },
        deleteMany: async (args) => {
          calls.push({ table: "ReceivedEmail", op: "deleteMany", where: args.where });
          return { count: 1 };
        },
      },
    },
    authPrisma: {
      machineToken: {} as never,
      lLMUsageEvent: {
        deleteMany: async (args: { where: Record<string, unknown> }) => {
          calls.push({ table: "LLMUsageEvent", op: "deleteMany", where: args.where });
          return { count: 4 };
        },
      } as unknown as never,
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
    const { inboxPrisma, authPrisma, calls } = makeFakes();
    const cron = new RetentionCron({
      inboxPrisma,
      authPrisma,
      now: () => now,
      bodyRetentionDays: 7,
      metadataRetentionDays: 90,
      pairingTokenRetentionHours: 1,
      llmEventRetentionDays: 30,
      vaultAuditRetentionDays: 365,
    });

    const stats = await cron.runOnce();

    expect(stats.bodies_purged).toBe(3);
    expect(stats.emails_deleted).toBe(1);
    expect(stats.pairing_tokens_deleted).toBe(2);
    expect(stats.llm_events_deleted).toBe(4);
    expect(stats.vault_audit_deleted).toBe(5);
    expect(stats.errors).toEqual([]);

    // Vault audit cutoff: now - 365 days
    const vaultAuditDelete = calls.find((c) => c.table === "VaultAuditEvent" && c.op === "deleteMany");
    expect(vaultAuditDelete).toBeDefined();
    const vaultWhere = vaultAuditDelete!.where["emitted_at"] as { lt: Date };
    expect(vaultWhere.lt).toEqual(new Date("2025-01-15T12:00:00Z"));

    // Body purge cutoff: now - 7 days
    const bodyPurge = calls.find((c) => c.table === "ReceivedEmail" && c.op === "updateMany");
    expect(bodyPurge).toBeDefined();
    const bodyWhere = bodyPurge!.where["received_at"] as { lt: Date };
    expect(bodyWhere.lt).toEqual(new Date("2026-01-08T12:00:00Z"));
    expect(bodyPurge!.where["body_purged_at"]).toBeNull();

    // Body fields should be nulled, body_purged_at stamped.
    expect(bodyPurge!.data).toMatchObject({
      body_text: null,
      body_html: null,
      body_purged_at: now,
    });

    // Metadata delete cutoff: now - 90 days
    const metaDelete = calls.find((c) => c.table === "ReceivedEmail" && c.op === "deleteMany");
    expect(metaDelete).toBeDefined();
    const metaWhere = metaDelete!.where["received_at"] as { lt: Date };
    expect(metaWhere.lt).toEqual(new Date("2025-10-17T12:00:00Z"));

    // Pairing token cutoff: now - 1 hour
    const pairingDelete = calls.find((c) => c.table === "PairingToken");
    expect(pairingDelete).toBeDefined();
    const pairingWhere = pairingDelete!.where["created_at"] as { lt: Date };
    expect(pairingWhere.lt).toEqual(new Date("2026-01-15T11:00:00Z"));

    // LLM event cutoff: now - 30 days
    const llmDelete = calls.find((c) => c.table === "LLMUsageEvent");
    expect(llmDelete).toBeDefined();
    const llmWhere = llmDelete!.where["occurred_at"] as { lt: Date };
    expect(llmWhere.lt).toEqual(new Date("2025-12-16T12:00:00Z"));
  });

  it("aggregates errors per section without crashing", async () => {
    const now = new Date("2026-01-15T12:00:00Z");
    const cron = new RetentionCron({
      inboxPrisma: {
        receivedEmail: {
          updateMany: async () => {
            throw new Error("body purge boom");
          },
          deleteMany: async () => {
            throw new Error("delete boom");
          },
        },
      },
      authPrisma: undefined,
      now: () => now,
    });

    const stats = await cron.runOnce();
    expect(stats.errors).toHaveLength(2);
    expect(stats.errors[0]).toMatch(/body purge/);
    expect(stats.errors[1]).toMatch(/email delete/);
  });

  it("status() exposes last-run state", async () => {
    const now = new Date("2026-01-15T12:00:00Z");
    const { inboxPrisma, authPrisma } = makeFakes();
    const cron = new RetentionCron({ inboxPrisma, authPrisma, now: () => now });

    expect(cron.status().last_run_at).toBeNull();
    await cron.runOnce();
    expect(cron.status().last_run_at).toEqual(now);
    expect(cron.status().last_stats?.bodies_purged).toBe(3);
  });

  it("does nothing harmful when both Prisma clients are absent (in-memory mode)", async () => {
    const cron = new RetentionCron({
      inboxPrisma: undefined,
      authPrisma: undefined,
      now: () => new Date("2026-01-15T12:00:00Z"),
    });
    const stats = await cron.runOnce();
    expect(stats.bodies_purged).toBe(0);
    expect(stats.emails_deleted).toBe(0);
    expect(stats.pairing_tokens_deleted).toBe(0);
    expect(stats.llm_events_deleted).toBe(0);
    expect(stats.errors).toEqual([]);
  });
});
