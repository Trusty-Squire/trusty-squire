// Tests for the surviving MCP tools.
//
// The native-provision cluster (provision/cancel/get_usage/list_services/
// list_subscriptions/rotate_credential/wait_for_approval) was sunset in
// 0.8 along with the runtime + mandate-validator packages. What's left:
// the interactive provisioning driver, vault tools, and extract-failure
// diagnostic pair.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import canonicalize from "canonicalize";
import { ApiCallError, type ApiClient } from "../api-client.js";
import type { CheckoutSummary } from "../bot/browser.js";
import type {
  CartCheckoutObservation,
  PaymentBrowser,
  PendingApprovalWait,
  PendingCardFill,
} from "../bot/pay-operator.js";
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
let mockPaymentAuthenticatedPendingOrder = false;
const mockRecordActivePaymentProvenance = vi.hoisted(() => vi.fn());
// [P0] The awaiting-approval rest state — mirrors provision-session.ts's real
// state machine so operate_pay's approval_pending path, and
// operate_payment_status/await, can be exercised against this fake session.
let mockAwaitingApproval: PendingApprovalWait | null = null;
let mockCartCheckout: CartCheckoutObservation | null = null;
const PAYMENT_SESSION_A_ID = "00000000-0000-4000-8000-000000000001";
const PAYMENT_SESSION_B_ID = "00000000-0000-4000-8000-000000000002";

interface MockPaymentSessionState {
  browser: PaymentBrowser;
  pending: PendingCardFill | null;
  pendingConfirming: boolean;
  submitStarted: boolean;
  paymentLease: { phase: "fill_card" | "single" } | null;
  paymentSealed: boolean;
  paymentSealActive: boolean;
  paymentAuthenticatedPendingOrder: boolean;
  awaitingApproval: PendingApprovalWait | null;
  cartCheckout: CartCheckoutObservation | null;
}

const primaryPaymentState: MockPaymentSessionState = {
  get browser() {
    return mockBrowser;
  },
  set browser(value) {
    mockBrowser = value;
  },
  get pending() {
    return mockPending;
  },
  set pending(value) {
    mockPending = value;
  },
  get pendingConfirming() {
    return mockPendingConfirming;
  },
  set pendingConfirming(value) {
    mockPendingConfirming = value;
  },
  get submitStarted() {
    return mockSubmitStarted;
  },
  set submitStarted(value) {
    mockSubmitStarted = value;
  },
  get paymentLease() {
    return mockPaymentLease;
  },
  set paymentLease(value) {
    mockPaymentLease = value;
  },
  get paymentSealed() {
    return mockPaymentSealed;
  },
  set paymentSealed(value) {
    mockPaymentSealed = value;
  },
  get paymentSealActive() {
    return mockPaymentSealActive;
  },
  set paymentSealActive(value) {
    mockPaymentSealActive = value;
  },
  get paymentAuthenticatedPendingOrder() {
    return mockPaymentAuthenticatedPendingOrder;
  },
  set paymentAuthenticatedPendingOrder(value) {
    mockPaymentAuthenticatedPendingOrder = value;
  },
  get awaitingApproval() {
    return mockAwaitingApproval;
  },
  set awaitingApproval(value) {
    mockAwaitingApproval = value;
  },
  get cartCheckout() {
    return mockCartCheckout;
  },
  set cartCheckout(value) {
    mockCartCheckout = value;
  },
};

const mockPaymentSessions = new Map<
  string,
  { session: ProvisionSession.Session; state: MockPaymentSessionState }
>();

function createPaymentSessionState(
  overrides: Partial<MockPaymentSessionState> = {},
): MockPaymentSessionState {
  return {
    browser: stubBrowser(),
    pending: null,
    pendingConfirming: false,
    submitStarted: false,
    paymentLease: null,
    paymentSealed: false,
    paymentSealActive: false,
    paymentAuthenticatedPendingOrder: false,
    awaitingApproval: null,
    cartCheckout: null,
    ...overrides,
  };
}

function addPaymentSession(
  id: string,
  state: MockPaymentSessionState = createPaymentSessionState(),
): MockPaymentSessionState {
  mockPaymentSessions.set(id, {
    session: { id } as ProvisionSession.Session,
    state,
  });
  return state;
}

function paymentSessionState(session?: ProvisionSession.Session): MockPaymentSessionState {
  const id = session?.id ?? PAYMENT_SESSION_A_ID;
  const entry = mockPaymentSessions.get(id);
  if (entry === undefined) throw new Error(`unknown provision session ${id}`);
  return entry.state;
}

