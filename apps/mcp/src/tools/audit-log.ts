import { z } from "zod";
import { assertApi, type Tool } from "./index.js";
import { ALWAYS_LOAD_META } from "./always-load.js";

// The who-touched-my-keys ledger. Every vault action — stored / retrieved /
// rotated / deleted / proxy_executed / proxy_rejected — newest first, keyset-
// paginated by the `before` cursor. Payloads carry NO secret values; this is
// strictly less than what list_credentials already exposes, so the account's
// own agent can read it (same account boundary as the human's web UI).
const inputSchema = z.object({
  limit: z.number().int().min(1).max(200).optional(),
  before: z.string().min(1).optional(),
  type: z.string().min(1).optional(),
  reference: z.string().min(1).optional(),
});

const DESCRIPTION = `Read the vault audit ledger — "show me everything that touched my keys."
Returns account-scoped events newest-first: stored / retrieved / rotated /
deleted / proxy_executed / proxy_rejected, each with a timestamp, the credential
reference, requester, and outcome. NO secret values are ever included.

Filter with \`type\` (an event kind) or \`reference\` (a single credential), cap with
\`limit\` (default 50, max 200), and page older with \`before\` (pass the prior
response's \`next_before\` cursor; null means no more pages). Use this to answer
"what used my Stripe key in the last N days" or to investigate a suspected leak.`;

export const auditLogTool: Tool<z.infer<typeof inputSchema>> = {
  name: "audit_log",
  description: DESCRIPTION,
  inputSchema,
  jsonInputSchema: {
    type: "object",
    properties: {
      limit: { type: "number" },
      before: { type: "string" },
      type: { type: "string" },
      reference: { type: "string" },
    },
  },
  annotations: { readOnlyHint: true },
  meta: ALWAYS_LOAD_META,
  async handler(args, api) {
    assertApi(api);
    return api.listAudit({
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
      ...(args.before !== undefined ? { before: args.before } : {}),
      ...(args.type !== undefined ? { type: args.type } : {}),
      ...(args.reference !== undefined ? { reference: args.reference } : {}),
    });
  },
};
