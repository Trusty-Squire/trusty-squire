import { createHash, generateKeyPairSync, type KeyObject } from "node:crypto";
import canonicalize from "canonicalize";
import { exportJWK, SignJWT } from "jose";
import { describe, expect, it, vi } from "vitest";
import { ApiClient } from "../../api-client.js";
import { executeOperatePay, type PaymentBrowser } from "../pay-operator.js";
import { generateOperatorKeypair, sealToRecipient } from "../payment-hpke.js";
import type { CheckoutCard, CheckoutSummary } from "../browser.js";

const CHECKOUT = {
  merchant: "Synthetic Merchant",
  checkout_origin: "https://checkout.synthetic.test",
  amount_cents: 2_599,
  currency: "USD",
};

const SYNTHETIC_CARD = {
  pan: "4242424242424242",
  exp_month: "12",
  exp_year: "30",
  name: "Synthetic Cardholder",
  cvv: "123",
  billing: {
    line1: "123 Test Street",
    line2: "Suite 4",
    city: "Testville",
    state: "NY",
    postal_code: "10001",
    country: "US",
  },
};

type Mode =
  | "happy"
  | "confirm_response_lost"
  | "confirm_response_lost_changed"
  | "junk_then_happy"
  | "tampered_amount"
  | "tampered_origin"
  | "wrong_recipient"
  | "wrong_issuer"
  | "wrong_audience"
  | "audit_failure"
  | "low_confidence";

