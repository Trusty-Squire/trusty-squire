// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
const router = vi.hoisted(() => ({ replace: vi.fn() }));
const vouchflow = vi.hoisted(() => ({ signPayload: vi.fn() }));
const pairing = vi.hoisted(() => ({ getPairingState: vi.fn(), pairDevice: vi.fn() }));

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "mutation_1" }),
  useRouter: () => router,
  usePathname: () => "/vault/mutate/mutation_1",
}));
vi.mock("../../../../lib/api", () => ({
  ApiError: class ApiError extends Error {
    constructor(
      message: string,
      public readonly status: number,
    ) {
      super(message);
    }
  },
  apiGet: api.apiGet,
  apiPost: api.apiPost,
}));
vi.mock("../../../../lib/vouchflow", () => ({ getVouchflow: () => vouchflow }));
vi.mock("../../../../lib/pairing", () => pairing);

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
  before: { label: "prod", allowed_hosts: ["api.openai.com"], login_hosts: [] },
  after: {
    label: "prod",
    allowed_hosts: ["api.openai.com", "uploads.openai.com"],
    login_hosts: [],
  },
  expires_at: "2026-08-22T12:10:00.000Z",
  payload: { mutation: { operation: "credential.edit" } },
  payload_sha256: "payload-hash",
};

beforeEach(() => {
  vi.clearAllMocks();
  pairing.getPairingState.mockResolvedValue({ enrolled: true });
  pairing.pairDevice.mockResolvedValue(undefined);
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

  it("does not submit when no passkey is enrolled", async () => {
    pairing.getPairingState.mockResolvedValue({ enrolled: false });
    render(<CredentialMutationApprovalPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Approve edit" }));
    expect(api.apiPost).not.toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: /set up passkey/i })).toBeTruthy();
  });
});
