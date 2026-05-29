// AccessGrant lifecycle: conditional-update races, expiry, cross-account
// isolation, and the CredentialVault.requestAccess / retrieveWithGrant /
// rotate-cascade integration.

import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  effectiveGrantStatus,
  InMemoryAccessGrantStore,
  PENDING_TTL_SECONDS,
  type AccessGrantRecord,
} from "../access-grant.js";
import {
  CredentialVault,
  GrantNotUsableError,
  type VaultStoreInput,
} from "../credential-vault.js";
import { InMemoryCredentialStore, InMemoryVaultAuditStore } from "../in-memory-stores.js";
import { LocalKMS } from "../kms-client.js";

const NOW = new Date("2026-05-29T12:00:00.000Z");
const ACCOUNT = "01HACCOUNTAAAAAAAAAAAAAAAA";
const OTHER = "01HOTHERAAAAAAAAAAAAAAAAAA";
const SESSION = "01HSESSIONAAAAAAAAAAAAAAAA";

function makeGrant(over: Partial<AccessGrantRecord> = {}): AccessGrantRecord {
  return {
    id: "01HGRANTAAAAAAAAAAAAAAAAAA",
    account_id: ACCOUNT,
    reference: "vault://acct/sub/cred",
    agent_session_id: SESSION,
    intent: "value",
    mode: "once",
    ttl_seconds: 3600,
    purpose: "write .env",
    reason_proxy_not_possible: "writing a local .env file",
    requested_target_host: null,
    requested_at: NOW,
    decided_at: null,
    expires_at: new Date(NOW.getTime() + PENDING_TTL_SECONDS * 1000),
    status: "pending",
    auto_approved: false,
    ...over,
  };
}

describe("InMemoryAccessGrantStore transitions", () => {
  it("approve is a single-winner conditional update (double-click loses)", async () => {
    const store = new InMemoryAccessGrantStore();
    await store.insert(makeGrant());
    const first = await store.approve({
      id: makeGrant().id,
      accountId: ACCOUNT,
      mode: "once",
      ttlSeconds: 3600,
      expiresAt: new Date(NOW.getTime() + 3600_000),
      decidedAt: NOW,
    });
    const second = await store.approve({
      id: makeGrant().id,
      accountId: ACCOUNT,
      mode: "once",
      ttlSeconds: 3600,
      expiresAt: new Date(NOW.getTime() + 3600_000),
      decidedAt: NOW,
    });
    expect(first).toBe(1);
    expect(second).toBe(0); // no longer pending
  });

  it("approve then revoke: revoke wins once, second revoke is a no-op", async () => {
    const store = new InMemoryAccessGrantStore();
    await store.insert(makeGrant());
    await store.approve({
      id: makeGrant().id,
      accountId: ACCOUNT,
      mode: "session",
      ttlSeconds: 3600,
      expiresAt: new Date(NOW.getTime() + 3600_000),
      decidedAt: NOW,
    });
    expect(await store.revoke({ id: makeGrant().id, accountId: ACCOUNT })).toBe(1);
    expect(await store.revoke({ id: makeGrant().id, accountId: ACCOUNT })).toBe(0);
  });

  it("consume only fires on an approved grant, exactly once", async () => {
    const store = new InMemoryAccessGrantStore();
    await store.insert(makeGrant({ status: "approved" }));
    expect(await store.consume({ id: makeGrant().id, accountId: ACCOUNT })).toBe(1);
    expect(await store.consume({ id: makeGrant().id, accountId: ACCOUNT })).toBe(0);
  });

  it("cross-account callers cannot approve, deny, revoke, consume, or read", async () => {
    const store = new InMemoryAccessGrantStore();
    await store.insert(makeGrant({ status: "approved" }));
    const id = makeGrant().id;
    expect(await store.approve({ id, accountId: OTHER, mode: "once", ttlSeconds: 1, expiresAt: NOW, decidedAt: NOW })).toBe(0);
    expect(await store.deny({ id, accountId: OTHER, decidedAt: NOW })).toBe(0);
    expect(await store.revoke({ id, accountId: OTHER })).toBe(0);
    expect(await store.consume({ id, accountId: OTHER })).toBe(0);
    expect(await store.findByIdForAccount(id, OTHER)).toBeNull();
  });

  it("findByIdForAgentSession only returns the owning session's grant", async () => {
    const store = new InMemoryAccessGrantStore();
    await store.insert(makeGrant());
    expect(await store.findByIdForAgentSession(makeGrant().id, SESSION)).not.toBeNull();
    expect(await store.findByIdForAgentSession(makeGrant().id, "01HWRONGSESSION")).toBeNull();
  });

  it("listPending + countPending reflect only pending rows for the account", async () => {
    const store = new InMemoryAccessGrantStore();
    await store.insert(makeGrant({ id: "01HG1" }));
    await store.insert(makeGrant({ id: "01HG2", status: "approved" }));
    await store.insert(makeGrant({ id: "01HG3", account_id: OTHER }));
    expect(await store.countPendingByAccount(ACCOUNT)).toBe(1);
    expect((await store.listPendingByAccount(ACCOUNT)).map((g) => g.id)).toEqual(["01HG1"]);
  });

  it("revokePersistentByReference only touches approved persistent grants for that reference", async () => {
    const store = new InMemoryAccessGrantStore();
    await store.insert(makeGrant({ id: "01HP1", mode: "persistent", status: "approved" }));
    await store.insert(makeGrant({ id: "01HP2", mode: "persistent", status: "approved" }));
    await store.insert(makeGrant({ id: "01HP3", mode: "once", status: "approved" }));
    await store.insert(makeGrant({ id: "01HP4", mode: "persistent", status: "approved", reference: "vault://other" }));
    const count = await store.revokePersistentByReference("vault://acct/sub/cred", ACCOUNT);
    expect(count).toBe(2);
  });
});

