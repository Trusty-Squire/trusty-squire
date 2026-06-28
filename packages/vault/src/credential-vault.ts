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

// Normalise an observed host: accept a bare host ("api.x.com") or a full
// URL ("https://api.x.com/keys?x=1") and return the lowercase hostname, or
// null if it can't be parsed into one. Strips scheme/path/port/credentials.
export function normalizeObservedHost(raw: string): string | null {
  const s = raw.trim();
  if (s.length === 0) return null;
  try {
    return new URL(s.includes("://") ? s : `https://${s}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

// The allowlist for a freshly-stored credential: hosts observed during the
// capture, unioned with the static service-name table, deduped in order.
// Observed hosts come first (they're the ground truth for THIS credential);
// the table augments. Result is empty only when neither yields a host.
export function mergeAllowedHosts(service: string, observed?: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (h: string | null): void => {
    if (h !== null && !seen.has(h)) {
      seen.add(h);
      out.push(h);
    }
  };
  for (const raw of observed ?? []) add(normalizeObservedHost(raw));
  for (const h of deriveAllowedHosts(service)) add(h);
  return out;
}
import type {
  CredentialRecord,
  CredentialStore,
  CredentialType,
  VaultAuditEventInput,
  VaultAuditListOptions,
  VaultAuditPayload,
  VaultAuditRecord,
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
  // Hosts observed during the capture that produced this credential (e.g.
  // the signup URL's host, the page the key was extracted from). Unioned
  // with the static service-name table so a successful capture never lands
  // with an EMPTY allowlist — which would make use_credential 403 every
  // call. Accepts bare hosts or full URLs; normalised + deduped.
  observed_hosts?: string[];
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

// Envelope health probe result. `healthy` means the full
// KMS→KEK→DEK→ciphertext chain decrypted cleanly — it does NOT mean the
// upstream service still accepts the key (that needs a per-service live
// call, out of this layer's scope). `field_count` is the number of
// fields recovered; no value is ever exposed.
export interface VaultHealthResult {
  reference: string;
  healthy: boolean;
  field_count?: number;
  algorithm?: string;
  error?: string;
}

// GDPR export shape — non-secret metadata + the full audit trail. No
// ciphertext, no secret values, ever.
export interface VaultCredentialExport {
  id: string;
  reference: string;
  service: string | null;
  label: string;
  type: string | null;
  env_var_suggestion: string | null;
  field_names: string[];
  allowed_hosts: string[];
  retrieval_count: number;
  last_retrieved_at: Date | null;
  rotated_at: Date | null;
  created_at: Date;
  deleted_at: Date | null;
}
export interface VaultAccountExport {
  account_id: string;
  credentials: VaultCredentialExport[];
  audit_events: VaultAuditRecord[];
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
  // Query params injected server-side (the sanctioned channel for
  // query-string-auth APIs — a ${SECRET} is allowed in a value here but
  // not in `url`). Passed through to the executor; host check uses `url`.
  query?: Record<string, string>;
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
  retrieveForAgentBrowserFill(
    reference: string,
    accountId: string,
    purpose?: string,
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
// addField refused: the entry already has a field with this name. Adding
// is additive — changing an existing field's value is the rotate path.
// API maps to 409.
export class FieldExistsError extends Error {
  constructor(public readonly field: string) {
    super(`field already exists: ${field}`);
    this.name = "FieldExistsError";
  }
}
// Restore refused: an active credential already occupies this entry's
// (service, label) slot, so undeleting would create a duplicate active
// twin and break the one-active-per-(account,service,label) invariant.
// API maps to 409. The user must delete/rotate the live one first.
export class RestoreConflictError extends Error {
  constructor(
    public readonly reference: string,
    public readonly service: string,
    public readonly label: string,
  ) {
    super(`cannot restore ${reference}: an active credential for ${service}/${label} already exists`);
    this.name = "RestoreConflictError";
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
  // Workload proxy traffic should not turn a successful upstream response into
  // a 500 because a post-response retrieval counter/audit write hit a transient
  // DB connection failure. Storage/reveal/rotate/delete audit semantics stay
  // strict; this option applies only to proxy() audit side effects.
  proxyAuditFailureMode?: "strict" | "best_effort";
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
      // Backfill an EMPTY allowlist on re-store, but never clobber a
      // non-empty one (the user may have curated it). This heals
      // credentials stored before allowed_hosts existed (or before their
      // service was in the table) — a re-store now lands a real allowlist.
      let allowedHosts = existing.allowed_hosts;
      if (allowedHosts.length === 0) {
        const backfilled = mergeAllowedHosts(input.service, input.observed_hosts);
        if (backfilled.length > 0) {
          await this.deps.store.setAllowedHosts(existing.reference, backfilled);
          allowedHosts = backfilled;
        }
      }
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
        allowed_hosts: allowedHosts,
        created_at: existing.created_at.toISOString(),
        updated: true,
      };
    }

    const reference = `vault://${input.account_id}/${input.subscription_id}/${ulid()}`;
    const env = await this.encryptFields(reference, input.account_id, input.fields);
    const allowedHosts = mergeAllowedHosts(input.service, input.observed_hosts);
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

  // Web-only: rename an entry. Changes the (non-secret) label only —
  // the encrypted payload, field names, and allowed_hosts are untouched.
  // Account-scoped.
  async rename(
    reference: string,
    accountId: string,
    label: string,
  ): Promise<{ label: string }> {
    const trimmed = label.trim();
    if (trimmed.length === 0) {
      throw new Error("label must not be empty");
    }
    const existing = await this.deps.store.findActive(reference);
    if (existing === null || existing.account_id !== accountId) {
      throw new CredentialNotFoundError(reference);
    }
    await this.deps.store.setLabel(reference, trimmed);
    await this.recordAudit(accountId, VAULT_AUDIT_TYPES.renamed, {
      reference,
      requester: "user",
      label: trimmed,
    });
    return { label: trimmed };
  }

  // Web-only: add a single field to an existing entry WITHOUT the caller
  // supplying the existing field values (the vault is write-only across
  // the API boundary, so the UI can't round-trip them). We decrypt the
  // current blob server-side, merge the new field, and re-encrypt. A
  // collision on `name` is rejected — adding is additive; changing an
  // existing field's value is the rotate/replaceFields path.
  async addField(
    reference: string,
    accountId: string,
    name: string,
    value: string,
  ): Promise<{ field_names: string[] }> {
    const fieldName = name.trim();
    if (fieldName.length === 0) {
      throw new Error("field name must not be empty");
    }
    const record = await this.deps.store.findActive(reference);
    if (record === null || record.account_id !== accountId) {
      throw new CredentialNotFoundError(reference);
    }
    const current = await this.decryptFields(record);
    if (Object.prototype.hasOwnProperty.call(current, fieldName)) {
      throw new FieldExistsError(fieldName);
    }
    const merged = { ...current, [fieldName]: value };
    const fieldNames = Object.keys(merged);
    const now = this.now();
    const env = await this.encryptFields(reference, accountId, merged);
    await this.deps.store.replaceSecret(reference, {
      ...env,
      field_names: fieldNames,
      rotatedAt: now,
    });
    await this.recordAudit(accountId, VAULT_AUDIT_TYPES.fieldAdded, {
      reference,
      requester: "user",
      label: record.label,
    });
    return { field_names: fieldNames };
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

  async retrieveForAgentBrowserFill(
    reference: string,
    accountId: string,
    purpose = "agent:browser_login_fill",
  ): Promise<Record<string, string>> {
    const record = await this.deps.store.findActive(reference);
    if (record === null || record.account_id !== accountId) {
      throw new CredentialNotFoundError(reference);
    }
    return this.retrieveInternal({
      reference,
      purpose,
      requester: "agent",
      signingDeviceId: null,
      assertion: null,
    });
  }

  // Web-only reveal: account-scoped, returns the field map. Audited.
  // Counts against the same per-account retrieval rate limit as the
  // agent/runtime paths — a reveal IS a retrieval, so the human path
  // can't be used to sidestep the 100/hr ceiling.
  async reveal(reference: string, accountId: string): Promise<Record<string, string>> {
    const record = await this.deps.store.findActive(reference);
    if (record === null || record.account_id !== accountId) {
      throw new CredentialNotFoundError(reference);
    }
    await this.enforceRetrievalRateLimit(accountId, {
      reference,
      purpose: "user:vault_reveal",
      requester: "user",
    });
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

  // Web-only integrity check: confirm the credential's encrypted
  // envelope still decrypts under the current KMS keyring + DEK chain,
  // WITHOUT returning the secret or calling upstream. Catches silent rot
  // — a credential orphaned by a botched master-key rotation, or a row
  // whose envelope no longer authenticates. Does not mark a retrieval or
  // count toward the rate limit: it's an integrity probe, not a use.
  async checkHealth(reference: string, accountId: string): Promise<VaultHealthResult> {
    const record = await this.deps.store.findActive(reference);
    if (record === null || record.account_id !== accountId) {
      throw new CredentialNotFoundError(reference);
    }
    try {
      const fields = await this.decryptFields(record);
      return {
        reference,
        healthy: true,
        field_count: Object.keys(fields).length,
        algorithm: record.algorithm,
      };
    } catch (err) {
      return {
        reference,
        healthy: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // Undelete: bring a soft-deleted credential back to active, account-
  // scoped + audited. Idempotent if it's already active. Refuses (409)
  // if restoring would collide with a live (service,label) twin — the
  // one-active-per-slot invariant the upsert path relies on.
  async restore(reference: string, accountId: string): Promise<void> {
    const rec = await this.deps.store.findByReferenceIncludingDeleted(reference);
    if (rec === null || rec.account_id !== accountId) {
      throw new CredentialNotFoundError(reference);
    }
    if (rec.deleted_at === null) return; // already active — no-op
    const service = typeof rec.metadata.service === "string" ? rec.metadata.service : "";
    if (service.length > 0) {
      const live = await this.deps.store.findActiveByServiceLabel(accountId, service, rec.label);
      if (live !== null) {
        throw new RestoreConflictError(reference, service, rec.label);
      }
    }
    await this.deps.store.restore(reference);
    await this.recordAudit(accountId, VAULT_AUDIT_TYPES.restored, {
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
    return this.proxyRecord(record, accountId, http, executor);
  }

  async proxyResolvedCredential(
    record: CredentialRecord,
    accountId: string,
    http: ProxyHttpTemplate,
    executor: ProxyExecutor,
  ): Promise<ProxyResponse> {
    if (record.account_id !== accountId || record.deleted_at !== null) {
      throw new CredentialNotFoundError(record.reference);
    }
    return this.proxyRecord(record, accountId, http, executor);
  }

  private async proxyRecord(
    record: CredentialRecord,
    accountId: string,
    http: ProxyHttpTemplate,
    executor: ProxyExecutor,
  ): Promise<ProxyResponse> {
    const reference = record.reference;
    const targetHost = safeHost(http.url);
    if (targetHost === null || !record.allowed_hosts.includes(targetHost)) {
      await this.recordProxyAudit(accountId, VAULT_AUDIT_TYPES.proxyRejected, {
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
      await this.runProxyAuditSideEffect(() => this.deps.store.markRetrieved(reference, this.now()));
      await this.recordProxyAudit(accountId, VAULT_AUDIT_TYPES.proxyExecuted, {
        reference,
        requester: "agent",
        target_host: targetHost,
        response_status: response.status,
        response_size: Buffer.byteLength(response.body, "utf8"),
        upstream_duration_ms: this.now().getTime() - startedAt,
      });
      return response;
    } catch (err) {
      await this.recordProxyAudit(accountId, VAULT_AUDIT_TYPES.proxyExecuted, {
        reference,
        requester: "agent",
        target_host: targetHost,
        upstream_duration_ms: this.now().getTime() - startedAt,
        proxy_error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  // Web-only: the account's audit trail (who-touched-my-keys timeline).
  // Read-through to the audit store; payloads never carry secret values.
  async listAudit(accountId: string, opts?: VaultAuditListOptions): Promise<VaultAuditRecord[]> {
    return this.deps.audit.list(accountId, opts);
  }

  // GDPR data export: the complete metadata + audit trail the vault holds
  // for an account. NEVER includes secret values or the encrypted
  // envelope — only the non-secret metadata (field NAMES, hosts, counts,
  // timestamps) plus the full audit history.
  async exportAccount(accountId: string): Promise<VaultAccountExport> {
    const credentials = await this.deps.store.listByAccountIncludingDeleted(accountId);
    const audit = await this.deps.audit.exportAll(accountId);
    return {
      account_id: accountId,
      credentials: credentials.map((c) => ({
        id: c.id,
        reference: c.reference,
        service: typeof c.metadata.service === "string" ? c.metadata.service : null,
        label: c.label,
        type: c.type,
        env_var_suggestion: c.env_var_suggestion,
        field_names: c.field_names,
        allowed_hosts: c.allowed_hosts,
        retrieval_count: c.retrieval_count,
        last_retrieved_at: c.last_retrieved_at,
        rotated_at: c.rotated_at,
        created_at: c.created_at,
        deleted_at: c.deleted_at,
      })),
      audit_events: audit,
    };
  }

  // Irreversible account offboarding (GDPR erasure): hard-purge every
  // credential row AND the entire audit trail for the account. Nothing
  // is recoverable after this — the soft-delete + retention path is the
  // forgiving one; this is the right-to-be-forgotten hard one.
  async purgeAccount(accountId: string): Promise<{ credentials_purged: number; audit_purged: number }> {
    const credentials_purged = await this.deps.store.purgeAccount(accountId);
    const audit_purged = await this.deps.audit.purgeAccount(accountId);
    return { credentials_purged, audit_purged };
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
      await this.enforceRetrievalRateLimit(accountId, {
        reference, purpose, requester, signing_device_id: signingDeviceId,
      });
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

  // Per-account retrieval rate limit, shared by every decrypt path
  // (agent retrieve, runtime retrieve, web reveal). Counts `retrieved`
  // audit rows in the trailing window; on breach it records a
  // rate_limited event and throws. Keeping this in one place is what
  // stops a new decrypt path from silently bypassing the ceiling.
  private async enforceRetrievalRateLimit(
    accountId: string,
    auditOnLimit: Pick<VaultAuditPayload, "reference" | "purpose" | "requester" | "signing_device_id">,
  ): Promise<void> {
    const since = new Date(this.now().getTime() - RATE_LIMIT_WINDOW_MS);
    const count = await this.deps.audit.countRecentRetrievals(accountId, since);
    if (count >= RATE_LIMIT_MAX) {
      await this.recordAudit(accountId, VAULT_AUDIT_TYPES.retrieved, {
        ...auditOnLimit,
        outcome: "rate_limited",
      });
      throw new VaultRateLimitError(accountId);
    }
  }

  private async recordAudit(
    accountId: string,
    type: VaultAuditType,
    payload: VaultAuditEventInput["payload"],
  ): Promise<void> {
    await this.deps.audit.record({ account_id: accountId, type, payload });
  }

  private async recordProxyAudit(
    accountId: string,
    type: VaultAuditType,
    payload: VaultAuditEventInput["payload"],
  ): Promise<void> {
    await this.runProxyAuditSideEffect(() => this.recordAudit(accountId, type, payload));
  }

  private async runProxyAuditSideEffect(fn: () => Promise<void>): Promise<void> {
    if (this.deps.proxyAuditFailureMode !== "best_effort") {
      await fn();
      return;
    }
    try {
      await fn();
    } catch {
      // Proxy audit/retrieval counters are important telemetry, but under
      // workload egress traffic they must not poison an otherwise successful
      // upstream response. The API process logs request failures at the route
      // layer; this package intentionally stays logger-free.
    }
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
