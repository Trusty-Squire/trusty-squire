// MCP server: reads the session from keytar/file, sets up an ApiClient
// against the configured API base URL, and exposes the registered tools
// over stdio.
//
// `runServer()` is invoked by bin.ts for the `server` subcommand. This
// file is a pure module — no shebang, no entrypoint guard, no top-level
// execution. The host agent launches `mcp server`; bin.ts dispatches.

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

export async function buildServer(api: ApiClient | null): Promise<Server> {
  const server = new Server(
    { name: SERVER_NAME, version: VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.jsonInputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = findTool(req.params.name);
    if (tool === null) {
      return errorContent(`unknown tool '${req.params.name}'`);
    }
    const parsed = tool.inputSchema.safeParse(req.params.arguments ?? {});
    if (!parsed.success) {
      return errorContent(`invalid arguments: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
    }
    try {
      // provision_any_service + check_provision_status are the Tier 0
      // escape hatch — they run on a machine token, no API client needed.
      if (tool.name === "provision_any_service" || tool.name === "check_provision_status") {
        const result = await tool.handler(parsed.data, null);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      // Other tools require an authenticated (Tier 1+) agent_session_token.
      // provision_any_service is the Tier 0 escape hatch and handles its own
      // session check above, so users who only need universal signup don't
      // need to pair at all.
      if (api === null) {
        return errorContent(
          `This tool requires pairing (Tier 1+). Run ` +
          `\`npx @trusty-squire/mcp install --target=<agent> --pair\` to enable it. ` +
          `If you just want to sign up for a free service, call \`provision_any_service\` instead — ` +
          `it works with a Tier 0 machine_token and doesn't need pairing.`
        );
      }

      const result = await tool.handler(parsed.data, api);
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

  // Tier-aware ApiClient: only paired (Tier 1+) sessions can call the
  // authenticated API. Tier 0 machine-token-only sessions get a null
  // ApiClient — provision_any_service uses session.machine_token via the
  // InboxClient directly, no agent session required.
  const api =
    session !== null && session.agent_session_token !== undefined
      ? new ApiClient({
          apiBaseUrl: session.api_base_url,
          registryBaseUrl: DEFAULT_REGISTRY_BASE,
          agentSessionToken: session.agent_session_token,
          agentIdentity: process.env.TRUSTY_SQUIRE_AGENT_IDENTITY ?? "unknown",
        })
      : null;

  const server = await buildServer(api);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
