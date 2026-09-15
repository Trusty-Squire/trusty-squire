// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
const router = vi.hoisted(() => ({ replace: vi.fn() }));
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
// The unlinked-device wording and its predicate are pure and live in the
// same module as the mocked device calls; keep the REAL ones so the page
// tests exercise the shipped copy rather than a stub of it.
vi.mock("../../../../lib/pairing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../lib/pairing")>()),
  getPairingState: pairing.getPairingState,
  pairDevice: pairing.pairDevice,
  registerEnrolledDevice: pairing.registerEnrolledDevice,
}));

import CredentialFetchApprovalPage from "../page";

const ceremony = {
  approval_id: "fetch_1",
  status: "pending" as const,
  credential: {
    reference: "vault://account/subscription/credential",
    service: "AWS",
    name: "prod",
  },
  field: "secret_access_key",
  field_names: ["access_key_id", "secret_access_key"],
  expires_at: "2026-09-05T12:10:00.000Z",
  payload: { fetch: { purpose: "credential.reveal" } },
  payload_sha256: "payload-hash",
};

let status: string;

beforeEach(() => {
  vi.clearAllMocks();
  status = "pending";
  pairing.getPairingState.mockResolvedValue({ enrolled: true });
  pairing.pairDevice.mockResolvedValue(undefined);
  pairing.registerEnrolledDevice.mockResolvedValue(false);
  vouchflow.signPayload.mockResolvedValue({ assertion: "signed-fetch-jws" });
  api.apiGet.mockImplementation((path: string) => {
    if (path === "/v1/status") return Promise.resolve({ billing_enabled: false });
    if (path === "/v1/vault/e2e") return Promise.resolve([]);
    if (path === "/v1/vault/fetch-approvals/fetch_1/ceremony") {
      return Promise.resolve({ ...ceremony, status });
    }
    return Promise.reject(new Error(`unexpected GET ${path}`));
  });
  api.apiPost.mockImplementation((path: string) => {
    if (path === "/v1/vault/fetch-approvals/fetch_1/approve") {
      status = "approved";
      return Promise.resolve({ status: "approved" });
    }
    if (path === "/v1/vault/fetch-approvals/fetch_1/deny") {
      status = "denied";
      return Promise.resolve({ status: "denied" });
    }
    return Promise.reject(new Error(`unexpected POST ${path}`));
  });
});

afterEach(() => cleanup());

