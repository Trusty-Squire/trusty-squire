// Postgres-backed CredentialStore for @trusty-squire/vault.
//
// The vault package keeps store implementations out of its dependency
// surface; this is the production wiring against the API's auth DB. The
// encryption envelope is done by CredentialVault — this only persists
// rows.

import type { Buffer } from "node:buffer";
import {
  CredentialSlotConflictError,
  VAULT_AUDIT_TYPES,
  type CredentialRecord,
  type CredentialStore,
} from "@trusty-squire/vault";
import { ulid } from "ulid";
import type { ApiPrismaClient } from "./api-prisma-client.js";

interface CredentialRow {
  id: string;
  reference: string;
  account_id: string;
  subscription_id: string;
  type: string | null;
  env_var_suggestion: string | null;
  label: string;
  field_names: string[];
  allowed_hosts: string[];
  ciphertext: Buffer;
  encrypted_dek: Buffer;
  account_kek_blob: Buffer;
  algorithm: string;
  metadata: unknown;
  rotated_at: Date | null;
  retrieval_count: number;
  last_retrieved_at: Date | null;
  deleted_at: Date | null;
  created_at: Date;
}

export class PrismaCredentialStore implements CredentialStore {
  constructor(private readonly prisma: ApiPrismaClient) {}

  async insert(record: CredentialRecord): Promise<void> {
    try {
      await this.prisma.credential.create({
        data: {
          id: record.id,
          reference: record.reference,
          account_id: record.account_id,
          subscription_id: record.subscription_id,
          type: record.type,
          env_var_suggestion: record.env_var_suggestion,
          label: record.label,
          field_names: record.field_names,
          allowed_hosts: record.allowed_hosts,
          ciphertext: record.ciphertext,
          encrypted_dek: record.encrypted_dek,
          account_kek_blob: record.account_kek_blob,
          algorithm: record.algorithm,
          metadata: record.metadata,
          rotated_at: record.rotated_at,
          retrieval_count: record.retrieval_count,
          last_retrieved_at: record.last_retrieved_at,
          deleted_at: record.deleted_at,
          created_at: record.created_at,
        },
      });
    } catch (error) {
      if (isPrismaUniqueConstraintError(error)) throw new CredentialSlotConflictError();
      throw error;
    }
  }

  async findActive(reference: string): Promise<CredentialRecord | null> {
    const lookup = () =>
      this.prisma.credential.findFirst({
        where: { reference, deleted_at: null },
      });
    let row;
    try {
      row = await lookup();
    } catch (err) {
      if (!isRetryablePrismaConnectionError(err)) throw err;
      await disconnectPrisma(this.prisma);
      row = await lookup();
    }
    return row === null ? null : this.toRecord(row);
  }

  async isActive(reference: string, accountId: string): Promise<boolean> {
    const lookup = () =>
      this.prisma.credential.findFirst({
        where: { reference, account_id: accountId, deleted_at: null },
      });
    let row;
    try {
      row = await lookup();
    } catch (error) {
      if (!isRetryablePrismaConnectionError(error)) throw error;
      await disconnectPrisma(this.prisma);
      row = await lookup();
    }
    return row !== null;
  }

  async findActiveByServiceLabel(
    accountId: string,
    service: string,
    label: string,
  ): Promise<CredentialRecord | null> {
    // `service` lives in metadata JSON; filter the account's active
    // rows in code (small set per account). Newest first.
    const rows = await this.prisma.credential.findMany({
      where: { account_id: accountId, deleted_at: null },
      orderBy: { created_at: "desc" },
    });
    const want = service.toLowerCase();
    const match = rows.find((r) => {
      const rec = this.toRecord(r);
      const svc = typeof rec.metadata.service === "string" ? rec.metadata.service : null;
      return rec.label === label && svc !== null && svc.toLowerCase() === want;
    });
    return match === undefined ? null : this.toRecord(match);
  }

  async markRetrieved(reference: string, retrievedAt: Date): Promise<void> {
    await this.prisma.credential.updateMany({
      where: { reference },
      data: { retrieval_count: { increment: 1 }, last_retrieved_at: retrievedAt },
    });
  }

