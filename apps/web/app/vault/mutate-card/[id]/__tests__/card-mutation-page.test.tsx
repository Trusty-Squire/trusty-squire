// @vitest-environment happy-dom
// edit_payment_card's human half. The ceremony hands the page the sealed
// blob; the card is decrypted HERE with the passkey PRF, edited HERE, and
// re-encrypted HERE before anything is submitted. Load-bearing assertions:
// the sealed blob / PAN never render outside the edit form, the signed
// payload carries the exact re-encrypted card as mutation.after, and a
// malformed stored expiry (the DBS bug) can be corrected in place — no
// delete-and-re-add required.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const api = vi.hoisted(() => ({
  ApiError: class ApiError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
  apiGet: vi.fn(),
  apiPost: vi.fn(),
}));
const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
const vouchflow = vi.hoisted(() => ({ signPayload: vi.fn() }));
const pairing = vi.hoisted(() => ({ getPairingState: vi.fn(), pairDevice: vi.fn() }));
const passkey = vi.hoisted(() => ({ evaluatePrf: vi.fn() }));
const e2e = vi.hoisted(() => ({ decryptCard: vi.fn(), encryptCard: vi.fn() }));

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "card_mutation_1" }),
  useRouter: () => router,
  usePathname: () => "/vault/mutate-card/card_mutation_1",
}));
vi.mock("../../../../lib/api", () => ({
  ApiError: api.ApiError,
  apiGet: api.apiGet,
  apiPost: api.apiPost,
}));
vi.mock("../../../../lib/vouchflow", () => ({ getVouchflow: () => vouchflow }));
vi.mock("../../../../lib/pairing", () => pairing);
vi.mock("../../../../lib/passkey", () => passkey);
vi.mock("@trusty-squire/vault/e2e", () => e2e);

import CardMutationApprovalPage from "../page";

const CEREMONY = {
  approval_id: "card_mutation_1",
  status: "pending" as const,
  operation: "edit_card" as const,
  card: { id: "card_a", label: "Personal", brand: "Visa", last4: "4242" },
  before: { label: "Personal", brand: "Visa", last4: "4242" },
  after: null,
  expires_at: "2026-08-22T12:10:00.000Z",
  payload: { mutation: { operation: "card.edit_card", after: null } },
  payload_sha256: "payload-hash",
  blob: JSON.stringify({
    v: 1,
    cipher: "aes-256-gcm",
    iv: "aXY=",
    ct: "c2VhbGVk",
    prf_salt: btoa("synthetic-salt"),
  }),
};

// Synthetic card only — never real data in fixtures. The malformed
// exp_month mirrors the DBS card stored with an invalid expiry.
const DECRYPTED = {
  pan: "4242424242424242",
  exp_month: "13",
  exp_year: "99",
  name: "Ada Lovelace",
  cvv: "987",
  billing: {
    line1: "1 Synthetic St",
    line2: "",
    city: "Testville",
    state: "",
    postal_code: "12345",
    country: "US",
  },
};

const RE_ENCRYPTED = {
  v: 1,
  cipher: "aes-256-gcm",
  iv: "bmV3LWl2",
  ct: "bmV3LWN0",
};

beforeEach(() => {
  vi.clearAllMocks();
  pairing.getPairingState.mockResolvedValue({ enrolled: true });
  pairing.pairDevice.mockResolvedValue(undefined);
  passkey.evaluatePrf.mockResolvedValue(new Uint8Array(32));
  e2e.decryptCard.mockResolvedValue({ ...DECRYPTED, billing: { ...DECRYPTED.billing } });
  e2e.encryptCard.mockResolvedValue({ ...RE_ENCRYPTED });
  vouchflow.signPayload.mockResolvedValue({ assertion: "signed-card-mutation-jws" });
  let approved = false;
  api.apiGet.mockImplementation((path: string) => {
    if (path === "/v1/status") return Promise.resolve({ billing_enabled: false });
    if (path === "/v1/vault/card-mutation-approvals/card_mutation_1/ceremony") {
      return Promise.resolve({ ...CEREMONY, status: approved ? "approved" : "pending" });
    }
    return Promise.reject(new Error(`unexpected GET ${path}`));
  });
  api.apiPost.mockImplementation((path: string) => {
    if (path === "/v1/vault/card-mutation-approvals/card_mutation_1/approve") {
      approved = true;
      return Promise.resolve({ status: "approved" });
    }
    return Promise.reject(new Error(`unexpected POST ${path}`));
  });
});

afterEach(() => cleanup());

