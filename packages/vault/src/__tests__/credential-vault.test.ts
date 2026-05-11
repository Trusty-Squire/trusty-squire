// CredentialVault behavioural tests — store / retrieve, audit
// emission, rate limiting, soft delete, stale assertion handling, and
// the runtime path.

import { Buffer } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceAssertion, VaultStoreInput } from "@trusty-squire/runtime";
import {
  CredentialNotFoundError,
  CredentialVault,
  StaleAssertionError,
  VaultRateLimitError,
} from "../credential-vault.js";
import { InMemoryCredentialStore, InMemoryVaultAuditStore } from "../in-memory-stores.js";
import { LocalKMS } from "../kms-client.js";

const NOW = new Date("2026-05-10T12:00:00.000Z");
const ACCOUNT = "01HACCOUNTAAAAAAAAAAAAAAAA";
const SUBSCRIPTION = "01HSUBAAAAAAAAAAAAAAAAAAAA";

function makeVault(opts: { now?: () => Date } = {}): {
  vault: CredentialVault;
  store: InMemoryCredentialStore;
  audit: InMemoryVaultAuditStore;
} {
  const store = new InMemoryCredentialStore();
  const audit = new InMemoryVaultAuditStore();
  const kms = LocalKMS.withFixedKey(Buffer.alloc(32, 0x42));
  const vault = new CredentialVault({
    store,
    audit,
    kms,
    now: opts.now ?? (() => NOW),
  });
  return { vault, store, audit };
}

function makeStoreInput(overrides: Partial<VaultStoreInput> = {}): VaultStoreInput {
  return {
    account_id: ACCOUNT,
    subscription_id: SUBSCRIPTION,
    type: "api_key",
    value: "sk_test_secret",
    env_var_suggestion: "TEST_API_KEY",
    metadata: { run_id: "01HRUN" },
    ...overrides,
  };
}

function makeAssertion(signedAt: Date | string = NOW): DeviceAssertion {
  return {
    signature: "fake-sig",
    signed_at: typeof signedAt === "string" ? signedAt : signedAt.toISOString(),
    signing_device_id: "01HDEVICE",
  };
}

