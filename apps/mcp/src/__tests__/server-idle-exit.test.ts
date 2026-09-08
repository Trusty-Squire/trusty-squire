// A live box surfaced 33 accumulated `mcp server` processes, some holding
// live operator Chromes — the disconnect-triggered shutdown in server.ts
// (transport.onclose / stdin EOF / SIGTERM, covered by bin-smoke.test.ts)
// never fired because the host abandoned the child without closing its
// stdio or signaling it. shouldIdleExit is the pure decision function behind
// the time-bound backstop for that case.
//
// An open provision session owns its own Chrome and profile. A session left
// open by an abandoned server can only be freed by that server itself exiting.
// shouldIdleExit therefore
// uses a longer bound when a session is open rather than never exiting, but
// still applies real teardown (closeAllProvisionSessions, which kills the
// leased Chrome) once that longer bound is crossed.

import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../api-client.js";
import {
  buildServer,
  createServerCallAdmission,
  runBoundedServerCleanup,
  shouldIdleExit,
} from "../server.js";
import { readServerInstanceRecord } from "../server-instance-registry.js";
import { SessionStore } from "../session.js";
import { listenBroker } from "../bot/broker/transport.js";
import { forwarderId } from "../bot/broker/lineage.js";

const require = createRequire(import.meta.url);
const credential = "a".repeat(43);
const sleep = async (ms: number) => await new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("condition did not become true before timeout");
    await sleep(25);
  }
}

function mcpRequest(child: ChildProcess, request: object): Promise<void> {
  return new Promise((resolve, reject) => {
    let buffered = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("MCP request timed out"));
    }, 10_000);
    const onData = (chunk: Buffer) => {
      buffered += String(chunk);
      for (;;) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) return;
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        try {
          const reply = JSON.parse(line) as { id?: number; error?: unknown };
          if (reply.id !== 1) continue;
          cleanup();
          if (reply.error !== undefined) reject(new Error(JSON.stringify(reply.error)));
          else resolve();
          return;
        } catch (error) {
          cleanup();
          reject(error);
          return;
        }
      }
    };
    const onExit = () => {
      cleanup();
      reject(new Error("MCP server exited before initialization"));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.off("exit", onExit);
    };
    child.stdout?.on("data", onData);
    child.once("exit", onExit);
    child.stdin?.write(`${JSON.stringify(request)}\n`);
  });
}

