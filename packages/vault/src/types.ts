// Internal vault types — the row shapes the CredentialStore /
// AuditStore implementations operate on.

import type { Buffer } from "node:buffer";

export type CredentialType = string;

export interface CredentialRecord {
  id: string;
  reference: string;
  account_id: string;
  subscription_id: string;
  // A credential entry is unique per (account, service, label). `label`
  // defaults to "default" — one entry per app — but lets a user hold
  // prod/dev keys for the same service side by side.
  label: string;
  type: CredentialType | null;
  env_var_suggestion: string | null;
  // Plaintext names of the secret fields this entry holds (NOT secret —
  // like AWS_ACCESS_KEY_ID). The ciphertext encrypts a JSON object
  // { [field_name]: value }. A lone API key is just ["value"]. Powers
  // list/proxy-validation/the web field editor without decrypting.
  field_names: string[];
  // Enforced destination allowlist for the use_credential proxy.
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
  findActive(reference: string): Promise<CredentialRecord | null>;
  // Upsert lookup: the active entry for (account, service, label), or
  // null. `service` is matched case-insensitively against metadata.service.
  findActiveByServiceLabel(
    accountId: string,
    service: string,
    label: string,
  ): Promise<CredentialRecord | null>;
  markRetrieved(reference: string, retrievedAt: Date): Promise<void>;
  softDelete(reference: string, deletedAt: Date): Promise<void>;
  // Overwrite the encrypted payload (the upsert / web-edit path). The
  // envelope is replaced wholesale (fresh kek/dek) along with the
  // field-name list; allowed_hosts + label are left untouched.
  replaceSecret(
    reference: string,
    payload: {
      ciphertext: Buffer;
      encrypted_dek: Buffer;
      account_kek_blob: Buffer;
      field_names: string[];
      rotatedAt: Date;
      type?: CredentialType | null;
      env_var_suggestion?: string | null;
      metadata?: Record<string, unknown>;
    },
  ): Promise<void>;
  listByAccount(accountId: string): Promise<CredentialRecord[]>;
  // Every credential the account ever held, soft-deleted included —
  // the complete-history read for GDPR export. Newest first.
  listByAccountIncludingDeleted(accountId: string): Promise<CredentialRecord[]>;
  findByIdForAccount(
    id: string,
    accountId: string,
  ): Promise<CredentialRecord | null>;
  // Lookups that ignore deleted_at — for the undelete/restore path.
  findByIdForAccountIncludingDeleted(
    id: string,
    accountId: string,
  ): Promise<CredentialRecord | null>;
  findByReferenceIncludingDeleted(reference: string): Promise<CredentialRecord | null>;
  // Clear deleted_at, bringing a soft-deleted credential back to active.
  restore(reference: string): Promise<void>;
  setAllowedHosts(reference: string, hosts: string[]): Promise<void>;
  // Rename an entry — updates the (non-secret) label only. Leaves the
  // encrypted payload + allowed_hosts untouched.
  setLabel(reference: string, label: string): Promise<void>;
  // Hard-delete every credential row (active + soft-deleted) for the
  // account — the irreversible offboarding purge. Returns rows removed.
  purgeAccount(accountId: string): Promise<number>;
}

export type VaultRequester = "agent" | "user" | "system";

export interface VaultAuditPayload {
  reference: string;
  requester: VaultRequester;
  purpose?: string;
  signing_device_id?: string | null;
  ip?: string;
  user_agent?: string;
  outcome?: "success" | "rate_limited" | "stale_assertion" | "missing_credential";
  credential_type?: string;
  service?: string;
  label?: string;
  // use_credential proxy forensics (no secret value, ever).
  target_host?: string;
  response_status?: number;
  response_size?: number;
  upstream_duration_ms?: number;
  proxy_error?: string;
  // Backlog-dedup forensics. `reference` is the row that was
  // soft-deleted; `collapsed_into` is the surviving (kept) reference
  // its duplicates were merged into. Set together by the one-time
  // dedup-credentials migration so the collapse is auditable + reversible.
  collapsed_into?: string;
}

export const VAULT_AUDIT_TYPES = {
  retrieved: "vault.credential_retrieved",
  stored: "vault.credential_stored",
  rotated: "vault.credential_rotated",
  deleted: "vault.credential_deleted",
  // A soft-deleted credential brought back to active (undelete). Distinct
  // from `stored` so a recovery is queryable on its own.
  restored: "vault.credential_restored",
  // A duplicate active row collapsed into a surviving one by the
  // one-time backlog-dedup migration. Distinct from `deleted` (a
  // user/agent revocation) so dedup soft-deletes are queryable on their own.
  collapsed: "vault.credential_collapsed",
  proxyExecuted: "vault.proxy_executed",
  proxyRejected: "vault.proxy_rejected",
  // Entry label changed (web rename). Non-secret metadata edit — distinct
  // from `rotated` (which re-encrypts the payload).
  renamed: "vault.credential_renamed",
  // A new field added to an existing entry's encrypted blob (web). The
  // payload is re-encrypted to merge the field; distinct from `rotated`
  // (full replace) so an additive edit is queryable on its own.
  fieldAdded: "vault.credential_field_added",
} as const;
export type VaultAuditType = (typeof VAULT_AUDIT_TYPES)[keyof typeof VAULT_AUDIT_TYPES];

export interface VaultAuditEventInput {
  account_id: string;
  type: VaultAuditType;
  payload: VaultAuditPayload;
}

// A persisted audit row, as read back for the who-touched-my-keys
// timeline. The payload carries NO secret values (by construction) —
// only references, requesters, outcomes, and proxy forensics.
export interface VaultAuditRecord {
  id: string;
  account_id: string;
  type: VaultAuditType;
  payload: VaultAuditPayload;
  emitted_at: Date;
}

export interface VaultAuditListOptions {
  // Page size; the store clamps to a sane maximum.
  limit?: number;
  // Keyset cursor — return only events strictly older than this
  // (emitted_at < before). Pair with the last row's emitted_at to page.
  before?: Date;
  // Optional filters. `type` hits the indexed column; `reference`
  // narrows to a single credential's history.
  type?: VaultAuditType;
  reference?: string;
}

export interface VaultAuditStore {
  record(event: VaultAuditEventInput): Promise<void>;
  countRecentRetrievals(accountId: string, since: Date): Promise<number>;
  // Newest-first audit trail for an account, for the activity timeline.
  list(accountId: string, opts?: VaultAuditListOptions): Promise<VaultAuditRecord[]>;
  // The entire trail for an account, unpaginated — for GDPR export.
  exportAll(accountId: string): Promise<VaultAuditRecord[]>;
  // Hard-delete every audit row for the account — offboarding purge.
  purgeAccount(accountId: string): Promise<number>;
}
