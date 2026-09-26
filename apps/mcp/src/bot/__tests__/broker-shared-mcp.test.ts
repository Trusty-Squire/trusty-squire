import { createServer, type Server as HttpServer } from "node:http";
import { createConnection, createServer as createNetServer, type Socket } from "node:net";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, expect, it, vi } from "vitest";
import { OperatorBroker } from "../broker/operator.js";
import { listenSharedMcp } from "../broker/mcp-socket.js";
import { listenBroker } from "../broker/transport.js";
import { OperatorForwarder } from "../broker/forwarder.js";
import { buildServer } from "../../server.js";
import { ApiClient } from "../../api-client.js";
import type { SessionGuard } from "../../session-guard.js";
import type { SessionData } from "../../session.js";
import type { OpenResult } from "../broker/protocol.js";

class Peer {
  private next = 1;
  private pending = new Map<number, (value: ReturnType<typeof JSON.parse>) => void>();
  private buffer = "";
  constructor(readonly socket: Socket) {
    socket.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      for (;;) {
        const end = this.buffer.indexOf("\n");
        if (end < 0) break;
        const frame = JSON.parse(this.buffer.slice(0, end));
        this.buffer = this.buffer.slice(end + 1);
        if (typeof frame.id === "number") {
          this.pending.get(frame.id)?.(frame);
          this.pending.delete(frame.id);
        }
      }
    });
  }
  async call(method: string, params: Record<string, unknown> = {}) {
    const id = this.next++;
    const response = new Promise<ReturnType<typeof JSON.parse>>((resolve) =>
      this.pending.set(id, resolve),
    );
    this.socket.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    const frame = await response;
    if (frame.error) throw new Error(JSON.stringify(frame.error));
    return frame.result;
  }
  async ready() {
    await this.call("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "client", version: "1" },
    });
    this.socket.write(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
    );
  }
  tool(name: string, args: Record<string, unknown>) {
    return this.call("tools/call", { name, arguments: args });
  }
  close() {
    this.socket.destroy();
  }
}

const text = (result: Awaited<ReturnType<Peer["tool"]>>) => JSON.parse(result.content[0].text);
let cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup = [];
});

it("relay sends the agent identity before MCP traffic and exits with its pipe", async () => {
  const root = await mkdtemp(join(process.cwd(), ".relay-test-"));
  cleanup.push(async () => await rm(root, { recursive: true, force: true }));
  const operator = new OperatorBroker({ registryBaseUrl: "http://unused.test" });
  const path = join(root, ".trusty-squire", "mcp.sock");
  const listener = await listenSharedMcp(operator, path, () => ({
    bind: async () => null,
    inspect: async () => ({ problem: null }),
    boundAccountId: () => null,
  }));
  cleanup.push(async () => await listener.close());
  const bin = fileURLToPath(new URL("../../bin.ts", import.meta.url));
  const relay = spawn(process.execPath, ["--import", "tsx", bin, "relay"], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: root, TRUSTY_SQUIRE_AGENT_IDENTITY: "relay-agent" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  cleanup.push(async () => {
    relay.kill();
  });
  let output = "";
  const initialized = new Promise<Record<string, unknown>>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error("relay did not answer initialize")), 5_000);
    relay.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const end = output.indexOf("\n");
      if (end < 0) return;
      clearTimeout(deadline);
      resolve(JSON.parse(output.slice(0, end)));
    });
    relay.once("exit", (code) => reject(new Error(`relay exited ${code}`)));
  });
  relay.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "fixture", version: "1" },
      },
    }) + "\n",
  );
  expect((await initialized).id).toBe(1);
  relay.stdin.end();
  await new Promise<void>((resolve) => relay.once("exit", () => resolve()));
});