describe("effectiveGrantStatus", () => {
  it("reads pending past its deadline as expired", () => {
    const g = makeGrant({ expires_at: new Date(NOW.getTime() - 1000) });
    expect(effectiveGrantStatus(g, NOW)).toBe("expired");
  });
  it("reads approved past expires_at as expired", () => {
    const g = makeGrant({ status: "approved", expires_at: new Date(NOW.getTime() - 1) });
    expect(effectiveGrantStatus(g, NOW)).toBe("expired");
  });
  it("leaves a live approved grant approved", () => {
    const g = makeGrant({ status: "approved", expires_at: new Date(NOW.getTime() + 1000) });
    expect(effectiveGrantStatus(g, NOW)).toBe("approved");
  });
});

// ── CredentialVault integration ────────────────────────────────

function makeVault(now: () => Date = () => NOW) {
  const store = new InMemoryCredentialStore();
  const audit = new InMemoryVaultAuditStore();
  const grants = new InMemoryAccessGrantStore();
  const kms = LocalKMS.withFixedKey(Buffer.alloc(32, 0x42));
  const vault = new CredentialVault({ store, audit, kms, accessGrants: grants, now });
  return { vault, store, audit, grants };
}

function storeInput(over: Partial<VaultStoreInput> = {}): VaultStoreInput {
  return {
    account_id: ACCOUNT,
    subscription_id: "01HSUB",
    type: "api_key",
    value: "sk-the-secret",
    env_var_suggestion: "OPENAI_API_KEY",
    metadata: { service: "OpenAI" },
    ...over,
  };
}

