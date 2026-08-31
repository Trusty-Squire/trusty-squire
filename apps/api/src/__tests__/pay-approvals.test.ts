import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { issueAgentSession } from "../auth/agent.js";
import { issueSession, SESSION_COOKIE_NAME, signSessionJwt } from "../auth/session.js";
import { buildInMemoryDeps, type ApiDeps } from "../services/deps.js";
import { buildServer } from "../server.js";

const SESSION_SECRET = "synthetic-payment-approval-test-secret";

async function makeWebSession(deps: ApiDeps, accountId: string, now: Date): Promise<string> {
  const { record, jwt } = issueSession({
    account_id: accountId,
    ip: null,
    user_agent: null,
    now,
  });
  await deps.sessionStore.insert(record);
  return `${SESSION_COOKIE_NAME}=${signSessionJwt(jwt, SESSION_SECRET)}`;
}

async function makeAgentToken(
  deps: ApiDeps,
  accountId: string,
  now: Date,
  agentIdentity: string | null = "synthetic-payment-test-agent",
): Promise<string> {
  const { raw_token, record } = issueAgentSession({
    account_id: accountId,
    agent_identity: agentIdentity,
    agent_version: "test",
    now,
  });
  await deps.agentSessionStore.insert(record);
  return raw_token;
}

