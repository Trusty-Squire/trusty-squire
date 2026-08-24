// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const api = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
}));
const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
const vouchflow = vi.hoisted(() => ({ signPayload: vi.fn() }));
const vault = vi.hoisted(() => ({ decryptCard: vi.fn() }));
const pairing = vi.hoisted(() => ({
  getPairingState: vi.fn(),
  pairDevice: vi.fn(),
  isPaymentPasskeyUnavailable: vi.fn(() => false),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "appr_1" }),
  useRouter: () => router,
  usePathname: () => "/vault/pay/appr_1",
}));

vi.mock("../../../../lib/api", () => ({
  ApiError: class ApiError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
  apiGet: api.apiGet,
  apiPost: api.apiPost,
}));

// Avoid loading the WebAuthn/vouchflow machinery — the sensitive add flow is
// covered by the shared CardEntry's own path; here we drive its onSaved.
vi.mock("../../../../lib/vouchflow", () => ({
  getVouchflow: () => vouchflow,
}));

vi.mock("../../../../lib/pairing", () => pairing);

vi.mock("@trusty-squire/vault/e2e", () => ({
  decryptCard: vault.decryptCard,
}));

vi.mock("@trusty-squire/vault/hpke", () => ({
  sealToRecipient: vi.fn().mockResolvedValue("sealed-card"),
}));

vi.mock("../../../../components/CardEntry", () => ({
  CardEntry: (props: { onSaved?: (r: { id: string }) => void }) => (
    <button
      type="button"
      data-testid="card-entry"
      onClick={() => props.onSaved?.({ id: "card_new" })}
    >
      add card (stub)
    </button>
  ),
}));

import PaymentApprovalPage from "../page";

// The ceremony response carries the server-bound card needed for authorization.
const BOUND_CARD = {
  id: "card_new",
  label: "Personal",
  brand: "Visa",
  last4: "4242",
  createdAt: "2026-07-01T00:00:00.000Z",
};
const LEGACY_BOUND_CARD = {
  ...BOUND_CARD,
  brand: null,
  last4: null,
};

let bound = false;
let cardListFailures = 0;
let failCardListAfterBind = false;
let bindFailures = 0;
let loseBindResponse = false;
let lostResponseCardRef = "card_new";
let cardListOverride: unknown[] | null = null;
let approvalAmountCents = 6000;
let approvalCurrency = "USD";

function approvalBody() {
  const metadata = cardListOverride?.[0] ?? BOUND_CARD;
  return {
    id: "appr_1",
    status: "pending",
    merchant: "CASETiFY",
    checkout_origin: "https://casetify.com",
    amount_cents: approvalAmountCents,
    currency: approvalCurrency,
    nonce: "nonce",
    card_ref: bound ? lostResponseCardRef : null,
    operator_pubkey: "AAAA",
    expires_at: "2026-07-01T00:10:00.000Z",
    item: "phone case",
    reason: "gift",
    agent: "claude-code",
    card: bound
      ? {
          blob: JSON.stringify({ prf_salt: "AAAA", ciphertext: "encrypted" }),
          brand: (metadata as typeof BOUND_CARD).brand,
          last4: (metadata as typeof BOUND_CARD).last4,
        }
      : null,
  };
}

function ceremonyBody() {
  const current = approvalBody();
  return {
    ...current,
    approval_payload_sha256: "synthetic-approval-payload-hash",
    card: current.card === null ? null : { blob: current.card.blob },
  };
}

