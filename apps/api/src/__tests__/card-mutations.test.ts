import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { InMemoryVaultAuditStore, VAULT_AUDIT_TYPES } from "@trusty-squire/vault";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { issueAgentSession } from "../auth/agent.js";
import { issueSession, SESSION_COOKIE_NAME, signSessionJwt } from "../auth/session.js";
import { cardMutationPayload } from "../routes/card-mutations.js";
import { buildInMemoryDeps, type ApiDeps } from "../services/deps.js";
import { InMemoryCardMutationApprovalStore } from "../services/card-mutation-approval-store.js";
import {
  CREDENTIAL_MUTATION_VOUCH_CONTEXT,
  createVouchMandateVerifier,
  hashVouchPayload,
  type VouchMandateVerifier,
} from "../services/vouch-mandate.js";
import { buildServer } from "../server.js";

const SESSION_SECRET = "card-mutation-test-session-secret";
const AUDIENCE = "card-mutation-test-customer";

type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

// Opaque sealed-blob stand-in. The server stores it verbatim; only the
// owner's browser can decrypt it, so tests never need a real ciphertext.
const ORIGINAL_BLOB = JSON.stringify({
  v: 1,
  cipher: "aes-256-gcm",
  iv: "original-iv",
  ct: "original-ct",
  prf_salt: "c3ludGhldGljLXNhbHQ",
});

