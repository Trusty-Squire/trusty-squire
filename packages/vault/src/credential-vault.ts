// CredentialVault — the encrypted credential store, modelled as a
// write-only secret sink.
//
// Trust model (0.8.4): a stored secret can be STORED, ROTATED, DELETED,
// revealed to the authenticated HUMAN (web reveal), and USED server-side
// via the use_credential proxy — but it is NEVER handed back to an agent.
// The proxy injects the secret into an outbound HTTP call and returns
// only the upstream response; the plaintext never enters the agent's
// context. The proxy HARD-ENFORCES the credential's host allowlist, so a
// secret can only ever reach destinations the user pre-authorised — the
// same posture as GitHub/Fly secrets (ingest + use, never regurgitate,
// never redirect). There is deliberately no "extract the raw value to an
// agent" path, which removes the prompt-injection / exfiltration jackpot
// and is why per-call approvals are unnecessary.
//
// Encryption: AES-256-GCM throughout; per-credential KEK is KMS-encrypted.

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

export interface VaultStoreInput {
  account_id: string;
  subscription_id: string;
  type: CredentialType;
  value: string;
  env_var_suggestion: string | null;
  metadata: Record<string, unknown>;
}

export interface VaultEntry {
  reference: string;
  type: CredentialType;
  created_at: string;
  // The host allowlist derived for this credential at store time.
  allowed_hosts: string[];
}

export interface RotateResult {
  rotated_at: string;
}

export interface DeviceAssertion {
  signature: string;
  signed_at: string;
  signing_device_id: string;
}

// use_credential proxy plumbing. The executor itself (SSRF guards,
// secret substitution, sockets) lives in the API layer — the vault
// stays network-free and receives it as an injected function.
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
export type ProxyExecutor = (input: {
  accountId: string;
  http: ProxyHttpTemplate;
  secret: string;
}) => Promise<ProxyResponse>;

export interface VaultClient {
  store(input: VaultStoreInput): Promise<VaultEntry>;
  retrieve(
    reference: string,
    purpose: string,
    deviceAssertion: DeviceAssertion,
  ): Promise<string>;
  retrieveForRuntime(reference: string, purpose: string): Promise<string>;
  delete(reference: string): Promise<void>;
  rotate(reference: string, newValue: string): Promise<RotateResult>;
}

const ASSERTION_MAX_AGE_MS = 60 * 60 * 1000; // 1h
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1h
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

// The use_credential proxy was asked to call a host that isn't on the
// credential's allowlist. Hard-rejected before any upstream dispatch —
// this is what makes the vault a true write-only sink (the secret can't
// be redirected to an attacker-chosen destination). The API maps it to
// 403 with guidance to edit the allowlist in /vault.
export class AllowlistViolationError extends Error {
  constructor(
    public readonly reference: string,
    public readonly host: string | null,
  ) {
    super(
      `host ${host ?? "(unparseable)"} is not on the credential's allowed_hosts`,
    );
    this.name = "AllowlistViolationError";
  }
}

export interface CredentialVaultDeps {
  store: CredentialStore;
  audit: VaultAuditStore;
  kms: KMSClient;
  // Clock injection for tests; production reads system time.
  now?: () => Date;
}

export class CredentialVault implements VaultClient {
  constructor(private readonly deps: CredentialVaultDeps) {}

  async store(input: VaultStoreInput): Promise<VaultEntry> {
    const reference = `vault://${input.account_id}/${input.subscription_id}/${ulid()}`;
    const aadValue = aadForValue(reference, input.account_id);
    const aadDek = aadForDek(reference, input.account_id);

    const kek = generateKey();
    const dek = generateKey();
    const ciphertext = encryptAesGcm(dek, Buffer.from(input.value, "utf8"), aadValue);
    const encryptedDek = encryptAesGcm(kek, dek, aadDek);
    const kekBlob = await this.deps.kms.encrypt(kek);

    // Seed the enforced host allowlist from the service name.
    const service =
      typeof input.metadata.service === "string" ? input.metadata.service : null;
    const allowedHosts = deriveAllowedHosts(service);

    const now = this.now();
    const record: CredentialRecord = {
      id: ulid(),
      reference,
      account_id: input.account_id,
      subscription_id: input.subscription_id,
      type: input.type,
      env_var_suggestion: input.env_var_suggestion,
      allowed_hosts: allowedHosts,
      ciphertext,
      encrypted_dek: encryptedDek,
      account_kek_blob: kekBlob,
      algorithm: "AES-256-GCM",
      metadata: input.metadata,
      rotated_at: null,
      retrieval_count: 0,
      last_retrieved_at: null,
      deleted_at: null,
      created_at: now,
    };
    await this.deps.store.insert(record);

    kek.fill(0);
    dek.fill(0);

    await this.recordAudit(input.account_id, VAULT_AUDIT_TYPES.stored, {
      reference,
      requester: "system",
      credential_type: input.type,
    });

    return {
      reference,
      type: input.type,
      created_at: now.toISOString(),
      allowed_hosts: allowedHosts,
    };
  }

  async retrieve(
    reference: string,
    purpose: string,
    deviceAssertion: DeviceAssertion,
  ): Promise<string> {
    return this.retrieveInternal({
      reference,
      purpose,
      requester: requesterFromPurpose(purpose, "user"),
      signingDeviceId: deviceAssertion.signing_device_id,
      assertion: deviceAssertion,
    });
  }

  async retrieveForRuntime(reference: string, purpose: string): Promise<string> {
    return this.retrieveInternal({
      reference,
      purpose,
      requester: "system",
      signingDeviceId: null,
      assertion: null,
    });
  }

