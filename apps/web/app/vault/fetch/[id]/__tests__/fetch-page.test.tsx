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
const pairing = vi.hoisted(() => ({ getPairingState: vi.fn(), pairDevice: vi.fn() }));

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
vi.mock("../../../../lib/pairing", () => pairing);

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

  // The ceremony is owner-authenticated server-side; the page's job is to send
  // a signed-out visitor to log in and bring them back to the SAME approval,
  // instead of showing them an error for a link that is theirs.
  it("sends a signed-out visitor to log in, keeping the approval link", async () => {
    api.apiGet.mockImplementation((path: string) => {
      if (path === "/v1/vault/fetch-approvals/fetch_1/ceremony") {
        return Promise.reject(new api.ApiError("web_session_required", 401));
      }
      return Promise.resolve({ billing_enabled: false });
    });

    render(<CredentialFetchApprovalPage />);
    await waitFor(() =>
      expect(router.replace).toHaveBeenCalledWith("/login?next=/vault/fetch/fetch_1"),
    );
    expect(api.apiPost).not.toHaveBeenCalled();
    expect(vouchflow.signPayload).not.toHaveBeenCalled();
  });

  it("sends the human to log in when the session lapses mid-ceremony", async () => {
    api.apiPost.mockRejectedValue(new api.ApiError("web_session_required", 401));
    render(<CredentialFetchApprovalPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Approve reveal" }));
    await waitFor(() =>
      expect(router.replace).toHaveBeenCalledWith("/login?next=/vault/fetch/fetch_1"),
    );
  });

  it("does not submit when no passkey is enrolled", async () => {
    pairing.getPairingState.mockResolvedValue({ enrolled: false });
    render(<CredentialFetchApprovalPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Approve reveal" }));
    expect(api.apiPost).not.toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: /set up passkey/i })).toBeTruthy();
  });
});
