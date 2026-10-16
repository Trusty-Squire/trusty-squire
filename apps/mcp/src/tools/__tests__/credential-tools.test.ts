import { findTool } from "../index.js";
import { flatVariants } from "../flat-variants.js";
import { z } from "zod";
// Credential tools (write-only-sink surface): store, vouch-gated non-secret
// metadata edit/delete, and proxy use. Secret rotation remains re-store only.

import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../api-client.js";
import { storeCredentialTool } from "../store-credential.js";
import { useCredentialTool } from "../use-credential.js";
import { deleteCredentialTool, editCredentialTool } from "../credential-mutations.js";

// Credential-shaped test fixtures are assembled at runtime from harmless
// fragments so no complete vendor-prefixed token literal appears in this
// source file (GitHub secret scanning false-positived on test data in
// commit 0b3b160f). The returned values are byte-identical to the old
// literals; do NOT inline these back into single string literals.
const akia = (body: string): string => "AK" + "IA" + body;
const sk = (body: string): string => "sk" + "-" + body;

function mockApi(over: Partial<ApiClient>): ApiClient {
  return over as ApiClient;
}

describe("store_credential (upsert)", () => {
  it("stores a single value and returns reference + field_names + updated", async () => {
    const api = mockApi({
      storeCredential: async (input) => {
        expect(input.service).toBe("OpenAI");
        expect(input.value).toBe(sk("x"));
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
    const res = await storeCredentialTool.handler({ service: "OpenAI", value: sk("x") }, api);
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
        fields: { access_key_id: akia(""), secret_access_key: "shh" },
      },
      api,
    );
    expect(seen).toMatchObject({
      service: "AWS",
      label: "prod",
      fields: { access_key_id: akia("") },
    });
  });

  it("surfaces the API's duplicate hint without altering the save result", async () => {
    const api = mockApi({
      storeCredential: async () => ({
        reference: "vault://a/b/new",
        service: "Beeline agents",
        label: "default",
        field_names: ["value"],
        auth_strategy: null,
        signin_url: null,
        login_hosts: [],
        allowed_hosts: [],
        created_at: "x",
        updated: false,
        duplicate_of: [{ service: "Openrouter", label: "default", reference: "vault://a/b/old" }],
        hint: "Use the existing credential for grants.",
      }),
    });
    const result = await storeCredentialTool.handler(
      { service: "Beeline agents", value: "shared-test-value" },
      api,
    );
    expect(result).toMatchObject({
      reference: "vault://a/b/new",
      updated: false,
      duplicate_of: [{ reference: "vault://a/b/old" }],
      hint: "Use the existing credential for grants.",
    });
    expect(JSON.stringify(result)).not.toContain("shared-test-value");
  });

  it("passes canonical api_hosts to the vault allowlist input", async () => {
    const storeCredential = vi.fn().mockResolvedValue({ reference: "vault://fixture" });
    const args = storeCredentialTool.inputSchema.parse({
      service: "Resend",
      value: "synthetic",
      api_hosts: ["api.resend.com", "api.resend.com"],
    });
    await storeCredentialTool.handler(args, mockApi({ storeCredential }));
    expect(storeCredential).toHaveBeenCalledWith(
      expect.objectContaining({ observed_hosts: ["api.resend.com"] }),
    );
  });

  it("schema requires value or fields", () => {
    expect(storeCredentialTool.inputSchema.safeParse({ service: "X" }).success).toBe(false);
  });

  it("normalizes labels with the same semantics as edit_credential", () => {
    const stored = storeCredentialTool.inputSchema.safeParse({
      service: "OpenAI",
      label: "  production  ",
      value: sk("x"),
    });
    const edited = editCredentialTool.inputSchema.safeParse({
      action: "start",
      reference: "vault://a/b/c",
      changes: { label: "  production  " },
    });
    expect(stored.success && stored.data.label).toBe("production");
    expect(edited.success && edited.data.changes.label).toBe("production");
    expect(
      storeCredentialTool.inputSchema.safeParse({ service: "OpenAI", label: "   ", value: "x" })
        .success,
    ).toBe(false);
    expect(
      editCredentialTool.inputSchema.safeParse({
        action: "start",
        reference: "vault://a/b/c",
        changes: { label: "   " },
      }).success,
    ).toBe(false);
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
        action: "start",
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
    expect(JSON.stringify(pending)).not.toContain(sk("secret"));

    await expect(
      editCredentialTool.handler({ action: "resume", approval_id: "mutation_1" }, api),
    ).resolves.toMatchObject({
      status: "credential_updated",
      approval_id: "mutation_1",
    });
  });

  it("rejects secret/immutable edit fields in the schema", () => {
    expect(
      editCredentialTool.inputSchema.safeParse({
        action: "start",
        reference: "vault://a/b/c",
        changes: { value: sk("secret") },
      }).success,
    ).toBe(false);
    expect(
      editCredentialTool.inputSchema.safeParse({
        action: "start",
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
      deleteCredentialTool.handler({ action: "start", reference: "vault://a/b/c" }, api),
    ).resolves.toMatchObject({
      status: "approval_pending",
      operation: "delete",
    });
    await expect(
      deleteCredentialTool.handler({ action: "resume", approval_id: "mutation_1" }, api),
    ).resolves.toMatchObject({
      status: "credential_deleted",
      approval_id: "mutation_1",
    });
  });

  it("does not accept an edit approval as delete authority", async () => {
    const api = mockApi({ getCredentialMutationApproval: async () => BASE_MUTATION });
    await expect(
      deleteCredentialTool.handler({ action: "resume", approval_id: "mutation_1" }, api),
    ).resolves.toEqual({
      status: "approval_intent_mismatch",
      error: "approval_operation_mismatch",
      expected_operation: "delete",
      actual_operation: "edit",
    });
  });
});

const schema = (name: string) => findTool(name)!.inputSchema;
const reference = "vault://fixture/amazon";

describe("flat operation grammar", () => {
  it.each(["fetch_credential", "edit_credential", "delete_credential", "edit_payment_card"])(
    "%s keeps start/resume exclusive and strict",
    (name) => {
      const input = schema(name);
      const start =
        name === "edit_payment_card"
          ? { card_id: "card" }
          : { reference, ...(name === "edit_credential" ? { changes: { label: "renamed" } } : {}) };
      expect(input.safeParse({ action: "start", ...start }).success).toBe(true);
      const resume = input.parse({ action: "resume", approval_id: "approval" });
      // Both stdio and broker parse the same input: action must survive parsing.
      expect(input.parse(resume)).toEqual(resume);
      for (const bad of [
        {},
        start,
        { action: "resume" },
        { action: "resume", approval_id: "approval", ...start },
        { action: "start", ...start, approval_id: "approval" },
        { action: "start", ...start, value: "immutable" },
      ])
        expect(input.safeParse(bad).success).toBe(false);
    },
  );

  it("requires each login action's own fields and keeps defaults and unknown-field stripping", () => {
    const input = schema("operate_login");
    for (const args of [
      { action: "oauth", provider: "google", ref: "e1" },
      { action: "prepare_signup" },
      { action: "store_signup", service: "amazon", login_hosts: ["amazon.com"] },
      { action: "load_saved", reference },
      { action: "load_saved", service: "amazon" },
    ]) {
      const parsed = input.parse({ session_id: "fixture", ...args });
      expect(input.parse(parsed)).toEqual(parsed);
    }
    expect(
      input.parse({
        session_id: "fixture",
        action: "prepare_signup",
        provider: 123,
        unknown: true,
      }),
    ).toEqual({ session_id: "fixture", action: "prepare_signup" });
    for (const args of [
      {},
      { provider: "google", ref: "e1" },
      { action: "oauth", provider: "google" },
      { action: "store_signup", service: "amazon" },
      { action: "store_signup", service: "amazon", login_hosts: [] },
      { action: "prepare_signup", password_length: 10 },
    ])
      expect(input.safeParse({ session_id: "fixture", ...args }).success).toBe(false);
    expect(input.parse({ session_id: "fixture", action: "load_saved", reference })).toMatchObject({
      fields: ["login", "password"],
      slot_prefix: "vault",
    });
  });

  it("preserves strict unknown behavior even across variant fields", () => {
    const input = flatVariants({
      start: z.object({ reference: z.string() }).strict(),
      resume: z.object({ approval_id: z.string() }).strict(),
    });
    expect(input.safeParse({ action: "start", reference, approval_id: "other" }).success).toBe(
      false,
    );
  });
});
