// Tests for the surviving MCP tools.
//
// The native-provision cluster (provision/cancel/get_usage/list_services/
// list_subscriptions/rotate_credential/wait_for_approval) was sunset in
// 0.8 along with the runtime + mandate-validator packages. What's left:
// the interactive provisioning driver, vault tools, and extract-failure
// diagnostic pair.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiCallError, type ApiClient } from "../api-client.js";
import type { CheckoutSummary } from "../bot/browser.js";
import type { PaymentBrowser, PendingCardFill } from "../bot/pay-operator.js";
import type * as ProvisionSession from "../bot/provision-session.js";

// operate_pay's handler reaches into the single active browser session via
// activeProvisionBrowserForPayment(). There is no real session in a unit test, so mock
// just that getter (everything else in the module is preserved) and hand back
// a stub whose checkout summary the resolution tests can control.
let mockBrowser: PaymentBrowser;
let mockPending: PendingCardFill | null = null;
let mockPendingConfirming = false;
let mockSubmitStarted = false;
let mockPaymentLease: { phase: "fill_card" | "single" } | null = null;
let mockPaymentSealed = false;
let mockPaymentSealActive = false;
vi.mock("../bot/provision-session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ProvisionSession>();
  return {
    ...actual,
    activeProvisionBrowserForPayment: async () => mockBrowser,
    claimActivePaymentForOperatePay: (phase: "fill_card" | "confirm" | undefined) => {
      if (mockPaymentLease !== null) {
        throw new Error("operate_pay refused: another payment operation is already in progress");
      }
      if (mockPendingConfirming) {
        throw new Error("operate_pay refused: another payment confirmation is already in progress");
      }
      if (mockPaymentSealed) {
        throw new Error("operate_pay refused: payment field cleanup remains unverified");
      }
      if (mockPending !== null) {
        if (phase !== "confirm") {
          throw new Error(
            'operate_pay refused: a vaulted card fill is pending; phase="confirm" is required next',
          );
        }
        const pending = mockPending;
        mockPending = null;
        mockPendingConfirming = true;
        mockSubmitStarted = false;
        return { kind: "confirm", pending };
      }
      if (phase === "confirm") return { kind: "missing_confirm" };
      const lease = { phase: phase === "fill_card" ? ("fill_card" as const) : ("single" as const) };
      mockPaymentLease = lease;
      if (lease.phase === "fill_card") mockPaymentSealActive = true;
      return { kind: "lease", lease };
    },
    completeActivePaymentLeaseWithPendingFill: (
      lease: { phase: "fill_card" | "single" },
      pending: PendingCardFill,
    ) => {
      if (mockPaymentLease !== lease || lease.phase !== "fill_card") {
        throw new Error(
          "operate_pay fill_card completed without ownership of the active payment lease",
        );
      }
      mockPaymentLease = null;
      mockPending = pending;
      mockPaymentSealActive = true;
    },
    releaseActivePaymentLease: (
      lease: { phase: "fill_card" | "single" },
      paymentFieldsCleared = true,
    ) => {
      if (mockPaymentLease !== lease) return false;
      mockPaymentLease = null;
      mockPaymentSealed = !paymentFieldsCleared;
      if (lease.phase === "fill_card") mockPaymentSealActive = !paymentFieldsCleared;
      return true;
    },
    markActivePendingCardFillSubmitStarted: () => {
      mockSubmitStarted = true;
    },
    restoreActivePendingCardFillAfterConfirmThrow: (pending: PendingCardFill) => {
      if (!mockPendingConfirming || mockSubmitStarted) return false;
      mockPending = pending;
      mockPendingConfirming = false;
      return true;
    },
    setActivePendingCardFill: (pending: PendingCardFill) => {
      mockPending = pending;
      mockPendingConfirming = false;
      mockSubmitStarted = false;
      mockPaymentLease = null;
      mockPaymentSealed = false;
      mockPaymentSealActive = true;
    },
    retainActivePaymentFieldSeal: () => {
      if (mockPaymentLease === null) mockPaymentSealed = true;
      mockPaymentSealActive = true;
    },
    clearActivePendingCardFill: (paymentFieldsCleared = true) => {
      mockPending = null;
      mockPendingConfirming = false;
      mockSubmitStarted = false;
      mockPaymentLease = null;
      mockPaymentSealed = !paymentFieldsCleared;
      mockPaymentSealActive = !paymentFieldsCleared;
    },
  };
});

