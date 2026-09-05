// Vault-first egress — the decrypt path that hands a credential to the LOCAL
// mcp process so it can put the key where it is needed (a GitHub Actions
// secret, a .env file).
//
// The load-bearing property here is that the destination gate runs BEFORE any
// decrypt: an off-allowlist destination must never cause plaintext to exist,
// not even briefly in server memory. A counting KMS proves it directly — a
// decrypt cannot happen without a `kms.decrypt` call.

import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  AllowlistViolationError,
  CredentialNotFoundError,
  CredentialVault,
  EGRESS_LOCAL_FILE_HOST,
  EGRESS_PURPOSE,
  type VaultStoreInput,
} from "../credential-vault.js";
import { InMemoryCredentialStore, InMemoryVaultAuditStore } from "../in-memory-stores.js";
import { LocalKMS } from "../kms-client.js";
import type { KMSClient } from "../kms-client.js";
import { VAULT_AUDIT_TYPES } from "../types.js";

const NOW = new Date("2026-09-05T12:00:00.000Z");
const ACCOUNT = "01HACCOUNTAAAAAAAAAAAAAAAA";
const OTHER_ACCOUNT = "01HACCOUNTBBBBBBBBBBBBBBBB";
const SUB = "01HSUBAAAAAAAAAAAAAAAAAAAA";

class CountingKMS implements KMSClient {
  decryptCalls = 0;
  constructor(private readonly inner: KMSClient) {}
  async encrypt(plaintext: Buffer): Promise<Buffer> {
    return this.inner.encrypt(plaintext);
  }
  async decrypt(ciphertext: Buffer): Promise<Buffer> {
    this.decryptCalls += 1;
    return this.inner.decrypt(ciphertext);
  }
}

function makeVault() {
  const store = new InMemoryCredentialStore();
  const audit = new InMemoryVaultAuditStore(() => NOW);
  const kms = new CountingKMS(LocalKMS.withFixedKey(Buffer.alloc(32, 0x42)));
  const vault = new CredentialVault({ store, audit, kms, now: () => NOW });
  return { vault, store, audit, kms };
}

function storeInput(over: Partial<VaultStoreInput> = {}): VaultStoreInput {
  return {
    account_id: ACCOUNT,
    subscription_id: SUB,
    service: "browserstack",
    fields: { api_key: "sk-live-egress-secret", username: "ada" },
    type: "api_key",
    observed_hosts: ["api.github.com"],
    ...over,
  };
}

