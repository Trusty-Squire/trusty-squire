// ── web ↔ mcp payment-mandate canonical-form SEAM test ─────────────────────
//
// This is the one seam that per-package tests structurally CANNOT cover:
//
//   • The WEB pay page (apps/web/app/vault/pay/[id]/page.tsx) builds a mandate
//     payload and passkey-signs it. Its canonical bytes come from the
//     @vouchflow/web SDK's OWN `canonicalize()` (dist/index.js → src/verify/
//     canonicalize.ts), NOT the npm `canonicalize` package.
//   • The MCP verifier (apps/mcp/src/bot/pay-operator.ts → verifyMandate)
//     re-canonicalizes with the npm `canonicalize` package and checks that the
//     JWS's `payload_sha256` claim (and the HPKE AAD sealing the card) match.
//
// If the two canonicalizers disagree on a single byte — field set, key order,
// number formatting, string escaping — every JIT payment silently rejects with
// `payload_hash_mismatch`. The existing pay-operator.test.ts cannot catch this:
// it builds its mandate with the SAME npm `canonicalize` the verifier uses, so
// it would stay green even if the WEB SDK canonicalized differently.
//
// This test closes that gap by importing the REAL @vouchflow/web `canonicalize`
// (the exact code the web app ships at the pinned 0.3.1) as the SIGNING side,
// and driving the mandate through the REAL, unmocked mcp `executeOperatePay`
// (npm `canonicalize`) as the VERIFYING side. A pass proves the two canonical
// forms are byte-identical for the production payload; a hash-mismatch would be
// a genuine cross-package drift, not a test artifact.
//
// What is PROVEN vs ASSUMED:
//   PROVEN in-process: web-SDK canonicalize(payload)  ≡  mcp npm-canonicalize
//     (byte-identical → same SHA-256 → verifyMandate PASSES / card unseals),
//     for the EXACT payload object the web page constructs (fields + values),
//     and that a card_ref or amount swap FAILS closed.
//   ASSUMED (not reachable in a unit test, by construction): that the vouchflow
//     SERVER sets `payload_sha256 = SHA-256(canonicalized_payload)` over the
//     bytes the client sent (the SDK POSTs `canonicalized_payload` to /v1/sign).
//     We stand in for the server by signing a JWS whose `payload_sha256` is
//     SHA-256 of the SDK's canonical bytes — the documented server contract.

import { createHash, generateKeyPairSync, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import canonicalize from "canonicalize";
import { canonicalize as vouchflowCanonicalize } from "@vouchflow/web";
import { exportJWK, SignJWT } from "jose";
import { describe, expect, it, vi } from "vitest";
import { ApiClient } from "../../api-client.js";
import { executeOperatePay, type PaymentBrowser } from "../pay-operator.js";
import { sealToRecipient } from "../payment-hpke.js";
import type { CheckoutCard, CheckoutSummary } from "../browser.js";

const CHECKOUT: CheckoutSummary = {
  merchant: "Synthetic Merchant",
  checkout_origin: "https://checkout.synthetic.test",
  amount_cents: 4_299,
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
    city: "Testville",
    state: "NY",
    postal_code: "10001",
    country: "US",
  },
};

// The mandate field set, in the order the web page + mcp both declare it. This
// list is the contract; the guard test below reads the REAL page.tsx source and
// fails if the web payload builder ever drifts from it (closing the "the React
// assembly code isn't executed in-process" gap — it can't be: signPayload fires
// a real WebAuthn passkey ceremony + vouchflow network calls).
const MANDATE_FIELDS = [
  "approval_id",
  "merchant",
  "checkout_origin",
  "amount_cents",
  "currency",
  "nonce",
  "card_ref",
  "recipient_pubkey_hash",
  "item",
  "reason",
  "agent",
] as const;

