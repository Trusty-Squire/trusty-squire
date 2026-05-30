// CredentialVault — encrypted credential store, write-only sink, with
// multi-field credentials.
//
// An entry is unique per (account, service, label) and holds a MAP of
// named secret fields (AWS = {access_key_id, secret_access_key};
// a lone key = {value}). The ciphertext encrypts JSON.stringify(fields);
// field NAMES are stored plaintext (they aren't secret). `store` is an
// UPSERT: re-storing the same (service,label) overwrites the fields —
// that IS rotation, so there's no separate rotate verb.
//
// The secret is NEVER returned to an agent. `use_credential` injects
// fields server-side via ${SECRET} / ${SECRET.<field>} and returns only
// the upstream response; the proxy hard-enforces the host allowlist.
// Human-only paths (web): reveal, delete, allowlist edits, field edits.

import { Buffer } from "node:buffer";
import { ulid } from "ulid";
import {
  aadForDek,
  aadForValue,
  decryptAesGcm,
  encryptAesGcm,
  generateKey,
} from "./encryption.js";
import type { KMSClient } from "./kms-client.js";
import { deriveAllowedHosts } from "./service-hosts.js";
import type {
  CredentialRecord,
  CredentialStore,
  CredentialType,
  VaultAuditEventInput,
  VaultAuditStore,
  VaultAuditType,
  VaultRequester,
} from "./types.js";
import { VAULT_AUDIT_TYPES } from "./types.js";

export const DEFAULT_LABEL = "default";

export interface VaultStoreInput {
  account_id: string;
  subscription_id: string;
  service: string;
  label?: string;
  // The named secret fields. A lone API key is { value: "sk-…" }.
  fields: Record<string, string>;
  type?: CredentialType | null;
  env_var_suggestion?: string | null;
  metadata?: Record<string, unknown>;
}

export interface VaultEntry {
  reference: string;
  service: string;
  label: string;
  field_names: string[];
  allowed_hosts: string[];
  created_at: string;
  // false on first create, true when an existing entry was overwritten.
  updated: boolean;
}

export interface RotateResult {
  rotated_at: string;
}

export interface DeviceAssertion {
  signature: string;
  signed_at: string;
  signing_device_id: string;
}

export interface ProxyHttpTemplate {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
}
export interface ProxyResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  truncated: boolean;
}
// The executor receives the decrypted field MAP and does the
// ${SECRET.<field>} substitution + network dispatch (API layer).
export type ProxyExecutor = (input: {
  accountId: string;
  http: ProxyHttpTemplate;
  fields: Record<string, string>;
}) => Promise<ProxyResponse>;

export interface VaultClient {
  store(input: VaultStoreInput): Promise<VaultEntry>;
  retrieve(
    reference: string,
    purpose: string,
    deviceAssertion: DeviceAssertion,
  ): Promise<Record<string, string>>;
  retrieveForRuntime(
    reference: string,
    purpose: string,
  ): Promise<Record<string, string>>;
  delete(reference: string): Promise<void>;
}

const ASSERTION_MAX_AGE_MS = 60 * 60 * 1000;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT_MAX = 100;

export class VaultRateLimitError extends Error {
  constructor(accountId: string) {
    super(`vault retrieval rate limit exceeded for account ${accountId}`);
    this.name = "VaultRateLimitError";
  }
}
export class StaleAssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleAssertionError";
  }
}
export class CredentialNotFoundError extends Error {
  constructor(reference: string) {
    super(`credential not found or deleted: ${reference}`);
    this.name = "CredentialNotFoundError";
  }
}
// use_credential asked to call a host not on the entry's allowlist —
// hard-rejected before decrypt/dispatch. API maps to 403.
export class AllowlistViolationError extends Error {
  constructor(
    public readonly reference: string,
    public readonly host: string | null,
  ) {
    super(`host ${host ?? "(unparseable)"} is not on the credential's allowed_hosts`);
    this.name = "AllowlistViolationError";
  }
}

