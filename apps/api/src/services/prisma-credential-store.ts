// Postgres-backed CredentialStore for @trusty-squire/vault.
//
// The vault package deliberately keeps store implementations out of
// its own dependency surface (see its in-memory-stores.ts) — this is
// that production wiring, against the API's auth DB. The encryption
// envelope is still done by CredentialVault; this only persists rows.

import { Buffer } from "node:buffer";
import type { CredentialType } from "@trusty-squire/runtime";
import type { CredentialRecord, CredentialStore } from "@trusty-squire/vault";
import type { ApiPrismaClient } from "./api-prisma-client.js";

interface CredentialRow {
  id: string;
  reference: string;
  account_id: string;
  subscription_id: string;
  type: string;
  env_var_suggestion: string | null;
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
    await this.prisma.credential.create({
      data: {
        id: record.id,
        reference: record.reference,
        account_id: record.account_id,
        subscription_id: record.subscription_id,
        type: record.type,
        env_var_suggestion: record.env_var_suggestion,
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
  }

  async findActive(reference: string): Promise<CredentialRecord | null> {
    const row = await this.prisma.credential.findFirst({
      where: { reference, deleted_at: null },
    });
    return row === null ? null : this.toRecord(row);
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

  async rotate(
    reference: string,
    ciphertext: Buffer,
    rotatedAt: Date,
  ): Promise<void> {
    await this.prisma.credential.updateMany({
      where: { reference },
      data: { ciphertext, rotated_at: rotatedAt },
    });
  }

  async listByAccount(accountId: string): Promise<CredentialRecord[]> {
    const rows = await this.prisma.credential.findMany({
      where: { account_id: accountId, deleted_at: null },
      orderBy: { created_at: "desc" },
    });
    return rows.map((row) => this.toRecord(row));
  }

  private toRecord(row: CredentialRow): CredentialRecord {
    return {
      id: row.id,
      reference: row.reference,
      account_id: row.account_id,
      subscription_id: row.subscription_id,
      // The DB column is free text; CredentialType is the closed set
      // the value was inserted from.
      type: row.type as CredentialType,
      env_var_suggestion: row.env_var_suggestion,
      ciphertext: row.ciphertext,
      encrypted_dek: row.encrypted_dek,
      account_kek_blob: row.account_kek_blob,
      algorithm: row.algorithm,
      // JSON column → object metadata.
      metadata: (row.metadata ?? {}) as Record<string, unknown>,
      rotated_at: row.rotated_at,
      retrieval_count: row.retrieval_count,
      last_retrieved_at: row.last_retrieved_at,
      deleted_at: row.deleted_at,
      created_at: row.created_at,
    };
  }
}