it("relay restores initialization after a broker restart and fails a dropped in-flight call", async () => {
  const root = await mkdtemp(join(process.cwd(), ".rr-"));
  cleanup.push(async () => await rm(root, { recursive: true, force: true }));
  const path = join(root, ".trusty-squire", "mcp.sock");
  await mkdir(join(root, ".trusty-squire"), { mode: 0o700 });
  const identities: string[] = [];
  const brokerFrames: Array<{ method?: string; id?: number | string }> = [];
  let generation = 0;
  const startBroker = async () => {
    generation++;
    const current = generation;
    const server = createNetServer((socket) => {
      let buffer = "";
      let identified = false;
      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        for (;;) {
          const end = buffer.indexOf("\n");
          if (end < 0) break;
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          if (!identified) {
            identities.push(line);
            identified = true;
            continue;
          }
          const frame = JSON.parse(line);
          brokerFrames.push(frame);
          if (frame.method === "initialize") {
            socket.write(
              JSON.stringify({
                jsonrpc: "2.0",
                id: frame.id,
                result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "broker", version: "1" } },
              }) + "\n",
            );
          } else if (frame.method === "tools/call") {
            if (current === 1) socket.destroy();
            else socket.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { ok: true } }) + "\n");
          }
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, resolve);
    });
    return server;
  };
  let broker = await startBroker();
  const bin = fileURLToPath(new URL("../../bin.ts", import.meta.url));
  const relay = spawn(process.execPath, ["--import", "tsx", bin, "relay"], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: root, TRUSTY_SQUIRE_AGENT_IDENTITY: "relay-agent" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  cleanup.push(async () => {
    relay.kill();
    broker.close();
  });
  const responses: Array<{ id: number; result?: unknown; error?: { message: string } }> = [];
  let output = "";
  relay.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
    for (;;) {
      const end = output.indexOf("\n");
      if (end < 0) break;
      responses.push(JSON.parse(output.slice(0, end)));
      output = output.slice(end + 1);
    }
  });
  const send = (id: number, method: string, params = {}) =>
    relay.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  send(1, "initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "fixture", version: "1" },
  });
  await vi.waitFor(() => expect(responses.find((frame) => frame.id === 1)?.result).toBeTruthy());
  relay.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  send(2, "tools/call", { name: "tools/list", arguments: {} });
  await vi.waitFor(() =>
    expect(responses.find((frame) => frame.id === 2)?.error?.message).toContain("connection lost"),
  );
  await new Promise<void>((resolve) => broker.close(() => resolve()));
  broker = await startBroker();
  await vi.waitFor(() =>
    expect(brokerFrames.filter((frame) => frame.method === "notifications/initialized")).toHaveLength(2),
  );
  send(3, "tools/call", { name: "tools/list", arguments: {} });
  await vi.waitFor(() => expect(responses.find((frame) => frame.id === 3)?.result).toEqual({ ok: true }));
  expect(relay.exitCode).toBeNull();
  expect(responses.filter((frame) => frame.id === 1)).toHaveLength(1);
  expect(brokerFrames.filter((frame) => frame.method === "initialize")).toHaveLength(2);
  expect(identities).toEqual(["relay-agent", "relay-agent"]);
  relay.stdin.end();
  await new Promise<void>((resolve) => relay.once("exit", () => resolve()));
});