describe("CredentialVault.requestAccess", () => {
  it("creates a pending grant for a value request", async () => {
    const { vault } = makeVault();
    const entry = await vault.store(storeInput());
    const grant = await vault.requestAccess({
      account_id: ACCOUNT,
      reference: entry.reference,
      agent_session_id: SESSION,
      intent: "value",
      mode: "once",
      ttl_seconds: 3600,
      purpose: "write .env",
      reason_proxy_not_possible: "local file",
      session_trusted: true, // trust never auto-approves a value request
    });
    expect(grant.status).toBe("pending");
    expect(grant.auto_approved).toBe(false);
  });

  it("auto-approves a trusted proxy request to an allowlisted host", async () => {
    const { vault } = makeVault();
    const entry = await vault.store(storeInput()); // OpenAI → api.openai.com
    const grant = await vault.requestAccess({
      account_id: ACCOUNT,
      reference: entry.reference,
      agent_session_id: SESSION,
      intent: "proxy",
      mode: "once",
      ttl_seconds: 60,
      purpose: "call /v1/models",
      requested_target_host: "api.openai.com",
      session_trusted: true,
    });
    expect(grant.status).toBe("approved");
    expect(grant.auto_approved).toBe(true);
    expect(grant.mode).toBe("once");
  });

  it("does NOT auto-approve an off-allowlist host even when trusted", async () => {
    const { vault } = makeVault();
    const entry = await vault.store(storeInput());
    const grant = await vault.requestAccess({
      account_id: ACCOUNT,
      reference: entry.reference,
      agent_session_id: SESSION,
      intent: "proxy",
      mode: "once",
      ttl_seconds: 60,
      purpose: "call elsewhere",
      requested_target_host: "evil.example.com",
      session_trusted: true,
    });
    expect(grant.status).toBe("pending");
  });

  it("does NOT auto-approve a proxy request from an untrusted session", async () => {
    const { vault } = makeVault();
    const entry = await vault.store(storeInput());
    const grant = await vault.requestAccess({
      account_id: ACCOUNT,
      reference: entry.reference,
      agent_session_id: SESSION,
      intent: "proxy",
      mode: "once",
      ttl_seconds: 60,
      purpose: "call /v1/models",
      requested_target_host: "api.openai.com",
      session_trusted: false,
    });
    expect(grant.status).toBe("pending");
  });
});

describe("CredentialVault.retrieveWithGrant", () => {
  it("returns the value for an approved once grant, then refuses a second poll", async () => {
    const { vault, store, grants } = makeVault();
    const entry = await vault.store(storeInput());
    const grant = await vault.requestAccess({
      account_id: ACCOUNT,
      reference: entry.reference,
      agent_session_id: SESSION,
      intent: "value",
      mode: "once",
      ttl_seconds: 3600,
      purpose: "write .env",
      reason_proxy_not_possible: "local file",
      session_trusted: false,
    });
    await grants.approve({
      id: grant.id,
      accountId: ACCOUNT,
      mode: "once",
      ttlSeconds: 3600,
      expiresAt: new Date(NOW.getTime() + 3600_000),
      decidedAt: NOW,
    });
    const value = await vault.retrieveWithGrant(grant.id, ACCOUNT, SESSION, "write .env");
    expect(value).toBe("sk-the-secret");
    // markRetrieved bumped the credential
    const rec = await store.findActive(entry.reference);
    expect(rec?.retrieval_count).toBe(1);
    // Second poll on a consumed once grant → 409.
    await expect(
      vault.retrieveWithGrant(grant.id, ACCOUNT, SESSION, "write .env"),
    ).rejects.toThrow(GrantNotUsableError);
  });

  it("refuses a pending (un-approved) grant", async () => {
    const { vault } = makeVault();
    const entry = await vault.store(storeInput());
    const grant = await vault.requestAccess({
      account_id: ACCOUNT,
      reference: entry.reference,
      agent_session_id: SESSION,
      intent: "value",
      mode: "once",
      ttl_seconds: 3600,
      purpose: "x",
      reason_proxy_not_possible: "y",
      session_trusted: false,
    });
    await expect(
      vault.retrieveWithGrant(grant.id, ACCOUNT, SESSION, "x"),
    ).rejects.toThrow(GrantNotUsableError);
  });

  it("refuses a grant belonging to another agent session", async () => {
    const { vault, grants } = makeVault();
    const entry = await vault.store(storeInput());
    const grant = await vault.requestAccess({
      account_id: ACCOUNT,
      reference: entry.reference,
      agent_session_id: SESSION,
      intent: "value",
      mode: "session",
      ttl_seconds: 3600,
      purpose: "x",
      reason_proxy_not_possible: "y",
      session_trusted: false,
    });
    await grants.approve({
      id: grant.id,
      accountId: ACCOUNT,
      mode: "session",
      ttlSeconds: 3600,
      expiresAt: new Date(NOW.getTime() + 3600_000),
      decidedAt: NOW,
    });
    await expect(
      vault.retrieveWithGrant(grant.id, ACCOUNT, "01HOTHERSESSION", "x"),
    ).rejects.toThrow(GrantNotUsableError);
  });
});

