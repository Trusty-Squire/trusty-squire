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
  mergeAllowedHosts,
  normalizeObservedHost,
  type DeviceAssertion,
  type ProxyResponse,
  type VaultStoreInput,
} from "../credential-vault.js";
import { InMemoryCredentialStore, InMemoryVaultAuditStore } from "../in-memory-stores.js";
import { LocalKMS } from "../kms-client.js";

const NOW = new Date("2026-05-30T12:00:00.000Z");
const ACCOUNT = "01HACCOUNTAAAAAAAAAAAAAAAA";
const SUB = "01HSUBAAAAAAAAAAAAAAAAAAAA";

function makeVault(opts: { now?: () => Date; proxyAuditFailureMode?: "strict" | "best_effort" } = {}) {
  const store = new InMemoryCredentialStore();
  const audit = new InMemoryVaultAuditStore(opts.now ?? (() => NOW));
  const kms = LocalKMS.withFixedKey(Buffer.alloc(32, 0x42));
  const vault = new CredentialVault({
    store,
    audit,
    kms,
    now: opts.now ?? (() => NOW),
    ...(opts.proxyAuditFailureMode !== undefined
      ? { proxyAuditFailureMode: opts.proxyAuditFailureMode }
      : {}),
  });
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

describe("allowed-host derivation helpers", () => {
  it("normalizeObservedHost handles bare hosts and full URLs", () => {
    expect(normalizeObservedHost("api.x.com")).toBe("api.x.com");
    expect(normalizeObservedHost("https://API.x.com/keys?a=1")).toBe("api.x.com");
    expect(normalizeObservedHost("  fred.example.org  ")).toBe("fred.example.org");
    expect(normalizeObservedHost("")).toBeNull();
    expect(normalizeObservedHost("not a url at all")).toBeNull();
  });

  it("mergeAllowedHosts unions observed hosts with the service table, deduped", () => {
    // openai is in the table → api.openai.com; observed host comes first.
    expect(mergeAllowedHosts("openai", ["https://dash.openai.com"])).toEqual([
      "dash.openai.com",
      "api.openai.com",
    ]);
    // unknown service + observed host → never empty.
    expect(mergeAllowedHosts("totally-unknown-saas", ["api.stlouisfed.org"])).toEqual([
      "api.stlouisfed.org",
    ]);
    // unknown service + no observed host → empty (documents the gap).
    expect(mergeAllowedHosts("totally-unknown-saas")).toEqual([]);
    // dedupes when observed equals the table value.
    expect(mergeAllowedHosts("openai", ["api.openai.com"])).toEqual(["api.openai.com"]);
  });
});

describe("store sets allowed_hosts from observed capture hosts", () => {
  it("a new credential for an unknown service still gets a non-empty allowlist", async () => {
    const { vault } = makeVault();
    const entry = await vault.store(
      storeInput({ service: "Quirkly", observed_hosts: ["https://api.quirkly.dev/v1"] }),
    );
    expect(entry.allowed_hosts).toEqual(["api.quirkly.dev"]);
  });

  it("re-storing a credential with an EMPTY allowlist backfills it from observed hosts", async () => {
    const { vault } = makeVault();
    // First store: unknown service, no observed host → empty allowlist.
    const a = await vault.store(storeInput({ service: "Quirkly", fields: { value: "sk_1" } }));
    expect(a.allowed_hosts).toEqual([]);
    // Re-store with an observed host → backfilled (heals pre-feature creds).
    const b = await vault.store(
      storeInput({ service: "Quirkly", fields: { value: "sk_2" }, observed_hosts: ["api.quirkly.dev"] }),
    );
    expect(b.reference).toBe(a.reference); // same record
    expect(b.allowed_hosts).toEqual(["api.quirkly.dev"]);
  });
});

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

describe("proxy audit failure mode", () => {
  it("best_effort returns the upstream response even when proxy audit writes fail", async () => {
    const { vault, audit } = makeVault({ proxyAuditFailureMode: "best_effort" });
    const entry = await vault.store(storeInput());
    const originalRecord = audit.record.bind(audit);
    let failAudit = false;
    audit.record = async (event) => {
      if (failAudit) throw new Error("audit database unavailable");
      await originalRecord(event);
    };
    failAudit = true;

    await expect(
      vault.proxy(
        entry.reference,
        ACCOUNT,
        { method: "POST", url: "https://api.openai.com/v1/chat/completions" },
        async () => okResponse,
      ),
    ).resolves.toEqual(okResponse);
  });

  it("strict mode keeps proxy audit writes on the success path", async () => {
    const { vault, audit } = makeVault();
    const entry = await vault.store(storeInput());
    audit.record = async () => {
      throw new Error("audit database unavailable");
    };

    await expect(
      vault.proxy(
        entry.reference,
        ACCOUNT,
        { method: "POST", url: "https://api.openai.com/v1/chat/completions" },
        async () => okResponse,
      ),
    ).rejects.toThrow(/audit database unavailable/);
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

  it("web reveal is subject to the same rate limit (no human bypass)", async () => {
    const { vault, audit } = makeVault();
    const entry = await vault.store(storeInput());
    for (let i = 0; i < 100; i++) {
      await audit.record({
        account_id: ACCOUNT,
        type: "vault.credential_retrieved",
        payload: { reference: entry.reference, requester: "user", outcome: "success" },
      });
    }
    await expect(vault.reveal(entry.reference, ACCOUNT)).rejects.toThrow(VaultRateLimitError);
    // and the breach is itself audited as a rate_limited reveal
    expect(
      audit.events.some((e) => e.payload.outcome === "rate_limited" && e.payload.purpose === "user:vault_reveal"),
    ).toBe(true);
  });
});

describe("envelope health check", () => {
  it("reports healthy when the envelope decrypts, with field count, no secret", async () => {
    const { vault } = makeVault();
    const entry = await vault.store(storeInput({ fields: { access_key_id: "AKIA", secret_access_key: "shh" } }));
    const health = await vault.checkHealth(entry.reference, ACCOUNT);
    expect(health.healthy).toBe(true);
    expect(health.field_count).toBe(2);
    expect(health.algorithm).toBe("AES-256-GCM");
    expect(JSON.stringify(health)).not.toContain("shh");
  });

  it("reports unhealthy when the master key can't decrypt the KEK", async () => {
    const store = new InMemoryCredentialStore();
    const audit = new InMemoryVaultAuditStore(() => NOW);
    const sealed = new CredentialVault({ store, audit, kms: LocalKMS.withFixedKey(Buffer.alloc(32, 0x42)), now: () => NOW });
    const entry = await sealed.store(storeInput());
    // a vault wired to a DIFFERENT master key sees the same row but the
    // KEK blob no longer authenticates — exactly the post-bad-rotation rot
    const wrongKey = new CredentialVault({ store, audit, kms: LocalKMS.withFixedKey(Buffer.alloc(32, 0x99)), now: () => NOW });
    const health = await wrongKey.checkHealth(entry.reference, ACCOUNT);
    expect(health.healthy).toBe(false);
    expect(health.error).toBeDefined();
    // the correctly-keyed vault still reports healthy
    expect((await sealed.checkHealth(entry.reference, ACCOUNT)).healthy).toBe(true);
  });

  it("rejects a cross-account health probe", async () => {
    const { vault } = makeVault();
    const entry = await vault.store(storeInput());
    await expect(vault.checkHealth(entry.reference, "01HOTHER")).rejects.toThrow(CredentialNotFoundError);
  });
});

describe("LocalKMS sanity", () => {
  beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });
  it("round-trips through fromEnv hex key", async () => {
    const kms = LocalKMS.fromEnv({ LOCAL_KMS_KEY: Buffer.alloc(32, 0x11).toString("hex") } as NodeJS.ProcessEnv);
    const blob = await kms.encrypt(Buffer.from("secret"));
    expect((await kms.decrypt(blob)).toString("utf8")).toBe("secret");
  });
});
