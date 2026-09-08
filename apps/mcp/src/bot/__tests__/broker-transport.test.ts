import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { BrokerClient, listenBroker } from "../broker/transport.js";
import { BrokerAuthority } from "../broker/authority.js";
const require = createRequire(import.meta.url);

describe("authenticated broker IPC", () => {
  it("distinguishes explicit client release from a transient socket loss", async () => {
    const root = await mkdtemp(join(tmpdir(), "ts-ipc-release-"));
    const path = join(root, "broker.sock");
    const releases: boolean[] = [];
    const broker = await listenBroker(path, {
      authenticate: async () => ({ accountId: "account", agentId: "agent" }),
      call: async () => ({}),
      disconnect: async (_principal, explicit) => {
        releases.push(explicit === true);
      },
    });
    try {
      const dropped = await BrokerClient.connect(path, "token");
      await dropped.close();
      await expect.poll(() => releases).toEqual([false]);
      const released = await BrokerClient.connect(path, "token");
      await released.release();
      await expect.poll(() => releases).toEqual([false, true]);
    } finally {
      await broker.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("claims a lineage at hello and hands it off only after disconnect completes", async () => {
    const root = await mkdtemp(join(tmpdir(), "ts-ipc-lineage-"));
    const path = join(root, "b.sock");
    const authority = new BrokerAuthority("account", "cell");
    let releaseDisconnect!: () => void;
    let disconnected!: () => void;
    let finishedDisconnect!: () => void;
    const disconnectGate = new Promise<void>((resolve) => {
      releaseDisconnect = resolve;
    });
    const disconnectStarted = new Promise<void>((resolve) => {
      disconnected = resolve;
    });
    const disconnectFinished = new Promise<void>((resolve) => {
      finishedDisconnect = resolve;
    });
    const broker = await listenBroker(path, {
      authenticate: async () => ({
        accountId: "account",
        agentId: "local-agent",
        forwarderId: "lineage",
      }),
      connected: (principal) => authority.claimForwarder(principal),
      call: async () => ({}),
      disconnect: async (principal) => {
        authority.beginForwarderRelease(principal);
        disconnected();
        await disconnectGate;
        authority.releaseForwarder(principal);
        finishedDisconnect();
      },
    });
    let first: BrokerClient | undefined;
    let restarted: BrokerClient | undefined;
    try {
      const contenders = await Promise.allSettled([
        BrokerClient.connect(path, "test"),
        BrokerClient.connect(path, "test"),
      ]);
      expect(contenders.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(contenders.filter((result) => result.status === "rejected")).toHaveLength(1);
      first = contenders.find(
        (result): result is PromiseFulfilledResult<BrokerClient> => result.status === "fulfilled",
      )?.value;
      await first?.close();
      await disconnectStarted;
      const handoff = BrokerClient.connect(path, "test");
      let handoffSettled = false;
      void handoff.then(
        () => {
          handoffSettled = true;
        },
        () => {
          handoffSettled = true;
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 2_100));
      expect(handoffSettled).toBe(false);
      releaseDisconnect();
      await disconnectFinished;
      restarted = await handoff;
    } finally {
      releaseDisconnect();
      await first?.close();
      await restarted?.close();
      await broker.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 10_000);

  it("serves three separate OS processes with overlapping calls and closes only disconnected clients", async () => {
    const root = await mkdtemp(join(tmpdir(), "ts-ipc-"));
    const path = join(root, "b.sock");
    const active = new Set<string>();
    const ids = new Set<string>();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const broker = await listenBroker(path, {
      authenticate: async (token) =>
        ["a", "b", "c"].includes(token) ? { accountId: "account", agentId: token } : null,
      call: async (principal, method, params) => {
        expect(method).toBe("overlap");
        active.add(principal.clientId);
        ids.add(principal.clientId);
        const start = Date.now();
        if (active.size === 3) release();
        await barrier;
        return {
          pid: params.pid,
          clientId: principal.clientId,
          start,
          end: Date.now() + 1,
          active: active.size,
        };
      },
      disconnect: async (principal) => {
        active.delete(principal.clientId);
      },
    });
    try {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      await expect(BrokerClient.connect(path, "foreign")).rejects.toThrow(
        "Invalid broker credential",
      );
      const outputs = await Promise.all(
        ["a", "b", "c"].map(
          async (token) =>
            await new Promise<string>((resolve, reject) => {
              const child = spawn(process.execPath, [
                require.resolve("tsx/cli"),
                fileURLToPath(new URL("fixtures/broker-client.ts", import.meta.url)),
                path,
                token,
              ]);
              let output = "",
                error = "";
              child.stdout.on("data", (chunk) => {
                output += String(chunk);
              });
              child.stderr.on("data", (chunk) => {
                error += String(chunk);
              });
              child.once("error", reject);
              child.once("exit", (code) =>
                code === 0 ? resolve(output) : reject(new Error(error)),
              );
            }),
        ),
      );
      const evidence = outputs.map(
        (output) =>
          JSON.parse(output) as { pid: number; start: number; end: number; active: number },
      );
      expect(new Set(evidence.map((row) => row.pid)).size).toBe(3);
      expect(evidence.every((row) => row.pid !== process.pid && row.active === 3)).toBe(true);
      expect(Math.max(...evidence.map((row) => row.start))).toBeLessThan(
        Math.min(...evidence.map((row) => row.end)),
      );
      expect(ids.size).toBe(3);
    } finally {
      await broker.close();
      expect(active.size).toBe(0);
      await rm(root, { recursive: true, force: true });
    }
  }, 15000);

  it("does not redispatch duplicate requests and refuses a competing listener", async () => {
    const root = await mkdtemp(join(tmpdir(), "ts-ipc-"));
    const path = join(root, "b.sock");
    let dispatches = 0;
    const port = {
      authenticate: async () => ({ accountId: "account", agentId: "agent" }),
      call: async () => ++dispatches,
      disconnect: async () => undefined,
    };
    const broker = await listenBroker(path, port);
    let client: BrokerClient | undefined;
    try {
      await expect(listenBroker(path, port)).rejects.toThrow("EADDRINUSE");
      client = await BrokerClient.connect(path, "test");
      expect(await client.call("charge", {}, "charge-one")).toBe(1);
      expect(await client.call("charge", {}, "charge-one")).toBe(1);
      await expect(client.call("charge", { changed: true }, "charge-one")).rejects.toThrow(
        "different input",
      );
      expect(dispatches).toBe(1);
    } finally {
      await client?.close();
      await broker.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not acknowledge a tool response before caller delivery", async () => {
    const root = await mkdtemp(join(tmpdir(), "ts-ipc-"));
    const path = join(root, "b.sock");
    const acknowledgements: string[] = [];
    const broker = await listenBroker(path, {
      authenticate: async () => ({ accountId: "account", agentId: "agent" }),
      call: async (_principal, method, params) => {
        if (method === "acknowledge") {
          acknowledgements.push(String(params.requestId));
          return {};
        }
        return { delivered: true };
      },
      disconnect: async () => undefined,
    });
    let client: BrokerClient | undefined;
    try {
      client = await BrokerClient.connect(path, "test");
      expect(await client.call("tool", {}, "operation")).toEqual({ delivered: true });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(acknowledgements).toEqual([]);
    } finally {
      await client?.close();
      await broker.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
