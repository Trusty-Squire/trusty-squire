// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const api = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
}));
const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));

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
  getVouchflow: () => ({ signPayload: vi.fn() }),
}));

vi.mock("../../../../components/CardEntry", () => ({
  CardEntry: (props: { onSaved?: (r: { id: string }) => void }) => (
    <button type="button" data-testid="card-entry" onClick={() => props.onSaved?.({ id: "card_new" })}>
      add card (stub)
    </button>
  ),
}));

import PaymentApprovalPage from "../page";

// The card the ceremony binds (4242) vs a decoy card also in the account
// (9999). The review anchor must show the BOUND card's last4, never the decoy.
const BOUND_CARD = {
  id: "card_new",
  label: "Personal",
  brand: "Visa",
  last4: "4242",
  createdAt: "2026-07-01T00:00:00.000Z",
};
const DECOY_CARD = {
  id: "card_other",
  label: "Other",
  brand: "Mastercard",
  last4: "9999",
  createdAt: "2026-07-02T00:00:00.000Z",
};

let bound = false;
let cardListFailures = 0;
let failCardListAfterBind = false;

function approvalBody() {
  return {
    status: "pending",
    merchant: "CASETiFY",
    checkout_origin: "https://casetify.com",
    amount_cents: 6000,
    currency: "USD",
    nonce: "nonce",
    card_ref: bound ? "card_new" : null,
    operator_pubkey: "AAAA",
    expires_at: "2026-07-01T00:10:00.000Z",
    item: "phone case",
    reason: "gift",
    agent: "claude-code",
  };
}

beforeEach(() => {
  bound = false;
  cardListFailures = 0;
  failCardListAfterBind = false;
  vi.clearAllMocks();
  api.apiGet.mockImplementation((path: string) => {
    if (path === "/v1/status") return Promise.resolve({ billing_enabled: false });
    if (path === "/v1/pay/approvals/appr_1") return Promise.resolve(approvalBody());
    if (path === "/v1/vault/e2e") {
      if (cardListFailures > 0) {
        cardListFailures -= 1;
        return Promise.reject(new Error("card list unavailable"));
      }
      return Promise.resolve(bound ? [BOUND_CARD, DECOY_CARD] : [DECOY_CARD]);
    }
    return Promise.reject(new Error(`unexpected GET ${path}`));
  });
  api.apiPost.mockImplementation((path: string) => {
    if (path === "/v1/pay/approvals/appr_1/bind-card") {
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

  it("add → bind → review beat shows the SERVER-BOUND card last4 before approve", async () => {
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

    // Distinct review beat — the bound card's last4 is the visual anchor.
    const anchor = await screen.findByText(/Pay with/);
    expect(anchor.textContent).toContain("··4242");
    // The decoy card's last4 must never surface as the anchor.
    expect(anchor.textContent).not.toContain("9999");

    // Approve is the lone action, and only appears after the card is bound.
    expect(screen.getByRole("button", { name: /Approve payment/ })).toBeTruthy();
  });

  it("goes straight to the review beat for an already-bound approval", async () => {
    bound = true;
    render(<PaymentApprovalPage />);
    await waitFor(() => expect(screen.getByRole("button", { name: /Approve payment/ })).toBeTruthy());
    expect(screen.queryByTestId("card-entry")).toBeNull();
    const anchor = screen.getByText(/Pay with/);
    expect(anchor.textContent).toContain("··4242");
  });

  it("blocks approval when the server-bound card metadata cannot be loaded", async () => {
    bound = true;
    cardListFailures = 1;
    render(<PaymentApprovalPage />);

    const approve = await screen.findByRole("button", { name: /Approve payment/ });
    expect(approve.hasAttribute("disabled")).toBe(true);
    expect(screen.queryByText(/your saved card/i)).toBeNull();
    expect(screen.getByText("card list unavailable")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("preserves a successful bind when metadata refresh fails and retries only metadata", async () => {
    failCardListAfterBind = true;
    render(<PaymentApprovalPage />);
    await waitFor(() => expect(screen.getByTestId("card-entry")).toBeTruthy());

    const user = userEvent.setup();
    await user.click(screen.getByTestId("card-entry"));

    const approve = await screen.findByRole("button", { name: /Approve payment/ });
    expect(approve.hasAttribute("disabled")).toBe(true);
    expect(screen.queryByTestId("card-entry")).toBeNull();
    expect(screen.queryByText(/your saved card/i)).toBeNull();
    expect(screen.getByText("card list unavailable")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Retry" }));
    const anchor = await screen.findByText(/Pay with/);
    expect(anchor.textContent).toContain("··4242");
    expect(screen.getByRole("button", { name: /Approve payment/ }).hasAttribute("disabled")).toBe(
      false,
    );
    expect(api.apiPost).toHaveBeenCalledTimes(1);
  });
});