async function harness(
  mode: Mode,
  expectedAudience: string | null = "customer_test",
  apiAudience?: string,
  threeDs?: {
    resolution: "succeeded" | "failed" | "timeout";
    waitSeconds?: number;
    notifyNeverResolves?: boolean;
  },
) {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const jwk = await exportJWK(publicKey);
  const auditBodies: unknown[] = [];
  const approvalBodies: Array<Record<string, unknown>> = [];
  const filledCards: CheckoutCard[] = [];
  const notifyCalls: string[] = [];
  const resolvedCardRefs: string[] = [];
  const confirmationBodies: Array<Record<string, unknown>> = [];
  const nonce = "synthetic-nonce";
  const agent = "synthetic-payment-test-agent";
  let approvalPolls = 0;
  let confirmedCandidate: Record<string, unknown> | undefined;

  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === "https://vouchflow.test/.well-known/jwks.json") {
      return Response.json({ keys: [{ ...jwk, alg: "RS256", use: "sig", kid: "test-key" }] });
    }
    if (url.endsWith("/v1/pay/config") && init?.method === "GET") {
      return Response.json(apiAudience === undefined ? {} : { vouchflow_audience: apiAudience });
    }
    if (url.endsWith("/v1/pay/approvals") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      approvalBodies.push(body);
      return Response.json(
        {
          id: "approval_test",
          nonce,
          agent,
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        },
        { status: 201 },
      );
    }
    if (url.endsWith("/v1/pay/approvals/approval_test") && init?.method === "GET") {
      approvalPolls += 1;
      const approval = approvalBodies[0]!;
      const operatorPublicKey = String(approval.operator_pubkey);
      if (confirmedCandidate !== undefined) {
        return Response.json({
          id: "approval_test",
          status: "approved",
          ...CHECKOUT,
          nonce,
          card_ref: "card_test",
          operator_pubkey: operatorPublicKey,
          jws: confirmedCandidate.jws,
          sealed_card: confirmedCandidate.sealed_card,
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        });
      }
      const recipientHash = createHash("sha256")
        .update(Buffer.from(operatorPublicKey, "base64url"))
        .digest("base64url");
      const payload = {
        approval_id: "approval_test",
        merchant: CHECKOUT.merchant,
        checkout_origin:
          mode === "tampered_origin" ? "https://evil.synthetic.test" : CHECKOUT.checkout_origin,
        amount_cents:
          mode === "tampered_amount" ? CHECKOUT.amount_cents + 1 : CHECKOUT.amount_cents,
        currency: CHECKOUT.currency,
        nonce,
        card_ref: "card_test",
        recipient_pubkey_hash: recipientHash,
        item: approval.item,
        reason: approval.reason,
        agent,
      };
      const canonical = canonicalize(payload)!;
      const aad = createHash("sha256").update(canonical, "utf8").digest();
      const assertion = await new SignJWT({
        payload_sha256: aad.toString("base64url"),
        context: "purchase",
        confidence: mode === "low_confidence" ? "low" : "high",
        mandate_id: "mandate_test",
      })
        .setProtectedHeader({ alg: "RS256", kid: "test-key" })
        .setIssuer(
          mode === "wrong_issuer" ? "https://other-issuer.example" : "https://vouchflow.dev",
        )
        .setAudience(mode === "wrong_audience" ? "other-customer" : "customer_test")
        .sign(privateKey);
      const recipient =
        mode === "wrong_recipient"
          ? (await generateOperatorKeypair()).publicKey
          : operatorPublicKey;
      const sealedCard = await sealToRecipient(
        recipient,
        new TextEncoder().encode(JSON.stringify(SYNTHETIC_CARD)),
        aad,
      );
      return Response.json({
        id: "approval_test",
        status:
          mode === "happy" ||
          mode === "confirm_response_lost" ||
          mode === "confirm_response_lost_changed" ||
          mode === "junk_then_happy"
            ? "pending"
            : "approved",
        ...CHECKOUT,
        nonce,
        card_ref: "card_test",
        operator_pubkey: operatorPublicKey,
        jws: assertion,
        sealed_card: mode === "junk_then_happy" && approvalPolls === 1 ? "junk" : sealedCard,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      });
    }
    if (url.endsWith("/v1/pay/approvals/approval_test/confirm") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      confirmationBodies.push(body);
      confirmedCandidate =
        mode === "confirm_response_lost_changed"
          ? { ...body, sealed_card: "different-candidate" }
          : body;
      if (mode === "confirm_response_lost" || mode === "confirm_response_lost_changed") {
        throw new TypeError("confirm response lost");
      }
      return Response.json({ status: "approved" });
    }
    if (url.endsWith("/v1/pay/approvals/approval_test/notify-3ds") && init?.method === "POST") {
      notifyCalls.push(url);
      if (threeDs?.notifyNeverResolves === true) {
        return new Promise<Response>(() => undefined);
      }
      return Response.json({ sent: true });
    }
    if (url.endsWith("/v1/vault/payments/audit") && init?.method === "POST") {
      auditBodies.push(JSON.parse(String(init.body)) as unknown);
      if (mode === "audit_failure") {
        return Response.json({ error: "audit_unavailable" }, { status: 503 });
      }
      return Response.json({ id: "audit_test" }, { status: 201 });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  }) as typeof fetch;

  const browser: PaymentBrowser = {
    isPayPalHostedCheckout: vi.fn().mockResolvedValue(false),
    readCheckoutSummary: vi.fn().mockResolvedValue(CHECKOUT),
    currentUrl: vi.fn().mockReturnValue(`${CHECKOUT.checkout_origin}/session/test`),
    fillAndSubmitCheckout: vi.fn(async (card: CheckoutCard) => {
      filledCards.push(card);
      return threeDs === undefined
        ? { three_ds_required: false }
        : {
            three_ds_required: true,
            challenge_url: "https://issuer.synthetic.test/challenge",
          };
    }),
    waitForThreeDsResolution: vi.fn().mockResolvedValue(threeDs?.resolution ?? "timeout"),
  };
  const api = new ApiClient({
    apiBaseUrl: "https://api.test",
    registryBaseUrl: "https://registry.test",
    agentSessionToken: "synthetic-session-token",
    fetch: fetchMock,
  });
  api.setRequestingAgent("Hermes");
  const result = await executeOperatePay(
    {
      card_ref: "card_test",
      merchant: "Agent Supplied Merchant",
      amount_cents: 1,
      currency: "EUR",
      item: "Wireless Mouse",
      reason: "office restock",
      ...(threeDs?.waitSeconds !== undefined ? { three_ds_wait_seconds: threeDs.waitSeconds } : {}),
    },
    api,
    browser,
    {
      fetch: fetchMock,
      sleep: async () => undefined,
      vouchflowApiBase: "https://vouchflow.test",
      vouchflowExpectedAudience: expectedAudience ?? undefined,
      webBase: "https://web.test",
      surfaceApprovalUrl: vi.fn(),
      onCardResolved: (cardRef) => resolvedCardRefs.push(cardRef),
    },
  );

  return {
    result,
    approvalBodies,
    auditBodies,
    filledCards,
    notifyCalls,
    resolvedCardRefs,
    confirmationBodies,
    browser,
  };
}