describe("credential fetch approval page", () => {
  it("styles the approval and denial controls with the shared button classes", async () => {
    render(<CredentialFetchApprovalPage />);
    const deny = await screen.findByRole("button", { name: "Deny" });
    expect(deny.classList.contains("btn-deny")).toBe(true);
    const approve = screen.getByRole("button", { name: "Approve reveal" });
    expect(approve.classList.contains("btn-primary")).toBe(true);
  });

  it("names the exact credential and field, and warns what approving costs", async () => {
    render(<CredentialFetchApprovalPage />);
    expect(await screen.findByText("AWS · prod")).toBeTruthy();
    expect(screen.getByText("vault://account/subscription/credential")).toBeTruthy();
    expect(screen.getByText("secret_access_key")).toBeTruthy();
    expect(screen.getByText(/see this value in clear/i)).toBeTruthy();
  });

  it("never renders a secret value — the ceremony carries none", async () => {
    render(<CredentialFetchApprovalPage />);
    await screen.findByText("AWS · prod");
    // The ceremony response has no value field at all; this pins that the page
    // has no place it could render one from.
    expect(Object.keys(ceremony)).not.toContain("fields");
    expect(document.body.textContent).not.toContain("sk-");
  });

  it("signs with the credential-FETCH context and submits only the JWS", async () => {
    render(<CredentialFetchApprovalPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Approve reveal" }));

    await waitFor(() =>
      expect(vouchflow.signPayload).toHaveBeenCalledWith({
        context: "vault_credential_fetch",
        payload: ceremony.payload,
        minConfidence: "low",
      }),
    );
    expect(api.apiPost).toHaveBeenCalledWith("/v1/vault/fetch-approvals/fetch_1/approve", {
      jws: "signed-fetch-jws",
    });
    expect(await screen.findByText(/agent can now read this secret once/i)).toBeTruthy();
  });

  it("denies without signing anything", async () => {
    render(<CredentialFetchApprovalPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Deny" }));

    await waitFor(() => expect(screen.getByText(/no value was released/i)).toBeTruthy());
    expect(vouchflow.signPayload).not.toHaveBeenCalled();
    expect(api.apiPost).toHaveBeenCalledWith("/v1/vault/fetch-approvals/fetch_1/deny", {});
  });

  // A signed-in browser opening the link claims its own passkey, so an owner
  // who enrolled long before this binding existed can answer the approval
  // without detouring through the vault to register first.
  it("claims this browser's enrolled device on mount", async () => {
    render(<CredentialFetchApprovalPage />);
    await screen.findByRole("button", { name: "Approve reveal" });
    expect(pairing.registerEnrolledDevice).toHaveBeenCalledTimes(1);
  });

  it("stays usable when the mount-time device claim fails", async () => {
    pairing.registerEnrolledDevice.mockRejectedValue(new api.ApiError("web_session_required", 401));
    render(<CredentialFetchApprovalPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Approve reveal" }));

    await waitFor(() =>
      expect(screen.getByText(/the agent can now read this secret/i)).toBeTruthy(),
    );
    expect(router.replace).not.toHaveBeenCalled();
  });

  // An unclaimed passkey is recoverable, not a dead end: signing in claims this
  // browser's device on the way back, so the human returns to a link that works
  // instead of reading an instruction to go do it themselves.
  it("sends an unclaimed signing device through login and back to this approval", async () => {
    api.apiPost.mockRejectedValue(new api.ApiError("mandate_signer_not_authorized", 403));
    render(<CredentialFetchApprovalPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Approve reveal" }));

    await waitFor(() =>
      expect(router.replace).toHaveBeenCalledWith("/login?next=/vault/fetch/fetch_1"),
    );
    expect(screen.queryByText(/mandate_signer_not_authorized/)).toBeNull();
    // One attempt, never a retry loop.
    expect(
      api.apiPost.mock.calls.filter(
        ([path]: [string]) => path === "/v1/vault/fetch-approvals/fetch_1/approve",
      ),
    ).toHaveLength(1);
  });

  // Unlike an unlinked device, an assertion that named no device at all is not
  // something signing in can fix, so the page must say something a human can
  // act on rather than echo the wire code.
  it("explains an assertion that named no signing device, without redirecting", async () => {
    api.apiPost.mockRejectedValue(new api.ApiError("missing_device_token", 403));
    render(<CredentialFetchApprovalPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Approve reveal" }));

    await waitFor(() =>
      expect(screen.getByText(/couldn't verify which device signed/i)).toBeTruthy(),
    );
    expect(screen.queryByText(/missing_device_token/)).toBeNull();
    expect(router.replace).not.toHaveBeenCalled();
  });

  // Once the claim HAS landed this browser holds a session, so the same refusal
  // means that session is a different account. Another trip to login would just
  // return to the same 403, so the page has to stop and say so.
  it("stops redirecting once the device is claimed and the refusal persists", async () => {
    pairing.registerEnrolledDevice.mockResolvedValue(true);
    api.apiPost.mockRejectedValue(new api.ApiError("mandate_signer_not_authorized", 403));
    render(<CredentialFetchApprovalPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Approve reveal" }));

    await waitFor(() =>
      expect(screen.getByText(/linked to a different Trusty Squire account/i)).toBeTruthy(),
    );
    expect(router.replace).not.toHaveBeenCalled();
    expect(screen.queryByText(/mandate_signer_not_authorized/)).toBeNull();
  });

  it("surfaces any other approval failure in place", async () => {
    api.apiPost.mockRejectedValue(new api.ApiError("credential_fetch_approval_expired", 409));
    render(<CredentialFetchApprovalPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Approve reveal" }));

    await waitFor(() =>
      expect(screen.getByText(/credential_fetch_approval_expired/)).toBeTruthy(),
    );
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("shows a load failure in place rather than bouncing to login", async () => {
    api.apiGet.mockImplementation((path: string) => {
      if (path === "/v1/vault/fetch-approvals/fetch_1/ceremony") {
        return Promise.reject(new api.ApiError("credential_fetch_approval_not_found", 404));
      }
      return Promise.resolve({ billing_enabled: false });
    });

    render(<CredentialFetchApprovalPage />);
    await waitFor(() =>
      expect(screen.getByText(/credential_fetch_approval_not_found/)).toBeTruthy(),
    );
    expect(router.replace).not.toHaveBeenCalled();
    expect(api.apiPost).not.toHaveBeenCalled();
    expect(vouchflow.signPayload).not.toHaveBeenCalled();
  });

  it("does not submit when no passkey is enrolled", async () => {
    pairing.getPairingState.mockResolvedValue({ enrolled: false });
    render(<CredentialFetchApprovalPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Approve reveal" }));
    expect(api.apiPost).not.toHaveBeenCalled();
    const setup = await screen.findByRole("button", { name: /set up passkey/i });
    expect(setup.classList.contains("btn-primary")).toBe(true);
  });
});
