import { randomUUID } from "node:crypto";
import { createConnection, createServer, type Server as NetServer, type Socket } from "node:net";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ApiClient } from "../../api-client.js";
import { buildServer, createServerCallAdmission, runBoundedServerCleanup } from "../../server.js";
import { shutdownDeadlineMs } from "../../server.js";
import { createSessionGuard } from "../../session-guard.js";
import type { OperatorBroker } from "./operator.js";
import { InProcessOperatorPrincipal } from "./mcp-principal.js";
import { sharedMcpSocketPath } from "./mcp-socket-path.js";

export { sharedMcpSocketPath } from "./mcp-socket-path.js";

async function liveListener(path: string): Promise<boolean> {
  return await new Promise((resolve) => {
    const probe = createConnection(path);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => {
      probe.destroy();
      resolve(false);
    });
  });
}

async function bind(server: NetServer, path: string): Promise<void> {
  const attempt = async () =>
    await new Promise<void>((resolve, reject) => {
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      server.once("listening", onListening);
      server.once("error", onError);
      server.listen(path);
    });
  try {
    await attempt();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" || (await liveListener(path)))
      throw error;
    await unlink(path);
    await attempt();
  }
}

/** Separate from broker election and Chrome custody: one listener, one MCP Server per socket. */
export async function listenSharedMcp(
  operator: OperatorBroker,
  path = sharedMcpSocketPath(),
  makeGuard = createSessionGuard,
): Promise<{ close(): Promise<void> }> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const stat = await lstat(parent);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
    throw new Error("MCP socket directory must be owned by this user with mode 0700");
  const sockets = new Set<Socket>();
  const cleanup = new Set<Promise<void>>();
  const listener = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    let prefix = Buffer.alloc(0);
    let retire: (() => Promise<void>) | undefined;
    socket.once("close", () => {
      sockets.delete(socket);
      if (retire) {
        const task = retire().catch(() => undefined);
        cleanup.add(task);
        void task.finally(() => cleanup.delete(task));
      }
    });
    const readIdentity = (chunk: Buffer) => {
      prefix = Buffer.concat([prefix, chunk]);
      const end = prefix.indexOf(10);
      if (end < 0 && prefix.length > 4096) {
        socket.destroy();
        return;
      }
      if (end < 0) return;
      socket.pause();
      socket.off("data", readIdentity);
      const agentId = prefix.subarray(0, end).toString("utf8").trim();
      const rest = prefix.subarray(end + 1);
      prefix = Buffer.alloc(0);
      if (agentId.length === 0 || agentId.length > 128 || agentId.includes("\r")) {
        socket.destroy();
        return;
      }
      if (rest.length) socket.unshift(rest);
      void (async () => {
        const guard = makeGuard();
        const owner = new InProcessOperatorPrincipal(
          { agentId, clientId: randomUUID() },
          operator,
          guard,
        );
        const loadApi = async () => {
          const session = await guard.bind();
          return session?.agent_session_token
            ? new ApiClient({
                apiBaseUrl: session.api_base_url,
                registryBaseUrl:
                  process.env.ADAPTER_REGISTRY_URL ?? "https://registry.trustysquire.ai",
                agentSessionToken: session.agent_session_token,
                agentIdentity: agentId,
                ...(session.account_id ? { accountId: session.account_id } : {}),
              })
            : null;
        };
        const admission = createServerCallAdmission();
        const server = await buildServer(
          await loadApi(),
          admission,
          loadApi,
          guard,
          owner,
          agentId,
        );
        const transport = new StdioServerTransport(socket, socket);
        let retired = false;
        retire = async () => {
          if (retired) return;
          retired = true;
          const drained = admission.closeAndDrain();
          await runBoundedServerCleanup(
            Promise.allSettled([owner.disconnect(), drained]).then(() => undefined),
            async () => await server.close(),
            shutdownDeadlineMs(),
          );
        };
        if (socket.destroyed) {
          await retire();
          return;
        }
        transport.onclose = () => {
          socket.destroy();
        };
        await server.connect(transport);
        socket.resume();
      })().catch((error) => {
        process.stderr.write(
          `[browser-broker] MCP connection failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        socket.destroy();
      });
    };
    socket.on("data", readIdentity);
    socket.resume();
  });
  await bind(listener, path);
  await chmod(path, 0o600);
  const identity = await lstat(path);
  return {
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => listener.close(() => resolve()));
      await Promise.all(cleanup);
      const current = await lstat(path).catch(() => null);
      if (current?.ino === identity.ino && current.dev === identity.dev) await unlink(path);
    },
  };
}