vi.mock("../bot/provision-session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ProvisionSession>();
  return {
    ...actual,
    withPaymentSessionCall: async (
      sessionId: string | undefined,
      fn: (session: ProvisionSession.Session) => Promise<unknown>,
    ) => {
      const entry =
        sessionId === undefined
          ? mockPaymentSessions.size === 1
            ? mockPaymentSessions.values().next().value
            : undefined
          : mockPaymentSessions.get(sessionId);
      if (entry === undefined) {
        throw new Error(
          sessionId === undefined
            ? "operate_pay requires session_id when multiple operator sessions are active"
            : `unknown provision session ${sessionId}`,
        );
      }
      return await fn(entry.session);
    },
    activeProvisionBrowserForPayment: async (session?: ProvisionSession.Session) =>
      paymentSessionState(session).browser,
    activeCartCheckoutForOrigin: (_origin: string, session?: ProvisionSession.Session) =>
      paymentSessionState(session).cartCheckout,
    claimActivePaymentForOperatePay: (
      phase: "fill_card" | "confirm" | undefined,
      session?: ProvisionSession.Session,
    ) => {
      const state = paymentSessionState(session);
      if (state.paymentLease !== null) {
        throw new Error("operate_pay refused: another payment operation is already in progress");
      }
      if (state.pendingConfirming) {
        throw new Error("operate_pay refused: another payment confirmation is already in progress");
      }
      if (state.paymentSealed) {
        throw new Error("operate_pay refused: payment field cleanup remains unverified");
      }
      if (state.paymentAuthenticatedPendingOrder) {
        throw new Error(
          "operate_pay refused: the prior authenticated payment still needs a manual order check",
        );
      }
      if (state.pending !== null) {
        if (phase !== "confirm") {
          throw new Error(
            'operate_pay refused: a vaulted card fill is pending; phase="confirm" is required next',
          );
        }
        const pending = state.pending;
        state.pending = null;
        state.pendingConfirming = true;
        state.submitStarted = false;
        return { kind: "confirm", pending };
      }
      if (phase === "confirm") return { kind: "missing_confirm" };
      const resumeApproval = state.awaitingApproval ?? undefined;
      state.awaitingApproval = null;
      const lease = { phase: phase === "fill_card" ? ("fill_card" as const) : ("single" as const) };
      state.paymentLease = lease;
      if (lease.phase === "fill_card") state.paymentSealActive = true;
      return resumeApproval !== undefined
        ? { kind: "lease", lease, resumeApproval }
        : { kind: "lease", lease };
    },
    completeActivePaymentLeaseWithPendingFill: (
      lease: { phase: "fill_card" | "single" },
      pending: PendingCardFill,
      session?: ProvisionSession.Session,
    ) => {
      const state = paymentSessionState(session);
      if (state.paymentLease !== lease || lease.phase !== "fill_card") {
        throw new Error(
          "operate_pay fill_card completed without ownership of the active payment lease",
        );
      }
      state.paymentLease = null;
      state.pending = pending;
      state.paymentSealActive = true;
    },
    completeActivePaymentLeaseWithPendingApproval: (
      lease: { phase: "fill_card" | "single" },
      approval: PendingApprovalWait,
      session?: ProvisionSession.Session,
    ) => {
      const state = paymentSessionState(session);
      if (state.paymentLease !== lease) {
        throw new Error(
          "operate_pay approval_pending completed without ownership of the active payment lease",
        );
      }
      state.paymentLease = null;
      state.awaitingApproval = approval;
    },
    completeActivePaymentLeaseWithUnconfirmedOutcome: (
      lease: { phase: "fill_card" | "single" },
      paymentFieldsCleared = true,
      session?: ProvisionSession.Session,
    ) => {
      const state = paymentSessionState(session);
      if (state.paymentLease !== lease) {
        throw new Error("operate_pay lost ownership of the active payment lease");
      }
      state.paymentLease = null;
      state.paymentAuthenticatedPendingOrder = paymentFieldsCleared;
      state.paymentSealed = !paymentFieldsCleared;
      state.paymentSealActive = !paymentFieldsCleared;
    },
    getActivePendingApproval: (session?: ProvisionSession.Session) =>
      paymentSessionState(session).awaitingApproval,
    recordActivePaymentProvenance: mockRecordActivePaymentProvenance,
    releaseActivePaymentLease: (
      lease: { phase: "fill_card" | "single" },
      paymentFieldsCleared = true,
      session?: ProvisionSession.Session,
    ) => {
      const state = paymentSessionState(session);
      if (state.paymentLease !== lease) return false;
      state.paymentLease = null;
      state.paymentSealed = !paymentFieldsCleared;
      if (lease.phase === "fill_card") state.paymentSealActive = !paymentFieldsCleared;
      return true;
    },
    markActivePendingCardFillSubmitStarted: (session?: ProvisionSession.Session) => {
      paymentSessionState(session).submitStarted = true;
    },
    restoreActivePendingCardFillAfterConfirmThrow: (
      pending: PendingCardFill,
      session?: ProvisionSession.Session,
    ) => {
      const state = paymentSessionState(session);
      if (!state.pendingConfirming || state.submitStarted) return false;
      state.pending = pending;
      state.pendingConfirming = false;
      return true;
    },
    setActivePendingCardFill: (pending: PendingCardFill, session?: ProvisionSession.Session) => {
      const state = paymentSessionState(session);
      state.pending = pending;
      state.pendingConfirming = false;
      state.submitStarted = false;
      state.paymentLease = null;
      state.paymentSealed = false;
      state.paymentSealActive = true;
      state.paymentAuthenticatedPendingOrder = false;
    },
    retainActivePaymentFieldSeal: (session?: ProvisionSession.Session) => {
      const state = paymentSessionState(session);
      if (state.paymentLease === null) state.paymentSealed = true;
      state.paymentSealActive = true;
    },
    clearActivePendingCardFill: (
      paymentFieldsCleared = true,
      session?: ProvisionSession.Session,
    ) => {
      const state = paymentSessionState(session);
      state.pending = null;
      state.pendingConfirming = false;
      state.submitStarted = false;
      state.paymentLease = null;
      state.paymentSealed = !paymentFieldsCleared;
      state.paymentSealActive = !paymentFieldsCleared;
      state.paymentAuthenticatedPendingOrder = false;
    },
    completeActivePendingCardFillWithUnconfirmedOutcome: (
      paymentFieldsCleared = true,
      session?: ProvisionSession.Session,
    ) => {
      const state = paymentSessionState(session);
      if (!state.pendingConfirming) {
        throw new Error("operate_pay confirm lost ownership of the active payment state");
      }
      state.pendingConfirming = false;
      state.paymentAuthenticatedPendingOrder = paymentFieldsCleared;
      state.paymentSealed = !paymentFieldsCleared;
      state.paymentSealActive = !paymentFieldsCleared;
    },
  };
});

import {
  auditLogTool,
  listAppAccessTool,
  listCredentialsTool,
  listPaymentCardsTool,
  operatePayTool,
  operatePaymentAwaitTool,
  operatePaymentStatusTool,
  revokeAppAccessTool,
  buildToolRegistry,
  TOOLS,
} from "../tools/index.js";
import {
  operateLoginTool,
  operateRecipeRunTool,
  operateRecipeSaveTool,
  provisionActTool,
  provisionFinishTool,
} from "../tools/provision-drive.js";

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
    fillAndSubmitCheckout: vi
      .fn()
      .mockResolvedValue({ three_ds_required: false, order_confirmed: true }),
    fillCheckoutCardFields: vi.fn().mockResolvedValue(undefined),
    submitFilledCheckout: vi
      .fn()
      .mockResolvedValue({ three_ds_required: false, order_confirmed: true }),
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
  mockPaymentAuthenticatedPendingOrder = false;
  mockRecordActivePaymentProvenance.mockReset();
  mockAwaitingApproval = null;
  mockCartCheckout = null;
  mockPaymentSessions.clear();
  addPaymentSession(PAYMENT_SESSION_A_ID, primaryPaymentState);
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

describe("operate_act manual card refusal", () => {
  it("returns the vaulted-card alternative and its verified-total prerequisite", async () => {
    const args = provisionActTool.inputSchema.parse({
      session_id: "session_1",
      kind: "type",
      target: "Card number",
      text: "5555 5555 5555 4444",
    });
    await expect(provisionActTool.handler(args, null)).resolves.toMatchObject({
      status: "manual_card_entry_refused",
      safe_alternative: "operate_pay",
      missing_prerequisite: "verified_cart_total",
    });
  });
});

