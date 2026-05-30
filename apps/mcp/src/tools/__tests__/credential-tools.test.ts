// The credential tools (write-only-sink surface): store / rotate /
// delete / use_credential, exercised against a mock ApiClient.

import { describe, expect, it } from "vitest";
import type { ApiClient } from "../../api-client.js";
import { storeCredentialTool } from "../store-credential.js";
import { rotateCredentialTool } from "../rotate-credential.js";
import { deleteCredentialTool } from "../delete-credential.js";
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
    const res = await storeCredentialTool.handler({ service: "OpenAI", value: "sk-x" }, api);
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
  it("returns rotated_at", async () => {
    const api = mockApi({
      rotateCredential: async (ref: string, val: string) => {
        expect(ref).toBe("vault://a/b/c");
        expect(val).toBe("sk-new");
        return { rotated_at: "2026-05-29T01:00:00Z" };
      },
    });
    const res = await rotateCredentialTool.handler(
      { reference: "vault://a/b/c", new_value: "sk-new" },
      api,
    );
    expect(res).toEqual({ rotated_at: "2026-05-29T01:00:00Z" });
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

describe("use_credential", () => {
  it("proxies directly (no request_id) and returns the upstream response", async () => {
    const api = mockApi({
      useCredential: async (input) => {
        expect(input.reference).toBe("vault://a/b/c");
        expect(input.http.headers?.authorization).toBe("Bearer ${SECRET}");
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
        reference: "vault://a/b/c",
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
