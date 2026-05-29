import { z } from "zod";
import { assertApi, type Tool } from "./index.js";

const inputSchema = z
  .object({
    reference: z.string().min(1).optional(),
    service: z.string().min(1).optional(),
    purpose: z.string().min(1).max(400),
    intent: z.enum(["value", "proxy"]),
    proxy_target_host: z.string().min(1).optional(),
    reason_proxy_not_possible: z.string().min(1).optional(),
    mode_requested: z.enum(["once", "session", "persistent"]).optional(),
    ttl_requested: z.number().int().positive().optional(),
  })
  .refine((b) => b.reference !== undefined || b.service !== undefined, {
    message: "one of reference or service is required",
  })
  .refine((b) => b.intent !== "value" || b.reason_proxy_not_possible !== undefined, {
    message: "reason_proxy_not_possible is required when intent=value",
  });

const DESCRIPTION = `Return the raw plaintext secret to this agent. The secret will be
VISIBLE in the conversation context after this call. Use ONLY when the
user explicitly needs the value (writing a .env file, pasting into a
config UI) — for HTTP API calls always prefer use_credential, which
keeps the secret server-side. Requires the user to approve in the
Trusty Squire web UI; you must poll_credential_access for the result.
Must include a \`reason_proxy_not_possible\` explaining why use_credential
doesn't fit.`;

export const requestCredentialTool: Tool<z.infer<typeof inputSchema>> = {
  name: "request_credential",
  description: DESCRIPTION,
  inputSchema,
  jsonInputSchema: {
    type: "object",
    required: ["purpose", "intent"],
    properties: {
      reference: { type: "string" },
      service: { type: "string" },
      purpose: { type: "string", maxLength: 400 },
      intent: { type: "string", enum: ["value", "proxy"] },
      proxy_target_host: { type: "string" },
      reason_proxy_not_possible: { type: "string" },
      mode_requested: { type: "string", enum: ["once", "session", "persistent"] },
      ttl_requested: { type: "number" },
    },
  },
  annotations: { destructiveHint: true },
  async handler(args, api) {
    assertApi(api);
    const res = await api.requestCredentialAccess({
      ...(args.reference !== undefined ? { reference: args.reference } : {}),
      ...(args.service !== undefined ? { service: args.service } : {}),
      purpose: args.purpose,
      intent: args.intent,
      ...(args.proxy_target_host !== undefined ? { proxy_target_host: args.proxy_target_host } : {}),
      ...(args.reason_proxy_not_possible !== undefined
        ? { reason_proxy_not_possible: args.reason_proxy_not_possible }
        : {}),
      ...(args.mode_requested !== undefined ? { mode_requested: args.mode_requested } : {}),
      ...(args.ttl_requested !== undefined ? { ttl_requested: args.ttl_requested } : {}),
    });
    return {
      request_id: res.request_id,
      status: res.status,
      expires_at: res.expires_at,
      auto_approved: res.auto_approved,
    };
  },
};