async function openEditor() {
  render(<CardMutationApprovalPage />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Edit card details" }));
  await waitFor(() => expect(e2e.decryptCard).toHaveBeenCalled());
  return user;
}

describe("card mutation approval page", () => {
  it("sends a signed-out visitor to login with the approval link", async () => {
    api.apiGet.mockImplementation((path: string) => {
      if (path === "/v1/vault/card-mutation-approvals/card_mutation_1/ceremony") {
        return Promise.reject(new api.ApiError("web_session_required", 401));
      }
      return Promise.resolve({ billing_enabled: false });
    });

    render(<CardMutationApprovalPage />);

    await waitFor(() =>
      expect(router.replace).toHaveBeenCalledWith("/login?next=/vault/mutate-card/card_mutation_1"),
    );
    expect(api.apiPost).not.toHaveBeenCalled();
    expect(vouchflow.signPayload).not.toHaveBeenCalled();
  });

  it("shows only display metadata before the passkey ceremony — never the blob", async () => {
    render(<CardMutationApprovalPage />);
    expect(await screen.findByText("Personal")).toBeTruthy();
    expect(screen.getByText("•••• •••• •••• 4242 · Visa")).toBeTruthy();
    const html = document.body.innerHTML ?? "";
    expect(html).not.toContain("c2VhbGVk");
    expect(html).not.toContain("4242424242424242");
    expect(screen.queryByRole("button", { name: /save and confirm/i })).toBeNull();
  });

  it("decrypts into the prefilled edit form after the passkey PRF ceremony", async () => {
    await openEditor();

    expect(passkey.evaluatePrf).toHaveBeenCalledTimes(1);
    expect(e2e.decryptCard).toHaveBeenCalledTimes(1);
    expect((screen.getByLabelText("Card number") as HTMLInputElement).value).toBe("4242424242424242");
    expect((screen.getByLabelText("Expiration") as HTMLInputElement).value).toBe("13/99");
    expect((screen.getByLabelText("Label") as HTMLInputElement).value).toBe("Personal");
    expect((screen.getByLabelText("Name on card") as HTMLInputElement).value).toBe("Ada Lovelace");
    expect((screen.getByLabelText("City") as HTMLInputElement).value).toBe("Testville");
  });

  it("corrects a malformed stored expiry in place and submits the re-encrypted card", async () => {
    const user = await openEditor();
    const expiry = screen.getByLabelText("Expiration") as HTMLInputElement;

    // The stored blob's malformed DBS expiry (13/99) is corrected — the card
    // never has to be deleted and re-added.
    await user.clear(expiry);
    await user.type(expiry, "1230");
    expect(expiry.value).toBe("12/30");

    await user.click(screen.getByRole("button", { name: "Save and confirm" }));

    await waitFor(() => expect(api.apiPost).toHaveBeenCalled());
    expect(e2e.encryptCard).toHaveBeenCalledTimes(1);
    const [encryptKey, encryptCard] = e2e.encryptCard.mock.calls[0] as unknown[];
    expect(encryptKey).toBe(passkey.evaluatePrf.mock.results[0]!.value);
    expect(encryptCard).toMatchObject({
      pan: "4242424242424242",
      exp_month: "12",
      exp_year: "30",
      name: "Ada Lovelace",
      cvv: "987",
    });

    // The signed payload carries the exact re-encrypted blob as
    // mutation.after, preserving the PRF salt, with brand/last4 derived
    // from the PAN in this browser.
    const signedCall = vouchflow.signPayload.mock.calls[0]![0] as {
      context: string;
      payload: { mutation: { after: { label: string; blob: string; brand: string; last4: string } } };
      minConfidence: string;
    };
    expect(signedCall.context).toBe("vault_credential_mutation");
    expect(signedCall.minConfidence).toBe("low");
    expect(signedCall.payload.mutation.after.label).toBe("Personal");
    expect(signedCall.payload.mutation.after.brand).toBe("Visa");
    expect(signedCall.payload.mutation.after.last4).toBe("4242");
    const submittedBlob = JSON.parse(signedCall.payload.mutation.after.blob) as {
      ct: string;
      prf_salt: string;
    };
    expect(submittedBlob.ct).toBe("bmV3LWN0");
    expect(submittedBlob.prf_salt).toBe(btoa("synthetic-salt"));

    // The POST submits the new opaque blob + display metadata + JWS — and
    // no card value beyond the metadata the wallet already shows.
    expect(api.apiPost).toHaveBeenCalledWith("/v1/vault/card-mutation-approvals/card_mutation_1/approve", {
      jws: "signed-card-mutation-jws",
      blob: signedCall.payload.mutation.after.blob,
      label: "Personal",
      brand: "Visa",
      last4: "4242",
    });

    expect(await screen.findByText(/card is updated/i)).toBeTruthy();
  });

  it("refuses to submit a still-malformed or past expiry", async () => {
    const user = await openEditor();
    const expiry = screen.getByLabelText("Expiration") as HTMLInputElement;

    await user.clear(expiry);
    await user.type(expiry, "13/30");
    await user.click(screen.getByRole("button", { name: "Save and confirm" }));
    expect(await screen.findByText(/valid future month/i)).toBeTruthy();
    expect(e2e.encryptCard).not.toHaveBeenCalled();
    expect(api.apiPost).not.toHaveBeenCalled();

    await user.clear(expiry);
    await user.type(expiry, "0120");
    await user.click(screen.getByRole("button", { name: "Save and confirm" }));
    expect(await screen.findByText(/valid future month/i)).toBeTruthy();
    expect(e2e.encryptCard).not.toHaveBeenCalled();
    expect(api.apiPost).not.toHaveBeenCalled();
  });

  it("sends an expired approval session to login", async () => {
    const user = await openEditor();
    api.apiPost.mockRejectedValue(new api.ApiError("web_session_required", 401));
    const expiry = screen.getByLabelText("Expiration") as HTMLInputElement;
    await user.clear(expiry);
    await user.type(expiry, "1230");
    await user.click(screen.getByRole("button", { name: "Save and confirm" }));
    await waitFor(() =>
      expect(router.replace).toHaveBeenCalledWith("/login?next=/vault/mutate-card/card_mutation_1"),
    );
  });

  it("does not open the card when no passkey is enrolled", async () => {
    render(<CardMutationApprovalPage />);
    pairing.getPairingState.mockResolvedValue({ enrolled: false });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Edit card details" }));
    expect(e2e.decryptCard).not.toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: /set up passkey/i })).toBeTruthy();
  });
});