  async softDelete(reference: string, deletedAt: Date): Promise<void> {
    await this.prisma.credential.updateMany({
      where: { reference },
      data: { deleted_at: deletedAt },
    });
  }

  async collapseDuplicate(
    reference: string,
    accountId: string,
    service: string,
    label: string,
    deletedAt: Date,
  ): Promise<string | null> {
    return await this.prisma.$transaction(async (tx) => {
      const slot = await tx.$queryRaw<Array<{ reference: string; service: string }>>`
        SELECT "reference", "metadata"->>'service' AS service
        FROM "Credential"
        WHERE "account_id" = ${accountId}
          AND "deleted_at" IS NULL
          AND "label" = ${label}
          AND jsonb_typeof("metadata"->'service') = 'string'
          AND lower("metadata"->>'service') = lower(${service})
        ORDER BY "created_at" DESC, "reference" DESC
        FOR UPDATE
      `;
      if (!slot.some((candidate) => candidate.reference === reference)) return null;
      const survivor = slot.find((candidate) => candidate.reference !== reference);
      if (survivor === undefined) return null;

      const deleted = await tx.credential.updateMany({
        where: {
          reference,
          account_id: accountId,
          deleted_at: null,
          label,
        },
        data: { deleted_at: deletedAt },
      });
      if (deleted.count !== 1) return null;

      await tx.vaultAuditEvent.create({
        data: {
          id: ulid(),
          account_id: accountId,
          type: VAULT_AUDIT_TYPES.collapsed,
          payload: {
            reference,
            collapsed_into: survivor.reference,
            requester: "system",
            service: survivor.service,
            label,
          },
          emitted_at: deletedAt,
        },
      });
      return survivor.reference;
    });
  }

  async replaceSecret(
    reference: string,
    payload: {
      ciphertext: Buffer;
      encrypted_dek: Buffer;
      account_kek_blob: Buffer;
      field_names: string[];
      rotatedAt: Date;
    },
  ): Promise<void> {
    await this.prisma.credential.updateMany({
      where: { reference },
      data: {
        ciphertext: payload.ciphertext,
        encrypted_dek: payload.encrypted_dek,
        account_kek_blob: payload.account_kek_blob,
        field_names: payload.field_names,
        rotated_at: payload.rotatedAt,
      },
    });
  }

  async listByAccount(accountId: string): Promise<CredentialRecord[]> {
    const rows = await this.prisma.credential.findMany({
      where: { account_id: accountId, deleted_at: null },
      orderBy: { created_at: "desc" },
    });
    return rows.map((row) => this.toRecord(row));
  }

  // Every account that owns at least one active credential. The dedup
  // migration enumerates these, then runs listByAccount per account —
  // there's no all-accounts list helper, and a global scan would lose
  // the per-account grouping the dedup key needs anyway.
  async listAllAccountIds(): Promise<string[]> {
    const groups = await this.prisma.credential.groupBy({
      by: ["account_id"],
      where: { deleted_at: null },
    });
    return groups.map((g) => g.account_id);
  }

  // Complete history (soft-deleted included) for GDPR export.
  async listByAccountIncludingDeleted(accountId: string): Promise<CredentialRecord[]> {
    const rows = await this.prisma.credential.findMany({
      where: { account_id: accountId },
      orderBy: { created_at: "desc" },
    });
    return rows.map((row) => this.toRecord(row));
  }

  // Irreversible offboarding purge — hard-delete every row (active +
  // soft-deleted) for the account. Returns the count removed.
  async purgeAccount(accountId: string): Promise<number> {
    const r = await this.prisma.credential.deleteMany({ where: { account_id: accountId } });
    return r.count;
  }

  async findByIdForAccount(id: string, accountId: string): Promise<CredentialRecord | null> {
    const row = await this.prisma.credential.findFirst({
      where: { id, account_id: accountId, deleted_at: null },
    });
    return row === null ? null : this.toRecord(row);
  }

