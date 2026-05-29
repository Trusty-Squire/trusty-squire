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
import { deriveAllowedHosts } from "./service-hosts.js";
import {
  effectiveGrantStatus,
  PENDING_TTL_SECONDS,
  type AccessGrantRecord,
  type AccessGrantStore,
  type GrantIntent,
  type GrantMode,
} from "./access-grant.js";
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
  // The advisory host allowlist derived for this credential at store
  // time (see service-hosts.ts). Surfaced so the manual-paste route can
  // echo it straight back to the web UI.
  allowed_hosts: string[];
}

// Result of a rotation. revoked_grant_count is the number of
// outstanding persistent access-grants invalidated by the new value
// (the rotation cascade lands with the AccessGrant store in a later
// PR; today there are no grants, so it's always 0).
export interface RotateResult {
  rotated_at: string;
  revoked_grant_count: number;
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

// Thrown when a grant doesn't exist for the calling agent session, or
// isn't in a state that permits the requested operation (not approved,
// expired, already consumed, wrong intent). The route maps it to 409.
export class GrantNotUsableError extends Error {
  constructor(
    public readonly requestId: string,
    public readonly reason: string,
  ) {
    super(`access grant ${requestId} not usable: ${reason}`);
    this.name = "GrantNotUsableError";
  }
}

export class AccessGrantsNotConfiguredError extends Error {
  constructor() {
    super("CredentialVault has no accessGrants store wired");
    this.name = "AccessGrantsNotConfiguredError";
  }
}

export interface CredentialVaultDeps {
  store: CredentialStore;
  audit: VaultAuditStore;
  kms: KMSClient;
  // Agent-mediated access broker. Optional so the historic
  // signup-write path (no grants) keeps working; the access routes
  // require it and throw AccessGrantsNotConfiguredError when absent.
  accessGrants?: AccessGrantStore;
  // Clock injection for tests; production reads system time.
  now?: () => Date;
}

// use_credential proxy plumbing. The executor itself (SSRF guards,
// substitution, sockets) lives in the API layer — the vault stays
// network-free and receives it as an injected function.
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

// Input to requestAccess — the agent's ask, plus the trust signal the
// route resolved from the agent session (the vault doesn't know about
// sessions, so trust is passed in).
export interface RequestAccessInput {
  account_id: string;
  reference: string;
  agent_session_id: string;
  intent: GrantIntent;
  mode: GrantMode;
  ttl_seconds: number;
  purpose: string;
  reason_proxy_not_possible?: string | null;
  requested_target_host?: string | null;
  // True when the calling agent session is marked trusted (≤24h passkey
  // step-up). Gates proxy auto-approval together with the host allowlist.
  session_trusted: boolean;
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

    // Seed the advisory host allowlist from the service name. The
    // service lives in metadata (the universal-bot + manual-paste paths
    // both set `metadata.service`); unknown services start empty.
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

    // Plaintext key material zeroed before returning. Defensive — Buffer
    // contents may linger in heap fragments otherwise.
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
    // Load before deleting so the audit row carries the account_id.
    // Soft-delete on a missing reference is a no-op (matches the store
    // contract) — record the attempt with an empty account_id so the
    // probe still leaves a trail.
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
    // Anyone holding access to decrypt the old value can decrypt the
    // new one too; this is a value rotation, not a key rotation.
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
    // Rotation cascade: the new value invalidates every outstanding
    // persistent grant for this reference — the next use_credential gets
    // a fresh approval. No-op when no grant store is wired.
    const revokedGrantCount =
      this.deps.accessGrants !== undefined
        ? await this.deps.accessGrants.revokePersistentByReference(
            reference,
            existing.account_id,
          )
        : 0;
    return {
      rotated_at: rotatedAt.toISOString(),
      revoked_grant_count: revokedGrantCount,
    };
  }

  // ── Agent-mediated access ────────────────────────────────────

