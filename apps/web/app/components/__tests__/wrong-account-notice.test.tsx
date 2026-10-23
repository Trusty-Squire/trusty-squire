// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const router = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
import * as api from "../../lib/api";
import { WrongAccountNotice } from "../WrongAccountNotice";
beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("keeps the approval open if logout fails and allows retry", async () => {
  vi.spyOn(api, "apiGet").mockResolvedValue({ signed_in: true, email: "other@example.com" });
  const logout = vi
    .spyOn(api, "apiPost")
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue({ ok: true });
  render(<WrongAccountNotice approvalPath="/vault/fetch/a?source=link" />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Switch account" }));
  expect(await screen.findByText(/Could not sign out/)).toBeTruthy();
  expect(router.replace).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Switch account" }));
  await waitFor(() =>
    expect(router.replace).toHaveBeenCalledWith("/login?next=%2Fvault%2Ffetch%2Fa%3Fsource%3Dlink"),
  );
  expect(logout).toHaveBeenCalledTimes(2);
});
it("still offers recovery when the account read is unavailable", async () => {
  vi.spyOn(api, "apiGet").mockRejectedValue(new Error("offline"));
  vi.spyOn(api, "apiPost").mockRejectedValue(new api.ApiError(401, "web_session_required"));
  render(<WrongAccountNotice approvalPath="/vault/fetch/a" />);
  await userEvent.setup().click(screen.getByRole("button", { name: "Switch account" }));
  await waitFor(() =>
    expect(router.replace).toHaveBeenCalledWith("/login?next=%2Fvault%2Ffetch%2Fa"),
  );
});