  async delete(reference: string): Promise<void> {
    const existing = await this.deps.store.findActive(reference);
    await this.deps.store.softDelete(reference, this.now());
    await this.recordAudit(existing?.account_id ?? "", VAULT_AUDIT_TYPES.deleted, {
      reference,
      requester: "user",
    });
  }

  async rotate(reference: string, newValue: string): Promise<RotateResult> {
    const existing = await this.deps.store.findActive(reference);
    if (existing === null) throw new CredentialNotFoundError(reference);
    // Reuse the same KEK/DEK envelope — only the ciphertext changes.
    const kek = await this.deps.kms.decrypt(existing.account_kek_blob);
    const aadDek = aadForDek(reference, existing.account_id);
    const dek = decryptAesGcm(kek, existing.encrypted_dek, aadDek);
    const aadValue = aadForValue(reference, existing.account_id);
    const newCiphertext = encryptAesGcm(dek, Buffer.from(newValue, "utf8"), aadValue);
    const rotatedAt = this.now();
    await this.deps.store.rotate(reference, newCiphertext, rotatedAt);
    kek.fill(0);
    dek.fill(0);
    await this.recordAudit(existing.account_id, VAULT_AUDIT_TYPES.rotated, {
      reference,
      requester: "user",
    });
    return { rotated_at: rotatedAt.toISOString() };
  }

  // ── use_credential: server-side proxy (write-only sink) ──────
  //
  // Decrypt the secret, hand it + the request to the injected executor,
  // return only the upstream response. The secret never returns to the
  // caller. The target host is HARD-CHECKED against the credential's
  // allowed_hosts before anything is decrypted or dispatched — an
  // off-allowlist host is rejected (the secret can't be redirected).
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

    const secret = await this.decryptRecord(record);
    const startedAt = this.now().getTime();
    try {
      const response = await executor({ accountId, http, secret });
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
      // Forensic row even on failure — the secret is never in it.
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

  // ── Private ─────────────────────────────────────────────────

  private async retrieveInternal(args: {
    reference: string;
    purpose: string;
    requester: VaultRequester;
    signingDeviceId: string | null;
    assertion: DeviceAssertion | null;
  }): Promise<string> {
    const { reference, purpose, requester, signingDeviceId, assertion } = args;

    const record = await this.deps.store.findActive(reference);
    const accountId = record?.account_id ?? "";

    if (record !== null) {
      const since = new Date(this.now().getTime() - RATE_LIMIT_WINDOW_MS);
      const count = await this.deps.audit.countRecentRetrievals(accountId, since);
      if (count >= RATE_LIMIT_MAX) {
        await this.recordAudit(accountId, VAULT_AUDIT_TYPES.retrieved, {
          reference,
          purpose,
          requester,
          signing_device_id: signingDeviceId,
          outcome: "rate_limited",
        });
        throw new VaultRateLimitError(accountId);
      }
    }

    if (assertion !== null) {
      const ageMs = this.now().getTime() - Date.parse(assertion.signed_at);
      if (Number.isNaN(ageMs) || ageMs > ASSERTION_MAX_AGE_MS || ageMs < 0) {
        await this.recordAudit(accountId, VAULT_AUDIT_TYPES.retrieved, {
          reference,
          purpose,
          requester,
          signing_device_id: signingDeviceId,
          outcome: "stale_assertion",
        });
        throw new StaleAssertionError(
          `device assertion stale or invalid (age=${Number.isNaN(ageMs) ? "NaN" : ageMs}ms)`,
        );
      }
    }

    if (record === null) {
      await this.recordAudit(accountId, VAULT_AUDIT_TYPES.retrieved, {
        reference,
        purpose,
        requester,
        signing_device_id: signingDeviceId,
        outcome: "missing_credential",
      });
      throw new CredentialNotFoundError(reference);
    }

    const plaintext = await this.decryptRecord(record);

    await this.deps.store.markRetrieved(reference, this.now());
    await this.recordAudit(record.account_id, VAULT_AUDIT_TYPES.retrieved, {
      reference,
      purpose,
      requester,
      signing_device_id: signingDeviceId,
      outcome: "success",
    });

    return plaintext;
  }

  private async decryptRecord(record: CredentialRecord): Promise<string> {
    const aadValue = aadForValue(record.reference, record.account_id);
    const aadDek = aadForDek(record.reference, record.account_id);
    const kek = await this.deps.kms.decrypt(record.account_kek_blob);
    const dek = decryptAesGcm(kek, record.encrypted_dek, aadDek);
    const plaintextBuf = decryptAesGcm(dek, record.ciphertext, aadValue);
    const plaintext = plaintextBuf.toString("utf8");
    kek.fill(0);
    dek.fill(0);
    plaintextBuf.fill(0);
    return plaintext;
  }

  private async recordAudit(
    accountId: string,
    type: VaultAuditType,
    payload: VaultAuditEventInput["payload"],
  ): Promise<void> {
    await this.deps.audit.record({ account_id: accountId, type, payload });
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }
}

// Convention: purpose strings prefixed `agent:` / `user:` / `system:`
// route the audit requester; default to the caller's hint.
function requesterFromPurpose(purpose: string, fallback: VaultRequester): VaultRequester {
  if (purpose.startsWith("agent:")) return "agent";
  if (purpose.startsWith("user:")) return "user";
  if (purpose.startsWith("system:")) return "system";
  return fallback;
}

// Parse the host out of a URL for the allowlist check; null on an
// unparseable URL (which the proxy then rejects).
function safeHost(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}
