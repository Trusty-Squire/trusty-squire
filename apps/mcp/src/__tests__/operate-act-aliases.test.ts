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

import {
  operateCartAddTool,
  operateFormSelectManyTool,
  provisionActTool,
  provisionAwaitVerificationTool,
  provisionCaptchaGateTool,
  provisionExtractTool,
} from "../tools/provision-drive.js";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.observedHostsForSession.mockReturnValue(["api.example.test"]);
  mocks.stashSecretSlot.mockReturnValue({
    slot: "sealed_secret",
    masked: true,
  });
});

describe("operate_act consolidated-kind alias parity", () => {
  it("delegates cart_add through the idempotent cart handler and preserves its postcondition", async () => {
    const result = {
      status: "already_in_cart",
      cart_delta: "0",
      cart_url: "https://shop.example.test/cart",
      checkout_state: { authority: "informational_only" },
      postcondition: {
        product_identity: "sku:tiara",
        options_hash: "size=M",
        quantity: 1,
      },
    };
    mocks.cartAdd.mockResolvedValue(result);
    const legacyInput = {
      session_id: "session-cart",
      product_identity: "sku:tiara",
      options_hash: "size=M",
      idempotency_key: "cart-add-1",
    };

    const legacy = await operateCartAddTool.handler(
      operateCartAddTool.inputSchema.parse(legacyInput),
      null,
    );
    const consolidated = await provisionActTool.handler(
      provisionActTool.inputSchema.parse({ ...legacyInput, kind: "cart_add" }),
      null,
    );

    expect(consolidated).toEqual(legacy);
    expect(consolidated).toEqual(result);
    expect(mocks.cartAdd).toHaveBeenNthCalledWith(
      1,
      "session-cart",
      "sku:tiara",
      "size=M",
      "cart-add-1",
    );
    expect(mocks.cartAdd).toHaveBeenNthCalledWith(
      2,
      "session-cart",
      "sku:tiara",
      "size=M",
      "cart-add-1",
    );
    expect(() =>
      provisionActTool.inputSchema.parse({
        session_id: "session-cart",
        kind: "cart_add",
        product_identity: "sku:tiara",
        options_hash: "size=M",
      }),
    ).toThrow();
  });

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

    const legacy = await operateFormSelectManyTool.handler(
      operateFormSelectManyTool.inputSchema.parse(legacyInput),
      null,
    );
    const consolidated = await provisionActTool.handler(
      provisionActTool.inputSchema.parse({ ...legacyInput, kind: "select_many" }),
      null,
    );

    expect(consolidated).toEqual(legacy);
    expect(consolidated).toEqual(result);
    expect(mocks.formSelectMany).toHaveBeenNthCalledWith(
      1,
      "session-select",
      legacyInput.selections,
    );
    expect(mocks.formSelectMany).toHaveBeenNthCalledWith(
      2,
      "session-select",
      legacyInput.selections,
    );
  });

  it("delegates extract into_slot without widening raw-secret visibility", async () => {
    const rawSecret = "sk-live-never-return-this-value";
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

    const legacy = await provisionExtractTool.handler(
      provisionExtractTool.inputSchema.parse(legacyInput),
      null,
    );
    const consolidated = await provisionActTool.handler(
      provisionActTool.inputSchema.parse({ ...legacyInput, kind: "extract" }),
      null,
    );

    expect(consolidated).toEqual(legacy);
    expect(consolidated).toMatchObject({ sealed: true, slot: { masked: true } });
    expect(JSON.stringify(consolidated)).not.toContain(rawSecret);
    expect(mocks.stashSecretSlot).toHaveBeenCalledTimes(2);
  });

  it("delegates extract store and returns only credential metadata", async () => {
    const rawSecret = "sk-live-store-never-return-this-value";
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

    const legacy = await provisionExtractTool.handler(
      provisionExtractTool.inputSchema.parse(legacyInput),
      api,
    );
    const consolidated = await provisionActTool.handler(
      provisionActTool.inputSchema.parse({ ...legacyInput, kind: "extract" }),
      api,
    );

    expect(consolidated).toEqual(legacy);
    expect(consolidated).not.toHaveProperty("credentials");
    expect(consolidated).toMatchObject({
      stored_credential: { reference: "vault://acct/cred_1", field_names: ["api_key"] },
    });
    expect(JSON.stringify(consolidated)).not.toContain(rawSecret);
    expect(storeCredential).toHaveBeenCalledTimes(2);
  });

  it("delegates solve_captcha and preserves the needs_user fail-fast handoff", async () => {
    const result = {
      session_id: "session-captcha",
      found: true,
      variant: "recaptcha_v2",
      settled: false,
      needs_user: {
        gate: "captcha_solver",
        message: "CAPTCHA solver is not configured",
        remedy: "Set up 2Captcha in settings",
      },
    };
    mocks.captchaGate.mockResolvedValue(result);

    const legacy = await provisionCaptchaGateTool.handler(
      provisionCaptchaGateTool.inputSchema.parse({ session_id: "session-captcha" }),
      null,
    );
    const consolidated = await provisionActTool.handler(
      provisionActTool.inputSchema.parse({ session_id: "session-captcha", kind: "solve_captcha" }),
      null,
    );

    expect(consolidated).toEqual(legacy);
    expect(consolidated).toEqual(result);
    expect(mocks.captchaGate).toHaveBeenCalledTimes(2);
  });

  it("delegates await_verification through the inbox-consent and sealed-OTP contract", async () => {
    mocks.awaitVerification.mockImplementation(
      async (_sessionId: string, options: { grantConsent?: boolean }) =>
        options.grantConsent !== false
          ? {
              session_id: "session-verify",
              found: true,
              sealed: true,
              slot: { slot: "otp", masked: true },
              source_from: "service@example.test",
            }
          : {
              session_id: "session-verify",
              found: false,
              needs_user: {
                wall: "verification_code",
                message: "Inbox reading is not consented",
              },
            },
    );
    const baseInput = {
      session_id: "session-verify",
      sender: "example.test",
      into_slot: "otp",
    };

    const legacyDefault = await provisionAwaitVerificationTool.handler(
      provisionAwaitVerificationTool.inputSchema.parse(baseInput),
      null,
    );
    const consolidatedDefault = await provisionActTool.handler(
      provisionActTool.inputSchema.parse({ ...baseInput, kind: "await_verification" }),
      null,
    );
    expect(consolidatedDefault).toEqual(legacyDefault);
    expect(consolidatedDefault).toMatchObject({ found: true, sealed: true });

    const optedOutInput = { ...baseInput, grant_inbox_consent: false };
    const legacyOptedOut = await provisionAwaitVerificationTool.handler(
      provisionAwaitVerificationTool.inputSchema.parse(optedOutInput),
      null,
    );
    const consolidatedOptedOut = await provisionActTool.handler(
      provisionActTool.inputSchema.parse({ ...optedOutInput, kind: "await_verification" }),
      null,
    );
    expect(consolidatedOptedOut).toEqual(legacyOptedOut);
    expect(consolidatedOptedOut).toMatchObject({
      found: false,
      needs_user: { wall: "verification_code" },
    });

    const consentedInput = { ...baseInput, grant_inbox_consent: true };
    const legacyConsented = await provisionAwaitVerificationTool.handler(
      provisionAwaitVerificationTool.inputSchema.parse(consentedInput),
      null,
    );
    const consolidatedConsented = await provisionActTool.handler(
      provisionActTool.inputSchema.parse({ ...consentedInput, kind: "await_verification" }),
      null,
    );
    expect(consolidatedConsented).toEqual(legacyConsented);
    expect(consolidatedConsented).toMatchObject({ found: true, sealed: true });
    expect(JSON.stringify(consolidatedConsented)).not.toMatch(/\b\d{6}\b/);
    expect(mocks.awaitVerification).toHaveBeenNthCalledWith(1, "session-verify", {
      sender: "example.test",
      intoSlot: "otp",
    });
    expect(mocks.awaitVerification).toHaveBeenNthCalledWith(3, "session-verify", {
      sender: "example.test",
      intoSlot: "otp",
      grantConsent: false,
    });
    expect(mocks.awaitVerification).toHaveBeenNthCalledWith(5, "session-verify", {
      sender: "example.test",
      intoSlot: "otp",
      grantConsent: true,
    });
  });
});
