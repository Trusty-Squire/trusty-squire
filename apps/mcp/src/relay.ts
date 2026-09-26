import { createConnection } from "node:net";
import { sharedMcpSocketPath } from "./bot/broker/mcp-socket-path.js";

/** Pipe one MCP stdio client to the resident broker. No session state lives here. */
export async function runRelay(): Promise<void> {
  const agentId = (process.env.TRUSTY_SQUIRE_AGENT_IDENTITY ?? "unknown").trim();
  if (!agentId || agentId.length > 128 || agentId.includes("\n") || agentId.includes("\r"))
    throw new Error("TRUSTY_SQUIRE_AGENT_IDENTITY must be a single line of at most 128 characters");
  const socket = createConnection(sharedMcpSocketPath());
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.write(`${agentId}\n`);
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
  socket.once("close", () => {
    process.stdin.unpipe(socket);
    process.stdin.pause();
    process.stdout.end(() => process.exit(process.exitCode ?? 0));
  });
  socket.on("error", (error) => {
    process.stderr.write(`[trusty-squire] relay: ${error.message}\n`);
    process.exitCode = 1;
  });
}
