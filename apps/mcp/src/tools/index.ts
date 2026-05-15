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
import { listServicesTool } from "./list-services.js";
import { listSubscriptionsTool } from "./list-subscriptions.js";
import { cancelTool } from "./cancel.js";
import { getUsageTool } from "./get-usage.js";
import { rotateCredentialTool } from "./rotate-credential.js";
import { provisionAnyTool } from "./provision-any.js";

export interface Tool<TArgs extends Record<string, unknown> = Record<string, unknown>> {
  name: string;
  description: string;
  inputSchema: ZodTypeAny;
  jsonInputSchema: Record<string, unknown>;
  handler: (args: TArgs, api: ApiClient) => Promise<unknown>;
}

export const TOOLS: Tool[] = [
  provisionAnyTool,
  provisionTool,
  waitForApprovalTool,
  getCredentialTool,
  listServicesTool,
  listSubscriptionsTool,
  cancelTool,
  getUsageTool,
  rotateCredentialTool,
] as Tool[];

export function findTool(name: string): Tool | null {
  return TOOLS.find((t) => t.name === name) ?? null;
}

// Re-export zod so tool files can `import { z } from "../tools/index.js"`.
export { z };

// Per-tool re-exports so callers (tests, custom integrations) can
// import a single tool without going through the TOOLS array.
export {
  provisionTool,
  waitForApprovalTool,
  getCredentialTool,
  listServicesTool,
  listSubscriptionsTool,
  cancelTool,
  getUsageTool,
  rotateCredentialTool,
};
