// Vault-first egress routes — the two small server halves of
// `use_credential { target }`:
//
//   POST /v1/vault/egress-fetch     gate → decrypt → seal to the caller's key
//   POST /v1/vault/egress-outcome   client-reported: what actually got the key
//
// The gate is the same pre-decrypt `allowed_hosts` check the proxy uses, so an
// egress destination is exactly as user-authorised as a proxied call. The
// pre-decrypt property itself is proven directly (with a counting KMS) in
// packages/vault/src/__tests__/credential-vault-egress.test.ts; here it shows
// up as "403, and no retrieval row was ever written".

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Buffer } from "node:buffer";
import { constants, generateKeyPairSync, privateDecrypt } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { VAULT_AUDIT_TYPES } from "@trusty-squire/vault";
import { issueAgentSession } from "../auth/agent.js";
import { issueSession, signSessionJwt, SESSION_COOKIE_NAME } from "../auth/session.js";
import { buildInMemoryDeps, type ApiDeps } from "../services/deps.js";
import { buildServer } from "../server.js";

const SESSION_SECRET = "dev-test-secret-do-not-use-anywhere-else";
const SECRET_VALUE = "sk-live-must-never-reach-the-model";

interface Harness {
  server: FastifyInstance;
  deps: ApiDeps;
}

async function setup(): Promise<Harness> {
  const deps = buildInMemoryDeps({ sessionSecret: SESSION_SECRET });
  const server = await buildServer({ deps });
  return { server, deps };
}

async function webCookie(deps: ApiDeps, accountId: string): Promise<string> {
  const { record, jwt } = issueSession({
    account_id: accountId,
    ip: null,
    user_agent: null,
    now: new Date(),
  });
  await deps.sessionStore.insert(record);
  return `${SESSION_COOKIE_NAME}=${signSessionJwt(jwt, SESSION_SECRET)}`;
}

async function agentToken(deps: ApiDeps, accountId: string): Promise<string> {
  const { raw_token, record } = issueAgentSession({
    account_id: accountId,
    agent_identity: "claude-code",
    agent_version: "test",
    now: new Date(),
  });
  await deps.agentSessionStore.insert(record);
  return raw_token;
}