it("isolates concurrent socket principals, attributes vault calls, coexists with stdio, and reaccepts after restart", async () => {
  const root = await mkdtemp(join(process.cwd(), ".shared-mcp-test-"));
  cleanup.push(async () => await rm(root, { recursive: true, force: true }));
  const headers: string[] = [];
  const apiServer: HttpServer = createServer((request, response) => {
    headers.push(String(request.headers["x-squire-agent-identity"]));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ credentials: [] }));
  });
  await new Promise<void>((resolve) => apiServer.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => await new Promise<void>((resolve) => apiServer.close(() => resolve())));
  const address = apiServer.address();
  if (address === null || typeof address === "string") throw new Error("no API port");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const guard = (): SessionGuard => ({
    bind: async () =>
      ({ account_id: "acct", agent_session_token: "token", api_base_url: baseUrl }) as SessionData,
    inspect: async () => ({ problem: null }),
    boundAccountId: () => "acct",
  });
  const operator = new OperatorBroker({ registryBaseUrl: baseUrl });
  const closed: string[] = [];
  vi.spyOn(operator, "open").mockImplementation(async (principal) => {
    const tab = randomUUID();
    const sessionId = await operator.authority.open(principal, async () => ({
      targetId: tab,
      invoke: async (_name, args) => ({
        session_id: args.session_id,
        tab,
        closed: _name === "operate_finish",
      }),
      close: async () => {
        closed.push(tab);
        return true;
      },
      orphan: async () => undefined,
    }));
    return {
      sessionId,
      observation: {
        session_id: sessionId,
        url: "https://example.test",
        tab,
      } as OpenResult["observation"],
    };
  });
  const path = join(root, "mcp.sock");
  let shared = await listenSharedMcp(operator, path, guard);
  cleanup.push(async () => await shared.close());
  const connect = async (identity: string) => {
    const socket = createConnection(path);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    // Identity and first MCP frame can share one kernel write.
    const peer = new Peer(socket);
    socket.write(identity + "\n");
    await peer.ready();
    return peer;
  };
  const [alice, bob] = await Promise.all([connect("alice"), connect("bob")]);
  const [a, b] = await Promise.all([
    alice.tool("operate_start", { service_url: "https://example.test/a" }),
    bob.tool("operate_start", { service_url: "https://example.test/b" }),
  ]);
  const aSession = text(a).session_id;
  const bSession = text(b).session_id;
  expect(aSession).not.toBe(bSession);
  expect(text(a).tab).not.toBe(text(b).tab);
  expect(text(await alice.tool("operate_observe", { session_id: aSession })).tab).toBeTruthy();
  expect(text(await bob.tool("operate_observe", { session_id: bSession })).tab).toBeTruthy();
  expect(text(await bob.tool("operate_observe", { session_id: aSession })).error.code).toBe(
    "stale_lease",
  );
  await Promise.all([alice.tool("list_credentials", {}), bob.tool("list_credentials", {})]);
  expect(headers).toContain("alice");
  expect(headers).toContain("bob");

  const wirePath = join(root, "broker.sock");
  const wire = await listenBroker(wirePath, {
    call: async (principal, method, params, id) =>
      method === "open" || method === "command"
        ? await operator.withRegisteredRequest(
            principal,
            id,
            async (signal) => await operator.call(principal, method, params, id, signal),
          )
        : await operator.call(principal, method, params, id),
    disconnect: async (principal, explicit) => await operator.disconnect(principal, explicit),
    abort: (principal, id) => operator.cancel(principal, id),
  });
  cleanup.push(async () => await wire.close());
  const forwarder = new OperatorForwarder(wirePath, guard());
  const stdio = await buildServer(
    new ApiClient({ apiBaseUrl: baseUrl, registryBaseUrl: baseUrl, agentSessionToken: "token" }),
    undefined,
    undefined,
    guard(),
    forwarder,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await stdio.connect(serverTransport);
  const stdioClient = new Client({ name: "Hermes", version: "1" });
  await stdioClient.connect(clientTransport);
  cleanup.push(async () => {
    await stdioClient.close();
    await forwarder.close();
  });
  const stdioStart = await stdioClient.callTool({
    name: "operate_start",
    arguments: { service_url: "https://example.test/stdio" },
  });
  const stdioSession = text(stdioStart).session_id;
  expect(stdioSession).toBeTruthy();
  expect(operator.authority.inventory().sessions).toBe(3);

  alice.close();
  await vi.waitFor(() => expect(operator.authority.inventory().sessions).toBe(2));
  expect(closed).toHaveLength(1);
  expect(text(await bob.tool("operate_observe", { session_id: bSession })).tab).toBeTruthy();
  bob.close();
  await vi.waitFor(() => expect(operator.authority.inventory().sessions).toBe(1));
  await stdioClient.callTool({
    name: "operate_finish",
    arguments: { session_id: stdioSession, outcome: "none" },
  });
  await stdioClient.close();
  await forwarder.close();
  await vi.waitFor(() => expect(operator.authority.inventory().sessions).toBe(0));
  await shared.close();
  shared = await listenSharedMcp(new OperatorBroker({ registryBaseUrl: baseUrl }), path, guard);
  const reconnected = await connect("alice");
  expect(
    (await reconnected.call("tools/list")).tools.some(
      (tool: { name: string }) => tool.name === "operate_start",
    ),
  ).toBe(true);
  reconnected.close();
});
