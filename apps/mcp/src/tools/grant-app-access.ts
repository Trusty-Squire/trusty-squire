import { z } from "zod";
import { assertApi, type Tool } from "./index.js";
import { ALWAYS_LOAD_META } from "./always-load.js";

// Egress Grants — mint a standing, revocable token so a DEPLOYED app (a server
// the agent provisioned, a loop runtime) can call a provider through Squire's
// injecting proxy. The raw vault key never leaves Squire; the app holds only a
// downgraded, rate-limited, revocable token. This is use_credential generalized
// from "the agent makes a call" to "a workload makes calls, forever."
const inputSchema = z
  .object({
    reference: z.string().min(1).optional(),
    service: z.string().min(1).optional(),
    rate_limit_per_hour: z.number().int().min(1).max(100000).optional(),
    spend_cap_usd: z.number().min(0).optional(),
  })
  .refine((b) => b.reference !== undefined || b.service !== undefined, {
    message: "one of reference or service is required",
  });

const DESCRIPTION = `Mint an egress grant: a revocable token + base URL so an app you DEPLOYED can
call a provider using a vaulted credential, WITHOUT ever holding the raw key.
Squire injects the real secret server-side at the boundary and enforces the
credential's allowed_hosts. Point the app's SDK base URL at the returned
\`base_url\` and authenticate with the returned \`token\` — the SDK's requests are
forwarded to the provider with the real key swapped in.

Pass \`service\` or \`reference\` to pick which vaulted credential to leash. Limits
are OPT-IN and UNLIMITED by default: pass \`rate_limit_per_hour\` and/or
\`spend_cap_usd\` ONLY if the caller wants a cap. Omit them for no rate/spend limit
(the grant is still revocable + host-scoped + audited).

SECURITY: the token is BACKEND-ONLY. It is metered spend until revoked — never
put it in client/browser code. It is strictly safer than the raw key (scoped to
one credential's hosts, rate-limited, instantly revocable, audited), but it is
still a bearer secret. Revoke any time; revocation is instant and needs no key
rotation.`;

export const grantAppAccessTool: Tool<z.infer<typeof inputSchema>> = {
  name: "grant_app_access",
  description: DESCRIPTION,
  inputSchema,
  jsonInputSchema: {
    type: "object",
    properties: {
      reference: { type: "string" },
      service: { type: "string" },
      rate_limit_per_hour: { type: "number" },
      spend_cap_usd: { type: "number" },
    },
  },
  meta: ALWAYS_LOAD_META,
  async handler(args, api) {
    assertApi(api);
    const res = await api.grantAppAccess({
      ...(args.reference !== undefined ? { reference: args.reference } : {}),
      ...(args.service !== undefined ? { service: args.service } : {}),
      ...(args.rate_limit_per_hour !== undefined ? { rate_limit_per_hour: args.rate_limit_per_hour } : {}),
      ...(args.spend_cap_usd !== undefined ? { spend_cap_usd: args.spend_cap_usd } : {}),
    });
    return res;
  },
};
