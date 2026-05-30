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
    },
  ): Promise<void>;
  listByAccount(accountId: string): Promise<CredentialRecord[]>;
  findByIdForAccount(
    id: string,
    accountId: string,
  ): Promise<CredentialRecord | null>;
  setAllowedHosts(reference: string, hosts: string[]): Promise<void>;
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
}

export const VAULT_AUDIT_TYPES = {
  retrieved: "vault.credential_retrieved",
  stored: "vault.credential_stored",
  rotated: "vault.credential_rotated",
  deleted: "vault.credential_deleted",
  proxyExecuted: "vault.proxy_executed",
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
  countRecentRetrievals(accountId: string, since: Date): Promise<number>;
}
