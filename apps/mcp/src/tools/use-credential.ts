import { z } from "zod";
import { assertApi, type Tool } from "./index.js";
import { ALWAYS_LOAD_META } from "./always-load.js";

// Direct, single-call proxy. The agent names a credential (by reference
// or service) and the HTTP request; the server injects the secret and
// returns only the upstream response. No request_id / approval dance —
// the vault is a write-only sink (the secret never returns to the agent,
// and the proxy hard-enforces the credential's host allowlist), which is
// what makes per-call approval unnecessary.
const inputSchema = z
  .object({
    reference: z.string().min(1).optional(),
    service: z.string().min(1).optional(),
    http: z.object({
      method: z.string().min(1).max(10),
      url: z.string().min(1).max(2048),
      headers: z.record(z.string()).optional(),
      body: z.string().max(64 * 1024).optional(),
    }),
  })
  .refine((b) => b.reference !== undefined || b.service !== undefined, {
    message: "one of reference or service is required",
  });

const DESCRIPTION = `Execute an authenticated HTTP request against an external API using a
vaulted credential. The secret value NEVER crosses to this agent — the
server injects it via \${SECRET} or \${SECRET_JSON} placeholders in your
headers/body and returns only the upstream response. Pass \`service\` or
\`reference\` plus the standard HTTP fields (method, url, headers, body).
This is the ONLY way to use a stored secret: there is no raw-value
extraction. The target host must be on the credential's allowed_hosts
(editable in the Trusty Squire web vault) or the call is rejected.`;

export const useCredentialTool: Tool<z.infer<typeof inputSchema>> = {
  name: "use_credential",
  description: DESCRIPTION,
  inputSchema,
  jsonInputSchema: {
    type: "object",
    required: ["http"],
    properties: {
      reference: { type: "string" },
      service: { type: "string" },
      http: {
        type: "object",
        required: ["method", "url"],
        properties: {
          method: { type: "string" },
          url: { type: "string" },
          headers: { type: "object", additionalProperties: { type: "string" } },
          body: { type: "string" },
        },
      },
    },
  },
  annotations: { destructiveHint: true },
  meta: ALWAYS_LOAD_META,
  async handler(args, api) {
    assertApi(api);
    const http = {
      method: args.http.method,
      url: args.http.url,
      ...(args.http.headers !== undefined ? { headers: args.http.headers } : {}),
      ...(args.http.body !== undefined ? { body: args.http.body } : {}),
    };
    const res = await api.useCredential({
      ...(args.reference !== undefined ? { reference: args.reference } : {}),
      ...(args.service !== undefined ? { service: args.service } : {}),
      http,
    });
    return { response: res.response };
  },
};