import {
  auditLogTool,
  listAppAccessTool,
  listCredentialsTool,
  listPaymentCardsTool,
  operatePayTool,
  revokeAppAccessTool,
  TOOLS,
} from "../tools/index.js";

function stubBrowser(): PaymentBrowser {
  return {
    isPayPalHostedCheckout: vi.fn().mockResolvedValue(false),
    readCheckoutSummary: vi.fn().mockResolvedValue({
      merchant: "M",
      checkout_origin: "https://m.test",
      amount_cents: 100,
      currency: "USD",
    }),
    readCheckoutConfirmSummary: vi.fn().mockResolvedValue({
      merchant: "M",
      checkout_origin: "https://m.test",
      amount_cents: 100,
      currency: "USD",
    }),
    fillAndSubmitCheckout: vi.fn().mockResolvedValue({ three_ds_required: false }),
    fillCheckoutCardFields: vi.fn().mockResolvedValue(undefined),
    submitFilledCheckout: vi.fn().mockResolvedValue({ three_ds_required: false }),
    clearSealedPaymentFields: vi.fn().mockResolvedValue(undefined),
    waitForThreeDsResolution: vi.fn().mockResolvedValue("timeout"),
    currentUrl: vi.fn().mockReturnValue("https://m.test/checkout"),
  };
}

const PAYMENT_DETAILS = { item: "Synthetic item", reason: "Synthetic purchase reason" };

beforeEach(() => {
  mockBrowser = stubBrowser();
  mockPending = null;
  mockPendingConfirming = false;
  mockSubmitStarted = false;
  mockPaymentLease = null;
  mockPaymentSealed = false;
  mockPaymentSealActive = false;
});

function makeMockApi(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    listCredentials: vi.fn(),
    ...overrides,
  } as unknown as ApiClient;
}

describe("list_credentials", () => {
  it("returns the vault credential metadata list", async () => {
    const listCredentials = vi.fn().mockResolvedValue({
      credentials: [
        {
          id: "c1",
          reference: "vault://acct/c1",
          service: "Resend",
          key_name: "RESEND_API_KEY",
          type: "api_key",
          created_at: "now",
          last_retrieved_at: null,
          retrieval_count: 0,
        },
      ],
    });
    const api = makeMockApi({ listCredentials } as unknown as ApiClient);
    const parsed = listCredentialsTool.inputSchema.parse({});
    const res = (await listCredentialsTool.handler(parsed, api)) as {
      credentials: { reference: string }[];
    };
    expect(res.credentials).toHaveLength(1);
    expect(res.credentials[0]?.reference).toBe("vault://acct/c1");
    expect(listCredentials).toHaveBeenCalledOnce();
  });

  it("requires an active session", async () => {
    await expect(listCredentialsTool.handler({}, null)).rejects.toThrow(/Trusty Squire session/);
  });
});

describe("list_payment_cards", () => {
  it("returns only saved card IDs and labels", async () => {
    const listPaymentCards = vi.fn().mockResolvedValue([{ id: "card_1", label: "Personal" }]);
    const api = makeMockApi({ listPaymentCards } as unknown as ApiClient);

    await expect(listPaymentCardsTool.handler({}, api)).resolves.toEqual({
      cards: [{ id: "card_1", label: "Personal" }],
    });
  });
});

