// CredentialVault — the user-facing implementation of VaultClient.
//
// Implements the VaultClient interface defined in @trusty-squire/runtime
// (chunk 5). Per the chunk-6 design decisions:
//   - retrieve(): freshness-checks the DeviceAssertion (≤ 1h old);
//     audit logs the read; rate limits at 100/h/account.
//   - retrieveForRuntime(): no DeviceAssertion required (compensation
//     and scheduled rotations don't have a fresh user signature). Same
//     rate limit applies; audit logs `requester: "system"`. Trade-off:
//     a DB+KMS compromise can decrypt these without a device. Future
//     chunks may opt-in specific credentials to a stricter path.
//   - Encryption uses AES-256-GCM throughout. Per-credential KEK is
//     KMS-encrypted. The HKDF/session-KEK primitive exists in
//     kek-derivation.ts but isn't wired in yet (chunk-6 simplification
//     — see comment in that file).

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
import type {
  CredentialRecord,
  CredentialStore,
  CredentialType,
  VaultAuditEventInput,
  VaultAuditStore,
  VaultRequester,
} from "./types.js";

// VaultClient surface — inlined here in 0.8 after the runtime
// package was sunset. Same shape as the historic runtime-side
// definition (chunk 5): a user-facing retrieve() with a fresh
// device assertion + a system-side retrieveForRuntime() for
// rotations and the universal-bot post-extract write path.
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
}

export interface DeviceAssertion {
  signature: string;
  signed_at: string;
  signing_device_id: string;
}

export interface VaultClient {
  store(input: VaultStoreInput): Promise<VaultEntry>;
  retrieve(
    reference: string,
    purpose: string,
    deviceAssertion: DeviceAssertion,
  ): Promise<string>;
  retrieveForRuntime(reference: string, purpose: string): Promise<string>;
  delete(reference: string): Promise<void>;
  rotate(reference: string, newValue: string): Promise<void>;
}

const ASSERTION_MAX_AGE_MS = 60 * 60 * 1000; // 1h
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1h
const RATE_LIMIT_MAX = 100;
const AUDIT_TYPE = "vault.credential_retrieved";

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

    // Per-credential envelope: fresh DEK + fresh KEK. Both wrapped.
    // Re-using KEK across an account's credentials is a future
    // optimisation; per-credential here keeps the test surface clean.
    const kek = generateKey();
    const dek = generateKey();
    const ciphertext = encryptAesGcm(dek, Buffer.from(input.value, "utf8"), aadValue);
    const encryptedDek = encryptAesGcm(kek, dek, aadDek);
    const kekBlob = await this.deps.kms.encrypt(kek);

    const now = this.now();
    const record: CredentialRecord = {
      id: ulid(),
      reference,
      account_id: input.account_id,
      subscription_id: input.subscription_id,
      type: input.type,
      env_var_suggestion: input.env_var_suggestion,
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

    // Plaintext key material zeroed before returning. Defensive — Buffer
    // contents may linger in heap fragments otherwise.
    kek.fill(0);
    dek.fill(0);

    return { reference, type: input.type, created_at: now.toISOString() };
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
    await this.deps.store.softDelete(reference, this.now());
  }

  async rotate(reference: string, newValue: string): Promise<void> {
    const existing = await this.deps.store.findActive(reference);
    if (existing === null) throw new CredentialNotFoundError(reference);
    // Reuse the same KEK/DEK envelope — only the ciphertext changes.
    // Anyone holding access to decrypt the old value can decrypt the
    // new one too; this is a value rotation, not a key rotation.
    const kek = await this.deps.kms.decrypt(existing.account_kek_blob);
    const aadDek = aadForDek(reference, existing.account_id);
    const dek = decryptAesGcm(kek, existing.encrypted_dek, aadDek);
    const aadValue = aadForValue(reference, existing.account_id);
    const newCiphertext = encryptAesGcm(dek, Buffer.from(newValue, "utf8"), aadValue);
    await this.deps.store.rotate(reference, newCiphertext, this.now());
    kek.fill(0);
    dek.fill(0);
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

    // Load early so rate-limit / freshness audit events can record
    // account_id (we need it to query the rate-limit window). If the
    // credential is missing, audit with a synthetic accountId of "".
    const record = await this.deps.store.findActive(reference);
    const accountId = record?.account_id ?? "";

    // Rate limit before assertion / decrypt. Even probes count.
    if (record !== null) {
      const since = new Date(this.now().getTime() - RATE_LIMIT_WINDOW_MS);
      const count = await this.deps.audit.countRecentRetrievals(accountId, since);
      if (count >= RATE_LIMIT_MAX) {
        await this.recordAudit(accountId, {
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
        await this.recordAudit(accountId, {
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
      await this.recordAudit(accountId, {
        reference,
        purpose,
        requester,
        signing_device_id: signingDeviceId,
        outcome: "missing_credential",
      });
      throw new CredentialNotFoundError(reference);
    }

    const aadValue = aadForValue(reference, record.account_id);
    const aadDek = aadForDek(reference, record.account_id);
    const kek = await this.deps.kms.decrypt(record.account_kek_blob);
    const dek = decryptAesGcm(kek, record.encrypted_dek, aadDek);
    const plaintextBuf = decryptAesGcm(dek, record.ciphertext, aadValue);
    const plaintext = plaintextBuf.toString("utf8");

    kek.fill(0);
    dek.fill(0);
    plaintextBuf.fill(0);

    await this.deps.store.markRetrieved(reference, this.now());
    await this.recordAudit(record.account_id, {
      reference,
      purpose,
      requester,
      signing_device_id: signingDeviceId,
      outcome: "success",
    });

    return plaintext;
  }

  private async recordAudit(
    accountId: string,
    payload: VaultAuditEventInput["payload"],
  ): Promise<void> {
    await this.deps.audit.record({
      account_id: accountId,
      type: AUDIT_TYPE,
      payload,
    });
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }
}

// Convention: purpose strings prefixed `agent:` come from autonomous
// runtime actions, `user:` from end-user-driven UI flows. Default to
// the caller's hint.
function requesterFromPurpose(purpose: string, fallback: VaultRequester): VaultRequester {
  if (purpose.startsWith("agent:")) return "agent";
  if (purpose.startsWith("user:")) return "user";
  if (purpose.startsWith("system:")) return "system";
  return fallback;
}
