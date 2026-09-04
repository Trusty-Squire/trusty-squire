// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const api = vi.hoisted(() => ({ apiPost: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/vault/card",
}));

vi.mock("../../lib/api", () => ({
  ApiError: class ApiError extends Error {},
  apiPost: api.apiPost,
}));

// Enrollment state is per-test controllable — the pre-enrollment gate and the
// enrolled form make different trust claims, and both must be PAN-scoped.
const pairing = vi.hoisted(() => ({ getPairingState: vi.fn(), pairDevice: vi.fn() }));
vi.mock("../../lib/pairing", () => pairing);

vi.mock("../../lib/passkey", () => ({
  evaluatePrf: vi.fn().mockResolvedValue(new Uint8Array(32)),
}));

vi.mock("@trusty-squire/vault/e2e", () => ({
  encryptCard: vi.fn().mockResolvedValue({ ciphertext: "sealed" }),
}));

import { CardEntry } from "../CardEntry";

beforeEach(() => {
  vi.clearAllMocks();
  pairing.getPairingState.mockResolvedValue({ enrolled: true });
});
afterEach(() => cleanup());

describe("CardEntry — the shared sensitive add-card flow", () => {
  it("makes only PAN-scoped trust claims on the pre-enrollment gate", async () => {
    pairing.getPairingState.mockResolvedValue({ enrolled: false });
    const { container } = render(<CardEntry />);
    await waitFor(() => expect(screen.getByText("Set up payments on this device")).toBeTruthy());
    const text = container.textContent ?? "";
    // The overbroad whole-card claim is a lie now that last4 + brand are stored.
    expect(text).not.toContain("Your card is never readable");
    expect(text).toContain("Your full card number is encrypted here and never readable");
  });

  it("shows the honest trust copy (no false 'cannot decrypt' promise)", async () => {
    render(<CardEntry />);
    await waitFor(() =>
      expect(
        screen.getByText(
          "Your full card number is encrypted in this browser and never readable by our servers. We store only the last 4 digits and card brand, for display.",
        ),
      ).toBeTruthy(),
    );
  });

  it(
    "auto-formats Expiration from digits alone (mobile numeric keypads have no /)",
    async () => {
      render(<CardEntry />);
      await waitFor(() => expect(screen.getByLabelText("Expiration")).toBeTruthy());
      const user = userEvent.setup();
      const expiry = screen.getByLabelText("Expiration") as HTMLInputElement;

      await user.type(expiry, "1230");
      expect(expiry.value).toBe("12/30");

      // Partial input grows naturally, without a stuck slash on backspace.
      await user.clear(expiry);
      await user.type(expiry, "1");
      expect(expiry.value).toBe("1");
      await user.clear(expiry);
      await user.type(expiry, "12");
      expect(expiry.value).toBe("12");
      await user.clear(expiry);
      await user.type(expiry, "123");
      expect(expiry.value).toBe("12/3");
      await user.keyboard("{Backspace}");
      expect(expiry.value).toBe("12");

      // A desktop user typing their own `/` still lands on valid MM/YY.
      await user.clear(expiry);
      await user.type(expiry, "12/30");
      expect(expiry.value).toBe("12/30");
    },
  );

  // userEvent typing across 9 fields exceeds the 5s default when the whole
  // workspace's suites run in parallel and starve the CPU.
  it(
    "derives brand + last4 in the browser and sends only those (never the PAN)",
    { timeout: 30_000 },
    async () => {
      api.apiPost.mockResolvedValue({ id: "card_new" });
      const onSaved = vi.fn();
      render(<CardEntry onSaved={onSaved} />);
      await waitFor(() => expect(screen.getByLabelText("Card number")).toBeTruthy());

      const user = userEvent.setup();
      await user.type(screen.getByLabelText("Label"), "Personal");
      await user.type(screen.getByLabelText("Card number"), "4242 4242 4242 4242");
      await user.type(screen.getByLabelText("Expiration"), "12 / 45");
      await user.type(screen.getByLabelText("Name on card"), "A Tester");
      await user.type(screen.getByLabelText("CVV"), "123");
      await user.type(screen.getByLabelText("Address line 1"), "1 Main St");
      await user.type(screen.getByLabelText("City"), "Townsville");
      await user.type(screen.getByLabelText("Postal code"), "12345");
      await user.selectOptions(screen.getByLabelText("Country"), "US");
      await user.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => expect(api.apiPost).toHaveBeenCalledTimes(1));
      const [path, body] = api.apiPost.mock.calls[0] as [string, Record<string, unknown>];
      expect(path).toBe("/v1/vault/e2e");
      expect(body.brand).toBe("Visa");
      expect(body.last4).toBe("4242");
      // The full PAN must never leave the browser in the request body.
      expect(JSON.stringify(body)).not.toContain("4242 4242 4242 4242");
      expect(JSON.stringify(body)).not.toContain("4242424242424242");
      expect(onSaved).toHaveBeenCalledWith({
        id: "card_new",
        label: "Personal",
        last4: "4242",
      });
    },
  );
});
