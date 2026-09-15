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

  return { ApiError, apiGet: vi.fn(), apiPost: vi.fn() };
});
const router = vi.hoisted(() => ({ replace: vi.fn() }));
const vouchflow = vi.hoisted(() => ({ signPayload: vi.fn() }));
const pairing = vi.hoisted(() => ({
  getPairingState: vi.fn(),
  pairDevice: vi.fn(),
  registerEnrolledDevice: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "mutation_1" }),
  useRouter: () => router,
  usePathname: () => "/vault/mutate/mutation_1",
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

import CredentialMutationApprovalPage from "../page";

const ceremony = {
  approval_id: "mutation_1",
  status: "pending" as const,
  operation: "edit" as const,
  credential: {
    reference: "vault://account/subscription/credential",
    service: "OpenAI",
    name: "prod",
  },
  before: {
    label: "prod",
    allowed_hosts: ["api.openai.com"],
    login_hosts: [],
    auth_strategy: null,
  },
  after: {
    label: "prod",
    allowed_hosts: ["api.openai.com", "uploads.openai.com"],
    login_hosts: [],
    auth_strategy: null,
  },
  expires_at: "2026-08-22T12:10:00.000Z",
  payload: { mutation: { operation: "credential.edit" } },
  payload_sha256: "payload-hash",
};

beforeEach(() => {
  vi.clearAllMocks();
  pairing.getPairingState.mockResolvedValue({ enrolled: true });
  pairing.pairDevice.mockResolvedValue(undefined);
  pairing.registerEnrolledDevice.mockResolvedValue(undefined);
  vouchflow.signPayload.mockResolvedValue({ assertion: "signed-mutation-jws" });
  let approved = false;
  api.apiGet.mockImplementation((path: string) => {
    if (path === "/v1/status") return Promise.resolve({ billing_enabled: false });
    if (path === "/v1/vault/e2e") return Promise.resolve([]);
    if (path === "/v1/vault/mutation-approvals/mutation_1/ceremony") {
      return Promise.resolve({ ...ceremony, status: approved ? "approved" : "pending" });
    }
    return Promise.reject(new Error(`unexpected GET ${path}`));
  });
  api.apiPost.mockImplementation((path: string) => {
    if (path === "/v1/vault/mutation-approvals/mutation_1/approve") {
      approved = true;
      return Promise.resolve({ status: "approved" });
    }
    return Promise.reject(new Error(`unexpected POST ${path}`));
  });
});

afterEach(() => cleanup());

describe("credential mutation approval page", () => {
  // The ceremony is sessionless, so an approval link opened signed-out loads
  // normally; a failure to load is a failure to report, not a login prompt.
  it("shows a load failure in place rather than bouncing to login", async () => {
    api.apiGet.mockImplementation((path: string) => {
      if (path === "/v1/vault/mutation-approvals/mutation_1/ceremony") {
        return Promise.reject(new api.ApiError("credential_mutation_approval_not_found", 404));
      }
      return Promise.resolve({ billing_enabled: false });
    });

    render(<CredentialMutationApprovalPage />);

    await waitFor(() =>
      expect(screen.getByText(/credential_mutation_approval_not_found/)).toBeTruthy(),
    );
    expect(router.replace).not.toHaveBeenCalled();
    expect(api.apiPost).not.toHaveBeenCalled();
    expect(vouchflow.signPayload).not.toHaveBeenCalled();
  });

  it("shows the exact credential and before/after host change", async () => {
    render(<CredentialMutationApprovalPage />);
    expect(await screen.findByText("OpenAI · prod")).toBeTruthy();
    expect(screen.getByText("vault://account/subscription/credential")).toBeTruthy();
    expect(screen.getByText("api.openai.com")).toBeTruthy();
    expect(screen.getByText("api.openai.com, uploads.openai.com")).toBeTruthy();
  });

  it("signs with the credential-mutation context and submits only the JWS", async () => {
    render(<CredentialMutationApprovalPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Approve edit" }));

    await waitFor(() =>
      expect(vouchflow.signPayload).toHaveBeenCalledWith({
        context: "vault_credential_mutation",
        payload: ceremony.payload,
        minConfidence: "low",
      }),
    );
    expect(api.apiPost).toHaveBeenCalledWith("/v1/vault/mutation-approvals/mutation_1/approve", {
      jws: "signed-mutation-jws",
    });
    expect(await screen.findByText(/vault mutation is complete/i)).toBeTruthy();
  });

  // The only thing a visitor can be missing on a sessionless ceremony is a
  // device this account has claimed — say that, not the raw refusal code.
  // A signed-in browser opening the link claims its own passkey, so an owner
  // who enrolled long before this binding existed can answer the approval
  // without detouring through the vault to register first.
  it("claims this browser's enrolled device on mount", async () => {
    render(<CredentialMutationApprovalPage />);
    await screen.findByRole("button", { name: "Approve edit" });
    expect(pairing.registerEnrolledDevice).toHaveBeenCalledTimes(1);
  });

  // An unclaimed passkey is recoverable, not a dead end: signing in claims this
  // browser's device on the way back, so the human returns to a link that works
  // instead of reading an instruction to go do it themselves.
  it("sends an unclaimed signing device through login and back to this approval", async () => {
    api.apiPost.mockRejectedValue(new api.ApiError("mandate_signer_not_authorized", 403));
    render(<CredentialMutationApprovalPage />);

    await userEvent.setup().click(await screen.findByRole("button", { name: "Approve edit" }));

    await waitFor(() =>
      expect(router.replace).toHaveBeenCalledWith("/login?next=/vault/mutate/mutation_1"),
    );
    expect(screen.queryByText(/mandate_signer_not_authorized/)).toBeNull();
    // One attempt, never a retry loop.
    expect(
      api.apiPost.mock.calls.filter(
        ([path]: [string]) => path === "/v1/vault/mutation-approvals/mutation_1/approve",
      ),
    ).toHaveLength(1);
  });

  it("does not submit when no passkey is enrolled", async () => {
    pairing.getPairingState.mockResolvedValue({ enrolled: false });
    render(<CredentialMutationApprovalPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Approve edit" }));
    expect(api.apiPost).not.toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: /set up passkey/i })).toBeTruthy();
  });
});
