// Unit-tests the retention cron's decision math without hitting a real
// database. We feed in a fake auth Prisma client that records the where
// clauses it's asked to operate on; the test asserts the cutoffs are
// correct relative to the configured retention windows.

import { describe, expect, it } from "vitest";
import { InMemoryVaultAuditStore } from "@trusty-squire/vault";
import { RetentionCron } from "../services/retention-cron.js";

interface RecordedCall {
  table: string;
  op: "deleteMany" | "findMany" | "updateMany";
  where: Record<string, unknown>;
}

// A lapsed fetch approval the sweep will find. `status` decides whether it is
// an unsettled reveal (pending/approved — must be audited before deletion) or
// one already settled by a poll.
function lapsedFetchRow(status: string, id = "fetch_1"): Record<string, unknown> {
  return {
    id,
    account_id: "acct_owner",
    credential_reference: "vault://acct_owner/sub/cred",
    credential_service: "OpenAI",
    credential_label: "default",
    field: null,
    field_names: ["value"],
    nonce: "n",
    agent: "codex",
    requester_kind: "agent",
    intent_hash: "h",
    status,
    failure_code: null,
    mandate_id: null,
    created_at: new Date("2026-01-15T11:00:00Z"),
    expires_at: new Date("2026-01-15T11:10:00Z"),
    approved_at: null,
    delivered_at: null,
  };
}

