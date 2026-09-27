import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { ensureSharedMcp } from "./bot/broker/discovery.js";
import { sharedMcpSocketPath } from "./bot/broker/mcp-socket-path.js";
import { VERSION } from "./version.js";

type RpcFrame = { id?: string | number; method?: string; error?: unknown };

function frames(chunk: Buffer, buffered: Buffer, receive: (line: string) => void): Buffer {
  let input = Buffer.concat([buffered, chunk]);
  for (;;) {
    const end = input.indexOf(10);
    if (end < 0) return input;
    receive(input.subarray(0, end).toString("utf8"));
    input = input.subarray(end + 1);
  }
}

/** Keep the agent's stdio MCP connection alive across broker restarts. */
export async function runRelay(): Promise<void> {
  process.stderr.write(`[trusty-squire] server v${VERSION}\n`);
  const agentId = (process.env.TRUSTY_SQUIRE_AGENT_IDENTITY ?? "unknown").trim();
  if (!agentId || agentId.length > 128 || agentId.includes("\n") || agentId.includes("\r"))
    throw new Error("TRUSTY_SQUIRE_AGENT_IDENTITY must be a single line of at most 128 characters");

  let socket: Socket | undefined;
  let retry: NodeJS.Timeout | undefined;
  let input: Buffer = Buffer.alloc(0);
  let output: Buffer = Buffer.alloc(0);
  let initialize: string | undefined;
  let initialized: string | undefined;
  let replayId: string | undefined;
  let delayMs = 100;
  let stopped = false;
  let connectedOnce = false;
  let ready = false;
  const pending = new Map<string, string | number>();
  const queued: string[] = [];

  const flush = () => {
    while (queued.length) {
      const line = queued.shift()!;
      const frame = JSON.parse(line) as RpcFrame;
      if (frame.id !== undefined && frame.method) pending.set(JSON.stringify(frame.id), frame.id);
      socket?.write(`${line}\n`);
    }
  };
  const reconnect = () => {
    if (stopped || retry) return;
    retry = setTimeout(() => {
      retry = undefined;
      connect();
    }, delayMs);
    delayMs = Math.min(delayMs * 2, 1_000);
  };
  const connect = () => {
    if (stopped) return;
    void ensureSharedMcp()
      .then(() => {
        if (stopped) return;
        attach(createConnection(sharedMcpSocketPath()));
      })
      .catch((error: unknown) => {
        if (stopped) return;
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`[trusty-squire] relay: ${message}\n`);
        reconnect();
      });
  };
  const attach = (peer: Socket) => {
    if (stopped) {
      peer.destroy();
      return;
    }
    socket = peer;
    output = Buffer.alloc(0);
    peer.once("connect", () => {
      delayMs = 100;
      peer.write(`${agentId}\n`);
      if (connectedOnce && initialize) {
        replayId = `trusty-squire-relay-${randomUUID()}`;
        const frame = JSON.parse(initialize) as RpcFrame;
        peer.write(JSON.stringify({ ...frame, id: replayId }) + "\n");
      } else {
        ready = true;
        flush();
      }
      connectedOnce = true;
    });
    peer.on("data", (chunk: Buffer) => {
      output = frames(chunk, output, (line) => {
        const frame = JSON.parse(line) as RpcFrame;
        if (frame.id === replayId) {
          replayId = undefined;
          if (frame.error) {
            peer.destroy(new Error("broker rejected relay initialization"));
            return;
          }
          if (initialized) peer.write(`${initialized}\n`);
          ready = true;
          flush();
          return;
        }
        if (frame.id !== undefined && !frame.method) pending.delete(JSON.stringify(frame.id));
        process.stdout.write(`${line}\n`);
      });
    });
    peer.on("error", (error) => {
      if (!stopped) process.stderr.write(`[trusty-squire] relay: ${error.message}\n`);
    });
    peer.once("close", () => {
      if (socket !== peer || stopped) return;
      socket = undefined;
      ready = false;
      replayId = undefined;
      for (const id of pending.values()) {
        process.stdout.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: { code: -32000, message: "Trusty Squire broker connection lost" },
          }) + "\n",
        );
      }
      pending.clear();
      reconnect();
    });
  };

  process.stdin.on("data", (chunk: Buffer) => {
    input = frames(chunk, input, (line) => {
      const frame = JSON.parse(line) as RpcFrame;
      if (frame.method === "initialize") initialize = line;
      if (frame.method === "notifications/initialized") initialized = line;
      queued.push(line);
      if (ready) flush();
    });
  });
  await new Promise<void>((resolve) => {
    const close = () => {
      if (stopped) return;
      stopped = true;
      if (retry) clearTimeout(retry);
      socket?.destroy();
      process.stdout.end(resolve);
    };
    process.stdin.once("end", close);
    process.stdin.once("close", close);
    process.once("SIGHUP", close);
    process.once("SIGTERM", close);
    process.once("SIGINT", close);
    process.stdin.resume();
    connect();
  });
}
