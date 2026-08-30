import { createHash, generateKeyPairSync, type KeyObject } from "node:crypto";
import canonicalize from "canonicalize";
import { exportJWK, SignJWT } from "jose";
import { describe, expect, it, vi } from "vitest";
import { ApiClient } from "../../api-client.js";
import {
  executeOperatePay,
  executeOperatePayConfirm,
  type CartCheckoutObservation,
  type PaymentBrowser,
  type PendingApprovalWait,
  type PendingCardFill,
  type PendingThreeDsWait,
} from "../pay-operator.js";
import { generateOperatorKeypair, sealToRecipient } from "../payment-hpke.js";
import { manualCardEntryBlockReason } from "../provision-session.js";
import {
  BrowserController,
  PaymentCardFillCleanupError,
  PaymentSubmitOutcomeUnknownError,
  UnrecognizedPaymentFrameError,
  type CheckoutCard,
  type CheckoutSubmitResult,
  type CheckoutSummary,
} from "../browser.js";

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
  | "review_then_happy"
  | "review_wrong_issuer"
  | "confirm_response_lost"
  | "confirm_response_lost_changed"
  | "confirm_denied"
  | "junk_then_happy"
  | "tampered_amount"
  | "tampered_origin"
  | "wrong_recipient"
  | "wrong_issuer"
  | "wrong_audience"
  | "expired_relay"
  | "stale_expired_relay"
  | "audit_failure"
  | "low_confidence";

async function harness(
  mode: Mode,
  expectedAudience: string | null = "customer_test",
  apiAudience?: string,
  threeDs?: {
    resolution: "succeeded" | "failed" | "challenge_pending" | "timeout";
    waitSeconds?: number;
    notifyNeverResolves?: boolean;
    notifySent?: boolean;
  },
  checkoutOptions: {
    checkout?: CheckoutSummary;
    readCheckoutSummary?: () => Promise<CheckoutSummary>;
    fillAndSubmitCheckout?: (
      card: CheckoutCard,
      options?: { onSubmitDispatched?: () => void; beforeSubmitDispatch?: () => void | number },
    ) => Promise<CheckoutSubmitResult>;
    paymentInstrumentMismatch?: () => CheckoutSubmitResult["payment_instrument_mismatch"];
    now?: () => number;
    approvalExpiresAt?: () => string;
    onJwksFetch?: () => void;
  } = {},
) {
  const checkout = checkoutOptions.checkout ?? CHECKOUT;
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const jwk = await exportJWK(publicKey);
  const auditBodies: unknown[] = [];
  const approvalBodies: Array<Record<string, unknown>> = [];
  const filledCards: CheckoutCard[] = [];
  const notifyCalls: string[] = [];
  const notifyBodies: Array<Record<string, unknown>> = [];
  const resolvedCardRefs: string[] = [];
  const confirmationBodies: Array<Record<string, unknown>> = [];
  const pendingStates: PendingApprovalWait[] = [];
  const pendingThreeDsStates: PendingThreeDsWait[] = [];
  const pendingAtDispatchCounts: number[] = [];
  let activePendingThreeDs: PendingThreeDsWait | null = null;
  const nonce = "synthetic-nonce";
  const agent = "synthetic-payment-test-agent";
  let approvalPolls = 0;
  let confirmedCandidate: Record<string, unknown> | undefined;
  const approvalExpiresAt = (): string =>
    checkoutOptions.approvalExpiresAt?.() ?? new Date(Date.now() + 60_000).toISOString();

  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === "https://vouchflow.test/.well-known/jwks.json") {
      checkoutOptions.onJwksFetch?.();
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
          expires_at: approvalExpiresAt(),
        },
        { status: 201 },
      );
    }
    if (
      (url.endsWith("/v1/pay/approvals/approval_test") ||
        url.includes("/v1/pay/approvals/approval_test?wait_for_submission=1")) &&
      init?.method === "GET"
    ) {
      approvalPolls += 1;
      const approval = approvalBodies[0]!;
      const operatorPublicKey = String(approval.operator_pubkey);
      if (confirmedCandidate !== undefined) {
        return Response.json({
          id: "approval_test",
          status: "approved",
          ...checkout,
          nonce,
          card_ref: "card_test",
          operator_pubkey: operatorPublicKey,
          jws: confirmedCandidate.jws,
          sealed_card: confirmedCandidate.sealed_card,
          expires_at: approvalExpiresAt(),
        });
      }
      const recipientHash = createHash("sha256")
        .update(Buffer.from(operatorPublicKey, "base64url"))
        .digest("base64url");
      const payload = {
        approval_id: "approval_test",
        merchant: checkout.merchant,
        checkout_origin:
          mode === "tampered_origin" ? "https://evil.synthetic.test" : checkout.checkout_origin,
        amount_cents:
          mode === "tampered_amount" ? checkout.amount_cents + 1 : checkout.amount_cents,
        currency: checkout.currency,
        nonce,
        card_ref: "card_test",
        recipient_pubkey_hash: recipientHash,
        item: approval.item,
        reason: approval.reason,
        agent,
      };
      const canonical = canonicalize(payload)!;
      const aad = createHash("sha256").update(canonical, "utf8").digest();
      const reviewCandidate =
        (mode === "review_then_happy" || mode === "review_wrong_issuer") && approvalPolls === 1;
      const reviewCanonical = canonicalize({
        approval_id: "approval_test",
        approval_payload_sha256: aad.toString("base64url"),
        card_ref: "card_test",
        recipient_pubkey_hash: recipientHash,
      })!;
      const reviewAad = createHash("sha256").update(reviewCanonical, "utf8").digest();
      const candidateAad = reviewCandidate ? reviewAad : aad;
      let assertionBuilder = new SignJWT({
        payload_sha256: candidateAad.toString("base64url"),
        context: "purchase",
        confidence: mode === "low_confidence" ? "low" : "high",
        mandate_id: "mandate_test",
      })
        .setProtectedHeader({ alg: "RS256", kid: "test-key" })
        .setIssuer(
          mode === "wrong_issuer" || mode === "review_wrong_issuer"
            ? "https://other-issuer.example"
            : "https://vouchflow.dev",
        )
        .setAudience(mode === "wrong_audience" ? "other-customer" : "customer_test");
      if (mode === "expired_relay" || mode === "stale_expired_relay") {
        assertionBuilder = assertionBuilder
          .setIssuedAt(
            Math.floor(Date.now() / 1_000) - (mode === "stale_expired_relay" ? 1_260 : 120),
          )
          .setExpirationTime(
            Math.floor(Date.now() / 1_000) - (mode === "stale_expired_relay" ? 1_140 : 60),
          );
      }
      const assertion = await assertionBuilder.sign(privateKey);
      const recipient =
        mode === "wrong_recipient"
          ? (await generateOperatorKeypair()).publicKey
          : operatorPublicKey;
      const sealedCard = await sealToRecipient(
        recipient,
        new TextEncoder().encode(JSON.stringify(SYNTHETIC_CARD)),
        candidateAad,
      );
      return Response.json({
        id: "approval_test",
        status:
          mode === "happy" ||
          mode === "review_then_happy" ||
          mode === "confirm_response_lost" ||
          mode === "confirm_response_lost_changed" ||
          mode === "confirm_denied" ||
          mode === "junk_then_happy" ||
          mode === "expired_relay" ||
          mode === "stale_expired_relay"
            ? "pending"
            : "approved",
        ...checkout,
        nonce,
        card_ref: "card_test",
        operator_pubkey: operatorPublicKey,
        jws: assertion,
        sealed_card: mode === "junk_then_happy" && approvalPolls === 1 ? "junk" : sealedCard,
        expires_at: approvalExpiresAt(),
      });
    }
    if (url.endsWith("/v1/pay/approvals/approval_test/confirm") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      confirmationBodies.push(body);
      if (mode === "review_then_happy" && confirmationBodies.length === 1) {
        return Response.json({ status: "verified" });
      }
      if (
        (mode === "confirm_response_lost" || mode === "confirm_response_lost_changed") &&
        confirmationBodies.length === 1
      ) {
        confirmedCandidate =
          mode === "confirm_response_lost_changed"
            ? { ...body, sealed_card: "different-candidate" }
            : body;
        throw new TypeError("confirm response lost");
      }
      if (mode === "confirm_response_lost_changed") {
        return Response.json({ error: "payment_approval_candidate_changed" }, { status: 409 });
      }
      if (mode === "confirm_denied") {
        return Response.json({ error: "payment_approval_denied" }, { status: 409 });
      }
      confirmedCandidate = body;
      return Response.json({ status: "approved" });
    }
    if (url.endsWith("/v1/pay/approvals/approval_test/notify-3ds") && init?.method === "POST") {
      notifyCalls.push(url);
      notifyBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      if (threeDs?.notifyNeverResolves === true) {
        return new Promise<Response>(() => undefined);
      }
      return Response.json({ sent: threeDs?.notifySent ?? true });
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
    readCheckoutSummary: vi.fn(checkoutOptions.readCheckoutSummary ?? (async () => checkout)),
    readCheckoutConfirmSummary: vi.fn().mockResolvedValue(checkout),
    currentUrl: vi.fn().mockReturnValue(`${checkout.checkout_origin}/session/test`),
    fillCheckoutCardFields: vi.fn(),
    submitFilledCheckout: vi.fn(),
    clearSealedPaymentFields: vi.fn().mockResolvedValue(undefined),
    fillAndSubmitCheckout: vi.fn(
      checkoutOptions.fillAndSubmitCheckout ??
        (async (
          card: CheckoutCard,
          options?: {
            onSubmitDispatched?: () => void;
            beforeSubmitDispatch?: () => void | number;
          },
        ) => {
          filledCards.push(card);
          options?.beforeSubmitDispatch?.();
          options?.onSubmitDispatched?.();
          pendingAtDispatchCounts.push(pendingThreeDsStates.length);
          return threeDs === undefined
            ? { three_ds_required: false, order_confirmed: true }
            : {
                three_ds_required: true,
                order_confirmed: false,
                challenge_url: "https://issuer.synthetic.test/challenge",
              };
        }),
    ),
    waitForThreeDsResolution: vi.fn().mockResolvedValue(threeDs?.resolution ?? "timeout"),
    ...(checkoutOptions.paymentInstrumentMismatch !== undefined
      ? { paymentInstrumentMismatch: checkoutOptions.paymentInstrumentMismatch }
      : {}),
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
      ...(checkoutOptions.now === undefined ? {} : { now: checkoutOptions.now }),
      sleep: async () => undefined,
      vouchflowApiBase: "https://vouchflow.test",
      vouchflowExpectedAudience: expectedAudience ?? undefined,
      webBase: "https://web.test",
      surfaceApprovalUrl: vi.fn(),
      onCardResolved: (cardRef) => resolvedCardRefs.push(cardRef),
      onApprovalPending: (state) => pendingStates.push(state),
      onThreeDsPending: (state) => {
        activePendingThreeDs = state;
        pendingThreeDsStates.push(state);
      },
      onThreeDsCleared: (state) => {
        if (activePendingThreeDs === state) activePendingThreeDs = null;
      },
    },
  );

  return {
    result,
    approvalBodies,
    auditBodies,
    filledCards,
    notifyCalls,
    notifyBodies,
    resolvedCardRefs,
    confirmationBodies,
    pendingStates,
    pendingThreeDsStates,
    pendingAtDispatchCounts,
    get activePendingThreeDs() {
      return activePendingThreeDs;
    },
    browser,
  };
}

