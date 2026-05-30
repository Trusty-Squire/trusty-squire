// Internal vault types — the row shapes the CredentialStore /
// AuditStore implementations operate on. Keeps the in-memory test
// implementations free of Prisma typings.

import type { Buffer } from "node:buffer";

// Credential-type vocabulary the vault accepts. A free string union
// rather than a closed enum — the universal-bot synthesizer invents
// service-specific kind names ("admin_api_key", "search_api_key", …).
export type CredentialType = string;

export interface CredentialRecord {
  id: string;
  reference: string;
  account_id: string;
  subscription_id: string;
  type: CredentialType;
  env_var_suggestion: string | null;
  // Enforced destination allowlist for the use_credential proxy. Seeded
  // at store-time from the service name (see service-hosts.ts); the user
  // edits it in /vault. The proxy HARD-REJECTS any host not on this
  // list — the vault is a write-only sink, so a credential can only ever
  // be used against destinations the user pre-authorised.
  allowed_hosts: string[];
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
  // treats "deleted" the same as "missing" for retrieve/proxy.
  findActive(reference: string): Promise<CredentialRecord | null>;
  markRetrieved(reference: string, retrievedAt: Date): Promise<void>;
  softDelete(reference: string, deletedAt: Date): Promise<void>;
  rotate(reference: string, ciphertext: Buffer, rotatedAt: Date): Promise<void>;
  // All of an account's active (non-deleted) credentials, newest
  // first. Powers the vault UI's credential list.
  listByAccount(accountId: string): Promise<CredentialRecord[]>;
  // Account-scoped single lookup by id — `WHERE id=$1 AND account_id=$2`
  // in one query so the web CRUD routes can't be tricked into touching
  // another account's credential via a guessed id.
  findByIdForAccount(
    id: string,
    accountId: string,
  ): Promise<CredentialRecord | null>;
  // Replace the enforced host allowlist for one credential.
  setAllowedHosts(reference: string, hosts: string[]): Promise<void>;
}

export type VaultRequester = "agent" | "user" | "system";

// One audit-event payload shape covering every type the vault emits.
// Field optionality reflects which `type` populates it. The secret
// value is NEVER present in any field.
export interface VaultAuditPayload {
  reference: string;
  requester: VaultRequester;
  // Retrieve events (web reveal / system rotation reads).
  purpose?: string;
  signing_device_id?: string | null;
  ip?: string;
  user_agent?: string;
  outcome?: "success" | "rate_limited" | "stale_assertion" | "missing_credential";
  // "stored" carries the credential's type tag for the audit UI badge.
  credential_type?: string;
  // use_credential proxy forensics (target + outcome only — no secret).
  target_host?: string;
  response_status?: number;
  response_size?: number;
  upstream_duration_ms?: number;
  proxy_error?: string;
}

// Audit event type vocabulary. Centralised so the API's
// PrismaVaultAuditStore + the in-memory store + future consumers
// share one source of truth.
export const VAULT_AUDIT_TYPES = {
  retrieved: "vault.credential_retrieved",
  stored: "vault.credential_stored",
  rotated: "vault.credential_rotated",
  deleted: "vault.credential_deleted",
  // use_credential server-side proxy.
  proxyExecuted: "vault.proxy_executed",
  // Off-allowlist host rejected before any upstream dispatch.
  proxyRejected: "vault.proxy_rejected",
} as const;
export type VaultAuditType = (typeof VAULT_AUDIT_TYPES)[keyof typeof VAULT_AUDIT_TYPES];

export interface VaultAuditEventInput {
  account_id: string;
  type: VaultAuditType;
  payload: VaultAuditPayload;
}

export interface VaultAuditStore {
  record(event: VaultAuditEventInput): Promise<void>;
  // Counts retrievals for rate-limiting. Failed retrievals count too so
  // an attacker can't probe the vault unrate-limited via broken assertions.
  countRecentRetrievals(accountId: string, since: Date): Promise<number>;
}