// Extract the KEYS of the `const payload = { ... }` object literal from a source
// file (the web page or the mcp operator). Deliberately source-text based so it
// pins the actual production field SET, not a re-import.
function payloadObjectKeys(source: string, anchor: string): string[] {
  const start = source.indexOf(anchor);
  if (start === -1) throw new Error(`anchor not found: ${anchor}`);
  const open = source.indexOf("{", start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const body = source.slice(open + 1, end);
  // Top-level property at the start of a line. Matches both explicit (`key:`)
  // and ES shorthand (`key,`) — mcp writes `item,`/`reason,` shorthand, the web
  // page writes `item: approval.item`. The payload here is flat (no nesting).
  return [...body.matchAll(/^\s*([a-z_]+)\s*[:,]/gm)].map((m) => m[1]!);
}

// Mirrors the WEB page's base64url of SHA-256(operator pubkey bytes):
//   apps/web/.../page.tsx:241-252  publicKeyHash = SHA-256(fromBase64Url(op_pk));
//   recipient_pubkey_hash = toBase64Url(new Uint8Array(publicKeyHash))
function recipientPubkeyHash(operatorPubkeyBase64Url: string): string {
  return createHash("sha256")
    .update(Buffer.from(operatorPubkeyBase64Url, "base64url"))
    .digest("base64url");
}

// Build + sign the mandate EXACTLY as apps/web/app/vault/pay/[id]/page.tsx does:
// the `payload` object literal (lines 245-256, field set + order reproduced
// verbatim) fed through the @vouchflow/web SDK's own canonicalize(), then the
// vouchflow server contract (payload_sha256 = SHA-256(canonical bytes)) stood
// in for with a test RSA key. `aad` = SHA-256(canonical), used to HPKE-seal the
// card, exactly as page.tsx does (aad = SHA-256(sign.payload)).
async function signMandateLikeWeb(params: {
  operatorPubkey: string;
  privateKey: KeyObject;
  nonce: string;
  agent: string;
  // Values the PHONE signs over. Aligned case = the same values the mcp will
  // reconstruct from checkout/approval; swap cases drift one field.
  cardRef: string;
  amountCents: number;
  approvalId?: string;
  item: string;
  reason: string;
  confidence?: "low" | "medium" | "high";
}): Promise<{ jws: string; sealed_card: string; canonical: string }> {
  // ↓↓↓ VERBATIM field construction from page.tsx (the production web payload).
  const payload = {
    approval_id: params.approvalId ?? "appr_seam",
    merchant: CHECKOUT.merchant,
    checkout_origin: CHECKOUT.checkout_origin,
    amount_cents: params.amountCents,
    currency: CHECKOUT.currency,
    nonce: params.nonce,
    card_ref: params.cardRef,
    recipient_pubkey_hash: recipientPubkeyHash(params.operatorPubkey),
    item: params.item,
    reason: params.reason,
    agent: params.agent,
  };
  // THE SEAM: web canonical bytes come from the @vouchflow/web SDK, not npm.
  const canonical = vouchflowCanonicalize(payload);
  const aadBuf = createHash("sha256").update(canonical, "utf8").digest();
  const jws = await new SignJWT({
    payload_sha256: aadBuf.toString("base64url"),
    context: "purchase",
    confidence: params.confidence ?? "low",
    mandate_id: "seam-mandate",
  })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer("https://vouchflow.dev")
    .setAudience("customer_test")
    .sign(params.privateKey);
  const sealed_card = await sealToRecipient(
    params.operatorPubkey,
    new TextEncoder().encode(JSON.stringify(SYNTHETIC_CARD)),
    new Uint8Array(aadBuf),
  );
  return { jws, sealed_card, canonical };
}

async function signReviewLikeWeb(params: {
  operatorPubkey: string;
  privateKey: KeyObject;
  approvalPayloadSha256: string;
  cardRef: string;
}): Promise<{ jws: string; sealed_card: string }> {
  const payload = {
    approval_id: "appr_seam",
    approval_payload_sha256: params.approvalPayloadSha256,
    card_ref: params.cardRef,
    recipient_pubkey_hash: recipientPubkeyHash(params.operatorPubkey),
  };
  const canonical = vouchflowCanonicalize(payload);
  const aad = createHash("sha256").update(canonical, "utf8").digest();
  const jws = await new SignJWT({
    payload_sha256: aad.toString("base64url"),
    context: "purchase",
    confidence: "low",
    mandate_id: "seam-review",
  })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer("https://vouchflow.dev")
    .setAudience("customer_test")
    .sign(params.privateKey);
  const sealed_card = await sealToRecipient(
    params.operatorPubkey,
    new TextEncoder().encode(JSON.stringify(SYNTHETIC_CARD)),
    new Uint8Array(aad),
  );
  return { jws, sealed_card };
}

// Drives the REAL executeOperatePay JIT resume path: a card-less approval whose
// card_ref is bound SERVER-SIDE and read back on resume (per #403). The operator
// holds NO args.card_ref, so it can only pass verifyMandate by re-canonicalizing
// (with npm canonicalize) over the same fields the web SDK signed.
async function runSeam(cfg: {
  boundCardRef: string; // what the server binds + echoes as approval.card_ref
  signCardRef?: string; // what the phone signs over (default = bound)
  signAmountCents?: number; // what the phone signs over (default = checkout)
  signApprovalId?: string; // what the phone signs over (default = current approval)
  confidence?: "low" | "medium" | "high";
}): Promise<{
  result: Record<string, unknown>;
  filledCards: CheckoutCard[];
  canonical: string;
  confirmationBodies: Array<Record<string, unknown>>;
  resolvedCardRefs: string[];
}> {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = await exportJWK(publicKey);
  const approvalBodies: Array<Record<string, unknown>> = [];
  const confirmationBodies: Array<Record<string, unknown>> = [];
  const filledCards: CheckoutCard[] = [];
  const resolvedCardRefs: string[] = [];
  const nonce = "seam-nonce";
  const agent = "seam-agent@host";
  let clock = 0;
  let webCanonical = "";
  let reviewVerified = false;
  let approved = false;
  let reviewCandidate: { jws: string; sealed_card: string } | undefined;
  let finalCandidate: { jws: string; sealed_card: string } | undefined;

  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === "https://vouchflow.test/.well-known/jwks.json") {
      return Response.json({ keys: [{ ...jwk, alg: "RS256", use: "sig", kid: "test-key" }] });
    }
    if (url.endsWith("/v1/pay/approvals") && init?.method === "POST") {
      approvalBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return Response.json(
        { id: "appr_seam", nonce, agent, expires_at: new Date(8.64e15).toISOString() },
        { status: 201 },
      );
    }
    if (
      (url.endsWith("/v1/pay/approvals/appr_seam") ||
        url.endsWith("/v1/pay/approvals/appr_seam?wait_for_submission=1")) &&
      init?.method === "GET"
    ) {
      const operatorPubkey = String(approvalBodies[0]!.operator_pubkey);
      if (!reviewVerified) {
        const approvalCanonical = canonicalize({
          approval_id: "appr_seam",
          ...CHECKOUT,
          nonce,
          card_ref: cfg.boundCardRef,
          recipient_pubkey_hash: recipientPubkeyHash(operatorPubkey),
          item: "Synthetic seam item",
          reason: "Synthetic seam purchase reason",
          agent,
        })!;
        reviewCandidate ??= await signReviewLikeWeb({
          operatorPubkey,
          privateKey,
          approvalPayloadSha256: createHash("sha256")
            .update(approvalCanonical, "utf8")
            .digest("base64url"),
          cardRef: cfg.boundCardRef,
        });
      } else {
        if (finalCandidate === undefined) {
          const { jws, sealed_card, canonical } = await signMandateLikeWeb({
            operatorPubkey,
            privateKey,
            nonce,
            agent,
            cardRef: cfg.signCardRef ?? cfg.boundCardRef,
            amountCents: cfg.signAmountCents ?? CHECKOUT.amount_cents,
            ...(cfg.signApprovalId !== undefined ? { approvalId: cfg.signApprovalId } : {}),
            item: "Synthetic seam item",
            reason: "Synthetic seam purchase reason",
            ...(cfg.confidence !== undefined ? { confidence: cfg.confidence } : {}),
          });
          finalCandidate = { jws, sealed_card };
          webCanonical = canonical;
        }
      }
      const candidate = reviewVerified ? finalCandidate! : reviewCandidate!;
      return Response.json({
        id: "appr_seam",
        status: approved ? "approved" : "pending",
        ...CHECKOUT,
        nonce,
        card_ref: cfg.boundCardRef, // server-bound ref the operator resumes with
        operator_pubkey: operatorPubkey,
        ...candidate,
        expires_at: new Date(8.64e15).toISOString(),
      });
    }
    if (url.endsWith("/v1/pay/approvals/appr_seam/confirm") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      confirmationBodies.push(body);
      if (!reviewVerified) {
        reviewVerified = true;
        return Response.json({ status: "verified" });
      }
      approved = true;
      return Response.json({ status: "approved" });
    }
    if (url.endsWith("/v1/vault/payments/audit") && init?.method === "POST") {
      return Response.json({ id: "audit_seam" }, { status: 201 });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  }) as typeof fetch;

  const browser: PaymentBrowser = {
    isPayPalHostedCheckout: vi.fn().mockResolvedValue(false),
    readCheckoutSummary: vi.fn().mockResolvedValue(CHECKOUT),
    currentUrl: vi.fn().mockReturnValue(`${CHECKOUT.checkout_origin}/session/test`),
    fillAndSubmitCheckout: vi.fn(async (card: CheckoutCard) => {
      filledCards.push(card);
      return { three_ds_required: false };
    }),
    fillCheckoutCardFields: vi.fn(),
    submitFilledCheckout: vi.fn(),
    clearSealedPaymentFields: vi.fn().mockResolvedValue(undefined),
    waitForThreeDsResolution: vi.fn().mockResolvedValue("timeout"),
  };

  const api = new ApiClient({
    apiBaseUrl: "https://api.test",
    registryBaseUrl: "https://registry.test",
    agentSessionToken: "synthetic-session-token",
    fetch: fetchMock,
  });

  // JIT ceremony: NO card_ref in args (card is bound server-side mid-ceremony).
  const result = (await executeOperatePay(
    {
      merchant: CHECKOUT.merchant,
      amount_cents: CHECKOUT.amount_cents,
      currency: CHECKOUT.currency,
      item: "Synthetic seam item",
      reason: "Synthetic seam purchase reason",
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
      pollIntervalMs: 1,
      jitApprovalTimeoutMs: 3,
      onCardResolved: (cardRef) => resolvedCardRefs.push(cardRef),
    },
  )) as Record<string, unknown>;

  return { result, filledCards, canonical: webCanonical, confirmationBodies, resolvedCardRefs };
}