describe("operate_pay card selection", () => {
  it("requires item and reason, accepts no selector, and rejects both selectors", () => {
    // Neither is now valid — the handler resolves against the cards on file
    // (0 → JIT ceremony, 1 → use it, >1 → error). Both is still rejected.
    expect(() => operatePayTool.inputSchema.parse({})).toThrow();
    expect(() => operatePayTool.inputSchema.parse({ item: " ", reason: "why" })).toThrow();
    expect(() => operatePayTool.inputSchema.parse(PAYMENT_DETAILS)).not.toThrow();
    expect(() =>
      operatePayTool.inputSchema.parse({
        ...PAYMENT_DETAILS,
        card_ref: "card_1",
        card_label: "Personal",
      }),
    ).toThrow();
  });

  it("surfaces PayPal-hosted checkout before resolving saved cards", async () => {
    mockBrowser = stubBrowser();
    vi.mocked(mockBrowser.isPayPalHostedCheckout).mockResolvedValue(true);
    const listPaymentCards = vi.fn();
    const api = makeMockApi({ listPaymentCards } as unknown as ApiClient);
    const args = operatePayTool.inputSchema.parse(PAYMENT_DETAILS);

    await expect(operatePayTool.handler(args, api)).resolves.toMatchObject({
      status: "paypal_checkout",
      reason: "paypal_hosted_fields_unfillable",
      needs_user: { wall: "paypal" },
    });
    expect(listPaymentCards).not.toHaveBeenCalled();
  });

  it("reports ambiguous card labels before opening the checkout", async () => {
    const listPaymentCards = vi.fn().mockResolvedValue([
      { id: "card_1", label: "Personal" },
      { id: "card_2", label: "Personal" },
    ]);
    const api = makeMockApi({ listPaymentCards } as unknown as ApiClient);
    const args = operatePayTool.inputSchema.parse({ ...PAYMENT_DETAILS, card_label: "Personal" });

    await expect(operatePayTool.handler(args, api)).rejects.toThrow(/Multiple saved payment cards/);
  });

  it("no selector + >1 cards on file errors listing the labels (never guesses)", async () => {
    const listPaymentCards = vi.fn().mockResolvedValue([
      { id: "card_1", label: "Personal" },
      { id: "card_2", label: "Work" },
    ]);
    const api = makeMockApi({ listPaymentCards } as unknown as ApiClient);
    const args = operatePayTool.inputSchema.parse(PAYMENT_DETAILS);

    await expect(operatePayTool.handler(args, api)).rejects.toThrow(
      /Multiple saved payment cards on file.*"Personal".*"Work".*specify card_ref or card_label/,
    );
  });

  it("no selector + exactly 1 card on file uses that card (has-card, not JIT)", async () => {
    mockBrowser = stubBrowser();
    const listPaymentCards = vi.fn().mockResolvedValue([{ id: "card_only", label: "Personal" }]);
    // The approval expires immediately, so the operator terminates without
    // side effects; we only assert what card_ref the handler resolved.
    const createPaymentApproval = vi.fn().mockResolvedValue({
      id: "appr_1",
      nonce: "n",
      agent: "a",
      expires_at: new Date(0).toISOString(),
    });
    const getPaymentConfig = vi.fn().mockResolvedValue({ vouchflow_audience: "cust" });
    const getPaymentApproval = vi
      .fn()
      .mockResolvedValue({ id: "appr_1", status: "expired", card_ref: "card_only" });
    const api = makeMockApi({
      listPaymentCards,
      createPaymentApproval,
      getPaymentConfig,
      getPaymentApproval,
    } as unknown as ApiClient);
    const args = operatePayTool.inputSchema.parse({
      ...PAYMENT_DETAILS,
      merchant: "M",
      amount_cents: 100,
      currency: "USD",
    });

    const result = (await operatePayTool.handler(args, api)) as Record<string, unknown>;
    expect(createPaymentApproval).toHaveBeenCalledOnce();
    // The single card on file was resolved and sent as card_ref (has-card).
    expect(createPaymentApproval.mock.calls[0]![0]).toMatchObject({ card_ref: "card_only" });
    // Has-card timeout is the plain shape — no card_required, no JIT hint.
    expect(result).toMatchObject({ status: "payment_approval_timeout" });
    expect(result).not.toHaveProperty("card_persisted");
  });

  it("no selector + 0 cards mints a CARD-LESS approval (JIT ceremony)", async () => {
    mockBrowser = stubBrowser();
    const listPaymentCards = vi.fn().mockResolvedValue([]);
    const createPaymentApproval = vi.fn().mockResolvedValue({
      id: "appr_jit",
      nonce: "n",
      agent: "a",
      expires_at: new Date(0).toISOString(),
    });
    const getPaymentConfig = vi.fn().mockResolvedValue({ vouchflow_audience: "cust" });
    const getPaymentApproval = vi
      .fn()
      .mockResolvedValue({ id: "appr_jit", status: "expired", card_ref: null });
    const api = makeMockApi({
      listPaymentCards,
      createPaymentApproval,
      getPaymentConfig,
      getPaymentApproval,
    } as unknown as ApiClient);
    const args = operatePayTool.inputSchema.parse({
      ...PAYMENT_DETAILS,
      merchant: "M",
      amount_cents: 100,
      currency: "USD",
    });

    const result = (await operatePayTool.handler(args, api)) as Record<string, unknown>;
    expect(createPaymentApproval).toHaveBeenCalledOnce();
    // Card-less create — no card_ref sent.
    expect(createPaymentApproval.mock.calls[0]![0]).not.toHaveProperty("card_ref");
    // A card-less approval that expires before a card is bound → card_required.
    expect(result).toMatchObject({
      status: "payment_card_required",
      needs_user: { wall: "card_required" },
    });
  });
});

