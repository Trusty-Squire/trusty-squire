// fetch_credential's server half. This is the ONE path that returns a raw
// vaulted value to an agent, so the tests are the deliverable: every branch
// that must yield NO value is asserted to yield no value, and the assertion is
// made against the whole response body, not just a status field.

import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { VAULT_AUDIT_TYPES, VAULT_REVEAL_PURPOSE } from "@trusty-squire/vault";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { issueAgentSession } from "../auth/agent.js";
import { issueSession, SESSION_COOKIE_NAME, signSessionJwt } from "../auth/session.js";
import { buildInMemoryDeps, type ApiDeps } from "../services/deps.js";
import {
  CREDENTIAL_FETCH_VOUCH_CONTEXT,
  CREDENTIAL_MUTATION_VOUCH_CONTEXT,
  PAYMENT_VOUCH_CONTEXT,
  createVouchMandateVerifier,
  type VouchMandateVerifier,
} from "../services/vouch-mandate.js";
import { buildServer } from "../server.js";
import { HttpProxyExecutor } from "../services/http-proxy.js";

const SESSION_SECRET = "credential-fetch-test-session-secret";
const AUDIENCE = "credential-fetch-test-customer";
const SECRET_VALUE = "sk-live-this-must-never-leak";
// The ceremony is sessionless, so the SIGNER is what ties an assertion to the
// owning account: Vouchflow names the device in the signed claims, and the
// owner claims that device from a signed-in browser.
const OWNER_DEVICE_TOKEN = "dev_owner_device_token";
const OWNER_SIGNING_DEVICE_ID = "sdev_owner_signing_device";
const FOREIGN_DEVICE_TOKEN = "dev_stranger_device_token";

type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

