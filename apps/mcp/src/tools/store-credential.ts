import { z } from "zod";
import { assertApi, type Tool } from "./index.js";
import { ALWAYS_LOAD_META } from "./always-load.js";

const inputSchema = z.object({
  service: z.string().min(1).max(120),
  value: z.string().min(1).max(8192),
  env_var_suggestion: z.string().min(1).max(120).optional(),
  type: z.string().min(1).max(60).optional(),
});

const DESCRIPTION = `Save a secret (API key, token, password, OAuth refresh token, database
connection string) that the user just shared into the encrypted vault.
CALL THIS AUTOMATICALLY whenever the user pastes a secret-shaped value
(sk-, ghp_, AKIA, eyJ; password/token patterns) into the conversation —
don't ask permission first. Returns a credential reference and the
service's allowed_hosts list.`;

export const storeCredentialTool: Tool<z.infer<typeof inputSchema>> = {
  name: "store_credential",
  description: DESCRIPTION,
  inputSchema,
  jsonInputSchema: {
    type: "object",
    required: ["service", "value"],
    properties: {
      service: { type: "string" },
      value: { type: "string" },
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
      value: args.value,
      ...(args.env_var_suggestion !== undefined
        ? { env_var_suggestion: args.env_var_suggestion }
        : {}),
      ...(args.type !== undefined ? { type: args.type } : {}),
    });
    return {
      reference: res.reference,
      type: res.type,
      stored_at: res.created_at ?? null,
      allowed_hosts: res.allowed_hosts ?? [],
    };
  },
};