export interface CredentialVaultDeps {
  store: CredentialStore;
  audit: VaultAuditStore;
  kms: KMSClient;
  now?: () => Date;
}

export class CredentialVault implements VaultClient {
  constructor(private readonly deps: CredentialVaultDeps) {}

  // Upsert by (account, service, label). Creates on first write;
  // overwrites the field set (= rotation) on subsequent writes, keeping
  // the existing reference, allowed_hosts, and label.
  async store(input: VaultStoreInput): Promise<VaultEntry> {
    const label = input.label ?? DEFAULT_LABEL;
    const fieldNames = Object.keys(input.fields);
    if (fieldNames.length === 0) {
      throw new Error("store requires at least one field");
    }
    const now = this.now();
    const existing = await this.deps.store.findActiveByServiceLabel(
      input.account_id,
      input.service,
      label,
    );

    if (existing !== null) {
      const env = await this.encryptFields(existing.reference, input.account_id, input.fields);
      await this.deps.store.replaceSecret(existing.reference, {
        ...env,
        field_names: fieldNames,
        rotatedAt: now,
      });
      await this.recordAudit(input.account_id, VAULT_AUDIT_TYPES.rotated, {
        reference: existing.reference,
        requester: "user",
        service: input.service,
        label,
      });
      return {
        reference: existing.reference,
        service: input.service,
        label,
        field_names: fieldNames,
        allowed_hosts: existing.allowed_hosts,
        created_at: existing.created_at.toISOString(),
        updated: true,
      };
    }

    const reference = `vault://${input.account_id}/${input.subscription_id}/${ulid()}`;
    const env = await this.encryptFields(reference, input.account_id, input.fields);
    const allowedHosts = deriveAllowedHosts(input.service);
    const record: CredentialRecord = {
      id: ulid(),
      reference,
      account_id: input.account_id,
      subscription_id: input.subscription_id,
      label,
      type: input.type ?? null,
      env_var_suggestion: input.env_var_suggestion ?? null,
      field_names: fieldNames,
      allowed_hosts: allowedHosts,
      ciphertext: env.ciphertext,
      encrypted_dek: env.encrypted_dek,
      account_kek_blob: env.account_kek_blob,
      algorithm: "AES-256-GCM",
      metadata: { ...(input.metadata ?? {}), service: input.service },
      rotated_at: null,
      retrieval_count: 0,
      last_retrieved_at: null,
      deleted_at: null,
      created_at: now,
    };
    await this.deps.store.insert(record);
    await this.recordAudit(input.account_id, VAULT_AUDIT_TYPES.stored, {
      reference,
      requester: "system",
      service: input.service,
      label,
      ...(input.type !== undefined && input.type !== null ? { credential_type: input.type } : {}),
    });
    return {
      reference,
      service: input.service,
      label,
      field_names: fieldNames,
      allowed_hosts: allowedHosts,
      created_at: now.toISOString(),
      updated: false,
    };
  }