beforeEach(() => {
  bound = false;
  cardListFailures = 0;
  failCardListAfterBind = false;
  bindFailures = 0;
  loseBindResponse = false;
  lostResponseCardRef = "card_new";
  cardListOverride = null;
  approvalAmountCents = 6000;
  approvalCurrency = "USD";
  vi.clearAllMocks();
  pairing.getPairingState.mockResolvedValue({ enrolled: true });
  pairing.pairDevice.mockResolvedValue(undefined);
  pairing.isPaymentPasskeyUnavailable.mockReturnValue(false);
  vouchflow.signPayload.mockImplementation(async ({ payload }: { payload: unknown }) => ({
    assertion: "e30.synthetic.signature",
    payload: JSON.stringify(payload),
    prfResult: new Uint8Array(32),
  }));
  vault.decryptCard.mockResolvedValue({ pan: "4242424242424242" });
  api.apiGet.mockImplementation((path: string) => {
    if (path === "/v1/status") return Promise.resolve({ billing_enabled: false });
    if (path === "/v1/vault/e2e") return Promise.resolve(cardListOverride ?? [BOUND_CARD]);
    if (path === "/v1/pay/approvals/appr_1/ceremony") {
      if (cardListFailures > 0) {
        cardListFailures -= 1;
        return Promise.reject(new Error("card unavailable"));
      }
      return Promise.resolve(ceremonyBody());
    }
    return Promise.reject(new Error(`unexpected GET ${path}`));
  });
  api.apiPost.mockImplementation((path: string) => {
    if (path === "/v1/pay/approvals/appr_1/bind-card") {
      if (loseBindResponse) {
        loseBindResponse = false;
        bound = true;
        return Promise.reject(new Error("bind response lost"));
      }
      if (bindFailures > 0) {
        bindFailures -= 1;
        return Promise.reject(new Error("bind unavailable"));
      }
      bound = true;
      if (failCardListAfterBind) cardListFailures += 1;
      return Promise.resolve({ card_ref: "card_new" });
    }
    if (path === "/v1/pay/approvals/appr_1/approve") {
      const { card, ...approval } = approvalBody();
      void card;
      const metadata = cardListOverride?.[0] ?? BOUND_CARD;
      return Promise.resolve({
        status: "verified",
        approval,
        card: {
          brand: (metadata as typeof BOUND_CARD).brand,
          last4: (metadata as typeof BOUND_CARD).last4,
        },
      });
    }
    return Promise.resolve({});
  });
});
afterEach(() => cleanup());