describe("CredentialVault", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("store + retrieve round-trips the original value", async () => {
    const { vault } = makeVault();
    const entry = await vault.store(makeStoreInput());
    const value = await vault.retrieve(entry.reference, "user:read", makeAssertion());
    expect(value).toBe("sk_test_secret");
    expect(entry.type).toBe("api_key");
  });

  it("multiple credentials per account → independent encryption (different ciphertexts)", async () => {
    const { vault, store } = makeVault();
    const a = await vault.store(makeStoreInput({ value: "sk_a" }));
    const b = await vault.store(makeStoreInput({ value: "sk_b" }));
    const recA = await store.findActive(a.reference);
    const recB = await store.findActive(b.reference);
    expect(Buffer.compare(recA!.ciphertext, recB!.ciphertext)).not.toBe(0);
    expect(Buffer.compare(recA!.encrypted_dek, recB!.encrypted_dek)).not.toBe(0);
    expect(Buffer.compare(recA!.account_kek_blob, recB!.account_kek_blob)).not.toBe(0);
  });

  it("retrieve writes a vault.credential_retrieved audit event with success outcome", async () => {
    const { vault, audit } = makeVault();
    const entry = await vault.store(makeStoreInput());
    await vault.retrieve(entry.reference, "user:debug", makeAssertion());
    const events = audit.events.filter((e) => e.type === "vault.credential_retrieved");
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.account_id).toBe(ACCOUNT);
    expect(ev.payload.outcome).toBe("success");
    expect(ev.payload.requester).toBe("user");
    expect(ev.payload.signing_device_id).toBe("01HDEVICE");
  });

  it("retrieveForRuntime: succeeds without DeviceAssertion, audits as system", async () => {
    const { vault, audit } = makeVault();
    const entry = await vault.store(makeStoreInput());
    const value = await vault.retrieveForRuntime(entry.reference, "compensation");
    expect(value).toBe("sk_test_secret");
    const ev = audit.events[audit.events.length - 1]!;
    expect(ev.payload.requester).toBe("system");
    expect(ev.payload.signing_device_id).toBeNull();
    expect(ev.payload.outcome).toBe("success");
  });

  it("rate limit triggers after 100 retrievals in the past hour", async () => {
    const { vault, audit } = makeVault();
    const entry = await vault.store(makeStoreInput());
    // Pre-seed 100 audit events to fill the bucket.
    for (let i = 0; i < 100; i++) {
      await audit.record({
        account_id: ACCOUNT,
        type: "vault.credential_retrieved",
        payload: {
          reference: entry.reference,
          purpose: "user:fill",
          requester: "user",
          signing_device_id: "01HDEVICE",
          outcome: "success",
        },
      });
    }
    await expect(
      vault.retrieve(entry.reference, "user:read", makeAssertion()),
    ).rejects.toThrow(VaultRateLimitError);
    // The rejected attempt itself is recorded as rate_limited.
    const last = audit.events[audit.events.length - 1]!;
    expect(last.payload.outcome).toBe("rate_limited");
  });

  it("stale device assertion (>1h) → fails with StaleAssertionError, audited as stale", async () => {
    const { vault, audit } = makeVault();
    const entry = await vault.store(makeStoreInput());
    const tooOld = new Date(NOW.getTime() - 90 * 60 * 1000); // 90m ago
    await expect(
      vault.retrieve(entry.reference, "user:read", makeAssertion(tooOld)),
    ).rejects.toThrow(StaleAssertionError);
    const last = audit.events[audit.events.length - 1]!;
    expect(last.payload.outcome).toBe("stale_assertion");
  });

  it("future-dated assertion (signed_at > now) → fails as stale", async () => {
    const { vault } = makeVault();
    const entry = await vault.store(makeStoreInput());
    const future = new Date(NOW.getTime() + 60 * 60 * 1000); // 1h in the future
    await expect(
      vault.retrieve(entry.reference, "user:read", makeAssertion(future)),
    ).rejects.toThrow(StaleAssertionError);
  });

  it("malformed signed_at → fails as stale", async () => {
    const { vault } = makeVault();
    const entry = await vault.store(makeStoreInput());
    await expect(
      vault.retrieve(entry.reference, "user:read", makeAssertion("not-a-date")),
    ).rejects.toThrow(StaleAssertionError);
  });

  it("delete soft-deletes; subsequent retrieve fails with CredentialNotFoundError", async () => {
    const { vault, audit } = makeVault();
    const entry = await vault.store(makeStoreInput());
    await vault.delete(entry.reference);
    await expect(
      vault.retrieve(entry.reference, "user:read", makeAssertion()),
    ).rejects.toThrow(CredentialNotFoundError);
    const last = audit.events[audit.events.length - 1]!;
    expect(last.payload.outcome).toBe("missing_credential");
  });

  it("rotate replaces the stored value while keeping the same reference", async () => {
    const { vault } = makeVault();
    const entry = await vault.store(makeStoreInput());
    await vault.rotate(entry.reference, "sk_new_value");
    const value = await vault.retrieve(entry.reference, "user:read", makeAssertion());
    expect(value).toBe("sk_new_value");
  });

  it("rotate on a missing reference throws CredentialNotFoundError", async () => {
    const { vault } = makeVault();
    await expect(vault.rotate("vault://nope", "x")).rejects.toThrow(
      CredentialNotFoundError,
    );
  });

  it("retrieve increments retrieval_count + last_retrieved_at on the credential row", async () => {
    const { vault, store } = makeVault();
    const entry = await vault.store(makeStoreInput());
    await vault.retrieve(entry.reference, "user:read", makeAssertion());
    const rec = await store.findActive(entry.reference);
    expect(rec?.retrieval_count).toBe(1);
    expect(rec?.last_retrieved_at?.toISOString()).toBe(NOW.toISOString());
  });

  it("retrieve on an unknown reference fails without leaking timing on rate limit", async () => {
    const { vault, audit } = makeVault();
    await expect(
      vault.retrieve("vault://nope", "user:read", makeAssertion()),
    ).rejects.toThrow(CredentialNotFoundError);
    const last = audit.events[audit.events.length - 1]!;
    expect(last.payload.outcome).toBe("missing_credential");
  });

  it("purpose prefix routes to requester=agent / user / system", async () => {
    const { vault, audit } = makeVault();
    const entry = await vault.store(makeStoreInput());
    await vault.retrieve(entry.reference, "agent:rotate", makeAssertion());
    expect(audit.events.at(-1)!.payload.requester).toBe("agent");
    await vault.retrieve(entry.reference, "user:read", makeAssertion());
    expect(audit.events.at(-1)!.payload.requester).toBe("user");
    await vault.retrieve(entry.reference, "system:internal", makeAssertion());
    expect(audit.events.at(-1)!.payload.requester).toBe("system");
  });
});

describe("LocalKMS", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("round-trips through LocalKMS.fromEnv with a hex key", async () => {
    const env = {
      LOCAL_KMS_KEY: Buffer.alloc(32, 0x11).toString("hex"),
    } as NodeJS.ProcessEnv;
    const kms = LocalKMS.fromEnv(env);
    const blob = await kms.encrypt(Buffer.from("secret"));
    const back = await kms.decrypt(blob);
    expect(back.toString("utf8")).toBe("secret");
  });

  it("rejects malformed LOCAL_KMS_KEY", () => {
    expect(() =>
      LocalKMS.fromEnv({ LOCAL_KMS_KEY: "not-hex" } as NodeJS.ProcessEnv),
    ).toThrow(/64 hex chars/);
  });

  it("warns + uses ephemeral key when LOCAL_KMS_KEY is unset", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const kms = LocalKMS.fromEnv({} as NodeJS.ProcessEnv);
    expect(warn).toHaveBeenCalled();
    const blob = await kms.encrypt(Buffer.from("x"));
    const back = await kms.decrypt(blob);
    expect(back.toString("utf8")).toBe("x");
  });
});
