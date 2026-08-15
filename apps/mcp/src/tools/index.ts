// Tool registry for the MCP server. Each tool exports its name, the
// JSON-schema input shape, the verbatim description that the coding
// agent reads to decide when to call, and a `handler(args, api)` that
// returns a plain JSON response.
//
// Tools are pure functions of (args, api-client). The MCP `server.ts`
// wraps them with the SDK's request handler so they appear as
// callable tools over stdio. Tests skip the SDK and exercise handlers
// directly with a mock api-client.

import { z, type ZodIssue, type ZodTypeAny } from "zod";
import type { ApiClient } from "../api-client.js";
import { listCredentialsTool } from "./list-credentials.js";
import { listExtractFailuresTool, getExtractFailureTool } from "./extract-failures.js";
import { storeCredentialTool } from "./store-credential.js";
import { useCredentialTool } from "./use-credential.js";
import { grantAppAccessTool } from "./grant-app-access.js";
import { revokeAppAccessTool, listAppAccessTool } from "./revoke-app-access.js";
import { auditLogTool } from "./audit-log.js";
import { OPERATE_TOOLS } from "./provision-drive.js";
import {
  listPaymentCardsTool,
  operatePayTool,
  operatePaymentAwaitTool,
  operatePaymentStatusTool,
} from "./operate-pay.js";

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
  // Action tools can turn a schema miss into an executable repair object rather
  // than leaving the model to infer the grammar from a prose validation error.
  schemaRepair?: (args: unknown, issues: readonly ZodIssue[]) => Record<string, unknown>;
  handler: (args: TArgs, api: ApiClient | null, context?: ToolContext) => Promise<unknown>;
}

export interface ToolContext {
  notifyUser: (message: string, data?: Record<string, unknown>) => Promise<void>;
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

const diagnosticsTools = [listExtractFailuresTool, getExtractFailureTool] as const;

function diagnosticsProfileEnabled(env: NodeJS.ProcessEnv): boolean {
  const value = (env.TRUSTY_SQUIRE_DIAGNOSTICS ?? "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

// Build the agent-facing tool registry. The legacy async `provision` surface is
// no longer exposed: host agents drive signup through the interactive operator
// loop. Maintainer-only DOM diagnostics are opt-in so their large, specialist
// schemas do not occupy the default agent context.
export function buildToolRegistry(env: NodeJS.ProcessEnv = process.env): Tool[] {
  return [
    listCredentialsTool,
    // Vault lifecycle + write-only-sink proxy (the credential surface).
    storeCredentialTool,
    useCredentialTool,
    // Egress grants: a deployed app uses a vaulted credential via the proxy.
    grantAppAccessTool,
    listAppAccessTool,
    revokeAppAccessTool,
    // Audit ledger: who-touched-my-keys (account-scoped, no secret values).
    auditLogTool,
    ...(diagnosticsProfileEnabled(env) ? diagnosticsTools : []),
    listPaymentCardsTool,
    operatePayTool,
    // [P0] Non-blocking payment approval: read-only status + a bounded wait,
    // so a host never has to block an RPC on the human's phone tap.
    operatePaymentStatusTool,
    operatePaymentAwaitTool,
    // Interactive host-driven provisioning (operate_start/observe/act/finish
    // plus recipe save/run; workflow kinds are consolidated under operate_act).
    ...OPERATE_TOOLS,
  ] as Tool[];
}

// The stable default surface used by direct integrations and registry tests.
// buildServer() resolves the environment-aware registry once at startup.
export const TOOLS: Tool[] = buildToolRegistry({});

export function findTool(name: string, tools: readonly Tool[] = TOOLS): Tool | null {
  return tools.find((t) => t.name === name) ?? null;
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
  listAppAccessTool,
  revokeAppAccessTool,
  auditLogTool,
  listExtractFailuresTool,
  getExtractFailureTool,
  listPaymentCardsTool,
  operatePayTool,
  operatePaymentStatusTool,
  operatePaymentAwaitTool,
};