describe("pay page — JIT add-card ceremony", () => {
  it("starts in add-card mode for a card-less approval (no Approve yet)", async () => {
    render(<PaymentApprovalPage />);
    await waitFor(() => expect(screen.getByText("Add a card to pay")).toBeTruthy());
    expect(screen.getByTestId("card-entry")).toBeTruthy();
    // The card is impossible to tap past — no approve action exists yet.
    expect(screen.queryByRole("button", { name: /Approve payment/ })).toBeNull();
  });

  it("add → bind shows the server record before one passkey approval", async () => {
    render(<PaymentApprovalPage />);
    await waitFor(() => expect(screen.getByTestId("card-entry")).toBeTruthy());

    const user = userEvent.setup();
    await user.click(screen.getByTestId("card-entry"));

    // Binds the stored card to the approval, server-side.
    await waitFor(() =>
      expect(api.apiPost).toHaveBeenCalledWith("/v1/pay/approvals/appr_1/bind-card", {
        card_ref: "card_new",
      }),
    );

    const approve = await screen.findByRole("button", { name: /Approve payment/ });
    expect(screen.getByText("CASETiFY")).toBeTruthy();
    expect(screen.getByText("https://casetify.com")).toBeTruthy();
    expect(screen.getByText("phone case")).toBeTruthy();
    expect(screen.getByText("gift")).toBeTruthy();
    expect(screen.getByText(/Pay with/).textContent).toContain("$60.00");
    const boundLine = screen.getByText(/Pay with/);
    expect(boundLine.textContent).toContain("Personal •••• 4242");
    expect(boundLine.textContent).not.toContain("4242424242424242");
    expect(approve.hasAttribute("disabled")).toBe(false);
    expect(vouchflow.signPayload).not.toHaveBeenCalled();

    await user.click(approve);
    await waitFor(() => expect(vouchflow.signPayload).toHaveBeenCalledTimes(1));
  });

  it("discloses server-record details before authorization without OAuth or account navigation", async () => {
    bound = true;
    render(<PaymentApprovalPage />);
    await screen.findByRole("button", { name: /Approve payment/ });
    expect(router.replace).not.toHaveBeenCalled();
    expect(screen.getByText("CASETiFY")).toBeTruthy();
    expect(screen.getByText("https://casetify.com")).toBeTruthy();
    expect(screen.getByText("phone case")).toBeTruthy();
    expect(screen.getByText("gift")).toBeTruthy();
    expect(screen.getByText(/Pay with/).textContent).toContain("$60.00");
    expect(api.apiGet).not.toHaveBeenCalledWith("/v1/pay/approvals/appr_1");
    expect(api.apiGet).not.toHaveBeenCalledWith("/v1/vault/e2e/card_new");
    expect(router.replace).not.toHaveBeenCalled();
    expect(screen.queryByTestId("card-entry")).toBeNull();
    expect(screen.queryByRole("button", { name: "Account" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Vault" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Cards" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Activity" })).toBeNull();
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute("href")).toBe("/");
    expect(vouchflow.signPayload).not.toHaveBeenCalled();
  });

  it("shows normal payment copy for a genuine zero-dollar approval", async () => {
    bound = true;
    approvalAmountCents = 0;
    approvalCurrency = "USD";
    render(<PaymentApprovalPage />);
    await screen.findByRole("button", { name: /Approve payment/ });

    const paymentLine = screen.getByText(/Pay with/);
    expect(paymentLine.textContent).toContain("$0.00");
  });

  it("blocks JIT approval when the server-bound card metadata cannot be loaded", async () => {
    failCardListAfterBind = true;
    render(<PaymentApprovalPage />);
    await waitFor(() => expect(screen.getByTestId("card-entry")).toBeTruthy());

    const user = userEvent.setup();
    await user.click(screen.getByTestId("card-entry"));

    await screen.findByRole("button", { name: "Retry" });
    expect(screen.queryByRole("button", { name: /Approve payment/ })).toBeNull();
    expect(screen.getByText(/Personal •••• 4242/i)).toBeTruthy();
    expect(screen.getByText("CASETiFY")).toBeTruthy();
    expect(screen.getByText("card unavailable")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(
      api.apiPost.mock.calls.some(([path]) => path === "/v1/pay/approvals/appr_1/approve"),
    ).toBe(false);
  });

  it("keeps the pre-bound legacy-card approval path enabled", async () => {
    bound = true;
    cardListOverride = [LEGACY_BOUND_CARD];
    render(<PaymentApprovalPage />);

    const approve = await screen.findByRole("button", { name: /Approve payment/ });
    expect(approve.hasAttribute("disabled")).toBe(false);
    expect(screen.getByText(/Pay with/).textContent).toContain("Personal");
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("preserves a successful bind when metadata refresh fails and retries only metadata", async () => {
    failCardListAfterBind = true;
    render(<PaymentApprovalPage />);
    await waitFor(() => expect(screen.getByTestId("card-entry")).toBeTruthy());

    const user = userEvent.setup();
    await user.click(screen.getByTestId("card-entry"));

    expect(screen.queryByRole("button", { name: /Approve payment/ })).toBeNull();
    expect(screen.queryByTestId("card-entry")).toBeNull();
    expect(screen.getByText(/Personal •••• 4242/i)).toBeTruthy();
    expect(screen.getByText("card unavailable")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Retry" }));
    const approve = await screen.findByRole("button", { name: /Approve payment/ });
    expect(approve.hasAttribute("disabled")).toBe(false);
    expect(screen.getByText("CASETiFY")).toBeTruthy();
    expect(
      api.apiPost.mock.calls.filter(([path]) => path === "/v1/pay/approvals/appr_1/bind-card"),
    ).toHaveLength(1);
  });

  it("retries binding the same saved card without reopening card entry", async () => {
    bindFailures = 1;
    render(<PaymentApprovalPage />);
    await waitFor(() => expect(screen.getByTestId("card-entry")).toBeTruthy());

    const user = userEvent.setup();
    await user.click(screen.getByTestId("card-entry"));

    const retry = await screen.findByRole("button", { name: "Retry attaching card" });
    expect(screen.queryByTestId("card-entry")).toBeNull();
    expect(screen.getByText("bind unavailable")).toBeTruthy();

    await user.click(retry);
    await screen.findByRole("button", { name: /Approve payment/ });
    expect(screen.getByText("CASETiFY")).toBeTruthy();
    expect(screen.queryByTestId("card-entry")).toBeNull();

    const bindCalls = api.apiPost.mock.calls.filter(
      ([path]) => path === "/v1/pay/approvals/appr_1/bind-card",
    );
    expect(bindCalls).toEqual([
      ["/v1/pay/approvals/appr_1/bind-card", { card_ref: "card_new" }],
      ["/v1/pay/approvals/appr_1/bind-card", { card_ref: "card_new" }],
    ]);
  });

  it("reconciles an already-committed bind after its response is lost", async () => {
    loseBindResponse = true;
    render(<PaymentApprovalPage />);
    await waitFor(() => expect(screen.getByTestId("card-entry")).toBeTruthy());

    const user = userEvent.setup();
    await user.click(screen.getByTestId("card-entry"));

    await screen.findByRole("button", { name: /Approve payment/ });
    expect(screen.getByText("CASETiFY")).toBeTruthy();
    expect(screen.queryByTestId("card-entry")).toBeNull();
    expect(screen.queryByText("bind response lost")).toBeNull();
    expect(
      api.apiGet.mock.calls.filter(([path]) => path === "/v1/pay/approvals/appr_1/ceremony"),
    ).toHaveLength(2);
  });

  it("blocks a JIT approval reconciled to a different card", async () => {
    loseBindResponse = true;
    lostResponseCardRef = "card_other";
    render(<PaymentApprovalPage />);
    await waitFor(() => expect(screen.getByTestId("card-entry")).toBeTruthy());

    const user = userEvent.setup();
    await user.click(screen.getByTestId("card-entry"));

    await screen.findByText(
      "This payment was attached to a different card than the one you added.",
    );
    expect(screen.queryByRole("button", { name: /Approve payment/ })).toBeNull();
    expect(
      screen.getByText("This payment was attached to a different card than the one you added."),
    ).toBeTruthy();
    expect(screen.getByText(/this payment's/)).toBeTruthy();
    expect(screen.getByText("CASETiFY")).toBeTruthy();
  });
});

describe("pay page — single payment authorization", () => {
  it("shows a JPY approval as a whole-yen amount", async () => {
    bound = true;
    approvalAmountCents = 9845;
    approvalCurrency = "JPY";
    render(<PaymentApprovalPage />);

    const paymentLine = await screen.findByText(/Pay with/);
    expect(paymentLine.textContent).toContain("9,845");
    expect(paymentLine.textContent).not.toMatch(/9,845\.00/);
  });

  it("renders canonical payment details and names the bound card before authorization", async () => {
    bound = true;
    render(<PaymentApprovalPage />);
    await screen.findByRole("button", { name: /Approve payment/ });
    expect(screen.getByText("CASETiFY")).toBeTruthy();
    expect(screen.getByText("https://casetify.com")).toBeTruthy();
    expect(screen.getByText("phone case")).toBeTruthy();
    expect(screen.getByText("gift")).toBeTruthy();
    const namedLine = screen.getByText(/Pay with/);
    expect(namedLine.textContent).toContain("$60.00");
    // The bound card is named by non-secret label + last4; the sealed PAN
    // never appears in rendered text.
    expect(namedLine.textContent).toContain("Personal •••• 4242");
    expect(namedLine.textContent).not.toContain("4242424242424242");
    expect(vouchflow.signPayload).not.toHaveBeenCalled();
  });

  it("signs the displayed canonical values exactly once and submits without OAuth", async () => {
    bound = true;
    render(<PaymentApprovalPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Approve payment/ }));
    await waitFor(() =>
      expect(vouchflow.signPayload).toHaveBeenCalledWith({
        context: "purchase",
        payload: {
          approval_id: "appr_1",
          merchant: "CASETiFY",
          checkout_origin: "https://casetify.com",
          amount_cents: 6000,
          currency: "USD",
          nonce: "nonce",
          card_ref: "card_new",
          recipient_pubkey_hash: expect.any(String),
          item: "phone case",
          reason: "gift",
          agent: "claude-code",
        },
        minConfidence: "low",
        prfSalt: expect.any(Uint8Array),
      }),
    );
    expect(vouchflow.signPayload).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(api.apiPost).toHaveBeenCalledWith(
        "/v1/pay/approvals/appr_1/approve",
        expect.objectContaining({
          jws: "e30.synthetic.signature",
          sealed_card: "sealed-card",
        }),
      ),
    );
    expect(
      api.apiPost.mock.calls.filter(([path]) => path === "/v1/pay/approvals/appr_1/approve"),
    ).toHaveLength(1);
    expect(await screen.findByText("Approval sent — operator verifying.")).toBeTruthy();
    expect(screen.queryByText(/Approved —/)).toBeNull();
    expect(router.replace).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
  });

  it("uses OAuth only as the setup fallback when no PRF passkey is enrolled", async () => {
    bound = true;
    pairing.getPairingState.mockResolvedValue({ enrolled: false });
    render(<PaymentApprovalPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Approve payment/ }));
    await user.click(await screen.findByRole("button", { name: /Sign in and set up passkey/ }));
    await waitFor(() => expect(pairing.pairDevice).toHaveBeenCalledTimes(1));
    expect(api.apiGet).toHaveBeenCalledWith("/v1/vault/e2e");
    expect(
      api.apiPost.mock.calls.some(([path]) => path === "/v1/pay/approvals/appr_1/approve"),
    ).toBe(false);
  });

  it("does not prepare or submit when the passkey cannot decrypt this account's card", async () => {
    bound = true;
    vault.decryptCard.mockRejectedValue(new Error("card decrypt failed"));
    render(<PaymentApprovalPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Approve payment/ }));
    await screen.findByText("card decrypt failed");
    expect(screen.getByRole("button", { name: /Approve payment/ })).toBeTruthy();
    expect(vouchflow.signPayload).toHaveBeenCalledTimes(1);
    expect(
      api.apiPost.mock.calls.some(([path]) => path === "/v1/pay/approvals/appr_1/approve"),
    ).toBe(false);
  });
});
