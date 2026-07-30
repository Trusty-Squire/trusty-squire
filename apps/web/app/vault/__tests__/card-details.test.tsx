// @vitest-environment happy-dom
// Card detail view — everything but the CVV. Clicking a wallet row opens
// the inline particulars; `reveal` runs the passkey ceremony and decrypts
// the sealed blob CLIENT-side. The load-bearing assertion: the decrypted
// CVV never reaches the DOM, in any form.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const api = vi.hoisted(() => ({
  ApiError: class ApiError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPatch: vi.fn(),
  apiDelete: vi.fn(),
}));
const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
const e2e = vi.hoisted(() => ({ decryptCard: vi.fn(), encryptCard: vi.fn() }));
const passkey = vi.hoisted(() => ({ evaluatePrf: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/vault",
  useParams: () => ({}),
}));
vi.mock("../../lib/api", () => ({
  ApiError: api.ApiError,
  apiGet: api.apiGet,
  apiPost: api.apiPost,
  apiPatch: api.apiPatch,
  apiDelete: api.apiDelete,
  timeAgo: () => "1d ago",
}));
vi.mock("@trusty-squire/vault/e2e", () => e2e);
vi.mock("../../lib/passkey", () => passkey);

import VaultPage from "../page";

const CARD = {
  id: "card_a",
  label: "Personal",
  brand: "Visa",
  last4: "4242",
  createdAt: "2026-07-01T00:00:00.000Z",
};

// Synthetic card only — never real data in fixtures.
const DECRYPTED = {
  pan: "4242424242424242",
  exp_month: "12",
  exp_year: "30",
  name: "Ada Lovelace",
  cvv: "987",
  billing: {
    line1: "1 Synthetic St",
    line2: "",
    city: "Testville",
    state: "",
    postal_code: "12345",
    country: "US",
  },
};

const BLOB = JSON.stringify({
  v: 1,
  cipher: "aes-256-gcm",
  iv: "aXY=",
  ct: "c2VhbGVk",
  prf_salt: btoa("synthetic-salt"),
});

beforeEach(() => {
  vi.clearAllMocks();
  api.apiGet.mockImplementation((path: string) => {
    if (path === "/v1/status") return Promise.resolve({ billing_enabled: false });
    if (path === "/v1/vault/credentials") return Promise.resolve({ credentials: [] });
    if (path === "/v1/vault/e2e") return Promise.resolve([CARD]);
    if (path === "/v1/vault/e2e/card_a") return Promise.resolve({ ...CARD, blob: BLOB });
    return Promise.reject(new Error(`unexpected GET ${path}`));
  });
  passkey.evaluatePrf.mockResolvedValue(new Uint8Array(32));
  e2e.decryptCard.mockResolvedValue({ ...DECRYPTED });
});
afterEach(() => cleanup());

async function openDetails() {
  render(<VaultPage />);
  await waitFor(() => expect(screen.getByText("Personal")).toBeTruthy());
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Details for Personal" }));
  return user;
}

describe("card detail view", () => {
  it("clicking the row opens the details: added date + masked PAN + reveal", async () => {
    await openDetails();
    expect(screen.getByText(/added /)).toBeTruthy();
    expect(screen.getByText("•••• •••• •••• 4242")).toBeTruthy();
    expect(screen.getByRole("button", { name: "reveal" })).toBeTruthy();
    // Nothing sealed is fetched until the user asks.
    expect(api.apiGet).not.toHaveBeenCalledWith("/v1/vault/e2e/card_a");
  });

  it("reveal runs the passkey ceremony and shows the particulars — but never the CVV", async () => {
    const user = await openDetails();
    await user.click(screen.getByRole("button", { name: "reveal" }));

    await waitFor(() => expect(screen.getByText("4242 4242 4242 4242")).toBeTruthy());
    expect(passkey.evaluatePrf).toHaveBeenCalledTimes(1);
    expect(e2e.decryptCard).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Ada Lovelace")).toBeTruthy();
    expect(screen.getByText("12 / 30")).toBeTruthy();
    expect(screen.getByText("1 Synthetic St, Testville, 12345, US")).toBeTruthy();

    // THE invariant: the decrypted CVV value and any cvv field label are
    // absent from the entire document.
    expect(document.body.textContent).not.toContain("987");
    expect(document.body.textContent?.toLowerCase()).not.toContain("cvv");
  });

  it("hide collapses the revealed values back to the mask", async () => {
    const user = await openDetails();
    await user.click(screen.getByRole("button", { name: "reveal" }));
    await waitFor(() => expect(screen.getByText("4242 4242 4242 4242")).toBeTruthy());

    await user.click(screen.getByRole("button", { name: "hide" }));
    expect(screen.queryByText("4242 4242 4242 4242")).toBeNull();
    expect(screen.getByText("•••• •••• •••• 4242")).toBeTruthy();
  });

  it("surfaces a friendly error when the passkey ceremony fails", async () => {
    passkey.evaluatePrf.mockRejectedValue(new Error("NotAllowedError"));
    const user = await openDetails();
    await user.click(screen.getByRole("button", { name: "reveal" }));
    await waitFor(() =>
      expect(
        screen.getByText("This device can't use passkeys, or the request was cancelled."),
      ).toBeTruthy(),
    );
    expect(screen.queryByText("4242 4242 4242 4242")).toBeNull();
  });
});