// [P0] Non-blocking approval: operate_pay never blocks the RPC on the human's
// phone tap. It makes one live check and, when nobody has responded yet,
// hands back approval_pending and leaves the session in the awaiting_approval
// rest state instead — verified here at the tool-wiring layer (operate-pay.ts),
// distinct from pay-operator.test.ts's executeOperatePay-level coverage.
describe("operate_pay non-blocking approval [P0] — tool wiring", () => {
  it("never consumes checkout_state as a charge input", async () => {
    const createPaymentApproval = vi.fn().mockResolvedValue({
      id: "appr_checkout_hint",
      nonce: "n",
      agent: "a",
      expires_at: new Date(Date.now() + 300_000).toISOString(),
    });
    const api = makeMockApi({
      listPaymentCards: vi.fn().mockResolvedValue([{ id: "card_1", label: "Personal" }]),
      createPaymentApproval,
      getPaymentConfig: vi.fn().mockResolvedValue({ vouchflow_audience: "cust" }),
      getPaymentApproval: vi.fn().mockResolvedValue({
        id: "appr_checkout_hint",
        status: "pending",
        card_ref: "card_1",
        jws: null,
        sealed_card: null,
      }),
    } as unknown as ApiClient);
    const args = operatePayTool.inputSchema.parse({
      ...PAYMENT_DETAILS,
      checkout_state: {
        authority: "informational_only",
        completeness: "best_effort",
        authoritative_for_payment: false,
        payable_total: { amount_cents: 999_999, currency: "USD" },
        shipping: { amount_cents: 999_899, currency: "USD" },
      },
    });

    expect(args).not.toHaveProperty("checkout_state");
    await operatePayTool.handler(args, api);

    expect(mockBrowser.readCheckoutSummary).toHaveBeenCalledOnce();
    expect(createPaymentApproval).toHaveBeenCalledOnce();
    expect(createPaymentApproval.mock.calls[0]![0]).toMatchObject({
      amount_cents: 100,
      currency: "USD",
    });
  });

  it("returns approval_pending (never payment_approval_timeout) when the human hasn't responded, and marks the lease awaiting_approval", async () => {
    mockBrowser = stubBrowser();
    const createPaymentApproval = vi.fn().mockResolvedValue({
      id: "appr_wire",
      nonce: "n",
      agent: "a",
      expires_at: new Date(Date.now() + 300_000).toISOString(),
    });
    const getPaymentConfig = vi.fn().mockResolvedValue({ vouchflow_audience: "cust" });
    const getPaymentApproval = vi.fn().mockResolvedValue({
      id: "appr_wire",
      status: "pending",
      card_ref: "card_1",
      jws: null,
      sealed_card: null,
    });
    const api = makeMockApi({
      listPaymentCards: vi.fn().mockResolvedValue([{ id: "card_1", label: "Personal" }]),
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

    const notifyUser = vi.fn().mockResolvedValue(undefined);
    const result = (await operatePayTool.handler(args, api, { notifyUser })) as Record<
      string,
      unknown
    >;
    expect(result).toMatchObject({
      status: "approval_pending",
      approval_id: "appr_wire",
      next: { tool: "operate_payment_status", wait_seconds: 15 },
    });
    // The RPC completed on a single live check — the old blocking loop that
    // polled until payment_approval_timeout never ran.
    expect(getPaymentApproval).toHaveBeenCalledOnce();
    expect(getPaymentApproval).toHaveBeenCalledWith("appr_wire", "immediate");
    expect(mockAwaitingApproval).not.toBeNull();
    expect(mockPaymentLease).toBeNull();

    // A re-initiation now resumes — never a second POST /v1/pay/approvals.
    await operatePayTool.handler(args, api, { notifyUser });
    expect(createPaymentApproval).toHaveBeenCalledOnce();
    expect(notifyUser).toHaveBeenCalledTimes(2);
    expect(notifyUser).toHaveBeenNthCalledWith(
      1,
      "Approve this payment on your phone: https://trustysquire.ai/vault/pay/appr_wire",
      { approval_url: "https://trustysquire.ai/vault/pay/appr_wire" },
    );
    expect(notifyUser).toHaveBeenNthCalledWith(
      2,
      "Approve this payment on your phone: https://trustysquire.ai/vault/pay/appr_wire",
      { approval_url: "https://trustysquire.ai/vault/pay/appr_wire" },
    );
  });

  it("replaces an expired approval with a new notified approval whose resource exists", async () => {
    const createPaymentApproval = vi
      .fn()
      .mockResolvedValueOnce({
        id: "appr_expired",
        nonce: "old-nonce",
        agent: "a",
        expires_at: new Date(Date.now() + 300_000).toISOString(),
      })
      .mockResolvedValueOnce({
        id: "appr_fresh",
        nonce: "new-nonce",
        agent: "a",
        expires_at: new Date(Date.now() + 300_000).toISOString(),
      });
    let expiredApprovalReads = 0;
    const getPaymentApproval = vi.fn(async (id: string) => {
      if (id === "appr_expired") expiredApprovalReads++;
      return {
        id,
        status: id === "appr_expired" && expiredApprovalReads > 1 ? "expired" : "pending",
        merchant: "M",
        checkout_origin: "https://m.test",
        amount_cents: 100,
        currency: "USD",
        nonce: id === "appr_expired" ? "old-nonce" : "new-nonce",
        card_ref: "card_1",
        operator_pubkey: "public",
        jws: null,
        sealed_card: null,
        expires_at: new Date(Date.now() + 300_000).toISOString(),
      };
    });
    const api = makeMockApi({
      listPaymentCards: vi.fn().mockResolvedValue([{ id: "card_1", label: "Personal" }]),
      createPaymentApproval,
      getPaymentConfig: vi.fn().mockResolvedValue({ vouchflow_audience: "cust" }),
      getPaymentApproval,
    } as unknown as ApiClient);
    const args = operatePayTool.inputSchema.parse(PAYMENT_DETAILS);
    const notifyUser = vi.fn().mockResolvedValue(undefined);

    const first = (await operatePayTool.handler(args, api, { notifyUser })) as Record<
      string,
      unknown
    >;
    const second = (await operatePayTool.handler(args, api, { notifyUser })) as Record<
      string,
      unknown
    >;

    expect(first).toMatchObject({ status: "approval_pending", approval_id: "appr_expired" });
    expect(second).toMatchObject({ status: "approval_pending", approval_id: "appr_fresh" });
    expect(createPaymentApproval).toHaveBeenCalledTimes(2);
    expect(getPaymentApproval).toHaveBeenNthCalledWith(1, "appr_expired", "immediate");
    expect(getPaymentApproval).toHaveBeenNthCalledWith(2, "appr_expired");
    expect(getPaymentApproval).toHaveBeenNthCalledWith(3, "appr_fresh", "immediate");
    expect(notifyUser).toHaveBeenCalledTimes(2);
    expect(notifyUser).toHaveBeenLastCalledWith(
      "Approve this payment on your phone: https://trustysquire.ai/vault/pay/appr_fresh",
      { approval_url: "https://trustysquire.ai/vault/pay/appr_fresh" },
    );
  });

  it("replaces a missing resumed approval and only returns the existing replacement", async () => {
    const expiresAt = new Date(Date.now() + 300_000).toISOString();
    const createPaymentApproval = vi
      .fn()
      .mockResolvedValueOnce({
        id: "appr_deleted",
        nonce: "deleted-nonce",
        agent: "a",
        expires_at: expiresAt,
      })
      .mockResolvedValueOnce({
        id: "appr_replacement",
        nonce: "replacement-nonce",
        agent: "a",
        expires_at: expiresAt,
      });
    const pendingApproval = (id: string) => ({
      id,
      status: "pending" as const,
      merchant: "M",
      checkout_origin: "https://m.test",
      amount_cents: 100,
      currency: "USD",
      nonce: id === "appr_deleted" ? "deleted-nonce" : "replacement-nonce",
      card_ref: "card_1",
      operator_pubkey: "public",
      jws: null,
      sealed_card: null,
      expires_at: expiresAt,
    });
    const getPaymentApproval = vi
      .fn()
      .mockResolvedValueOnce(pendingApproval("appr_deleted"))
      .mockRejectedValueOnce(
        new ApiCallError(
          404,
          "payment_approval_not_found",
          "GET /v1/pay/approvals/appr_deleted → 404 payment_approval_not_found",
        ),
      )
      .mockResolvedValueOnce(pendingApproval("appr_replacement"));
    const api = makeMockApi({
      listPaymentCards: vi.fn().mockResolvedValue([{ id: "card_1", label: "Personal" }]),
      createPaymentApproval,
      getPaymentConfig: vi.fn().mockResolvedValue({ vouchflow_audience: "cust" }),
      getPaymentApproval,
    } as unknown as ApiClient);
    const args = operatePayTool.inputSchema.parse(PAYMENT_DETAILS);
    const notifyUser = vi.fn().mockResolvedValue(undefined);

    await operatePayTool.handler(args, api, { notifyUser });
    const deletedState = mockAwaitingApproval;
    const replacement = (await operatePayTool.handler(args, api, { notifyUser })) as Record<
      string,
      unknown
    >;

    expect(replacement).toMatchObject({
      status: "approval_pending",
      approval_id: "appr_replacement",
    });
    expect(createPaymentApproval).toHaveBeenCalledTimes(2);
    expect(getPaymentApproval).toHaveBeenNthCalledWith(2, "appr_deleted");
    expect(getPaymentApproval).toHaveBeenNthCalledWith(3, "appr_replacement", "immediate");
    expect(deletedState?.keypair.privateKey).toBe("");
    expect(notifyUser).toHaveBeenLastCalledWith(
      "Approve this payment on your phone: https://trustysquire.ai/vault/pay/appr_replacement",
      { approval_url: "https://trustysquire.ai/vault/pay/appr_replacement" },
    );
  });

  it("restores a resumable approval when notification fails after creation", async () => {
    const createPaymentApproval = vi.fn().mockResolvedValue({
      id: "appr_restore",
      nonce: "n",
      agent: "a",
      expires_at: new Date(Date.now() + 600_000).toISOString(),
    });
    const api = makeMockApi({
      listPaymentCards: vi.fn().mockResolvedValue([{ id: "card_1", label: "Personal" }]),
      createPaymentApproval,
      getPaymentConfig: vi.fn().mockResolvedValue({ vouchflow_audience: "cust" }),
      getPaymentApproval: vi.fn().mockResolvedValue({
        id: "appr_restore",
        status: "pending",
        card_ref: "card_1",
        jws: null,
        sealed_card: null,
      }),
    } as unknown as ApiClient);
    const args = operatePayTool.inputSchema.parse(PAYMENT_DETAILS);

    await expect(
      operatePayTool.handler(args, api, {
        notifyUser: vi.fn().mockRejectedValue(new Error("notification unavailable")),
      }),
    ).rejects.toThrow("notification unavailable");
    expect(mockAwaitingApproval).toMatchObject({ approval_id: "appr_restore" });

    await operatePayTool.handler(args, api);
    expect(createPaymentApproval).toHaveBeenCalledOnce();
  });

  it("restores the original approval when failure precedes operator execution", async () => {
    const resumeApproval: PendingApprovalWait = {
      approval_id: "appr_existing",
      approval_url: "https://web.test/pay/appr_existing",
      nonce: "nonce_existing",
      agent: "agent_existing",
      checkout: {
        merchant: "M",
        checkout_origin: "https://m.test",
        amount_cents: 100,
        currency: "USD",
      },
      jit: false,
      boundCardRef: "card_1",
      deadline: Date.now() + 600_000,
      rejectedCandidates: [],
      keypair: { publicKey: "public", privateKey: "private" },
      item: PAYMENT_DETAILS.item,
      reason: PAYMENT_DETAILS.reason,
      cardRef: "card_1",
    };
    mockAwaitingApproval = resumeApproval;
    vi.mocked(mockBrowser.isPayPalHostedCheckout).mockRejectedValue(
      new Error("browser unavailable"),
    );

    await expect(
      operatePayTool.handler(operatePayTool.inputSchema.parse(PAYMENT_DETAILS), makeMockApi()),
    ).rejects.toThrow("browser unavailable");
    expect(mockAwaitingApproval).toBe(resumeApproval);
    expect(mockPaymentLease).toBeNull();
  });

  it("preserves a resumed approval across a normal configuration error", async () => {
    const resumeApproval: PendingApprovalWait = {
      approval_id: "appr_configuration",
      approval_url: "https://web.test/pay/appr_configuration",
      nonce: "nonce_configuration",
      agent: "agent_configuration",
      checkout: {
        merchant: "M",
        checkout_origin: "https://m.test",
        amount_cents: 100,
        currency: "USD",
      },
      jit: false,
      boundCardRef: "card_1",
      deadline: Date.now() + 600_000,
      rejectedCandidates: [],
      keypair: { publicKey: "public", privateKey: "private" },
      item: PAYMENT_DETAILS.item,
      reason: PAYMENT_DETAILS.reason,
      cardRef: "card_1",
    };
    mockAwaitingApproval = resumeApproval;
    const api = makeMockApi({
      listPaymentCards: vi.fn().mockResolvedValue([{ id: "card_1", label: "Personal" }]),
      getPaymentConfig: vi.fn().mockResolvedValue({ vouchflow_audience: "" }),
    } as unknown as ApiClient);

    await expect(
      operatePayTool.handler(operatePayTool.inputSchema.parse(PAYMENT_DETAILS), api),
    ).resolves.toMatchObject({
      status: "payment_configuration_error",
      reason: "vouchflow_expected_audience_unset",
    });
    expect(mockAwaitingApproval).toBe(resumeApproval);
    expect(resumeApproval.keypair.privateKey).toBe("private");
    expect(mockPaymentLease).toBeNull();
  });

  it("replaces a terminal resumed approval instead of requeueing it", async () => {
    const resumeApproval: PendingApprovalWait = {
      approval_id: "appr_terminal",
      approval_url: "https://web.test/pay/appr_terminal",
      nonce: "nonce_terminal",
      agent: "agent_terminal",
      checkout: {
        merchant: "M",
        checkout_origin: "https://m.test",
        amount_cents: 100,
        currency: "USD",
      },
      jit: false,
      boundCardRef: "card_1",
      deadline: Date.now() + 600_000,
      rejectedCandidates: [],
      keypair: { publicKey: "public", privateKey: "private" },
      item: PAYMENT_DETAILS.item,
      reason: PAYMENT_DETAILS.reason,
      cardRef: "card_1",
      three_ds_wait_seconds: 600,
    };
    mockAwaitingApproval = resumeApproval;
    const createPaymentApproval = vi.fn().mockResolvedValue({
      id: "appr_fresh_after_terminal",
      nonce: "fresh-nonce",
      agent: "fresh-agent",
      expires_at: new Date(Date.now() + 600_000).toISOString(),
    });
    const api = makeMockApi({
      listPaymentCards: vi.fn().mockResolvedValue([{ id: "card_1", label: "Personal" }]),
      getPaymentConfig: vi.fn().mockResolvedValue({ vouchflow_audience: "cust" }),
      createPaymentApproval,
      getPaymentApproval: vi.fn(async (id: string) => ({
        id,
        status: id === "appr_terminal" ? "approved" : "pending",
        merchant: "M",
        checkout_origin: "https://m.test",
        amount_cents: 100,
        currency: "USD",
        nonce: "fresh-nonce",
        card_ref: "card_1",
        operator_pubkey: "public",
        jws: null,
        sealed_card: null,
        expires_at: new Date(Date.now() + 600_000).toISOString(),
      })),
    } as unknown as ApiClient);

    await expect(
      operatePayTool.handler(
        operatePayTool.inputSchema.parse({ ...PAYMENT_DETAILS, three_ds_wait_seconds: 0 }),
        api,
      ),
    ).resolves.toMatchObject({
      status: "approval_pending",
      approval_id: "appr_fresh_after_terminal",
    });
    expect(createPaymentApproval).toHaveBeenCalledOnce();
    expect(mockAwaitingApproval).toMatchObject({
      approval_id: "appr_fresh_after_terminal",
      three_ds_wait_seconds: 0,
    });
    expect(resumeApproval.keypair.privateKey).toBe("");
    expect(mockPaymentLease).toBeNull();
  });

  it("returns the persisted cart URL with the safe total-observation action", async () => {
    mockCartCheckout = {
      checkout: {
        merchant: "M",
        checkout_origin: "https://m.test",
        amount_cents: 100,
        currency: "USD",
      },
      url: "https://m.test/cart",
      observedAt: Date.now(),
    };
    vi.mocked(mockBrowser.readCheckoutSummary).mockRejectedValue(
      new Error("payment_checkout_total_not_found"),
    );
    const api = makeMockApi({
      listPaymentCards: vi.fn().mockResolvedValue([{ id: "card_1", label: "Personal" }]),
      getPaymentConfig: vi.fn().mockResolvedValue({ vouchflow_audience: "cust" }),
    } as unknown as ApiClient);

    await expect(
      operatePayTool.handler(operatePayTool.inputSchema.parse(PAYMENT_DETAILS), api),
    ).resolves.toMatchObject({
      status: "needs_cart_total",
      next: { tool: "operate_observe", url: "https://m.test/cart" },
    });
  });
});

describe("operate_payment_status / operate_payment_await [P0]", () => {
  const paymentSessionId = PAYMENT_SESSION_A_ID;
  const operatorPublicKey = Buffer.from("status-operator-public-key").toString("base64url");
  const baseState = {
    approval_id: "appr_status",
    approval_url: "https://web.test/vault/pay/appr_status",
    nonce: "n",
    agent: "a",
    checkout: {
      merchant: "M",
      checkout_origin: "https://m.test",
      amount_cents: 100,
      currency: "USD",
    },
    jit: false,
    boundCardRef: "card_1",
    deadline: Date.now() + 60_000,
    rejectedCandidates: [],
    keypair: { publicKey: operatorPublicKey, privateKey: "priv" },
    item: "Synthetic item",
    reason: "Synthetic purchase reason",
    cardRef: "card_1",
  };

  function candidateJws(kind: "review" | "approval"): string {
    const recipientHash = createHash("sha256")
      .update(Buffer.from(operatorPublicKey, "base64url"))
      .digest("base64url");
    const approvalCanonical = canonicalize({
      approval_id: baseState.approval_id,
      merchant: baseState.checkout.merchant,
      checkout_origin: baseState.checkout.checkout_origin,
      amount_cents: baseState.checkout.amount_cents,
      currency: baseState.checkout.currency,
      nonce: baseState.nonce,
      card_ref: baseState.cardRef,
      recipient_pubkey_hash: recipientHash,
      item: baseState.item,
      reason: baseState.reason,
      agent: baseState.agent,
    })!;
    const approvalHash = createHash("sha256").update(approvalCanonical).digest();
    const reviewCanonical = canonicalize({
      approval_id: baseState.approval_id,
      approval_payload_sha256: approvalHash.toString("base64url"),
      card_ref: baseState.cardRef,
      recipient_pubkey_hash: recipientHash,
    })!;
    const hash =
      kind === "approval" ? approvalHash : createHash("sha256").update(reviewCanonical).digest();
    const payload = Buffer.from(
      JSON.stringify({ context: "purchase", payload_sha256: hash.toString("base64url") }),
    ).toString("base64url");
    return `e30.${payload}.signature`;
  }

  it("reports no_pending_payment when nothing is awaiting approval", async () => {
    const api = makeMockApi();
    await expect(operatePaymentStatusTool.handler({}, api)).resolves.toMatchObject({
      session_id: paymentSessionId,
      status: "no_pending_payment",
    });
    await expect(operatePaymentAwaitTool.handler({}, api)).resolves.toMatchObject({
      session_id: paymentSessionId,
      status: "no_pending_payment",
    });
  });

  it("routes every payment tool to only its addressed session", async () => {
    const stateA: PendingApprovalWait = {
      ...baseState,
      approval_id: "appr_session_a",
      approval_url: "https://web.test/vault/pay/appr_session_a",
      nonce: "nonce_a",
    };
    const stateB: PendingApprovalWait = {
      ...baseState,
      approval_id: "appr_session_b",
      approval_url: "https://web.test/vault/pay/appr_session_b",
      nonce: "nonce_b",
    };
    mockAwaitingApproval = stateA;
    const sessionB = addPaymentSession(
      PAYMENT_SESSION_B_ID,
      createPaymentSessionState({ awaitingApproval: stateB }),
    );
    const approvalRecord = (state: PendingApprovalWait) => ({
      id: state.approval_id,
      status: "pending" as const,
      merchant: state.checkout.merchant,
      checkout_origin: state.checkout.checkout_origin,
      amount_cents: state.checkout.amount_cents,
      currency: state.checkout.currency,
      nonce: state.nonce,
      card_ref: state.cardRef,
      operator_pubkey: state.keypair.publicKey,
      jws: null,
      sealed_card: null,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });

    const getStatusApproval = vi.fn().mockResolvedValue(approvalRecord(stateA));
    await expect(
      operatePaymentStatusTool.handler(
        { session_id: PAYMENT_SESSION_A_ID },
        makeMockApi({ getPaymentApproval: getStatusApproval } as unknown as ApiClient),
      ),
    ).resolves.toMatchObject({
      session_id: PAYMENT_SESSION_A_ID,
      approval_id: "appr_session_a",
    });
    expect(getStatusApproval).toHaveBeenCalledWith("appr_session_a", "peek");

    const getAwaitApproval = vi.fn().mockResolvedValue(approvalRecord(stateB));
    await expect(
      operatePaymentAwaitTool.handler(
        { session_id: PAYMENT_SESSION_B_ID },
        makeMockApi({ getPaymentApproval: getAwaitApproval } as unknown as ApiClient),
      ),
    ).resolves.toMatchObject({
      session_id: PAYMENT_SESSION_B_ID,
      approval_id: "appr_session_b",
    });
    expect(getAwaitApproval).toHaveBeenCalledWith("appr_session_b", "wait-peek");

    const getPayApproval = vi.fn().mockResolvedValue(approvalRecord(stateB));
    const payApi = makeMockApi({
      listPaymentCards: vi.fn().mockResolvedValue([{ id: "card_1", label: "Personal" }]),
      getPaymentApproval: getPayApproval,
      getPaymentConfig: vi.fn().mockResolvedValue({ vouchflow_audience: "cust" }),
    } as unknown as ApiClient);
    await expect(
      operatePayTool.handler(
        operatePayTool.inputSchema.parse({
          ...PAYMENT_DETAILS,
          session_id: PAYMENT_SESSION_B_ID,
        }),
        payApi,
      ),
    ).resolves.toMatchObject({
      session_id: PAYMENT_SESSION_B_ID,
      status: "approval_pending",
      approval_id: "appr_session_b",
    });
    expect(getPayApproval).toHaveBeenCalledWith("appr_session_b");
    expect(getPayApproval).not.toHaveBeenCalledWith("appr_session_a");
    expect(mockAwaitingApproval).toBe(stateA);
    expect(sessionB.awaitingApproval).toMatchObject({ approval_id: "appr_session_b" });
  });

  it("rejects payment-tool session omission when two sessions are active", async () => {
    addPaymentSession(PAYMENT_SESSION_B_ID);
    const api = makeMockApi();

    await expect(
      operatePayTool.handler(operatePayTool.inputSchema.parse(PAYMENT_DETAILS), api),
    ).rejects.toThrow(/requires session_id when multiple operator sessions are active/);
    await expect(operatePaymentStatusTool.handler({}, api)).rejects.toThrow(
      /requires session_id when multiple operator sessions are active/,
    );
    await expect(operatePaymentAwaitTool.handler({}, api)).rejects.toThrow(
      /requires session_id when multiple operator sessions are active/,
    );
  });

  it("rejects waits longer than the 15-second tool contract", () => {
    expect(() => operatePaymentAwaitTool.inputSchema.parse({ max_wait_seconds: 16 })).toThrow();
    expect(operatePaymentAwaitTool.jsonInputSchema).toMatchObject({
      properties: { max_wait_seconds: { maximum: 15 } },
    });
    expect(() => operatePaymentStatusTool.inputSchema.parse({ wait_seconds: 16 })).toThrow();
    expect(() => operatePaymentStatusTool.inputSchema.parse({ wait_seconds: -1 })).toThrow();
    expect(operatePaymentStatusTool.jsonInputSchema).toMatchObject({
      properties: { wait_seconds: { minimum: 0, maximum: 15 } },
    });
  });

  it("operate_payment_await is a delegating alias for operate_payment_status(wait_seconds)", async () => {
    mockAwaitingApproval = baseState;
    const getPaymentApproval = vi.fn().mockResolvedValue({
      id: "appr_status",
      status: "pending",
      merchant: "M",
      amount_cents: 100,
      currency: "USD",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      card_ref: "card_1",
      operator_pubkey: operatorPublicKey,
      jws: null,
      sealed_card: null,
    });
    const api = makeMockApi({ getPaymentApproval } as unknown as ApiClient);

    const viaAlias = await operatePaymentAwaitTool.handler({ max_wait_seconds: 5 }, api);
    const viaCanonical = await operatePaymentStatusTool.handler({ wait_seconds: 5 }, api);
    expect(viaAlias).toEqual(viaCanonical);
    expect(getPaymentApproval).toHaveBeenNthCalledWith(1, "appr_status", "wait-peek");
    expect(getPaymentApproval).toHaveBeenNthCalledWith(2, "appr_status", "wait-peek");

    // Omitting max_wait_seconds on the alias still waits (defaults to 15s),
    // unlike omitting wait_seconds on the canonical tool (defaults to an
    // instant peek, 0s).
    const aliasDefault = await operatePaymentAwaitTool.handler({}, api);
    const statusDefault = await operatePaymentStatusTool.handler({}, api);
    expect(getPaymentApproval).toHaveBeenNthCalledWith(3, "appr_status", "wait-peek");
    expect(getPaymentApproval).toHaveBeenNthCalledWith(4, "appr_status", "peek");
    expect(aliasDefault).toMatchObject({ status: "pending" });
    expect(statusDefault).toMatchObject({ status: "pending" });
  });

  it("status: read-only — never opens the card or confirms a candidate", async () => {
    mockAwaitingApproval = baseState;
    const getPaymentApproval = vi.fn().mockResolvedValue({
      id: "appr_status",
      status: "pending",
      merchant: "M",
      amount_cents: 100,
      currency: "USD",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      card_ref: "card_1",
      operator_pubkey: operatorPublicKey,
      jws: null,
      sealed_card: null,
    });
    const confirmPaymentApproval = vi.fn();
    const api = makeMockApi({ getPaymentApproval, confirmPaymentApproval } as unknown as ApiClient);

    const result = await operatePaymentStatusTool.handler({}, api);
    expect(result).toMatchObject({
      session_id: paymentSessionId,
      status: "pending",
      approval_id: "appr_status",
      candidate_submitted: false,
      next: { tool: "operate_payment_status", session_id: paymentSessionId, wait_seconds: 15 },
    });
    expect(getPaymentApproval).toHaveBeenCalledWith("appr_status", "peek");
    expect(confirmPaymentApproval).not.toHaveBeenCalled();
  });

  it("distinguishes a final candidate as ready to charge", async () => {
    mockAwaitingApproval = baseState;
    const getPaymentApproval = vi.fn().mockResolvedValue({
      id: "appr_status",
      status: "pending",
      merchant: "M",
      amount_cents: 100,
      currency: "USD",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      card_ref: "card_1",
      operator_pubkey: operatorPublicKey,
      jws: candidateJws("approval"),
      sealed_card: "sealed",
    });
    const api = makeMockApi({ getPaymentApproval } as unknown as ApiClient);

    const result = await operatePaymentAwaitTool.handler({}, api);
    expect(result).toMatchObject({
      session_id: paymentSessionId,
      status: "pending",
      candidate_submitted: true,
      candidate_kind: "approval",
      ready_to_charge: true,
      next: { tool: "operate_pay", session_id: paymentSessionId },
    });
    expect(getPaymentApproval).toHaveBeenCalledWith("appr_status", "wait-peek");
  });

  it("distinguishes a review candidate from final charge authorization", async () => {
    mockAwaitingApproval = baseState;
    const getPaymentApproval = vi.fn().mockResolvedValue({
      id: "appr_status",
      status: "pending",
      merchant: "M",
      amount_cents: 100,
      currency: "USD",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      card_ref: "card_1",
      operator_pubkey: operatorPublicKey,
      jws: candidateJws("review"),
      sealed_card: "sealed",
    });
    const api = makeMockApi({ getPaymentApproval } as unknown as ApiClient);

    await expect(operatePaymentAwaitTool.handler({}, api)).resolves.toMatchObject({
      status: "pending",
      candidate_submitted: true,
      candidate_kind: "review",
      ready_to_charge: false,
      next: { tool: "operate_pay" },
    });
    expect(getPaymentApproval).toHaveBeenCalledWith("appr_status", "wait-peek");
  });

  it("keeps the verified-review state explicit while waiting for the final signature", async () => {
    mockAwaitingApproval = { ...baseState, reviewVerified: true };
    const getPaymentApproval = vi.fn().mockResolvedValue({
      id: "appr_status",
      status: "pending",
      merchant: "M",
      amount_cents: 100,
      currency: "USD",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      card_ref: "card_1",
      operator_pubkey: operatorPublicKey,
      jws: null,
      sealed_card: null,
    });
    const api = makeMockApi({ getPaymentApproval } as unknown as ApiClient);

    await expect(operatePaymentStatusTool.handler({}, api)).resolves.toMatchObject({
      status: "pending",
      candidate_submitted: false,
      candidate_kind: "review",
      ready_to_charge: false,
      next: { tool: "operate_payment_status", wait_seconds: 15 },
    });
  });

  it("reports expired without a next action", async () => {
    mockAwaitingApproval = baseState;
    const getPaymentApproval = vi.fn().mockResolvedValue({
      id: "appr_status",
      status: "expired",
      merchant: "M",
      amount_cents: 100,
      currency: "USD",
      expires_at: new Date(Date.now() - 1_000).toISOString(),
      card_ref: "card_1",
      operator_pubkey: operatorPublicKey,
      jws: null,
      sealed_card: null,
    });
    const api = makeMockApi({ getPaymentApproval } as unknown as ApiClient);

    const result = await operatePaymentAwaitTool.handler({ max_wait_seconds: 5 }, api);
    expect(result).toMatchObject({ status: "expired" });
    expect(result).not.toHaveProperty("next");
  });

  it("await never outlasts its own bound even if the server call hangs", async () => {
    mockAwaitingApproval = baseState;
    const getPaymentApproval = vi.fn(() => new Promise<never>(() => undefined));
    const api = makeMockApi({ getPaymentApproval } as unknown as ApiClient);

    const start = Date.now();
    const result = await operatePaymentAwaitTool.handler({ max_wait_seconds: 1 }, api);
    expect(Date.now() - start).toBeLessThan(2_000);
    expect(result).toMatchObject({ status: "pending", candidate_submitted: false });
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
  };

  it("accepts the three phase values and rejects unknown ones", () => {
    expect(() =>
      operatePayTool.inputSchema.parse({ ...PAYMENT_DETAILS, phase: "single" }),
    ).not.toThrow();
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

  it('treats phase:"single" identically to omitting phase', async () => {
    mockBrowser = stubBrowser();
    const createPaymentApproval = vi.fn().mockResolvedValue({
      id: "appr_single",
      nonce: "n",
      agent: "a",
      expires_at: new Date(Date.now() + 300_000).toISOString(),
    });
    const getPaymentConfig = vi.fn().mockResolvedValue({ vouchflow_audience: "cust" });
    const getPaymentApproval = vi.fn().mockResolvedValue({
      id: "appr_single",
      status: "pending",
      card_ref: "card_1",
      jws: null,
      sealed_card: null,
    });
    const makeApi = () =>
      makeMockApi({
        listPaymentCards: vi.fn().mockResolvedValue([{ id: "card_1", label: "Personal" }]),
        createPaymentApproval,
        getPaymentConfig,
        getPaymentApproval,
      } as unknown as ApiClient);

    const omitted = await operatePayTool.handler(
      operatePayTool.inputSchema.parse(PAYMENT_DETAILS),
      makeApi(),
    );
    mockPaymentLease = null;
    mockAwaitingApproval = null;
    const explicit = await operatePayTool.handler(
      operatePayTool.inputSchema.parse({ ...PAYMENT_DETAILS, phase: "single" }),
      makeApi(),
    );
    expect(explicit).toEqual(omitted);
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
    let releaseSubmit!: (value: { three_ds_required: false; order_confirmed: true }) => void;
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
    releaseSubmit({ three_ds_required: false, order_confirmed: true });
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
    vi.mocked(mockBrowser.submitFilledCheckout).mockResolvedValue({
      three_ds_required: true,
      order_confirmed: false,
    });
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

  it("keeps authenticated-but-unconfirmed split payment terminal and blocks another charge", async () => {
    mockPending = { ...PENDING };
    vi.mocked(mockBrowser.submitFilledCheckout).mockResolvedValue({
      three_ds_required: true,
      order_confirmed: false,
      challenge_url: "https://issuer.synthetic.test/challenge",
    });
    vi.mocked(mockBrowser.waitForThreeDsResolution).mockResolvedValue(
      "authenticated_pending_order",
    );
    const api = makeMockApi({
      auditPayment: vi.fn().mockResolvedValue({ id: "audit_1" }),
      notifyThreeDs: vi.fn().mockResolvedValue({ sent: true }),
    });
    const args = operatePayTool.inputSchema.parse({ ...PAYMENT_DETAILS, phase: "confirm" });

    await expect(operatePayTool.handler(args, api)).resolves.toMatchObject({
      status: "payment_3ds_authenticated_pending_order",
    });
    expect(mockPendingConfirming).toBe(false);
    expect(mockPaymentAuthenticatedPendingOrder).toBe(true);
    expect(mockRecordActivePaymentProvenance).toHaveBeenCalledWith(
      "card_split",
      expect.objectContaining({ id: PAYMENT_SESSION_A_ID }),
    );
    await expect(
      operatePayTool.handler(operatePayTool.inputSchema.parse(PAYMENT_DETAILS), api),
    ).rejects.toThrow(/prior authenticated payment still needs a manual order check/);
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
  it("exposes the bare-essentials 17-tool default surface without maintainer diagnostics", () => {
    // Credential read/write tools (write-only sink; rotation = re-store, delete
    // is web-only) + grant_app_access
    // (egress grants: a deployed app uses a vaulted credential via the proxy).
    // The read-back get_credential tool was removed: in the sink model an
    // agent never sees a raw secret value.
    // Bare-essentials cut (captain's decision 2026-08-15): every legacy
    // delegating alias was dropped from the registry. Their behavior remains
    // reachable as operate_act kinds (cart_add/select_many/extract/solve_captcha/
    // await_verification/login_prepare_signup/login_store_signup/login_load_saved)
    // or as operate_finish{outcome} (operate_finish_task) / operate_recipe_run
    // and operate_recipe_save (operate_use/operate_remember).
    // operate_payment_await stays registered — its removal belongs to the
    // in-flight operator-restore-native-3ds payment fix, not this cut.
    expect(TOOLS).toHaveLength(17);
    expect(TOOLS.map((t) => t.name).sort()).toEqual([
      "audit_log",
      "grant_app_access",
      "list_app_access",
      "list_credentials",
      "list_payment_cards",
      "operate_act",
      "operate_finish",
      "operate_observe",
      "operate_pay",
      "operate_payment_await",
      "operate_payment_status",
      "operate_recipe_run",
      "operate_recipe_save",
      "operate_start",
      "revoke_app_access",
      "store_credential",
      "use_credential",
    ]);
  });

  it("adds the two-stage extract diagnostics profile only when explicitly enabled", async () => {
    for (const disabled of [undefined, "", "0", "false", "off"]) {
      const tools = buildToolRegistry(
        disabled === undefined ? {} : { TRUSTY_SQUIRE_DIAGNOSTICS: disabled },
      );
      expect(tools).toHaveLength(17);
      expect(tools.map((tool) => tool.name)).not.toEqual(
        expect.arrayContaining(["list_extract_failures", "get_extract_failure"]),
      );
    }

    const tools = buildToolRegistry({ TRUSTY_SQUIRE_DIAGNOSTICS: "1" });
    expect(tools).toHaveLength(19);
    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["list_extract_failures", "get_extract_failure"]),
    );

    const list = tools.find((tool) => tool.name === "list_extract_failures")!;
    const detail = tools.find((tool) => tool.name === "get_extract_failure")!;
    const listExtractFailures = vi.fn().mockResolvedValue({
      snapshots: [{ id: "extract_1", service: "railway" }],
    });
    const getExtractFailure = vi.fn().mockResolvedValue({
      id: "extract_1",
      html: "<button>Copy token</button>",
      screenshot_jpeg_base64: "jpeg-bytes",
    });
    const api = makeMockApi({ listExtractFailures, getExtractFailure } as unknown as ApiClient);

    const listed = (await list.handler(list.inputSchema.parse({ limit: 5 }), api)) as {
      snapshots: { id: string }[];
    };
    const fetched = (await detail.handler(
      detail.inputSchema.parse({ id: listed.snapshots[0]!.id }),
      api,
    )) as Record<string, unknown>;

    expect(listExtractFailures).toHaveBeenCalledWith(5);
    expect(getExtractFailure).toHaveBeenCalledWith("extract_1");
    expect(fetched).toMatchObject({
      id: "extract_1",
      html: "<button>Copy token</button>",
      screenshot_omitted: true,
    });
    expect(fetched).not.toHaveProperty("screenshot_jpeg_base64");
  });

  it("does not expose the legacy async provision pair", () => {
    const names = TOOLS.map((t) => t.name);
    expect(names).not.toContain("provision");
    expect(names).not.toContain("check_provision_status");
  });

  it("exposes consolidated operate_act kinds and drops their former standalone tool names", () => {
    const properties = provisionActTool.jsonInputSchema.properties as Record<string, unknown>;
    const kinds = (properties.kind as { enum: string[] }).enum;
    expect(kinds).toEqual(
      expect.arrayContaining([
        "cart_add",
        "select_many",
        "extract",
        "solve_captcha",
        "await_verification",
        "login_prepare_signup",
        "login_store_signup",
        "login_load_saved",
      ]),
    );

    const names = TOOLS.map((tool) => tool.name);
    expect(names).not.toEqual(
      expect.arrayContaining([
        "operate_cart_add",
        "operate_form_select_many",
        "operate_extract",
        "operate_captcha_gate",
        "operate_await_verification",
        "operate_login",
        "operate_prepare_login",
        "operate_store_login",
        "operate_seal_vault_credential",
      ]),
    );
  });

  it("operate_login's former action variants map onto the operate_act login_* kinds", () => {
    // operateLoginTool is no longer registered (folded into operate_act), but the
    // object stays defined as the internal handle for this equivalence check.
    const loginVariants = operateLoginTool.jsonInputSchema.oneOf as {
      properties: { action: { const: string } };
    }[];
    expect(loginVariants.map((variant) => variant.properties.action.const)).toEqual([
      "prepare_signup",
      "store_signup",
      "load_saved",
    ]);

    const properties = provisionActTool.jsonInputSchema.properties as Record<string, unknown>;
    const kinds = (properties.kind as { enum: string[] }).enum;
    expect(kinds).toEqual(
      expect.arrayContaining(["login_prepare_signup", "login_store_signup", "login_load_saved"]),
    );
  });

  it("exposes consolidated lifecycle/recipe schemas and drops their former standalone tool names", () => {
    const finishProperties = provisionFinishTool.jsonInputSchema.properties as Record<
      string,
      unknown
    >;
    const finishVariants = (finishProperties.outcome as { oneOf: Record<string, unknown>[] }).oneOf;
    expect(finishVariants).toHaveLength(3);
    expect(finishVariants[1]).toMatchObject({ required: ["kind", "store"] });
    expect(finishVariants[2]).toMatchObject({
      required: ["kind"],
      anyOf: [{ required: ["summary"] }, { required: ["data"] }],
    });

    expect(operateRecipeRunTool.name).toBe("operate_recipe_run");
    expect(operateRecipeSaveTool.name).toBe("operate_recipe_save");
    const names = TOOLS.map((tool) => tool.name);
    expect(names).not.toEqual(
      expect.arrayContaining([
        "operate_prepare_login",
        "operate_store_login",
        "operate_seal_vault_credential",
        "operate_finish_task",
        "operate_use",
        "operate_remember",
      ]),
    );
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
