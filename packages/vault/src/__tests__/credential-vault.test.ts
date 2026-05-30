// CredentialVault — field-map model: upsert store, multi-field,
// labels, retrieve/reveal, proxy with enforced allowlist, rate limit.

import { Buffer } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AllowlistViolationError,
  CredentialNotFoundError,
  CredentialVault,
  StaleAssertionError,
  VaultRateLimitError,
  type DeviceAssertion,
  type ProxyResponse,
  type VaultStoreInput,
} from "../credential-vault.js";
import { InMemoryCredentialStore, InMemoryVaultAuditStore } from "../in-memory-stores.js";
import { LocalKMS } from "../kms-client.js";

const NOW = new Date("2026-05-30T12:00:00.000Z");
const ACCOUNT = "01HACCOUNTAAAAAAAAAAAAAAAA";
const SUB = "01HSUBAAAAAAAAAAAAAAAAAAAA";

function makeVault(opts: { now?: () => Date } = {}) {
  const store = new InMemoryCredentialStore();
  const audit = new InMemoryVaultAuditStore();
  const kms = LocalKMS.withFixedKey(Buffer.alloc(32, 0x42));
  const vault = new CredentialVault({ store, audit, kms, now: opts.now ?? (() => NOW) });
  return { vault, store, audit };
}

function storeInput(over: Partial<VaultStoreInput> = {}): VaultStoreInput {
  return {
    account_id: ACCOUNT,
    subscription_id: SUB,
    service: "OpenAI",
    fields: { value: "sk_test_secret" },
    type: "api_key",
    ...over,
  };
}

function assertion(signedAt: Date | string = NOW): DeviceAssertion {
  return {
    signature: "sig",
    signed_at: typeof signedAt === "string" ? signedAt : signedAt.toISOString(),
    signing_device_id: "01HDEVICE",
  };
}

const okResponse: ProxyResponse = {
  status: 200,
  headers: { "content-type": "application/json" },
  body: '{"ok":true}',
  truncated: false,
};

describe("store + retrieve (field map)", () => {
  it("round-trips a single-field credential", async () => {
    const { vault } = makeVault();
    const entry = await vault.store(storeInput());
    expect(entry.field_names).toEqual(["value"]);
    expect(entry.allowed_hosts).toEqual(["api.openai.com"]);
    expect(entry.updated).toBe(false);
    const fields = await vault.retrieve(entry.reference, "user:read", assertion());
    expect(fields).toEqual({ value: "sk_test_secret" });
  });

  it("round-trips a multi-field credential", async () => {
    const { vault } = makeVault();
    const entry = await vault.store(
      storeInput({ service: "AWS", fields: { access_key_id: "AKIA", secret_access_key: "abc/123" } }),
    );
    expect(entry.field_names.sort()).toEqual(["access_key_id", "secret_access_key"]);
    const fields = await vault.retrieve(entry.reference, "user:read", assertion());
    expect(fields).toEqual({ access_key_id: "AKIA", secret_access_key: "abc/123" });
  });
});

describe("upsert (store overwrites by service+label)", () => {
  it("re-storing the same service+label overwrites in place (same reference)", async () => {
    const { vault } = makeVault();
    const a = await vault.store(storeInput({ fields: { value: "sk_old" } }));
    const b = await vault.store(storeInput({ fields: { value: "sk_new" } }));
    expect(b.updated).toBe(true);
    expect(b.reference).toBe(a.reference);
    const fields = await vault.retrieve(a.reference, "user:read", assertion());
    expect(fields).toEqual({ value: "sk_new" });
  });

  it("overwrite preserves allowed_hosts the user edited", async () => {
    const { vault, store } = makeVault();
    const a = await vault.store(storeInput());
    await store.setAllowedHosts(a.reference, ["custom.example.com"]);
    const b = await vault.store(storeInput({ fields: { value: "sk_new" } }));
    expect(b.allowed_hosts).toEqual(["custom.example.com"]);
  });

  it("a different label is a separate entry", async () => {
    const { vault } = makeVault();
    const def = await vault.store(storeInput({ fields: { value: "sk_default" } }));
    const prod = await vault.store(storeInput({ label: "prod", fields: { value: "sk_prod" } }));
    expect(prod.reference).not.toBe(def.reference);
    expect(prod.label).toBe("prod");
    expect(await vault.retrieve(def.reference, "user:read", assertion())).toEqual({ value: "sk_default" });
    expect(await vault.retrieve(prod.reference, "user:read", assertion())).toEqual({ value: "sk_prod" });
  });

  it("rejects an empty field map", async () => {
    const { vault } = makeVault();
    await expect(vault.store(storeInput({ fields: {} }))).rejects.toThrow(/at least one field/);
  });
});