  async updateMetadata(
    reference: string,
    expected: {
      label: string;
      allowed_hosts: string[];
      metadata: Record<string, unknown>;
    },
    input: {
      label?: string;
      allowed_hosts?: string[];
      metadata?: Record<string, unknown>;
    },
  ): Promise<"updated" | "changed" | "conflict"> {
    try {
      const result = await this.prisma.credential.updateMany({
        where: {
          reference,
          deleted_at: null,
          label: expected.label,
          allowed_hosts: { equals: expected.allowed_hosts },
          metadata: { equals: expected.metadata },
        },
        data: {
          ...(input.label !== undefined ? { label: input.label } : {}),
          ...(input.allowed_hosts !== undefined ? { allowed_hosts: input.allowed_hosts } : {}),
          ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
        },
      });
      return result.count > 0 ? "updated" : "changed";
    } catch (error) {
      if (isPrismaUniqueConstraintError(error)) return "conflict";
      throw error;
    }
  }

  async findByIdForAccountIncludingDeleted(
    id: string,
    accountId: string,
  ): Promise<CredentialRecord | null> {
    const row = await this.prisma.credential.findFirst({
      where: { id, account_id: accountId },
    });
    return row === null ? null : this.toRecord(row);
  }

  async findByReferenceIncludingDeleted(reference: string): Promise<CredentialRecord | null> {
    const row = await this.prisma.credential.findFirst({ where: { reference } });
    return row === null ? null : this.toRecord(row);
  }

  // Undelete — clear deleted_at. The caller (vault) has already checked
  // ownership + that no active (service,label) twin exists.
  async restore(reference: string): Promise<void> {
    try {
      await this.prisma.credential.updateMany({
        where: { reference },
        data: { deleted_at: null },
      });
    } catch (error) {
      if (isPrismaUniqueConstraintError(error)) throw new CredentialSlotConflictError();
      throw error;
    }
  }

  // Re-wrap only the master-key envelope (account_kek_blob), for the KEK
  // key-rotation migration. Deliberately does NOT touch rotated_at — a
  // re-wrap re-encrypts the same KEK under a new master key; the secret
  // itself is unchanged, so this is not a rotation event.
  async rewrapAccountKek(reference: string, accountKekBlob: Buffer): Promise<void> {
    await this.prisma.credential.updateMany({
      where: { reference },
      data: { account_kek_blob: accountKekBlob },
    });
  }

  private toRecord(row: CredentialRow): CredentialRecord {
    return {
      id: row.id,
      reference: row.reference,
      account_id: row.account_id,
      subscription_id: row.subscription_id,
      type: row.type,
      env_var_suggestion: row.env_var_suggestion,
      label: row.label ?? "default",
      field_names: row.field_names ?? [],
      allowed_hosts: row.allowed_hosts ?? [],
      ciphertext: row.ciphertext,
      encrypted_dek: row.encrypted_dek,
      account_kek_blob: row.account_kek_blob,
      algorithm: row.algorithm,
      metadata: (row.metadata ?? {}) as Record<string, unknown>,
      rotated_at: row.rotated_at,
      retrieval_count: row.retrieval_count,
      last_retrieved_at: row.last_retrieved_at,
      deleted_at: row.deleted_at,
      created_at: row.created_at,
    };
  }
}

function isRetryablePrismaConnectionError(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  const code = "code" in err ? String((err as { code?: unknown }).code ?? "") : "";
  if (code === "P1017" || code === "P1001" || code === "P1002") return true;
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    message.includes("server has closed the connection") ||
    message.includes("connection terminated") ||
    message.includes("connection pool") ||
    message.includes("can't reach database server")
  );
}

function isPrismaUniqueConstraintError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    String((error as { code?: unknown }).code ?? "") === "P2002"
  );
}

async function disconnectPrisma(prisma: ApiPrismaClient): Promise<void> {
  const maybeDisconnect = (prisma as { $disconnect?: () => Promise<void> }).$disconnect;
  if (maybeDisconnect === undefined) return;
  try {
    await maybeDisconnect.call(prisma);
  } catch {
    // Prisma reconnects lazily; a failed cleanup should not suppress the retry.
  }
}