describe("CredentialVault.proxyWithGrant", () => {
  it("decrypts the secret, hands it to the executor, audits the call, never leaks the secret", async () => {
    const { vault, audit } = makeVault();
    const entry = await vault.store(storeInput()); // OpenAI → api.openai.com
    const grant = await vault.requestAccess({
      account_id: ACCOUNT,
      reference: entry.reference,
      agent_session_id: SESSION,
      intent: "proxy",
      mode: "once",
      ttl_seconds: 60,
      purpose: "call /v1/models",
      requested_target_host: "api.openai.com",
      session_trusted: true, // auto-approved
    });
    expect(grant.status).toBe("approved");

    let sawSecret: string | null = null;
    const response = await vault.proxyWithGrant(
      grant.id,
      ACCOUNT,
      SESSION,
      {
        method: "GET",
        url: "https://api.openai.com/v1/models",
        headers: { authorization: "Bearer ${SECRET}" },
      },
      async ({ secret }) => {
        sawSecret = secret;
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: '{"ok":true}',
          truncated: false,
        };
      },
    );
    expect(response.status).toBe(200);
    expect(sawSecret).toBe("sk-the-secret"); // executor got it server-side
    // proxy_executed audit row exists, target host recorded, NO secret.
    const proxyEvent = audit.events.find((e) => e.type === "vault.proxy_executed")!;
    expect(proxyEvent.payload).toMatchObject({
      target_host: "api.openai.com",
      response_status: 200,
    });
    expect(JSON.stringify(audit.events)).not.toContain("sk-the-secret");
  });

  it("logs proxy_off_allowlist for an off-allowlist host but still proceeds", async () => {
    const { vault, audit, grants } = makeVault();
    const entry = await vault.store(storeInput());
    // Pre-approve a proxy grant manually (untrusted path → user approved).
    const grant = await vault.requestAccess({
      account_id: ACCOUNT,
      reference: entry.reference,
      agent_session_id: SESSION,
      intent: "proxy",
      mode: "session",
      ttl_seconds: 3600,
      purpose: "call elsewhere",
      requested_target_host: "api.elsewhere.com",
      session_trusted: false,
    });
    await grants.approve({
      id: grant.id,
      accountId: ACCOUNT,
      mode: "session",
      ttlSeconds: 3600,
      expiresAt: new Date(NOW.getTime() + 3600_000),
      decidedAt: NOW,
    });
    await vault.proxyWithGrant(
      grant.id,
      ACCOUNT,
      SESSION,
      { method: "GET", url: "https://api.elsewhere.com/x", headers: {} },
      async () => ({ status: 200, headers: {}, body: "ok", truncated: false }),
    );
    expect(audit.events.some((e) => e.type === "vault.proxy_off_allowlist")).toBe(true);
  });

  it("records a forensic proxy_executed row even when the executor throws", async () => {
    const { vault, audit } = makeVault();
    const entry = await vault.store(storeInput());
    const grant = await vault.requestAccess({
      account_id: ACCOUNT,
      reference: entry.reference,
      agent_session_id: SESSION,
      intent: "proxy",
      mode: "once",
      ttl_seconds: 60,
      purpose: "call /v1/models",
      requested_target_host: "api.openai.com",
      session_trusted: true,
    });
    await expect(
      vault.proxyWithGrant(
        grant.id,
        ACCOUNT,
        SESSION,
        { method: "GET", url: "https://api.openai.com/v1/models", headers: {} },
        async () => {
          throw new Error("upstream boom");
        },
      ),
    ).rejects.toThrow("upstream boom");
    const ev = audit.events.find((e) => e.type === "vault.proxy_executed")!;
    expect(ev.payload.proxy_error).toContain("boom");
  });
});

describe("CredentialVault.rotate cascade", () => {
  it("revokes approved persistent grants for the reference and reports the count", async () => {
    const { vault, grants } = makeVault();
    const entry = await vault.store(storeInput());
    // Mint two approved persistent grants for this reference.
    for (const id of ["01HRP1", "01HRP2"]) {
      await grants.insert(
        makeGrant({
          id,
          reference: entry.reference,
          mode: "persistent",
          status: "approved",
          expires_at: new Date(NOW.getTime() + 7 * 24 * 3600_000),
        }),
      );
    }
    const result = await vault.rotate(entry.reference, "sk-rotated");
    expect(result.revoked_grant_count).toBe(2);
    expect((await grants.findByIdForAccount("01HRP1", ACCOUNT))?.status).toBe("revoked");
  });
});