  // Create a pending access request, or mint an auto-approved one-shot
  // grant when the session is trusted, the intent is a proxy call, and
  // the target host is on the credential's advisory allowlist.
  async requestAccess(input: RequestAccessInput): Promise<AccessGrantRecord> {
    const grants = this.requireGrants();
    const credential = await this.deps.store.findActive(input.reference);
    if (credential === null) throw new CredentialNotFoundError(input.reference);

    const now = this.now();
    const autoApprove =
      input.session_trusted &&
      input.intent === "proxy" &&
      input.requested_target_host !== null &&
      input.requested_target_host !== undefined &&
      credential.allowed_hosts.includes(input.requested_target_host);

    const base: AccessGrantRecord = {
      id: ulid(),
      account_id: input.account_id,
      reference: input.reference,
      agent_session_id: input.agent_session_id,
      intent: input.intent,
      mode: input.mode,
      ttl_seconds: input.ttl_seconds,
      purpose: input.purpose,
      reason_proxy_not_possible: input.reason_proxy_not_possible ?? null,
      requested_target_host: input.requested_target_host ?? null,
      requested_at: now,
      decided_at: null,
      expires_at: new Date(now.getTime() + PENDING_TTL_SECONDS * 1000),
      status: "pending",
      auto_approved: false,
    };

    if (autoApprove) {
      // One-shot grant minted approved; the proxy consumes it on use.
      base.mode = "once";
      base.status = "approved";
      base.auto_approved = true;
      base.decided_at = now;
      base.expires_at = new Date(now.getTime() + input.ttl_seconds * 1000);
    }

    await grants.insert(base);
    await this.recordAudit(input.account_id, VAULT_AUDIT_TYPES.accessRequested, {
      reference: input.reference,
      requester: "agent",
      request_id: base.id,
      agent_session_id: input.agent_session_id,
      intent: input.intent,
      mode: base.mode,
      auto_approved: base.auto_approved,
      ...(base.requested_target_host !== null
        ? { target_host: base.requested_target_host }
        : {}),
    });
    if (autoApprove) {
      await this.recordAudit(input.account_id, VAULT_AUDIT_TYPES.accessApproved, {
        reference: input.reference,
        requester: "system",
        request_id: base.id,
        agent_session_id: input.agent_session_id,
        intent: input.intent,
        mode: base.mode,
        auto_approved: true,
      });
    }
    return base;
  }

  // Resolve an approved value-intent grant to the raw secret. Consumes
  // single-use ("once") grants via a conditional UPDATE so a double-poll
  // can't extract the value twice. Throws GrantNotUsableError (→409) on
  // any non-approved / expired / wrong-intent / cross-session state.
  async retrieveWithGrant(
    requestId: string,
    accountId: string,
    agentSessionId: string,
    purpose: string,
  ): Promise<string> {
    const grants = this.requireGrants();
    const now = this.now();
    const grant = await grants.findByIdForAgentSession(requestId, agentSessionId);
    if (grant === null || grant.account_id !== accountId) {
      throw new GrantNotUsableError(requestId, "not_found");
    }
    if (grant.intent !== "value") {
      throw new GrantNotUsableError(requestId, "wrong_intent");
    }
    if (effectiveGrantStatus(grant, now) !== "approved") {
      throw new GrantNotUsableError(requestId, "not_approved");
    }
    if (grant.mode === "once") {
      const consumed = await grants.consume({ id: requestId, accountId });
      if (consumed === 0) throw new GrantNotUsableError(requestId, "already_consumed");
    }

    const record = await this.deps.store.findActive(grant.reference);
    if (record === null) throw new CredentialNotFoundError(grant.reference);
    const plaintext = await this.decryptRecord(record);

    await this.deps.store.markRetrieved(grant.reference, now);
    await this.recordAudit(accountId, VAULT_AUDIT_TYPES.accessConsumed, {
      reference: grant.reference,
      requester: "agent",
      request_id: requestId,
      agent_session_id: agentSessionId,
      intent: "value",
      mode: grant.mode,
      purpose,
    });
    return plaintext;
  }

