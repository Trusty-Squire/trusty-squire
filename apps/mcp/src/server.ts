// MCP server: reads the session from keytar/file, sets up an ApiClient
// against the configured API base URL, and exposes the registered tools
// over stdio.
//
// `runServer()` is invoked by bin.ts for the `server` subcommand. This
// file is a pure module — no shebang, no entrypoint guard, no top-level
// execution. The host agent launches `mcp server`; bin.ts dispatches.
//
// Single-tier auth (post-Tier-0 collapse): every session is account-
// bound. Sessions that pre-date the single-tier change (only a
// machine_token, no agent_session_token) fail loud at tool-call time
// with a re-install instruction. There is no anonymous mode.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { ApiClient } from "./api-client.js";
import { TOOLS, findTool } from "./tools/index.js";
import { openSessionStorage } from "./session.js";
import { VERSION } from "./version.js";

const SERVER_NAME = "trusty-squire";

const DEFAULT_REGISTRY_BASE = process.env.ADAPTER_REGISTRY_URL ?? "https://registry.trustysquire.ai";

// Injected into the model's system prompt every turn (≤2KB). Teaches
// the routing between store / use / request so the agent reaches for
// the right credential tool without the user spelling it out.
const SERVER_INSTRUCTIONS = `This is the Trusty Squire credential vault — a write-only secret sink.
The user's secrets (API keys, tokens, passwords) live here encrypted;
they are NOT in the conversation context and CANNOT be read back to you.
Routing rules for THIS server's tools:

- User pastes a secret-shaped value (sk-…, ghp_…, AKIA…, eyJ…) into chat
  → call store_credential AUTOMATICALLY; don't ask permission.
- User refers to a saved credential by name or service ('my OpenAI key',
  'the Stripe token') → call list_credentials to resolve the reference.
- User wants an authenticated API call → call use_credential with the
  service/reference + the HTTP request, using \${SECRET} (single-field)
  or \${SECRET.<field>} (multi-field) placeholders. The server injects
  the secret and returns only the upstream response; you never see the
  value. The target host must be on the credential's allowed_hosts.
- Rotating a key = call store_credential again with the new value (it
  overwrites). You cannot rotate or delete credentials directly — delete
  is done by the user in the web vault.
- There is NO way to extract a raw secret value to you — by design. If a
  user wants the plaintext (e.g. for a .env file), they read it from the
  Trusty Squire web vault themselves.`;

export async function buildServer(api: ApiClient | null): Promise<Server> {
  const server = new Server(
    { name: SERVER_NAME, version: VERSION },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.jsonInputSchema,
      ...(t.annotations !== undefined ? { annotations: t.annotations } : {}),
      ...(t.meta !== undefined ? { _meta: t.meta } : {}),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = findTool(req.params.name);
    if (tool === null) {
      return errorContent(`unknown tool '${req.params.name}'`);
    }
    // Stale install gate runs before zod parsing: telling the user
    // "you have invalid arguments" is worse than telling them "your
    // install needs reconnecting" when both are true.
    if (api === null) {
      return errorContent(
        `This install is from before single-tier auth and isn't bound to an account. ` +
          `Run \`npx @trusty-squire/mcp connect\` to reconnect.`,
      );
    }
    const parsed = tool.inputSchema.safeParse(req.params.arguments ?? {});
    if (!parsed.success) {
      return errorContent(`invalid arguments: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
    }
    try {
      const result = await tool.handler(parsed.data, api, {
        notifyUser: async (message, data) => {
          await server.sendLoggingMessage({
            level: "notice",
            logger: "trusty-squire",
            data: { message, ...data },
          });
        },
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return errorContent(err instanceof Error ? err.message : String(err));
    }
  });

  return server;
}

function errorContent(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

// Start the MCP stdio server. Throws on a fatal startup failure; bin.ts
// owns the process-level error handling.
export async function runServer(): Promise<void> {
  // Startup breadcrumb on stderr (which lands in the host agent's MCP
  // log). A silent no-op was the worst part of the entrypoint-guard
  // bug — this line makes "did the server actually start?" answerable
  // at a glance.
  process.stderr.write(`[trusty-squire] server v${VERSION} starting\n`);

  const storage = await openSessionStorage();
  const session = await storage.read();

  // Single-tier: every session is account-bound. A session with just a
  // machine_token (pre-collapse install) yields api=null, and every
  // tool call returns the re-install instruction.
  const api =
    session !== null && session.agent_session_token !== undefined
      ? new ApiClient({
          apiBaseUrl: session.api_base_url,
          registryBaseUrl: DEFAULT_REGISTRY_BASE,
          agentSessionToken: session.agent_session_token,
          agentIdentity: process.env.TRUSTY_SQUIRE_AGENT_IDENTITY ?? "unknown",
          ...(session.account_id !== undefined ? { accountId: session.account_id } : {}),
        })
      : null;

  const server = await buildServer(api);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
