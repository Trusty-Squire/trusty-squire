import { z } from "zod";
import { assertApi, type Tool } from "./index.js";
import { ALWAYS_LOAD_META } from "./always-load.js";

// Revoke an egress grant — the kill-switch counterpart to grant_app_access.
// Revocation is instant and needs no key rotation: the next call through the
// grant's proxy is rejected (403 grant_revoked). The underlying vaulted
// credential is untouched and every OTHER grant on it keeps working.
const revokeInput = z.object({
  grant_id: z.string().min(1),
});

const REVOKE_DESCRIPTION = `Revoke an egress grant on the spot — "something leaked, kill that token now."
Pass the \`grant_id\` returned by grant_app_access (or list_app_access). Revocation
is INSTANT and global: the next request through that grant's proxy is rejected
(403), no key rotation required. The vaulted credential itself is untouched and
any other grants on it keep working. Use this the moment a backend egress token
is suspected leaked.`;

export const revokeAppAccessTool: Tool<z.infer<typeof revokeInput>> = {
  name: "revoke_app_access",
  description: REVOKE_DESCRIPTION,
  inputSchema: revokeInput,
  jsonInputSchema: {
    type: "object",
    properties: { grant_id: { type: "string" } },
    required: ["grant_id"],
  },
  annotations: { destructiveHint: true, idempotentHint: true },
  meta: ALWAYS_LOAD_META,
  async handler(args, api) {
    assertApi(api);
    return api.revokeEgressGrant(args.grant_id);
  },
};

// List this account's egress grants so the agent can find the grant_id to
// revoke (e.g. after a leak) without the user pasting it. token_hash is never
// returned; revoked grants carry a non-null revoked_at.
const listInput = z.object({});

const LIST_DESCRIPTION = `List the egress grants minted for this account — grant_id, which vaulted
credential each leashes, rate limit, spend cap, created/revoked timestamps. The
backend token itself is never returned (it is shown ONCE at mint time). Use this
to find the grant_id to hand to revoke_app_access, or to audit what standing app
access exists.`;

export const listAppAccessTool: Tool<z.infer<typeof listInput>> = {
  name: "list_app_access",
  description: LIST_DESCRIPTION,
  inputSchema: listInput,
  jsonInputSchema: { type: "object", properties: {} },
  annotations: { readOnlyHint: true },
  meta: ALWAYS_LOAD_META,
  async handler(_args, api) {
    assertApi(api);
    return api.listEgressGrants();
  },
};
