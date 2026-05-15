#!/usr/bin/env node
// MCP server entry point. Reads the session from keytar/file, sets up
// an ApiClient against the configured API base URL, and exposes the
// registered tools over stdio.
//
// The server is what a coding agent (Claude Code, Cursor, etc.)
// launches as a child process via the MCP config it found in
// `~/.claude/mcp.json` or equivalent.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { ApiClient, MissingSessionError } from "./api-client.js";
import { TOOLS, findTool } from "./tools/index.js";
import { openSessionStorage } from "./session.js";

const SERVER_NAME = "trusty-squire";
const SERVER_VERSION = "0.1.0";

const DEFAULT_REGISTRY_BASE = process.env.ADAPTER_REGISTRY_URL ?? "https://registry.trustysquire.ai";

export async function buildServer(api: ApiClient | null): Promise<Server> {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
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
      // provision_any_service doesn't need API client (anonymous mode)
      if (tool.name === "provision_any_service") {
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
          `This tool requires pairing (Tier 1+). For local dev: ` +
          `\`node /home/chode/trusty-squire/apps/mcp/dist/install/cli.js install --target=goose --pair\`. ` +
          `In production: \`npx @trusty-squire/mcp install --target=<agent> --pair\`. ` +
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

async function main(): Promise<void> {
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

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    // stderr goes to the coding agent's MCP log — keep the message
    // useful for debugging without leaking secrets.
    console.error(
      err instanceof MissingSessionError
        ? err.message
        : `[trusty-squire] startup failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  });
}
