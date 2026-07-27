// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
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

import VaultPage from "../page";

const FULL_CARD = {
  id: "card_a",
  label: "Personal",
  brand: "Visa",
  last4: "4242",
  createdAt: "2026-07-01T00:00:00.000Z",
};
const LEGACY_CARD = {
  id: "card_legacy",
  label: "Old card",
  brand: null,
  last4: null,
  createdAt: "2026-06-01T00:00:00.000Z",
};

function mockLists(cards: unknown[], creds: unknown[] = []) {
  api.apiGet.mockImplementation((path: string) => {
    if (path === "/v1/status") return Promise.resolve({ billing_enabled: false });
    if (path === "/v1/vault/credentials") return Promise.resolve({ credentials: creds });
    if (path === "/v1/vault/e2e") return Promise.resolve(cards);
    return Promise.reject(new Error(`unexpected GET ${path}`));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
});

describe("vault list — Wallet section", () => {
  it("renders Wallet above API keys", async () => {
    mockLists([FULL_CARD]);
    const { container } = render(<VaultPage />);
    await waitFor(() => expect(screen.getByText("Wallet")).toBeTruthy());
    const text = container.textContent ?? "";
    expect(text.indexOf("Wallet")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("Wallet")).toBeLessThan(text.indexOf("API keys"));
  });

  it("renders a full card row with brand + last4", async () => {
    mockLists([FULL_CARD]);
    render(<VaultPage />);
    await waitFor(() => expect(screen.getByText("Personal")).toBeTruthy());
    expect(screen.getByText(/··4242/)).toBeTruthy();
  });

  it("renders a legacy card row with the re-add nudge, not a fake last4", async () => {
    mockLists([LEGACY_CARD]);
    render(<VaultPage />);
    await waitFor(() => expect(screen.getByText("Old card")).toBeTruthy());
    expect(screen.getByText(/Re-add to show/)).toBeTruthy();
  });

  it("shows an actionable empty-wallet state, not a bare 'No saved cards.'", async () => {
    mockLists([]);
    render(<VaultPage />);
    await waitFor(() =>
      expect(
        screen.getByText("No card yet — add one so agents can pay on your behalf."),
      ).toBeTruthy(),
    );
    const link = screen.getByRole("link", { name: "Add card" });
    expect(link.getAttribute("href")).toBe("/vault/card");
    expect(screen.queryByText("No saved cards.")).toBeNull();
  });

  it("renames a card inline via PATCH .../label", async () => {
    mockLists([FULL_CARD]);
    api.apiPatch.mockResolvedValue({ id: "card_a", label: "Travel" });
    render(<VaultPage />);
    await waitFor(() => expect(screen.getByText("Personal")).toBeTruthy());

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Actions for Personal" }));
    await user.click(screen.getByRole("menuitem", { name: "Rename" }));

    const input = screen.getByLabelText("Card label");
    await user.clear(input);
    await user.type(input, "Travel");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(api.apiPatch).toHaveBeenCalledWith("/v1/vault/e2e/card_a/label", {
        label: "Travel",
      }),
    );
  });

  it("deletes a card inline via DELETE and drops the row", async () => {
    mockLists([FULL_CARD]);
    api.apiDelete.mockResolvedValue(undefined);
    render(<VaultPage />);
    await waitFor(() => expect(screen.getByText("Personal")).toBeTruthy());

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Actions for Personal" }));
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    // Inline confirm — a distinct Delete affordance in the row.
    const confirmRow = screen.getByText("Delete this card?").parentElement as HTMLElement;
    await user.click(within(confirmRow).getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(api.apiDelete).toHaveBeenCalledWith("/v1/vault/e2e/card_a"),
    );
  });

  it("redirects to login when inline card rename sees an expired session", async () => {
    mockLists([FULL_CARD]);
    api.apiPatch.mockRejectedValue(new api.ApiError("unauthorized", 401));
    render(<VaultPage />);
    await waitFor(() => expect(screen.getByText("Personal")).toBeTruthy());

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Actions for Personal" }));
    await user.click(screen.getByRole("menuitem", { name: "Rename" }));
    const input = screen.getByLabelText("Card label");
    await user.clear(input);
    await user.type(input, "Travel");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/login?next=/vault"));
    expect(screen.queryByText("unauthorized")).toBeNull();
  });

  it("redirects to login when inline card delete sees an expired session", async () => {
    mockLists([FULL_CARD]);
    api.apiDelete.mockRejectedValue(new api.ApiError("unauthorized", 401));
    render(<VaultPage />);
    await waitFor(() => expect(screen.getByText("Personal")).toBeTruthy());

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Actions for Personal" }));
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    const confirmRow = screen.getByText("Delete this card?").parentElement as HTMLElement;
    await user.click(within(confirmRow).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/login?next=/vault"));
    expect(screen.queryByText("unauthorized")).toBeNull();
  });
});
