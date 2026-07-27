// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
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
  CardEntry: () => <div data-testid="card-entry">shared add-card</div>,
}));

import CardPage from "../page";

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