describe("operate_pay split checkout phases", () => {
  const PENDING: PendingCardFill = {
    approval_id: "appr_split",
    approval_url: "https://web.test/vault/pay/appr_split",
    checkout: {
      merchant: "M",
      checkout_origin: "https://m.test",
      amount_cents: 100,
      currency: "USD",
    },
    card_ref: "card_split",
    last4: "4242",
    mandate_id: "mandate_split",
    item: "Synthetic item",
    reason: "Synthetic purchase reason",
  };

  it("accepts the two phase values and rejects unknown ones", () => {
    expect(() =>
      operatePayTool.inputSchema.parse({ ...PAYMENT_DETAILS, phase: "fill_card" }),
    ).not.toThrow();
    expect(() =>
      operatePayTool.inputSchema.parse({ ...PAYMENT_DETAILS, phase: "confirm" }),
    ).not.toThrow();
    expect(() =>
      operatePayTool.inputSchema.parse({ ...PAYMENT_DETAILS, phase: "charge" }),
    ).toThrow();
  });

  it("refuses confirm when no card fill is pending", async () => {
    const api = makeMockApi();
    const args = operatePayTool.inputSchema.parse({ ...PAYMENT_DETAILS, phase: "confirm" });

    await expect(operatePayTool.handler(args, api)).rejects.toThrow(
      /phase="confirm" requires a completed phase="fill_card"/,
    );
  });

  it("confirm verifies the live total, charges, clears pending, and skips the PayPal gate", async () => {
    mockPending = { ...PENDING };
    // An incidental PayPal button iframe on the review page must not block the
    // confirm of an already-filled card.
    vi.mocked(mockBrowser.isPayPalHostedCheckout).mockResolvedValue(true);
    const auditPayment = vi.fn().mockResolvedValue({ id: "audit_1" });
    const api = makeMockApi({ auditPayment } as unknown as ApiClient);
    const args = operatePayTool.inputSchema.parse({ ...PAYMENT_DETAILS, phase: "confirm" });

    const result = (await operatePayTool.handler(args, api)) as Record<string, unknown>;
    expect(result).toMatchObject({ status: "payment_submitted", amount_cents: 100 });
    expect(mockBrowser.submitFilledCheckout).toHaveBeenCalledTimes(1);
    expect(mockBrowser.isPayPalHostedCheckout).not.toHaveBeenCalled();
    expect(auditPayment).toHaveBeenCalledWith(
      expect.objectContaining({ last4: "4242", status: "payment_submitted" }),
    );
    expect(mockPending).toBeNull();
  });

  it("confirm keeps the pending fill on an amount mismatch (no charge)", async () => {
    mockPending = { ...PENDING };
    vi.mocked(mockBrowser.readCheckoutConfirmSummary).mockResolvedValue({
      merchant: "M",
      checkout_origin: "https://m.test",
      amount_cents: 999,
      currency: "EUR",
    });
    const api = makeMockApi();
    const args = operatePayTool.inputSchema.parse({ ...PAYMENT_DETAILS, phase: "confirm" });

    const result = (await operatePayTool.handler(args, api)) as Record<string, unknown>;
    expect(result).toMatchObject({
      status: "payment_amount_mismatch",
      mandate_amount_cents: 100,
      live_amount_cents: 999,
    });
    expect(mockBrowser.submitFilledCheckout).not.toHaveBeenCalled();
    expect(mockPending).not.toBeNull();
  });

  it("atomically reserves a pending fill across overlapping confirms", async () => {
    mockPending = { ...PENDING };
    let releaseSubmit!: (value: { three_ds_required: false }) => void;
    vi.mocked(mockBrowser.submitFilledCheckout).mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseSubmit = resolve;
        }),
    );
    const api = makeMockApi({ auditPayment: vi.fn().mockResolvedValue({ id: "audit_1" }) });
    const args = operatePayTool.inputSchema.parse({ ...PAYMENT_DETAILS, phase: "confirm" });

    const first = operatePayTool.handler(args, api);
    await vi.waitFor(() => expect(mockBrowser.submitFilledCheckout).toHaveBeenCalledTimes(1));
    await expect(operatePayTool.handler(args, api)).rejects.toThrow(
      /another payment confirmation is already in progress/,
    );
    releaseSubmit({ three_ds_required: false });
    await expect(first).resolves.toMatchObject({ status: "payment_submitted" });
    expect(mockBrowser.submitFilledCheckout).toHaveBeenCalledTimes(1);
  });

  it("rejects every non-confirm payment while a card fill is pending", async () => {
    mockPending = { ...PENDING };
    const api = makeMockApi({ listPaymentCards: vi.fn() } as unknown as ApiClient);

    for (const phase of [undefined, "fill_card" as const]) {
      const args = operatePayTool.inputSchema.parse({ ...PAYMENT_DETAILS, phase });
      await expect(operatePayTool.handler(args, api)).rejects.toThrow(
        /a vaulted card fill is pending; phase="confirm" is required next/,
      );
    }
    expect(mockBrowser.isPayPalHostedCheckout).not.toHaveBeenCalled();
    expect(api.listPaymentCards).not.toHaveBeenCalled();
    expect(mockPending).toEqual(PENDING);
  });

  it("leases fill_card before its first await and releases refusals", async () => {
    let releasePayPal!: (value: boolean) => void;
    vi.mocked(mockBrowser.isPayPalHostedCheckout).mockImplementation(
      () =>
        new Promise((resolve) => {
          releasePayPal = resolve;
        }),
    );
    const api = makeMockApi();
    const fillArgs = operatePayTool.inputSchema.parse({
      ...PAYMENT_DETAILS,
      phase: "fill_card",
    });
    const fill = operatePayTool.handler(fillArgs, api);
    await vi.waitFor(() => expect(mockBrowser.isPayPalHostedCheckout).toHaveBeenCalledOnce());

    expect(mockPaymentLease).toEqual({ phase: "fill_card" });
    expect(mockPaymentSealActive).toBe(true);
    await expect(
      operatePayTool.handler(operatePayTool.inputSchema.parse(PAYMENT_DETAILS), api),
    ).rejects.toThrow(/another payment operation is already in progress/);

    releasePayPal(true);
    await expect(fill).resolves.toMatchObject({ status: "paypal_checkout" });
    expect(mockPaymentLease).toBeNull();
    expect(mockPaymentSealActive).toBe(false);
  });

  it("rejects every other payment while confirm is in flight", async () => {
    mockPending = { ...PENDING };
    let releaseRead!: (value: CheckoutSummary) => void;
    vi.mocked(mockBrowser.readCheckoutConfirmSummary).mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseRead = resolve;
        }),
    );
    const api = makeMockApi({ auditPayment: vi.fn().mockResolvedValue({ id: "audit_1" }) });
    const confirmArgs = operatePayTool.inputSchema.parse({ ...PAYMENT_DETAILS, phase: "confirm" });
    const first = operatePayTool.handler(confirmArgs, api);
    await vi.waitFor(() => expect(mockBrowser.readCheckoutConfirmSummary).toHaveBeenCalledOnce());

    for (const phase of [undefined, "fill_card" as const, "confirm" as const]) {
      const args = operatePayTool.inputSchema.parse({ ...PAYMENT_DETAILS, phase });
      await expect(operatePayTool.handler(args, api)).rejects.toThrow(
        /another payment confirmation is already in progress/,
      );
    }
    releaseRead({
      merchant: "M",
      checkout_origin: "https://m.test",
      amount_cents: 100,
      currency: "USD",
    });
    await expect(first).resolves.toMatchObject({ status: "payment_submitted" });
    expect(mockBrowser.submitFilledCheckout).toHaveBeenCalledTimes(1);
  });

  it("restores the pending fill when confirm throws before submission", async () => {
    mockPending = { ...PENDING };
    vi.mocked(mockBrowser.readCheckoutConfirmSummary).mockRejectedValue(
      new Error("Execution context was destroyed"),
    );
    const api = makeMockApi();
    const args = operatePayTool.inputSchema.parse({ ...PAYMENT_DETAILS, phase: "confirm" });

    await expect(operatePayTool.handler(args, api)).rejects.toThrow(
      /Execution context was destroyed/,
    );
    expect(mockPending).toEqual(PENDING);
    expect(mockPendingConfirming).toBe(false);
    expect(mockBrowser.submitFilledCheckout).not.toHaveBeenCalled();
  });

  it("does not restore the pending fill when confirm throws after submission starts", async () => {
    mockPending = { ...PENDING };
    vi.mocked(mockBrowser.submitFilledCheckout).mockResolvedValue({ three_ds_required: true });
    vi.mocked(mockBrowser.waitForThreeDsResolution).mockRejectedValue(
      new Error("Execution context was destroyed"),
    );
    const api = makeMockApi({ notifyThreeDs: vi.fn().mockResolvedValue({ sent: true }) });
    const args = operatePayTool.inputSchema.parse({ ...PAYMENT_DETAILS, phase: "confirm" });

    await expect(operatePayTool.handler(args, api)).rejects.toThrow(
      /Execution context was destroyed/,
    );
    expect(mockPending).toBeNull();
    expect(mockPendingConfirming).toBe(true);
    await expect(
      operatePayTool.handler(operatePayTool.inputSchema.parse(PAYMENT_DETAILS), api),
    ).rejects.toThrow(/another payment confirmation is already in progress/);
  });

  it("confirm clears pending after an ambiguous submit outcome", async () => {
    mockPending = { ...PENDING };
    vi.mocked(mockBrowser.submitFilledCheckout).mockRejectedValue(
      new Error("click failed after dispatch"),
    );
    const api = makeMockApi({ auditPayment: vi.fn().mockResolvedValue({ id: "audit_1" }) });
    const args = operatePayTool.inputSchema.parse({ ...PAYMENT_DETAILS, phase: "confirm" });

    const result = (await operatePayTool.handler(args, api)) as Record<string, unknown>;
    expect(result).toMatchObject({ status: "payment_outcome_unknown" });
    expect(mockBrowser.clearSealedPaymentFields).toHaveBeenCalledTimes(1);
    expect(mockPending).toBeNull();
    expect(mockPaymentSealActive).toBe(false);
  });

  it("confirm retains the seal lock when terminal cleanup cannot clear the fields", async () => {
    mockPending = { ...PENDING };
    mockPaymentSealActive = true;
    vi.mocked(mockBrowser.submitFilledCheckout).mockRejectedValue(
      new Error("click failed after dispatch"),
    );
    vi.mocked(mockBrowser.clearSealedPaymentFields).mockRejectedValue(
      new Error("controlled field restored"),
    );
    const api = makeMockApi({ auditPayment: vi.fn().mockResolvedValue({ id: "audit_1" }) });
    const args = operatePayTool.inputSchema.parse({ ...PAYMENT_DETAILS, phase: "confirm" });

    const result = (await operatePayTool.handler(args, api)) as Record<string, unknown>;
    expect(result).toMatchObject({
      status: "payment_outcome_unknown",
      payment_fields_cleared: false,
    });
    expect(mockPending).toBeNull();
    expect(mockPaymentSealActive).toBe(true);
  });
});