describe("operate_pay", () => {
  it("verifies the mandate, opens the card, fills the checkout, and audits last4 only", async () => {
    const {
      result,
      approvalBodies,
      auditBodies,
      filledCards,
      resolvedCardRefs,
      confirmationBodies,
    } =
      await harness("happy");

    expect(result).toMatchObject({
      status: "payment_submitted",
      merchant: CHECKOUT.merchant,
      amount_cents: CHECKOUT.amount_cents,
      currency: CHECKOUT.currency,
    });
    expect(approvalBodies[0]).toMatchObject({
      ...CHECKOUT,
      card_ref: "card_test",
      item: "Wireless Mouse",
      reason: "office restock",
    });
    expect(approvalBodies[0]).not.toHaveProperty("agent");
    expect(filledCards).toEqual([SYNTHETIC_CARD]);
    expect(resolvedCardRefs).toEqual(["card_test"]);
    expect(confirmationBodies).toHaveLength(1);
    expect(auditBodies).toEqual([
      {
        merchant: CHECKOUT.merchant,
        amountCents: CHECKOUT.amount_cents,
        currency: CHECKOUT.currency,
        last4: "4242",
        status: "payment_submitted",
        mandateId: "mandate_test",
      },
    ]);
    const auditJson = JSON.stringify(auditBodies);
    expect(auditJson).not.toContain(SYNTHETIC_CARD.pan);
    expect(auditJson).not.toContain(SYNTHETIC_CARD.cvv);
  });

  it("ignores a junk pending seal and confirms a valid replacement", async () => {
    const { result, filledCards, confirmationBodies } = await harness("junk_then_happy");

    expect(result).toMatchObject({ status: "payment_submitted" });
    expect(filledCards).toEqual([SYNTHETIC_CARD]);
    expect(confirmationBodies).toHaveLength(1);
    expect(confirmationBodies[0]).not.toMatchObject({ sealed_card: "junk" });
  });

  it("reconciles a lost confirm response before submitting payment", async () => {
    const { result, filledCards, confirmationBodies } = await harness("confirm_response_lost");

    expect(result).toMatchObject({ status: "payment_submitted" });
    expect(filledCards).toEqual([SYNTHETIC_CARD]);
    expect(confirmationBodies).toHaveLength(1);
  });

  it("does not reconcile a lost response to a different approved candidate", async () => {
    await expect(harness("confirm_response_lost_changed")).rejects.toThrow("confirm response lost");
  });

  it("rejects a validly-signed mandate whose amount differs from the live checkout", async () => {
    const { result, auditBodies, filledCards } = await harness("tampered_amount");

    expect(result).toMatchObject({
      status: "payment_mandate_rejected",
      reason: "payload_hash_mismatch",
    });
    expect(filledCards).toHaveLength(0);
    expect(auditBodies).toHaveLength(0);
  });

  it("rejects a mandate bound to a different checkout origin", async () => {
    const { result, auditBodies, filledCards } = await harness("tampered_origin");

    expect(result).toMatchObject({
      status: "payment_mandate_rejected",
      reason: "payload_hash_mismatch",
    });
    expect(filledCards).toHaveLength(0);
    expect(auditBodies).toHaveLength(0);
  });

  it("preserves the submitted outcome when audit recording fails", async () => {
    const { result, filledCards } = await harness("audit_failure");

    expect(result).toMatchObject({
      status: "payment_submitted",
      audit_recorded: false,
    });
    expect(filledCards).toEqual([SYNTHETIC_CARD]);
  });

  it("fails closed when the card was sealed to a different operator key", async () => {
    const { result, auditBodies, filledCards } = await harness("wrong_recipient");

    expect(result).toMatchObject({ status: "payment_card_open_failed" });
    expect(filledCards).toHaveLength(0);
    expect(auditBodies).toHaveLength(0);
  });

  it("rejects a mandate issued for another Vouchflow customer", async () => {
    const { result, auditBodies, filledCards } = await harness("wrong_audience");

    expect(result).toMatchObject({
      status: "payment_mandate_rejected",
      reason: "mandate_verification_failed",
    });
    expect(filledCards).toHaveLength(0);
    expect(auditBodies).toHaveLength(0);
  });

  it("rejects a mandate from another issuer", async () => {
    const { result, auditBodies, filledCards } = await harness("wrong_issuer");

    expect(result).toMatchObject({
      status: "payment_mandate_rejected",
      reason: "mandate_verification_failed",
    });
    expect(filledCards).toHaveLength(0);
    expect(auditBodies).toHaveLength(0);
  });

  it("fails closed when the expected Vouchflow audience is not configured", async () => {
    const { result, auditBodies, filledCards } = await harness("happy", null);

    expect(result).toMatchObject({
      status: "payment_configuration_error",
      reason: "vouchflow_expected_audience_unset",
      configuration: "Set VOUCHFLOW_CUSTOMER_ID on the Trusty Squire API.",
    });
    expect(filledCards).toHaveLength(0);
    expect(auditBodies).toHaveLength(0);
  });

  it("uses the authenticated API audience when the environment override is absent", async () => {
    const { result, filledCards } = await harness("happy", null, "customer_test");

    expect(result).toMatchObject({ status: "payment_submitted" });
    expect(filledCards).toEqual([SYNTHETIC_CARD]);
  });

  it("accepts a low-confidence mandate (web passkeys are capped low)", async () => {
    const { result, filledCards } = await harness("low_confidence");

    expect(result).toMatchObject({ status: "payment_submitted" });
    expect(filledCards).toEqual([SYNTHETIC_CARD]);
  });

  it("notifies and records submitted when the 3DS challenge succeeds", async () => {
    const { result, auditBodies, notifyCalls, browser } = await harness(
      "happy",
      "customer_test",
      undefined,
      { resolution: "succeeded" },
    );

    expect(result).toMatchObject({ status: "payment_submitted" });
    expect(notifyCalls).toHaveLength(1);
    expect(browser.waitForThreeDsResolution).toHaveBeenCalledWith(180_000);
    expect(auditBodies).toEqual([expect.objectContaining({ status: "payment_submitted" })]);
  });

  it("does not wait for notification delivery before resolving 3DS", async () => {
    const { result, notifyCalls, browser } = await harness("happy", "customer_test", undefined, {
      resolution: "succeeded",
      notifyNeverResolves: true,
    });

    expect(result).toMatchObject({ status: "payment_submitted" });
    expect(notifyCalls).toHaveLength(1);
    expect(browser.waitForThreeDsResolution).toHaveBeenCalledWith(180_000);
  });

  it("notifies and hands back when the 3DS challenge times out", async () => {
    const { result, notifyCalls } = await harness("happy", "customer_test", undefined, {
      resolution: "timeout",
    });

    expect(result).toMatchObject({
      status: "payment_3ds_required",
      needs_user: { wall: "3ds", resume: "checkout" },
    });
    expect(notifyCalls).toHaveLength(1);
  });

  it("records declined when the 3DS challenge fails", async () => {
    const { result, auditBodies, notifyCalls } = await harness(
      "happy",
      "customer_test",
      undefined,
      { resolution: "failed" },
    );

    expect(result).toMatchObject({ status: "payment_declined" });
    expect(result).not.toHaveProperty("merchant");
    expect(notifyCalls).toHaveLength(1);
    expect(auditBodies).toEqual([expect.objectContaining({ status: "payment_declined" })]);
  });

  it("hands back immediately without notifying when the 3DS wait is disabled", async () => {
    const { result, notifyCalls, browser } = await harness("happy", "customer_test", undefined, {
      resolution: "timeout",
      waitSeconds: 0,
    });

    expect(result).toMatchObject({
      status: "payment_3ds_required",
      needs_user: { wall: "3ds", resume: "checkout" },
    });
    expect(notifyCalls).toHaveLength(0);
    expect(browser.waitForThreeDsResolution).not.toHaveBeenCalled();
  });

  // IRON-RULE regression: the has-card path must be byte-for-byte the same
  // flow it was before the JIT branch existed. The JIT-only resume re-read of
  // the live total must NOT run for a has-card payment.
  it("REGRESSION: has-card path does not re-read the checkout total on resume", async () => {
    const { result, browser } = await harness("happy");

    expect(result).toMatchObject({ status: "payment_submitted" });
    // Exactly one summary read (the initial one). A second call would mean the
    // JIT resume re-read leaked into the has-card path.
    expect(browser.readCheckoutSummary).toHaveBeenCalledTimes(1);
    expect(result).not.toHaveProperty("card_persisted");
  });
});

