import { createHash, generateKeyPairSync } from "node:crypto";
import canonicalize from "canonicalize";
import { exportJWK, SignJWT } from "jose";
import { describe, expect, it, vi } from "vitest";
import { ApiClient } from "../../api-client.js";
import { executeOperatePay, type PaymentBrowser } from "../pay-operator.js";
import { generateOperatorKeypair, sealToRecipient } from "../payment-hpke.js";
import type { CheckoutCard } from "../browser.js";

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
  | "tampered_amount"
  | "tampered_origin"
  | "wrong_recipient"
  | "wrong_issuer"
  | "wrong_audience"
  | "audit_failure";

async function harness(
  mode: Mode,
  expectedAudience: string | null = "customer_test",
  apiAudience?: string,
) {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const jwk = await exportJWK(publicKey);
  const auditBodies: unknown[] = [];
  const approvalBodies: Array<Record<string, unknown>> = [];
  const filledCards: CheckoutCard[] = [];
  const nonce = "synthetic-nonce";

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
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        },
        { status: 201 },
      );
    }
    if (url.endsWith("/v1/pay/approvals/approval_test") && init?.method === "GET") {
      const approval = approvalBodies[0]!;
      const operatorPublicKey = String(approval.operator_pubkey);
      const recipientHash = createHash("sha256")
        .update(Buffer.from(operatorPublicKey, "base64url"))
        .digest("base64url");
      const payload = {
        merchant: CHECKOUT.merchant,
        checkout_origin:
          mode === "tampered_origin" ? "https://evil.synthetic.test" : CHECKOUT.checkout_origin,
        amount_cents:
          mode === "tampered_amount" ? CHECKOUT.amount_cents + 1 : CHECKOUT.amount_cents,
        currency: CHECKOUT.currency,
        nonce,
        card_ref: "card_test",
        recipient_pubkey_hash: recipientHash,
      };
      const canonical = canonicalize(payload)!;
      const aad = createHash("sha256").update(canonical, "utf8").digest();
      const assertion = await new SignJWT({
        payload_sha256: aad.toString("base64url"),
        context: "purchase",
        confidence: "high",
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
        status: "approved",
        ...CHECKOUT,
        nonce,
        card_ref: "card_test",
        operator_pubkey: operatorPublicKey,
        jws: assertion,
        sealed_card: sealedCard,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      });
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
    readCheckoutSummary: vi.fn().mockResolvedValue(CHECKOUT),
    currentUrl: vi.fn().mockReturnValue(`${CHECKOUT.checkout_origin}/session/test`),
    fillAndSubmitCheckout: vi.fn(async (card: CheckoutCard) => {
      filledCards.push(card);
      return { three_ds_required: false };
    }),
  };
  const api = new ApiClient({
    apiBaseUrl: "https://api.test",
    registryBaseUrl: "https://registry.test",
    agentSessionToken: "synthetic-session-token",
    fetch: fetchMock,
  });
  const result = await executeOperatePay(
    {
      card_ref: "card_test",
      merchant: "Agent Supplied Merchant",
      amount_cents: 1,
      currency: "EUR",
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
    },
  );

  return { result, approvalBodies, auditBodies, filledCards };
}

describe("operate_pay", () => {
  it("verifies the mandate, opens the card, fills the checkout, and audits last4 only", async () => {
    const { result, approvalBodies, auditBodies, filledCards } = await harness("happy");

    expect(result).toMatchObject({
      status: "payment_submitted",
      merchant: CHECKOUT.merchant,
      amount_cents: CHECKOUT.amount_cents,
      currency: CHECKOUT.currency,
    });
    expect(approvalBodies[0]).toMatchObject({
      ...CHECKOUT,
      card_ref: "card_test",
    });
    expect(filledCards).toEqual([SYNTHETIC_CARD]);
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
});
