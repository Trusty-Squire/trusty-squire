import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../api-client.js";
import type * as ProvisionSession from "../bot/provision-session.js";

const mocks = vi.hoisted(() => ({
  cartAdd: vi.fn(),
  formSelectMany: vi.fn(),
  extractCredentials: vi.fn(),
  captchaGate: vi.fn(),
  awaitVerification: vi.fn(),
  observedHostsForSession: vi.fn(),
  stashSecretSlot: vi.fn(),
}));

vi.mock("../bot/provision-session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ProvisionSession>();
  return {
    ...actual,
    cartAdd: mocks.cartAdd,
    formSelectMany: mocks.formSelectMany,
    extractCredentials: mocks.extractCredentials,
    captchaGate: mocks.captchaGate,
    awaitVerification: mocks.awaitVerification,
    observedHostsForSession: mocks.observedHostsForSession,
    stashSecretSlot: mocks.stashSecretSlot,
  };
});

import { operateSelectTool, provisionExtractTool } from "../tools/provision-drive.js";

// Credential-shaped test fixtures are assembled at runtime from harmless
// fragments so no complete vendor-prefixed token literal appears in this
// source file (GitHub secret scanning false-positived on test data in
// commit 0b3b160f). The returned values are byte-identical to the old
// literals; do NOT inline these back into single string literals.
const sk = (body: string): string => "sk" + "-" + body;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.observedHostsForSession.mockReturnValue(["api.example.test"]);
  mocks.stashSecretSlot.mockReturnValue({
    slot: "sealed_secret",
    masked: true,
  });
});

describe("flat operator workflow routing", () => {
  it("delegates select_many and preserves ordered partial results", async () => {
    const result = {
      session_id: "session-select",
      fields: [
        { label: "Variant", option: "Blue", status: "selected", selected_option: "Ocean Blue" },
        { label: "Color", option: "Red", status: "failed", reason: "no matching option" },
      ],
      observation: { session_id: "session-select", url: "https://shop.example.test/product" },
    };
    mocks.formSelectMany.mockResolvedValue(result);
    const legacyInput = {
      session_id: "session-select",
      selections: { Variant: "Blue", Color: "Red" },
    };

    const consolidated = await operateSelectTool.handler(
      operateSelectTool.inputSchema.parse({ ...legacyInput }),
      null,
    );

    expect(consolidated).toEqual(result);
    expect(mocks.formSelectMany).toHaveBeenNthCalledWith(
      1,
      "session-select",
      legacyInput.selections,
    );
  });

  it("delegates extract into_slot without widening raw-secret visibility", async () => {
    const rawSecret = sk("live-never-return-this-value");
    mocks.extractCredentials.mockResolvedValue({
      session_id: "session-extract",
      url: "https://example.test/keys",
      credentials: { client_secret: rawSecret },
      candidate_count: 1,
    });
    const legacyInput = {
      session_id: "session-extract",
      into_slot: "sealed_secret",
      secret_label: "client secret",
    };

    const consolidated = await provisionExtractTool.handler(
      provisionExtractTool.inputSchema.parse({ ...legacyInput }),
      null,
    );

    expect(consolidated).toMatchObject({ sealed: true, slot: { masked: true } });
    expect(JSON.stringify(consolidated)).not.toContain(rawSecret);
    expect(mocks.stashSecretSlot).toHaveBeenCalledTimes(1);
  });

  it("delegates extract store and returns only credential metadata", async () => {
    const rawSecret = sk("live-store-never-return-this-value");
    mocks.extractCredentials.mockResolvedValue({
      session_id: "session-store",
      url: "https://example.test/keys",
      credentials: { api_key: rawSecret },
      candidate_count: 1,
    });
    const storeCredential = vi.fn().mockResolvedValue({
      reference: "vault://acct/cred_1",
      service: "example",
      label: "Production",
      field_names: ["api_key"],
      allowed_hosts: ["api.example.test"],
      updated: false,
    });
    const api = { storeCredential } as unknown as ApiClient;
    const legacyInput = {
      session_id: "session-store",
      store: { service: "example", label: "Production" },
    };

    const consolidated = await provisionExtractTool.handler(
      provisionExtractTool.inputSchema.parse({ ...legacyInput }),
      api,
    );

    expect(consolidated).not.toHaveProperty("credentials");
    expect(consolidated).toMatchObject({
      stored_credential: { reference: "vault://acct/cred_1", field_names: ["api_key"] },
    });
    expect(JSON.stringify(consolidated)).not.toContain(rawSecret);
    expect(storeCredential).toHaveBeenCalledTimes(1);
  });
});