  // Web-only: replace an existing entry's fields, by reference,
  // account-scoped (the field editor / single-value rotate).
  async replaceFields(
    reference: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<RotateResult> {
    const existing = await this.deps.store.findActive(reference);
    if (existing === null || existing.account_id !== accountId) {
      throw new CredentialNotFoundError(reference);
    }
    if (Object.keys(fields).length === 0) {
      throw new Error("at least one field is required");
    }
    const now = this.now();
    const env = await this.encryptFields(reference, accountId, fields);
    await this.deps.store.replaceSecret(reference, {
      ...env,
      field_names: Object.keys(fields),
      rotatedAt: now,
    });
    await this.recordAudit(accountId, VAULT_AUDIT_TYPES.rotated, {
      reference,
      requester: "user",
    });
    return { rotated_at: now.toISOString() };
  }

  async retrieve(
    reference: string,
    purpose: string,
    deviceAssertion: DeviceAssertion,
  ): Promise<Record<string, string>> {
    return this.retrieveInternal({
      reference,
      purpose,
      requester: requesterFromPurpose(purpose, "user"),
      signingDeviceId: deviceAssertion.signing_device_id,
      assertion: deviceAssertion,
    });
  }

  async retrieveForRuntime(
    reference: string,
    purpose: string,
  ): Promise<Record<string, string>> {
    return this.retrieveInternal({
      reference,
      purpose,
      requester: "system",
      signingDeviceId: null,
      assertion: null,
    });
  }

  // Web-only reveal: account-scoped, returns the field map. Audited.
  async reveal(reference: string, accountId: string): Promise<Record<string, string>> {
    const record = await this.deps.store.findActive(reference);
    if (record === null || record.account_id !== accountId) {
      throw new CredentialNotFoundError(reference);
    }
    const fields = await this.decryptFields(record);
    await this.deps.store.markRetrieved(reference, this.now());
    await this.recordAudit(accountId, VAULT_AUDIT_TYPES.retrieved, {
      reference,
      purpose: "user:vault_reveal",
      requester: "user",
      outcome: "success",
    });
    return fields;
  }

  async delete(reference: string): Promise<void> {
    const existing = await this.deps.store.findActive(reference);
    await this.deps.store.softDelete(reference, this.now());
    await this.recordAudit(existing?.account_id ?? "", VAULT_AUDIT_TYPES.deleted, {
      reference,
      requester: "user",
    });
  }

  // use_credential: decrypt fields, hand them + the request to the
  // injected executor (which substitutes ${SECRET.<field>}), return only
  // the upstream response. Host hard-checked against allowed_hosts first.
  async proxy(
    reference: string,
    accountId: string,
    http: ProxyHttpTemplate,
    executor: ProxyExecutor,
  ): Promise<ProxyResponse> {
    const record = await this.deps.store.findActive(reference);
    if (record === null || record.account_id !== accountId) {
      throw new CredentialNotFoundError(reference);
    }
    const targetHost = safeHost(http.url);
    if (targetHost === null || !record.allowed_hosts.includes(targetHost)) {
      await this.recordAudit(accountId, VAULT_AUDIT_TYPES.proxyRejected, {
        reference,
        requester: "agent",
        ...(targetHost !== null ? { target_host: targetHost } : {}),
      });
      throw new AllowlistViolationError(reference, targetHost);
    }
    const fields = await this.decryptFields(record);
    const startedAt = this.now().getTime();
    try {
      const response = await executor({ accountId, http, fields });
      await this.deps.store.markRetrieved(reference, this.now());
      await this.recordAudit(accountId, VAULT_AUDIT_TYPES.proxyExecuted, {
        reference,
        requester: "agent",
        target_host: targetHost,
        response_status: response.status,
        response_size: Buffer.byteLength(response.body, "utf8"),
        upstream_duration_ms: this.now().getTime() - startedAt,
      });
      return response;
    } catch (err) {
      await this.recordAudit(accountId, VAULT_AUDIT_TYPES.proxyExecuted, {
        reference,
        requester: "agent",
        target_host: targetHost,
        upstream_duration_ms: this.now().getTime() - startedAt,
        proxy_error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  // ── private ──────────────────────────────────────────────────

  private async encryptFields(
    reference: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<{ ciphertext: Buffer; encrypted_dek: Buffer; account_kek_blob: Buffer }> {
    const aadValue = aadForValue(reference, accountId);
    const aadDek = aadForDek(reference, accountId);
    const kek = generateKey();
    const dek = generateKey();
    const plaintext = Buffer.from(JSON.stringify(fields), "utf8");
    const ciphertext = encryptAesGcm(dek, plaintext, aadValue);
    const encryptedDek = encryptAesGcm(kek, dek, aadDek);
    const accountKekBlob = await this.deps.kms.encrypt(kek);
    kek.fill(0);
    dek.fill(0);
    plaintext.fill(0);
    return { ciphertext, encrypted_dek: encryptedDek, account_kek_blob: accountKekBlob };
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private async decryptFields(record: CredentialRecord): Promise<Record<string, string>> {
    const aadValue = aadForValue(record.reference, record.account_id);
    const aadDek = aadForDek(record.reference, record.account_id);
    const kek = await this.deps.kms.decrypt(record.account_kek_blob);
    const dek = decryptAesGcm(kek, record.encrypted_dek, aadDek);
    const plaintextBuf = decryptAesGcm(dek, record.ciphertext, aadValue);
    const text = plaintextBuf.toString("utf8");
    kek.fill(0);
    dek.fill(0);
    plaintextBuf.fill(0);
    return coerceFieldMap(text);
  }

  private async retrieveInternal(args: {
    reference: string;
    purpose: string;
    requester: VaultRequester;
    signingDeviceId: string | null;
    assertion: DeviceAssertion | null;
  }): Promise<Record<string, string>> {
    const { reference, purpose, requester, signingDeviceId, assertion } = args;
    const record = await this.deps.store.findActive(reference);
    const accountId = record?.account_id ?? "";

    if (record !== null) {
      const since = new Date(this.now().getTime() - RATE_LIMIT_WINDOW_MS);
      const count = await this.deps.audit.countRecentRetrievals(accountId, since);
      if (count >= RATE_LIMIT_MAX) {
        await this.recordAudit(accountId, VAULT_AUDIT_TYPES.retrieved, {
          reference, purpose, requester, signing_device_id: signingDeviceId,
          outcome: "rate_limited",
        });
        throw new VaultRateLimitError(accountId);
      }
    }
    if (assertion !== null) {
      const ageMs = this.now().getTime() - Date.parse(assertion.signed_at);
      if (Number.isNaN(ageMs) || ageMs > ASSERTION_MAX_AGE_MS || ageMs < 0) {
        await this.recordAudit(accountId, VAULT_AUDIT_TYPES.retrieved, {
          reference, purpose, requester, signing_device_id: signingDeviceId,
          outcome: "stale_assertion",
        });
        throw new StaleAssertionError(
          `device assertion stale or invalid (age=${Number.isNaN(ageMs) ? "NaN" : ageMs}ms)`,
        );
      }
    }
    if (record === null) {
      await this.recordAudit(accountId, VAULT_AUDIT_TYPES.retrieved, {
        reference, purpose, requester, signing_device_id: signingDeviceId,
        outcome: "missing_credential",
      });
      throw new CredentialNotFoundError(reference);
    }

    const fields = await this.decryptFields(record);
    await this.deps.store.markRetrieved(reference, this.now());
    await this.recordAudit(record.account_id, VAULT_AUDIT_TYPES.retrieved, {
      reference, purpose, requester, signing_device_id: signingDeviceId,
      outcome: "success",
    });
    return fields;
  }

  private async recordAudit(
    accountId: string,
    type: VaultAuditType,
    payload: VaultAuditEventInput["payload"],
  ): Promise<void> {
    await this.deps.audit.record({ account_id: accountId, type, payload });
  }
}

// Decrypted-plaintext → field map, tolerant of the pre-v2 format.
//
// v2 stores ciphertext as JSON.stringify(fields). Credentials written
// before v2 (the single-value era) hold the RAW secret string, which is
// not a JSON object — running JSON.parse on it throws and 500s reveal +
// use_credential. Coerce any non-object plaintext to a single { value }
// field so legacy credentials keep working. A valid v2 payload is always
// a JSON object with at least one string field, so it round-trips
// unchanged; only legacy raw values take the fallback.
export function coerceFieldMap(text: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { value: text }; // legacy raw secret — not JSON
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { value: text }; // legacy raw secret that parsed as a JSON scalar/array
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  // An object with no string fields isn't a usable field map — treat the
  // whole plaintext as a raw value rather than reveal nothing.
  return Object.keys(out).length > 0 ? out : { value: text };
}

function requesterFromPurpose(purpose: string, fallback: VaultRequester): VaultRequester {
  if (purpose.startsWith("agent:")) return "agent";
  if (purpose.startsWith("user:")) return "user";
  if (purpose.startsWith("system:")) return "system";
  return fallback;
}

function safeHost(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}
