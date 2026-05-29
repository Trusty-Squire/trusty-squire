// Internal vault types — the row shapes the CredentialStore /
// AuditStore implementations operate on. Keeps the in-memory test
// implementations free of Prisma typings.

import type { Buffer } from "node:buffer";

// Credential-type vocabulary the vault accepts. Inlined here in 0.8
// after the runtime package was sunset; this list is the universal
// signup bot's working set + the historic native-provision values
// (api_key, oauth_token, etc.). Kept as a string union rather than a
// strict enum because the universal-bot synthesizer occasionally
// invents service-specific kind names ("admin_api_key",
// "search_api_key", …) that don't fit a closed set.
export type CredentialType = string;

export interface CredentialRecord {
  id: string;
  reference: string;
  account_id: string;
  subscription_id: string;
  type: CredentialType;
  env_var_suggestion: string | null;
  // Advisory host allowlist for the use_credential proxy. Seeded at
  // store-time from the service name (see service-hosts.ts); the user
  // edits it from the /vault UI. Empty = no default known.
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
  // treats "deleted" the same as "missing" for retrieve operations.
  findActive(reference: string): Promise<CredentialRecord | null>;
  markRetrieved(reference: string, retrievedAt: Date): Promise<void>;
  softDelete(reference: string, deletedAt: Date): Promise<void>;
  rotate(reference: string, ciphertext: Buffer, rotatedAt: Date): Promise<void>;
  // All of an account's active (non-deleted) credentials, newest
  // first. Powers the vault UI's credential list.
  listByAccount(accountId: string): Promise<CredentialRecord[]>;
  // Account-scoped single lookup by id — `WHERE id=$1 AND account_id=$2`
  // in one query so the web CRUD routes can't be tricked into touching
  // another account's credential via a guessed id. Returns null when
  // the id doesn't belong to the account or is soft-deleted.
  findByIdForAccount(
    id: string,
    accountId: string,
  ): Promise<CredentialRecord | null>;
  // Replace the advisory host allowlist for one credential.
  setAllowedHosts(reference: string, hosts: string[]): Promise<void>;
}

export type VaultRequester = "agent" | "user" | "system";

// One audit-event payload shape covering every type the vault emits.
// Field optionality reflects which `type` populates it: retrieve events
// fill purpose/signing_device_id/outcome; store/rotate/delete events
// fill credential_type instead. We keep them on one structural type
// (rather than a discriminated union) so historic callers that access
// payload.outcome don't need narrowing.
export interface VaultAuditPayload {
  reference: string;
  requester: VaultRequester;
  // Retrieve events
  purpose?: string;
  signing_device_id?: string | null;
  ip?: string;
  user_agent?: string;
  outcome?: "success" | "rate_limited" | "stale_assertion" | "missing_credential";
  // Mutation events ("stored" carries the credential's type tag so the
  // audit UI can render a service badge; rotate/delete leave it unset).
  credential_type?: string;
  // Agent-mediated access events (request / approve / deny / consume)
  // and the use_credential proxy. The secret value is NEVER present in
  // any of these fields.
  request_id?: string;
  agent_session_id?: string;
  intent?: "value" | "proxy";
  mode?: "once" | "session" | "persistent";
  auto_approved?: boolean;
  target_host?: string;
  // Proxy forensics — filled after the upstream call returns (or fails).
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
  // Agent-mediated access lifecycle.
  accessRequested: "vault.access_requested",
  accessApproved: "vault.access_approved",
  accessDenied: "vault.access_denied",
  accessConsumed: "vault.access_consumed",
  // use_credential server-side proxy.
  proxyExecuted: "vault.proxy_executed",
  proxyOffAllowlist: "vault.proxy_off_allowlist",
} as const;
export type VaultAuditType = (typeof VAULT_AUDIT_TYPES)[keyof typeof VAULT_AUDIT_TYPES];

export interface VaultAuditEventInput {
  account_id: string;
  type: VaultAuditType;
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
