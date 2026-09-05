import { z } from "zod";
import { assertApi, type Tool } from "./index.js";
import { ApiCallError } from "../api-client.js";
import { ALWAYS_LOAD_META } from "./always-load.js";
import { egressTargetSchema, executeEgressTarget } from "./egress-targets.js";

// Direct, single-call proxy. The agent names a credential (by reference
// or service) and the HTTP request; the server injects the secret and
// returns only the upstream response. No request_id / approval dance —
// the vault is a write-only sink (the secret never returns to the agent,
// and the proxy hard-enforces the credential's host allowlist), which is
// what makes per-call approval unnecessary.
// `target` is the deploy half: instead of CALLING an API with the secret, put
// the secret where something else will use it. Same write-only property — the
// value is sealed to this process, acted on, and never returned. The shape
// itself is owned by egress-targets.ts, which executes it.
const inputSchema = z
  .object({
    reference: z.string().min(1).optional(),
    service: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    // Which vault field to send, when the credential has more than one.
    field: z.string().min(1).max(120).optional(),
    http: z
      .object({
        method: z.string().min(1).max(10),
        url: z.string().min(1).max(2048),
        headers: z.record(z.string()).optional(),
        body: z
          .string()
          .max(64 * 1024)
          .optional(),
        query: z.record(z.string()).optional(),
      })
      .optional(),
    target: egressTargetSchema.optional(),
  })
  .refine((b) => b.reference !== undefined || b.service !== undefined || b.name !== undefined, {
    message: "one of reference, service, or name is required",
  })
  .refine((b) => (b.http !== undefined) !== (b.target !== undefined), {
    message: "pass exactly one of http (call an API with the secret) or target (deploy the secret)",
  });

const DESCRIPTION = `Do something with a vaulted credential without ever seeing its value.
Two modes; pass exactly one.

\`http\` — CALL an API with the credential. The server injects the secret and
returns only the upstream response. In your headers/body use \${SECRET} for a
single-field credential, or \${SECRET.<field>} for a multi-field one (e.g.
\${SECRET.access_key_id}, \${SECRET.secret_access_key}); \${SECRET_JSON[.field]}
JSON-escapes. For APIs that authenticate via a query-string key (e.g. FRED's
\`api_key\`), put the secret in \`query\` — \`query: { api_key: "\${SECRET}" }\` —
NOT in the url (a \${SECRET} in the url is rejected; the server injects query
params after the host check so the key never lands in a log).

\`target\` — DEPLOY the credential: put it where something else will use it.
This is the shortest path from "key you just vaulted" to "key in production",
and it is how you finish a provisioning task. Kinds:
  • \`{kind:"github_repo_secret", owner, repo, name, environment?}\` — set a
    GitHub Actions secret. Uses your local \`gh auth token\`, else GITHUB_TOKEN.
    Requires \`api.github.com\` on the credential's allowed_hosts.
  • \`{kind:"dotenv_write", path, name}\` — write \`NAME="…"\` into a .env file
    under the project root (0600, atomic, other lines preserved byte for byte).
    Requires the literal marker \`local-file\` on the credential's allowed_hosts:
    .env egress is authorised the same way a network destination is, so add it
    with edit_credential first if it is missing.
The value is sealed to this MCP process, written to the destination, and never
returned to you: you get {ok:true,…} or {written:true,…}.

Name the credential with \`service\` or \`reference\` (call list_credentials to
resolve one), and \`field\` when the credential has several fields. The
destination host must be on the credential's allowed_hosts (editable with
edit_credential after a signed vouch, or in the web vault) or the call is
rejected. There is no raw-value extraction path.`;

export const useCredentialTool: Tool<z.infer<typeof inputSchema>> = {
  name: "use_credential",
  description: DESCRIPTION,
  inputSchema,
  jsonInputSchema: {
    type: "object",
    oneOf: [{ required: ["http"] }, { required: ["target"] }],
    properties: {
      reference: { type: "string" },
      service: { type: "string" },
      name: { type: "string" },
      field: { type: "string" },
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
      target: {
        type: "object",
        oneOf: [
          {
            required: ["kind", "owner", "repo", "name"],
            properties: {
              kind: { const: "github_repo_secret" },
              owner: { type: "string" },
              repo: { type: "string" },
              name: { type: "string" },
              environment: { type: "string" },
            },
          },
          {
            required: ["kind", "path", "name"],
            properties: {
              kind: { const: "dotenv_write" },
              path: { type: "string" },
              name: { type: "string" },
            },
          },
        ],
      },
    },
  },
  annotations: { destructiveHint: true },
  meta: ALWAYS_LOAD_META,
  async handler(args, api) {
    assertApi(api);
    const selector = {
      ...(args.reference !== undefined ? { reference: args.reference } : {}),
      ...(args.service !== undefined ? { service: args.service } : {}),
      ...(args.name !== undefined ? { name: args.name } : {}),
    };
    if (args.target !== undefined) {
      return await executeEgressTarget(api, {
        selector,
        ...(args.field !== undefined ? { field: args.field } : {}),
        target: args.target,
      });
    }
    const http = {
      method: args.http!.method,
      url: args.http!.url,
      ...(args.http!.headers !== undefined ? { headers: args.http!.headers } : {}),
      ...(args.http!.body !== undefined ? { body: args.http!.body } : {}),
      ...(args.http!.query !== undefined ? { query: args.http!.query } : {}),
    };
    try {
      const res = await api.useCredential({ ...selector, http });
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
