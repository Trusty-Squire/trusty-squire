// PR-8 — the six new credential tools, exercised against a mock
// ApiClient. Each asserts the handler shapes its result correctly,
// forwards the right call, and (where relevant) that schema validation
// + the null-api gate fire.

import { describe, expect, it } from "vitest";
import type { ApiClient } from "../../api-client.js";
import { storeCredentialTool } from "../store-credential.js";
import { rotateCredentialTool } from "../rotate-credential.js";
import { deleteCredentialTool } from "../delete-credential.js";
import { requestCredentialTool } from "../request-credential.js";
import { pollCredentialAccessTool } from "../poll-credential-access.js";
import { useCredentialTool } from "../use-credential.js";

function mockApi(over: Partial<ApiClient>): ApiClient {
  return over as ApiClient;
}

describe("store_credential", () => {
  it("stores and returns reference + allowed_hosts", async () => {
    const api = mockApi({
      storeCredential: async () => ({
        reference: "vault://a/b/c",
        type: "api_key",
        created_at: "2026-05-29T00:00:00Z",
        allowed_hosts: ["api.openai.com"],
      }),
    });
    const res = await storeCredentialTool.handler(
      { service: "OpenAI", value: "sk-x" },
      api,
    );
    expect(res).toEqual({
      reference: "vault://a/b/c",
      type: "api_key",
      stored_at: "2026-05-29T00:00:00Z",
      allowed_hosts: ["api.openai.com"],
    });
  });

  it("throws without an active session", async () => {
    await expect(
      storeCredentialTool.handler({ service: "x", value: "y" }, null),
    ).rejects.toThrow(/active Trusty Squire session/);
  });

  it("is annotated idempotent + always-loaded", () => {
    expect(storeCredentialTool.annotations).toMatchObject({ idempotentHint: true });
    expect(storeCredentialTool.meta).toMatchObject({ "anthropic/alwaysLoad": true });
  });
});

describe("rotate_credential", () => {
  it("returns rotated_at + revoked_grant_count", async () => {
    const api = mockApi({
      rotateCredential: async (ref: string, val: string) => {
        expect(ref).toBe("vault://a/b/c");
        expect(val).toBe("sk-new");
        return { rotated_at: "2026-05-29T01:00:00Z", revoked_grant_count: 2 };
      },
    });
    const res = await rotateCredentialTool.handler(
      { reference: "vault://a/b/c", new_value: "sk-new" },
      api,
    );
    expect(res).toEqual({ rotated_at: "2026-05-29T01:00:00Z", revoked_grant_count: 2 });
  });

  it("is flagged destructive", () => {
    expect(rotateCredentialTool.annotations).toMatchObject({ destructiveHint: true });
  });
});

describe("delete_credential", () => {
  it("returns deleted_at", async () => {
    const api = mockApi({
      deleteCredential: async () => ({ deleted_at: "2026-05-29T02:00:00Z" }),
    });
    const res = await deleteCredentialTool.handler({ reference: "vault://a/b/c" }, api);
    expect(res).toEqual({ deleted_at: "2026-05-29T02:00:00Z" });
  });
});

describe("request_credential", () => {
  it("forwards a value request and returns the broker reply", async () => {
    const api = mockApi({
      requestCredentialAccess: async (input) => {
        expect(input.intent).toBe("value");
        expect(input.reason_proxy_not_possible).toBe("writing .env");
        return { request_id: "req1", status: "pending", expires_at: null, auto_approved: false };
      },
    });
    const res = await requestCredentialTool.handler(
      {
        reference: "vault://a/b/c",
        purpose: "write .env",
        intent: "value",
        reason_proxy_not_possible: "writing .env",
      },
      api,
    );
    expect(res).toMatchObject({ request_id: "req1", status: "pending", auto_approved: false });
  });

  it("schema rejects intent=value without reason_proxy_not_possible", () => {
    const parsed = requestCredentialTool.inputSchema.safeParse({
      reference: "vault://a/b/c",
      purpose: "x",
      intent: "value",
    });
    expect(parsed.success).toBe(false);
  });

  it("schema rejects missing reference AND service", () => {
    const parsed = requestCredentialTool.inputSchema.safeParse({
      purpose: "x",
      intent: "proxy",
    });
    expect(parsed.success).toBe(false);
  });
});

describe("poll_credential_access", () => {
  it("returns status + value when present", async () => {
    const api = mockApi({
      pollCredentialAccess: async () => ({ status: "approved", value: "sk-secret" }),
    });
    const res = await pollCredentialAccessTool.handler({ request_id: "req1" }, api);
    expect(res).toEqual({ status: "approved", value: "sk-secret" });
  });

  it("omits value when not returned", async () => {
    const api = mockApi({
      pollCredentialAccess: async () => ({ status: "pending" }),
    });
    const res = await pollCredentialAccessTool.handler({ request_id: "req1" }, api);
    expect(res).toEqual({ status: "pending" });
  });

  it("is read-only", () => {
    expect(pollCredentialAccessTool.annotations).toMatchObject({ readOnlyHint: true });
  });
});

describe("use_credential", () => {
  it("proxies and returns the upstream response", async () => {
    const api = mockApi({
      useCredentialProxy: async (requestId, http) => {
        expect(requestId).toBe("req1");
        expect(http.headers?.authorization).toBe("Bearer ${SECRET}");
        return {
          response: {
            status: 200,
            headers: { "content-type": "application/json" },
            body: '{"ok":true}',
            truncated: false,
          },
        };
      },
    });
    const res = (await useCredentialTool.handler(
      {
        request_id: "req1",
        http: {
          method: "GET",
          url: "https://api.openai.com/v1/models",
          headers: { authorization: "Bearer ${SECRET}" },
        },
      },
      api,
    )) as { response: { status: number } };
    expect(res.response.status).toBe(200);
  });

  it("is destructive + always-loaded", () => {
    expect(useCredentialTool.annotations).toMatchObject({ destructiveHint: true });
    expect(useCredentialTool.meta).toMatchObject({ "anthropic/alwaysLoad": true });
  });
});