// ── JIT add-card ceremony (card-less approval → server-bound card_ref) ──────
//
// These exercise the money-path crypto invariant that matters most: on resume
// the operator has NO card_ref of its own (args.card_ref is absent), so it must
// re-canonicalize the mandate with the card_ref the ceremony bound SERVER-SIDE.
// Miss that and every JIT payment hash-mismatches and silently rejects.

const JIT_CHECKOUT: CheckoutSummary = {
  merchant: "Synthetic Merchant",
  checkout_origin: "https://checkout.synthetic.test",
  amount_cents: 2_599,
  currency: "USD",
};

type PollState = { status: "pending" | "approved" | "expired"; card_ref: string | null };

async function buildApprovedMandate(params: {
  operatorPubkey: string;
  privateKey: KeyObject;
  signCardRef: string;
  nonce: string;
  agent: string;
  audience?: string;
  issuer?: string;
}): Promise<{ jws: string; sealed_card: string }> {
  const recipientHash = createHash("sha256")
    .update(Buffer.from(params.operatorPubkey, "base64url"))
    .digest("base64url");
  const canonical = canonicalize({
    approval_id: "appr_jit",
    merchant: JIT_CHECKOUT.merchant,
    checkout_origin: JIT_CHECKOUT.checkout_origin,
    amount_cents: JIT_CHECKOUT.amount_cents,
    currency: JIT_CHECKOUT.currency,
    nonce: params.nonce,
    // The mandate is signed over whatever card_ref the phone saw. In the happy
    // path that equals the server-bound ref; the swap test signs a different one.
    card_ref: params.signCardRef,
    recipient_pubkey_hash: recipientHash,
    item: "Synthetic JIT item",
    reason: "Synthetic JIT purchase reason",
    agent: params.agent,
  })!;
  const aad = createHash("sha256").update(canonical, "utf8").digest();
  const jws = await new SignJWT({
    payload_sha256: aad.toString("base64url"),
    context: "purchase",
    confidence: "low",
    mandate_id: "jit-mandate",
  })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(params.issuer ?? "https://vouchflow.dev")
    .setAudience(params.audience ?? "customer_test")
    .sign(params.privateKey);
  const sealed_card = await sealToRecipient(
    params.operatorPubkey,
    new TextEncoder().encode(JSON.stringify(SYNTHETIC_CARD)),
    aad,
  );
  return { jws, sealed_card };
}

