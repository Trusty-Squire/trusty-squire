// @vitest-environment happy-dom
// Activity timeline — card / payment / grant events render legibly next to
// the credential events. Payment rows show merchant + amount + last4 only.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const api = vi.hoisted(() => ({
  ApiError: class ApiError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
  apiGet: vi.fn(),
}));
const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/vault/activity",
  useParams: () => ({}),
}));
vi.mock("../../../lib/api", () => ({
  ApiError: api.ApiError,
  apiGet: api.apiGet,
  timeAgo: () => "1d ago",
}));

import ActivityPage from "../page";

const EVENTS = [
  {
    id: "e1",
    type: "vault.card_stored",
    emitted_at: "2026-07-20T10:00:00.000Z",
    reference: "card://c1",
    requester: "user",
    label: "Personal Visa",
    brand: "Visa",
    last4: "4242",
  },
  {
    id: "e2",
    type: "vault.payment_executed",
    emitted_at: "2026-07-20T11:00:00.000Z",
    reference: "pay://p1",
    requester: "agent",
    merchant: "Synthetic Books",
    amount_cents: 1234,
    currency: "USD",
    last4: "4242",
    payment_status: "approved",
  },
  {
    id: "e3",
    type: "vault.card_deleted",
    emitted_at: "2026-07-20T12:00:00.000Z",
    reference: "card://c1",
    requester: "user",
    label: "Personal Visa",
    last4: "4242",
  },
  {
    id: "e5",
    type: "vault.payment_executed",
    emitted_at: "2026-07-20T12:30:00.000Z",
    reference: "pay://p2",
    requester: "agent",
    merchant: "Japan Flower Shop",
    amount_cents: 9845,
    currency: "JPY",
    last4: "4242",
    payment_status: "approved",
  },
  {
    id: "e4",
    type: "vault.grant_minted",
    emitted_at: "2026-07-20T13:00:00.000Z",
    reference: "vault://a/s/REF",
    requester: "agent",
    service: "openrouter",
    grant_id: "grant_1",
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  api.apiGet.mockImplementation((path: string) => {
    if (path === "/v1/status") return Promise.resolve({ billing_enabled: false });
    if (path.startsWith("/v1/vault/audit")) {
      return Promise.resolve({ events: EVENTS, next_before: null });
    }
    return Promise.reject(new Error(`unexpected GET ${path}`));
  });
});
afterEach(() => cleanup());

describe("activity timeline — card / payment / grant events", () => {
  it("renders card lifecycle rows with label + last4", async () => {
    render(<ActivityPage />);
    await waitFor(() => expect(screen.getByText("Card added")).toBeTruthy());
    expect(screen.getByText("Card removed")).toBeTruthy();
    expect(screen.getAllByText("Personal Visa ··4242")).toHaveLength(2);
  });

  it("renders a payment row with merchant + amount + last4, never a PAN", async () => {
    const { container } = render(<ActivityPage />);
    await waitFor(() => expect(screen.getAllByText("Payment")).toHaveLength(2));
    expect(screen.getByText("Synthetic Books — USD 12.34 ··4242")).toBeTruthy();
    expect(screen.getByText("Japan Flower Shop — JPY 9845 ··4242")).toBeTruthy();
    expect(container.textContent).not.toContain("JPY 98.45");
    // Only ever four trailing digits — no 15/16-digit number anywhere.
    expect(container.textContent).not.toMatch(/\d{15,16}/);
  });

  it("renders grant lifecycle rows", async () => {
    render(<ActivityPage />);
    await waitFor(() => expect(screen.getByText("Grant minted")).toBeTruthy());
    expect(screen.getByText("openrouter")).toBeTruthy();
  });

  it("renders an unknown payment outcome as an error", async () => {
    api.apiGet.mockImplementation((path: string) => {
      if (path === "/v1/status") return Promise.resolve({ billing_enabled: false });
      if (path.startsWith("/v1/vault/audit")) {
        return Promise.resolve({
          events: [
            {
              ...EVENTS[1],
              id: "unknown-payment",
              payment_status: "payment_outcome_unknown",
            },
          ],
          next_before: null,
        });
      }
      return Promise.reject(new Error(`unexpected GET ${path}`));
    });

    const { container } = render(<ActivityPage />);
    await waitFor(() => expect(screen.getByText("Payment payment_outcome_unknown")).toBeTruthy());
    expect(container.querySelector(".tl-row .tl-dot.err")).toBeTruthy();
    expect(container.querySelector(".tl-row .tl-dot.ok")).toBeNull();
  });
});