describe("passkey-gated fetch_credential", () => {
  let server: FastifyInstance;
  let deps: ApiDeps;
  let nowMs: number;
  let agentToken: string;
  let accountId: string;
  let signingKey: SigningKey;
  let vouchVerifier: VouchMandateVerifier;

  beforeEach(async () => {
    nowMs = Date.parse("2026-09-05T12:00:00.000Z");
    vi.stubEnv("VOUCHFLOW_CUSTOMER_ID", AUDIENCE);
    const keys = await generateKeyPair("ES256");
    signingKey = keys.privateKey;
    const publicJwk = await exportJWK(keys.publicKey);
    publicJwk.kid = "credential-fetch-test-key";
    deps = buildInMemoryDeps({ sessionSecret: SESSION_SECRET, now: () => new Date(nowMs) });
    vouchVerifier = createVouchMandateVerifier(
      async () => Response.json({ keys: [publicJwk] }),
      "https://vouchflow.test",
    );
    server = await buildServer({ deps, vouchVerifier });
    const account = await deps.accountStore.createAccount("fetcher@example.test", "Fetcher");
    accountId = account.id;
    agentToken = await issueAgentToken(accountId, "codex");
    expect((await registerDevice(OWNER_DEVICE_TOKEN)).statusCode).toBe(204);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await server.close();
  });

  async function issueAgentToken(account: string, identity: string): Promise<string> {
    const session = issueAgentSession({
      account_id: account,
      agent_identity: identity,
      agent_version: "test",
      now: new Date(nowMs),
    });
    await deps.agentSessionStore.insert(session.record);
    return session.raw_token;
  }

  async function storeCredential(
    body: Record<string, unknown>,
    token = agentToken,
  ): Promise<string> {
    const response = await server.inject({
      method: "POST",
      url: "/v1/vault/credentials",
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    });
    expect(response.statusCode).toBe(201);
    return (response.json() as { reference: string }).reference;
  }

  // The add-a-field route is web-session only; the fetch path has to hold up
  // against a credential the HUMAN reshaped mid-approval.
  async function webCookie(account = accountId): Promise<string> {
    const { record, jwt } = issueSession({
      account_id: account,
      ip: null,
      user_agent: null,
      now: new Date(nowMs),
    });
    await deps.sessionStore.insert(record);
    return `${SESSION_COOKIE_NAME}=${signSessionJwt(jwt, SESSION_SECRET)}`;
  }

  async function registerDevice(deviceToken: string, cookie?: string) {
    return await server.inject({
      method: "POST",
      url: "/v1/vouchflow/devices",
      headers: { cookie: cookie ?? (await webCookie()) },
      payload: { device_token: deviceToken },
    });
  }

  async function createFetch(payload: Record<string, unknown>, token = agentToken) {
    return await server.inject({
      method: "POST",
      url: "/v1/vault/fetch-approvals",
      headers: { authorization: `Bearer ${token}`, "x-squire-agent-identity": "Codex" },
      payload,
    });
  }

  async function resume(id: string, token = agentToken) {
    return await server.inject({
      method: "GET",
      url: `/v1/vault/fetch-approvals/${id}`,
      headers: { authorization: `Bearer ${token}` },
    });
  }

  async function ceremony(id: string, cookie?: string) {
    const response = await server.inject({
      method: "GET",
      url: `/v1/vault/fetch-approvals/${id}/ceremony`,
      headers: { cookie: cookie ?? (await webCookie()) },
    });
    expect(response.statusCode).toBe(200);
    return response.json() as { payload: unknown; payload_sha256: string };
  }

  async function signHash(
    hash: string,
    context: string,
    mandateId: string,
    expiration: string | number = "10m",
    device: { device_token?: string; signing_device_id?: string } = {
      device_token: OWNER_DEVICE_TOKEN,
      signing_device_id: OWNER_SIGNING_DEVICE_ID,
    },
  ): Promise<string> {
    return await new SignJWT({
      context,
      payload_sha256: hash,
      confidence: "low",
      mandate_id: mandateId,
      ...device,
    })
      .setProtectedHeader({ alg: "ES256", kid: "credential-fetch-test-key" })
      .setIssuer("https://vouchflow.dev")
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(expiration)
      .sign(signingKey);
  }

  // The human half of the ceremony is sessionless: the assertion, signed over
  // this approval's payload by a device the owner registered, is the authority.
  async function approve(id: string, context = CREDENTIAL_FETCH_VOUCH_CONTEXT) {
    const signed = await ceremony(id);
    const jws = await signHash(signed.payload_sha256, context, `mandate_${id}`);
    return await server.inject({
      method: "POST",
      url: `/v1/vault/fetch-approvals/${id}/approve`,
      payload: { jws },
    });
  }

  async function deny(id: string, cookie?: string) {
    return await server.inject({
      method: "POST",
      url: `/v1/vault/fetch-approvals/${id}/deny`,
      headers: { cookie: cookie ?? (await webCookie()) },
      payload: {},
    });
  }

  async function revealAudit() {
    const events = await deps.vaultAuditStore.list(accountId, { limit: 200 });
    return events.filter((event) => event.payload.purpose === VAULT_REVEAL_PURPOSE);
  }

  // Ledger ordering across a moving clock is not the property under test; the
  // SET of terminal outcomes recorded is.
  async function revealOutcomes(): Promise<string[]> {
    return (await revealAudit()).map((event) => String(event.payload.outcome)).sort();
  }

  // Every no-value branch asserts on the raw body: a `fields` key that is
  // absent from the type but present on the wire would still be a leak.
  function expectNoValueAnywhere(body: string): void {
    expect(body).not.toContain(SECRET_VALUE);
    expect(JSON.parse(body)).not.toHaveProperty("fields");
  }

  it("mints an approval link and returns NO value before the passkey signs", async () => {
    const reference = await storeCredential({ service: "OpenAI", value: SECRET_VALUE });
    const created = await createFetch({ reference });
    expect(created.statusCode).toBe(201);
    const approval = created.json() as {
      approval_id: string;
      approval_url: string;
      status: string;
      credential: { reference: string };
      field: string | null;
    };
    expect(approval.status).toBe("pending");
    expect(approval.approval_url).toContain(`/vault/fetch/${approval.approval_id}`);
    expect(approval.credential.reference).toBe(reference);
    expectNoValueAnywhere(created.body);

    // Polling an unsigned approval is not authority to read it.
    const polled = await resume(approval.approval_id);
    expect(polled.statusCode).toBe(200);
    expect((polled.json() as { status: string }).status).toBe("pending");
    expectNoValueAnywhere(polled.body);
    expect(await revealAudit()).toEqual([]);
  });

  it("stores requested_by and reason on the ceremony the page reads", async () => {
    const reference = await storeCredential({ service: "OpenAI", value: SECRET_VALUE });
    const created = await createFetch({
      reference,
      reason: "write the key into a GitHub Actions secret",
    });
    expect(created.statusCode).toBe(201);
    const approval = created.json() as {
      approval_id: string;
      requested_by: string | null;
      reason: string | null;
    };
    expect(approval.requested_by).toBe("Codex");
    expect(approval.reason).toBe("write the key into a GitHub Actions secret");

    const page = await server.inject({
      method: "GET",
      url: `/v1/vault/fetch-approvals/${approval.approval_id}/ceremony`,
    });
    expect(page.statusCode).toBe(200);
    expect(page.json()).toMatchObject({
      requested_by: "Codex",
      reason: "write the key into a GitHub Actions secret",
    });
    // Who/why are display-only: they must not enter the signed payload.
    expect((page.json() as { payload: Record<string, unknown> }).payload).not.toHaveProperty(
      "requested_by",
    );
    expect((page.json() as { payload: Record<string, unknown> }).payload).not.toHaveProperty(
      "reason",
    );
  });

  it("stores a null reason when the agent omits one", async () => {
    const reference = await storeCredential({ service: "OpenAI", value: SECRET_VALUE });
    const created = await createFetch({ reference });
    expect(created.statusCode).toBe(201);
    expect((created.json() as { reason: string | null }).reason).toBeNull();

    const page = await server.inject({
      method: "GET",
      url: `/v1/vault/fetch-approvals/${(created.json() as { approval_id: string }).approval_id}/ceremony`,
    });
    expect(page.statusCode).toBe(200);
    expect((page.json() as { reason: string | null }).reason).toBeNull();
    expect((page.json() as { requested_by: string | null }).requested_by).toBe("Codex");
  });

  it("returns the raw value once a valid fetch mandate is signed, and audits purpose=reveal", async () => {
    const reference = await storeCredential({ service: "OpenAI", value: SECRET_VALUE });
    const approval = (await createFetch({ reference })).json() as { approval_id: string };

    expect((await approve(approval.approval_id)).statusCode).toBe(200);

    const delivered = await resume(approval.approval_id);
    expect(delivered.statusCode).toBe(200);
    const body = delivered.json() as { status: string; fields: Record<string, string> };
    expect(body.status).toBe("consumed");
    expect(body.fields).toEqual({ value: SECRET_VALUE });

    // Both halves of the transaction are on the ledger: the human's approval
    // (naming the approving account) and the delivery it authorized.
    expect(await revealOutcomes()).toEqual(["approved", "success"]);
    const audit = await revealAudit();
    expect(audit.every((event) => event.type === VAULT_AUDIT_TYPES.retrieved)).toBe(true);
    expect(audit.find((event) => event.payload.outcome === "approved")!.payload).toMatchObject({
      reference,
      purpose: "reveal",
      approval_id: approval.approval_id,
      approver_account_id: accountId,
      // The device the assertion came from, which is what let the route
      // attribute the approval to this account at all.
      signing_device_id: OWNER_SIGNING_DEVICE_ID,
    });
    // The delivery row names the approver too. A ledger where only the decision
    // carries it cannot answer "who released this secret?" from the row that
    // records the secret actually leaving.
    expect(audit.find((event) => event.payload.outcome === "success")!.payload).toMatchObject({
      reference,
      requester: "agent",
      purpose: "reveal",
      outcome: "success",
      approval_id: approval.approval_id,
      approver_account_id: accountId,
    });
    // The audit trail records that a reveal happened, never what was revealed.
    expect(JSON.stringify(audit)).not.toContain(SECRET_VALUE);
  });

  it("refuses an unsigned, malformed, or wrong-context mandate", async () => {
    const reference = await storeCredential({ service: "OpenAI", value: SECRET_VALUE });
    const approval = (await createFetch({ reference })).json() as { approval_id: string };

    const cookie = await webCookie();
    const unsigned = await server.inject({
      method: "POST",
      url: `/v1/vault/fetch-approvals/${approval.approval_id}/approve`,
      headers: { cookie },
      payload: {},
    });
    expect(unsigned.statusCode).toBe(400);

    const malformed = await server.inject({
      method: "POST",
      url: `/v1/vault/fetch-approvals/${approval.approval_id}/approve`,
      headers: { cookie },
      payload: { jws: "not.a.valid-jws" },
    });
    expect(malformed.statusCode).toBe(403);

    // A payment mandate and a credential-MUTATION mandate are both real,
    // valid Vouchflow assertions. Neither may reveal a secret.
    for (const context of [PAYMENT_VOUCH_CONTEXT, CREDENTIAL_MUTATION_VOUCH_CONTEXT]) {
      const wrong = await approve(approval.approval_id, context);
      expect(wrong.statusCode).toBe(403);
      expect(wrong.json()).toEqual({ error: "invalid_mandate_context" });
    }

    const stillPending = await resume(approval.approval_id);
    expect((stillPending.json() as { status: string }).status).toBe("pending");
    expectNoValueAnywhere(stillPending.body);
  });

  it("cannot be approved with a mandate signed over a DIFFERENT fetch approval", async () => {
    const first = await storeCredential({ service: "OpenAI", value: SECRET_VALUE });
    const second = await storeCredential({ service: "Stripe", value: "sk-other-secret" });
    const a = (await createFetch({ reference: first })).json() as { approval_id: string };
    const b = (await createFetch({ reference: second })).json() as { approval_id: string };

    // Sign B's payload, present it for A.
    const signedB = await ceremony(b.approval_id);
    const jws = await signHash(
      signedB.payload_sha256,
      CREDENTIAL_FETCH_VOUCH_CONTEXT,
      `mandate_${b.approval_id}`,
    );
    const crossed = await server.inject({
      method: "POST",
      url: `/v1/vault/fetch-approvals/${a.approval_id}/approve`,
      headers: { cookie: await webCookie() },
      payload: { jws },
    });
    expect(crossed.statusCode).toBe(403);
    expect(crossed.json()).toEqual({ error: "payload_hash_mismatch" });

    const polled = await resume(a.approval_id);
    expect((polled.json() as { status: string }).status).toBe("pending");
    expectNoValueAnywhere(polled.body);
  });

  it("returns an error and no value after the user denies", async () => {
    const reference = await storeCredential({ service: "OpenAI", value: SECRET_VALUE });
    const approval = (await createFetch({ reference })).json() as { approval_id: string };

    const denied = await deny(approval.approval_id);
    expect(denied.statusCode).toBe(200);
    expect(denied.json()).toEqual({ status: "denied" });

    const resumed = await resume(approval.approval_id);
    expect(resumed.statusCode).toBe(409);
    expect((resumed.json() as { error: string }).error).toBe("credential_fetch_denied");
    expectNoValueAnywhere(resumed.body);

    // A denial cannot be walked back by signing afterwards.
    expect((await approve(approval.approval_id)).statusCode).toBe(409);
    expectNoValueAnywhere((await resume(approval.approval_id)).body);

    const audit = await revealAudit();
    expect(audit).toHaveLength(1);
    // The ledger names the outcome and the credential. It does NOT name a
    // refuser: deny carries no assertion, so the route knows only that someone
    // holding the link said no — claiming the owner did would be a fiction.
    expect(audit[0]!.payload).toMatchObject({
      outcome: "denied",
      reference,
      purpose: "reveal",
      approval_id: approval.approval_id,
    });
    expect(audit[0]!.payload).not.toHaveProperty("approver_account_id");
    expect(JSON.stringify(audit)).not.toContain(SECRET_VALUE);
  });

  it("returns an error and no value once the approval expires, signed or not", async () => {
    const reference = await storeCredential({ service: "OpenAI", value: SECRET_VALUE });

    // Never signed: expiry alone closes it.
    const stale = (await createFetch({ reference })).json() as { approval_id: string };
    nowMs += 11 * 60 * 1000;
    const staleResume = await resume(stale.approval_id);
    expect(staleResume.statusCode).toBe(409);
    expect((staleResume.json() as { error: string }).error).toBe(
      "credential_fetch_approval_expired",
    );
    expectNoValueAnywhere(staleResume.body);
    expect((await approve(stale.approval_id)).statusCode).toBe(409);

    // Signed but left unclaimed past expiry: the window closes on delivery too.
    const signed = (await createFetch({ reference })).json() as { approval_id: string };
    expect((await approve(signed.approval_id)).statusCode).toBe(200);
    nowMs += 11 * 60 * 1000;
    const lateResume = await resume(signed.approval_id);
    expect(lateResume.statusCode).toBe(409);
    expect((lateResume.json() as { error: string }).error).toBe(
      "credential_fetch_approval_expired",
    );
    expectNoValueAnywhere(lateResume.body);

    expect(await revealOutcomes()).toEqual(["approved", "expired", "expired"]);

    // Polling an already-lapsed approval must not keep growing the ledger.
    for (let i = 0; i < 4; i++) {
      expect((await resume(stale.approval_id)).statusCode).toBe(409);
      expect((await resume(signed.approval_id)).statusCode).toBe(409);
    }
    expect(await revealOutcomes()).toEqual(["approved", "expired", "expired"]);
  });

  it("delivers exactly once — a replayed approval_id returns no second value", async () => {
    const reference = await storeCredential({ service: "OpenAI", value: SECRET_VALUE });
    const approval = (await createFetch({ reference })).json() as { approval_id: string };
    expect((await approve(approval.approval_id)).statusCode).toBe(200);

    const first = await resume(approval.approval_id);
    expect(first.statusCode).toBe(200);
    expect((first.json() as { fields: Record<string, string> }).fields.value).toBe(SECRET_VALUE);

    const replay = await resume(approval.approval_id);
    expect(replay.statusCode).toBe(409);
    expect((replay.json() as { error: string }).error).toBe("credential_fetch_already_delivered");
    expectNoValueAnywhere(replay.body);

    // Re-signing a spent approval does not re-open it.
    expect((await approve(approval.approval_id)).statusCode).toBe(409);
    expectNoValueAnywhere((await resume(approval.approval_id)).body);
    // One approval, one delivery — a refused re-approval adds no second pair.
    expect(await revealOutcomes()).toEqual(["approved", "success"]);
  });

  it("is invisible to another account, even with the exact approval id", async () => {
    const reference = await storeCredential({ service: "OpenAI", value: SECRET_VALUE });
    const approval = (await createFetch({ reference })).json() as { approval_id: string };
    expect((await approve(approval.approval_id)).statusCode).toBe(200);

    const other = await deps.accountStore.createAccount("intruder@example.test", "Intruder");
    const otherToken = await issueAgentToken(other.id, "claude");

    const stolen = await resume(approval.approval_id, otherToken);
    expect(stolen.statusCode).toBe(404);
    expectNoValueAnywhere(stolen.body);

    // …and the owner's approval is still intact and unspent.
    const owner = await resume(approval.approval_id);
    expect(owner.statusCode).toBe(200);
    expect((owner.json() as { fields: Record<string, string> }).fields.value).toBe(SECRET_VALUE);
  });

  it("cannot mint an approval against another account's credential", async () => {
    const other = await deps.accountStore.createAccount("victim@example.test", "Victim");
    const otherToken = await issueAgentToken(other.id, "claude");
    const victimRef = await storeCredential({ service: "OpenAI", value: SECRET_VALUE }, otherToken);

    const created = await createFetch({ reference: victimRef });
    expect(created.statusCode).toBe(404);
    expect(created.json()).toEqual({ error: "credential_not_found" });
  });

  it("a fetch approval cannot be replayed at the mutation route, and vice versa", async () => {
    const reference = await storeCredential({ service: "OpenAI", value: SECRET_VALUE });
    const fetchApproval = (await createFetch({ reference })).json() as { approval_id: string };
    expect((await approve(fetchApproval.approval_id)).statusCode).toBe(200);

    // The stores are disjoint: a fetch id is not a mutation id.
    const asMutation = await server.inject({
      method: "GET",
      url: `/v1/vault/mutation-approvals/${fetchApproval.approval_id}`,
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(asMutation.statusCode).toBe(404);

    const mutation = await server.inject({
      method: "POST",
      url: "/v1/vault/mutation-approvals",
      headers: { authorization: `Bearer ${agentToken}` },
      payload: {
        operation: "edit",
        reference,
        changes: { allowed_hosts: { mode: "add", hosts: ["extra.openai.com"] } },
      },
    });
    expect(mutation.statusCode).toBe(201);
    const mutationId = (mutation.json() as { approval_id: string }).approval_id;

    const asFetch = await resume(mutationId);
    expect(asFetch.statusCode).toBe(404);
    expectNoValueAnywhere(asFetch.body);
    // The fetch approval was signed but never claimed: an approval row, and no
    // delivery of any kind.
    expect(await revealOutcomes()).toEqual(["approved"]);
  });

  it("selects one field, and refuses an ambiguous or unknown field with no value", async () => {
    const reference = await storeCredential({
      service: "AWS",
      fields: { access_key_id: "AKIAEXAMPLE", secret_access_key: SECRET_VALUE },
    });

    const ambiguous = await createFetch({ reference });
    expect(ambiguous.statusCode).toBe(409);
    expect(ambiguous.json()).toEqual({
      error: "ambiguous_credential_field",
      field_names: ["access_key_id", "secret_access_key"],
    });
    expectNoValueAnywhere(ambiguous.body);

    const unknown = await createFetch({ reference, field: "session_token" });
    expect(unknown.statusCode).toBe(404);
    expect((unknown.json() as { error: string }).error).toBe("credential_field_not_found");
    expectNoValueAnywhere(unknown.body);

    const scoped = (await createFetch({ reference, field: "secret_access_key" })).json() as {
      approval_id: string;
    };
    expect((await approve(scoped.approval_id)).statusCode).toBe(200);
    const delivered = await resume(scoped.approval_id);
    expect(delivered.statusCode).toBe(200);
    // Only the approved field is disclosed; the sibling stays in the vault.
    expect((delivered.json() as { fields: Record<string, string> }).fields).toEqual({
      secret_access_key: SECRET_VALUE,
    });
    expect(delivered.body).not.toContain("AKIAEXAMPLE");
  });

  it("binds the signed payload to the exact credential, field, and agent", async () => {
    const reference = await storeCredential({
      service: "AWS",
      fields: { access_key_id: "AKIAEXAMPLE", secret_access_key: SECRET_VALUE },
    });
    const approval = (await createFetch({ reference, field: "secret_access_key" })).json() as {
      approval_id: string;
    };
    const signed = await ceremony(approval.approval_id);
    expect(signed.payload).toMatchObject({
      agent: "codex",
      approval_id: approval.approval_id,
      credential: { reference },
      fetch: { field: "secret_access_key", purpose: "credential.reveal" },
      requester_kind: "agent",
    });
    // The ceremony page shows the human what is at stake, never the secret.
    expect(JSON.stringify(signed)).not.toContain(SECRET_VALUE);
  });

  it("discloses only the field set the human signed, even if the credential grew one", async () => {
    const reference = await storeCredential({ service: "OpenAI", value: SECRET_VALUE });
    const approval = (await createFetch({ reference })).json() as { approval_id: string };
    // The ceremony was signed over a single-field credential…
    expect((await ceremony(approval.approval_id)).payload).toMatchObject({
      fetch: { field: null, field_names: ["value"] },
    });
    expect((await approve(approval.approval_id)).statusCode).toBe(200);

    // …and only then does the credential gain a second field.
    const target = await deps.credentialStore.findActive(reference);
    const added = await server.inject({
      method: "POST",
      url: `/v1/vault/credentials/${target!.id}/fields`,
      headers: { cookie: await webCookie() },
      payload: { name: "org_id", value: "org-added-after-approval" },
    });
    expect(added.statusCode).toBe(200);

    const delivered = await resume(approval.approval_id);
    expect(delivered.statusCode).toBe(200);
    expect((delivered.json() as { fields: Record<string, string> }).fields).toEqual({
      value: SECRET_VALUE,
    });
    expect(delivered.body).not.toContain("org-added-after-approval");
  });

  it("reuses one pending approval for a repeated identical request", async () => {
    const reference = await storeCredential({ service: "OpenAI", value: SECRET_VALUE });
    const first = (await createFetch({ reference })).json() as { approval_id: string };
    const second = await createFetch({ reference });
    expect(second.statusCode).toBe(200);
    expect((second.json() as { approval_id: string }).approval_id).toBe(first.approval_id);
    expectNoValueAnywhere(second.body);
  });

  // Holding the approval link alone is still not authority to RELEASE the
  // secret: the assertion must be signed over THIS approval's account-bound
  // payload, and verification rejects anything else. What the removal of the
  // web-session gate changed is who may PRESENT a valid assertion — the
  // sessionless Telegram-link browser, like payments — not what counts as one.
  it("refuses an approval settled by an assertion over a DIFFERENT account-bound payload", async () => {
    const reference = await storeCredential({ service: "OpenAI", value: SECRET_VALUE });
    const approval = (await createFetch({ reference })).json() as { approval_id: string };

    // The sessionless ceremony names the owning account only through its
    // opaque account binding.
    const peeked = await server.inject({
      method: "GET",
      url: `/v1/vault/fetch-approvals/${approval.approval_id}/ceremony`,
    });
    expect(peeked.statusCode).toBe(200);
    const signed = peeked.json() as { payload_sha256: string; payload: Record<string, unknown> };
    expect(signed.payload).toMatchObject({
      account_binding: createHash("sha256")
        .update("trusty-squire/credential-fetch/account/v1\n")
        .update(accountId)
        .digest("base64url"),
    });

    // An assertion over a DIFFERENT approval's payload — however genuine —
    // never settles this one, session or no session.
    const otherReference = await storeCredential({ service: "Stripe", value: "sk-other-secret" });
    const second = (await createFetch({ reference: otherReference })).json() as {
      approval_id: string;
    };
    const foreignCeremony = await ceremony(second.approval_id);
    const jws = await signHash(
      foreignCeremony.payload_sha256,
      CREDENTIAL_FETCH_VOUCH_CONTEXT,
      `mandate_${second.approval_id}`,
    );
    const crossed = await server.inject({
      method: "POST",
      url: `/v1/vault/fetch-approvals/${approval.approval_id}/approve`,
      payload: { jws },
    });
    expect(crossed.statusCode).toBe(403);
    expect(crossed.json()).toEqual({ error: "payload_hash_mismatch" });

    // The owner's approval is untouched, and no value moved.
    const polled = await resume(approval.approval_id);
    expect((polled.json() as { status: string }).status).toBe("pending");
    expectNoValueAnywhere(polled.body);
    expect(await revealAudit()).toEqual([]);
    expect(JSON.stringify(await revealAudit())).not.toContain(SECRET_VALUE);
  });

  // The hole the payload binding alone does NOT close, now that the ceremony
  // takes no session: an assertion over the RIGHT payload, produced by someone
  // else's entirely genuine passkey. Only the account's own registered signing
  // devices may answer its approvals.
  it("refuses a correctly-bound assertion from a device the account never registered", async () => {
    const reference = await storeCredential({ service: "OpenAI", value: SECRET_VALUE });
    const approval = (await createFetch({ reference })).json() as { approval_id: string };
    const signed = await ceremony(approval.approval_id);

    const strangerJws = await signHash(
      signed.payload_sha256,
      CREDENTIAL_FETCH_VOUCH_CONTEXT,
      `mandate_${approval.approval_id}`,
      "10m",
      { device_token: FOREIGN_DEVICE_TOKEN, signing_device_id: "sdev_stranger" },
    );
    const stranger = await server.inject({
      method: "POST",
      url: `/v1/vault/fetch-approvals/${approval.approval_id}/approve`,
      payload: { jws: strangerJws },
    });
    expect(stranger.statusCode, stranger.body).toBe(403);
    expect(stranger.json()).toEqual({ error: "mandate_signer_not_authorized" });

    // An assertion that names no signer at all is equally unattributable.
    const unnamedJws = await signHash(
      signed.payload_sha256,
      CREDENTIAL_FETCH_VOUCH_CONTEXT,
      `mandate_${approval.approval_id}`,
      "10m",
      {},
    );
    const unnamed = await server.inject({
      method: "POST",
      url: `/v1/vault/fetch-approvals/${approval.approval_id}/approve`,
      payload: { jws: unnamedJws },
    });
    expect(unnamed.statusCode, unnamed.body).toBe(403);
    expect(unnamed.json()).toEqual({ error: "missing_device_token" });

    // The approval never moved, nothing was revealed, and the ledger has no
    // settlement to report.
    const polled = await resume(approval.approval_id);
    expect((polled.json() as { status: string }).status).toBe("pending");
    expectNoValueAnywhere(polled.body);
    expect(await revealAudit()).toEqual([]);

    // Once the owner claims that device from a signed-in browser, the SAME
    // assertion settles the approval — the binding is the only thing that
    // was missing.
    expect((await registerDevice(FOREIGN_DEVICE_TOKEN)).statusCode).toBe(204);
    const accepted = await server.inject({
      method: "POST",
      url: `/v1/vault/fetch-approvals/${approval.approval_id}/approve`,
      payload: { jws: strangerJws },
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect((await resume(approval.approval_id)).json()).toMatchObject({
      fields: { value: SECRET_VALUE },
    });
  });

  // One physical passkey belongs to every account its owner holds, and the
  // ceremony pages claim it on every signed-in visit. A device-keyed binding
  // would let signing into a second account silently strip the first one's,
  // refusing its very next approval for something no human did.
  it("keeps a device bound to every account that claimed it, not just the last", async () => {
    const second = await deps.accountStore.createAccount("second@example.test", "Second");
    const secondCookie = await webCookie(second.id);
    expect((await registerDevice(OWNER_DEVICE_TOKEN, secondCookie)).statusCode).toBe(204);

    expect(await deps.vouchflowDeviceStore.listTokensByAccount(second.id)).toEqual([
      OWNER_DEVICE_TOKEN,
    ]);
    expect(await deps.vouchflowDeviceStore.listTokensByAccount(accountId)).toEqual([
      OWNER_DEVICE_TOKEN,
    ]);

    // The first account's approvals still settle on that same passkey.
    const reference = await storeCredential({ service: "OpenAI", value: SECRET_VALUE });
    const approval = (await createFetch({ reference })).json() as { approval_id: string };
    const settled = await approve(approval.approval_id);
    expect(settled.statusCode, settled.body).toBe(200);
    expect((await resume(approval.approval_id)).json()).toMatchObject({
      fields: { value: SECRET_VALUE },
    });
  });

  // The human half is sessionless, exactly like the payment approval path:
  // the Telegram link opens in a browser with no Trusty Squire web session,
  // and the Vouchflow passkey assertion is what authenticates the decision.
  it("settles the ceremony with no web session — the signed assertion is the authority", async () => {
    const reference = await storeCredential({ service: "OpenAI", value: SECRET_VALUE });
    const approval = (await createFetch({ reference })).json() as { approval_id: string };

    // The ceremony is readable with no session at all: the payload binds the
    // owning account only through its opaque account_binding, and reading it
    // authorizes nothing.
    const anonymousCeremony = await server.inject({
      method: "GET",
      url: `/v1/vault/fetch-approvals/${approval.approval_id}/ceremony`,
    });
    expect(anonymousCeremony.statusCode).toBe(200);
    const signed = anonymousCeremony.json() as { payload_sha256: string };
    const jws = await signHash(
      signed.payload_sha256,
      CREDENTIAL_FETCH_VOUCH_CONTEXT,
      `mandate_${approval.approval_id}`,
    );

    // An agent token is the requester's authority, never the approver's: it
    // cannot settle anything without an assertion. An unsigned body is not
    // one.
    const agentAttempt = await server.inject({
      method: "POST",
      url: `/v1/vault/fetch-approvals/${approval.approval_id}/approve`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: {},
    });
    expect(agentAttempt.statusCode).toBe(400);
    expect((await resume(approval.approval_id)).json()).toMatchObject({ status: "pending" });

    // The sessionless human half approves, and the value becomes claimable.
    const anonymousApprove = await server.inject({
      method: "POST",
      url: `/v1/vault/fetch-approvals/${approval.approval_id}/approve`,
      payload: { jws },
    });
    expect(anonymousApprove.statusCode).toBe(200);
    const delivered = await resume(approval.approval_id);
    expect((delivered.json() as { fields: Record<string, string> }).fields).toEqual({
      value: SECRET_VALUE,
    });
    expectNoValueAnywhere(anonymousApprove.body);

    // Denial is sessionless too — it is the conservative answer and moves no
    // value.
    const second = (await createFetch({ reference })).json() as { approval_id: string };
    const anonymousDeny = await server.inject({
      method: "POST",
      url: `/v1/vault/fetch-approvals/${second.approval_id}/deny`,
      payload: {},
    });
    expect(anonymousDeny.statusCode).toBe(200);
    expectNoValueAnywhere((await resume(second.approval_id)).body);
  });

  it("settles a lapsed approval as expired rather than logging a denial nobody made", async () => {
    const reference = await storeCredential({ service: "OpenAI", value: SECRET_VALUE });
    const approval = (await createFetch({ reference })).json() as { approval_id: string };
    nowMs += 11 * 60 * 1000;

    const denied = await deny(approval.approval_id);
    expect(denied.statusCode).toBe(409);
    expect(denied.json()).toEqual({ error: "credential_fetch_approval_expired" });

    expect(await revealOutcomes()).toEqual(["expired"]);
    expect((await revealAudit())[0]!.payload).toMatchObject({
      outcome: "expired",
      reference,
      approval_id: approval.approval_id,
    });
    expectNoValueAnywhere((await resume(approval.approval_id)).body);
  });

  it("audits a field set that moved under a signed approval as exactly that, not as success", async () => {
    const reference = await storeCredential({ service: "OpenAI", value: SECRET_VALUE });
    const approval = (await createFetch({ reference })).json() as { approval_id: string };
    expect((await approve(approval.approval_id)).statusCode).toBe(200);

    // A rotation renames the field the human signed for out of existence.
    const rotated = await server.inject({
      method: "POST",
      url: "/v1/vault/credentials",
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { service: "OpenAI", fields: { renamed_value: "sk-live-rotated-and-renamed" } },
    });
    expect(rotated.statusCode).toBe(200);
    expect((rotated.json() as { reference: string }).reference).toBe(reference);

    const delivered = await resume(approval.approval_id);
    expect(delivered.statusCode).toBe(409);
    expect((delivered.json() as { error: string }).error).toBe("credential_fields_changed");
    expectNoValueAnywhere(delivered.body);
    expect(delivered.body).not.toContain("sk-live-rotated-and-renamed");

    expect(await revealOutcomes()).toEqual(["approved", "field_set_changed"]);
  });

  it("audits a credential deleted between approval and claim as a missing credential", async () => {
    const reference = await storeCredential({ service: "OpenAI", value: SECRET_VALUE });
    const approval = (await createFetch({ reference })).json() as { approval_id: string };
    expect((await approve(approval.approval_id)).statusCode).toBe(200);

    await deps.credentialStore.softDelete(reference, new Date(nowMs));

    const delivered = await resume(approval.approval_id);
    expect(delivered.statusCode).toBe(404);
    expectNoValueAnywhere(delivered.body);
    expect(await revealOutcomes()).toEqual(["approved", "missing_credential"]);
  });

  it("audits an internal failure that burned the approval instead of losing it", async () => {
    const reference = await storeCredential({ service: "OpenAI", value: SECRET_VALUE });
    const approval = (await createFetch({ reference })).json() as { approval_id: string };
    expect((await approve(approval.approval_id)).statusCode).toBe(200);

    // The approval is spent the moment the claim lands, so a decrypt/KMS
    // failure after it must still leave a terminal row behind.
    vi.spyOn(deps.vault, "revealForApprovedFetch").mockRejectedValueOnce(new Error("kms wedged"));
    const failed = await resume(approval.approval_id);
    expect(failed.statusCode).toBe(500);
    expectNoValueAnywhere(failed.body);
    expect(await revealOutcomes()).toEqual(["approved", "internal_error"]);

    // …and the burned approval releases nothing afterwards.
    vi.restoreAllMocks();
    const retried = await resume(approval.approval_id);
    expect(retried.statusCode).toBe(409);
    expectNoValueAnywhere(retried.body);
  });

  it("tells caches never to store the delivery", async () => {
    const reference = await storeCredential({ service: "OpenAI", value: SECRET_VALUE });
    const approval = (await createFetch({ reference })).json() as { approval_id: string };
    expect((await approve(approval.approval_id)).statusCode).toBe(200);

    const delivered = await resume(approval.approval_id);
    expect(delivered.statusCode).toBe(200);
    expect(delivered.headers["cache-control"]).toBe("no-store, private");
  });

  it("requires authentication to mint or resume", async () => {
    const reference = await storeCredential({ service: "OpenAI", value: SECRET_VALUE });
    const approval = (await createFetch({ reference })).json() as { approval_id: string };
    expect((await approve(approval.approval_id)).statusCode).toBe(200);

    const anonymousMint = await server.inject({
      method: "POST",
      url: "/v1/vault/fetch-approvals",
      payload: { reference },
    });
    expect(anonymousMint.statusCode).toBe(401);

    const anonymousResume = await server.inject({
      method: "GET",
      url: `/v1/vault/fetch-approvals/${approval.approval_id}`,
    });
    expect(anonymousResume.statusCode).toBe(401);
    expectNoValueAnywhere(anonymousResume.body);
  });
});

// The captain's "keep" list: fetch_credential is an ADDITION, not a change of
// posture. These two paths must still never hand a value to the agent.
describe("the never-exposed paths are unchanged by fetch_credential", () => {
  let server: FastifyInstance;
  let deps: ApiDeps;
  let agentToken: string;
  let dispatchedAuthorization = "";

  beforeEach(async () => {
    dispatchedAuthorization = "";
    const now = new Date("2026-09-05T12:00:00.000Z");
    deps = buildInMemoryDeps({ sessionSecret: SESSION_SECRET, now: () => now });
    server = await buildServer({
      deps,
      proxyExecutor: new HttpProxyExecutor({
        lookup: async () => ({ address: "203.0.113.9", family: 4 }),
        dispatch: async (input) => {
          dispatchedAuthorization = input.headers.authorization ?? "";
          return {
            status: 200,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ok: true }),
            truncated: false,
          };
        },
      }),
    });
    const account = await deps.accountStore.createAccount("keeper@example.test", "Keeper");
    const session = issueAgentSession({
      account_id: account.id,
      agent_identity: "codex",
      agent_version: "test",
      now,
    });
    await deps.agentSessionStore.insert(session.record);
    agentToken = session.raw_token;
  });

  afterEach(async () => {
    await server.close();
  });

  it("use_credential still returns only the upstream response", async () => {
    const stored = await server.inject({
      method: "POST",
      url: "/v1/vault/credentials",
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { service: "OpenAI", value: SECRET_VALUE },
    });
    expect(stored.statusCode).toBe(201);

    const used = await server.inject({
      method: "POST",
      url: "/v1/vault/use",
      headers: { authorization: `Bearer ${agentToken}` },
      payload: {
        service: "OpenAI",
        http: {
          method: "GET",
          url: "https://api.openai.com/v1/models",
          headers: { authorization: "Bearer ${SECRET}" },
        },
      },
    });
    expect(used.statusCode).toBe(200);
    expect(used.body).not.toContain(SECRET_VALUE);
    // The secret went upstream, injected server-side, and came back to
    // nobody: that is exactly the property fetch_credential must not erode.
    expect(dispatchedAuthorization).toBe(`Bearer ${SECRET_VALUE}`);
  });

  it("the agent store path (extract { store }) still returns metadata only", async () => {
    const stored = await server.inject({
      method: "POST",
      url: "/v1/vault/credentials",
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { service: "Resend", value: SECRET_VALUE },
    });
    expect(stored.statusCode).toBe(201);
    expect(stored.body).not.toContain(SECRET_VALUE);
    expect(stored.json()).not.toHaveProperty("value");
    expect(stored.json()).not.toHaveProperty("fields");

    // Listing credentials is metadata-only, before and after a fetch exists.
    const listed = await server.inject({
      method: "GET",
      url: "/v1/vault/credentials",
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.body).not.toContain(SECRET_VALUE);
  });
});