describe("operate_pay", () => {
  it.each([
    [
      "payment_checkout_total_not_found",
      {
        status: "needs_cart_total",
        reason: "checkout_total_not_on_page",
        next: { tool: "operate_observe", hint: expect.any(String) },
      },
    ],
  ])("does not mint an approval for checkout grounding failure %s", async (error, expected) => {
    const approvalBodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/v1/pay/config") && init?.method === "GET") {
        return Response.json({ vouchflow_audience: "customer_test" });
      }
      if (url.endsWith("/v1/pay/approvals") && init?.method === "POST") {
        approvalBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      }
      return Response.json({ error: "unexpected_request" }, { status: 500 });
    }) as typeof fetch;
    const api = new ApiClient({
      apiBaseUrl: "https://api.test",
      registryBaseUrl: "https://registry.test",
      agentSessionToken: "synthetic-session-token",
      fetch: fetchMock,
    });
    const browser: PaymentBrowser = {
      isPayPalHostedCheckout: vi.fn().mockResolvedValue(false),
      readCheckoutSummary: vi.fn().mockRejectedValue(new Error(error)),
      readCheckoutConfirmSummary: vi.fn().mockRejectedValue(new Error(error)),
      currentUrl: vi.fn().mockReturnValue("https://flowers.example.test/checkout"),
      fillAndSubmitCheckout: vi.fn(),
      fillCheckoutCardFields: vi.fn(),
      submitFilledCheckout: vi.fn(),
      clearSealedPaymentFields: vi.fn().mockResolvedValue(undefined),
      waitForThreeDsResolution: vi.fn(),
    };

    await expect(
      executeOperatePay(
        {
          card_ref: "card_test",
          merchant: "Japan Flower Shop",
          ...(error === "payment_checkout_total_not_found"
            ? {}
            : { amount_cents: 9_845, currency: "JPY" }),
          item: "Flowers",
          reason: "Gift",
        },
        api,
        browser,
        { vouchflowExpectedAudience: "customer_test" },
      ),
    ).resolves.toEqual(expected);
    expect(approvalBodies).toEqual([]);
  });

  // REGRESSION: itch.io ("Paying $2.99 for…") and Gumroad have no labelled
  // "total"/"amount due" line, so readCheckoutSummary can't machine-read a
  // total. That used to hard-refuse (needs_cart_total /
  // checkout_total_not_on_page) even when the caller passed amount_cents.
  // A caller-supplied amount_cents must now be honored as the approval
  // amount — the human passkey approval (which shows the amount to the
  // user) remains the real amount check.
  it("honors a caller-supplied amount_cents when the page total cannot be machine-read", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = await exportJWK(publicKey);
    const approvalBodies: Array<Record<string, unknown>> = [];
    const filledCards: CheckoutCard[] = [];
    const auditBodies: unknown[] = [];
    const nonce = "fallback-nonce";
    const agent = "fallback-agent";
    const checkoutOrigin = "https://itch-style.synthetic.test";
    // What pay-operator's fallback constructs when the total can't be read:
    // merchant from the page hostname, amount/currency from the caller.
    const FALLBACK_CHECKOUT = {
      merchant: "itch-style.synthetic.test",
      checkout_origin: checkoutOrigin,
      amount_cents: 299,
      currency: "USD",
    };

    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "https://vouchflow.test/.well-known/jwks.json") {
        return Response.json({ keys: [{ ...jwk, alg: "RS256", use: "sig", kid: "test-key" }] });
      }
      if (url.endsWith("/v1/pay/config") && init?.method === "GET") {
        return Response.json({ vouchflow_audience: "customer_test" });
      }
      if (url.endsWith("/v1/pay/approvals") && init?.method === "POST") {
        approvalBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return Response.json(
          {
            id: "approval_fallback",
            nonce,
            agent,
            expires_at: new Date(Date.now() + 60_000).toISOString(),
          },
          { status: 201 },
        );
      }
      if (
        (url.endsWith("/v1/pay/approvals/approval_fallback") ||
          url.includes("/v1/pay/approvals/approval_fallback?wait_for_submission=1")) &&
        init?.method === "GET"
      ) {
        const operatorPublicKey = String(approvalBodies[0]!.operator_pubkey);
        const recipientHash = createHash("sha256")
          .update(Buffer.from(operatorPublicKey, "base64url"))
          .digest("base64url");
        const canonical = canonicalize({
          approval_id: "approval_fallback",
          merchant: FALLBACK_CHECKOUT.merchant,
          checkout_origin: FALLBACK_CHECKOUT.checkout_origin,
          amount_cents: FALLBACK_CHECKOUT.amount_cents,
          currency: FALLBACK_CHECKOUT.currency,
          nonce,
          card_ref: "card_test",
          recipient_pubkey_hash: recipientHash,
          item: approvalBodies[0]!.item,
          reason: approvalBodies[0]!.reason,
          agent,
        })!;
        const aad = createHash("sha256").update(canonical, "utf8").digest();
        const jws = await new SignJWT({
          payload_sha256: aad.toString("base64url"),
          context: "purchase",
          confidence: "high",
          mandate_id: "fallback-mandate",
        })
          .setProtectedHeader({ alg: "RS256", kid: "test-key" })
          .setIssuer("https://vouchflow.dev")
          .setAudience("customer_test")
          .sign(privateKey);
        const sealed_card = await sealToRecipient(
          operatorPublicKey,
          new TextEncoder().encode(JSON.stringify(SYNTHETIC_CARD)),
          aad,
        );
        return Response.json({
          id: "approval_fallback",
          status: "approved",
          ...FALLBACK_CHECKOUT,
          nonce,
          card_ref: "card_test",
          operator_pubkey: operatorPublicKey,
          jws,
          sealed_card,
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        });
      }
      if (url.endsWith("/v1/vault/payments/audit") && init?.method === "POST") {
        auditBodies.push(JSON.parse(String(init.body)) as unknown);
        return Response.json({ id: "audit_fallback" }, { status: 201 });
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    }) as typeof fetch;

    const api = new ApiClient({
      apiBaseUrl: "https://api.test",
      registryBaseUrl: "https://registry.test",
      agentSessionToken: "synthetic-session-token",
      fetch: fetchMock,
    });

    const browser: PaymentBrowser = {
      isPayPalHostedCheckout: vi.fn().mockResolvedValue(false),
      readCheckoutSummary: vi.fn().mockRejectedValue(new Error("payment_checkout_total_not_found")),
      readCheckoutConfirmSummary: vi
        .fn()
        .mockRejectedValue(new Error("payment_checkout_total_not_found")),
      currentUrl: vi.fn().mockReturnValue(`${checkoutOrigin}/session/test`),
      fillCheckoutCardFields: vi.fn(),
      submitFilledCheckout: vi.fn(),
      clearSealedPaymentFields: vi.fn().mockResolvedValue(undefined),
      fillAndSubmitCheckout: vi.fn(async (card: CheckoutCard) => {
        filledCards.push(card);
        return { three_ds_required: false, order_confirmed: true };
      }),
      waitForThreeDsResolution: vi.fn(),
    };

    const result = await executeOperatePay(
      {
        card_ref: "card_test",
        amount_cents: 299,
        currency: "USD",
        item: "Indie game",
        reason: "Paying $2.99 for the game",
      },
      api,
      browser,
      {
        fetch: fetchMock,
        sleep: async () => undefined,
        vouchflowApiBase: "https://vouchflow.test",
        vouchflowExpectedAudience: "customer_test",
        webBase: "https://web.test",
        surfaceApprovalUrl: vi.fn(),
        onCardResolved: () => undefined,
      },
    );

    expect(result).toMatchObject({
      status: "payment_submitted",
      merchant: FALLBACK_CHECKOUT.merchant,
      amount_cents: 299,
      currency: "USD",
    });
    // Exactly one approval minted for the purchase.
    expect(approvalBodies).toHaveLength(1);
    expect(approvalBodies[0]).toMatchObject({ amount_cents: 299, currency: "USD" });
    expect(filledCards).toHaveLength(1);
  });

  it("verifies the mandate, opens the card, fills the checkout, and audits last4 only", async () => {
    const {
      result,
      approvalBodies,
      auditBodies,
      filledCards,
      resolvedCardRefs,
      confirmationBodies,
    } = await harness("happy");

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

  it("manual card-entry guard never gates the sanctioned vaulted-card fill", async () => {
    // The exact PAN operate_act's type guard refuses as model-supplied text...
    expect(manualCardEntryBlockReason(SYNTHETIC_CARD.pan)).toMatch(/operate_pay/);
    // ...still flows through operate_pay's server-side injection path untouched.
    const { result, filledCards } = await harness("happy");
    expect(result).toMatchObject({ status: "payment_submitted" });
    expect(filledCards).toEqual([SYNTHETIC_CARD]);
  });

  it("binds approval to the final Japanese payable total, never the earlier subtotal", async () => {
    const checkout: CheckoutSummary = {
      merchant: "Rakuten",
      checkout_origin: "https://checkout.rakuten.test",
      amount_cents: 3_404,
      currency: "JPY",
    };
    const controller = new BrowserController({ humanize: false });
    const frame = {
      evaluate: vi.fn().mockResolvedValue("小計 ¥2,904\n合計 ¥3,404"),
    };
    const page = {
      evaluate: vi.fn().mockResolvedValue({ title: "Rakuten", siteName: "Rakuten" }),
      mainFrame: () => frame,
      frames: () => [frame],
      url: () => `${checkout.checkout_origin}/session/test`,
    };
    Object.defineProperty(controller, "page", { value: page });

    const { result, approvalBodies, browser } = await harness(
      "happy",
      "customer_test",
      undefined,
      undefined,
      {
        checkout,
        readCheckoutSummary: controller.readCheckoutSummary.bind(controller),
      },
    );

    expect(browser.readCheckoutSummary).toHaveBeenCalledTimes(1);
    expect(approvalBodies[0]).toMatchObject({ amount_cents: 3_404, currency: "JPY" });
    expect(result).toMatchObject({
      status: "payment_submitted",
      amount_cents: 3_404,
      currency: "JPY",
    });
  }, 10_000);

  it("verifies an opaque review seal before accepting the final approval", async () => {
    const { result, confirmationBodies, filledCards } = await harness("review_then_happy");

    expect(result).toMatchObject({ status: "payment_submitted" });
    expect(confirmationBodies).toHaveLength(2);
    expect(filledCards).toEqual([SYNTHETIC_CARD]);
  });

  it("surfaces a rejected review issuer instead of silently polling", async () => {
    const { result, filledCards, confirmationBodies } = await harness("review_wrong_issuer");

    expect(result).toMatchObject({
      status: "payment_review_verification_failed",
      reason: "mandate_verification_failed",
    });
    expect(confirmationBodies).toHaveLength(0);
    expect(filledCards).toHaveLength(0);
  });

  it("returns an explicit error for a final-bound pending candidate with a junk seal", async () => {
    const { result, filledCards, confirmationBodies } = await harness("junk_then_happy");

    expect(result).toMatchObject({
      status: "payment_card_open_failed",
      reason: "card_open_failed",
      candidate_kind: "approval",
    });
    expect(filledCards).toHaveLength(0);
    expect(confirmationBodies).toHaveLength(0);
  });

  it("reconciles a lost confirm response before submitting payment", async () => {
    const { result, filledCards, confirmationBodies } = await harness("confirm_response_lost");

    expect(result).toMatchObject({ status: "payment_submitted" });
    expect(filledCards).toEqual([SYNTHETIC_CARD]);
    expect(confirmationBodies).toHaveLength(2);
    expect(confirmationBodies[1]).toEqual(confirmationBodies[0]);
  });

  it("fails closed instead of resurrecting the candidate when reconciliation can't confirm it", async () => {
    const { result, filledCards, auditBodies, pendingStates } = await harness(
      "confirm_response_lost_changed",
    );

    // The confirm may have actually succeeded server-side (its response was
    // merely lost); reconciliation coming back "candidate_changed" means we
    // can't prove that either way. This must be a clean terminal failure —
    // never a resurrected still-awaiting approval that a later call could
    // re-confirm and re-charge.
    expect(result).toMatchObject({
      status: "payment_confirmation_failed",
      reason: "confirm_failed",
      candidate_kind: "approval",
    });
    expect(pendingStates).toHaveLength(0);
    expect(filledCards).toHaveLength(0);
    expect(auditBodies).toHaveLength(0);
  });

  it("returns terminal denial when denial wins final candidate confirmation", async () => {
    const { result, filledCards, auditBodies, pendingStates, confirmationBodies } =
      await harness("confirm_denied");

    expect(result).toMatchObject({
      status: "payment_approval_denied",
      approval_id: "approval_test",
    });
    expect(confirmationBodies).toHaveLength(1);
    expect(pendingStates).toHaveLength(0);
    expect(filledCards).toHaveLength(0);
    expect(auditBodies).toHaveLength(0);
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

  it("accepts a recently expired assertion already verified by the approval relay", async () => {
    const { result, filledCards } = await harness("expired_relay");

    expect(result).toMatchObject({ status: "payment_submitted" });
    expect(filledCards).toEqual([SYNTHETIC_CARD]);
  });

  it("rejects an expired relayed assertion outside the approval lifetime", async () => {
    const { result, auditBodies, filledCards } = await harness("stale_expired_relay");

    expect(result).toMatchObject({
      status: "payment_mandate_verification_failed",
      reason: "mandate_assertion_expired",
    });
    expect(filledCards).toHaveLength(0);
    expect(auditBodies).toHaveLength(0);
  });

  it("refuses card release when mandate verification crosses approval expiry", async () => {
    let clock = 0;
    const deadline = 1_000;
    const { result, filledCards, resolvedCardRefs } = await harness(
      "happy",
      "customer_test",
      undefined,
      undefined,
      {
        now: () => clock,
        approvalExpiresAt: () => new Date(deadline).toISOString(),
        onJwksFetch: () => {
          clock = deadline;
        },
      },
    );

    expect(result).toMatchObject({ status: "payment_approval_timeout" });
    expect(resolvedCardRefs).toHaveLength(0);
    expect(filledCards).toHaveLength(0);
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
    const { result, auditBodies, notifyCalls, browser, pendingAtDispatchCounts } = await harness(
      "happy",
      "customer_test",
      undefined,
      { resolution: "succeeded" },
    );

    expect(result).toMatchObject({ status: "payment_submitted" });
    expect(notifyCalls).toHaveLength(1);
    expect(browser.waitForThreeDsResolution).toHaveBeenCalledWith(180_000);
    expect(auditBodies).toEqual([expect.objectContaining({ status: "payment_submitted" })]);
    expect(pendingAtDispatchCounts).toEqual([1]);
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
    const { result, notifyCalls, notifyBodies } = await harness(
      "happy",
      "customer_test",
      undefined,
      {
        resolution: "timeout",
      },
    );

    expect(result).toMatchObject({
      status: "payment_3ds_required",
      needs_user: {
        wall: "3ds",
        resume: "checkout",
        message: expect.stringContaining("bank app"),
      },
    });
    expect(notifyCalls).toHaveLength(1);
    expect(notifyBodies).toEqual([{ mode: "detected_challenge" }]);
  });

  // Regression coverage for the decoupled/out-of-band 3DS completion gap: a
  // timed-out wait (genuinely still pending — the cardholder may approve
  // just after this call's own bounded wait ends) must leave resumable
  // state for operate_payment_status to keep checking the SAME already-
  // submitted charge, and must tell the host to use that tool rather than
  // silently stranding the browser on the challenge with nothing watching.
  it("REGRESSION: a timed-out 3DS wait persists resumable state and points to operate_payment_status", async () => {
    const { result, pendingThreeDsStates } = await harness("happy", "customer_test", undefined, {
      resolution: "timeout",
    });

    expect(result).toMatchObject({
      status: "payment_3ds_required",
      next: {
        tool: "operate_payment_status",
        wait_seconds: 15,
        hint: expect.stringContaining("not re-release"),
      },
    });
    expect(pendingThreeDsStates).toHaveLength(1);
    expect(pendingThreeDsStates[0]).toMatchObject({
      checkout: CHECKOUT,
      last4: "4242",
      deadline: expect.any(Number),
    });
    expect(pendingThreeDsStates[0]!.deadline).toBeGreaterThan(Date.now());
  });

  it("surfaces ACS instrument evidence as a warning without blocking the 3DS handoff", async () => {
    const { result, browser, pendingThreeDsStates } = await harness(
      "happy",
      "customer_test",
      undefined,
      { resolution: "timeout" },
      {
        fillAndSubmitCheckout: async () => ({
          three_ds_required: true,
          order_confirmed: false,
          payment_instrument_mismatch: {
            kind: "payment_instrument_mismatch",
            confidence: "high",
            evidence_used: ["issuer"],
            expected: { last4: "9192", issuer: "DBS" },
            observed: { issuer: "ENBDX" },
            provenance: {
              expected: { last4: "released_card", issuer: "bin_metadata" },
              observed: "3ds_challenge",
            },
          },
        }),
      },
    );

    expect(result).toMatchObject({
      status: "payment_3ds_required",
      warning: {
        kind: "payment_instrument_mismatch",
        expected: { last4: "9192", issuer: "DBS" },
        observed: { issuer: "ENBDX" },
      },
      needs_user: { wall: "3ds", resume: "checkout" },
    });
    expect(browser.waitForThreeDsResolution).not.toHaveBeenCalled();
    expect(pendingThreeDsStates).toMatchObject([
      { payment_instrument_mismatch: { observed: { issuer: "ENBDX" } } },
    ]);
  });

  it("persists mismatch evidence first observed during the existing 3DS wait", async () => {
    const mismatch: NonNullable<CheckoutSubmitResult["payment_instrument_mismatch"]> = {
      kind: "payment_instrument_mismatch",
      confidence: "high",
      evidence_used: ["last4"],
      expected: { last4: "9192" },
      observed: { last4: "0005" },
      provenance: {
        expected: { last4: "released_card" },
        observed: "3ds_challenge",
      },
    };
    const { result, pendingThreeDsStates } = await harness(
      "happy",
      "customer_test",
      undefined,
      { resolution: "timeout" },
      {
        fillAndSubmitCheckout: async () => ({
          three_ds_required: true,
          order_confirmed: false,
        }),
        paymentInstrumentMismatch: () => mismatch,
      },
    );

    expect(result).toMatchObject({ warning: mismatch });
    expect(pendingThreeDsStates).toMatchObject([{ payment_instrument_mismatch: mismatch }]);
  });

  it("keeps an outcome unknown without inventing an app-push challenge", async () => {
    const { result, notifyCalls, notifyBodies, browser } = await harness(
      "happy",
      "customer_test",
      undefined,
      { resolution: "timeout" },
      {
        fillAndSubmitCheckout: async () => ({
          three_ds_required: false,
          order_confirmed: false,
        }),
      },
    );

    expect(result).toMatchObject({
      status: "payment_outcome_unknown",
      next: { tool: "operate_payment_status", wait_seconds: 15 },
    });
    expect(result).not.toHaveProperty("needs_user");
    expect(notifyCalls).toHaveLength(0);
    expect(notifyBodies).toEqual([]);
    expect(browser.waitForThreeDsResolution).toHaveBeenCalledWith(180_000);
  });

  it("flags an undelivered Telegram nudge in the timeout hand-off instead of blocking or faking it", async () => {
    const { result, notifyCalls } = await harness("happy", "customer_test", undefined, {
      resolution: "timeout",
      notifySent: false,
    });

    expect(result).toMatchObject({
      status: "payment_3ds_required",
      needs_user: {
        wall: "3ds",
        resume: "checkout",
        message: expect.stringContaining("could not be delivered"),
      },
    });
    expect(notifyCalls).toHaveLength(1);
  });

  it("records declined when the 3DS challenge fails", async () => {
    const outcome = await harness("happy", "customer_test", undefined, { resolution: "failed" });

    expect(outcome.result).toMatchObject({ status: "payment_declined" });
    expect(outcome.result).not.toHaveProperty("merchant");
    expect(outcome.notifyCalls).toHaveLength(1);
    expect(outcome.auditBodies).toEqual([expect.objectContaining({ status: "payment_declined" })]);
    expect(outcome.pendingThreeDsStates).toHaveLength(1);
    expect(outcome.activePendingThreeDs).toBeNull();
  });

  it("records and tracks unknown when single-page submission fails after dispatch", async () => {
    const mismatch: NonNullable<CheckoutSubmitResult["payment_instrument_mismatch"]> = {
      kind: "payment_instrument_mismatch",
      confidence: "low",
      evidence_used: ["issuer"],
      expected: { last4: "4242", issuer: "DBS", label: "DBS Mastercard" },
      observed: { issuer: "ENBDX" },
      provenance: {
        expected: {
          last4: "released_card",
          issuer: "vault_label",
          label: "vault_label",
        },
        observed: "3ds_challenge",
      },
    };
    const { result, auditBodies, browser, pendingThreeDsStates } = await harness(
      "happy",
      "customer_test",
      undefined,
      undefined,
      {
        fillAndSubmitCheckout: async (_card, options) => {
          options?.onSubmitDispatched?.();
          throw new PaymentSubmitOutcomeUnknownError();
        },
        paymentInstrumentMismatch: () => mismatch,
      },
    );

    expect(result).toMatchObject({
      status: "payment_outcome_unknown",
      reason: "payment_submit_outcome_unknown",
      next: { tool: "operate_payment_status", wait_seconds: 15 },
      warning: mismatch,
    });
    expect(auditBodies).toEqual([expect.objectContaining({ status: "payment_outcome_unknown" })]);
    expect(browser.waitForThreeDsResolution).toHaveBeenCalledWith(0);
    expect(pendingThreeDsStates).toHaveLength(1);
    expect(pendingThreeDsStates[0]).toMatchObject({
      outcome: "unknown",
      payment_instrument_mismatch: mismatch,
    });
  });

  it.each([
    ["succeeded", "payment_submitted"],
    ["failed", "payment_declined"],
  ] as const)(
    "maps an immediate %s outcome after a dispatched submit error",
    async (resolution, expectedStatus) => {
      const outcome = await harness(
        "happy",
        "customer_test",
        undefined,
        { resolution },
        {
          fillAndSubmitCheckout: async (_card, options) => {
            options?.onSubmitDispatched?.();
            throw new PaymentSubmitOutcomeUnknownError();
          },
        },
      );

      expect(outcome.result).toMatchObject({ status: expectedStatus });
      expect(outcome.result).not.toHaveProperty("reason");
      expect(outcome.result).not.toHaveProperty("next");
      expect(outcome.auditBodies).toEqual([
        expect.objectContaining({ status: expectedStatus }),
      ]);
      expect(outcome.activePendingThreeDs).toBeNull();
    },
  );

  it("does not retain pending 3DS when checkout fails before charge dispatch", async () => {
    const { result, auditBodies, browser, pendingThreeDsStates } = await harness(
      "happy",
      "customer_test",
      undefined,
      undefined,
      {
        fillAndSubmitCheckout: async () => {
          throw new Error("payment_submit_not_found");
        },
      },
    );

    expect(result).toMatchObject({
      status: "payment_checkout_failed",
      reason: "payment_submit_not_found",
    });
    expect(result).not.toHaveProperty("next");
    expect(auditBodies).toEqual([expect.objectContaining({ status: "payment_checkout_failed" })]);
    expect(browser.waitForThreeDsResolution).not.toHaveBeenCalled();
    expect(pendingThreeDsStates).toHaveLength(0);
  });

  it("hands back immediately without notifying when the 3DS wait is disabled", async () => {
    const { result, notifyCalls, browser, pendingThreeDsStates } = await harness(
      "happy",
      "customer_test",
      undefined,
      {
        resolution: "timeout",
        waitSeconds: 0,
      },
    );

    expect(result).toMatchObject({
      status: "payment_3ds_required",
      next: { tool: "operate_payment_status", wait_seconds: 15 },
      needs_user: {
        wall: "3ds",
        resume: "checkout",
        message: expect.stringContaining("bank app"),
      },
    });
    expect(notifyCalls).toHaveLength(0);
    expect(browser.waitForThreeDsResolution).not.toHaveBeenCalled();
    expect(pendingThreeDsStates).toHaveLength(1);
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
  const serverExpiresAt = new Date(
    (cfg.cardRefArg === undefined ? cfg.jitApprovalTimeoutMs : cfg.approvalTimeoutMs) ?? 8.64e15,
  ).toISOString();

  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === "https://vouchflow.test/.well-known/jwks.json") {
      return Response.json({ keys: [{ ...jwk, alg: "RS256", use: "sig", kid: "test-key" }] });
    }
    if (url.endsWith("/v1/pay/approvals") && init?.method === "POST") {
      approvalBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return Response.json(
        { id: "appr_jit", nonce, agent, expires_at: serverExpiresAt },
        { status: 201 },
      );
    }
    if (
      (url.endsWith("/v1/pay/approvals/appr_jit") ||
        url.includes("/v1/pay/approvals/appr_jit?wait_for_submission=1")) &&
      init?.method === "GET"
    ) {
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
          expires_at: serverExpiresAt,
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
        expires_at: serverExpiresAt,
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
    readCheckoutConfirmSummary: vi.fn().mockResolvedValue(JIT_CHECKOUT),
    currentUrl: vi.fn().mockReturnValue(`${JIT_CHECKOUT.checkout_origin}/session/test`),
    fillCheckoutCardFields: vi.fn(),
    submitFilledCheckout: vi.fn(),
    clearSealedPaymentFields: vi.fn().mockResolvedValue(undefined),
    fillAndSubmitCheckout: vi.fn(async (card: CheckoutCard) => {
      filledCards.push(card);
      return { three_ds_required: false, order_confirmed: true };
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

  it("uses the approved checkout when the live total can no longer be read on resume", async () => {
    const { result, filledCards, summaryReads } = await runJit({
      boundCardRef: "card_x",
      poll: () => ({ status: "approved", card_ref: "card_x" }),
      resumeThrows: true,
    });

    expect(result).toMatchObject({
      status: "payment_submitted",
      merchant: JIT_CHECKOUT.merchant,
      amount_cents: JIT_CHECKOUT.amount_cents,
      currency: JIT_CHECKOUT.currency,
    });
    expect(filledCards).toEqual([SYNTHETIC_CARD]);
    expect(summaryReads).toBe(2);
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

// ── Split checkout (phase="fill_card" → executeOperatePayConfirm) ───────────
//
// Split flows fill without submitting, then re-verify the total on a separate
// confirmation step immediately before the charge.

const SPLIT_CHECKOUT: CheckoutSummary = {
  merchant: "Split Merchant",
  checkout_origin: "https://shop.split.test",
  amount_cents: 3_999,
  currency: "USD",
};

async function runSplitFill(
  cfg: {
    fillRejects?: Error;
    driftOriginAfterApproval?: string;
    // The live card-entry page's OWN total, when it has one. Omitted (the
    // common Rakuten shape) → readCheckoutSummary rejects with
    // payment_checkout_total_not_found, exercising the cart fallback below.
    liveCheckout?: CheckoutSummary;
    // The session's most recently observed real cart total, carried forward
    // as the fill_card fallback. Defaults to SPLIT_CHECKOUT; pass `null` to
    // simulate a session that never captured one.
    cartFallbackCheckout?: CheckoutSummary | null;
  } = {},
): Promise<{
  result: Record<string, unknown>;
  approvalBodies: Array<Record<string, unknown>>;
  auditBodies: unknown[];
  filledCards: CheckoutCard[];
  pendings: PendingCardFill[];
  cleanupFailureCalls: number;
  browser: PaymentBrowser;
}> {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = await exportJWK(publicKey);
  const approvalBodies: Array<Record<string, unknown>> = [];
  const auditBodies: unknown[] = [];
  const filledCards: CheckoutCard[] = [];
  const pendings: PendingCardFill[] = [];
  let cleanupFailureCalls = 0;
  const nonce = "split-nonce";
  const agent = "split-agent";

  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === "https://vouchflow.test/.well-known/jwks.json") {
      return Response.json({ keys: [{ ...jwk, alg: "RS256", use: "sig", kid: "test-key" }] });
    }
    if (url.endsWith("/v1/pay/approvals") && init?.method === "POST") {
      approvalBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return Response.json(
        {
          id: "appr_split",
          nonce,
          agent,
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        },
        { status: 201 },
      );
    }
    if (
      (url.endsWith("/v1/pay/approvals/appr_split") ||
        url.includes("/v1/pay/approvals/appr_split?wait_for_submission=1")) &&
      init?.method === "GET"
    ) {
      // Sign the mandate over whatever checkout the operator MINTED the
      // approval with — declared values on a split page, live ones otherwise.
      const approval = approvalBodies[0]!;
      const operatorPublicKey = String(approval.operator_pubkey);
      const recipientHash = createHash("sha256")
        .update(Buffer.from(operatorPublicKey, "base64url"))
        .digest("base64url");
      const canonical = canonicalize({
        approval_id: "appr_split",
        merchant: approval.merchant,
        checkout_origin: approval.checkout_origin,
        amount_cents: approval.amount_cents,
        currency: approval.currency,
        nonce,
        card_ref: "card_split",
        recipient_pubkey_hash: recipientHash,
        item: approval.item,
        reason: approval.reason,
        agent,
      })!;
      const aad = createHash("sha256").update(canonical, "utf8").digest();
      const jws = await new SignJWT({
        payload_sha256: aad.toString("base64url"),
        context: "purchase",
        confidence: "high",
        mandate_id: "mandate_split",
      })
        .setProtectedHeader({ alg: "RS256", kid: "test-key" })
        .setIssuer("https://vouchflow.dev")
        .setAudience("customer_test")
        .sign(privateKey);
      const sealed_card = await sealToRecipient(
        operatorPublicKey,
        new TextEncoder().encode(JSON.stringify(SYNTHETIC_CARD)),
        aad,
      );
      return Response.json({
        id: "appr_split",
        status: "approved",
        merchant: approval.merchant,
        checkout_origin: approval.checkout_origin,
        amount_cents: approval.amount_cents,
        currency: approval.currency,
        nonce,
        card_ref: "card_split",
        operator_pubkey: operatorPublicKey,
        jws,
        sealed_card,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      });
    }
    if (url.endsWith("/v1/vault/payments/audit") && init?.method === "POST") {
      auditBodies.push(JSON.parse(String(init.body)) as unknown);
      return Response.json({ id: "audit_split" }, { status: 201 });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  }) as typeof fetch;

  const browser: PaymentBrowser = {
    isPayPalHostedCheckout: vi.fn().mockResolvedValue(false),
    // fill_card tries the live page first, same as a single-page checkout.
    // The Rakuten shape (no config) has no total there, so this rejects and
    // executeOperatePay falls back to deps.cartFallbackCheckout.
    readCheckoutSummary:
      cfg.liveCheckout !== undefined
        ? vi.fn().mockResolvedValue(cfg.liveCheckout)
        : vi.fn().mockRejectedValue(new Error("payment_checkout_total_not_found")),
    readCheckoutConfirmSummary: vi
      .fn()
      .mockRejectedValue(new Error("payment_checkout_total_not_found")),
    currentUrl: vi.fn(() => {
      if (cfg.driftOriginAfterApproval !== undefined && approvalBodies.length > 0) {
        return cfg.driftOriginAfterApproval;
      }
      return `${SPLIT_CHECKOUT.checkout_origin}/checkout/payment`;
    }),
    fillAndSubmitCheckout: vi.fn(),
    fillCheckoutCardFields: vi.fn(async (card: CheckoutCard) => {
      if (cfg.fillRejects !== undefined) throw cfg.fillRejects;
      filledCards.push(card);
    }),
    submitFilledCheckout: vi.fn(),
    clearSealedPaymentFields: vi.fn().mockResolvedValue(undefined),
    waitForThreeDsResolution: vi.fn(),
  };
  const api = new ApiClient({
    apiBaseUrl: "https://api.test",
    registryBaseUrl: "https://registry.test",
    agentSessionToken: "synthetic-session-token",
    fetch: fetchMock,
  });

  const cartFallbackCheckout =
    cfg.cartFallbackCheckout === null
      ? undefined
      : ({
          checkout: cfg.cartFallbackCheckout ?? SPLIT_CHECKOUT,
          url: `${SPLIT_CHECKOUT.checkout_origin}/cart`,
          observedAt: 1,
        } satisfies CartCheckoutObservation);
  const result = (await executeOperatePay(
    {
      card_ref: "card_split",
      item: "Split item",
      reason: "Split purchase reason",
      phase: "fill_card",
    },
    api,
    browser,
    {
      fetch: fetchMock,
      sleep: async () => undefined,
      vouchflowApiBase: "https://vouchflow.test",
      vouchflowExpectedAudience: "customer_test",
      webBase: "https://web.test",
      surfaceApprovalUrl: vi.fn(),
      onCardFilled: (pending) => pendings.push(pending),
      onCardFillCleanupFailed: () => {
        cleanupFailureCalls += 1;
      },
      ...(cartFallbackCheckout !== undefined ? { cartFallbackCheckout } : {}),
    },
  )) as Record<string, unknown>;

  return {
    result,
    approvalBodies,
    auditBodies,
    filledCards,
    pendings,
    cleanupFailureCalls,
    browser,
  };
}

describe("operate_pay split checkout — fill_card", () => {
  it("approves the session's carried cart total when the card-entry page shows none", async () => {
    const { result, approvalBodies, filledCards, auditBodies, browser } = await runSplitFill();

    expect(result).toMatchObject({
      status: "payment_card_filled",
      merchant: SPLIT_CHECKOUT.merchant,
      amount_cents: SPLIT_CHECKOUT.amount_cents,
      currency: SPLIT_CHECKOUT.currency,
    });
    expect(approvalBodies).toEqual([
      expect.objectContaining({
        amount_cents: SPLIT_CHECKOUT.amount_cents,
        currency: SPLIT_CHECKOUT.currency,
      }),
    ]);
    expect(filledCards).toEqual([SYNTHETIC_CARD]);
    expect(browser.readCheckoutSummary).toHaveBeenCalled();
    expect(browser.submitFilledCheckout).not.toHaveBeenCalled();
    expect(browser.fillAndSubmitCheckout).not.toHaveBeenCalled();
    expect(auditBodies).toEqual([]);
  });

  it("uses the live card-entry page's own total when it has one, ignoring the cart fallback", async () => {
    const liveOnPage: CheckoutSummary = { ...SPLIT_CHECKOUT, amount_cents: 1_234 };
    const { result, approvalBodies } = await runSplitFill({ liveCheckout: liveOnPage });

    expect(result).toMatchObject({ status: "payment_card_filled", amount_cents: 1_234 });
    expect(approvalBodies).toEqual([expect.objectContaining({ amount_cents: 1_234 })]);
  });

  it("fails closed when the card-entry page has no total and this session never captured a cart total", async () => {
    const { result, browser } = await runSplitFill({ cartFallbackCheckout: null });

    expect(result).toMatchObject({
      status: "needs_cart_total",
      reason: "checkout_total_not_on_page",
    });
    expect(browser.fillCheckoutCardFields).not.toHaveBeenCalled();
  });

  it("refuses to fill when the page origin drifted during the ceremony", async () => {
    const { result, filledCards, browser } = await runSplitFill({
      driftOriginAfterApproval: "https://evil.synthetic.test/checkout",
    });

    expect(result).toMatchObject({
      status: "payment_checkout_origin_mismatch",
      mandate_checkout_origin: SPLIT_CHECKOUT.checkout_origin,
      live_checkout_origin: "https://evil.synthetic.test",
    });
    expect(filledCards).toHaveLength(0);
    expect(browser.fillCheckoutCardFields).not.toHaveBeenCalled();
  });

  it("refuses the fill into an unrecognized cross-origin frame", async () => {
    const { result, auditBodies } = await runSplitFill({
      fillRejects: new UnrecognizedPaymentFrameError("https://rogue-payments.example"),
    });

    expect(result).toMatchObject({
      status: "payment_frame_not_recognized",
      frame_origin: "https://rogue-payments.example",
    });
    expect(auditBodies).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(SYNTHETIC_CARD.pan);
  });

  it("surfaces a failed fill with its payment_ code", async () => {
    const { result } = await runSplitFill({
      fillRejects: new Error("payment_field_not_found:cvv"),
    });

    expect(result).toMatchObject({
      status: "payment_card_fill_failed",
      reason: "payment_field_not_found:cvv",
    });
  });

  it("activates the non-retryable seal when failed-fill cleanup is unproven", async () => {
    const { result, cleanupFailureCalls, pendings } = await runSplitFill({
      fillRejects: new PaymentCardFillCleanupError(new Error("payment_field_not_found:cvv")),
    });

    expect(result).toMatchObject({
      status: "payment_card_fill_failed",
      reason: "payment_field_not_found:cvv",
      payment_fields_cleared: false,
    });
    expect(cleanupFailureCalls).toBe(1);
    expect(pendings).toEqual([]);
  });
});

// The pending state a real fill_card now produces: a SINGLE amount-bound
// approval (one passkey tap) that both released the card and authorizes the
// eventual charge up to checkout.amount_cents — never a zero/"XXX" placeholder.
function splitPending(checkout: CheckoutSummary = SPLIT_CHECKOUT): PendingCardFill {
  return {
    approval_id: "appr_split",
    approval_url: "https://web.test/vault/pay/appr_split",
    checkout,
    card_ref: "card_split",
    last4: "4242",
    mandate_id: "mandate_split",
  };
}

// confirm no longer touches the browser or the API at all: no total re-read,
// no button click, no audit event. It only reports the approved terms back so
// the caller can verify the live total and place the order itself.
describe("operate_pay split checkout — confirm", () => {
  it("reports the fill-time approved terms with no browser or API interaction", async () => {
    const result = (await executeOperatePayConfirm(splitPending(SPLIT_CHECKOUT))) as Record<
      string,
      unknown
    >;

    expect(result).toMatchObject({
      status: "payment_ready_to_place",
      approval_url: "https://web.test/vault/pay/appr_split",
      merchant: SPLIT_CHECKOUT.merchant,
      amount_cents: SPLIT_CHECKOUT.amount_cents,
      currency: SPLIT_CHECKOUT.currency,
      next:
        "Trusty Squire closed out the fill-time approval and released the pending-fill lease. " +
        "It did not inspect, submit, or otherwise change the checkout.",
    });
  });

  it("Rakuten-style: fill_card approves the cart 小計, and confirm reports that same amount back", async () => {
    // fill_card sources the cart's subtotal (小計 2,803円 — the session's
    // carried cart total) as the approved amount.
    const rakutenCart: CheckoutSummary = {
      merchant: "Rakuten",
      checkout_origin: "https://shop.split.test",
      amount_cents: 2_803,
      currency: "JPY",
    };
    const { result: fillResult, approvalBodies } = await runSplitFill({
      cartFallbackCheckout: rakutenCart,
    });
    expect(fillResult).toMatchObject({
      status: "payment_card_filled",
      amount_cents: 2_803,
      currency: "JPY",
    });
    expect(approvalBodies[0]).toMatchObject({ amount_cents: 2_803, currency: "JPY" });

    const confirmResult = (await executeOperatePayConfirm(splitPending(rakutenCart))) as Record<
      string,
      unknown
    >;
    expect(confirmResult).toMatchObject({
      status: "payment_ready_to_place",
      amount_cents: 2_803,
      currency: "JPY",
    });
  });
});

// ── Non-blocking approval [P0] ───────────────────────────────────────────
//
// Friction-audit finding #1: operate_pay used to block the MCP call for up
// to five (or eighteen, JIT) minutes polling for a human's phone tap. These
// exercise the fix: a bounded per-call poll budget that returns
// approval_pending at an explicit zero bound, and idempotent resume — a later
// call reuses the SAME approval/operator keypair rather than minting a
// duplicate approval.

function buildResumableEnv(checkout: CheckoutSummary = CHECKOUT): {
  api: ApiClient;
  browser: PaymentBrowser;
  fetch: typeof fetch;
  approvalBodies: Array<Record<string, unknown>>;
  filledCards: CheckoutCard[];
  expiresAt: string;
  setReview: () => void;
  setApproved: () => void;
  setDenied: () => void;
  setPendingApproved: () => void;
  setInvalidFinalJws: () => void;
  setInvalidFinalCard: () => void;
} {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  let candidateState:
    | "none"
    | "review"
    | "approval"
    | "denied"
    | "approval_pending"
    | "invalid_jws"
    | "invalid_card" = "none";
  let reviewConfirmed = false;
  const approvalBodies: Array<Record<string, unknown>> = [];
  const filledCards: CheckoutCard[] = [];
  const nonce = "resume-nonce";
  const agent = "resume-agent";
  const expiresAt = new Date(Date.now() + 600_000).toISOString();

  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === "https://vouchflow.test/.well-known/jwks.json") {
      const jwk = await exportJWK(publicKey);
      return Response.json({ keys: [{ ...jwk, alg: "RS256", use: "sig", kid: "test-key" }] });
    }
    if (url.endsWith("/v1/pay/approvals") && init?.method === "POST") {
      approvalBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return Response.json(
        { id: "appr_resume", nonce, agent, expires_at: expiresAt },
        { status: 201 },
      );
    }
    if (
      (url.endsWith("/v1/pay/approvals/appr_resume") ||
        url.includes("/v1/pay/approvals/appr_resume?wait_for_submission=1") ||
        url.endsWith("/v1/pay/approvals/appr_resume?read_submission=1")) &&
      init?.method === "GET"
    ) {
      const approval = approvalBodies[0]!;
      const operatorPublicKey = String(approval.operator_pubkey);
      const readsRelayCandidate =
        url.includes("?wait_for_submission=1") || url.endsWith("?read_submission=1");
      if (
        !readsRelayCandidate ||
        candidateState === "none" ||
        candidateState === "denied" ||
        (candidateState === "review" && reviewConfirmed)
      ) {
        return Response.json({
          id: "appr_resume",
          status: candidateState === "denied" ? "denied" : "pending",
          ...checkout,
          nonce,
          card_ref: "card_resume",
          operator_pubkey: operatorPublicKey,
          jws: null,
          sealed_card: null,
          expires_at: expiresAt,
        });
      }
      const recipientHash = createHash("sha256")
        .update(Buffer.from(operatorPublicKey, "base64url"))
        .digest("base64url");
      const canonical = canonicalize({
        approval_id: "appr_resume",
        merchant: checkout.merchant,
        checkout_origin: checkout.checkout_origin,
        amount_cents: checkout.amount_cents,
        currency: checkout.currency,
        nonce,
        card_ref: "card_resume",
        recipient_pubkey_hash: recipientHash,
        item: approval.item,
        reason: approval.reason,
        agent,
      })!;
      const aad = createHash("sha256").update(canonical, "utf8").digest();
      const reviewCanonical = canonicalize({
        approval_id: "appr_resume",
        approval_payload_sha256: aad.toString("base64url"),
        card_ref: "card_resume",
        recipient_pubkey_hash: recipientHash,
      })!;
      const reviewAad = createHash("sha256").update(reviewCanonical, "utf8").digest();
      const candidateAad = candidateState === "review" ? reviewAad : aad;
      const jws = await new SignJWT({
        payload_sha256: candidateAad.toString("base64url"),
        context: "purchase",
        confidence: "high",
        mandate_id: "mandate_resume",
      })
        .setProtectedHeader({ alg: "RS256", kid: "test-key" })
        .setIssuer(
          candidateState === "invalid_jws"
            ? "https://stale-vouchflow.example"
            : "https://vouchflow.dev",
        )
        .setAudience("customer_test")
        .sign(privateKey);
      const sealed_card = await sealToRecipient(
        operatorPublicKey,
        new TextEncoder().encode(JSON.stringify(SYNTHETIC_CARD)),
        candidateAad,
      );
      return Response.json({
        id: "appr_resume",
        status: candidateState === "approval" ? "approved" : "pending",
        ...checkout,
        nonce,
        card_ref: "card_resume",
        operator_pubkey: operatorPublicKey,
        jws,
        sealed_card: candidateState === "invalid_card" ? "invalid-sealed-card" : sealed_card,
        expires_at: expiresAt,
      });
    }
    if (url.endsWith("/v1/pay/approvals/appr_resume/confirm") && init?.method === "POST") {
      if (candidateState === "review") reviewConfirmed = true;
      return Response.json({
        status: candidateState === "review" ? "verified" : "approved",
      });
    }
    if (url.endsWith("/v1/vault/payments/audit") && init?.method === "POST") {
      return Response.json({ id: "audit_resume" }, { status: 201 });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  }) as typeof fetch;

  const browser: PaymentBrowser = {
    isPayPalHostedCheckout: vi.fn().mockResolvedValue(false),
    readCheckoutSummary: vi.fn(async () => checkout),
    readCheckoutConfirmSummary: vi.fn().mockResolvedValue(checkout),
    currentUrl: vi.fn().mockReturnValue(`${checkout.checkout_origin}/session/test`),
    fillCheckoutCardFields: vi.fn(),
    submitFilledCheckout: vi.fn(),
    clearSealedPaymentFields: vi.fn().mockResolvedValue(undefined),
    fillAndSubmitCheckout: vi.fn(async (card: CheckoutCard) => {
      filledCards.push(card);
      return { three_ds_required: false, order_confirmed: true };
    }),
    waitForThreeDsResolution: vi.fn().mockResolvedValue("timeout"),
  };

  const api = new ApiClient({
    apiBaseUrl: "https://api.test",
    registryBaseUrl: "https://registry.test",
    agentSessionToken: "synthetic-session-token",
    fetch: fetchMock,
  });

  return {
    api,
    browser,
    fetch: fetchMock,
    approvalBodies,
    filledCards,
    expiresAt,
    setReview: () => {
      candidateState = "review";
      reviewConfirmed = false;
    },
    setApproved: () => {
      candidateState = "approval";
      reviewConfirmed = false;
    },
    setDenied: () => {
      candidateState = "denied";
      reviewConfirmed = false;
    },
    setPendingApproved: () => {
      candidateState = "approval_pending";
      reviewConfirmed = false;
    },
    setInvalidFinalJws: () => {
      candidateState = "invalid_jws";
    },
    setInvalidFinalCard: () => {
      candidateState = "invalid_card";
    },
  };
}

describe("operate_pay bounded approval continuation [P0]", () => {
  const baseArgs = {
    card_ref: "card_resume",
    merchant: CHECKOUT.merchant,
    amount_cents: CHECKOUT.amount_cents,
    currency: CHECKOUT.currency,
    item: "Wireless Mouse",
    reason: "office restock",
  };

  it("returns an in-flight denial even after the local deadline passes", async () => {
    const env = buildResumableEnv();
    env.setDenied();

    await expect(
      executeOperatePay(baseArgs, env.api, env.browser, {
        fetch: env.fetch,
        vouchflowApiBase: "https://vouchflow.test",
        vouchflowExpectedAudience: "customer_test",
        webBase: "https://web.test",
        surfaceApprovalUrl: vi.fn(),
        now: () => Date.parse(env.expiresAt) + 1,
      }),
    ).resolves.toMatchObject({
      status: "payment_approval_denied",
      approval_id: "appr_resume",
    });
    expect(env.filledCards).toHaveLength(0);
  });

  it("returns a persisted denial after deadline without minting a replacement approval", async () => {
    const env = buildResumableEnv();
    let pending: PendingApprovalWait | undefined;
    await executeOperatePay(baseArgs, env.api, env.browser, {
      fetch: env.fetch,
      vouchflowApiBase: "https://vouchflow.test",
      vouchflowExpectedAudience: "customer_test",
      webBase: "https://web.test",
      surfaceApprovalUrl: vi.fn(),
      pollBudgetMs: 0,
      onApprovalPending: (state) => {
        pending = state;
      },
    });
    if (pending === undefined) throw new Error("expected pending approval");
    pending.deadline = Date.now() - 1;
    env.setDenied();

    await expect(
      executeOperatePay(baseArgs, env.api, env.browser, {
        fetch: env.fetch,
        vouchflowApiBase: "https://vouchflow.test",
        vouchflowExpectedAudience: "customer_test",
        webBase: "https://web.test",
        surfaceApprovalUrl: vi.fn(),
        resumeFrom: pending,
      }),
    ).resolves.toMatchObject({
      status: "payment_approval_denied",
      approval_id: "appr_resume",
    });
    expect(env.approvalBodies).toHaveLength(1);
    expect(env.filledCards).toHaveLength(0);
  });

  it("returns a clean same-approval continuation when an explicit zero wait ends", async () => {
    const env = buildResumableEnv();
    const sleepCalls: number[] = [];
    const pendingStates: PendingApprovalWait[] = [];

    const result = (await executeOperatePay(baseArgs, env.api, env.browser, {
      fetch: env.fetch,
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
      vouchflowApiBase: "https://vouchflow.test",
      vouchflowExpectedAudience: "customer_test",
      webBase: "https://web.test",
      surfaceApprovalUrl: vi.fn(),
      onApprovalPending: (state) => pendingStates.push(state),
      pollBudgetMs: 0,
    })) as Record<string, unknown>;

    expect(result).toMatchObject({
      status: "approval_pending",
      approval_id: "appr_resume",
      merchant: CHECKOUT.merchant,
      approved_amount_cents: CHECKOUT.amount_cents,
      currency: CHECKOUT.currency,
      phase: null,
      next: { tool: "operate_pay" },
    });
    expect(result.approval_url).toContain("appr_resume");
    expect(result.expires_at).toBe(env.expiresAt);
    // Never blocked on a real wait — one live check, then hand back.
    expect(sleepCalls).toEqual([]);
    expect(pendingStates).toHaveLength(1);
    expect(pendingStates[0]?.deadline).toBe(Date.parse(env.expiresAt));
    expect(env.approvalBodies).toHaveLength(1);
  });

  it("resumes the SAME approval on re-initiation — never mints a duplicate", async () => {
    const env = buildResumableEnv();
    let captured: PendingApprovalWait | null = null;
    const surfaceApprovalUrl = vi.fn();

    const first = (await executeOperatePay(baseArgs, env.api, env.browser, {
      fetch: env.fetch,
      sleep: async () => undefined,
      vouchflowApiBase: "https://vouchflow.test",
      vouchflowExpectedAudience: "customer_test",
      webBase: "https://web.test",
      surfaceApprovalUrl,
      onApprovalPending: (state) => {
        captured = state;
      },
      pollBudgetMs: 0,
    })) as Record<string, unknown>;
    expect(first.status).toBe("approval_pending");
    expect(env.approvalBodies).toHaveLength(1);
    if (captured === null) throw new Error("expected resumable state from the first call");
    const resumeState: PendingApprovalWait = captured;

    // Re-initiation: the host calls operate_pay again with the SAME
    // arguments (unaware or not of the prior pending call) — the MCP tool
    // layer supplies resumeFrom from session state. The phone has now
    // responded.
    env.setApproved();
    const resolvedCardRefs: string[] = [];
    const second = (await executeOperatePay(baseArgs, env.api, env.browser, {
      fetch: env.fetch,
      sleep: async () => undefined,
      vouchflowApiBase: "https://vouchflow.test",
      vouchflowExpectedAudience: "customer_test",
      webBase: "https://web.test",
      surfaceApprovalUrl,
      onCardResolved: (ref) => resolvedCardRefs.push(ref),
      resumeFrom: resumeState,
      pollBudgetMs: 0,
    })) as Record<string, unknown>;

    expect(second).toMatchObject({ status: "payment_submitted", merchant: CHECKOUT.merchant });
    expect(env.filledCards).toEqual([SYNTHETIC_CARD]);
    expect(resolvedCardRefs).toEqual(["card_resume"]);
    // Exactly ONE approval was ever minted across both calls — the exact
    // duplicate-approval pile-up the friction audit flagged.
    expect(env.approvalBodies).toHaveLength(1);
    // Re-requests deliberately re-surface the same live URL so the host can
    // deliver another approval notice without minting another authorization.
    expect(surfaceApprovalUrl).toHaveBeenCalledTimes(2);
    expect(surfaceApprovalUrl).toHaveBeenNthCalledWith(1, "https://web.test/vault/pay/appr_resume");
    expect(surfaceApprovalUrl).toHaveBeenNthCalledWith(2, "https://web.test/vault/pay/appr_resume");
  });

  it("charges a pending final relay with a zero poll budget", async () => {
    const env = buildResumableEnv();
    let pending: PendingApprovalWait | null = null;
    await executeOperatePay(baseArgs, env.api, env.browser, {
      fetch: env.fetch,
      vouchflowApiBase: "https://vouchflow.test",
      vouchflowExpectedAudience: "customer_test",
      webBase: "https://web.test",
      surfaceApprovalUrl: vi.fn(),
      onApprovalPending: (state) => {
        pending = state;
      },
      pollBudgetMs: 0,
    });
    if (pending === null) throw new Error("expected initial resumable approval");

    env.setPendingApproved();
    const result = await executeOperatePay(baseArgs, env.api, env.browser, {
      fetch: env.fetch,
      vouchflowApiBase: "https://vouchflow.test",
      vouchflowExpectedAudience: "customer_test",
      webBase: "https://web.test",
      surfaceApprovalUrl: vi.fn(),
      resumeFrom: pending,
      pollBudgetMs: 0,
    });

    expect(result).toMatchObject({ status: "payment_submitted" });
    expect(env.browser.fillAndSubmitCheckout).toHaveBeenCalledOnce();
    expect(env.filledCards).toEqual([SYNTHETIC_CARD]);
  });

  it("refuses the charge when approval expires at the final browser dispatch fence", async () => {
    const env = buildResumableEnv();
    let now = Date.now();
    let pending: PendingApprovalWait | null = null;
    await executeOperatePay(baseArgs, env.api, env.browser, {
      fetch: env.fetch,
      vouchflowApiBase: "https://vouchflow.test",
      vouchflowExpectedAudience: "customer_test",
      webBase: "https://web.test",
      surfaceApprovalUrl: vi.fn(),
      onApprovalPending: (state) => {
        pending = state;
      },
      pollBudgetMs: 0,
      now: () => now,
    });
    if (pending === null) throw new Error("expected initial resumable approval");
    env.setPendingApproved();
    const deadline = Date.parse(env.expiresAt);
    now = deadline - 1;
    vi.mocked(env.browser.fillAndSubmitCheckout).mockImplementation(async (_card, options) => {
      now = deadline;
      options?.beforeSubmitDispatch?.();
      throw new Error("charge dispatch should have been refused");
    });

    const result = await executeOperatePay(baseArgs, env.api, env.browser, {
      fetch: env.fetch,
      vouchflowApiBase: "https://vouchflow.test",
      vouchflowExpectedAudience: "customer_test",
      webBase: "https://web.test",
      surfaceApprovalUrl: vi.fn(),
      resumeFrom: pending,
      pollBudgetMs: 0,
      now: () => now,
    });

    expect(result).toMatchObject({ status: "payment_approval_timeout" });
    expect(env.browser.fillAndSubmitCheckout).toHaveBeenCalledOnce();
    expect(env.filledCards).toEqual([]);
  });

  it("keeps a zero-budget review candidate distinct, then charges a subsequent final candidate on the same approval", async () => {
    const env = buildResumableEnv();
    const mountedShopifyPanValues = ["", ""];
    vi.mocked(env.browser.fillAndSubmitCheckout).mockImplementation(async (card) => {
      mountedShopifyPanValues[0] = card.pan;
      env.filledCards.push(card);
      return { three_ds_required: false, order_confirmed: true };
    });
    let pending: PendingApprovalWait | null = null;
    await executeOperatePay(baseArgs, env.api, env.browser, {
      fetch: env.fetch,
      vouchflowApiBase: "https://vouchflow.test",
      vouchflowExpectedAudience: "customer_test",
      webBase: "https://web.test",
      surfaceApprovalUrl: vi.fn(),
      onApprovalPending: (state) => {
        pending = state;
      },
      pollBudgetMs: 0,
    });
    if (pending === null) throw new Error("expected initial resumable approval");

    env.setReview();
    let afterReview: PendingApprovalWait | null = null;
    const reviewResult = await executeOperatePay(baseArgs, env.api, env.browser, {
      fetch: env.fetch,
      vouchflowApiBase: "https://vouchflow.test",
      vouchflowExpectedAudience: "customer_test",
      webBase: "https://web.test",
      surfaceApprovalUrl: vi.fn(),
      resumeFrom: pending,
      onApprovalPending: (state) => {
        afterReview = state;
      },
      pollBudgetMs: 0,
    });

    expect(reviewResult).toMatchObject({
      status: "approval_pending_final_signature",
      candidate_kind: "review",
      ready_to_charge: false,
    });
    expect(env.browser.fillAndSubmitCheckout).not.toHaveBeenCalled();
    expect(mountedShopifyPanValues).toEqual(["", ""]);
    expect(env.approvalBodies).toHaveLength(1);
    if (afterReview === null) throw new Error("expected review-specific resumable approval");
    const reviewResume = afterReview as PendingApprovalWait;
    expect(reviewResume.reviewVerified).toBe(true);

    env.setApproved();
    const finalResult = await executeOperatePay(baseArgs, env.api, env.browser, {
      fetch: env.fetch,
      vouchflowApiBase: "https://vouchflow.test",
      vouchflowExpectedAudience: "customer_test",
      webBase: "https://web.test",
      surfaceApprovalUrl: vi.fn(),
      resumeFrom: reviewResume,
      pollBudgetMs: 0,
    });

    expect(finalResult).toMatchObject({ status: "payment_submitted" });
    expect(env.approvalBodies).toHaveLength(1);
    expect(env.browser.fillAndSubmitCheckout).toHaveBeenCalledOnce();
    expect(mountedShopifyPanValues[0]).toBe(SYNTHETIC_CARD.pan);
  });

  it.each([
    ["JWS verification", "setInvalidFinalJws", "payment_mandate_verification_failed"],
    ["card open", "setInvalidFinalCard", "payment_card_open_failed"],
  ] as const)(
    "returns an explicit error for a pending final candidate whose %s fails",
    async (_label, setter, expectedStatus) => {
      const env = buildResumableEnv();
      let pending: PendingApprovalWait | null = null;
      await executeOperatePay(baseArgs, env.api, env.browser, {
        fetch: env.fetch,
        vouchflowApiBase: "https://vouchflow.test",
        vouchflowExpectedAudience: "customer_test",
        webBase: "https://web.test",
        surfaceApprovalUrl: vi.fn(),
        onApprovalPending: (state) => {
          pending = state;
        },
        pollBudgetMs: 0,
      });
      if (pending === null) throw new Error("expected resumable approval");
      env[setter]();

      const result = await executeOperatePay(baseArgs, env.api, env.browser, {
        fetch: env.fetch,
        vouchflowApiBase: "https://vouchflow.test",
        vouchflowExpectedAudience: "customer_test",
        webBase: "https://web.test",
        surfaceApprovalUrl: vi.fn(),
        resumeFrom: pending,
        pollBudgetMs: 0,
      });

      expect(result).toMatchObject({
        status: expectedStatus,
        candidate_kind: "approval",
      });
      expect(result.status).not.toBe("approval_pending");
      expect(env.browser.fillAndSubmitCheckout).not.toHaveBeenCalled();
    },
  );

  it("preserves the resumed keypair when configuration lookup fails", async () => {
    const env = buildResumableEnv();
    let captured: PendingApprovalWait | null = null;
    await executeOperatePay(baseArgs, env.api, env.browser, {
      fetch: env.fetch,
      vouchflowApiBase: "https://vouchflow.test",
      vouchflowExpectedAudience: "customer_test",
      webBase: "https://web.test",
      surfaceApprovalUrl: vi.fn(),
      onApprovalPending: (state) => {
        captured = state;
      },
      pollBudgetMs: 0,
    });
    if (captured === null) throw new Error("expected resumable state");
    const resumeState: PendingApprovalWait = captured;
    const privateKey = resumeState.keypair.privateKey;
    vi.spyOn(env.api, "getPaymentConfig").mockRejectedValueOnce(
      new Error("configuration unavailable"),
    );
    let restored: PendingApprovalWait | null = null;

    await expect(
      executeOperatePay(baseArgs, env.api, env.browser, {
        fetch: env.fetch,
        vouchflowApiBase: "https://vouchflow.test",
        webBase: "https://web.test",
        surfaceApprovalUrl: vi.fn(),
        onApprovalPending: (state) => {
          restored = state;
        },
        resumeFrom: resumeState,
        pollBudgetMs: 0,
      }),
    ).rejects.toThrow("configuration unavailable");
    expect(restored).toBe(resumeState);
    expect(resumeState.keypair.privateKey).toBe(privateKey);
  });

  it("does not hand a resumed approval back after submission starts", async () => {
    const env = buildResumableEnv();
    let captured: PendingApprovalWait | null = null;
    await executeOperatePay(baseArgs, env.api, env.browser, {
      fetch: env.fetch,
      vouchflowApiBase: "https://vouchflow.test",
      vouchflowExpectedAudience: "customer_test",
      webBase: "https://web.test",
      surfaceApprovalUrl: vi.fn(),
      onApprovalPending: (state) => {
        captured = state;
      },
      pollBudgetMs: 0,
    });
    if (captured === null) throw new Error("expected resumable state");
    const resumeState: PendingApprovalWait = captured;
    env.setApproved();
    vi.mocked(env.browser.fillAndSubmitCheckout).mockResolvedValue({
      three_ds_required: true,
      order_confirmed: false,
    });
    vi.mocked(env.browser.waitForThreeDsResolution).mockRejectedValue(new Error("3DS unavailable"));
    const onApprovalPending = vi.fn();

    await expect(
      executeOperatePay(baseArgs, env.api, env.browser, {
        fetch: env.fetch,
        vouchflowApiBase: "https://vouchflow.test",
        vouchflowExpectedAudience: "customer_test",
        webBase: "https://web.test",
        surfaceApprovalUrl: vi.fn(),
        onApprovalPending,
        resumeFrom: resumeState,
        pollBudgetMs: 0,
      }),
    ).rejects.toThrow("3DS unavailable");
    expect(onApprovalPending).not.toHaveBeenCalled();
  });

  it("resumes a JIT split fill without requiring a total on the card page", async () => {
    const env = buildResumableEnv(SPLIT_CHECKOUT);
    vi.mocked(env.browser.readCheckoutSummary).mockRejectedValue(
      new Error("payment_checkout_total_not_found"),
    );
    const args = {
      item: "Split item",
      reason: "Split purchase reason",
      phase: "fill_card" as const,
    };
    const cartFallbackCheckout = {
      checkout: SPLIT_CHECKOUT,
      url: `${SPLIT_CHECKOUT.checkout_origin}/cart`,
      observedAt: 1,
    } satisfies CartCheckoutObservation;
    let captured: PendingApprovalWait | null = null;
    await executeOperatePay(args, env.api, env.browser, {
      fetch: env.fetch,
      vouchflowApiBase: "https://vouchflow.test",
      vouchflowExpectedAudience: "customer_test",
      webBase: "https://web.test",
      surfaceApprovalUrl: vi.fn(),
      cartFallbackCheckout,
      onApprovalPending: (state) => {
        captured = state;
      },
      pollBudgetMs: 0,
    });
    if (captured === null) throw new Error("expected resumable state");
    env.setApproved();

    await expect(
      executeOperatePay(args, env.api, env.browser, {
        fetch: env.fetch,
        vouchflowApiBase: "https://vouchflow.test",
        vouchflowExpectedAudience: "customer_test",
        webBase: "https://web.test",
        surfaceApprovalUrl: vi.fn(),
        cartFallbackCheckout,
        resumeFrom: captured,
        pollBudgetMs: 0,
      }),
    ).resolves.toMatchObject({ status: "payment_card_filled" });
    expect(env.browser.readCheckoutSummary).toHaveBeenCalledOnce();
    expect(env.browser.fillCheckoutCardFields).toHaveBeenCalledOnce();
  });

  it("refuses a resumed single-page payment when the live checkout drifted", async () => {
    const env = buildResumableEnv();
    let captured: PendingApprovalWait | null = null;
    await executeOperatePay(baseArgs, env.api, env.browser, {
      fetch: env.fetch,
      vouchflowApiBase: "https://vouchflow.test",
      vouchflowExpectedAudience: "customer_test",
      webBase: "https://web.test",
      surfaceApprovalUrl: vi.fn(),
      onApprovalPending: (state) => {
        captured = state;
      },
      pollBudgetMs: 0,
    });
    if (captured === null) throw new Error("expected resumable state");
    env.setApproved();
    vi.mocked(env.browser.readCheckoutSummary).mockResolvedValue({
      ...CHECKOUT,
      amount_cents: CHECKOUT.amount_cents + 1,
    });

    await expect(
      executeOperatePay(baseArgs, env.api, env.browser, {
        fetch: env.fetch,
        vouchflowApiBase: "https://vouchflow.test",
        vouchflowExpectedAudience: "customer_test",
        webBase: "https://web.test",
        surfaceApprovalUrl: vi.fn(),
        resumeFrom: captured,
        pollBudgetMs: 0,
      }),
    ).resolves.toMatchObject({
      status: "payment_amount_mismatch",
      mandate_amount_cents: CHECKOUT.amount_cents,
      live_amount_cents: CHECKOUT.amount_cents + 1,
    });
    expect(env.filledCards).toHaveLength(0);
  });

  it("bounds the wait to pollBudgetMs, never the full approval deadline", async () => {
    const env = buildResumableEnv();
    let clock = 0;
    const sleepCalls: number[] = [];

    const result = (await executeOperatePay(baseArgs, env.api, env.browser, {
      fetch: env.fetch,
      now: () => clock,
      sleep: async (ms) => {
        sleepCalls.push(ms);
        clock += ms;
      },
      vouchflowApiBase: "https://vouchflow.test",
      vouchflowExpectedAudience: "customer_test",
      webBase: "https://web.test",
      surfaceApprovalUrl: vi.fn(),
      onApprovalPending: () => undefined,
      pollBudgetMs: 10_000,
    })) as Record<string, unknown>;

    expect(result.status).toBe("approval_pending");
    // pollIntervalMs defaults to 3000ms — a 10s budget polls a handful of
    // times then gives up, nowhere near the server approval deadline.
    expect(sleepCalls.length).toBeGreaterThan(0);
    expect(sleepCalls.every((ms) => ms === 3_000)).toBe(true);
    expect(clock).toBeLessThan(13_000);
  });

  it("returns a resumable approval when the long-poll transport times out", async () => {
    const env = buildResumableEnv();
    const getPaymentApproval = vi.spyOn(env.api, "getPaymentApproval").mockImplementation(
      async (_id, candidateRead) => {
        if (candidateRead === true) {
          const error = new Error("approval transport timed out");
          error.name = "TimeoutError";
          throw error;
        }
        throw new Error("unexpected immediate approval read");
      },
    );
    const onApprovalPending = vi.fn();

    const result = await executeOperatePay(baseArgs, env.api, env.browser, {
      fetch: env.fetch,
      vouchflowApiBase: "https://vouchflow.test",
      vouchflowExpectedAudience: "customer_test",
      webBase: "https://web.test",
      surfaceApprovalUrl: vi.fn(),
      onApprovalPending,
      pollBudgetMs: 1_000,
    });

    expect(result).toMatchObject({ status: "approval_pending", approval_id: "appr_resume" });
    expect(onApprovalPending).toHaveBeenCalledOnce();
    expect(getPaymentApproval).toHaveBeenCalledWith(
      "appr_resume",
      true,
      expect.any(Number),
      expect.any(Number),
    );
  });

  it("aborts a stalled payment-approval transport at its request bound", async () => {
    let observedSignal: AbortSignal | undefined;
    const api = new ApiClient({
      apiBaseUrl: "https://api.test",
      registryBaseUrl: "https://registry.test",
      agentSessionToken: "synthetic-session",
      fetch: (async (_input, init) => {
        observedSignal = init?.signal ?? undefined;
        return await new Promise<Response>((_resolve, reject) => {
          observedSignal?.addEventListener("abort", () => reject(observedSignal?.reason), {
            once: true,
          });
        });
      }) as typeof fetch,
    });

    await expect(api.getPaymentApproval("appr_stalled", true, 5_000, 25)).rejects.toMatchObject({
      name: "TimeoutError",
    });
    expect(observedSignal).toBeDefined();
    expect(observedSignal?.aborted).toBe(true);
  });
});
