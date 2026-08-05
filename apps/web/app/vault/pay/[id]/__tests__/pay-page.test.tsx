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

// The ceremony response carries metadata only for the server-bound card.
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

function approvalBody() {
  const metadata = cardListOverride?.[0] ?? BOUND_CARD;
  return {
    id: "appr_1",
    status: "pending",
    merchant: "CASETiFY",
    checkout_origin: "https://casetify.com",
    amount_cents: 6000,
    currency: "USD",
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

beforeEach(() => {
  bound = false;
  cardListFailures = 0;
  failCardListAfterBind = false;
  bindFailures = 0;
  loseBindResponse = false;
  lostResponseCardRef = "card_new";
  cardListOverride = null;
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
    if (path === "/v1/vault/e2e") return Promise.resolve([]);
    if (path === "/v1/pay/approvals/appr_1/ceremony") {
      if (cardListFailures > 0) {
        cardListFailures -= 1;
        return Promise.reject(new Error("card unavailable"));
      }
      return Promise.resolve(approvalBody());
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

  it("add → bind → passkey review shows the SERVER-BOUND card last4", async () => {
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

    const review = await screen.findByRole("button", { name: /Review with passkey/ });
    expect(screen.queryByText(/Pay with/)).toBeNull();
    await user.click(review);

    // Details and the bound card's last4 appear only after the passkey ceremony.
    const anchor = await screen.findByText(/Pay with/);
    expect(anchor.textContent).toContain("··4242");

    // Approve is the lone action, and only appears after the card is bound.
    expect(screen.getByRole("button", { name: /Approve payment/ }).hasAttribute("disabled")).toBe(
      false,
    );
  });

  it("uses the passkey-only hot path for an already-bound approval", async () => {
    bound = true;
    render(<PaymentApprovalPage />);
    const review = await screen.findByRole("button", { name: /Review with passkey/ });
    expect(router.replace).not.toHaveBeenCalled();
    expect(screen.queryByText("CASETiFY")).toBeNull();
    const user = userEvent.setup();
    await user.click(review);
    await screen.findByRole("button", { name: /Approve payment/ });
    expect(screen.queryByTestId("card-entry")).toBeNull();
    const anchor = screen.getByText(/Pay with/);
    expect(anchor.textContent).toContain("··4242");
  });

  it("blocks JIT approval when the server-bound card metadata cannot be loaded", async () => {
    failCardListAfterBind = true;
    render(<PaymentApprovalPage />);
    await waitFor(() => expect(screen.getByTestId("card-entry")).toBeTruthy());

    const user = userEvent.setup();
    await user.click(screen.getByTestId("card-entry"));

    await screen.findByRole("button", { name: "Retry" });
    expect(screen.queryByRole("button", { name: /Approve payment/ })).toBeNull();
    expect(screen.queryByText(/your saved card/i)).toBeNull();
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

    const review = await screen.findByRole("button", { name: /Review with passkey/ });
    expect(review.hasAttribute("disabled")).toBe(false);
    expect(screen.queryByText(/your saved card/i)).toBeNull();
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
    expect(screen.queryByText(/your saved card/i)).toBeNull();
    expect(screen.getByText("card unavailable")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Retry" }));
    const review = await screen.findByRole("button", { name: /Review with passkey/ });
    await user.click(review);
    const anchor = await screen.findByText(/Pay with/);
    expect(anchor.textContent).toContain("··4242");
    expect(screen.getByRole("button", { name: /Approve payment/ }).hasAttribute("disabled")).toBe(
      false,
    );
    expect(api.apiPost).toHaveBeenCalledTimes(1);
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
    const review = await screen.findByRole("button", { name: /Review with passkey/ });
    await user.click(review);
    const anchor = await screen.findByText(/Pay with/);
    expect(anchor.textContent).toContain("··4242");
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

    const review = await screen.findByRole("button", { name: /Review with passkey/ });
    await user.click(review);
    const anchor = await screen.findByText(/Pay with/);
    expect(anchor.textContent).toContain("··4242");
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
    expect(screen.queryByText(/your saved card/i)).toBeNull();
  });
});

describe("pay page — passkey privacy gate", () => {
  it("does not render merchant, amount, item, or reason before the passkey ceremony", async () => {
    bound = true;
    render(<PaymentApprovalPage />);
    await screen.findByRole("button", { name: /Review with passkey/ });
    expect(screen.queryByText("CASETiFY")).toBeNull();
    expect(screen.queryByText("phone case")).toBeNull();
    expect(screen.queryByText("gift")).toBeNull();
    expect(screen.queryByText(/\$60/)).toBeNull();
  });

  it("submits the prepared seal without redirecting through OAuth", async () => {
    bound = true;
    render(<PaymentApprovalPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Review with passkey/ }));
    await user.click(await screen.findByRole("button", { name: /Approve payment/ }));
    await waitFor(() =>
      expect(api.apiPost).toHaveBeenCalledWith(
        "/v1/pay/approvals/appr_1/approve",
        expect.objectContaining({
          jws: "e30.synthetic.signature",
          sealed_card: "sealed-card",
        }),
      ),
    );
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("uses OAuth only as the setup fallback when no PRF passkey is enrolled", async () => {
    bound = true;
    pairing.getPairingState.mockResolvedValue({ enrolled: false });
    render(<PaymentApprovalPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Review with passkey/ }));
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
    await user.click(await screen.findByRole("button", { name: /Review with passkey/ }));
    await screen.findByText("card decrypt failed");
    expect(screen.queryByRole("button", { name: /Approve payment/ })).toBeNull();
    expect(
      api.apiPost.mock.calls.some(([path]) => path === "/v1/pay/approvals/appr_1/approve"),
    ).toBe(false);
  });
});
