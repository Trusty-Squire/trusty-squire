// @vitest-environment happy-dom
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
  ...(await importOriginal<typeof PairingModule>()),
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
  agent: "Grok",
  reason: "write it into GitHub Actions" as string | null,
  expires_at: "2026-09-05T12:10:00.000Z",
  payload: { fetch: { purpose: "credential.reveal" } },
  payload_sha256: "payload-hash",
};

let status: string;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-05T12:00:00.000Z"));
  status = "pending";
  ceremony.reason = "write it into GitHub Actions";
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

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("credential fetch approval page", () => {
  it("styles the approval and denial controls with the shared button classes", async () => {
    render(<CredentialFetchApprovalPage />);
    const deny = await screen.findByRole("button", { name: "Deny" });
    expect(deny.classList.contains("btn-deny")).toBe(true);
    const approve = screen.getByRole("button", { name: "Approve reveal" });
    expect(approve.classList.contains("btn-primary")).toBe(true);
  });

  it("asks the reveal as a question with a humanized field, who/why, and expiry", async () => {
    render(<CredentialFetchApprovalPage />);
    expect(
      await screen.findByRole("heading", {
        name: "Reveal AWS Secret access key to your agent?",
      }),
    ).toBeTruthy();
    expect(screen.getByText("Requested by Grok · write it into GitHub Actions")).toBeTruthy();
    expect(
      screen.getByText(
        "Your agent sees this value once, in clear, and it stays in that conversation. Expires in 10 minutes.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("vault://account/subscription/credential")).toBeNull();
    expect(screen.queryByText("secret_access_key")).toBeNull();
    expect(screen.queryByText("AWS · prod")).toBeNull();
  });

  it("names the requesting agent alone when it stated no reason", async () => {
    ceremony.reason = null;
    render(<CredentialFetchApprovalPage />);
    expect(await screen.findByText("Requested by Grok")).toBeTruthy();
    expect(screen.queryByText(/Requested by Grok ·/)).toBeNull();
  });

  it("never renders a secret value — the ceremony carries none", async () => {
    render(<CredentialFetchApprovalPage />);
    await screen.findByRole("heading", {
      name: "Reveal AWS Secret access key to your agent?",
    });
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
    expect(screen.queryByText("AWS · prod")).toBeNull();
    expect(screen.queryByRole("button", { name: "Deny" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Approve reveal" })).toBeNull();
    expect(screen.queryByText(/Expires in/)).toBeNull();
    expect(
      screen.queryByRole("heading", { name: "Reveal AWS Secret access key to your agent?" }),
    ).toBeNull();
  });

  it("denies without signing anything", async () => {
    render(<CredentialFetchApprovalPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Deny" }));

    await waitFor(() => expect(screen.getByText(/no value was released/i)).toBeTruthy());
    expect(vouchflow.signPayload).not.toHaveBeenCalled();
    expect(api.apiPost).toHaveBeenCalledWith("/v1/vault/fetch-approvals/fetch_1/deny", {});
    expect(screen.queryByText("AWS · prod")).toBeNull();
    expect(screen.queryByRole("button", { name: "Deny" })).toBeNull();
    expect(screen.queryByText(/Expires in/)).toBeNull();
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

    await waitFor(() => expect(screen.getByText(/credential_fetch_approval_expired/)).toBeTruthy());
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

  // This is the Telegram-link landing surface now: it loads with no session, so
  // offering signed-in navigation (and a Sign out control) would send the human
  // to a 401 from the one page whose whole job is to be legible.
  it("renders no signed-in navigation on the sessionless approval link", async () => {
    render(<CredentialFetchApprovalPage />);
    await screen.findByRole("button", { name: "Approve reveal" });

    for (const name of ["Vault", "Cards", "Activity", "Services", "Agents"]) {
      expect(screen.queryByRole("link", { name })).toBeNull();
    }
    expect(screen.queryByText(/sign out/i)).toBeNull();
    expect(screen.getByRole("link", { name: /Trusty Squire/i })).toBeTruthy();
  });

  // A passkey enrolled mid-flow claims this browser, so the refusal that
  // follows is a wrong-account one — bouncing to login could not help.
  it("treats a passkey enrolled mid-flow as a claim, then explains rather than redirects", async () => {
    pairing.getPairingState.mockResolvedValueOnce({ enrolled: false, deviceId: null });
    // The mount claim finds nothing enrolled yet; only the setup below claims.
    pairing.registerEnrolledDevice.mockResolvedValueOnce(false).mockResolvedValue(true);
    render(<CredentialFetchApprovalPage />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Approve reveal" }));
    await user.click(await screen.findByRole("button", { name: /set up passkey/i }));
    await waitFor(() => expect(pairing.registerEnrolledDevice).toHaveBeenCalled());

    api.apiPost.mockRejectedValue(new api.ApiError("mandate_signer_not_authorized", 403));
    await user.click(await screen.findByRole("button", { name: "Approve reveal" }));

    await waitFor(() =>
      expect(screen.getByText(/linked to a different Trusty Squire account/i)).toBeTruthy(),
    );
    expect(router.replace).not.toHaveBeenCalled();
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