describe("vouch-gated card mutations", () => {
  let server: FastifyInstance;
  let deps: ApiDeps;
  let nowMs: number;
  let agentToken: string;
  let accountId: string;
  let webCookie: string;
  let signingKey: SigningKey;
  let vouchVerifier: VouchMandateVerifier;

  beforeEach(async () => {
    nowMs = Date.parse("2026-08-22T12:00:00.000Z");
    vi.stubEnv("VOUCHFLOW_CUSTOMER_ID", AUDIENCE);
    const keys = await generateKeyPair("ES256");
    signingKey = keys.privateKey;
    const publicJwk = await exportJWK(keys.publicKey);
    publicJwk.kid = "card-mutation-test-key";
    deps = buildInMemoryDeps({
      sessionSecret: SESSION_SECRET,
      now: () => new Date(nowMs),
    });
    vouchVerifier = createVouchMandateVerifier(
      async () => Response.json({ keys: [publicJwk] }),
      "https://vouchflow.test",
    );
    server = await buildServer({ deps, vouchVerifier });
    const account = await deps.accountStore.createAccount("carditor@example.test", "Carditor");
    accountId = account.id;
    const session = issueAgentSession({
      account_id: account.id,
      agent_identity: "codex",
      agent_version: "test",
      now: new Date(nowMs),
    });
    await deps.agentSessionStore.insert(session.record);
    agentToken = session.raw_token;
    const webSession = issueSession({
      account_id: account.id,
      ip: null,
      user_agent: null,
      now: new Date(nowMs),
    });
    await deps.sessionStore.insert(webSession.record);
    webCookie = `${SESSION_COOKIE_NAME}=${signSessionJwt(webSession.jwt, SESSION_SECRET)}`;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await server.close();
  });

  async function storeCard(
    label = "Personal card",
    blob = ORIGINAL_BLOB,
    brand: string | null = "Visa",
    last4: string | null = "4242",
  ): Promise<string> {
    const response = await server.inject({
      method: "POST",
      url: "/v1/vault/e2e",
      headers: { cookie: webCookie },
      payload: {
        label,
        blob,
        ...(brand !== null ? { brand } : {}),
        ...(last4 !== null ? { last4 } : {}),
      },
    });
    expect(response.statusCode).toBe(201);
    return (response.json() as { id: string }).id;
  }

  async function createMutation(payload: Record<string, unknown>) {
    return await server.inject({
      method: "POST",
      url: "/v1/vault/card-mutation-approvals",
      headers: {
        authorization: `Bearer ${agentToken}`,
        "x-squire-agent-identity": "Codex",
      },
      payload,
    });
  }

  async function cardCeremony(id: string, cookie = webCookie) {
    const response = await server.inject({
      method: "GET",
      url: `/v1/vault/card-mutation-approvals/${id}/ceremony`,
      headers: { cookie },
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json() as {
      payload: unknown;
      payload_sha256: string;
      blob: string;
      operation: "edit_card";
    };
  }

  async function signHash(
    hash: string,
    context: string,
    mandateId: string,
    expiration: string | number = "10m",
  ): Promise<string> {
    return await new SignJWT({
      context,
      payload_sha256: hash,
      confidence: "low",
      mandate_id: mandateId,
    })
      .setProtectedHeader({ alg: "ES256", kid: "card-mutation-test-key" })
      .setIssuer("https://vouchflow.dev")
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(expiration)
      .sign(signingKey);
  }

  // Mirrors the ceremony page: take the ceremony payload (after = null),
  // swap in the edited card as mutation.after, sign, and submit the new
  // opaque blob with re-derived display metadata.
  async function approveCard(
    id: string,
    after: { label: string; blob?: string; brand?: string; last4?: string },
    context = CREDENTIAL_MUTATION_VOUCH_CONTEXT,
  ) {
    const ceremony = await cardCeremony(id);
    const payload = ceremony.payload as { mutation: Record<string, unknown> };
    const fullPayload = {
      ...payload,
      mutation: {
        ...payload.mutation,
        // The server re-derives `after` with brand/last4 ALWAYS present
        // (null when the browser omitted them), so the page signs exactly
        // that shape.
        after: {
          label: after.label,
          blob: after.blob ?? ceremony.blob,
          brand: after.brand ?? null,
          last4: after.last4 ?? null,
        },
      },
    };
    const jws = await signHash(
      hashVouchPayload(fullPayload).toString("base64url"),
      context,
      `mandate_${id}`,
    );
    return await server.inject({
      method: "POST",
      url: `/v1/vault/card-mutation-approvals/${id}/approve`,
      headers: { cookie: webCookie },
      payload: {
        jws,
        blob: after.blob ?? ceremony.blob,
        label: after.label,
        ...(after.brand !== undefined ? { brand: after.brand } : {}),
        ...(after.last4 !== undefined ? { last4: after.last4 } : {}),
      },
    });
  }

  async function captureTelegramMessages(): Promise<string[]> {
    const messages: string[] = [];
    await deps.accountStore.setTelegramChatId(accountId, "123456789");
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "synthetic-telegram-token");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { text: string };
        messages.push(body.text);
        return Response.json({ ok: true });
      }),
    );
    return messages;
  }

  it("binds ceremony and settlement to the owner web account and never exposes the blob to the agent", async () => {
    const cardId = await storeCard();
    const created = await createMutation({ operation: "edit_card", card_id: cardId });
    expect(created.statusCode, created.body).toBe(201);
    const approval = created.json() as {
      approval_id: string;
      card: { id: string; label: string };
    };
    expect(created.body).not.toContain("original-ct");
    expect(approval.card).toMatchObject({ id: cardId, label: "Personal card" });

    // The agent can poll status but can NEVER open the ceremony (the only
    // place the sealed blob is disclosed).
    const agentCeremony = await server.inject({
      method: "GET",
      url: `/v1/vault/card-mutation-approvals/${approval.approval_id}/ceremony`,
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(agentCeremony.statusCode).toBe(401);

    const ceremony = await cardCeremony(approval.approval_id);
    expect(ceremony.blob).toBe(ORIGINAL_BLOB);
    expect(ceremony.payload).toMatchObject({
      account_binding: createHash("sha256")
        .update("trusty-squire/card-mutation/account/v1\n")
        .update(accountId)
        .digest("base64url"),
      mutation: { operation: "card.edit_card", after: null },
    });

    const intruder = await deps.accountStore.createAccount("intruder@example.test", "Intruder");
    const intruderSession = issueSession({
      account_id: intruder.id,
      ip: null,
      user_agent: null,
      now: new Date(nowMs),
    });
    await deps.sessionStore.insert(intruderSession.record);
    const intruderCookie = `${SESSION_COOKIE_NAME}=${signSessionJwt(
      intruderSession.jwt,
      SESSION_SECRET,
    )}`;
    const foreignCeremony = await server.inject({
      method: "GET",
      url: `/v1/vault/card-mutation-approvals/${approval.approval_id}/ceremony`,
      headers: { cookie: intruderCookie },
    });
    expect(foreignCeremony.statusCode).toBe(404);
    const foreignApprove = await server.inject({
      method: "POST",
      url: `/v1/vault/card-mutation-approvals/${approval.approval_id}/approve`,
      headers: { cookie: intruderCookie },
      payload: { jws: "synthetic", blob: "synthetic", label: "synthetic" },
    });
    expect(foreignApprove.statusCode).toBe(404);

    const agentPoll = await server.inject({
      method: "GET",
      url: `/v1/vault/card-mutation-approvals/${approval.approval_id}`,
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(agentPoll.statusCode).toBe(200);
    expect(agentPoll.body).not.toContain("original-ct");
    expect(await deps.e2eCredentialStore.getByIdForAccount(cardId, accountId)).not.toBeNull();
  });

  it("replaces only the sealed blob after a valid signed vouch", async () => {
    const cardId = await storeCard();
    const created = await createMutation({ operation: "edit_card", card_id: cardId });
    expect(created.statusCode).toBe(201);
    const id = (created.json() as { approval_id: string }).approval_id;

    // Creating/polling an approval is not authority to mutate.
    expect((await deps.e2eCredentialStore.getByIdForAccount(cardId, accountId))?.blob).toBe(
      ORIGINAL_BLOB,
    );
    const unsigned = await server.inject({
      method: "POST",
      url: `/v1/vault/card-mutation-approvals/${id}/approve`,
      headers: { cookie: webCookie },
      payload: {},
    });
    expect(unsigned.statusCode).toBe(400);
    const badSignature = await server.inject({
      method: "POST",
      url: `/v1/vault/card-mutation-approvals/${id}/approve`,
      headers: { cookie: webCookie },
      payload: { jws: "not.a.valid-jws", blob: "new-blob", label: "x" },
    });
    expect(badSignature.statusCode).toBe(403);
    expect((await deps.e2eCredentialStore.getByIdForAccount(cardId, accountId))?.blob).toBe(
      ORIGINAL_BLOB,
    );

    // Signing the CEREMONY payload (after = null) must not authorize the
    // edit — the mandate must cover the exact new blob the server stores.
    const ceremony = await cardCeremony(id);
    const staleJws = await signHash(
      ceremony.payload_sha256,
      CREDENTIAL_MUTATION_VOUCH_CONTEXT,
      `mandate_${id}`,
    );
    const stale = await server.inject({
      method: "POST",
      url: `/v1/vault/card-mutation-approvals/${id}/approve`,
      headers: { cookie: webCookie },
      payload: { jws: staleJws, blob: ceremony.blob, label: "Personal card" },
    });
    expect(stale.statusCode).toBe(403);
    expect((await deps.e2eCredentialStore.getByIdForAccount(cardId, accountId))?.blob).toBe(
      ORIGINAL_BLOB,
    );

    const newBlob = JSON.stringify({
      v: 1,
      cipher: "aes-256-gcm",
      iv: "edited-iv",
      ct: "edited-ct",
      prf_salt: "c3ludGhldGljLXNhbHQ",
    });
    const approved = await approveCard(id, {
      label: "Travel card",
      blob: newBlob,
      brand: "Mastercard",
      last4: "9999",
    });
    expect(approved.statusCode).toBe(200);
    const card = await deps.e2eCredentialStore.getByIdForAccount(cardId, accountId);
    expect(card?.blob).toBe(newBlob);
    expect(card).toMatchObject({ label: "Travel card", brand: "Mastercard", last4: "9999" });

    // The status surface keeps the blob sealed; display metadata only.
    const status = await server.inject({
      method: "GET",
      url: `/v1/vault/card-mutation-approvals/${id}`,
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(status.statusCode).toBe(200);
    expect(status.body).not.toContain("edited-ct");
    expect(status.json()).toMatchObject({
      status: "approved",
      operation: "edit_card",
      card: { id: cardId, label: "Travel card", brand: "Mastercard", last4: "9999" },
    });

    // A stale-registered PAN cannot hide in the display metadata.
    const panInjection = await createMutation({ operation: "edit_card", card_id: cardId });
    const panId = (panInjection.json() as { approval_id: string }).approval_id;
    const panApproved = await approveCard(panId, {
      label: "4242424242424242",
      blob: newBlob,
      brand: "4242424242424242",
      last4: "9999",
    });
    expect(panApproved.statusCode).toBe(400);
    expect((await deps.e2eCredentialStore.getByIdForAccount(cardId, accountId))?.label).toBe(
      "Travel card",
    );
  });

  it("resolves the card by id or exact label, and reports missing and ambiguous labels", async () => {
    const id = await storeCard("prod");
    await storeCard("dev");

    const byId = await createMutation({ operation: "edit_card", card_id: id });
    expect(byId.statusCode).toBe(201);
    expect((byId.json() as { card: { id: string } }).card.id).toBe(id);

    const byLabel = await createMutation({ operation: "edit_card", label: "prod" });
    // Same card, same intent: the pending approval is reused, not duplicated.
    expect(byLabel.statusCode).toBe(200);
    expect((byLabel.json() as { card: { id: string }; approval_id: string }).approval_id).toBe(
      (byId.json() as { approval_id: string }).approval_id,
    );

    const ambiguous = await storeCard("prod");
    const duplicate = await createMutation({ operation: "edit_card", label: "prod" });
    expect(duplicate.statusCode).toBe(409);
    const duplicateBody = duplicate.json() as { error: string; candidates: unknown[] };
    expect(duplicateBody.error).toBe("ambiguous_card");
    expect(duplicateBody.candidates).toHaveLength(2);

    const missing = await createMutation({ operation: "edit_card", card_id: "card_missing" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "card_not_found" });
    void ambiguous;
  });

  it("requires a body selector and rejects unknown fields", async () => {
    const cardId = await storeCard();
    const noSelector = await createMutation({ operation: "edit_card" });
    expect(noSelector.statusCode).toBe(400);
    const unknownField = await createMutation({
      operation: "edit_card",
      card_id: cardId,
      after: { label: "x" },
    });
    expect(unknownField.statusCode).toBe(400);
    const badOperation = await createMutation({ operation: "delete_card", card_id: cardId });
    expect(badOperation.statusCode).toBe(400);
  });

  it("repeats an approved approval idempotently and refuses invalid retries", async () => {
    const cardId = await storeCard();
    const created = await createMutation({ operation: "edit_card", card_id: cardId });
    const id = (created.json() as { approval_id: string }).approval_id;
    const approved = await approveCard(id, { label: "Renamed", last4: "4242" });
    expect(approved.statusCode).toBe(200);
    const after = await deps.e2eCredentialStore.getByIdForAccount(cardId, accountId);
    expect(after?.label).toBe("Renamed");

    const repeated = await approveCard(id, { label: "Renamed", last4: "4242" });
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json()).toEqual({ status: "approved", operation: "edit_card" });
    expect((await deps.e2eCredentialStore.getByIdForAccount(cardId, accountId))?.label).toBe(
      "Renamed",
    );

    const invalidRetry = await server.inject({
      method: "POST",
      url: `/v1/vault/card-mutation-approvals/${id}/approve`,
      headers: { cookie: webCookie },
      payload: { jws: "not.a.valid-jws", blob: "x", label: "Renamed" },
    });
    expect(invalidRetry.statusCode).toBe(403);
  });

  it("fails closed after expiry and when the card changed before execution", async () => {
    const cardId = await storeCard();
    const expiredCreated = await createMutation({ operation: "edit_card", card_id: cardId });
    const expiredId = (expiredCreated.json() as { approval_id: string }).approval_id;
    nowMs += 11 * 60 * 1000;
    const expired = await approveCard(expiredId, { label: "too late" });
    expect(expired.statusCode).toBe(409);
    expect(expired.json()).toEqual({ error: "card_mutation_approval_expired" });
    expect((await deps.e2eCredentialStore.getByIdForAccount(cardId, accountId))?.label).toBe(
      "Personal card",
    );

    nowMs -= 11 * 60 * 1000;
    const editCreated = await createMutation({ operation: "edit_card", card_id: cardId });
    const editId = (editCreated.json() as { approval_id: string }).approval_id;
    // The card changed under the pending approval (e.g. the owner renamed it
    // through the wallet): the stale approval must not overwrite it.
    await deps.e2eCredentialStore.updateLabelForAccount(cardId, accountId, "Drifted");
    const drifted = await approveCard(editId, { label: "stale edit" });
    expect(drifted.statusCode).toBe(409);
    expect(drifted.json()).toEqual({ error: "card_changed" });
    expect((await deps.e2eCredentialStore.getByIdForAccount(cardId, accountId))?.label).toBe(
      "Drifted",
    );
    expect((await deps.cardMutationApprovalStore.getById(editId))?.failureCode).toBe(
      "card_changed",
    );
  });

  it("keeps the ledger complete: audit event written, rolled back if it fails", async () => {
    const cardId = await storeCard();
    const created = await createMutation({ operation: "edit_card", card_id: cardId });
    const id = (created.json() as { approval_id: string }).approval_id;
    expect((await approveCard(id, { label: "Audited", last4: "4242" })).statusCode).toBe(200);
    const audits = await deps.vaultAuditStore.list(accountId, {
      type: VAULT_AUDIT_TYPES.cardUpdated,
      reference: `card://${cardId}`,
    });
    const event = audits.find((entry) => entry.payload.approval_id === id);
    expect(event?.payload.requester).toBe("agent");
    expect(event?.payload.label).toBe("Audited");
    // Display metadata only — never a card value.
    expect(JSON.stringify(event?.payload)).not.toContain("original-ct");

    await server.close();
    const audit = new InMemoryVaultAuditStore(() => new Date(nowMs));
    const originalRecord = audit.record.bind(audit);
    let failCardAudit = true;
    audit.record = async (entry) => {
      if (failCardAudit && entry.type === VAULT_AUDIT_TYPES.cardUpdated) {
        failCardAudit = false;
        throw new Error("synthetic audit outage");
      }
      await originalRecord(entry);
    };
    deps.vaultAuditStore = audit;
    deps.cardMutationApprovalStore = new InMemoryCardMutationApprovalStore(
      deps.e2eCredentialStore,
      audit,
      () => new Date(nowMs),
    );
    server = await buildServer({ deps, vouchVerifier });
    const retryCreated = await createMutation({ operation: "edit_card", card_id: cardId });
    const retryId = (retryCreated.json() as { approval_id: string }).approval_id;
    const first = await approveCard(retryId, { label: "Recovered" });
    expect(first.statusCode).toBe(500);
    expect((await deps.e2eCredentialStore.getByIdForAccount(cardId, accountId))?.label).toBe(
      "Audited",
    );
    expect((await deps.cardMutationApprovalStore.getById(retryId))?.status).toBe("pending");

    const retried = await approveCard(retryId, { label: "Recovered" });
    expect(retried.statusCode).toBe(200);
    expect((await deps.cardMutationApprovalStore.getById(retryId))?.status).toBe("approved");
    expect((await deps.e2eCredentialStore.getByIdForAccount(cardId, accountId))?.label).toBe(
      "Recovered",
    );
    const recoveredAudits = await deps.vaultAuditStore.list(accountId, {
      type: VAULT_AUDIT_TYPES.cardUpdated,
      reference: `card://${cardId}`,
    });
    expect(
      recoveredAudits.filter((entry) => entry.payload.approval_id === retryId),
    ).toHaveLength(1);
  });

  it("sends card edit approval metadata and an explicit browser link to Telegram", async () => {
    const cardId = await storeCard("Personal card");
    const messages = await captureTelegramMessages();
    const created = await createMutation({ operation: "edit_card", card_id: cardId });
    expect(created.statusCode).toBe(201);
    const id = (created.json() as { approval_id: string }).approval_id;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("approve card edit");
    expect(messages[0]).toContain("Personal card •••• 4242");
    expect(messages[0]).toContain(
      `Review exact details: https://trustysquire.ai/vault/mutate-card/${id}`,
    );
    // No card value can appear in the notification.
    expect(messages[0]).not.toContain("original-ct");
  });

  it("does not reuse a pending approval across requesting agents", async () => {
    const cardId = await storeCard();
    const first = await createMutation({ operation: "edit_card", card_id: cardId });
    const secondSession = issueAgentSession({
      account_id: accountId,
      agent_identity: "claude",
      agent_version: "test",
      now: new Date(nowMs),
    });
    await deps.agentSessionStore.insert(secondSession.record);
    const second = await server.inject({
      method: "POST",
      url: "/v1/vault/card-mutation-approvals",
      headers: {
        authorization: `Bearer ${secondSession.raw_token}`,
        "x-squire-agent-identity": "Claude",
      },
      payload: { operation: "edit_card", card_id: cardId },
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    const firstId = (first.json() as { approval_id: string }).approval_id;
    const secondId = (second.json() as { approval_id: string }).approval_id;
    expect(secondId).not.toBe(firstId);
    expect((await deps.cardMutationApprovalStore.getById(firstId))?.agent).toBe("codex");
    expect((await deps.cardMutationApprovalStore.getById(secondId))?.agent).toBe("claude");
  });

  it("reuses a pending approval for the identical card edit intent", async () => {
    const cardId = await storeCard();
    const first = await createMutation({ operation: "edit_card", card_id: cardId });
    const second = await createMutation({ operation: "edit_card", card_id: cardId });
    const firstId = (first.json() as { approval_id: string }).approval_id;
    const secondId = (second.json() as { approval_id: string }).approval_id;
    expect(second.statusCode).toBe(200);
    expect(secondId).toBe(firstId);
  });

  it("rechecks approval expiry after mandate verification", async () => {
    const cardId = await storeCard();
    const created = await createMutation({ operation: "edit_card", card_id: cardId });
    const id = (created.json() as { approval_id: string }).approval_id;
    await server.close();
    server = await buildServer({
      deps,
      vouchVerifier: async () => {
        nowMs += 11 * 60 * 1000;
        return { mandate_id: "mandate_slow_verification" };
      },
    });
    const ceremony = await cardCeremony(id);
    const payload = ceremony.payload as { mutation: Record<string, unknown> };
    const fullPayload = {
      ...payload,
      mutation: { ...payload.mutation, after: { label: "late", blob: ceremony.blob } },
    };
    const jws = await signHash(
      hashVouchPayload(fullPayload).toString("base64url"),
      CREDENTIAL_MUTATION_VOUCH_CONTEXT,
      "mandate_slow_verification",
    );
    const response = await server.inject({
      method: "POST",
      url: `/v1/vault/card-mutation-approvals/${id}/approve`,
      headers: { cookie: webCookie },
      payload: { jws, blob: ceremony.blob, label: "late" },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "card_mutation_approval_expired" });
    expect((await deps.e2eCredentialStore.getByIdForAccount(cardId, accountId))?.label).toBe(
      "Personal card",
    );
  });

  it("round-trips the exact payload the ceremony page re-signs", async () => {
    const cardId = await storeCard();
    const created = await createMutation({ operation: "edit_card", card_id: cardId });
    const id = (created.json() as { approval_id: string }).approval_id;
    const ceremony = await cardCeremony(id);
    const stored = await deps.cardMutationApprovalStore.getById(id);
    expect(stored).not.toBeNull();
    const emptyHash = hashVouchPayload(cardMutationPayload(stored!, null)).toString("base64url");
    expect(emptyHash).toBe(ceremony.payload_sha256);

    const after = { label: "Round", blob: "round-trip-blob", brand: "Visa", last4: "4242" };
    const fullHash = hashVouchPayload(cardMutationPayload(stored!, after)).toString("base64url");
    const jws = await signHash(fullHash, CREDENTIAL_MUTATION_VOUCH_CONTEXT, `mandate_${id}`);
    const approved = await server.inject({
      method: "POST",
      url: `/v1/vault/card-mutation-approvals/${id}/approve`,
      headers: { cookie: webCookie },
      payload: { jws, blob: after.blob, label: after.label, brand: after.brand, last4: after.last4 },
    });
    expect(approved.statusCode).toBe(200);
    expect((await deps.e2eCredentialStore.getByIdForAccount(cardId, accountId))?.blob).toBe(
      "round-trip-blob",
    );
  });
});