async function storeCred(
  h: Harness,
  cookie: string,
  over: Record<string, unknown> = {},
): Promise<string> {
  const res = await h.server.inject({
    method: "POST",
    url: "/v1/vault/credentials/manual",
    headers: { cookie, "content-type": "application/json" },
    payload: {
      service: "browserstack",
      fields: { api_key: SECRET_VALUE, username: "ada" },
      type: "api_key",
      observed_hosts: ["api.github.com"],
      ...over,
    },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { reference: string }).reference;
}

function egressKeyPair(): { publicKey: string; decrypt: (value: string) => string } {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return {
    publicKey,
    decrypt: (value: string) =>
      privateDecrypt(
        { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
        Buffer.from(value, "base64"),
      ).toString("utf8"),
  };
}

interface Actor {
  accountId: string;
  cookie: string;
  token: string;
}

async function actor(h: Harness, email: string): Promise<Actor> {
  const account = await h.deps.accountStore.createAccount(email, "U");
  return {
    accountId: account.id,
    cookie: await webCookie(h.deps, account.id),
    token: await agentToken(h.deps, account.id),
  };
}

describe("POST /v1/vault/egress-fetch", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup();
  });
  afterEach(async () => {
    await h.server.close();
  });

  it("rejects an unauthenticated call", async () => {
    const res = await h.server.inject({
      method: "POST",
      url: "/v1/vault/egress-fetch",
      headers: { "content-type": "application/json" },
      payload: {
        reference: "vault://nope",
        fields: ["api_key"],
        encrypted_response_public_key: egressKeyPair().publicKey,
        destination: { kind: "github_repo_secret", host: "api.github.com" },
      },
    });
    expect(res.statusCode).toBe(401);
  });

  it("404s an unknown reference", async () => {
    const a = await actor(h, "unknown@example.test");
    const res = await h.server.inject({
      method: "POST",
      url: "/v1/vault/egress-fetch",
      headers: { authorization: `Bearer ${a.token}`, "content-type": "application/json" },
      payload: {
        reference: "vault://acct/does-not-exist",
        fields: ["api_key"],
        encrypted_response_public_key: egressKeyPair().publicKey,
        destination: { kind: "github_repo_secret", host: "api.github.com" },
      },
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: string }).error).toBe("credential_not_found");
  });

  it("seals the requested fields to the supplied public key", async () => {
    const a = await actor(h, "seal@example.test");
    const reference = await storeCred(h, a.cookie);
    const keys = egressKeyPair();

    const res = await h.server.inject({
      method: "POST",
      url: "/v1/vault/egress-fetch",
      headers: { authorization: `Bearer ${a.token}`, "content-type": "application/json" },
      payload: {
        reference,
        fields: ["api_key"],
        encrypted_response_public_key: keys.publicKey,
        destination: { kind: "github_repo_secret", host: "api.github.com" },
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { reference: string; encrypted_fields: Record<string, string> };
    expect(body.reference).toBe(reference);
    // Sealed on the wire — the response body itself never carries the value.
    expect(res.body).not.toContain(SECRET_VALUE);
    expect(keys.decrypt(body.encrypted_fields.api_key!)).toBe(SECRET_VALUE);
  });

  it("audits a fetch as `retrieved` with purpose egress and the target host", async () => {
    const a = await actor(h, "audit@example.test");
    const reference = await storeCred(h, a.cookie);

    await h.server.inject({
      method: "POST",
      url: "/v1/vault/egress-fetch",
      headers: { authorization: `Bearer ${a.token}`, "content-type": "application/json" },
      payload: {
        reference,
        fields: ["api_key"],
        encrypted_response_public_key: egressKeyPair().publicKey,
        destination: { kind: "github_repo_secret", host: "api.github.com" },
      },
    });

    const events = await h.deps.vaultAuditStore.list(a.accountId);
    const retrieved = events.filter(
      (e) => e.type === VAULT_AUDIT_TYPES.retrieved && e.payload.purpose === "egress",
    );
    expect(retrieved).toHaveLength(1);
    expect(retrieved[0]!.payload).toMatchObject({
      reference,
      requester: "agent",
      target_host: "api.github.com",
      outcome: "success",
    });
  });

  it("403s a destination host that is not on allowed_hosts, before any decrypt", async () => {
    const a = await actor(h, "offlist@example.test");
    // allowed_hosts = [api.example.com]; api.github.com is NOT on it.
    const reference = await storeCred(h, a.cookie, { observed_hosts: ["api.example.com"] });

    const res = await h.server.inject({
      method: "POST",
      url: "/v1/vault/egress-fetch",
      headers: { authorization: `Bearer ${a.token}`, "content-type": "application/json" },
      payload: {
        reference,
        fields: ["api_key"],
        encrypted_response_public_key: egressKeyPair().publicKey,
        destination: { kind: "github_repo_secret", host: "api.github.com" },
      },
    });

    expect(res.statusCode).toBe(403);
    const body = res.json() as { error: string; host: string; hint: string };
    expect(body.error).toBe("host_not_allowed");
    expect(body.host).toBe("api.github.com");
    expect(body.hint).toContain("allowed_hosts");

    const events = await h.deps.vaultAuditStore.list(a.accountId);
    expect(
      events.filter((e) => e.type === VAULT_AUDIT_TYPES.proxyRejected)[0]!.payload,
    ).toMatchObject({ reference, purpose: "egress", target_host: "api.github.com" });
    // No retrieval row: the gate ran before the decrypt path was entered.
    expect(events.some((e) => e.type === VAULT_AUDIT_TYPES.retrieved)).toBe(false);
  });

  it("normalises the destination host the same way the proxy does", async () => {
    const a = await actor(h, "normalise@example.test");
    const reference = await storeCred(h, a.cookie);

    const res = await h.server.inject({
      method: "POST",
      url: "/v1/vault/egress-fetch",
      headers: { authorization: `Bearer ${a.token}`, "content-type": "application/json" },
      payload: {
        reference,
        fields: ["api_key"],
        encrypted_response_public_key: egressKeyPair().publicKey,
        destination: { kind: "github_repo_secret", host: "https://API.github.com:443/repos" },
      },
    });

    expect(res.statusCode).toBe(200);
  });

  it("400s a public key the server cannot seal to", async () => {
    const a = await actor(h, "badkey@example.test");
    const reference = await storeCred(h, a.cookie);

    const res = await h.server.inject({
      method: "POST",
      url: "/v1/vault/egress-fetch",
      headers: { authorization: `Bearer ${a.token}`, "content-type": "application/json" },
      payload: {
        reference,
        fields: ["api_key"],
        encrypted_response_public_key:
          "-----BEGIN PUBLIC KEY-----\nnot-a-key\n-----END PUBLIC KEY-----",
        destination: { kind: "github_repo_secret", host: "api.github.com" },
      },
    });

    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe("invalid_public_key");
  });

  it("400s a field the credential does not have", async () => {
    const a = await actor(h, "missing@example.test");
    const reference = await storeCred(h, a.cookie);

    const res = await h.server.inject({
      method: "POST",
      url: "/v1/vault/egress-fetch",
      headers: { authorization: `Bearer ${a.token}`, "content-type": "application/json" },
      payload: {
        reference,
        fields: ["nope"],
        encrypted_response_public_key: egressKeyPair().publicKey,
        destination: { kind: "github_repo_secret", host: "api.github.com" },
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "missing_fields", fields: ["nope"] });
  });

  it("serves a dotenv_write destination on the local-file sentinel without a host entry", async () => {
    const a = await actor(h, "dotenv@example.test");
    // No network host in common — the .env gate is the mcp-side project-root check.
    const reference = await storeCred(h, a.cookie, { observed_hosts: ["api.example.com"] });
    const keys = egressKeyPair();

    const res = await h.server.inject({
      method: "POST",
      url: "/v1/vault/egress-fetch",
      headers: { authorization: `Bearer ${a.token}`, "content-type": "application/json" },
      payload: {
        reference,
        fields: ["api_key"],
        encrypted_response_public_key: keys.publicKey,
        destination: { kind: "dotenv_write", host: "local-file" },
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { encrypted_fields: Record<string, string> };
    expect(keys.decrypt(body.encrypted_fields.api_key!)).toBe(SECRET_VALUE);

    const events = await h.deps.vaultAuditStore.list(a.accountId);
    const retrieved = events.filter((e) => e.type === VAULT_AUDIT_TYPES.retrieved);
    expect(retrieved[0]!.payload.target_host).toBe("local-file");
  });

  it("400s a dotenv_write destination that claims a network host", async () => {
    const a = await actor(h, "dotenv-host@example.test");
    const reference = await storeCred(h, a.cookie);

    const res = await h.server.inject({
      method: "POST",
      url: "/v1/vault/egress-fetch",
      headers: { authorization: `Bearer ${a.token}`, "content-type": "application/json" },
      payload: {
        reference,
        fields: ["api_key"],
        encrypted_response_public_key: egressKeyPair().publicKey,
        destination: { kind: "dotenv_write", host: "api.github.com" },
      },
    });

    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe("invalid_request");
  });

  it("404s another account's credential", async () => {
    const owner = await actor(h, "owner@example.test");
    const stranger = await actor(h, "stranger@example.test");
    const reference = await storeCred(h, owner.cookie);

    const res = await h.server.inject({
      method: "POST",
      url: "/v1/vault/egress-fetch",
      headers: { authorization: `Bearer ${stranger.token}`, "content-type": "application/json" },
      payload: {
        reference,
        fields: ["api_key"],
        encrypted_response_public_key: egressKeyPair().publicKey,
        destination: { kind: "github_repo_secret", host: "api.github.com" },
      },
    });

    expect(res.statusCode).toBe(404);
  });

  it("refuses a username_password credential (browser-fill's job, not egress)", async () => {
    const a = await actor(h, "login@example.test");
    const reference = await storeCred(h, a.cookie, {
      service: "someapp",
      fields: { login: "ada@example.test", password: "correct-horse" },
      type: "username_password",
      auth_strategy: "username_password",
      login_hosts: ["someapp.example"],
    });

    const res = await h.server.inject({
      method: "POST",
      url: "/v1/vault/egress-fetch",
      headers: { authorization: `Bearer ${a.token}`, "content-type": "application/json" },
      payload: {
        reference,
        fields: ["password"],
        encrypted_response_public_key: egressKeyPair().publicKey,
        destination: { kind: "github_repo_secret", host: "api.github.com" },
      },
    });

    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe("unsupported_credential_type");
  });
});

describe("POST /v1/vault/egress-outcome", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup();
  });
  afterEach(async () => {
    await h.server.close();
  });

  it("records the GitHub destination and an ok status", async () => {
    const a = await actor(h, "outcome-ok@example.test");
    const reference = await storeCred(h, a.cookie);

    const res = await h.server.inject({
      method: "POST",
      url: "/v1/vault/egress-outcome",
      headers: { authorization: `Bearer ${a.token}`, "content-type": "application/json" },
      payload: {
        reference,
        destination: { kind: "github_repo_secret", repo: "octo/demo", environment: "production" },
        status: "ok",
      },
    });

    expect(res.statusCode).toBe(201);
    const delivered = (await h.deps.vaultAuditStore.list(a.accountId)).filter(
      (e) => e.type === VAULT_AUDIT_TYPES.egressDelivered,
    );
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.payload).toMatchObject({
      reference,
      requester: "agent",
      purpose: "egress",
      egress_kind: "github_repo_secret",
      egress_destination: "octo/demo:production",
      egress_status: "ok",
    });
  });

  it("records a .env destination and the destination's own error text", async () => {
    const a = await actor(h, "outcome-err@example.test");
    const reference = await storeCred(h, a.cookie);

    const res = await h.server.inject({
      method: "POST",
      url: "/v1/vault/egress-outcome",
      headers: { authorization: `Bearer ${a.token}`, "content-type": "application/json" },
      payload: {
        reference,
        destination: { kind: "dotenv_write", path: "/home/ada/proj/.env" },
        status: "error",
        error: "EACCES: permission denied",
      },
    });

    expect(res.statusCode).toBe(201);
    const delivered = (await h.deps.vaultAuditStore.list(a.accountId)).filter(
      (e) => e.type === VAULT_AUDIT_TYPES.egressDelivered,
    );
    expect(delivered[0]!.payload).toMatchObject({
      egress_kind: "dotenv_write",
      egress_destination: "/home/ada/proj/.env",
      egress_status: "error",
      egress_error: "EACCES: permission denied",
    });
  });

  it("404s an unknown reference", async () => {
    const a = await actor(h, "outcome-404@example.test");
    const res = await h.server.inject({
      method: "POST",
      url: "/v1/vault/egress-outcome",
      headers: { authorization: `Bearer ${a.token}`, "content-type": "application/json" },
      payload: {
        reference: "vault://acct/does-not-exist",
        destination: { kind: "dotenv_write", path: "/tmp/.env" },
        status: "ok",
      },
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: string }).error).toBe("credential_not_found");
  });

  it("404s another account's credential", async () => {
    const owner = await actor(h, "outcome-owner@example.test");
    const stranger = await actor(h, "outcome-stranger@example.test");
    const reference = await storeCred(h, owner.cookie);

    const res = await h.server.inject({
      method: "POST",
      url: "/v1/vault/egress-outcome",
      headers: { authorization: `Bearer ${stranger.token}`, "content-type": "application/json" },
      payload: {
        reference,
        destination: { kind: "github_repo_secret", repo: "octo/demo" },
        status: "ok",
      },
    });

    expect(res.statusCode).toBe(404);
  });

  it("rejects an unauthenticated call", async () => {
    const res = await h.server.inject({
      method: "POST",
      url: "/v1/vault/egress-outcome",
      headers: { "content-type": "application/json" },
      payload: {
        reference: "vault://x",
        destination: { kind: "dotenv_write", path: "/tmp/.env" },
        status: "ok",
      },
    });
    expect(res.statusCode).toBe(401);
  });
});
