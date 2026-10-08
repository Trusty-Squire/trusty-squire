// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const apiGet = vi.hoisted(() => vi.fn());
vi.mock("../../lib/api", () => ({ apiGet }));
vi.mock("../../lib/pairing", () => ({
  isPasskeyRecoveryRequired: (error: unknown) =>
    error instanceof Error && "code" in error && error.code === "passkey_recovery_required",
}));

import { PasskeySetup } from "../PasskeySetup";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  apiGet.mockReset();
});

it("retries recovery and requires a card-specific confirmation before creating", async () => {
  const recoveryError = Object.assign(new Error("Recovery required"), {
    code: "passkey_recovery_required",
  });
  const onSetup = vi.fn()
    .mockRejectedValueOnce(recoveryError)
    .mockRejectedValueOnce(recoveryError)
    .mockResolvedValue(undefined);
  apiGet.mockResolvedValue([{ label: "Personal Visa" }]);
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  const user = userEvent.setup();
  render(<PasskeySetup onSetup={onSetup} cardName="Checkout card ···· 4242" />);

  await user.click(screen.getByRole("button", { name: "Sign in and set up passkey" }));
  await screen.findByRole("button", { name: "Use your existing passkey" });
  expect(onSetup).toHaveBeenCalledWith(false);
  expect(onSetup).toHaveBeenCalledTimes(1);

  await user.click(screen.getByRole("button", { name: "Use your existing passkey" }));
  await waitFor(() => expect(onSetup).toHaveBeenCalledTimes(2));
  expect(onSetup).toHaveBeenLastCalledWith(false);

  await user.click(screen.getByRole("button", { name: "Create a new passkey" }));
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Personal Visa"));
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Checkout card ···· 4242"));
  expect(onSetup).toHaveBeenCalledTimes(2);

  confirm.mockReturnValue(true);
  await user.click(screen.getByRole("button", { name: "Create a new passkey" }));
  await waitFor(() => expect(onSetup).toHaveBeenCalledTimes(3));
  expect(onSetup).toHaveBeenLastCalledWith(true);
});
