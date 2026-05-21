// Tool registry for the MCP server. Each tool exports its name, the
// JSON-schema input shape, the verbatim description that the coding
// agent reads to decide when to call, and a `handler(args, api)` that
// returns a plain JSON response.
//
// Tools are pure functions of (args, api-client). The MCP `server.ts`
// wraps them with the SDK's request handler so they appear as
// callable tools over stdio. Tests skip the SDK and exercise handlers
// directly with a mock api-client.

import { z, type ZodTypeAny } from "zod";
import type { ApiClient } from "../api-client.js";
import { provisionTool } from "./provision.js";
import { waitForApprovalTool } from "./wait-for-approval.js";
import { getCredentialTool } from "./get-credential.js";
import { listCredentialsTool } from "./list-credentials.js";
import { listServicesTool } from "./list-services.js";
import { listSubscriptionsTool } from "./list-subscriptions.js";
import { cancelTool } from "./cancel.js";
import { getUsageTool } from "./get-usage.js";
import { rotateCredentialTool } from "./rotate-credential.js";
import { provisionAnyTool, checkProvisionStatusTool } from "./provision-any.js";

export interface Tool<TArgs extends Record<string, unknown> = Record<string, unknown>> {
  name: string;
  description: string;
  inputSchema: ZodTypeAny;
  jsonInputSchema: Record<string, unknown>;
  handler: (args: TArgs, api: ApiClient | null) => Promise<unknown>;
}

// All tools receive `api: ApiClient | null`. In the single-tier model
// server.ts only invokes a handler after confirming a non-null api, but
// the registry contract still types it as nullable so handlers like
// check_provision_status (which doesn't need the API) don't have to
// fake-narrow. assertApi() is the one-liner that asserts the
// non-nullability for handlers that DO need the API.
export function assertApi(api: ApiClient | null): asserts api is ApiClient {
  if (api === null) {
    throw new Error(
      "This tool requires an active Trusty Squire session. Run `npx @trusty-squire/mcp connect`.",
    );
  }
}

// The agent-facing tool registry. Only tools with a live backend are
// exposed: the universal signup bot + its status poll, and the vault
// read path. The native-`provision` cluster — provisionTool,
// waitForApprovalTool, listServicesTool, listSubscriptionsTool,
// cancelTool, getUsageTool, rotateCredentialTool — is still defined and
// re-exported below but deliberately NOT registered: that subsystem
// (adapter registry + mandate engine + native adapters) is deferred, so
// handing those tools to a coding agent only yields 403s / dead-registry
// errors. Re-register them when the native-provision work lands.
export const TOOLS: Tool[] = [
  provisionAnyTool,
  checkProvisionStatusTool,
  getCredentialTool,
  listCredentialsTool,
] as Tool[];

export function findTool(name: string): Tool | null {
  return TOOLS.find((t) => t.name === name) ?? null;
}

// Re-export zod so tool files can `import { z } from "../tools/index.js"`.
export { z };

// Per-tool re-exports so callers (tests, custom integrations) can
// import a single tool without going through the TOOLS array.
export {
  provisionAnyTool,
  checkProvisionStatusTool,
  provisionTool,
  waitForApprovalTool,
  getCredentialTool,
  listCredentialsTool,
  listServicesTool,
  listSubscriptionsTool,
  cancelTool,
  getUsageTool,
  rotateCredentialTool,
};
