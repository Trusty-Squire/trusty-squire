// The SDK's key reveal and payment, end to end over real HTTP: the published
// `Squire` client against a listening API. The value goes only to the agent
// session that asked, only once, only after the passkey YES, and only sealed
// to that app's own key. Every no-value branch is checked against the raw
// response body, not just a status field.

import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { sealToRecipient } from "@trusty-squire/vault/hpke";
import {
  ApiCallError,
  generateSealingKey,
  openSealed,
  SealedDeliveryError,
  Squire,
  type SealingKey,
} from "@trusty-squire/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { issueAgentSession } from "../auth/agent.js";
import { issueSession, SESSION_COOKIE_NAME, signSessionJwt } from "../auth/session.js";
import { buildInMemoryDeps, type ApiDeps } from "../services/deps.js";
import { buildServer } from "../server.js";
import {
  CREDENTIAL_FETCH_VOUCH_CONTEXT,
  PAYMENT_VOUCH_CONTEXT,
  canonicalVouchPayload,
  createVouchMandateVerifier,
} from "../services/vouch-mandate.js";
import { revealSealAad } from "../services/sealed-claims.js";

const SESSION_SECRET = "sealed-claims-test-session-secret";
const AUDIENCE = "sealed-claims-test-customer";
const SECRET_VALUE = "sk-live-sealed-reveal-must-never-be-plaintext";
const OWNER_DEVICE_TOKEN = "dev_owner_device_token";
const CARD = {
  pan: "4242424242424242",
  exp_month: "12",
  exp_year: "2030",
  name: "Ada Owner",
  cvv: "123",
  billing: { line1: "1 Main St", city: "Springfield", postal_code: "12345", country: "US" },
};

type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