function makeFakes(fetchRows: Array<Record<string, unknown>> = []): {
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
      paymentAuditEvent: {
        deleteMany: async (args: { where: Record<string, unknown> }) => {
          calls.push({ table: "PaymentAuditEvent", op: "deleteMany", where: args.where });
          return { count: 3 };
        },
      } as unknown as never,
      pendingPaymentApproval: {
        deleteMany: async (args: { where: Record<string, unknown> }) => {
          calls.push({ table: "PendingPaymentApproval", op: "deleteMany", where: args.where });
          return { count: 4 };
        },
      } as unknown as never,
      credentialFetchApproval: {
        findMany: async (args: { where: Record<string, unknown> }) => {
          calls.push({ table: "CredentialFetchApproval", op: "findMany", where: args.where });
          return fetchRows;
        },
        updateMany: async (args: { where: Record<string, unknown> }) => {
          calls.push({ table: "CredentialFetchApproval", op: "updateMany", where: args.where });
          return { count: 1 };
        },
        deleteMany: async (args: { where: Record<string, unknown> }) => {
          calls.push({
            table: "CredentialFetchApproval",
            op: "deleteMany",
            where: args.where,
          });
          return { count: (args.where["id"] as { in: string[] }).in.length };
        },
      } as unknown as never,
      credentialMutationApproval: {
        deleteMany: async (args: { where: Record<string, unknown> }) => {
          calls.push({
            table: "CredentialMutationApproval",
            op: "deleteMany",
            where: args.where,
          });
          return { count: 6 };
        },
      } as unknown as never,
      telegramLinkToken: {
        deleteMany: async (args: { where: Record<string, unknown> }) => {
          calls.push({ table: "TelegramLinkToken", op: "deleteMany", where: args.where });
          return { count: 1 };
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
    expect(stats.payment_audit_deleted).toBe(3);
    expect(stats.payment_approvals_deleted).toBe(4);
    expect(stats.credential_mutation_approvals_deleted).toBe(6);
    expect(stats.telegram_link_tokens_deleted).toBe(1);
    expect(stats.errors).toEqual([]);

    // Vault audit cutoff: now - 365 days
    const vaultAuditDelete = calls.find(
      (c) => c.table === "VaultAuditEvent" && c.op === "deleteMany",
    );
    expect(vaultAuditDelete).toBeDefined();
    const vaultWhere = vaultAuditDelete!.where["emitted_at"] as { lt: Date };
    expect(vaultWhere.lt).toEqual(new Date("2025-01-15T12:00:00Z"));

    const paymentAuditDelete = calls.find((c) => c.table === "PaymentAuditEvent");
    expect(paymentAuditDelete).toBeDefined();
    const paymentWhere = paymentAuditDelete!.where["created_at"] as { lt: Date };
    expect(paymentWhere.lt).toEqual(new Date("2025-01-15T12:00:00Z"));

    const paymentApprovalDelete = calls.find((c) => c.table === "PendingPaymentApproval");
    expect(paymentApprovalDelete).toBeDefined();
    const paymentApprovalWhere = paymentApprovalDelete!.where["expires_at"] as { lt: Date };
    expect(paymentApprovalWhere.lt).toEqual(now);

    const credentialMutationApprovalDelete = calls.find(
      (c) => c.table === "CredentialMutationApproval",
    );
    expect(credentialMutationApprovalDelete).toBeDefined();
    const credentialMutationApprovalWhere = credentialMutationApprovalDelete!.where[
      "expires_at"
    ] as { lt: Date };
    expect(credentialMutationApprovalWhere.lt).toEqual(now);

    const credentialFetchApprovalScan = calls.find(
      (c) => c.table === "CredentialFetchApproval" && c.op === "findMany",
    );
    expect(credentialFetchApprovalScan).toBeDefined();
    const credentialFetchApprovalWhere = credentialFetchApprovalScan!.where["expires_at"] as {
      lt: Date;
    };
    expect(credentialFetchApprovalWhere.lt).toEqual(now);

    const telegramLinkTokenDelete = calls.find((c) => c.table === "TelegramLinkToken");
    expect(telegramLinkTokenDelete).toBeDefined();
    const telegramLinkTokenWhere = telegramLinkTokenDelete!.where["expires_at"] as { lt: Date };
    expect(telegramLinkTokenWhere.lt).toEqual(now);

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
        paymentAuditEvent: {
          deleteMany: async () => {
            throw new Error("payment boom");
          },
        } as unknown as never,
        pendingPaymentApproval: {
          deleteMany: async () => {
            throw new Error("payment approval boom");
          },
        } as unknown as never,
        credentialMutationApproval: {
          deleteMany: async () => {
            throw new Error("credential mutation approval boom");
          },
        } as unknown as never,
        credentialFetchApproval: {
          findMany: async () => {
            throw new Error("credential fetch approval boom");
          },
        } as unknown as never,
        telegramLinkToken: {
          deleteMany: async () => {
            throw new Error("telegram link token boom");
          },
        } as unknown as never,
      } as never,
      now: () => now,
    });

    const stats = await cron.runOnce();
    expect(stats.errors).toHaveLength(7);
    expect(stats.errors[0]).toMatch(/pairing/);
    expect(stats.errors[1]).toMatch(/vault audit/);
    expect(stats.errors[2]).toMatch(/payment audit/);
    expect(stats.errors[3]).toMatch(/payment approval/);
    expect(stats.errors[4]).toMatch(/credential mutation approval/);
    expect(stats.errors[5]).toMatch(/credential fetch approval/);
    expect(stats.errors[6]).toMatch(/telegram link token/);
  });

  // The cron used to delete lapsed fetch approvals outright, which made
  // "every fetch outcome is audited" false for every approval nobody came back
  // for: the row was the only remaining evidence the request existed.
  it("settles and audits an abandoned fetch approval before deleting it", async () => {
    const now = new Date("2026-01-15T12:00:00Z");
    const auditStore = new InMemoryVaultAuditStore(() => now);
    const { authPrisma, calls } = makeFakes([
      lapsedFetchRow("pending", "fetch_pending"),
      lapsedFetchRow("approved", "fetch_approved"),
    ]);
    const cron = new RetentionCron({ authPrisma, vaultAuditStore: auditStore, now: () => now });

    const stats = await cron.runOnce();
    expect(stats.credential_fetch_approvals_deleted).toBe(2);

    expect(auditStore.events.map((event) => event.payload.outcome)).toEqual([
      "expired",
      "expired",
    ]);
    expect(auditStore.events[0]!.account_id).toBe("acct_owner");
    expect(auditStore.events[0]!.payload).toMatchObject({
      reference: "vault://acct_owner/sub/cred",
      purpose: "reveal",
      outcome: "expired",
      approval_id: "fetch_pending",
    });
    // No decrypted material can reach these rows — there is no parameter for it.
    expect(JSON.stringify(auditStore.events)).not.toContain("value\":\"sk-");

    // Settled first, deleted second: the audit write cannot be skipped by a
    // delete that already ran.
    const fetchCalls = calls.filter((c) => c.table === "CredentialFetchApproval");
    expect(fetchCalls.map((c) => c.op)).toEqual([
      "findMany",
      "updateMany",
      "updateMany",
      "deleteMany",
    ]);
  });

  it("deletes an already-settled lapsed approval without a second audit row", async () => {
    const now = new Date("2026-01-15T12:00:00Z");
    const auditStore = new InMemoryVaultAuditStore(() => now);
    const { authPrisma } = makeFakes([
      lapsedFetchRow("failed", "fetch_settled"),
      lapsedFetchRow("consumed", "fetch_delivered"),
    ]);
    const cron = new RetentionCron({ authPrisma, vaultAuditStore: auditStore, now: () => now });

    const stats = await cron.runOnce();
    expect(stats.credential_fetch_approvals_deleted).toBe(2);
    expect(auditStore.events).toEqual([]);
  });

  it("keeps an unsettled approval rather than deleting it with no audit sink", async () => {
    const now = new Date("2026-01-15T12:00:00Z");
    const { authPrisma, calls } = makeFakes([lapsedFetchRow("pending")]);
    const cron = new RetentionCron({ authPrisma, now: () => now });

    const stats = await cron.runOnce();
    expect(stats.credential_fetch_approvals_deleted).toBe(0);
    expect(calls.some((c) => c.table === "CredentialFetchApproval" && c.op === "deleteMany")).toBe(
      false,
    );
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
    expect(stats.payment_audit_deleted).toBe(0);
    expect(stats.payment_approvals_deleted).toBe(0);
    expect(stats.credential_mutation_approvals_deleted).toBe(0);
    expect(stats.credential_fetch_approvals_deleted).toBe(0);
    expect(stats.telegram_link_tokens_deleted).toBe(0);
    expect(stats.errors).toEqual([]);
  });
});
