// Internal vault types — the row shapes the CredentialStore /
// AuditStore implementations operate on. Keeps the in-memory test
// implementations free of Prisma typings.

import type { Buffer } from "node:buffer";
import type { CredentialType } from "@trusty-squire/runtime";

export interface CredentialRecord {
  id: string;
  reference: string;
  account_id: string;
  subscription_id: string;
  type: CredentialType;
  env_var_suggestion: string | null;
  ciphertext: Buffer;
  encrypted_dek: Buffer;
  account_kek_blob: Buffer;
  algorithm: string;
  metadata: Record<string, unknown>;
  rotated_at: Date | null;
  retrieval_count: number;
  last_retrieved_at: Date | null;
  deleted_at: Date | null;
  created_at: Date;
}

export interface CredentialStore {
  insert(record: CredentialRecord): Promise<void>;
  // Returns null when the credential is deleted (or absent). The vault
  // treats "deleted" the same as "missing" for retrieve operations.
  findActive(reference: string): Promise<CredentialRecord | null>;
  markRetrieved(reference: string, retrievedAt: Date): Promise<void>;
  softDelete(reference: string, deletedAt: Date): Promise<void>;
  rotate(reference: string, ciphertext: Buffer, rotatedAt: Date): Promise<void>;
}

export type VaultRequester = "agent" | "user" | "system";

export interface VaultAuditPayload {
  reference: string;
  purpose: string;
  requester: VaultRequester;
  signing_device_id: string | null;
  ip?: string;
  user_agent?: string;
  outcome: "success" | "rate_limited" | "stale_assertion" | "missing_credential";
}

export interface VaultAuditEventInput {
  account_id: string;
  type: string;
  payload: VaultAuditPayload;
}

export interface VaultAuditStore {
  record(event: VaultAuditEventInput): Promise<void>;
  // Counts retrievals (success + rate_limited + stale_assertion +
  // missing_credential) for rate-limiting purposes. Failed retrievals
  // intentionally count toward the limit so an attacker can't probe
  // the vault unrate-limited via deliberately-broken assertions.
  countRecentRetrievals(accountId: string, since: Date): Promise<number>;
}
