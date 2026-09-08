import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SessionStore } from "../../session.js";
import { forwarderId } from "../broker/lineage.js";
import { listenBroker } from "../broker/transport.js";

const require = createRequire(import.meta.url);
const credential = "a".repeat(43);
const brokerIdentity = {
  cellId: "retained-cell",
  browserEpoch: "retained-epoch",
  targetId: "retained-target",
  pid: 4242,
};
const capability = {
  ...brokerIdentity,
  sessionId: "retained-session",
  leaseGeneration: "retained-lease",
};

interface StdioClient {
  initialize(): Promise<void>;
  callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
}

function stdioClient(child: ChildProcess, diagnostics: () => string): StdioClient {
  let nextId = 1;
  let buffered = "";
  const pending = new Map<
    string,
    { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }
  >();
  child.stdout?.on("data", (chunk: Buffer) => {
    buffered += String(chunk);
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      const message = JSON.parse(line) as { id?: string | number; result?: Record<string, unknown> };
      if (message.id === undefined) continue;
      const reply = pending.get(String(message.id));
      if (reply === undefined) continue;
      pending.delete(String(message.id));
      reply.resolve(message.result ?? {});
    }
  });
  const request = async (method: string, params: Record<string, unknown>) =>
    await new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = String(nextId++);
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP ${method} timed out: ${diagnostics()}`));
      }, 10_000);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  return {
    initialize: async () => {
      await request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "stdio-restart", version: "1" },
      });
      child.stdin?.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`,
      );
    },
    callTool: async (name, args) => {
      const response = await request("tools/call", { name, arguments: args });
      const content = response.content as Array<{ type?: unknown; text?: unknown }> | undefined;
      const text = content?.find((entry) => entry.type === "text")?.text;
      if (response.isError === true || typeof text !== "string")
        throw new Error(`MCP ${name} failed: ${JSON.stringify(response)}`);
      return JSON.parse(text) as Record<string, unknown>;
    },
  };
}

function waitForExit(child: ChildProcess, diagnostics: () => string): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0 && signal === null) resolve();
      else reject(new Error(`MCP server exited code=${code} signal=${signal}: ${diagnostics()}`));
    });
  });
}

describe("broker-backed MCP stdio restart", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
  });

  it("reclaims the same broker browser session after an MCP stdio restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "ts-broker-stdio-restart-"));
    roots.push(root);
    const socket = join(root, "broker.sock");
    const config = join(root, "config");
    const profile = join(root, "profile");
    await Promise.all([mkdir(profile), mkdir(join(root, "home"))]);
    const account = {
      account_id: "fixture-account",
      agent_session_token: "fixture-token",
      api_base_url: "http://127.0.0.1:1",
      saved_at: new Date().toISOString(),
    };
    await new SessionStore(join(config, "trusty-squire", "session.json")).write(account);

    let starts = 0;
    let reclaims = 0;
    const disconnects: boolean[] = [];
    const broker = await listenBroker(socket, {
      authenticate: async (_token, _agentId, lineageCredential) =>
        lineageCredential === credential
          ? {
              accountId: account.account_id,
              agentId: "stdio-restart",
              forwarderId: forwarderId(credential),
            }
          : null,
      call: async (_principal, method, params) => {
        if (method === "reclaim") {
          reclaims += 1;
          return { capabilities: starts === 0 ? [] : [capability] };
        }
        if (method === "acknowledge" || method === "confirm_start") return {};
        if (method === "recover") return null;
        if (method !== "tool") throw new Error(`Unexpected broker method ${method}`);
        const name = (params as { name?: unknown }).name;
        if (name === "operate_start") {
          starts += 1;
          return {
            capability,
            result: { session_id: capability.sessionId, broker: brokerIdentity },
          };
        }
        if (name === "operate_observe")
          return {
            result: {
              session_id: capability.sessionId,
              dom: "retained broker browser",
              broker: brokerIdentity,
            },
          };
        if (name === "operate_finish") return { result: { closed: true } };
        throw new Error(`Unexpected broker tool ${String(name)}`);
      },
      disconnect: async (_principal, explicit) => {
        disconnects.push(explicit === true);
      },
    });
    const children: ChildProcess[] = [];
    const launch = () => {
      let stderr = "";
      const child = spawn(
        process.execPath,
        [
          require.resolve("tsx/cli"),
          fileURLToPath(new URL("../../bin.ts", import.meta.url)),
          "server",
        ],
        {
          env: {
            ...process.env,
            HOME: join(root, "home"),
            XDG_CONFIG_HOME: config,
            TMPDIR: root,
            TRUSTY_SQUIRE_ACCOUNT_ID: account.account_id,
            TRUSTY_SQUIRE_PROFILE_DIR: profile,
            TRUSTY_SQUIRE_REAPER_DIR: join(root, "reapers"),
            TRUSTY_SQUIRE_BROKER_SOCKET: socket,
            TRUSTY_SQUIRE_FORWARDER_CREDENTIAL: credential,
            TRUSTY_SQUIRE_AGENT_IDENTITY: "stdio-restart",
            BOT_CDP_ENDPOINT: "",
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      children.push(child);
      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });
      return { child, diagnostics: () => stderr };
    };
    try {
      const first = launch();
      const firstClient = stdioClient(first.child, first.diagnostics);
      await firstClient.initialize();
      const started = await firstClient.callTool("operate_start", {
        service_url: "https://example.test",
      });
      expect(started).toMatchObject({ session_id: capability.sessionId, broker: brokerIdentity });
      const firstExit = waitForExit(first.child, first.diagnostics);
      first.child.stdin?.end();
      await firstExit;

      const second = launch();
      const secondClient = stdioClient(second.child, second.diagnostics);
      await secondClient.initialize();
      const observed = await secondClient.callTool("operate_observe", {
        session_id: capability.sessionId,
      });
      expect(observed).toMatchObject({
        session_id: capability.sessionId,
        dom: "retained broker browser",
        broker: brokerIdentity,
      });
      await secondClient.callTool("operate_finish", { session_id: capability.sessionId });
      const secondExit = waitForExit(second.child, second.diagnostics);
      second.child.stdin?.end();
      await secondExit;

      expect(starts).toBe(1);
      expect(reclaims).toBeGreaterThanOrEqual(3);
      expect(disconnects).toEqual([false, false]);
    } finally {
      for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
      await broker.close();
    }
  }, 30_000);
});
