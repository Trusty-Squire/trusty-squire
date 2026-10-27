// The kind-agnostic approval surface: the approval card an app draws, the
// deny an app sends, and the signed decision webhook. The app is exactly the
// party the vault keeps out, so every payload here is also checked for the
// things it must never carry: secret values, card data, mandates, nonces.

import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { verifyWebhook, WebhookVerificationError } from "@trusty-squire/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { issueAgentSession } from "../auth/agent.js";
import { issueSession, SESSION_COOKIE_NAME, signSessionJwt } from "../auth/session.js";
import { buildInMemoryDeps, type ApiDeps } from "../services/deps.js";
import { buildServer } from "../server.js";
import {
  paymentApprovalStatus,
  readApprovalCard,
  type ApprovalCard,
} from "../services/approval-card.js";
import {
  APPROVAL_WEBHOOK_BACKOFF_MS,
  ApprovalWebhookService,
  createApprovalWebhookPoster,
  InMemoryApprovalWebhookStore,
  validateApprovalWebhookUrl,
  type ApprovalWebhookPoster,
} from "../services/approval-webhooks.js";
import type { PendingPaymentApprovalRecord } from "../services/in-memory-payment-approval-store.js";

const SESSION_SECRET = "approvals-test-session-secret";
const SECRET_VALUE = "sk-live-approval-card-must-never-carry-this";
const OPERATOR_PUBKEY = "c3ludGhldGljLW9wZXJhdG9yLWtleQ";
const CARD_BLOB = '{ "ciphertext": "sealed-card-bytes-never-in-a-card" }';
const WEB = "https://trustysquire.ai";

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: string;
}

