// Credential tools (write-only-sink surface): store (upsert) + use.
// Agents have no rotate/delete — rotation = re-store; delete is web-only.

import { describe, expect, it } from "vitest";
import type { ApiClient } from "../../api-client.js";
import { storeCredentialTool } from "../store-credential.js";
import { useCredentialTool } from "../use-credential.js";

function mockApi(over: Partial<ApiClient>): ApiClient {
  return over as ApiClient;
}

describe("store_credential (upsert)", () => {
  it("stores a single value and returns reference + field_names + updated", async () => {
    const api = mockApi({
      storeCredential: async (input) => {
        expect(input.service).toBe("OpenAI");
        expect(input.value).toBe("sk-x");
        return {
          reference: "vault://a/b/c",
          service: "OpenAI",
          label: "default",
          field_names: ["value"],
          auth_strategy: null,
          signin_url: null,
          login_hosts: [],
          allowed_hosts: ["api.openai.com"],
          created_at: "2026-05-30T00:00:00Z",
          updated: false,
        };
      },
    });
    const res = await storeCredentialTool.handler({ service: "OpenAI", value: "sk-x" }, api);
    expect(res).toEqual({
      reference: "vault://a/b/c",
      service: "OpenAI",
      label: "default",
      field_names: ["value"],
      auth_strategy: null,
      signin_url: null,
      login_hosts: [],
      allowed_hosts: ["api.openai.com"],
      updated: false,
    });
  });

  it("forwards a multi-field credential + label", async () => {
    let seen: unknown;
    const api = mockApi({
      storeCredential: async (input) => {
        seen = input;
        return {
          reference: "vault://a/b/d",
          service: "AWS",
          label: "prod",
          field_names: ["access_key_id", "secret_access_key"],
          auth_strategy: null,
          signin_url: null,
          login_hosts: [],
          allowed_hosts: [],
          created_at: "x",
          updated: true,
        };
      },
    });
    await storeCredentialTool.handler(
      { service: "AWS", label: "prod", fields: { access_key_id: "AKIA", secret_access_key: "shh" } },
      api,
    );
    expect(seen).toMatchObject({ service: "AWS", label: "prod", fields: { access_key_id: "AKIA" } });
  });

  it("forwards observed_hosts so captured keys do not land with an empty allowlist", async () => {
    let seen: unknown;
    const api = mockApi({
      storeCredential: async (input) => {
        seen = input;
        return {
          reference: "vault://a/b/resend",
          service: "Resend",
          label: "default",
          field_names: ["value"],
          auth_strategy: null,
          signin_url: null,
          login_hosts: [],
          allowed_hosts: ["api.resend.com"],
          created_at: "x",
          updated: true,
        };
      },
    });
    await storeCredentialTool.handler(
      {
        service: "Resend",
        value: "re_x",
        observed_hosts: ["resend.com", "api.resend.com"],
      },
      api,
    );
    expect(seen).toMatchObject({
      service: "Resend",
      observed_hosts: ["resend.com", "api.resend.com"],
    });
  });

  it("schema requires value or fields", () => {
    expect(storeCredentialTool.inputSchema.safeParse({ service: "X" }).success).toBe(false);
  });

  it("throws without an active session", async () => {
    await expect(storeCredentialTool.handler({ service: "x", value: "y" }, null)).rejects.toThrow(
      /active Trusty Squire session/,
    );
  });

  it("is idempotent + always-loaded", () => {
    expect(storeCredentialTool.annotations).toMatchObject({ idempotentHint: true });
    expect(storeCredentialTool.meta).toMatchObject({ "anthropic/alwaysLoad": true });
  });
});

describe("use_credential", () => {
  it("proxies with ${SECRET.field} and returns the upstream response", async () => {
    const api = mockApi({
      useCredential: async (input) => {
        expect(input.reference).toBe("vault://a/b/c");
        expect(input.http.headers?.["x-id"]).toBe("${SECRET.access_key_id}");
        return {
          response: { status: 200, headers: { "content-type": "application/json" }, body: '{"ok":true}', truncated: false },
        };
      },
    });
    const res = (await useCredentialTool.handler(
      {
        reference: "vault://a/b/c",
        http: { method: "GET", url: "https://sts.amazonaws.com/", headers: { "x-id": "${SECRET.access_key_id}" } },
      },
      api,
    )) as { response: { status: number } };
    expect(res.response.status).toBe(200);
  });

  it("schema requires reference or service", () => {
    const parsed = useCredentialTool.inputSchema.safeParse({
      http: { method: "GET", url: "https://api.openai.com/v1/models" },
    });
    expect(parsed.success).toBe(false);
  });

  it("is destructive + always-loaded", () => {
    expect(useCredentialTool.annotations).toMatchObject({ destructiveHint: true });
    expect(useCredentialTool.meta).toMatchObject({ "anthropic/alwaysLoad": true });
  });
});
