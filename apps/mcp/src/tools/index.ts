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
import { listCredentialsTool } from "./list-credentials.js";
import { listExtractFailuresTool, getExtractFailureTool } from "./extract-failures.js";
import { storeCredentialTool } from "./store-credential.js";
import { useCredentialTool } from "./use-credential.js";
import { grantAppAccessTool } from "./grant-app-access.js";
import { INTERACTIVE_SIGNUP_TOOLS } from "./provision-drive.js";

export interface Tool<TArgs extends Record<string, unknown> = Record<string, unknown>> {
  name: string;
  description: string;
  inputSchema: ZodTypeAny;
  jsonInputSchema: Record<string, unknown>;
  // Standard MCP tool annotations (readOnlyHint / destructiveHint /
  // idempotentHint). Client-only — they don't reach the model.
  annotations?: Record<string, unknown>;
  // Tool-level _meta. Carries `anthropic/alwaysLoad: true` for the
  // credential tools so Claude Code keeps their schemas resident
  // instead of deferring them behind Tool Search.
  meta?: Record<string, unknown>;
  handler: (args: TArgs, api: ApiClient | null) => Promise<unknown>;
}

// Re-exported for convenience; defined in its own module to avoid a
// circular import (tool files import it; index imports the tool files).
export { ALWAYS_LOAD_META } from "./always-load.js";

// All tools receive `api: ApiClient | null`. In the single-tier model
// server.ts only invokes a handler after confirming a non-null api, but
// the registry contract still types it as nullable. assertApi() is the
// one-liner that asserts the non-nullability for handlers that DO need the API.
export function assertApi(api: ApiClient | null): asserts api is ApiClient {
  if (api === null) {
    throw new Error(
      "This tool requires an active Trusty Squire session. Run `npx @trusty-squire/mcp connect`.",
    );
  }
}

// The agent-facing tool registry. The legacy async `provision` surface is no
// longer exposed: host agents should drive signup explicitly through the
// interactive provision_start/observe/act/extract/finish loop.
export const TOOLS: Tool[] = [
  listCredentialsTool,
  // Vault lifecycle + write-only-sink proxy (the credential surface).
  storeCredentialTool,
  useCredentialTool,
  // Egress grants: a deployed app uses a vaulted credential via the proxy.
  grantAppAccessTool,
  // Diagnostic tools: agent reads them after a failed extract so it
  // can write a targeted fix without the user fetching by curl.
  listExtractFailuresTool,
  getExtractFailureTool,
  // Interactive host-driven provisioning (provision_start/observe/act/
  // captcha_gate/await_verification/extract/finish).
  ...INTERACTIVE_SIGNUP_TOOLS,
] as Tool[];

export function findTool(name: string): Tool | null {
  return TOOLS.find((t) => t.name === name) ?? null;
}

// Re-export zod so tool files can `import { z } from "../tools/index.js"`.
export { z };

// Per-tool re-exports so callers (tests, custom integrations) can
// import a single tool without going through the TOOLS array.
export {
  listCredentialsTool,
  storeCredentialTool,
  useCredentialTool,
  grantAppAccessTool,
  listExtractFailuresTool,
  getExtractFailureTool,
};
