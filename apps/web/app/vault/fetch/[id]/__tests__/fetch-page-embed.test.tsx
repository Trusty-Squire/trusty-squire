// @vitest-environment happy-dom
// The fetch approval page opened from another app's sheet (the SDK's
// approvals.open()): no site chrome, the decision posted to the app, and a
// window of our own when the sheet cannot use a passkey.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as PairingModule from "../../../../lib/pairing";

const api = vi.hoisted(() => {
  class ApiError extends Error {
    constructor(
      message: string,
      public readonly status: number,
    ) {
      super(message);
    }
  }
  return { apiGet: vi.fn(), apiPost: vi.fn(), ApiError };
});
const router = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
const vouchflow = vi.hoisted(() => ({ signPayload: vi.fn() }));
const pairing = vi.hoisted(() => ({
  getPairingState: vi.fn(),
  pairDevice: vi.fn(),
  registerEnrolledDevice: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "fetch_1" }),
  useRouter: () => router,
  usePathname: () => "/vault/fetch/fetch_1",
}));
vi.mock("../../../../lib/api", () => ({
  ApiError: api.ApiError,
  apiGet: api.apiGet,
  apiPost: api.apiPost,
}));
vi.mock("../../../../lib/vouchflow", () => ({ getVouchflow: () => vouchflow }));
vi.mock("../../../../lib/pairing", async (importOriginal) => ({
  ...(await importOriginal<typeof PairingModule>()),
  getPairingState: pairing.getPairingState,
  pairDevice: pairing.pairDevice,
  registerEnrolledDevice: pairing.registerEnrolledDevice,
}));

import CredentialFetchApprovalPage from "../page";

const APP = "https://app.example.test";
let status: string;
let parent: { postMessage: ReturnType<typeof vi.fn> };

function openAs(search: string): void {
  window.history.replaceState({}, "", `/vault/fetch/fetch_1${search}`);
}

function posted(): unknown[] {
  return parent.postMessage.mock.calls.map((call) => {
    expect(call[1]).toBe(APP);
    return call[0];
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  status = "pending";
  parent = { postMessage: vi.fn() };
  Object.defineProperty(window, "parent", { value: parent, configurable: true });
  pairing.getPairingState.mockResolvedValue({ enrolled: true });
  pairing.registerEnrolledDevice.mockResolvedValue(false);
  vouchflow.signPayload.mockResolvedValue({ assertion: "signed-fetch-jws" });
  api.apiGet.mockImplementation((path: string) => {
    if (path === "/v1/vault/fetch-approvals/fetch_1/ceremony") {
      return Promise.resolve({
        approval_id: "fetch_1",
        status,
        credential: { reference: "vault://r", service: "Stripe", name: "live" },
        field: null,
        field_names: ["value"],
        agent: "Ruby",
        reason: null,
        expires_at: new Date(Date.now() + 600_000).toISOString(),
        payload: {},
        payload_sha256: "h",
      });
    }
    if (path === "/v1/status") return Promise.resolve({ billing_enabled: false });
    return Promise.reject(new Error(`unexpected GET ${path}`));
  });
  api.apiPost.mockImplementation((path: string) => {
    if (path === "/v1/vault/fetch-approvals/fetch_1/approve") {
      status = "approved";
      return Promise.resolve({ status: "approved" });
    }
    return Promise.reject(new Error(`unexpected POST ${path}`));
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (document as Document & { featurePolicy?: unknown }).featurePolicy;
  Object.defineProperty(window, "parent", { value: window, configurable: true });
  openAs("");
});

describe("fetch approval page in another app's sheet", () => {
  it("drops the site chrome, reports the decision, and steps back to the app", async () => {
    openAs(`?embed=sheet&return_origin=${encodeURIComponent(APP)}`);
    render(<CredentialFetchApprovalPage />);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Approve reveal" }));
    expect(screen.queryByRole("link", { name: /Trusty Squire/ })).toBeNull();
    await waitFor(() =>
      expect(posted()).toContainEqual({
        source: "trusty-squire",
        type: "approval.decision",
        approvalId: "fetch_1",
        status: "approved",
      }),
    );
    await userEvent.setup().click(screen.getByRole("button", { name: "Return to app" }));
    expect(posted()).toContainEqual({
      source: "trusty-squire",
      type: "approval.close",
      approvalId: "fetch_1",
    });
  });

  it("offers a window of its own when the sheet may not use a passkey", async () => {
    openAs(`?embed=sheet&return_origin=${encodeURIComponent(APP)}`);
    (document as Document & { featurePolicy?: unknown }).featurePolicy = {
      allowsFeature: (feature: string) => feature !== "publickey-credentials-get",
    };
    const popup = {} as Window;
    const open = vi.spyOn(window, "open").mockReturnValue(popup);
    render(<CredentialFetchApprovalPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Approve reveal" }));
    expect(vouchflow.signPayload).not.toHaveBeenCalled();
    await user.click(await screen.findByRole("button", { name: "Continue in a new window" }));
    const url = new URL(open.mock.calls[0]![0] as string);
    expect(url.pathname).toBe("/vault/fetch/fetch_1");
    expect(url.searchParams.get("embed")).toBe("popup");
    expect(url.searchParams.get("return_origin")).toBe(window.location.origin);
  });

  it("asks the app to redirect when a popup is blocked too", async () => {
    openAs(`?embed=sheet&return_origin=${encodeURIComponent(APP)}`);
    vouchflow.signPayload.mockRejectedValue(Object.assign(new Error("denied"), { name: "NotAllowedError" }));
    vi.spyOn(window, "open").mockReturnValue(null);
    render(<CredentialFetchApprovalPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Approve reveal" }));
    await user.click(await screen.findByRole("button", { name: "Continue in a new window" }));
    expect(posted()).toContainEqual({
      source: "trusty-squire",
      type: "approval.fallback",
      approvalId: "fetch_1",
    });
  });

  it("ignores an embed request whose return origin is not https", async () => {
    openAs("?embed=sheet&return_origin=http%3A%2F%2Fevil.test");
    render(<CredentialFetchApprovalPage />);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Approve reveal" }));
    await waitFor(() => expect(api.apiPost).toHaveBeenCalled());
    expect(parent.postMessage).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: /Trusty Squire/ })).toBeTruthy();
  });
});