  // Execute an approved proxy-intent grant: validate + consume the
  // grant, decrypt the secret server-side, hand both to the injected
  // executor, and audit the call (outcome only — never the secret). The
  // off-allowlist case is advisory: it's logged and proceeds (the
  // untrusted-no-auto-approve gate already happened at requestAccess).
  async proxyWithGrant(
    requestId: string,
    accountId: string,
    agentSessionId: string,
    http: ProxyHttpTemplate,
    executor: ProxyExecutor,
  ): Promise<ProxyResponse> {
    const grants = this.requireGrants();
    const now = this.now();
    const grant = await grants.findByIdForAgentSession(requestId, agentSessionId);
    if (grant === null || grant.account_id !== accountId) {
      throw new GrantNotUsableError(requestId, "not_found");
    }
    if (grant.intent !== "proxy") {
      throw new GrantNotUsableError(requestId, "wrong_intent");
    }
    if (effectiveGrantStatus(grant, now) !== "approved") {
      throw new GrantNotUsableError(requestId, "not_approved");
    }
    if (grant.mode === "once") {
      const consumed = await grants.consume({ id: requestId, accountId });
      if (consumed === 0) throw new GrantNotUsableError(requestId, "already_consumed");
    }

    const record = await this.deps.store.findActive(grant.reference);
    if (record === null) throw new CredentialNotFoundError(grant.reference);

    const targetHost = safeHost(http.url);
    if (targetHost !== null && !record.allowed_hosts.includes(targetHost)) {
      await this.recordAudit(accountId, VAULT_AUDIT_TYPES.proxyOffAllowlist, {
        reference: grant.reference,
        requester: "agent",
        request_id: requestId,
        agent_session_id: agentSessionId,
        intent: "proxy",
        target_host: targetHost,
      });
    }

    const secret = await this.decryptRecord(record);
    const startedAt = this.now().getTime();
    try {
      const response = await executor({ accountId, http, secret });
      await this.recordAudit(accountId, VAULT_AUDIT_TYPES.proxyExecuted, {
        reference: grant.reference,
        requester: "agent",
        request_id: requestId,
        agent_session_id: agentSessionId,
        intent: "proxy",
        mode: grant.mode,
        ...(targetHost !== null ? { target_host: targetHost } : {}),
        response_status: response.status,
        response_size: Buffer.byteLength(response.body, "utf8"),
        upstream_duration_ms: this.now().getTime() - startedAt,
      });
      return response;
    } catch (err) {
      // Forensic row even on failure — the secret is never in it.
      await this.recordAudit(accountId, VAULT_AUDIT_TYPES.proxyExecuted, {
        reference: grant.reference,
        requester: "agent",
        request_id: requestId,
        agent_session_id: agentSessionId,
        intent: "proxy",
        mode: grant.mode,
        ...(targetHost !== null ? { target_host: targetHost } : {}),
        upstream_duration_ms: this.now().getTime() - startedAt,
        proxy_error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  // Emit an access-lifecycle audit row from the API layer (the web
  // approve/deny routes drive the state transition via the store, then
  // record the audit through here so all vault audit goes one place).
  async recordAccessAudit(
    accountId: string,
    type: VaultAuditType,
    payload: VaultAuditEventInput["payload"],
  ): Promise<void> {
    await this.recordAudit(accountId, type, payload);
  }

  private requireGrants(): AccessGrantStore {
    if (this.deps.accessGrants === undefined) {
      throw new AccessGrantsNotConfiguredError();
    }
    return this.deps.accessGrants;
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
    await this.recordAudit(record.account_id, VAULT_AUDIT_TYPES.retrieved, {
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
    type: VaultAuditType,
    payload: VaultAuditEventInput["payload"],
  ): Promise<void> {
    await this.deps.audit.record({
      account_id: accountId,
      type,
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

// Parse the host out of a URL for the advisory allowlist check; returns
// null on an unparseable URL (the executor surfaces the real error).
function safeHost(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}