async function runJit(cfg: {
  cardRefArg?: string; // set = has-card comparison run (NOT a JIT ceremony)
  boundCardRef: string; // what the server binds + echoes as approval.card_ref
  signCardRef?: string; // what the phone signs the mandate over (default = bound)
  poll: (clockMs: number) => PollState;
  // Overrides merged into the second (resume) readCheckoutSummary — lets a test
  // drift the amount, merchant, or origin out from under the mandate.
  resumeOverride?: Partial<CheckoutSummary>;
  resumeThrows?: boolean;
  approvalTimeoutMs?: number;
  jitApprovalTimeoutMs?: number;
}): Promise<{
  result: Record<string, unknown>;
  approvalBodies: Array<Record<string, unknown>>;
  filledCards: CheckoutCard[];
  auditBodies: unknown[];
  resolvedCardRefs: string[];
  summaryReads: number;
}> {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = await exportJWK(publicKey);
  const approvalBodies: Array<Record<string, unknown>> = [];
  const filledCards: CheckoutCard[] = [];
  const auditBodies: unknown[] = [];
  const resolvedCardRefs: string[] = [];
  const nonce = "jit-nonce";
  const agent = "jit-agent";
  let clock = 0;
  let summaryReads = 0;

  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === "https://vouchflow.test/.well-known/jwks.json") {
      return Response.json({ keys: [{ ...jwk, alg: "RS256", use: "sig", kid: "test-key" }] });
    }
    if (url.endsWith("/v1/pay/approvals") && init?.method === "POST") {
      approvalBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return Response.json(
        { id: "appr_jit", nonce, agent, expires_at: new Date(8.64e15).toISOString() },
        { status: 201 },
      );
    }
    if (url.endsWith("/v1/pay/approvals/appr_jit") && init?.method === "GET") {
      const state = cfg.poll(clock);
      const operatorPubkey = String(approvalBodies[0]!.operator_pubkey);
      if (state.status === "approved") {
        const { jws, sealed_card } = await buildApprovedMandate({
          operatorPubkey,
          privateKey,
          signCardRef: cfg.signCardRef ?? cfg.boundCardRef,
          nonce,
          agent,
        });
        return Response.json({
          id: "appr_jit",
          status: "approved",
          ...JIT_CHECKOUT,
          nonce,
          card_ref: state.card_ref,
          operator_pubkey: operatorPubkey,
          jws,
          sealed_card,
          expires_at: new Date(8.64e15).toISOString(),
        });
      }
      return Response.json({
        id: "appr_jit",
        status: state.status,
        ...JIT_CHECKOUT,
        nonce,
        card_ref: state.card_ref,
        operator_pubkey: operatorPubkey,
        jws: null,
        sealed_card: null,
        expires_at: new Date(8.64e15).toISOString(),
      });
    }
    if (url.endsWith("/v1/vault/payments/audit") && init?.method === "POST") {
      auditBodies.push(JSON.parse(String(init.body)) as unknown);
      return Response.json({ id: "audit_jit" }, { status: 201 });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  }) as typeof fetch;

  const browser: PaymentBrowser = {
    isPayPalHostedCheckout: vi.fn().mockResolvedValue(false),
    readCheckoutSummary: vi.fn(async () => {
      const call = summaryReads++;
      if (call >= 1 && cfg.resumeThrows === true) {
        throw new Error("payment_checkout_total_not_found");
      }
      if (call >= 1 && cfg.resumeOverride !== undefined) {
        return { ...JIT_CHECKOUT, ...cfg.resumeOverride };
      }
      return JIT_CHECKOUT;
    }),
    currentUrl: vi.fn().mockReturnValue(`${JIT_CHECKOUT.checkout_origin}/session/test`),
    fillAndSubmitCheckout: vi.fn(async (card: CheckoutCard) => {
      filledCards.push(card);
      return { three_ds_required: false };
    }),
    waitForThreeDsResolution: vi.fn().mockResolvedValue("timeout"),
  };

  const api = new ApiClient({
    apiBaseUrl: "https://api.test",
    registryBaseUrl: "https://registry.test",
    agentSessionToken: "synthetic-session-token",
    fetch: fetchMock,
  });

  const result = (await executeOperatePay(
    {
      ...(cfg.cardRefArg !== undefined ? { card_ref: cfg.cardRefArg } : {}),
      merchant: JIT_CHECKOUT.merchant,
      amount_cents: JIT_CHECKOUT.amount_cents,
      currency: JIT_CHECKOUT.currency,
      item: "Synthetic JIT item",
      reason: "Synthetic JIT purchase reason",
    },
    api,
    browser,
    {
      fetch: fetchMock,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      vouchflowApiBase: "https://vouchflow.test",
      vouchflowExpectedAudience: "customer_test",
      webBase: "https://web.test",
      surfaceApprovalUrl: vi.fn(),
      onCardResolved: (cardRef) => resolvedCardRefs.push(cardRef),
      ...(cfg.approvalTimeoutMs !== undefined ? { approvalTimeoutMs: cfg.approvalTimeoutMs } : {}),
      ...(cfg.jitApprovalTimeoutMs !== undefined
        ? { jitApprovalTimeoutMs: cfg.jitApprovalTimeoutMs }
        : {}),
    },
  )) as Record<string, unknown>;

  return { result, approvalBodies, filledCards, auditBodies, resolvedCardRefs, summaryReads };
}