describe("retrieveForEgress", () => {
  it("returns the field map for a destination host on allowed_hosts", async () => {
    const { vault, kms } = makeVault();
    const entry = await vault.store(storeInput());

    const fields = await vault.retrieveForEgress(entry.reference, ACCOUNT, "api.github.com");

    expect(fields.api_key).toBe("sk-live-egress-secret");
    expect(kms.decryptCalls).toBe(1);
  });

  it("refuses an off-allowlist destination WITHOUT decrypting anything", async () => {
    const { vault, audit, kms } = makeVault();
    const entry = await vault.store(storeInput());

    await expect(
      vault.retrieveForEgress(entry.reference, ACCOUNT, "evil.example.com"),
    ).rejects.toBeInstanceOf(AllowlistViolationError);

    // The whole point: the gate ran first, so no plaintext was ever produced.
    expect(kms.decryptCalls).toBe(0);
    const events = await audit.list(ACCOUNT);
    const rejected = events.filter((e) => e.type === VAULT_AUDIT_TYPES.proxyRejected);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.payload).toMatchObject({
      reference: entry.reference,
      requester: "agent",
      purpose: EGRESS_PURPOSE,
      target_host: "evil.example.com",
    });
    expect(events.some((e) => e.type === VAULT_AUDIT_TYPES.retrieved)).toBe(false);
  });

  it("audits a success as `retrieved` with purpose egress and the target host", async () => {
    const { vault, audit } = makeVault();
    const entry = await vault.store(storeInput());

    await vault.retrieveForEgress(entry.reference, ACCOUNT, "api.github.com");

    const retrieved = (await audit.list(ACCOUNT)).filter(
      (e) => e.type === VAULT_AUDIT_TYPES.retrieved,
    );
    expect(retrieved).toHaveLength(1);
    expect(retrieved[0]!.payload).toMatchObject({
      reference: entry.reference,
      requester: "agent",
      purpose: EGRESS_PURPOSE,
      target_host: "api.github.com",
      outcome: "success",
    });
  });

  it("refuses the local-file marker unless the USER put it on allowed_hosts", async () => {
    // `.env` is not exempt. The marker is an ordinary allowlist entry added
    // through edit_credential; without it, a client asserting the .env kind
    // gets exactly nothing — which is the bypass this replaces.
    const { vault, kms, audit } = makeVault();
    const entry = await vault.store(storeInput({ observed_hosts: ["api.example.com"] }));

    await expect(
      vault.retrieveForEgress(entry.reference, ACCOUNT, EGRESS_LOCAL_FILE_HOST),
    ).rejects.toBeInstanceOf(AllowlistViolationError);

    expect(kms.decryptCalls).toBe(0);
    const events = await audit.list(ACCOUNT);
    expect(events.some((e) => e.type === VAULT_AUDIT_TYPES.retrieved)).toBe(false);
  });

  it("serves local-file once it IS on allowed_hosts, like any other host", async () => {
    const { vault, audit } = makeVault();
    const entry = await vault.store(
      storeInput({ observed_hosts: ["api.example.com", EGRESS_LOCAL_FILE_HOST] }),
    );

    const fields = await vault.retrieveForEgress(entry.reference, ACCOUNT, EGRESS_LOCAL_FILE_HOST, {
      kind: "dotenv_write",
    });

    expect(fields.api_key).toBe("sk-live-egress-secret");
    const retrieved = (await audit.list(ACCOUNT)).filter(
      (e) => e.type === VAULT_AUDIT_TYPES.retrieved,
    );
    expect(retrieved[0]!.payload).toMatchObject({
      target_host: EGRESS_LOCAL_FILE_HOST,
      egress_kind: "dotenv_write",
    });
  });

  it("records the destination identity the caller derived, on success and on refusal", async () => {
    const { vault, audit, kms } = makeVault();
    const entry = await vault.store(storeInput());

    await vault.retrieveForEgress(entry.reference, ACCOUNT, "api.github.com", {
      kind: "github_repo_secret",
      destination: "octo/demo:production",
    });
    await expect(
      vault.retrieveForEgress(entry.reference, ACCOUNT, "evil.example.com", {
        kind: "github_repo_secret",
        destination: "octo/demo",
      }),
    ).rejects.toBeInstanceOf(AllowlistViolationError);

    const events = await audit.list(ACCOUNT);
    expect(events.find((e) => e.type === VAULT_AUDIT_TYPES.retrieved)!.payload).toMatchObject({
      egress_kind: "github_repo_secret",
      egress_destination: "octo/demo:production",
    });
    expect(events.find((e) => e.type === VAULT_AUDIT_TYPES.proxyRejected)!.payload).toMatchObject({
      target_host: "evil.example.com",
      egress_kind: "github_repo_secret",
      egress_destination: "octo/demo",
    });
    // The refusal added no second decrypt.
    expect(kms.decryptCalls).toBe(1);
  });

  it("refuses a credential belonging to another account", async () => {
    const { vault, kms } = makeVault();
    const entry = await vault.store(storeInput());

    await expect(
      vault.retrieveForEgress(entry.reference, OTHER_ACCOUNT, "api.github.com"),
    ).rejects.toBeInstanceOf(CredentialNotFoundError);
    expect(kms.decryptCalls).toBe(0);
  });
});

describe("recordEgressDelivery", () => {
  it("records the destination identity and the reported status", async () => {
    const { vault, audit } = makeVault();
    const entry = await vault.store(storeInput());

    await vault.recordEgressDelivery(ACCOUNT, {
      reference: entry.reference,
      kind: "github_repo_secret",
      destination: "octo/demo:production",
      status: "ok",
    });

    const delivered = (await audit.list(ACCOUNT)).filter(
      (e) => e.type === VAULT_AUDIT_TYPES.egressDelivered,
    );
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.payload).toMatchObject({
      reference: entry.reference,
      requester: "agent",
      purpose: EGRESS_PURPOSE,
      egress_kind: "github_repo_secret",
      egress_destination: "octo/demo:production",
      egress_status: "ok",
    });
    expect(delivered[0]!.payload.egress_error).toBeUndefined();
  });

  it("carries the destination's own failure text on an error outcome", async () => {
    const { vault, audit } = makeVault();
    const entry = await vault.store(storeInput());

    await vault.recordEgressDelivery(ACCOUNT, {
      reference: entry.reference,
      kind: "dotenv_write",
      destination: "/home/ada/proj/.env",
      status: "error",
      error: "EACCES: permission denied",
    });

    const delivered = (await audit.list(ACCOUNT)).filter(
      (e) => e.type === VAULT_AUDIT_TYPES.egressDelivered,
    );
    expect(delivered[0]!.payload).toMatchObject({
      egress_kind: "dotenv_write",
      egress_destination: "/home/ada/proj/.env",
      egress_status: "error",
      egress_error: "EACCES: permission denied",
    });
  });
});
