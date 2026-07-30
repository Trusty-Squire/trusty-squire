// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/vault/card",
}));

// AppShell fetches /v1/status on mount.
vi.mock("../../../lib/api", () => ({
  ApiError: class ApiError extends Error {},
  apiGet: vi.fn().mockResolvedValue({ billing_enabled: false }),
  apiPost: vi.fn().mockResolvedValue({}),
}));

// Stub the shared add-card component — the point of this page is that it is
// add-ONLY, driven by the shared CardEntry, with the manage UI removed.
vi.mock("../../../components/CardEntry", () => ({
  CardEntry: (props: { onSaved?: (result: { id: string }) => void }) => (
    <button
      type="button"
      data-testid="card-entry"
      onClick={() => props.onSaved?.({ id: "card_new" })}
    >
      shared add-card
    </button>
  ),
}));

vi.mock("../../../components/CredentialFields", () => ({
  CredentialFields: () => <div data-testid="credential-fields" />,
}));

import CardPage from "../page";
import NewCredentialPage from "../../new/page";

afterEach(() => cleanup());

describe("/vault/card — add-only", () => {
  it("renders the shared add-card component", async () => {
    render(<CardPage />);
    await waitFor(() => expect(screen.getByTestId("card-entry")).toBeTruthy());
    expect(screen.getByText("Add card")).toBeTruthy();
  });

  it("no longer shows the manage/remove UI (moved to the list)", async () => {
    render(<CardPage />);
    await waitFor(() => expect(screen.getByTestId("card-entry")).toBeTruthy());
    expect(screen.queryByText("Saved cards")).toBeNull();
    expect(screen.queryByText("No saved cards.")).toBeNull();
  });

  it("makes no false 'server cannot decrypt' promise", async () => {
    const { container } = render(<CardPage />);
    await waitFor(() => expect(screen.getByTestId("card-entry")).toBeTruthy());
    expect((container.textContent ?? "").toLowerCase()).not.toContain("cannot decrypt");
  });
});

describe("/vault/new — card save", () => {
  it("returns to the vault after saving from the Card tab", async () => {
    render(<NewCredentialPage />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Card" }));
    await user.click(screen.getByTestId("card-entry"));

    expect(router.push).toHaveBeenCalledWith("/vault");
  });
});
