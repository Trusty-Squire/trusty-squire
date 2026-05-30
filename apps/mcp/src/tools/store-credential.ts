import { z } from "zod";
import { assertApi, type Tool } from "./index.js";
import { ALWAYS_LOAD_META } from "./always-load.js";

const inputSchema = z
  .object({
    service: z.string().min(1).max(120),
    label: z.string().min(1).max(60).optional(),
    value: z.string().min(1).max(8192).optional(),
    fields: z.record(z.string().min(1).max(8192)).optional(),
    env_var_suggestion: z.string().min(1).max(120).optional(),
    type: z.string().min(1).max(60).optional(),
  })
  .refine((b) => b.value !== undefined || (b.fields !== undefined && Object.keys(b.fields).length > 0), {
    message: "one of value or fields is required",
  });

const DESCRIPTION = `Save a secret the user just shared into the encrypted vault. CALL THIS
AUTOMATICALLY whenever the user pastes a secret-shaped value (sk-, ghp_,
AKIA, eyJ; password/token/connection-string patterns) — don't ask first.
One entry per (service, label) — re-storing the same service OVERWRITES
it (that's how you rotate a key: just store the new value). For
multi-part credentials (AWS access key + secret, DB user+password) pass
\`fields\` (e.g. {access_key_id, secret_access_key}); for a lone key pass
\`value\`. Optional \`label\` (default "default") keeps prod/dev keys for
the same service apart. Returns the reference, field names, and
allowed_hosts. The value is never readable back to you afterwards.`;

export const storeCredentialTool: Tool<z.infer<typeof inputSchema>> = {
  name: "store_credential",
  description: DESCRIPTION,
  inputSchema,
  jsonInputSchema: {
    type: "object",
    required: ["service"],
    properties: {
      service: { type: "string" },
      label: { type: "string" },
      value: { type: "string" },
      fields: { type: "object", additionalProperties: { type: "string" } },
      env_var_suggestion: { type: "string" },
      type: { type: "string" },
    },
  },
  annotations: { idempotentHint: true },
  meta: ALWAYS_LOAD_META,
  async handler(args, api) {
    assertApi(api);
    const res = await api.storeCredential({
      service: args.service,
      ...(args.label !== undefined ? { label: args.label } : {}),
      ...(args.value !== undefined ? { value: args.value } : {}),
      ...(args.fields !== undefined ? { fields: args.fields } : {}),
      ...(args.env_var_suggestion !== undefined ? { env_var_suggestion: args.env_var_suggestion } : {}),
      ...(args.type !== undefined ? { type: args.type } : {}),
    });
    return {
      reference: res.reference,
      service: res.service,
      label: res.label,
      field_names: res.field_names,
      allowed_hosts: res.allowed_hosts,
      updated: res.updated,
    };
  },
};