describe("sealed reveal and payment through the SDK", () => {
  let server: FastifyInstance;
  let deps: ApiDeps;
  let baseUrl: string;
  let accountId: string;
  let appToken: string;
  let otherSessionToken: string;
  let signingKey: SigningKey;
  let appKey: SealingKey;
  let app: Squire;
  let otherApp: Squire;
  let nowMs: number;
  // Everything the app's session received, to search for plaintext.
  let wire: string[];

  beforeEach(async () => {
    vi.stubEnv("VOUCHFLOW_CUSTOMER_ID", AUDIENCE);
    vi.stubEnv("PWA_BASE_URL", "https://trustysquire.ai");
    nowMs = Date.now();
    const keys = await generateKeyPair("ES256");
    signingKey = keys.privateKey;
    const publicJwk = await exportJWK(keys.publicKey);
    publicJwk.kid = "sealed-claims-test-key";
    deps = buildInMemoryDeps({ sessionSecret: SESSION_SECRET, now: () => new Date(nowMs) });
    server = await buildServer({
      deps,
      vouchVerifier: createVouchMandateVerifier(
        async () => Response.json({ keys: [publicJwk] }),
        "https://vouchflow.test",
      ),
    });
    await server.listen({ port: 0, host: "127.0.0.1" });
    baseUrl = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`;
    const account = await deps.accountStore.createAccount("owner@example.test", "Owner");
    accountId = account.id;
    appToken = await agentSession("Beeline");
    otherSessionToken = await agentSession("Another app");
    const registered = await server.inject({
      method: "POST",
      url: "/v1/vouchflow/devices",
      headers: { cookie: await webCookie() },
      payload: { device_token: OWNER_DEVICE_TOKEN },
    });
    expect(registered.statusCode).toBe(204);
    wire = [];
    const recordingFetch: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      wire.push(await response.clone().text());
      return response;
    };
    appKey = await generateSealingKey();
    app = new Squire({
      token: appToken,
      baseUrl,
      agentName: "Beeline",
      sealingKey: appKey,
      fetch: recordingFetch,
    });
    otherApp = new Squire({ token: otherSessionToken, baseUrl, agentName: "Another app" });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await server.close();
  });

  async function agentSession(identity: string): Promise<string> {
    const session = issueAgentSession({
      account_id: accountId,
      agent_identity: identity,
      agent_version: "test",
      now: new Date(nowMs),
    });
    await deps.agentSessionStore.insert(session.record);
    return session.raw_token;
  }

  async function webCookie(): Promise<string> {
    const { record, jwt } = issueSession({
      account_id: accountId,
      ip: null,
      user_agent: null,
      now: new Date(nowMs),
    });
    await deps.sessionStore.insert(record);
    return `${SESSION_COOKIE_NAME}=${signSessionJwt(jwt, SESSION_SECRET)}`;
  }

  async function sign(payloadSha256: string, context: string): Promise<string> {
    return await new SignJWT({
      context,
      payload_sha256: payloadSha256,
      confidence: "low",
      mandate_id: `mandate_${payloadSha256.slice(0, 8)}`,
      device_token: OWNER_DEVICE_TOKEN,
      signing_device_id: "sdev_owner",
    })
      .setProtectedHeader({ alg: "ES256", kid: "sealed-claims-test-key" })
      .setIssuer("https://vouchflow.dev")
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(signingKey);
  }

  async function storeSecret(): Promise<void> {
    await app.credentials.store({ service: "stripe", value: SECRET_VALUE });
  }

  // The Squire reveal page: read the ceremony, sign its payload with the passkey.
  async function approveReveal(id: string) {
    const ceremony = await server.inject({
      method: "GET",
      url: `/v1/vault/fetch-approvals/${id}/ceremony`,
    });
    const body = ceremony.json() as { payload: Record<string, unknown>; payload_sha256: string };
    const approved = await server.inject({
      method: "POST",
      url: `/v1/vault/fetch-approvals/${id}/approve`,
      payload: { jws: await sign(body.payload_sha256, CREDENTIAL_FETCH_VOUCH_CONTEXT) },
    });
    expect(approved.statusCode).toBe(200);
    return body.payload;
  }

  async function storeCard(): Promise<string> {
    const response = await server.inject({
      method: "POST",
      url: "/v1/vault/e2e",
      headers: { cookie: await webCookie() },
      payload: { label: "Visa", blob: "{}", brand: "visa", last4: "4242" },
    });
    expect(response.statusCode).toBe(201);
    return (response.json() as { id: string }).id;
  }

  // The Squire payment page: sign the canonical terms, seal the unlocked card
  // to the approval's recipient key under the hash of those terms.
  async function approvePayment(id: string) {
    const ceremony = (
      await server.inject({ method: "GET", url: `/v1/pay/approvals/${id}/ceremony` })
    ).json() as Record<string, string | number>;
    const terms = {
      account_binding: ceremony.account_binding,
      approval_id: ceremony.id,
      merchant: ceremony.merchant,
      checkout_origin: ceremony.checkout_origin,
      amount_cents: ceremony.amount_cents,
      currency: ceremony.currency,
      nonce: ceremony.nonce,
      card_ref: ceremony.card_ref,
      recipient_pubkey_hash: createHash("sha256")
        .update(Buffer.from(String(ceremony.operator_pubkey), "base64url"))
        .digest("base64url"),
      item: ceremony.item,
      reason: ceremony.reason,
      agent: ceremony.agent,
    };
    const canonical = canonicalVouchPayload(terms);
    const aad = createHash("sha256").update(canonical, "utf8").digest();
    const sealedCard = await sealToRecipient(
      String(ceremony.operator_pubkey),
      new TextEncoder().encode(JSON.stringify(CARD)),
      new Uint8Array(aad),
    );
    const approved = await server.inject({
      method: "POST",
      url: `/v1/pay/approvals/${id}/approve`,
      payload: {
        jws: await sign(aad.toString("base64url"), PAYMENT_VOUCH_CONTEXT),
        sealed_card: sealedCard,
      },
    });
    expect(approved.statusCode).toBe(202);
    return ceremony;
  }

  async function rawClaim(path: string, token = appToken) {
    return await server.inject({
      method: "POST",
      url: path,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
  }

  function expectNoSecret(body: string): void {
    expect(body).not.toContain(SECRET_VALUE);
    expect(body).not.toContain(CARD.pan);
    expect(body).not.toContain('"fields"');
  }

  describe("credentials.requestReveal", () => {
    it("names the requesting app on the card and signs over the app's key", async () => {
      await storeSecret();
      const { approval } = await app.credentials.requestReveal({ service: "stripe" });
      expect(approval).toMatchObject({
        kind: "credential_fetch",
        action: "reveal",
        status: "pending",
      });
      expect(approval.requestedBy).toBe("Beeline");
      expect(approval.details).toContainEqual({ label: "Requested by", value: "Beeline" });
      const ceremony = await server.inject({
        method: "GET",
        url: `/v1/vault/fetch-approvals/${approval.id}/ceremony`,
      });
      expect(ceremony.json()).toMatchObject({ agent: "Beeline" });
      expect((ceremony.json() as { payload: Record<string, unknown> }).payload).toMatchObject({
        agent: "Beeline",
        recipient_pubkey_hash: createHash("sha256")
          .update(Buffer.from(appKey.publicKey, "base64url"))
          .digest("base64url"),
      });
    });

    it("delivers nothing before approval", async () => {
      await storeSecret();
      const { approval } = await app.credentials.requestReveal({ service: "stripe" });
      await expect(app.credentials.claimReveal(approval.id)).rejects.toMatchObject({
        name: "SealedDeliveryError",
        code: "approval_pending",
      });
      const raw = await rawClaim(`/v1/vault/fetch-approvals/${approval.id}/claim`);
      expect(raw.statusCode).toBe(200);
      expect(raw.json()).not.toHaveProperty("sealed");
      expectNoSecret(raw.body);
      // Still claimable once the user says yes.
      await approveReveal(approval.id);
      expect((await app.credentials.claimReveal(approval.id)).value).toBe(SECRET_VALUE);
    });

    it("delivers the value once, sealed, to the session that asked", async () => {
      await storeSecret();
      const { approval } = await app.credentials.requestReveal({
        service: "stripe",
        reason: "deploy",
      });
      await approveReveal(approval.id);

      // Another session of the same account: refused, and nothing is burned.
      const stranger = await rawClaim(
        `/v1/vault/fetch-approvals/${approval.id}/claim`,
        otherSessionToken,
      );
      expect(stranger.statusCode).toBe(403);
      expect(stranger.json()).toEqual({ error: "sealed_claim_forbidden" });
      await expect(otherApp.credentials.claimReveal(approval.id)).rejects.toBeInstanceOf(
        ApiCallError,
      );
      // The broker's plaintext resume refuses a sealed approval, for every session.
      for (const token of [appToken, otherSessionToken]) {
        const resume = await server.inject({
          method: "GET",
          url: `/v1/vault/fetch-approvals/${approval.id}`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(resume.statusCode).toBe(409);
        expect(resume.json()).toMatchObject({ error: "sealed_claim_required" });
        expectNoSecret(resume.body);
      }

      wire = [];
      const revealed = await app.credentials.claimReveal(approval.id);
      expect(revealed).toEqual({
        approvalId: approval.id,
        fields: { value: SECRET_VALUE },
        value: SECRET_VALUE,
      });
      // On the wire it was sealed, never plaintext.
      expect(wire.join("\n")).not.toContain(SECRET_VALUE);
      expect(wire.join("\n")).toContain('"sealed"');

      const again = await rawClaim(`/v1/vault/fetch-approvals/${approval.id}/claim`);
      expect(again.statusCode).toBe(409);
      expect(again.json()).toMatchObject({ error: "credential_fetch_already_delivered" });
      expectNoSecret(again.body);
      expect((await app.approvals.get(approval.id)).status).toBe("completed");
    });

    it("opens only with the matching private key", async () => {
      await storeSecret();
      const { approval } = await app.credentials.requestReveal({ service: "stripe" });
      await approveReveal(approval.id);
      const raw = await rawClaim(`/v1/vault/fetch-approvals/${approval.id}/claim`);
      expect(raw.statusCode).toBe(200);
      const sealed = (raw.json() as { sealed: string }).sealed;
      expectNoSecret(raw.body);
      const wrongKey = await generateSealingKey();
      await expect(
        openSealed(wrongKey.privateKey, sealed, revealSealAad(approval.id)),
      ).rejects.toThrow();
      // The right key with another approval's binding fails too.
      await expect(
        openSealed(appKey.privateKey, sealed, revealSealAad("01ANOTHERAPPROVAL000000000")),
      ).rejects.toThrow();
      const opened = await openSealed(appKey.privateKey, sealed, revealSealAad(approval.id));
      expect(JSON.parse(new TextDecoder().decode(opened))).toEqual({ value: SECRET_VALUE });
    });

    it("delivers nothing once denied or expired", async () => {
      await storeSecret();
      const denied = (await app.credentials.requestReveal({ service: "stripe" })).approval;
      await app.approvals.deny(denied.id);
      const deniedClaim = await rawClaim(`/v1/vault/fetch-approvals/${denied.id}/claim`);
      expect(deniedClaim.statusCode).toBe(409);
      expect(deniedClaim.json()).toMatchObject({ error: "credential_fetch_denied" });
      expectNoSecret(deniedClaim.body);

      // A new request (the denied one no longer rides) that lapses unsigned.
      const lapsed = (await app.credentials.requestReveal({ service: "stripe", field: "value" }))
        .approval;
      nowMs += 11 * 60 * 1000;
      const expiredClaim = await rawClaim(`/v1/vault/fetch-approvals/${lapsed.id}/claim`);
      expect(expiredClaim.statusCode).toBe(409);
      expect(expiredClaim.json()).toMatchObject({ error: "credential_fetch_approval_expired" });
      expectNoSecret(expiredClaim.body);
    });

    it("keeps an approved but unclaimed reveal dead after expiry", async () => {
      await storeSecret();
      const { approval } = await app.credentials.requestReveal({ service: "stripe" });
      await approveReveal(approval.id);
      nowMs += 11 * 60 * 1000;
      const claim = await rawClaim(`/v1/vault/fetch-approvals/${approval.id}/claim`);
      expect(claim.statusCode).toBe(409);
      expectNoSecret(claim.body);
    });

    it("refuses a malformed app key and a sealed request from a web session", async () => {
      await storeSecret();
      const bad = await server.inject({
        method: "POST",
        url: "/v1/vault/fetch-approvals",
        headers: { authorization: `Bearer ${appToken}` },
        payload: { service: "stripe", recipient_public_key: "not-a-key" },
      });
      expect(bad.statusCode).toBe(400);
      const web = await server.inject({
        method: "POST",
        url: "/v1/vault/fetch-approvals",
        headers: { cookie: await webCookie() },
        payload: { service: "stripe", recipient_public_key: appKey.publicKey },
      });
      expect(web.statusCode).toBe(403);
    });

    it("leaves the broker's plaintext reveal exactly as it was", async () => {
      await storeSecret();
      const created = await server.inject({
        method: "POST",
        url: "/v1/vault/fetch-approvals",
        headers: { authorization: `Bearer ${appToken}` },
        payload: { service: "stripe" },
      });
      const id = (created.json() as { approval_id: string }).approval_id;
      const payload = await approveReveal(id);
      expect(payload).not.toHaveProperty("recipient_pubkey_hash");
      const sealedClaim = await rawClaim(`/v1/vault/fetch-approvals/${id}/claim`);
      expect(sealedClaim.statusCode).toBe(409);
      expect(sealedClaim.json()).toEqual({ error: "approval_not_sealed" });
      const resume = await server.inject({
        method: "GET",
        url: `/v1/vault/fetch-approvals/${id}`,
        headers: { authorization: `Bearer ${appToken}` },
      });
      expect(resume.statusCode).toBe(200);
      expect(resume.json()).toMatchObject({ status: "consumed", fields: { value: SECRET_VALUE } });
    });
  });

  describe("payments.request", () => {
    it("releases the card once, sealed, to the session that asked, then reports the outcome", async () => {
      const cardRef = await storeCard();
      const { approval } = await app.payments.request({
        merchant: "whitejade.xyz",
        amount: 3800,
        currency: "USD",
        cardRef,
        reason: "Glow Serum x1",
      });
      expect(approval).toMatchObject({ kind: "payment", action: "pay", status: "pending" });
      expect(approval.requestedBy).toBe("Beeline");
      expect(approval.details).toContainEqual({ label: "Requested by", value: "Beeline" });

      // Before the passkey: no card.
      await expect(app.payments.claim(approval.id)).rejects.toMatchObject({
        name: "SealedDeliveryError",
        code: "approval_pending",
      });
      const ceremony = await approvePayment(approval.id);
      expect(ceremony.agent).toBe("Beeline");
      expect(ceremony.operator_pubkey).toBe(appKey.publicKey);

      // Another session: refused, and its relay reads carry nothing.
      const stranger = await rawClaim(`/v1/pay/approvals/${approval.id}/claim`, otherSessionToken);
      expect(stranger.statusCode).toBe(403);
      for (const query of [
        "read_submission=1",
        "peek_submission=1",
        "wait_for_submission=1&wait_ms=0",
      ]) {
        const relay = await server.inject({
          method: "GET",
          url: `/v1/pay/approvals/${approval.id}?${query}`,
          headers: { authorization: `Bearer ${otherSessionToken}` },
        });
        expect(relay.statusCode).toBe(200);
        expect(relay.json()).toMatchObject({ jws: null, sealed_card: null });
      }

      wire = [];
      const released = await app.payments.claim(approval.id);
      expect(released.card).toEqual(CARD);
      expect(released.last4).toBe("4242");
      expect(released.approval.status).toBe("processing");
      expect(wire.join("\n")).not.toContain(CARD.pan);

      const again = await rawClaim(`/v1/pay/approvals/${approval.id}/claim`);
      expect(again.statusCode).toBe(409);
      expect(again.json()).toEqual({ error: "payment_approval_already_claimed" });

      // Only the claiming session reports the merchant's answer, once.
      const strangerReport = await server.inject({
        method: "POST",
        url: `/v1/pay/approvals/${approval.id}/outcome`,
        headers: { authorization: `Bearer ${otherSessionToken}` },
        payload: { outcome: "completed" },
      });
      expect(strangerReport.statusCode).toBe(403);
      const done = await app.payments.report(approval.id, { outcome: "completed" });
      expect(done.status).toBe("completed");
      await expect(app.payments.report(approval.id, { outcome: "failed" })).rejects.toMatchObject({
        code: "payment_outcome_already_reported",
      });
      const card = await server.inject({
        method: "GET",
        url: `/v1/approvals/${approval.id}`,
        headers: { authorization: `Bearer ${appToken}` },
      });
      expectNoSecret(card.body);
      expect(card.body).not.toContain(CARD.cvv + '"');
    });

    it("moves a released card to failed when the merchant refuses", async () => {
      const cardRef = await storeCard();
      const { approval } = await app.payments.request({
        merchant: "Whitejade",
        checkoutOrigin: "https://whitejade.xyz",
        amount: 1200,
        currency: "USD",
        cardRef,
        reason: "refill",
      });
      await approvePayment(approval.id);
      await app.payments.claim(approval.id, { timeoutMs: 1_000 });
      expect((await app.payments.report(approval.id, { outcome: "failed" })).status).toBe("failed");
    });

    it("cannot be opened without the app's private key", async () => {
      const cardRef = await storeCard();
      const { approval } = await app.payments.request({
        merchant: "whitejade.xyz",
        amount: 3800,
        currency: "USD",
        cardRef,
        reason: "Glow Serum x1",
      });
      await approvePayment(approval.id);
      const raw = await rawClaim(`/v1/pay/approvals/${approval.id}/claim`);
      expect(raw.statusCode).toBe(200);
      expect(raw.body).not.toContain(CARD.pan);
      const { sealed_card: sealedCard, jws } = raw.json() as { sealed_card: string; jws: string };
      const aad = Buffer.from(
        String(
          (
            JSON.parse(Buffer.from(jws.split(".")[1]!, "base64url").toString()) as {
              payload_sha256: string;
            }
          ).payload_sha256,
        ),
        "base64url",
      );
      const wrongKey = await generateSealingKey();
      await expect(openSealed(wrongKey.privateKey, sealedCard, aad)).rejects.toThrow();
      const opened = await openSealed(appKey.privateKey, sealedCard, aad);
      expect(JSON.parse(new TextDecoder().decode(opened))).toEqual(CARD);
    });

    it("releases nothing once denied or expired", async () => {
      const cardRef = await storeCard();
      const denied = (
        await app.payments.request({
          merchant: "whitejade.xyz",
          amount: 100,
          currency: "USD",
          cardRef,
          reason: "denied",
        })
      ).approval;
      await app.approvals.deny(denied.id);
      const deniedClaim = await rawClaim(`/v1/pay/approvals/${denied.id}/claim`);
      expect(deniedClaim.statusCode).toBe(409);
      expect(deniedClaim.json()).toMatchObject({ error: "payment_approval_denied" });
      expect(deniedClaim.json()).not.toHaveProperty("sealed_card");

      const lapsed = (
        await app.payments.request({
          merchant: "whitejade.xyz",
          amount: 200,
          currency: "USD",
          cardRef,
          reason: "lapsed",
        })
      ).approval;
      nowMs += 11 * 60 * 1000;
      const expiredClaim = await rawClaim(`/v1/pay/approvals/${lapsed.id}/claim`);
      expect(expiredClaim.statusCode).toBe(409);
      expect(expiredClaim.json()).toMatchObject({ error: "payment_approval_expired" });
      expect(expiredClaim.json()).not.toHaveProperty("sealed_card");
    });

    it("leaves the broker's payment relay exactly as it was", async () => {
      const cardRef = await storeCard();
      const operator = await generateSealingKey();
      const created = await server.inject({
        method: "POST",
        url: "/v1/pay/approvals",
        headers: { authorization: `Bearer ${appToken}` },
        payload: {
          merchant: "whitejade.xyz",
          checkout_origin: "https://whitejade.xyz",
          amount_cents: 3800,
          currency: "USD",
          card_ref: cardRef,
          operator_pubkey: operator.publicKey,
          item: "Glow Serum x1",
          reason: "Glow Serum x1",
        },
      });
      const id = (created.json() as { id: string }).id;
      await approvePayment(id);
      const claim = await rawClaim(`/v1/pay/approvals/${id}/claim`);
      expect(claim.json()).toEqual({ error: "approval_not_sealed" });
      // Any agent session of the account still reads the relay, as before.
      const relay = await server.inject({
        method: "GET",
        url: `/v1/pay/approvals/${id}?read_submission=1`,
        headers: { authorization: `Bearer ${otherSessionToken}` },
      });
      expect((relay.json() as { sealed_card: string | null }).sealed_card).not.toBeNull();
    });

    it("refuses an amount that is not in minor units", async () => {
      await expect(
        app.payments.request({
          merchant: "whitejade.xyz",
          amount: 38.5,
          currency: "USD",
          reason: "x",
        }),
      ).rejects.toBeInstanceOf(TypeError);
      await expect(
        app.payments.request({ merchant: "Whitejade", amount: 100, currency: "USD", reason: "x" }),
      ).rejects.toBeInstanceOf(TypeError);
    });
  });

  it("exports the delivery error type", () => {
    expect(new SealedDeliveryError("open_failed", "x")).toBeInstanceOf(Error);
  });
});