describe("payment approval relay", () => {
  let server: FastifyInstance;
  let deps: ApiDeps;
  let nowMs: number;
  let agentToken: string;
  let webCookie: string;
  let otherAgentToken: string;
  let otherWebCookie: string;

  beforeEach(async () => {
    nowMs = Date.parse("2026-07-23T12:00:00.000Z");
    deps = buildInMemoryDeps({
      sessionSecret: SESSION_SECRET,
      now: () => new Date(nowMs),
    });
    server = await buildServer({ deps, vouchVerifier: async () => ({}) });
    const account = await deps.accountStore.createAccount("payer@example.test", "Payer");
    const other = await deps.accountStore.createAccount("other@example.test", "Other");
    agentToken = await makeAgentToken(deps, account.id, new Date(nowMs));
    webCookie = await makeWebSession(deps, account.id, new Date(nowMs));
    otherAgentToken = await makeAgentToken(deps, other.id, new Date(nowMs));
    otherWebCookie = await makeWebSession(deps, other.id, new Date(nowMs));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await server.close();
  });

  async function createApproval(cardRef = "card_synthetic_1"): Promise<{
    id: string;
    nonce: string;
    agent: string;
    expires_at: string;
  }> {
    const response = await server.inject({
      method: "POST",
      url: "/v1/pay/approvals",
      headers: {
        authorization: `Bearer ${agentToken}`,
        "x-squire-agent-identity": "Hermes",
      },
      payload: {
        merchant: "Synthetic Books",
        checkout_origin: "https://checkout.synthetic.test",
        amount_cents: 2599,
        currency: "USD",
        card_ref: cardRef,
        operator_pubkey: "c3ludGhldGljLW9wZXJhdG9yLWtleQ",
        item: "Synthetic Book",
        reason: "Synthetic test purchase",
      },
    });
    expect(response.statusCode).toBe(201);
    return response.json() as {
      id: string;
      nonce: string;
      agent: string;
      expires_at: string;
    };
  }

  async function createCardlessApproval(): Promise<{ id: string }> {
    const response = await server.inject({
      method: "POST",
      url: "/v1/pay/approvals",
      headers: {
        authorization: `Bearer ${agentToken}`,
        "x-squire-agent-identity": "Hermes",
      },
      payload: {
        merchant: "Synthetic Books",
        checkout_origin: "https://checkout.synthetic.test",
        amount_cents: 2599,
        currency: "USD",
        operator_pubkey: "c3ludGhldGljLW9wZXJhdG9yLWtleQ",
        item: "Synthetic Book",
        reason: "Synthetic test purchase",
      },
    });
    expect(response.statusCode).toBe(201);
    return response.json() as { id: string };
  }

  // Creates an E2ECredential (card) owned by the account behind `cookie`,
  // returning its id — the value the JIT ceremony binds as card_ref.
  async function createOwnedCard(cookie: string, last4 = "4242"): Promise<string> {
    const res = await server.inject({
      method: "POST",
      url: "/v1/vault/e2e",
      headers: { cookie },
      payload: {
        label: "Synthetic Visa",
        blob: '{ "ciphertext": "synthetic-sealed-card" }',
        brand: "visa",
        last4,
      },
    });
    expect(res.statusCode).toBe(201);
    return (res.json() as { id: string }).id;
  }

  function makeSubmission(input: {
    id: string;
    nonce: string;
    card_ref?: string;
    merchant?: string;
    checkout_origin?: string;
    amount_cents?: number;
    currency?: string;
    operator_pubkey?: string;
    item?: string;
    reason?: string;
    agent?: string;
  }): { jws: string; sealed_card: string } {
    const operatorPubkey = input.operator_pubkey ?? "c3ludGhldGljLW9wZXJhdG9yLWtleQ";
    const payload = {
      approval_id: input.id,
      merchant: input.merchant ?? "Synthetic Books",
      checkout_origin: input.checkout_origin ?? "https://checkout.synthetic.test",
      amount_cents: input.amount_cents ?? 2599,
      currency: input.currency ?? "USD",
      nonce: input.nonce,
      card_ref: input.card_ref ?? "card_synthetic_1",
      recipient_pubkey_hash: createHash("sha256")
        .update(Buffer.from(operatorPubkey, "base64url"))
        .digest("base64url"),
      item: input.item ?? "Synthetic Book",
      reason: input.reason ?? "Synthetic test purchase",
      agent: input.agent ?? "Hermes",
    };
    const canonical = JSON.stringify(
      Object.fromEntries(
        Object.entries(payload).sort(([left], [right]) => left.localeCompare(right)),
      ),
    );
    const claims = Buffer.from(
      JSON.stringify({
        context: "purchase",
        payload_sha256: createHash("sha256").update(canonical).digest("base64url"),
      }),
    ).toString("base64url");
    return {
      jws: `e30.${claims}.synthetic-signature`,
      sealed_card: "c2VhbGVkLXN5bnRoZXRpYy1jYXJk",
    };
  }

  function makeReviewSubmission(input: {
    id: string;
    card_ref: string;
    operator_pubkey: string;
    approval_payload_sha256: string;
  }): { jws: string; sealed_card: string } {
    const canonical = JSON.stringify({
      approval_id: input.id,
      approval_payload_sha256: input.approval_payload_sha256,
      card_ref: input.card_ref,
      recipient_pubkey_hash: createHash("sha256")
        .update(Buffer.from(input.operator_pubkey, "base64url"))
        .digest("base64url"),
    });
    const claims = Buffer.from(
      JSON.stringify({
        context: "purchase",
        payload_sha256: createHash("sha256").update(canonical).digest("base64url"),
      }),
    ).toString("base64url");
    return {
      jws: `e30.${claims}.synthetic-review-signature`,
      sealed_card: "c2VhbGVkLXN5bnRoZXRpYy1yZXZpZXctY2FyZA",
    };
  }

  async function relaySubmission(
    id: string,
    submission: { jws: string; sealed_card: string },
  ): Promise<{ approvalStatus: number; relayed: Record<string, unknown> }> {
    const operatorWait = server.inject({
      method: "GET",
      url: `/v1/pay/approvals/${id}?wait_for_submission=1`,
      headers: { authorization: `Bearer ${agentToken}` },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const approval = await server.inject({
      method: "POST",
      url: `/v1/pay/approvals/${id}/approve`,
      payload: submission,
    });
    const relayed = await operatorWait;
    return { approvalStatus: approval.statusCode, relayed: relayed.json() };
  }

  it("creates a pending approval and returns it", async () => {
    const created = await createApproval();
    expect(created.nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(created.agent).toBe("synthetic-payment-test-agent");
    expect(created.expires_at).toBe("2026-07-23T12:10:00.000Z");

    const response = await server.inject({
      method: "GET",
      url: `/v1/pay/approvals/${created.id}`,
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      id: created.id,
      status: "pending",
      merchant: "Synthetic Books",
      checkout_origin: "https://checkout.synthetic.test",
      amount_cents: 2599,
      currency: "USD",
      nonce: created.nonce,
      card_ref: "card_synthetic_1",
      operator_pubkey: "c3ludGhldGljLW9wZXJhdG9yLWtleQ",
      item: "Synthetic Book",
      reason: "Synthetic test purchase",
      agent: "synthetic-payment-test-agent",
      jws: null,
      sealed_card: null,
      expires_at: created.expires_at,
    });
  });

  it("discloses bound-card display metadata but no plaintext card fields before authorization", async () => {
    const cardId = await createOwnedCard(webCookie);
    const created = await createApproval(cardId);
    const response = await server.inject({
      method: "GET",
      url: `/v1/pay/approvals/${created.id}/ceremony`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: created.id,
      status: "pending",
      merchant: "Synthetic Books",
      checkout_origin: "https://checkout.synthetic.test",
      amount_cents: 2599,
      currency: "USD",
      item: "Synthetic Book",
      reason: "Synthetic test purchase",
      card_ref: cardId,
      operator_pubkey: "c3ludGhldGljLW9wZXJhdG9yLWtleQ",
      approval_payload_sha256: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
    expect(response.json().card).toEqual({
      blob: '{ "ciphertext": "synthetic-sealed-card" }',
      label: "Synthetic Visa",
      last4: "4242",
    });
    expect(response.json().card).not.toHaveProperty("pan");
    expect(response.json().card).not.toHaveProperty("expiry");
    expect(response.json().card).not.toHaveProperty("cvv");
  });

  it("rejects legacy review-bound submissions as a stale payment client", async () => {
    const cardId = await createOwnedCard(webCookie);
    const created = await createApproval(cardId);
    const ceremonyResponse = await server.inject({
      method: "GET",
      url: `/v1/pay/approvals/${created.id}/ceremony`,
    });
    const ceremony = ceremonyResponse.json() as {
      id: string;
      card_ref: string;
      operator_pubkey: string;
      approval_payload_sha256: string;
    };
    const review = makeReviewSubmission(ceremony);
    const response = await server.inject({
      method: "POST",
      url: `/v1/pay/approvals/${created.id}/approve`,
      payload: review,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "stale_payment_client" });

    const pending = await server.inject({
      method: "GET",
      url: `/v1/pay/approvals/${created.id}`,
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(pending.json()).toMatchObject({
      status: "pending",
      jws: null,
      sealed_card: null,
    });
  });

  it("stores item/reason and ignores a forged requester header", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/v1/pay/approvals",
      headers: {
        authorization: `Bearer ${agentToken}`,
        "x-squire-agent-identity": "synthetic-shopping-agent",
      },
      payload: {
        merchant: "Synthetic Books",
        checkout_origin: "https://checkout.synthetic.test",
        amount_cents: 2599,
        currency: "USD",
        card_ref: "card_synthetic_1",
        operator_pubkey: "c3ludGhldGljLW9wZXJhdG9yLWtleQ",
        item: "Synthetic Widget",
        reason: "Restocking synthetic inventory",
        agent: "ignored-body-agent",
      },
    });
    expect(response.statusCode).toBe(201);
    const created = response.json() as { id: string; agent: string };
    expect(created.agent).toBe("synthetic-payment-test-agent");

    const get = await server.inject({
      method: "GET",
      url: `/v1/pay/approvals/${created.id}`,
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toMatchObject({
      item: "Synthetic Widget",
      reason: "Restocking synthetic inventory",
      agent: "synthetic-payment-test-agent",
    });
  });

  it("rejects missing or blank item and reason", async () => {
    const missing = await server.inject({
      method: "POST",
      url: "/v1/pay/approvals",
      headers: { authorization: `Bearer ${agentToken}` },
      payload: {
        merchant: "Synthetic Books",
        checkout_origin: "https://checkout.synthetic.test",
        amount_cents: 2599,
        currency: "USD",
        card_ref: "card_synthetic_1",
        operator_pubkey: "c3ludGhldGljLW9wZXJhdG9yLWtleQ",
      },
    });
    expect(missing.statusCode).toBe(400);

    const blank = await server.inject({
      method: "POST",
      url: "/v1/pay/approvals",
      headers: { authorization: `Bearer ${agentToken}` },
      payload: {
        merchant: "Synthetic Books",
        checkout_origin: "https://checkout.synthetic.test",
        amount_cents: 2599,
        currency: "USD",
        card_ref: "card_synthetic_1",
        operator_pubkey: "c3ludGhldGljLW9wZXJhdG9yLWtleQ",
        item: " ",
        reason: "because",
      },
    });
    expect(blank.statusCode).toBe(400);
  });

  it("returns the configured Vouchflow audience to an authenticated operator", async () => {
    vi.stubEnv("VOUCHFLOW_CUSTOMER_ID", "customer_test");
    const response = await server.inject({
      method: "GET",
      url: "/v1/pay/config",
      headers: { authorization: `Bearer ${agentToken}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ vouchflow_audience: "customer_test" });
  });

  it("omits the Vouchflow audience when the server is not configured", async () => {
    vi.stubEnv("VOUCHFLOW_CUSTOMER_ID", "");
    const response = await server.inject({
      method: "GET",
      url: "/v1/pay/config",
      headers: { authorization: `Bearer ${agentToken}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({});
  });

  it("durably retains an operator-sealed candidate until the agent confirms it", async () => {
    const created = await createApproval();
    const forged = { ...makeSubmission(created), sealed_card: "junk-seal" };
    const noOperator = await server.inject({
      method: "POST",
      url: `/v1/pay/approvals/${created.id}/approve`,
      payload: forged,
    });
    expect(noOperator.statusCode).toBe(202);

    const afterForgery = await server.inject({
      method: "GET",
      url: `/v1/pay/approvals/${created.id}`,
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(afterForgery.json()).toMatchObject({
      status: "pending",
      jws: null,
      sealed_card: null,
    });

    const relayedForgery = await server.inject({
      method: "GET",
      url: `/v1/pay/approvals/${created.id}?wait_for_submission=1`,
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(relayedForgery.statusCode).toBe(200);
    expect(relayedForgery.json()).toMatchObject(forged);

    const redeliveredForgery = await server.inject({
      method: "GET",
      url: `/v1/pay/approvals/${created.id}?wait_for_submission=1`,
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(redeliveredForgery.statusCode).toBe(200);
    expect(redeliveredForgery.json()).toMatchObject(forged);

    const afterRelay = await server.inject({
      method: "GET",
      url: `/v1/pay/approvals/${created.id}`,
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(afterRelay.json()).toMatchObject({ status: "pending", jws: null, sealed_card: null });

    nowMs += 15_001;
    const replacement = { ...makeSubmission(created), sealed_card: "replacement-seal" };
    const replacementAttempt = await server.inject({
      method: "POST",
      url: `/v1/pay/approvals/${created.id}/approve`,
      payload: replacement,
    });
    expect(replacementAttempt.statusCode).toBe(409);
    expect(replacementAttempt.json()).toEqual({ error: "payment_approval_in_progress" });
    const verified = forged;

    const wrongAccountConfirm = await server.inject({
      method: "POST",
      url: `/v1/pay/approvals/${created.id}/confirm`,
      headers: { authorization: `Bearer ${otherAgentToken}` },
      payload: verified,
    });
    expect(wrongAccountConfirm.statusCode).toBe(404);
    expect(wrongAccountConfirm.json()).toEqual({ error: "payment_approval_not_found" });

    const changedCandidateConfirm = await server.inject({
      method: "POST",
      url: `/v1/pay/approvals/${created.id}/confirm`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { ...verified, sealed_card: "different-seal" },
    });
    expect(changedCandidateConfirm.statusCode).toBe(409);
    expect(changedCandidateConfirm.json()).toEqual({
      error: "payment_approval_candidate_changed",
    });

    const confirm = await server.inject({
      method: "POST",
      url: `/v1/pay/approvals/${created.id}/confirm`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: verified,
    });
    expect(confirm.statusCode).toBe(200);
    expect(confirm.json()).toEqual({ status: "approved" });

    const repeatedConfirm = await server.inject({
      method: "POST",
      url: `/v1/pay/approvals/${created.id}/confirm`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: verified,
    });
    expect(repeatedConfirm.statusCode).toBe(200);
    expect(repeatedConfirm.json()).toEqual({ status: "approved" });

    const stored = await deps.pendingPaymentApprovalStore.getById(created.id);
    expect(stored).toMatchObject({
      status: "approved",
      jws: null,
      sealedCard: null,
      reviewJws: null,
      reviewSealedCard: null,
      submissionJws: null,
      submissionSealedCard: null,
      submissionPhase: "confirmed",
      submissionCandidateFingerprint: createHash("sha256")
        .update(JSON.stringify([verified.jws, verified.sealed_card]))
        .digest("base64url"),
    });

    const final = await server.inject({
      method: "GET",
      url: `/v1/pay/approvals/${created.id}`,
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(final.json()).toMatchObject({
      status: "approved",
      jws: null,
      sealed_card: null,
    });
  });

  it("marks only a previously accepted relay candidate for bounded expiry handling", async () => {
    await server.close();
    const verifier = vi.fn(async () => ({}));
    server = await buildServer({ deps, vouchVerifier: verifier });
    const created = await createApproval();
    const submission = makeSubmission(created);

    const relayed = await relaySubmission(created.id, submission);
    expect(relayed.approvalStatus).toBe(202);
    expect(verifier).toHaveBeenNthCalledWith(
      1,
      expect.not.objectContaining({ previouslyVerifiedRelay: true }),
    );

    const confirm = await server.inject({
      method: "POST",
      url: `/v1/pay/approvals/${created.id}/confirm`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: submission,
    });
    expect(confirm.statusCode).toBe(200);
    expect(verifier).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ previouslyVerifiedRelay: true }),
    );
  });

  it("refuses confirmation when approval expires during vouch verification", async () => {
    const created = await createApproval();
    const submission = makeSubmission(created);
    await relaySubmission(created.id, submission);
    nowMs = Date.parse(created.expires_at) - 1;
    await server.close();
    server = await buildServer({
      deps,
      vouchVerifier: async () => {
        nowMs += 2;
        return {};
      },
    });

    const confirm = await server.inject({
      method: "POST",
      url: `/v1/pay/approvals/${created.id}/confirm`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: submission,
    });
    expect(confirm.statusCode).toBe(409);
    expect(confirm.json()).toEqual({ error: "payment_approval_candidate_changed" });
    expect((await deps.pendingPaymentApprovalStore.getById(created.id))?.status).toBe("pending");
  });

  it("returns terminal denial when denial wins confirmation", async () => {
    const created = await createApproval();
    const submission = makeSubmission(created);
    await relaySubmission(created.id, submission);
    await server.close();
    server = await buildServer({
      deps,
      vouchVerifier: async () => {
        await deps.pendingPaymentApprovalStore.deny(created.id, new Date(nowMs));
        return {};
      },
    });

    const confirm = await server.inject({
      method: "POST",
      url: `/v1/pay/approvals/${created.id}/confirm`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: submission,
    });

    expect(confirm.statusCode).toBe(409);
    expect(confirm.json()).toEqual({ error: "payment_approval_denied" });
    expect((await deps.pendingPaymentApprovalStore.getById(created.id))?.status).toBe("denied");
  });

  it("rejects an expired approved relay before vouch verification", async () => {
    await server.close();
    const verifier = vi.fn(async () => ({}));
    server = await buildServer({ deps, vouchVerifier: verifier });
    const created = await createApproval();
    const submission = makeSubmission(created);
    await relaySubmission(created.id, submission);
    const confirmed = await server.inject({
      method: "POST",
      url: `/v1/pay/approvals/${created.id}/confirm`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: submission,
    });
    expect(confirmed.statusCode).toBe(200);
    expect(verifier).toHaveBeenCalledTimes(2);
    nowMs = Date.parse(created.expires_at) + 1;

    const expired = await server.inject({
      method: "POST",
      url: `/v1/pay/approvals/${created.id}/confirm`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: submission,
    });
    expect(expired.statusCode).toBe(409);
    expect(expired.json()).toEqual({ error: "payment_approval_expired" });
    expect(verifier).toHaveBeenCalledTimes(2);
  });

  it.each(["review", "approval"] as const)(
    "peeks at an in-flight %s candidate without consuming delivery state",
    async (binding) => {
      const created = await createApproval();
      const submission =
        binding === "review"
          ? makeReviewSubmission({
              id: created.id,
              card_ref: "card_synthetic_1",
              operator_pubkey: "c3ludGhldGljLW9wZXJhdG9yLWtleQ",
              approval_payload_sha256: createHash("sha256")
                .update(
                  JSON.stringify({
                    agent: "synthetic-payment-test-agent",
                    amount_cents: 2599,
                    approval_id: created.id,
                    card_ref: "card_synthetic_1",
                    checkout_origin: "https://checkout.synthetic.test",
                    currency: "USD",
                    item: "Synthetic Book",
                    merchant: "Synthetic Books",
                    nonce: created.nonce,
                    reason: "Synthetic test purchase",
                    recipient_pubkey_hash: createHash("sha256")
                      .update(Buffer.from("c3ludGhldGljLW9wZXJhdG9yLWtleQ", "base64url"))
                      .digest("base64url"),
                  }),
                )
                .digest("base64url"),
            })
          : makeSubmission(created);
      const fingerprint = createHash("sha256")
        .update(JSON.stringify([submission.jws, submission.sealed_card]))
        .digest("base64url");
      const candidate = {
        jws: submission.jws,
        sealedCard: submission.sealed_card,
        fingerprint,
      };
      const relayExpiresAt = new Date(nowMs + 15_000);
      const submitted =
        binding === "review"
          ? await deps.pendingPaymentApprovalStore.submitReviewCandidate(
              created.id,
              (await deps.pendingPaymentApprovalStore.getById(created.id))!.accountId,
              candidate,
              relayExpiresAt,
              new Date(nowMs),
            )
          : await deps.pendingPaymentApprovalStore.submitCandidate(
              created.id,
              (await deps.pendingPaymentApprovalStore.getById(created.id))!.accountId,
              candidate,
              relayExpiresAt,
              new Date(nowMs),
            );
      expect(submitted).toBe("submitted");

      for (const query of ["peek_submission=1", "wait_for_submission=1&peek_submission=1"]) {
        const peek = await server.inject({
          method: "GET",
          url: `/v1/pay/approvals/${created.id}?${query}`,
          headers: { authorization: `Bearer ${agentToken}` },
        });
        expect(peek.statusCode).toBe(200);
        expect(peek.json()).toMatchObject(submission);
        const stored = await deps.pendingPaymentApprovalStore.getById(created.id);
        expect(binding === "review" ? stored?.reviewPhase : stored?.submissionPhase).toBe(
          "submitted",
        );
      }

      const delivered = await server.inject({
        method: "GET",
        url: `/v1/pay/approvals/${created.id}?read_submission=1`,
        headers: { authorization: `Bearer ${agentToken}` },
      });
      expect(delivered.statusCode).toBe(200);
      expect(delivered.json()).toMatchObject(submission);
      const stored = await deps.pendingPaymentApprovalStore.getById(created.id);
      expect(binding === "review" ? stored?.reviewPhase : stored?.submissionPhase).toBe(
        "delivered",
      );
    },
  );

  it("retains a peeked final candidate past the long-poll window until confirmation", async () => {
    const created = await createApproval();
    const submission = makeSubmission(created);
    const approved = await server.inject({
      method: "POST",
      url: `/v1/pay/approvals/${created.id}/approve`,
      payload: submission,
    });
    expect(approved.statusCode).toBe(202);

    const peek = await server.inject({
      method: "GET",
      url: `/v1/pay/approvals/${created.id}?wait_for_submission=1&peek_submission=1`,
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(peek.statusCode).toBe(200);
    expect(peek.json()).toMatchObject(submission);

    nowMs += 15_001;
    const completionRead = await server.inject({
      method: "GET",
      url: `/v1/pay/approvals/${created.id}?read_submission=1`,
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(completionRead.statusCode).toBe(200);
    expect(completionRead.json()).toMatchObject({ status: "pending", ...submission });

    const confirm = await server.inject({
      method: "POST",
      url: `/v1/pay/approvals/${created.id}/confirm`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: submission,
    });
    expect(confirm.statusCode).toBe(200);
    expect(confirm.json()).toEqual({ status: "approved" });
  });

  // Regression (Aug 2026 money-path outage): the deployed operator echoes the
  // approval's card_ref in its /confirm body (pay-operator.ts candidate). The
  // #432 bare-.strict() schema rejected that key, 400ing every confirm after
  // the user had already passkey-approved. The extra key must be accepted —
  // and ignored: the server record stays the only card_ref authority.
  it("confirms a candidate whose body carries the operator's extra card_ref key", async () => {
    const created = await createApproval();
    const submission = makeSubmission(created);
    const relayed = await relaySubmission(created.id, submission);
    expect(relayed.approvalStatus).toBe(202);

    const confirm = await server.inject({
      method: "POST",
      url: `/v1/pay/approvals/${created.id}/confirm`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { ...submission, card_ref: "card_synthetic_1" },
    });
    expect(confirm.statusCode).toBe(200);
    expect(confirm.json()).toEqual({ status: "approved" });

    // A null card_ref (card-less JIT candidates serialize null) is accepted too.
    const second = await createApproval();
    const secondSubmission = makeSubmission(second);
    const secondRelayed = await relaySubmission(second.id, secondSubmission);
    expect(secondRelayed.approvalStatus).toBe(202);
    const nullConfirm = await server.inject({
      method: "POST",
      url: `/v1/pay/approvals/${second.id}/confirm`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { ...secondSubmission, card_ref: null },
    });
    expect(nullConfirm.statusCode).toBe(200);
    expect(nullConfirm.json()).toEqual({ status: "approved" });

    // Any OTHER unknown key is still rejected — the schema stays strict.
    const third = await createApproval();
    const thirdSubmission = makeSubmission(third);
    const thirdRelayed = await relaySubmission(third.id, thirdSubmission);
    expect(thirdRelayed.approvalStatus).toBe(202);
    const unknownKey = await server.inject({
      method: "POST",
      url: `/v1/pay/approvals/${third.id}/confirm`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { ...thirdSubmission, unexpected: "key" },
    });
    expect(unknownKey.statusCode).toBe(400);
    expect(unknownKey.json()).toMatchObject({ error: "invalid_request" });
  });

  it("reads a past pending approval as expired", async () => {
    const created = await createApproval();
    nowMs += 10 * 60 * 1000 + 1;
    const response = await server.inject({
      method: "GET",
      url: `/v1/pay/approvals/${created.id}`,
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: created.id, status: "expired" });

    const approve = await server.inject({
      method: "POST",
      url: `/v1/pay/approvals/${created.id}/approve`,
      payload: makeSubmission(created),
    });
    expect(approve.statusCode).toBe(409);
    expect(approve.json()).toEqual({ error: "payment_approval_expired" });
  });

  it("returns a denial committed at the approval wait deadline", async () => {
    const created = await createApproval();
    const peek = vi
      .spyOn(deps.pendingPaymentApprovalStore, "peekRelayCandidateForAccount")
      .mockImplementationOnce(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        await deps.pendingPaymentApprovalStore.deny(created.id, new Date(nowMs));
        return null;
      });

    try {
      const status = await server.inject({
        method: "GET",
        url: `/v1/pay/approvals/${created.id}?wait_for_submission=1&peek_submission=1&wait_ms=1`,
        headers: { authorization: `Bearer ${agentToken}` },
      });

      expect(status.statusCode).toBe(200);
      expect(status.json()).toMatchObject({ status: "denied", jws: null, sealed_card: null });
    } finally {
      peek.mockRestore();
    }
  });

  it("pushes to Telegram on create when the account has a linked chat", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "synthetic-bot-token");
    const account = await deps.accountStore.findAccountByEmail("payer@example.test");
    await deps.accountStore.setTelegramChatId(account!.id, "555000111");

    const created = await createApproval();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.telegram.org/botsynthetic-bot-token/sendMessage");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.chat_id).toBe("555000111");
    expect(body.text).toContain("USD 25.99");
    expect(body.text).toContain(`/vault/pay/${created.id}`);
  });

  it("uses truthful generic card copy for a cardless Telegram approval", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "synthetic-bot-token");
    const account = await deps.accountStore.findAccountByEmail("payer@example.test");
    await deps.accountStore.setTelegramChatId(account!.id, "555000111");

    const created = await createCardlessApproval();

    const approvalCall = fetchMock.mock.calls.find(([, init]) =>
      ((init as RequestInit).body?.toString() ?? "").includes(`/vault/pay/${created.id}`),
    );
    const body = JSON.parse((approvalCall![1] as RequestInit).body as string);
    expect(body.text).toContain("A card will be entered during checkout.");
    expect(body.text).not.toContain("your saved card");
  });

  it("names the bound card (label + last4) in the Telegram approval prompt, with no secret fields", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "synthetic-bot-token");
    const account = await deps.accountStore.findAccountByEmail("payer@example.test");
    await deps.accountStore.setTelegramChatId(account!.id, "555000111");
    const cardId = await createOwnedCard(webCookie, "9192");
    const blob = '{ "ciphertext": "synthetic-sealed-card" }';

    const created = await createApproval(cardId);

    // The card-store audit also pushes a vault alert, so locate the approval
    // push by its vault URL rather than assuming a single call.
    const approvalCall = fetchMock.mock.calls.find(([, init]) =>
      ((init as RequestInit).body?.toString() ?? "").includes(`/vault/pay/${created.id}`),
    );
    expect(approvalCall).toBeTruthy();
    const body = JSON.parse((approvalCall![1] as RequestInit).body as string);
    expect(body.chat_id).toBe("555000111");
    expect(body.text).toContain("Synthetic Visa •••• 9192");
    expect(body.text).toContain(`/vault/pay/${created.id}`);
    // The sealed blob and the raw PAN never render.
    expect(body.text).not.toContain("synthetic-sealed-card");
    expect(body.text).not.toContain(blob);
  });

  it("formats zero-decimal approval currencies without fake cents in Telegram", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "synthetic-bot-token");
    const account = await deps.accountStore.findAccountByEmail("payer@example.test");
    await deps.accountStore.setTelegramChatId(account!.id, "555000111");

    const response = await server.inject({
      method: "POST",
      url: "/v1/pay/approvals",
      headers: { authorization: `Bearer ${agentToken}`, "x-squire-agent-identity": "Hermes" },
      payload: {
        merchant: "Japan Flower Shop",
        checkout_origin: "https://flowers.example.test",
        amount_cents: 9845,
        currency: "JPY",
        card_ref: "card_synthetic_1",
        operator_pubkey: "c3ludGhldGljLW9wZXJhdG9yLWtleQ",
        item: "Flowers",
        reason: "Synthetic test purchase",
      },
    });
    expect(response.statusCode).toBe(201);

    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.text).toContain("JPY 9845");
    expect(body.text).not.toContain("JPY 98.45");
  });

  it("does not push to Telegram when the account has no linked chat", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "synthetic-bot-token");

    await createApproval();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("notifies Telegram when 3-D Secure is required", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "synthetic-bot-token");
    const account = await deps.accountStore.findAccountByEmail("payer@example.test");
    await deps.accountStore.setTelegramChatId(account!.id, "555000111");
    const created = await createApproval();
    fetchMock.mockClear();

    const response = await server.inject({
      method: "POST",
      url: `/v1/pay/approvals/${created.id}/notify-3ds`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { mode: "detected_challenge" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ sent: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.text).toContain("Synthetic Books");
    expect(body.text).toContain("USD 25.99");
    expect(body.text).toContain("bank app");
    expect(body.text).toContain("3-D Secure required");
  });

  it("uses cautious Telegram copy for possible out-of-band authentication", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "synthetic-bot-token");
    const account = await deps.accountStore.findAccountByEmail("payer@example.test");
    await deps.accountStore.setTelegramChatId(account!.id, "555000111");
    const created = await createApproval();
    fetchMock.mockClear();

    const response = await server.inject({
      method: "POST",
      url: `/v1/pay/approvals/${created.id}/notify-3ds`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { mode: "possible_out_of_band" },
    });

    expect(response.statusCode).toBe(200);
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.text).toContain("Authentication may be happening out of band");
    expect(body.text).toContain("Check your bank app");
    expect(body.text).not.toContain("3-D Secure required");
  });

  it("formats zero-decimal currencies without fake cents in 3-D Secure Telegram messages", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "synthetic-bot-token");
    const account = await deps.accountStore.findAccountByEmail("payer@example.test");
    await deps.accountStore.setTelegramChatId(account!.id, "555000111");

    const created = await server.inject({
      method: "POST",
      url: "/v1/pay/approvals",
      headers: { authorization: `Bearer ${agentToken}`, "x-squire-agent-identity": "Hermes" },
      payload: {
        merchant: "Japan Flower Shop",
        checkout_origin: "https://flowers.example.test",
        amount_cents: 9845,
        currency: "JPY",
        card_ref: "card_synthetic_1",
        operator_pubkey: "c3ludGhldGljLW9wZXJhdG9yLWtleQ",
        item: "Flowers",
        reason: "Synthetic test purchase",
      },
    });
    expect(created.statusCode).toBe(201);
    fetchMock.mockClear();

    const response = await server.inject({
      method: "POST",
      url: `/v1/pay/approvals/${(created.json() as { id: string }).id}/notify-3ds`,
      headers: { authorization: `Bearer ${agentToken}` },
    });

    expect(response.statusCode).toBe(200);
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.text).toContain("JPY 9845");
    expect(body.text).not.toContain("JPY 98.45");
  });

  it("does not notify Telegram about 3-D Secure without a linked chat", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "synthetic-bot-token");
    const created = await createApproval();

    const response = await server.inject({
      method: "POST",
      url: `/v1/pay/approvals/${created.id}/notify-3ds`,
      headers: { authorization: `Bearer ${agentToken}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ sent: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns not found when notifying for another account's approval", async () => {
    const created = await createApproval();
    const response = await server.inject({
      method: "POST",
      url: `/v1/pay/approvals/${created.id}/notify-3ds`,
      headers: { authorization: `Bearer ${otherAgentToken}` },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "not_found" });
  });

  // ── JIT add-card ceremony: card-less create → bind → approve ──────────

  it("gives a card-less JIT create an 18-min TTL and a has-card create 10 min", async () => {
    // nowMs is pinned to 2026-07-23T12:00:00.000Z in beforeEach.
    const cardless = await createCardlessApproval();
    expect(cardless).toMatchObject({});
    const cardlessGet = await server.inject({
      method: "GET",
      url: `/v1/pay/approvals/${cardless.id}`,
      headers: { authorization: `Bearer ${agentToken}` },
    });
    // 12:00:00 + 18 min.
    expect((cardlessGet.json() as { expires_at: string }).expires_at).toBe(
      "2026-07-23T12:18:00.000Z",
    );

    const hasCard = await createApproval();
    // createApproval sends card_ref → keeps the 10-min tap window.
    expect(hasCard.expires_at).toBe("2026-07-23T12:10:00.000Z");
  });

  it("creates a card-less approval (JIT add-card handle) with a null card_ref", async () => {
    const created = await createCardlessApproval();
    const get = await server.inject({
      method: "GET",
      url: `/v1/pay/approvals/${created.id}`,
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(get.statusCode).toBe(200);
    // Card-less, but the operator pubkey is minted at create regardless.
    expect(get.json()).toMatchObject({
      card_ref: null,
      operator_pubkey: "c3ludGhldGljLW9wZXJhdG9yLWtleQ",
      status: "pending",
    });
  });

  it("binds an owned card to a card-less approval, then approve succeeds", async () => {
    const created = await createCardlessApproval();
    const cardId = await createOwnedCard(webCookie);

    const bind = await server.inject({
      method: "POST",
      url: `/v1/pay/approvals/${created.id}/bind-card`,
      headers: { cookie: webCookie },
      payload: { card_ref: cardId },
    });
    expect(bind.statusCode).toBe(200);
    expect(bind.json()).toEqual({ card_ref: cardId });

    const get = await server.inject({
      method: "GET",
      url: `/v1/pay/approvals/${created.id}`,
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(get.json()).toMatchObject({ card_ref: cardId });

    const bound = get.json() as { id: string; nonce: string; card_ref: string };
    const submission = makeSubmission(bound);
    const approve = await relaySubmission(created.id, submission);
    expect(approve.approvalStatus).toBe(202);
    expect(approve.relayed).toMatchObject(submission);

    const confirm = await server.inject({
      method: "POST",
      url: `/v1/pay/approvals/${created.id}/confirm`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: submission,
    });
    expect(confirm.statusCode).toBe(200);
  });

  it("refuses to approve a card-less approval (409 card_required)", async () => {
    const created = await createCardlessApproval();
    const approve = await server.inject({
      method: "POST",
      url: `/v1/pay/approvals/${created.id}/approve`,
      payload: { jws: "synthetic.header.sig", sealed_card: "sealed" },
    });
    expect(approve.statusCode).toBe(409);
    expect(approve.json()).toEqual({ error: "card_required" });
  });

  it("rejects binding an owned card after the approval expires", async () => {
    const created = await createCardlessApproval();
    const cardId = await createOwnedCard(webCookie, "0007");
    // Card-less approvals get an 18-min JIT TTL — advance past it. That also
    // exceeds the 15-min web-session idle window, so re-mint the cookie (a
    // real user is still signed in) to isolate approval expiry from session
    // expiry.
    nowMs += 18 * 60 * 1000 + 1;
    const payer = await deps.accountStore.findAccountByEmail("payer@example.test");
    const freshCookie = await makeWebSession(deps, payer!.id, new Date(nowMs));

    const bind = await server.inject({
      method: "POST",
      url: `/v1/pay/approvals/${created.id}/bind-card`,
      headers: { cookie: freshCookie },
      payload: { card_ref: cardId },
    });
    expect(bind.statusCode).toBe(409);
    expect(bind.json()).toEqual({ error: "payment_approval_expired" });

    const get = await server.inject({
      method: "GET",
      url: `/v1/pay/approvals/${created.id}`,
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(get.json()).toMatchObject({ status: "expired", card_ref: null });
  });

  it("is write-once: a second bind on an already-bound approval is rejected", async () => {
    const created = await createCardlessApproval();
    const firstCard = await createOwnedCard(webCookie, "4242");
    const secondCard = await createOwnedCard(webCookie, "1111");

    const bind1 = await server.inject({
      method: "POST",
      url: `/v1/pay/approvals/${created.id}/bind-card`,
      headers: { cookie: webCookie },
      payload: { card_ref: firstCard },
    });
    expect(bind1.statusCode).toBe(200);

    const bind2 = await server.inject({
      method: "POST",
      url: `/v1/pay/approvals/${created.id}/bind-card`,
      headers: { cookie: webCookie },
      payload: { card_ref: secondCard },
    });
    expect(bind2.statusCode).toBe(409);
    expect(bind2.json()).toEqual({ error: "card_already_bound" });

    // The originally-bound card is unchanged.
    const get = await server.inject({
      method: "GET",
      url: `/v1/pay/approvals/${created.id}`,
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(get.json()).toMatchObject({ card_ref: firstCard });
  });

  it("rejects binding a card owned by a different account (404 card_not_found)", async () => {
    const created = await createCardlessApproval();
    const foreignCard = await createOwnedCard(otherWebCookie);

    const bind = await server.inject({
      method: "POST",
      url: `/v1/pay/approvals/${created.id}/bind-card`,
      headers: { cookie: webCookie },
      payload: { card_ref: foreignCard },
    });
    expect(bind.statusCode).toBe(404);
    expect(bind.json()).toEqual({ error: "card_not_found" });

    // The approval stays card-less — no foreign card leaked in.
    const get = await server.inject({
      method: "GET",
      url: `/v1/pay/approvals/${created.id}`,
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(get.json()).toMatchObject({ card_ref: null });
  });

  it("keeps an approval card-less when its selected card was deleted", async () => {
    const created = await createCardlessApproval();
    const deletedCard = await createOwnedCard(webCookie, "1001");
    const deleted = await server.inject({
      method: "DELETE",
      url: `/v1/vault/e2e/${deletedCard}`,
      headers: { cookie: webCookie },
    });
    expect(deleted.statusCode).toBe(204);

    const rejected = await server.inject({
      method: "POST",
      url: `/v1/pay/approvals/${created.id}/bind-card`,
      headers: { cookie: webCookie },
      payload: { card_ref: deletedCard },
    });
    expect(rejected.statusCode).toBe(404);
    expect(rejected.json()).toEqual({ error: "card_not_found" });

    const pending = await server.inject({
      method: "GET",
      url: `/v1/pay/approvals/${created.id}`,
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(pending.statusCode).toBe(200);
    expect(pending.json()).toMatchObject({ card_ref: null, status: "pending" });

    const freshCard = await createOwnedCard(webCookie, "1002");
    const rebound = await server.inject({
      method: "POST",
      url: `/v1/pay/approvals/${created.id}/bind-card`,
      headers: { cookie: webCookie },
      payload: { card_ref: freshCard },
    });
    expect(rebound.statusCode).toBe(200);
    expect(rebound.json()).toEqual({ card_ref: freshCard });
  });

  it("rejects binding a card to another account's approval (404 not_found)", async () => {
    const created = await createCardlessApproval();
    const otherCard = await createOwnedCard(otherWebCookie);

    const bind = await server.inject({
      method: "POST",
      url: `/v1/pay/approvals/${created.id}/bind-card`,
      headers: { cookie: otherWebCookie },
      payload: { card_ref: otherCard },
    });
    expect(bind.statusCode).toBe(404);
    expect(bind.json()).toEqual({ error: "payment_approval_not_found" });
  });

  it("is pending-only: cannot rebind after the approval is approved", async () => {
    const created = await createCardlessApproval();
    const cardId = await createOwnedCard(webCookie);

    await server.inject({
      method: "POST",
      url: `/v1/pay/approvals/${created.id}/bind-card`,
      headers: { cookie: webCookie },
      payload: { card_ref: cardId },
    });
    const current = await server.inject({
      method: "GET",
      url: `/v1/pay/approvals/${created.id}`,
      headers: { authorization: `Bearer ${agentToken}` },
    });
    const submission = makeSubmission(current.json());
    const approve = await relaySubmission(created.id, submission);
    expect(approve.approvalStatus).toBe(202);

    const confirm = await server.inject({
      method: "POST",
      url: `/v1/pay/approvals/${created.id}/confirm`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: submission,
    });
    expect(confirm.statusCode).toBe(200);

    const rebind = await server.inject({
      method: "POST",
      url: `/v1/pay/approvals/${created.id}/bind-card`,
      headers: { cookie: webCookie },
      payload: { card_ref: cardId },
    });
    expect(rebind.statusCode).toBe(409);
    expect(rebind.json()).toEqual({ error: "payment_approval_not_pending" });
  });

  it("denies cross-account reads and rejects a wrong-account submission", async () => {
    const created = await createApproval();
    const get = await server.inject({
      method: "GET",
      url: `/v1/pay/approvals/${created.id}`,
      headers: { authorization: `Bearer ${otherAgentToken}` },
    });
    expect(get.statusCode).toBe(404);

    const otherCreatedResponse = await server.inject({
      method: "POST",
      url: "/v1/pay/approvals",
      headers: { authorization: `Bearer ${otherAgentToken}` },
      payload: {
        merchant: "Other Merchant",
        checkout_origin: "https://other.synthetic.test",
        amount_cents: 100,
        currency: "USD",
        card_ref: "other_card",
        operator_pubkey: "b3RoZXItb3BlcmF0b3Ita2V5",
        item: "Other Item",
        reason: "Other reason",
      },
    });
    const otherCreated = otherCreatedResponse.json() as { id: string; nonce: string };
    const approve = await server.inject({
      method: "POST",
      url: `/v1/pay/approvals/${created.id}/approve`,
      payload: makeSubmission({
        ...otherCreated,
        merchant: "Other Merchant",
        checkout_origin: "https://other.synthetic.test",
        amount_cents: 100,
        card_ref: "other_card",
        operator_pubkey: "b3RoZXItb3BlcmF0b3Ita2V5",
        item: "Other Item",
        reason: "Other reason",
        agent: "synthetic-payment-test-agent",
      }),
    });
    expect(approve.statusCode).toBe(403);
    expect(approve.json()).toEqual({ error: "payment_approval_binding_mismatch" });
  });

  it("rejects replaying a submission bound to a different approval", async () => {
    const cardId = await createOwnedCard(webCookie);
    const first = await createApproval(cardId);
    const second = await createApproval(cardId);
    const approvalReplay = await server.inject({
      method: "POST",
      url: `/v1/pay/approvals/${second.id}/approve`,
      payload: makeSubmission({ ...first, card_ref: cardId }),
    });
    expect(approvalReplay.statusCode).toBe(403);
    expect(approvalReplay.json()).toEqual({ error: "payment_approval_binding_mismatch" });

    const firstCeremony = await server.inject({
      method: "GET",
      url: `/v1/pay/approvals/${first.id}/ceremony`,
    });
    const reviewReplay = await server.inject({
      method: "POST",
      url: `/v1/pay/approvals/${second.id}/approve`,
      payload: makeReviewSubmission(firstCeremony.json()),
    });
    expect(reviewReplay.statusCode).toBe(403);
    expect(reviewReplay.json()).toEqual({ error: "payment_approval_binding_mismatch" });
  });
});
