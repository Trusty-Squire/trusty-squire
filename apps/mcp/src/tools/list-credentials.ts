import { z } from "zod";
import { assertApi, type Tool } from "./index.js";

const inputSchema = z.object({
  // Case-insensitive exact match on the credential's service field.
  // A string matches one service; an array matches any of them.
  service: z
    .union([z.string(), z.array(z.string()).min(1)])
    .optional()
    .describe(
      'Filter by service (case-insensitive exact match), e.g. "exa" or ["groq", "cartesia"]',
    ),
  // Compact projection for provisioning checks: enough to decide reuse
  // (reference, service, label, field names, hosts, age, staleness)
  // without the full metadata payload.
  fields: z
    .literal("summary")
    .optional()
    .describe('"summary" returns a compact projection per credential'),
});

const DESCRIPTION = `List the credentials already stored in the user's vault for this account.

WHEN TO CALL THIS TOOL:
- BEFORE provisioning a service — check whether the account already has
  a usable key for it, so you reuse the existing key instead of signing
  up for a duplicate
- At the start of a task, to see what API keys are already available
- Whenever you need a service's key and aren't sure it exists yet

BEHAVIOR:
- Returns metadata only — service, key name, type, age, and a vault
  \`reference\` — never the secret values themselves
- The raw secret is never returned to you; to *use* a key, call
  use_credential with its \`reference\` (the server injects it)
- Scoped to the user's account; only this account's credentials list

FILTERS (all optional — with no filter the full metadata list is returned):
- \`service\`: case-insensitive exact match on the service field;
  pass a string for one service or an array to match any of several
- \`fields: "summary"\`: return only a compact projection per credential —
  reference, service, label, field_names, allowed_hosts, created_at,
  stale — instead of the full metadata object

When checking whether a key exists for a specific service (e.g. before
provisioning), pass \`service\` (and \`fields: "summary"\`) so the answer
stays small instead of pulling the whole vault inventory into context.`;

export const listCredentialsTool: Tool<z.infer<typeof inputSchema>> = {
  name: "list_credentials",
  description: DESCRIPTION,
  inputSchema,
  jsonInputSchema: {
    type: "object",
    properties: {
      service: {
        description: "Filter by service (case-insensitive exact match); string or array of strings",
        oneOf: [{ type: "string" }, { type: "array", items: { type: "string" }, minItems: 1 }],
      },
      fields: {
        type: "string",
        enum: ["summary"],
        description:
          '"summary" returns a compact projection: reference, service, label, field_names, allowed_hosts, created_at, stale',
      },
    },
  },
  async handler(args, api) {
    assertApi(api);
    const res = await api.listCredentials();
    const { service, fields } = args;
    const services =
      service === undefined ? undefined : Array.isArray(service) ? service : [service];
    const needle = (s: string) => s.trim().toLowerCase();
    const filtered = res.credentials.filter((c) => {
      if (services !== undefined) {
        if (c.service === null) return false;
        if (!services.some((s) => needle(s) === needle(c.service as string))) return false;
      }
      return true;
    });
    if (fields === "summary") {
      return {
        credentials: filtered.map((c) => ({
          reference: c.reference,
          service: c.service,
          label: c.label,
          field_names: c.field_names,
          allowed_hosts: c.allowed_hosts,
          created_at: c.created_at,
          stale: c.stale === true,
        })),
      };
    }
    return { credentials: filtered };
  },
};