describe("revoke_app_access", () => {
  it("revokes a grant by id via the egress DELETE route", async () => {
    const revokeEgressGrant = vi.fn().mockResolvedValue({ revoked: true, grant_id: "g_abc" });
    const api = makeMockApi({ revokeEgressGrant } as unknown as ApiClient);
    const parsed = revokeAppAccessTool.inputSchema.parse({ grant_id: "g_abc" });
    const res = (await revokeAppAccessTool.handler(parsed, api)) as { revoked: boolean };
    expect(res.revoked).toBe(true);
    expect(revokeEgressGrant).toHaveBeenCalledWith("g_abc");
  });

  it("requires grant_id", () => {
    expect(() => revokeAppAccessTool.inputSchema.parse({})).toThrow();
  });

  it("requires an active session", async () => {
    await expect(revokeAppAccessTool.handler({ grant_id: "g" }, null)).rejects.toThrow(
      /Trusty Squire session/,
    );
  });

  it("is marked destructive", () => {
    expect(revokeAppAccessTool.annotations?.destructiveHint).toBe(true);
  });
});

describe("list_app_access", () => {
  it("lists this account's egress grants", async () => {
    const listEgressGrants = vi.fn().mockResolvedValue({
      grants: [{ grant_id: "g1", credential_ref: "vault://a/c", revoked_at: null }],
    });
    const api = makeMockApi({ listEgressGrants } as unknown as ApiClient);
    const parsed = listAppAccessTool.inputSchema.parse({});
    const res = (await listAppAccessTool.handler(parsed, api)) as { grants: unknown[] };
    expect(res.grants).toHaveLength(1);
    expect(listEgressGrants).toHaveBeenCalledOnce();
  });
});