describe("approval cards, host-app deny, and decision webhooks", () => {
  let server: FastifyInstance;
  let deps: ApiDeps;
  let store: InMemoryApprovalWebhookStore;
  let nowMs: number;
  let accountId: string;
  let agentToken: string;
  let secondSessionToken: string;
  let otherAccountToken: string;
  let webCookie: string;
  let sent: Sent[];
  let respond: (call: Sent) => number;

  beforeEach(async () => {
    vi.stubEnv("PWA_BASE_URL", WEB);
    nowMs = Date.parse("2026-10-27T12:00:00.000Z");
    deps = buildInMemoryDeps({ sessionSecret: SESSION_SECRET, now: () => new Date(nowMs) });
    sent = [];
    respond = () => 200;
    store = new InMemoryApprovalWebhookStore(() => new Date(nowMs));
    const post: ApprovalWebhookPoster = async (input) => {
      const call = { url: input.url, headers: input.headers, body: input.body };
      sent.push(call);
      return { status: respond(call) };
    };
    deps.approvalWebhookStore = store;
    deps.approvalWebhooks = new ApprovalWebhookService({
      store,
      readCard: (account, id, kind) =>
        readApprovalCard(deps, account, id, new Date(nowMs), kind),
      signingKey: SESSION_SECRET,
      now: () => new Date(nowMs),
      post,
    });
    server = await buildServer({ deps, vouchVerifier: async () => ({}) });
    const account = await deps.accountStore.createAccount("owner@example.test", "Owner");
    const other = await deps.accountStore.createAccount("other@example.test", "Other");
    accountId = account.id;
    agentToken = await agentSession(account.id, "Beeline");
    secondSessionToken = await agentSession(account.id, "Another app");
    otherAccountToken = await agentSession(other.id, "Stranger");
    webCookie = await webSession(account.id);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await server.close();
  });

  async function agentSession(account: string, identity: string): Promise<string> {
    const session = issueAgentSession({
      account_id: account,
      agent_identity: identity,
      agent_version: "test",
      now: new Date(nowMs),
    });
    await deps.agentSessionStore.insert(session.record);
    return session.raw_token;
  }

  async function webSession(account: string): Promise<string> {
    const { record, jwt } = issueSession({
      account_id: account,
      ip: null,
      user_agent: null,
      now: new Date(nowMs),
    });
    await deps.sessionStore.insert(record);
    return `${SESSION_COOKIE_NAME}=${signSessionJwt(jwt, SESSION_SECRET)}`;
  }

  async function call(
    method: "GET" | "POST" | "PUT" | "DELETE",
    url: string,
    payload?: Record<string, unknown>,
    token = agentToken,
  ) {
    return await server.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}`, "x-squire-agent-identity": "Ruby" },
      ...(payload !== undefined ? { payload } : {}),
    });
  }

  async function storeCredential(service = "stripe"): Promise<string> {
    const response = await call("POST", "/v1/vault/credentials", {
      service,
      value: SECRET_VALUE,
    });
    expect(response.statusCode).toBe(201);
    return (response.json() as { reference: string }).reference;
  }

  async function storeCard(): Promise<string> {
    const response = await server.inject({
      method: "POST",
      url: "/v1/vault/e2e",
      headers: { cookie: webCookie },
      payload: { label: "Visa", blob: CARD_BLOB, brand: "visa", last4: "4242" },
    });
    expect(response.statusCode).toBe(201);
    return (response.json() as { id: string }).id;
  }

  async function requestPayment(cardRef: string, token = agentToken) {
    const response = await call(
      "POST",
      "/v1/pay/approvals",
      {
        merchant: "whitejade.xyz",
        checkout_origin: "https://whitejade.xyz",
        amount_cents: 3800,
        currency: "USD",
        card_ref: cardRef,
        operator_pubkey: OPERATOR_PUBKEY,
        item: "Glow Serum x1",
        reason: "Glow Serum x1, standard shipping",
      },
      token,
    );
    expect(response.statusCode).toBe(201);
    return response.json() as { id: string; nonce: string; account_binding: string; approval: ApprovalCard };
  }

  async function requestReveal(token = agentToken) {
    await storeCredential();
    const response = await call(
      "POST",
      "/v1/vault/fetch-approvals",
      { service: "stripe", reason: "deploy the billing worker" },
      token,
    );
    expect(response.statusCode).toBe(201);
    return response.json() as { approval_id: string; approval: ApprovalCard };
  }

  async function requestEdit() {
    await storeCredential("github");
    const response = await call("POST", "/v1/vault/mutation-approvals", {
      operation: "edit",
      service: "github",
      changes: { allowed_hosts: { mode: "add", hosts: ["uploads.github.com"] } },
    });
    expect(response.statusCode).toBe(201);
    return response.json() as { approval_id: string; approval: ApprovalCard };
  }

  async function requestDelete() {
    await storeCredential("github");
    const response = await call("POST", "/v1/vault/mutation-approvals", {
      operation: "delete",
      service: "github",
    });
    expect(response.statusCode).toBe(201);
    return response.json() as { approval_id: string; approval: ApprovalCard };
  }

  async function requestCardEdit() {
    const cardId = await storeCard();
    const response = await call("POST", "/v1/vault/card-mutation-approvals", {
      operation: "edit_card",
      card_id: cardId,
    });
    expect(response.statusCode).toBe(201);
    return response.json() as { approval_id: string; approval: ApprovalCard };
  }

  async function readCard(id: string, token = agentToken) {
    return await call("GET", `/v1/approvals/${id}`, undefined, token);
  }

  async function register(url = "https://app.example.test/squire/webhook", token = agentToken) {
    const response = await call("PUT", "/v1/approval-webhook", { url }, token);
    expect(response.statusCode).toBe(200);
    return response.json() as { url: string; secret: string; created_at: string };
  }

  async function settle(): Promise<void> {
    await deps.approvalWebhooks.tick();
  }

  // Every string the app must never see from a card or an event.
  function expectNoSecrets(text: string, extra: string[] = []): void {
    for (const forbidden of [
      SECRET_VALUE,
      OPERATOR_PUBKEY,
      "sealed-card-bytes",
      "sealed_card",
      "\"jws\"",
      "\"nonce\"",
      "account_binding",
      "\"blob\"",
      "\"fields\"",
      ...extra,
    ]) {
      expect(text).not.toContain(forbidden);
    }
  }

  function expectCardShape(card: ApprovalCard): void {
    expect(Object.keys(card).sort()).toEqual(
      [
        "action",
        "approve_url",
        "created_at",
        "details",
        "expires_at",
        "id",
        "kind",
        "reason",
        "requested_by",
        "status",
        "title",
      ].sort(),
    );
    expect(card.title.length).toBeGreaterThan(0);
    expect(card.details.length).toBeGreaterThan(0);
    for (const detail of card.details) expect(Object.keys(detail).sort()).toEqual(["label", "value"]);
    expect(Date.parse(card.expires_at)).toBeGreaterThan(nowMs);
  }

  describe("approval card payload, per kind", () => {
    it("payment: amount, merchant, card by label and last four, reason", async () => {
      const cardRef = await storeCard();
      const created = await requestPayment(cardRef);
      expectCardShape(created.approval);
      expect(created.approval).toMatchObject({
        id: created.id,
        kind: "payment",
        action: "pay",
        title: "Pay USD 38.00 to whitejade.xyz",
        status: "pending",
        // Payments name the session's registered agent identity.
        requested_by: "Beeline",
        reason: "Glow Serum x1, standard shipping",
        approve_url: `${WEB}/vault/pay/${created.id}`,
      });
      expect(created.approval.details).toEqual([
        { label: "Amount", value: "USD 38.00" },
        { label: "Merchant", value: "whitejade.xyz" },
        { label: "Card", value: "Visa ··4242" },
        { label: "Item", value: "Glow Serum x1" },
        { label: "Requested by", value: "Beeline" },
      ]);
      const read = await readCard(created.id);
      expect(read.statusCode).toBe(200);
      expect(read.json().approval).toEqual(created.approval);
      expectNoSecrets(read.body, [created.nonce, created.account_binding]);
    });

    it("credential fetch: names the key and fields, never the value", async () => {
      const created = await requestReveal();
      expectCardShape(created.approval);
      expect(created.approval).toMatchObject({
        kind: "credential_fetch",
        action: "reveal",
        title: "Reveal key: stripe / default",
        reason: "deploy the billing worker",
        approve_url: `${WEB}/vault/fetch/${created.approval_id}`,
      });
      expect(created.approval.details).toContainEqual({ label: "Fields", value: "value" });
      const read = await readCard(created.approval_id);
      expect(read.json().approval).toEqual(created.approval);
      expectNoSecrets(read.body);
    });

    it("credential edit: shows exactly what changes", async () => {
      const created = await requestEdit();
      expectCardShape(created.approval);
      expect(created.approval).toMatchObject({
        kind: "credential_mutation",
        action: "edit",
        title: "Edit key: github / default",
        approve_url: `${WEB}/vault/mutate/${created.approval_id}`,
      });
      const hosts = created.approval.details.find((detail) => detail.label === "Allowed hosts");
      expect(hosts?.value).toMatch(/→ .*uploads\.github\.com/);
      expectNoSecrets(JSON.stringify(created.approval));
    });

    it("credential delete: says the key is deleted", async () => {
      const created = await requestDelete();
      expectCardShape(created.approval);
      expect(created.approval).toMatchObject({
        kind: "credential_mutation",
        action: "delete",
        title: "Delete key: github / default",
      });
      expect(created.approval.details).toContainEqual({
        label: "Effect",
        value: "The key is deleted from the vault.",
      });
    });

    it("card edit: label and last four only", async () => {
      const created = await requestCardEdit();
      expectCardShape(created.approval);
      expect(created.approval).toMatchObject({
        kind: "card_mutation",
        action: "edit_card",
        title: "Edit card: Visa ··4242",
        approve_url: `${WEB}/vault/mutate-card/${created.approval_id}`,
      });
      expectNoSecrets(JSON.stringify(created.approval));
    });

    it("is invisible to another account", async () => {
      const created = await requestDelete();
      const read = await readCard(created.approval_id, otherAccountToken);
      expect(read.statusCode).toBe(404);
      const deny = await call("POST", `/v1/approvals/${created.approval_id}/deny`, {}, otherAccountToken);
      expect(deny.statusCode).toBe(404);
    });

    it("keeps approved apart from done for payments", async () => {
      const cardRef = await storeCard();
      const created = await requestPayment(cardRef);
      const candidate = { jws: "jws.payload.sig", sealedCard: "sealed", fingerprint: "fp" };
      const expiresAt = new Date(Date.parse(created.approval.expires_at));
      await deps.pendingPaymentApprovalStore.submitCandidate(
        created.id,
        accountId,
        candidate,
        expiresAt,
        new Date(nowMs),
      );
      expect((await readCard(created.id)).json().approval.status).toBe("approved");
      await deps.pendingPaymentApprovalStore.getRelayCandidateForAccount(created.id, accountId, new Date(nowMs));
      expect((await readCard(created.id)).json().approval.status).toBe("processing");
      await deps.pendingPaymentApprovalStore.confirmCandidateForAccount(created.id, accountId, "fp", new Date(nowMs));
      expect((await readCard(created.id)).json().approval.status).toBe("processing");
      const audit = await call("POST", "/v1/vault/payments/audit", {
        merchant: "whitejade.xyz",
        amountCents: 3800,
        currency: "USD",
        last4: "4242",
        status: "merchant_order_confirmed",
        approvalId: created.id,
      });
      expect(audit.statusCode).toBe(201);
      const done = await readCard(created.id);
      expect(done.json().approval.status).toBe("completed");
      expectNoSecrets(done.body, ["jws.payload.sig"]);
    });

    it("reports a signed payment whose checkout never ran as failed, an unsigned one as expired", () => {
      const base = {
        status: "pending",
        submissionPhase: null,
        expiresAt: new Date(nowMs + 1_000),
      } as unknown as PendingPaymentApprovalRecord;
      const later = new Date(nowMs + 2_000);
      expect(paymentApprovalStatus(base, null, new Date(nowMs))).toBe("pending");
      expect(paymentApprovalStatus(base, null, later)).toBe("expired");
      const signed = { ...base, submissionPhase: "submitted" } as PendingPaymentApprovalRecord;
      expect(paymentApprovalStatus(signed, null, new Date(nowMs))).toBe("approved");
      expect(paymentApprovalStatus(signed, null, later)).toBe("failed");
      const denied = { ...base, status: "denied" } as PendingPaymentApprovalRecord;
      expect(paymentApprovalStatus(denied, null, later)).toBe("denied");
    });

    it("waits on the bounded status read until the approval leaves pending", async () => {
      const created = await requestDelete();
      const waiting = readCard(`${created.approval_id}?wait_for_decision=1&wait_ms=3000`);
      await new Promise((resolve) => setTimeout(resolve, 50));
      await call("POST", `/v1/approvals/${created.approval_id}/deny`, {});
      const response = await waiting;
      expect(response.json().approval.status).toBe("denied");
    });
  });

  describe("deny from the host app", () => {
    it("denies every kind and changes nothing", async () => {
      const cardRef = await storeCard();
      const payment = await requestPayment(cardRef);
      const reveal = await requestReveal();
      const remove = await requestDelete();
      const cardEdit = await requestCardEdit();
      for (const id of [payment.id, reveal.approval_id, remove.approval_id, cardEdit.approval_id]) {
        const denied = await call("POST", `/v1/approvals/${id}/deny`, {});
        expect(denied.statusCode).toBe(200);
        expect(denied.json().approval.status).toBe("denied");
        const again = await call("POST", `/v1/approvals/${id}/deny`, {});
        expect(again.statusCode).toBe(200);
      }
      // The denied delete never ran: the key is still listed.
      const list = await call("GET", "/v1/vault/credentials");
      expect(
        (list.json() as { credentials: Array<{ service: string | null }> }).credentials.map(
          (credential) => credential.service,
        ),
      ).toContain("github");
      // A denied reveal cannot be claimed.
      const claim = await call("GET", `/v1/vault/fetch-approvals/${reveal.approval_id}`);
      expect(claim.statusCode).toBe(409);
      expectNoSecrets(claim.body);
    });

    it("refuses to deny once the approval expired", async () => {
      const created = await requestDelete();
      nowMs += 11 * 60_000;
      const denied = await call("POST", `/v1/approvals/${created.approval_id}/deny`, {});
      expect(denied.statusCode).toBe(409);
      expect(denied.json()).toMatchObject({ error: "approval_expired", approval: { status: "expired" } });
    });

    it("refuses to deny a payment the user already signed", async () => {
      const cardRef = await storeCard();
      const created = await requestPayment(cardRef);
      await deps.pendingPaymentApprovalStore.submitCandidate(
        created.id,
        accountId,
        { jws: "j", sealedCard: "s", fingerprint: "f" },
        new Date(Date.parse(created.approval.expires_at)),
        new Date(nowMs),
      );
      const denied = await call("POST", `/v1/approvals/${created.id}/deny`, {});
      expect(denied.statusCode).toBe(409);
      expect(denied.json().approval.status).toBe("approved");
    });
  });

  describe("decision webhooks", () => {
    it("registers https endpoints for agent sessions only and shows the secret once", async () => {
      expect((await call("PUT", "/v1/approval-webhook", { url: "http://app.example.test/hook" })).statusCode).toBe(400);
      expect((await call("PUT", "/v1/approval-webhook", { url: "https://u:p@app.example.test/hook" })).statusCode).toBe(400);
      const web = await server.inject({
        method: "PUT",
        url: "/v1/approval-webhook",
        headers: { cookie: webCookie },
        payload: { url: "https://app.example.test/hook" },
      });
      expect(web.statusCode).toBeGreaterThanOrEqual(401);
      const registered = await register();
      expect(registered.secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
      const read = await call("GET", "/v1/approval-webhook");
      expect(read.json()).toEqual({ url: registered.url, created_at: registered.created_at });
      expect(read.body).not.toContain(registered.secret);
      expect((await call("DELETE", "/v1/approval-webhook")).statusCode).toBe(204);
      expect((await call("GET", "/v1/approval-webhook")).statusCode).toBe(404);
    });

    it("signs each status change; the SDK accepts it and the body carries no secret", async () => {
      const { secret } = await register();
      const created = await requestReveal();
      await settle();
      expect(sent).toHaveLength(1);
      const first = await verifyWebhook(sent[0]!.body, sent[0]!.headers, secret, { now: () => nowMs });
      expect(first).toMatchObject({
        type: "approval.pending",
        approvalId: created.approval_id,
        decision: "pending",
        approval: { title: "Reveal key: stripe / default", kind: "credential_fetch" },
      });
      expect(sent[0]!.headers["squire-event-id"]).toBe(first.id);
      expect(sent[0]!.url).toBe("https://app.example.test/squire/webhook");

      await call("POST", `/v1/approvals/${created.approval_id}/deny`, {});
      await settle();
      expect(sent).toHaveLength(2);
      const second = await verifyWebhook(sent[1]!.body, sent[1]!.headers, secret, { now: () => nowMs });
      expect(second).toMatchObject({ type: "approval.denied", decision: "denied" });
      for (const delivery of sent) expectNoSecrets(delivery.body);
      // Nothing more to say about a final approval.
      await settle();
      expect(sent).toHaveLength(2);
    });

    it("announces an unanswered approval's expiry from the sweep", async () => {
      const { secret } = await register();
      const created = await requestDelete();
      await settle();
      nowMs += 11 * 60_000;
      await settle();
      const last = await verifyWebhook(sent.at(-1)!.body, sent.at(-1)!.headers, secret, { now: () => nowMs });
      expect(last).toMatchObject({ approvalId: created.approval_id, type: "approval.expired" });
    });

    it("follows a payment through approved, processing and completed", async () => {
      const { secret } = await register();
      const cardRef = await storeCard();
      const created = await requestPayment(cardRef);
      await settle();
      const expiresAt = new Date(Date.parse(created.approval.expires_at));
      const fingerprint = "fp";
      await deps.pendingPaymentApprovalStore.submitCandidate(
        created.id,
        accountId,
        { jws: "j", sealedCard: "s", fingerprint },
        expiresAt,
        new Date(nowMs),
      );
      await settle();
      await deps.pendingPaymentApprovalStore.getRelayCandidateForAccount(created.id, accountId, new Date(nowMs));
      await deps.pendingPaymentApprovalStore.confirmCandidateForAccount(created.id, accountId, fingerprint, new Date(nowMs));
      await settle();
      await call("POST", "/v1/vault/payments/audit", {
        merchant: "whitejade.xyz",
        amountCents: 3800,
        currency: "USD",
        last4: "4242",
        status: "merchant_order_confirmed",
        approvalId: created.id,
      });
      await settle();
      const types: string[] = [];
      for (const delivery of sent) {
        types.push((await verifyWebhook(delivery.body, delivery.headers, secret, { now: () => nowMs })).type);
        expectNoSecrets(delivery.body, [created.nonce, created.account_binding]);
      }
      expect(types).toEqual([
        "approval.pending",
        "approval.approved",
        "approval.processing",
        "approval.completed",
      ]);
    });

    it("retries a failed delivery with backoff, keeping the event id, then gives up", async () => {
      await register();
      respond = () => 503;
      await requestDelete();
      await settle();
      expect(sent).toHaveLength(1);
      const eventId = sent[0]!.headers["squire-event-id"];
      // Not due yet: nothing is resent before the first backoff elapses.
      nowMs += APPROVAL_WEBHOOK_BACKOFF_MS[0] - 1;
      await deps.approvalWebhooks.deliverDue();
      expect(sent).toHaveLength(1);
      for (const waitMs of APPROVAL_WEBHOOK_BACKOFF_MS) {
        nowMs += waitMs;
        await deps.approvalWebhooks.deliverDue();
      }
      expect(sent).toHaveLength(APPROVAL_WEBHOOK_BACKOFF_MS.length + 1);
      expect(new Set(sent.map((delivery) => delivery.headers["squire-event-id"]))).toEqual(new Set([eventId]));
      // Every retry is re-signed with a fresh timestamp over the same bytes.
      expect(new Set(sent.map((delivery) => delivery.body)).size).toBe(1);
      expect(store.allDeliveries()[0]).toMatchObject({ abandonedAt: expect.any(Date), lastError: "http_503" });
      nowMs += 24 * 60 * 60_000;
      await deps.approvalWebhooks.deliverDue();
      expect(sent).toHaveLength(APPROVAL_WEBHOOK_BACKOFF_MS.length + 1);
    });

    it("delivers after a retry succeeds", async () => {
      const { secret } = await register();
      let attempts = 0;
      respond = () => (++attempts < 3 ? 500 : 204);
      await requestCardEdit();
      await settle();
      nowMs += APPROVAL_WEBHOOK_BACKOFF_MS[0];
      await deps.approvalWebhooks.deliverDue();
      nowMs += APPROVAL_WEBHOOK_BACKOFF_MS[1];
      await deps.approvalWebhooks.deliverDue();
      expect(sent).toHaveLength(3);
      expect(store.allDeliveries()[0]).toMatchObject({ deliveredAt: expect.any(Date), attempts: 3 });
      await expect(
        verifyWebhook(sent[2]!.body, sent[2]!.headers, secret, { now: () => nowMs }),
      ).resolves.toMatchObject({ type: "approval.pending" });
    });

    it("rejects a replayed or forged delivery", async () => {
      const { secret } = await register();
      await requestDelete();
      await settle();
      const captured = sent[0]!;
      // Replayed later: the signed timestamp is outside the tolerance.
      const replay = await verifyWebhook(captured.body, captured.headers, secret, {
        now: () => nowMs + 10 * 60_000,
      }).catch((caught: unknown) => caught);
      expect(replay).toBeInstanceOf(WebhookVerificationError);
      expect((replay as WebhookVerificationError).code).toBe("timestamp_out_of_range");
      // Forged: a changed decision no longer matches the signature.
      const forged = captured.body.replace('"status":"pending"', '"status":"approved"');
      const forgery = await verifyWebhook(forged, captured.headers, secret, { now: () => nowMs }).catch(
        (caught: unknown) => caught,
      );
      expect((forgery as WebhookVerificationError).code).toBe("invalid_signature");
      // Re-registering rotates the secret: the old one stops verifying.
      const rotated = await register();
      expect(rotated.secret).not.toBe(secret);
      await requestCardEdit();
      await settle();
      const fresh = sent.at(-1)!;
      await expect(verifyWebhook(fresh.body, fresh.headers, rotated.secret, { now: () => nowMs })).resolves.toBeTruthy();
      const stale = await verifyWebhook(fresh.body, fresh.headers, secret, { now: () => nowMs }).catch(
        (caught: unknown) => caught,
      );
      expect((stale as WebhookVerificationError).code).toBe("invalid_signature");
    });

    it("delivers only the approvals the registering session requested", async () => {
      await register();
      await register("https://other-app.example.test/hook", otherAccountToken);
      await requestReveal(secondSessionToken);
      const cardRef = await storeCard();
      await requestPayment(cardRef, secondSessionToken);
      await settle();
      expect(sent).toHaveLength(0);
    });

    it("stops after the endpoint is removed", async () => {
      await register();
      const created = await requestDelete();
      await settle();
      expect(sent).toHaveLength(1);
      await call("DELETE", "/v1/approval-webhook");
      await call("POST", `/v1/approvals/${created.approval_id}/deny`, {});
      await settle();
      expect(sent).toHaveLength(1);
    });
  });
});

describe("webhook transport", () => {
  it("accepts only https URLs without credentials", () => {
    expect(validateApprovalWebhookUrl("https://app.example.test/hook")).not.toBeNull();
    expect(validateApprovalWebhookUrl("ftp://app.example.test/hook")).toBeNull();
    expect(validateApprovalWebhookUrl("https://user:pass@app.example.test/hook")).toBeNull();
    expect(validateApprovalWebhookUrl("not a url")).toBeNull();
    // Loopback http is a local-development opt-in, never on by default.
    expect(validateApprovalWebhookUrl("http://localhost:4000/hook")).toBeNull();
    vi.stubEnv("APPROVAL_WEBHOOK_ALLOW_LOOPBACK", "1");
    expect(validateApprovalWebhookUrl("http://localhost:4000/hook")).not.toBeNull();
    vi.stubEnv("NODE_ENV", "production");
    expect(validateApprovalWebhookUrl("http://localhost:4000/hook")).toBeNull();
    vi.unstubAllEnvs();
  });

  it("refuses private and loopback addresses", async () => {
    const post = createApprovalWebhookPoster();
    await expect(
      post({ url: "https://127.0.0.1:9/hook", headers: {}, body: "{}" }),
    ).rejects.toThrow("blocked_address");
    await expect(
      post({ url: "https://10.0.0.8/hook", headers: {}, body: "{}" }),
    ).rejects.toThrow("blocked_address");
  });

  it("POSTs the exact signed bytes to a real listener", async () => {
    const received: Array<{ headers: IncomingMessage["headers"]; body: string }> = [];
    const listener = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
      req.on("end", () => {
        received.push({ headers: req.headers, body });
        res.writeHead(204).end();
      });
    });
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    const port = (listener.address() as AddressInfo).port;
    try {
      const post = createApprovalWebhookPoster({ allowPrivate: true });
      const result = await post({
        url: `http://127.0.0.1:${port}/squire/webhook`,
        headers: { "content-type": "application/json", "squire-event-id": "evt_1" },
        body: '{"id":"evt_1"}',
      });
      expect(result.status).toBe(204);
      expect(received).toEqual([
        expect.objectContaining({
          body: '{"id":"evt_1"}',
          headers: expect.objectContaining({ "squire-event-id": "evt_1" }),
        }),
      ]);
    } finally {
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    }
  });
});
