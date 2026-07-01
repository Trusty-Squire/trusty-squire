import { z } from "zod";
import { assertApi, type Tool } from "./index.js";
import { ApiCallError } from "../api-client.js";
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
      query: z.record(z.string()).optional(),
    }),
  })
  .refine((b) => b.reference !== undefined || b.service !== undefined, {
    message: "one of reference or service is required",
  });

const DESCRIPTION = `Execute an authenticated HTTP request against an external API using a
vaulted credential. The secret value NEVER crosses to this agent — the
server injects it and returns only the upstream response. In your
headers/body use \${SECRET} for a single-field credential, or
\${SECRET.<field>} for a multi-field one (e.g. \${SECRET.access_key_id},
\${SECRET.secret_access_key}); \${SECRET_JSON[.field]} JSON-escapes. Call
list_credentials to see a credential's field names. Pass \`service\` or
\`reference\` plus the HTTP fields (method, url, headers, body). This is
the ONLY way to use a stored secret — there is no raw-value extraction.
For APIs that authenticate via a query-string key (e.g. FRED's
\`api_key\`), put the secret in \`query\` — \`query: { api_key: "\${SECRET}" }\`
— NOT in the url (a \${SECRET} in the url is rejected; the server injects
query params after the host check so the key never lands in a log).
The target host must be on the credential's allowed_hosts (editable in
the web vault) or the call is rejected.`;

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
          query: { type: "object", additionalProperties: { type: "string" } },
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
      ...(args.http.query !== undefined ? { query: args.http.query } : {}),
    };
    try {
      const res = await api.useCredential({
        ...(args.reference !== undefined ? { reference: args.reference } : {}),
        ...(args.service !== undefined ? { service: args.service } : {}),
        http,
      });
      return { response: res.response };
    } catch (err) {
      // On an ambiguous service match the server returns the candidate
      // references, but the bare error message dropped them — surface them so
      // the agent retries with an exact `reference` instead of a blind
      // list_credentials round-trip.
      if (err instanceof ApiCallError && err.code === "ambiguous_service") {
        const raw = (err.body as { candidates?: unknown } | undefined)?.candidates;
        const candidates = Array.isArray(raw)
          ? raw.filter((c): c is string => typeof c === "string")
          : [];
        const list = candidates.length > 0 ? candidates.join(", ") : "(see list_credentials)";
        throw new Error(
          `Multiple stored credentials match service "${args.service ?? ""}". Retry ` +
            `use_credential with one of these exact "reference" values instead of ` +
            `"service": ${list}. Call list_credentials to see their labels if you need to choose.`,
        );
      }
      throw err;
    }
  },
};