describe("audit_log", () => {
  it("reads the account audit ledger with optional filters", async () => {
    const listAudit = vi.fn().mockResolvedValue({
      events: [{ id: "e1", type: "proxy_executed", emitted_at: "now" }],
      next_before: null,
    });
    const api = makeMockApi({ listAudit } as unknown as ApiClient);
    const parsed = auditLogTool.inputSchema.parse({ limit: 10, type: "proxy_executed" });
    const res = (await auditLogTool.handler(parsed, api)) as { events: unknown[] };
    expect(res.events).toHaveLength(1);
    expect(listAudit).toHaveBeenCalledWith({ limit: 10, type: "proxy_executed" });
  });

  it("rejects an out-of-range limit", () => {
    expect(() => auditLogTool.inputSchema.parse({ limit: 9999 })).toThrow();
  });

  it("requires an active session", async () => {
    await expect(auditLogTool.handler({}, null)).rejects.toThrow(/Trusty Squire session/);
  });

  it("is read-only", () => {
    expect(auditLogTool.annotations?.readOnlyHint).toBe(true);
  });
});

describe("TOOLS registry", () => {
  it("exposes the post-0.8 public surface incl. the credential lifecycle tools", () => {
    // 3 credential read/diagnostic tools + 2 credential write tools (store/use —
    // write-only sink; rotation = re-store, delete is web-only) + grant_app_access
    // (egress grants: a deployed app uses a vaulted credential via the proxy).
    // The read-back get_credential tool was removed: in the sink model an
    // agent never sees a raw secret value.
    // 6 base tools + the 14 operator-surface tools (operate_start/observe/act/pay/
    // captcha_gate/await_verification/extract/remember/use/finish_task/finish —
    // remember+use are the operator-recipe capture/replay pair — plus the PR3c
    // login-credential tools: prepare/store plus seal_vault_credential for signin fill.
    expect(TOOLS).toHaveLength(24);
    expect(TOOLS.map((t) => t.name).sort()).toEqual([
      "audit_log",
      "get_extract_failure",
      "grant_app_access",
      "list_app_access",
      "list_credentials",
      "list_extract_failures",
      "list_payment_cards",
      "operate_act",
      "operate_await_verification",
      "operate_captcha_gate",
      "operate_extract",
      "operate_finish",
      "operate_finish_task",
      "operate_observe",
      "operate_pay",
      "operate_prepare_login",
      "operate_remember",
      "operate_seal_vault_credential",
      "operate_start",
      "operate_store_login",
      "operate_use",
      "revoke_app_access",
      "store_credential",
      "use_credential",
    ]);
  });

  it("does not expose the legacy async provision pair", () => {
    const names = TOOLS.map((t) => t.name);
    expect(names).not.toContain("provision");
    expect(names).not.toContain("check_provision_status");
  });

  it("every tool has a non-trivial description (helps the coding agent decide when to call)", () => {
    for (const t of TOOLS) {
      // >40 chars catches empty/one-word descriptions while allowing the
      // intentionally-terse credential tools (delete_credential,
      // poll_credential_access) whose verbatim copy is short by design.
      expect(t.description.length).toBeGreaterThan(40);
    }
  });

  it("documents compact observation reconstruction on every operator entry point", () => {
    for (const name of ["operate_start", "operate_observe", "operate_act"]) {
      const description = TOOLS.find((tool) => tool.name === name)?.description ?? "";
      expect(description).toContain("stable refs");
      expect(description).toContain("delta:true");
      expect(description).toContain("unchanged");
      expect(description).toContain("removed");
      expect(description).toContain("text_unchanged:true");
      expect(description).toContain("snapshot_file");
      expect(description).toContain("nothing changed, not an empty page");
      expect(description).toContain("delta:false as a full resync");
      expect(description).toContain("discard the prior element map");
      expect(description).toContain("Only when delta:true");
    }
  });
});

describe("ApiCallError surface", () => {
  it("preserves status + code so the agent can decide how to handle", () => {
    const err = new ApiCallError(403, "wrong_account", "denied");
    expect(err.status).toBe(403);
    expect(err.code).toBe("wrong_account");
  });
});