describe("operate_pay JIT add-card ceremony", () => {
  it("mints a card-less approval and resumes with the SERVER-BOUND card_ref", async () => {
    const { result, approvalBodies, filledCards, auditBodies, resolvedCardRefs } = await runJit({
      boundCardRef: "card_bound_by_server",
      poll: () => ({ status: "approved", card_ref: "card_bound_by_server" }),
    });

    // The mandate was signed over the bound card_ref; the operator (which has no
    // args.card_ref) could only pass verifyMandate by re-canonicalizing with it.
    expect(result).toMatchObject({ status: "payment_submitted" });
    expect(filledCards).toEqual([SYNTHETIC_CARD]);
    expect(resolvedCardRefs).toEqual(["card_bound_by_server"]);
    // Card-less create — no card_ref in the create body.
    expect(approvalBodies[0]).not.toHaveProperty("card_ref");
    expect(auditBodies).toEqual([expect.objectContaining({ status: "payment_submitted" })]);
  });

  it("rejects a mandate signed over a different card_ref than the server bound", async () => {
    const { result, filledCards, auditBodies } = await runJit({
      boundCardRef: "card_RIGHT",
      signCardRef: "card_WRONG",
      poll: () => ({ status: "approved", card_ref: "card_RIGHT" }),
    });

    // Operator canonicalizes with the bound "card_RIGHT"; the mandate was signed
    // over "card_WRONG" → hash mismatch → fail closed. A card swap can't slip in.
    expect(result).toMatchObject({
      status: "payment_mandate_rejected",
      reason: "payload_hash_mismatch",
    });
    expect(filledCards).toHaveLength(0);
    expect(auditBodies).toHaveLength(0);
  });

  it("refuses to fill when the live total drifts from the mandate amount on resume", async () => {
    const { result, filledCards, summaryReads } = await runJit({
      boundCardRef: "card_x",
      poll: () => ({ status: "approved", card_ref: "card_x" }),
      resumeOverride: { amount_cents: JIT_CHECKOUT.amount_cents + 500 },
    });

    expect(result).toMatchObject({
      status: "payment_amount_mismatch",
      mandate_amount_cents: JIT_CHECKOUT.amount_cents,
      live_amount_cents: JIT_CHECKOUT.amount_cents + 500,
    });
    expect(filledCards).toHaveLength(0);
    // Re-read happened (two summary reads: initial + resume).
    expect(summaryReads).toBe(2);
  });

  it("refuses to fill when the merchant or origin drifts on resume (same total)", async () => {
    // A mid-ceremony navigation to a different merchant/origin with an
    // identical total must NOT slip through — the mandate binds those fields.
    const merchantDrift = await runJit({
      boundCardRef: "card_x",
      poll: () => ({ status: "approved", card_ref: "card_x" }),
      resumeOverride: { merchant: "Different Merchant" },
    });
    expect(merchantDrift.result).toMatchObject({
      status: "payment_amount_mismatch",
      live_merchant: "Different Merchant",
    });
    expect(merchantDrift.filledCards).toHaveLength(0);

    const originDrift = await runJit({
      boundCardRef: "card_x",
      poll: () => ({ status: "approved", card_ref: "card_x" }),
      resumeOverride: { checkout_origin: "https://evil.synthetic.test" },
    });
    expect(originDrift.result).toMatchObject({
      status: "payment_amount_mismatch",
      live_checkout_origin: "https://evil.synthetic.test",
    });
    expect(originDrift.filledCards).toHaveLength(0);
  });

  it("fails closed when the live total can no longer be read on resume", async () => {
    const { result, filledCards } = await runJit({
      boundCardRef: "card_x",
      poll: () => ({ status: "approved", card_ref: "card_x" }),
      resumeThrows: true,
    });

    expect(result).toMatchObject({ status: "payment_amount_mismatch" });
    expect(filledCards).toHaveLength(0);
  });

  it("returns card_required when the link expires before a card is added", async () => {
    const { result, filledCards } = await runJit({
      boundCardRef: "unused",
      poll: () => ({ status: "expired", card_ref: null }),
    });

    expect(result).toMatchObject({
      status: "payment_card_required",
      needs_user: { wall: "card_required" },
    });
    expect(result).not.toHaveProperty("card_persisted");
    expect(filledCards).toHaveLength(0);
  });

  it("times out (card persists) when a card was added but never approved", async () => {
    const { result, filledCards } = await runJit({
      boundCardRef: "card_stored",
      // Card was bound mid-ceremony, but the approval expired before sign-off.
      poll: () => ({ status: "expired", card_ref: "card_stored" }),
    });

    expect(result).toMatchObject({
      status: "payment_approval_timeout",
      card_persisted: true,
    });
    expect(result).not.toHaveProperty("needs_user");
    expect(filledCards).toHaveLength(0);
  });

  it("refreshes the final card binding only for JIT deadline exits", async () => {
    let jitPolls = 0;
    const jit = await runJit({
      boundCardRef: "card_stored",
      poll: (clockMs) => {
        jitPolls += 1;
        return {
          status: "pending",
          card_ref: clockMs > 0 ? "card_stored" : null,
        };
      },
      jitApprovalTimeoutMs: 1,
    });
    expect(jit.result).toMatchObject({
      status: "payment_approval_timeout",
      card_persisted: true,
    });
    expect(jitPolls).toBe(2);

    let hasCardPolls = 0;
    const hasCard = await runJit({
      cardRefArg: "card_stored",
      boundCardRef: "card_stored",
      poll: () => {
        hasCardPolls += 1;
        return { status: "pending", card_ref: "card_stored" };
      },
      approvalTimeoutMs: 1,
    });
    expect(hasCard.result).toMatchObject({ status: "payment_approval_timeout" });
    expect(hasCardPolls).toBe(1);
  });

  it("waits longer than a has-card approval before giving up (JIT wait budget)", async () => {
    // Approval flips to approved at 330s — past the 5-min has-card budget but
    // inside the ~18-min JIT budget. The only difference between the two runs is
    // whether a card_ref is supplied, which is exactly what selects the budget.
    const approveAt = 330_000;
    const poll = (clockMs: number): PollState =>
      clockMs >= approveAt
        ? { status: "approved", card_ref: "card_bound_by_server" }
        : { status: "pending", card_ref: "card_bound_by_server" };

    const jit = await runJit({
      boundCardRef: "card_bound_by_server",
      poll,
      approvalTimeoutMs: 5 * 60 * 1000,
      jitApprovalTimeoutMs: 18 * 60 * 1000,
    });
    expect(jit.result).toMatchObject({ status: "payment_submitted" });

    const hasCard = await runJit({
      cardRefArg: "card_bound_by_server",
      boundCardRef: "card_bound_by_server",
      poll,
      approvalTimeoutMs: 5 * 60 * 1000,
      jitApprovalTimeoutMs: 18 * 60 * 1000,
    });
    // Same script, but the 5-min has-card budget expires before 330s.
    expect(hasCard.result).toMatchObject({ status: "payment_approval_timeout" });
    expect(hasCard.filledCards).toHaveLength(0);
  });
});
