import { z } from "zod";
import { ApiCallError, type CredentialFetchApproval } from "../api-client.js";
import { ALWAYS_LOAD_META } from "./always-load.js";
import { assertApi, type Tool } from "./index.js";

const start = z
  .object({
    reference: z.string().min(1).max(400).optional(),
    service: z.string().min(1).max(120).optional(),
    name: z.string().min(1).max(60).optional(),
    field: z.string().min(1).max(120).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.reference !== undefined || value.service !== undefined || value.name !== undefined,
    { message: "one of reference, service, or name is required" },
  );
const resume = z.object({ approval_id: z.string().min(1).max(64) }).strict();
const inputSchema = z.union([start, resume]);

// The description is the only thing standing between a model and a needless
// plaintext secret in its own transcript, so it leads with the cheaper route
// and states the cost of this one in the first two sentences.
const DESCRIPTION = `Return a vaulted credential's RAW value to you, in clear, after an explicit
human passkey approval. Use it ONLY when unavoidable: the value lands in your
context and therefore in the conversation transcript and any logs of it, which
no later step can undo.

Prefer \`use_credential\` whenever the task is "call an API with this key" — the
server injects the secret into the HTTP request and returns only the upstream
response, so the key never reaches you at all. Prefer an egress grant
(\`grant_app_access\`) when a deployed app needs standing access. Reach for
\`fetch_credential\` only when the raw key must physically land somewhere YOU
control and no server-side injection path exists — writing it into a
GitHub Actions secret, a .env file, or a config file. If you can accomplish
the task without the plaintext, do that instead.

Every fetch requires an explicit human passkey approval; there is no way to
skip it. The first call resolves the credential and returns approval_pending
with an approval_url — NO value. The user opens that link and signs with their
passkey. Then call fetch_credential again with ONLY that approval_id to receive
the value. Delivery is single-use: the same approval_id will not return the
value twice, so store it where it needs to go on first receipt. A denied or
expired approval returns a refusal and no value. Pass \`field\` to name one
field of a multi-field credential (required when the credential has more than
one — call list_credentials for its field names).`;

function refusal(reason: string, approval: CredentialFetchApproval): Record<string, unknown> {
  return {
    status: "credential_fetch_refused",
    reason,
    approval_id: approval.approval_id,
    credential: approval.credential,
    field: approval.field,
  };
}

function toolResult(approval: CredentialFetchApproval): Record<string, unknown> {
  if (approval.status === "consumed" && approval.fields !== undefined) {
    return {
      status: "credential_fetched",
      credential: approval.credential,
      field: approval.field,
      fields: approval.fields,
      approval_id: approval.approval_id,
      fetched_at: approval.fetched_at,
      reminder:
        "This value is now in your context. Write it only where the user asked, " +
        "and do not repeat it back in your reply.",
    };
  }
  if (approval.status === "pending") {
    return {
      status: "approval_pending",
      approval_id: approval.approval_id,
      approval_url: approval.approval_url,
      expires_at: approval.expires_at,
      credential: approval.credential,
      field: approval.field,
      field_names: approval.field_names,
      next: { tool: "fetch_credential", approval_id: approval.approval_id },
    };
  }
  return refusal(approval.error ?? `approval_${approval.status}`, approval);
}

// A refused fetch comes back as a non-2xx carrying the same approval shape.
// Rendering it as a typed refusal — rather than letting the HTTP error escape —
// is what tells the agent to stop instead of retrying the approval loop.
function refusalFromError(error: unknown): Record<string, unknown> | null {
  if (!(error instanceof ApiCallError)) return null;
  if (!error.code.startsWith("credential_fetch_")) return null;
  const body = error.body as Partial<CredentialFetchApproval> | undefined;
  return {
    status: "credential_fetch_refused",
    reason: error.code,
    ...(body?.approval_id !== undefined ? { approval_id: body.approval_id } : {}),
    ...(body?.credential !== undefined ? { credential: body.credential } : {}),
    ...(body?.field !== undefined ? { field: body.field } : {}),
  };
}

export const fetchCredentialTool: Tool<z.infer<typeof inputSchema>> = {
  name: "fetch_credential",
  description: DESCRIPTION,
  inputSchema,
  jsonInputSchema: {
    type: "object",
    oneOf: [
      {
        type: "object",
        properties: {
          reference: { type: "string" },
          service: { type: "string" },
          name: { type: "string" },
          field: { type: "string" },
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
  // Not read-only: a fetch discloses a secret and burns a single-use approval.
  annotations: { destructiveHint: true, idempotentHint: false },
  meta: ALWAYS_LOAD_META,
  async handler(args, api) {
    assertApi(api);
    try {
      const approval =
        "approval_id" in args
          ? await api.getCredentialFetchApproval(args.approval_id)
          : await api.createCredentialFetchApproval({
              ...(args.reference !== undefined ? { reference: args.reference } : {}),
              ...(args.service !== undefined ? { service: args.service } : {}),
              ...(args.name !== undefined ? { name: args.name } : {}),
              ...(args.field !== undefined ? { field: args.field } : {}),
            });
      return toolResult(approval);
    } catch (error) {
      const refused = refusalFromError(error);
      if (refused !== null) return refused;
      if (error instanceof ApiCallError && error.code === "ambiguous_credential_field") {
        const names = (error.body as { field_names?: unknown } | undefined)?.field_names;
        return {
          status: "credential_fetch_refused",
          reason: "ambiguous_credential_field",
          field_names: Array.isArray(names) ? names : [],
          remedy: "Retry fetch_credential with `field` set to one of field_names.",
        };
      }
      throw error;
    }
  },
};