describe("web ↔ mcp mandate canonical form (cross-package seam)", () => {
  it("GUARD: the real web page.tsx AND mcp pay-operator.ts declare the SAME payload field set (in order)", () => {
    const webSource = readFileSync(
      fileURLToPath(new URL("../../../../web/app/vault/pay/[id]/page.tsx", import.meta.url)),
      "utf8",
    );
    const mcpSource = readFileSync(
      fileURLToPath(new URL("../pay-operator.ts", import.meta.url)),
      "utf8",
    );
    // Web builds `const payload = {`; mcp builds `const canonical = canonicalize({`.
    const webKeys = payloadObjectKeys(webSource, "const payload = {");
    const mcpKeys = payloadObjectKeys(mcpSource, "const canonical = canonicalize({");
    // Both must equal the contract this file signs/verifies over. If a future PR
    // adds/removes/reorders a web field without matching mcp, THIS fails — even
    // though the React assembly path can't run in-process.
    expect(webKeys).toEqual([...MANDATE_FIELDS]);
    expect(mcpKeys).toEqual([...MANDATE_FIELDS]);
  });

  it("web-SDK canonicalize and mcp npm-canonicalize are BYTE-IDENTICAL for the production payload", () => {
    // The literal fields the web page constructs (page.tsx:245-256).
    const payload = {
      approval_id: "appr_seam",
      merchant: CHECKOUT.merchant,
      checkout_origin: CHECKOUT.checkout_origin,
      amount_cents: CHECKOUT.amount_cents,
      currency: CHECKOUT.currency,
      nonce: "seam-nonce",
      card_ref: "card_bound_by_server",
      recipient_pubkey_hash: "Zm9vYmFyaGFzaA",
      item: "",
      reason: "",
      agent: "seam-agent@host",
    };
    const web = vouchflowCanonicalize(payload);
    const mcp = canonicalize(payload);
    expect(web).toBe(mcp);
    // And a couple of value classes that DO break naive canonicalizers.
    const edges = {
      ...payload,
      amount_cents: 0,
      merchant: 'Café ☕ "Ünïçøde" \\slash/',
      reason: "line1\nline2\ttab",
    };
    expect(vouchflowCanonicalize(edges)).toBe(canonicalize(edges));
  });

  it("PASSES: a web-signed (vouchflow-canonical) mandate verifies through the real mcp JIT path", async () => {
    const { result, filledCards, canonical, confirmationBodies, resolvedCardRefs } = await runSeam({
      boundCardRef: "card_bound_by_server",
    });
    // payment_submitted is only reachable if verifyMandate's payload_hash check
    // passed AND the HPKE card unsealed under the same AAD — both derive from the
    // canonical bytes. So this asserts the web/mcp canonical forms are identical.
    expect(result).toMatchObject({ status: "payment_submitted" });
    expect(filledCards).toEqual([expect.objectContaining({ pan: SYNTHETIC_CARD.pan })]);
    expect(confirmationBodies).toHaveLength(2);
    expect(resolvedCardRefs).toEqual(["card_bound_by_server"]);
    // Sanity: the signing side really used the vouchflow SDK canonicalizer, and
    // it equals what mcp would produce for the same object.
    expect(canonical).toBe(
      canonicalize({
        approval_id: "appr_seam",
        merchant: CHECKOUT.merchant,
        checkout_origin: CHECKOUT.checkout_origin,
        amount_cents: CHECKOUT.amount_cents,
        currency: CHECKOUT.currency,
        nonce: "seam-nonce",
        card_ref: "card_bound_by_server",
        recipient_pubkey_hash: canonical.match(/"recipient_pubkey_hash":"([^"]*)"/)![1],
        item: "Synthetic seam item",
        reason: "Synthetic seam purchase reason",
        agent: "seam-agent@host",
      }),
    );
  });

  it("FAILS closed: a card_ref swap (phone signs a different card than the server bound)", async () => {
    const { result, filledCards, confirmationBodies, resolvedCardRefs } = await runSeam({
      boundCardRef: "card_RIGHT",
      signCardRef: "card_WRONG",
    });
    expect(result).toMatchObject({ status: "payment_approval_timeout" });
    expect(filledCards).toHaveLength(0);
    expect(confirmationBodies).toHaveLength(1);
    expect(resolvedCardRefs).toHaveLength(0);
  });

  it("FAILS closed: an amount swap (phone signs a different amount than the checkout)", async () => {
    const { result, filledCards, confirmationBodies, resolvedCardRefs } = await runSeam({
      boundCardRef: "card_bound_by_server",
      signAmountCents: CHECKOUT.amount_cents + 100,
    });
    expect(result).toMatchObject({ status: "payment_approval_timeout" });
    expect(filledCards).toHaveLength(0);
    expect(confirmationBodies).toHaveLength(1);
    expect(resolvedCardRefs).toHaveLength(0);
  });

  it("FAILS closed: a final seal replayed from a different approval", async () => {
    const { result, filledCards, confirmationBodies, resolvedCardRefs } = await runSeam({
      boundCardRef: "card_bound_by_server",
      signApprovalId: "appr_other",
    });
    expect(result).toMatchObject({ status: "payment_approval_timeout" });
    expect(filledCards).toHaveLength(0);
    expect(confirmationBodies).toHaveLength(1);
    expect(resolvedCardRefs).toHaveLength(0);
  });
});
