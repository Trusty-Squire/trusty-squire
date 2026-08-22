import { z } from "zod";
import type { CredentialMutationApproval } from "../api-client.js";
import { ALWAYS_LOAD_META } from "./always-load.js";
import { assertApi, type Tool } from "./index.js";

const selector = {
  reference: z.string().min(1).max(400).optional(),
  service: z.string().min(1).max(120).optional(),
  name: z.string().min(1).max(60).optional(),
};

const allowedHostEdit = z
  .object({
    mode: z.enum(["add", "remove", "replace"]),
    hosts: z.array(z.string().min(1).max(256)).max(50),
  })
  .strict();

const loginHostEdit = z
  .object({
    mode: z.enum(["add", "remove", "replace"]),
    hosts: z.array(z.string().min(1).max(253)).max(20),
  })
  .strict();

const changes = z
  .object({
    label: z.string().trim().min(1).max(60).optional(),
    allowed_hosts: allowedHostEdit.optional(),
    login_hosts: loginHostEdit.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "at least one editable metadata field is required",
  });

const editStart = z
  .object({ ...selector, changes })
  .strict()
  .refine(
    (value) =>
      value.reference !== undefined || value.service !== undefined || value.name !== undefined,
    { message: "one of reference, service, or name is required" },
  );
const editResume = z.object({ approval_id: z.string().min(1).max(64) }).strict();
const editInput = z.union([editStart, editResume]);

const deleteStart = z
  .object(selector)
  .strict()
  .refine(
    (value) =>
      value.reference !== undefined || value.service !== undefined || value.name !== undefined,
    { message: "one of reference, service, or name is required" },
  );
const deleteResume = z.object({ approval_id: z.string().min(1).max(64) }).strict();
const deleteInput = z.union([deleteStart, deleteResume]);

function toolResult(
  tool: "edit_credential" | "delete_credential",
  expectedOperation: "edit" | "delete",
  approval: CredentialMutationApproval,
): Record<string, unknown> {
  if (approval.operation !== expectedOperation) {
    return {
      status: "approval_intent_mismatch",
      error: "approval_operation_mismatch",
      expected_operation: expectedOperation,
      actual_operation: approval.operation,
    };
  }
  if (approval.status === "approved") {
    return {
      status: expectedOperation === "edit" ? "credential_updated" : "credential_deleted",
      operation: expectedOperation,
      credential: approval.credential,
      before: approval.before,
      after: approval.after,
      approval_id: approval.approval_id,
    };
  }
  if (approval.status === "expired" || approval.status === "failed") {
    return {
      status: "credential_mutation_refused",
      operation: expectedOperation,
      reason: approval.error ?? `approval_${approval.status}`,
      approval_id: approval.approval_id,
      credential: approval.credential,
    };
  }
  return {
    status: "approval_pending",
    operation: expectedOperation,
    approval_id: approval.approval_id,
    approval_url: approval.approval_url,
    expires_at: approval.expires_at,
    credential: approval.credential,
    before: approval.before,
    after: approval.after,
    next: { tool, approval_id: approval.approval_id },
  };
}

const EDIT_DESCRIPTION = `Edit only non-secret metadata on a credential after the user approves
the exact before→after change from the Telegram/passkey vouch link. Use
allowed_hosts or login_hosts with mode add/remove/replace; label renames are
also supported. Pass an exact vault reference, a service, or a saved credential
name (combine service+name to disambiguate). The first call returns
approval_pending and an approval_id. After the user approves, call
edit_credential again with ONLY that approval_id. Unknown and immutable fields
are rejected. This tool can never read or alter the stored secret value; rotate
a secret only by calling store_credential with the new value.`;

export const editCredentialTool: Tool<z.infer<typeof editInput>> = {
  name: "edit_credential",
  description: EDIT_DESCRIPTION,
  inputSchema: editInput,
  jsonInputSchema: {
    type: "object",
    oneOf: [
      {
        type: "object",
        required: ["changes"],
        properties: {
          reference: { type: "string" },
          service: { type: "string" },
          name: { type: "string" },
          changes: {
            type: "object",
            properties: {
              label: { type: "string" },
              allowed_hosts: { $ref: "#/$defs/allowedHostEdit" },
              login_hosts: { $ref: "#/$defs/loginHostEdit" },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
      {
        type: "object",
        required: ["approval_id"],
        properties: { approval_id: { type: "string" } },
        additionalProperties: false,
      },
    ],
    $defs: {
      allowedHostEdit: {
        type: "object",
        required: ["mode", "hosts"],
        properties: {
          mode: { type: "string", enum: ["add", "remove", "replace"] },
          hosts: { type: "array", maxItems: 50, items: { type: "string", maxLength: 256 } },
        },
        additionalProperties: false,
      },
      loginHostEdit: {
        type: "object",
        required: ["mode", "hosts"],
        properties: {
          mode: { type: "string", enum: ["add", "remove", "replace"] },
          hosts: { type: "array", maxItems: 20, items: { type: "string", maxLength: 253 } },
        },
        additionalProperties: false,
      },
    },
  },
  annotations: { destructiveHint: true, idempotentHint: true },
  meta: ALWAYS_LOAD_META,
  async handler(args, api) {
    assertApi(api);
    const approval =
      "approval_id" in args
        ? await api.getCredentialMutationApproval(args.approval_id)
        : await api.createCredentialMutationApproval({
            operation: "edit",
            ...(args.reference !== undefined ? { reference: args.reference } : {}),
            ...(args.service !== undefined ? { service: args.service } : {}),
            ...(args.name !== undefined ? { name: args.name } : {}),
            changes: {
              ...(args.changes.label !== undefined ? { label: args.changes.label } : {}),
              ...(args.changes.allowed_hosts !== undefined
                ? { allowed_hosts: args.changes.allowed_hosts }
                : {}),
              ...(args.changes.login_hosts !== undefined
                ? { login_hosts: args.changes.login_hosts }
                : {}),
            },
          });
    return toolResult("edit_credential", "edit", approval);
  },
};

const DELETE_DESCRIPTION = `Soft-delete a vaulted credential only after the user approves the exact
destructive action from the Telegram/passkey vouch link. Pass an exact vault
reference, service, or saved credential name (combine service+name to
disambiguate). The first call returns approval_pending and an approval_id.
After the user approves, call delete_credential again with ONLY that
approval_id. Retrying an approved approval_id is idempotent. No unsigned,
expired, mismatched, ambiguous, or unknown request deletes anything.`;

export const deleteCredentialTool: Tool<z.infer<typeof deleteInput>> = {
  name: "delete_credential",
  description: DELETE_DESCRIPTION,
  inputSchema: deleteInput,
  jsonInputSchema: {
    type: "object",
    oneOf: [
      {
        type: "object",
        properties: {
          reference: { type: "string" },
          service: { type: "string" },
          name: { type: "string" },
        },
        additionalProperties: false,
      },
      {
        type: "object",
        required: ["approval_id"],
        properties: { approval_id: { type: "string" } },
        additionalProperties: false,
      },
    ],
  },
  annotations: { destructiveHint: true, idempotentHint: true },
  meta: ALWAYS_LOAD_META,
  async handler(args, api) {
    assertApi(api);
    const approval =
      "approval_id" in args
        ? await api.getCredentialMutationApproval(args.approval_id)
        : await api.createCredentialMutationApproval({
            operation: "delete",
            ...(args.reference !== undefined ? { reference: args.reference } : {}),
            ...(args.service !== undefined ? { service: args.service } : {}),
            ...(args.name !== undefined ? { name: args.name } : {}),
          });
    return toolResult("delete_credential", "delete", approval);
  },
};