describe("delete + reveal", () => {
  it("delete soft-deletes; retrieve then 404s", async () => {
    const { vault } = makeVault();
    const entry = await vault.store(storeInput());
    await vault.delete(entry.reference);
    await expect(vault.retrieve(entry.reference, "user:read", assertion())).rejects.toThrow(
      CredentialNotFoundError,
    );
  });

  it("reveal returns the field map, account-scoped", async () => {
    const { vault } = makeVault();
    const entry = await vault.store(storeInput());
    expect(await vault.reveal(entry.reference, ACCOUNT)).toEqual({ value: "sk_test_secret" });
    await expect(vault.reveal(entry.reference, "01HOTHER")).rejects.toThrow(CredentialNotFoundError);
  });
});

describe("proxy (write-only sink, enforced allowlist)", () => {
  it("hands fields to the executor for an allowlisted host; secret never returned", async () => {
    const { vault, audit } = makeVault();
    const entry = await vault.store(storeInput());
    let seen: Record<string, string> | null = null;
    const res = await vault.proxy(
      entry.reference,
      ACCOUNT,
      { method: "GET", url: "https://api.openai.com/v1/models" },
      async ({ fields }) => {
        seen = fields;
        return okResponse;
      },
    );
    expect(res.status).toBe(200);
    expect(seen).toEqual({ value: "sk_test_secret" });
    expect(JSON.stringify(audit.events)).not.toContain("sk_test_secret");
  });

  it("hard-rejects an off-allowlist host before decrypt/dispatch", async () => {
    const { vault } = makeVault();
    const entry = await vault.store(storeInput());
    let called = false;
    await expect(
      vault.proxy(
        entry.reference,
        ACCOUNT,
        { method: "GET", url: "https://evil.example.com/x" },
        async () => {
          called = true;
          return okResponse;
        },
      ),
    ).rejects.toThrow(AllowlistViolationError);
    expect(called).toBe(false);
  });

  it("cannot proxy another account's credential", async () => {
    const { vault } = makeVault();
    const entry = await vault.store(storeInput());
    await expect(
      vault.proxy(entry.reference, "01HOTHER", { method: "GET", url: "https://api.openai.com/" }, async () => okResponse),
    ).rejects.toThrow(CredentialNotFoundError);
  });
});

describe("retrieve guards", () => {
  it("stale assertion is rejected", async () => {
    const { vault } = makeVault();
    const entry = await vault.store(storeInput());
    const old = new Date(NOW.getTime() - 2 * 60 * 60 * 1000).toISOString();
    await expect(vault.retrieve(entry.reference, "user:read", assertion(old))).rejects.toThrow(
      StaleAssertionError,
    );
  });

  it("rate limit trips after 100 retrievals in the window", async () => {
    const { vault, audit } = makeVault();
    const entry = await vault.store(storeInput());
    for (let i = 0; i < 100; i++) {
      await audit.record({
        account_id: ACCOUNT,
        type: "vault.credential_retrieved",
        payload: { reference: entry.reference, requester: "user", outcome: "success" },
      });
    }
    await expect(vault.retrieve(entry.reference, "user:read", assertion())).rejects.toThrow(
      VaultRateLimitError,
    );
  });
});

describe("LocalKMS sanity", () => {
  beforeEach(() => vi.spyOn(console, "warn").mockImplementation(() => {}));
  afterEach(() => vi.restoreAllMocks());
  it("round-trips through fromEnv hex key", async () => {
    const kms = LocalKMS.fromEnv({ LOCAL_KMS_KEY: Buffer.alloc(32, 0x11).toString("hex") } as NodeJS.ProcessEnv);
    const blob = await kms.encrypt(Buffer.from("secret"));
    expect((await kms.decrypt(blob)).toString("utf8")).toBe("secret");
  });
});
