import { z } from "zod";
import { assertApi, type Tool } from "./index.js";
import { ALWAYS_LOAD_META } from "./always-load.js";

// use_credential can target a freshly-minted request (request_id) OR
// ask the broker to mint one inline from a service/reference. v1
// requires an already-created request_id: the agent calls
// request_credential(intent="proxy") first (auto-approved for trusted
// sessions), then use_credential with the returned request_id.
const inputSchema = z.object({
  request_id: z.string().min(1),
  http: z.object({
    method: z.string().min(1).max(10),
    url: z.string().min(1).max(2048),
    headers: z.record(z.string()).optional(),
    body: z.string().max(64 * 1024).optional(),
  }),
});

const DESCRIPTION = `Execute an authenticated HTTP request against an external API using a
vaulted credential. The secret value never crosses to this agent — the
server injects it server-side via \${SECRET} or \${SECRET_JSON} placeholders
in your headers/body. Pass \`service\` or \`reference\` plus the standard
HTTP fields (method, url, headers, body). PREFER THIS over
request_credential whenever the user wants an API call; only fall back
if you need the raw secret to write into a local file.`;

export const useCredentialTool: Tool<z.infer<typeof inputSchema>> = {
  name: "use_credential",
  description: DESCRIPTION,
  inputSchema,
  jsonInputSchema: {
    type: "object",
    required: ["request_id", "http"],
    properties: {
      request_id: { type: "string" },
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
    // Rebuild without undefined-valued optionals (exactOptionalPropertyTypes).
    const http = {
      method: args.http.method,
      url: args.http.url,
      ...(args.http.headers !== undefined ? { headers: args.http.headers } : {}),
      ...(args.http.body !== undefined ? { body: args.http.body } : {}),
    };
    const res = await api.useCredentialProxy(args.request_id, http);
    return { response: res.response };
  },
};
