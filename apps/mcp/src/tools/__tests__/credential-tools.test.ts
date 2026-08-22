// Credential tools (write-only-sink surface): store, vouch-gated non-secret
// metadata edit/delete, and proxy use. Secret rotation remains re-store only.

import { describe, expect, it } from "vitest";
import type { ApiClient } from "../../api-client.js";
import { storeCredentialTool } from "../store-credential.js";
import { useCredentialTool } from "../use-credential.js";
import { deleteCredentialTool, editCredentialTool } from "../credential-mutations.js";

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
      {
        service: "AWS",
        label: "prod",
        fields: { access_key_id: "AKIA", secret_access_key: "shh" },
      },
      api,
    );
    expect(seen).toMatchObject({
      service: "AWS",
      label: "prod",
      fields: { access_key_id: "AKIA" },
    });
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
          url: "https://sts.amazonaws.com/",
          headers: { "x-id": "${SECRET.access_key_id}" },
        },
      },
      api,
    )) as { response: { status: number } };
    expect(res.response.status).toBe(200);
  });

  it("schema requires reference, service, or name", () => {
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

const BASE_MUTATION = {
  approval_id: "mutation_1",
  approval_url: "https://trustysquire.ai/vault/mutate/mutation_1",
  status: "pending" as const,
  operation: "edit" as const,
  credential: { reference: "vault://a/b/c", service: "OpenAI", name: "default" },
  before: {
    label: "default",
    allowed_hosts: ["api.openai.com"],
    login_hosts: [],
    auth_strategy: null,
  },
  after: {
    label: "default",
    allowed_hosts: ["api.openai.com", "uploads.openai.com"],
    login_hosts: [],
    auth_strategy: null,
  },
  expires_at: "2026-08-22T12:10:00.000Z",
};

describe("edit_credential", () => {
  it("creates an exact vouch intent, then resumes only by approval_id", async () => {
    let createdInput: unknown;
    const api = mockApi({
      createCredentialMutationApproval: async (input) => {
        createdInput = input;
        return BASE_MUTATION;
      },
      getCredentialMutationApproval: async (id) => ({
        ...BASE_MUTATION,
        approval_id: id,
        status: "approved",
      }),
    });
    const pending = await editCredentialTool.handler(
      {
        service: "OpenAI",
        name: "default",
        changes: { allowed_hosts: { mode: "add", hosts: ["uploads.openai.com"] } },
      },
      api,
    );
    expect(createdInput).toEqual({
      operation: "edit",
      service: "OpenAI",
      name: "default",
      changes: { allowed_hosts: { mode: "add", hosts: ["uploads.openai.com"] } },
    });
    expect(pending).toMatchObject({
      status: "approval_pending",
      approval_id: "mutation_1",
      next: { tool: "edit_credential", approval_id: "mutation_1" },
    });
    expect(JSON.stringify(pending)).not.toContain("sk-secret");

    await expect(
      editCredentialTool.handler({ approval_id: "mutation_1" }, api),
    ).resolves.toMatchObject({
      status: "credential_updated",
      approval_id: "mutation_1",
    });
  });

  it("rejects secret/immutable edit fields in the schema", () => {
    expect(
      editCredentialTool.inputSchema.safeParse({
        reference: "vault://a/b/c",
        changes: { value: "sk-secret" },
      }).success,
    ).toBe(false);
    expect(
      editCredentialTool.inputSchema.safeParse({
        reference: "vault://a/b/c",
        changes: {
          allowed_hosts: {
            mode: "add",
            hosts: ["uploads.openai.com"],
            unexpected: true,
          },
        },
      }).success,
    ).toBe(false);
  });

  it("is destructive, idempotent, and always loaded", () => {
    expect(editCredentialTool.annotations).toMatchObject({
      destructiveHint: true,
      idempotentHint: true,
    });
    expect(editCredentialTool.meta).toMatchObject({ "anthropic/alwaysLoad": true });
  });
});

describe("delete_credential", () => {
  it("returns pending before vouch and an idempotent deleted result after approval", async () => {
    const api = mockApi({
      createCredentialMutationApproval: async () => ({
        ...BASE_MUTATION,
        operation: "delete",
        after: null,
      }),
      getCredentialMutationApproval: async (id) => ({
        ...BASE_MUTATION,
        approval_id: id,
        operation: "delete",
        status: "approved",
        after: null,
      }),
    });
    await expect(
      deleteCredentialTool.handler({ reference: "vault://a/b/c" }, api),
    ).resolves.toMatchObject({
      status: "approval_pending",
      operation: "delete",
    });
    await expect(
      deleteCredentialTool.handler({ approval_id: "mutation_1" }, api),
    ).resolves.toMatchObject({
      status: "credential_deleted",
      approval_id: "mutation_1",
    });
  });

  it("does not accept an edit approval as delete authority", async () => {
    const api = mockApi({ getCredentialMutationApproval: async () => BASE_MUTATION });
    await expect(deleteCredentialTool.handler({ approval_id: "mutation_1" }, api)).resolves.toEqual(
      {
        status: "approval_intent_mismatch",
        error: "approval_operation_mismatch",
        expected_operation: "delete",
        actual_operation: "edit",
      },
    );
  });
});