describe("server shutdown call admission", () => {
  it("keeps its registry record draining until a stuck stdio call reaches the deadline", async () => {
    const root = await mkdtemp(join(tmpdir(), "ts-server-draining-process-"));
    const config = join(root, "config");
    const profile = join(root, "profile");
    const socket = join(root, "broker.sock");
    const records = join(root, "instances");
    const account = {
      account_id: "fixture-account",
      agent_session_token: "server-token",
      api_base_url: "http://127.0.0.1:1",
      saved_at: new Date().toISOString(),
    };
    await mkdir(profile);
    await new SessionStore(join(config, "trusty-squire", "session.json")).write(account);
    let entered!: () => void;
    const enteredCall = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const listener = await listenBroker(socket, {
      authenticate: async (token, _agentId, lineageCredential) =>
        token === account.agent_session_token && lineageCredential === credential
          ? { accountId: account.account_id, agentId: "registry-test", forwarderId: forwarderId(credential) }
          : null,
      call: async (_principal, method) => {
        if (method === "reclaim") return { capabilities: [] };
        if (method === "recover") return null;
        if (method === "acknowledge") return {};
        if (method === "tool") {
          entered();
          return await new Promise<never>(() => undefined);
        }
        return {};
      },
      disconnect: async () => undefined,
    });
    const child = spawn(
      process.execPath,
      [require.resolve("tsx/cli"), fileURLToPath(new URL("../bin.ts", import.meta.url)), "server"],
      {
        env: {
          ...process.env,
          HOME: join(root, "home"),
          XDG_CONFIG_HOME: config,
          TMPDIR: root,
          TRUSTY_SQUIRE_ACCOUNT_ID: account.account_id,
          TRUSTY_SQUIRE_AGENT_IDENTITY: "registry-test",
          TRUSTY_SQUIRE_PROFILE_DIR: profile,
          TRUSTY_SQUIRE_BROKER_SOCKET: socket,
          TRUSTY_SQUIRE_FORWARDER_CREDENTIAL: credential,
          TRUSTY_SQUIRE_SERVER_INSTANCE_DIR: records,
          TRUSTY_SQUIRE_SERVER_SHUTDOWN_DEADLINE_MS: "400",
          TRUSTY_SQUIRE_SERVER_HEARTBEAT_INTERVAL_MS: "50",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    try {
      await mcpRequest(child, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "registry-test", version: "1" },
        },
      });
      child.stdin?.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "operate_start", arguments: { service_url: "https://example.test" } },
        })}\n`,
      );
      await enteredCall;
      child.kill("SIGTERM");
      let recordPath = "";
      await waitFor(async () => {
        const entries = await readdir(records).catch(() => [] as string[]);
        recordPath = entries.map((entry) => join(records, entry)).find((path) => {
          const record = readServerInstanceRecord(path);
          return record?.state === "draining" && record.in_flight_calls === 1;
        }) ?? "";
        return recordPath.length > 0;
      }, 5_000);
      const first = readServerInstanceRecord(recordPath);
      expect(first).toMatchObject({ state: "draining", in_flight_calls: 1 });
      await sleep(100);
      expect(readServerInstanceRecord(recordPath)).toMatchObject({ state: "draining" });
      await expect(exited).resolves.toEqual({ code: 0, signal: null });
      await waitFor(async () => (await readdir(records).catch(() => [] as string[])).length === 0, 5_000);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await exited.catch(() => undefined);
      await listener.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("runs terminal cleanup and returns at the deadline when an admitted call is stuck", async () => {
    vi.useFakeTimers();
    try {
      const stuck = new Promise<void>(() => undefined);
      const cleanup = vi.fn(async () => undefined);
      const result = runBoundedServerCleanup(stuck, cleanup, 50);
      await vi.advanceTimersByTimeAsync(50);
      await expect(result).resolves.toBe("deadline");
      expect(cleanup).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes admission before draining calls that already entered", async () => {
    const admission = createServerCallAdmission();
    expect(admission.started()).toBe(true);
    expect(admission.started()).toBe(true);

    let drained = false;
    const drain = admission.closeAndDrain().then(() => {
      drained = true;
    });

    expect(admission.started()).toBe(false);
    admission.finished();
    await Promise.resolve();
    expect(drained).toBe(false);
    admission.finished();
    await drain;
    expect(drained).toBe(true);
  });

  it("rejects a tool call that arrives after shutdown closes admission", async () => {
    const admission = createServerCallAdmission();
    const api = { setRequestingAgent: vi.fn() } as unknown as ApiClient;
    const server = await buildServer(api, admission);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "shutdown-admission-test", version: "1" });
    await client.connect(clientTransport);
    await admission.closeAndDrain();
    try {
      const result = await client.callTool({ name: "list_credentials", arguments: {} });
      const text = (result.content as Array<{ text?: string }>)
        .map((entry) => entry.text ?? "")
        .join("");
      expect(JSON.parse(text).error.code).toBe("server_unavailable");
      expect(api.setRequestingAgent).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });
});

describe("shouldIdleExit", () => {
  const timeoutMs = 1_000;
  const timeoutWithSessionMs = 5_000;

  it("stays false while activity is within the no-session timeout", () => {
    expect(shouldIdleExit(1_500, 1_000, 0, timeoutMs, timeoutWithSessionMs)).toBe(false);
  });

  it("goes true once idle time reaches the no-session timeout", () => {
    expect(shouldIdleExit(2_000, 1_000, 0, timeoutMs, timeoutWithSessionMs)).toBe(true);
  });

  it("stays false with an open session before the (longer) session timeout", () => {
    expect(shouldIdleExit(3_000, 1_000, 1, timeoutMs, timeoutWithSessionMs)).toBe(false);
  });

  it("goes true with an open session once the longer timeout is crossed", () => {
    expect(shouldIdleExit(6_000, 1_000, 1, timeoutMs, timeoutWithSessionMs)).toBe(true);
  });

  it("re-arms after fresh activity moves lastActivityAt forward", () => {
    expect(shouldIdleExit(2_000, 1_900, 0, timeoutMs, timeoutWithSessionMs)).toBe(false);
  });
});
