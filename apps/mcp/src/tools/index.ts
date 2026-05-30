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
import { getCredentialTool } from "./get-credential.js";
import { listCredentialsTool } from "./list-credentials.js";
import { provisionTool, checkProvisionStatusTool } from "./provision-any.js";
import { listExtractFailuresTool, getExtractFailureTool } from "./extract-failures.js";
import { storeCredentialTool } from "./store-credential.js";
import { rotateCredentialTool } from "./rotate-credential.js";
import { deleteCredentialTool } from "./delete-credential.js";
import { useCredentialTool } from "./use-credential.js";

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

// The agent-facing tool registry. The native-`provision` cluster (mandate
// evaluator + adapter manifests + approval flow) was sunset in 0.8 — the
// universal browser-driven bot covers every service the team would have
// hand-authored a native adapter for, faster than the manifest work paid
// for itself. What survives: the universal provision tool, its status
// poll, vault reads, and the extract-failure diagnostic pair.
export const TOOLS: Tool[] = [
  provisionTool,
  checkProvisionStatusTool,
  getCredentialTool,
  listCredentialsTool,
  // Vault lifecycle + write-only-sink proxy (the credential surface).
  storeCredentialTool,
  rotateCredentialTool,
  deleteCredentialTool,
  useCredentialTool,
  // Diagnostic tools: agent reads them after a failed extract so it
  // can write a targeted fix without the user fetching by curl.
  listExtractFailuresTool,
  getExtractFailureTool,
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
  checkProvisionStatusTool,
  getCredentialTool,
  listCredentialsTool,
  storeCredentialTool,
  rotateCredentialTool,
  deleteCredentialTool,
  useCredentialTool,
  listExtractFailuresTool,
  getExtractFailureTool,
};
