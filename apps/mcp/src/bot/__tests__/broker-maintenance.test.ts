import { lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
vi.mock("../../session-guard.js", () => ({
  createSessionGuard: () => ({ bind: async () => ({ agent_session_token: "test" }) }),
}));
import { withBrokerMaintenance } from "../broker/maintenance.js";
import { BrokerClient, listenBroker } from "../broker/transport.js";

describe("plain-login broker maintenance over the connect path", () => {
  it("drains at connect, holds the connection, and resumes on close even when login fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "ts-maint-"));
    const path = join(root, "b.sock");
    const events: string[] = [];
    const broker = await listenBroker(path, {
      authenticate: async (token) =>
        token === "test" ? { accountId: "account", agentId: "connect" } : null,
      connected: async (_principal, params) => {
        events.push(params.maintain === true ? "connect:maintain" : "connect:plain");
        return params.maintain === true ? { maintenance: "ready" } : undefined;
      },
      call: async (_principal, method) => {
        events.push(method);
        return { closed: true };
      },
      disconnect: async () => {
        events.push("disconnect");
      },
    });
    vi.stubEnv("TRUSTY_SQUIRE_BROKER_SOCKET", path);
    try {
      await expect(BrokerClient.connect(path, "invalid")).rejects.toThrow(
        "Invalid broker credential",
      );
      await expect(
        withBrokerMaintenance(async () => {
          events.push("plain-login");
          throw new Error("login cancelled");
        }),
      ).rejects.toThrow("login cancelled");
    } finally {
      vi.unstubAllEnvs();
      await broker.close();
      await rm(root, { recursive: true, force: true });
    }
    expect(events).toEqual(["connect:maintain", "plain-login", "close", "disconnect"]);
  });

  it("refuses plain login while live sessions still own the browser", async () => {
    const root = await mkdtemp(join(tmpdir(), "ts-maint-busy-"));
    const path = join(root, "b.sock");
    const events: string[] = [];
    const broker = await listenBroker(path, {
      authenticate: async () => ({ accountId: "account", agentId: "connect" }),
      connected: async () => ({ maintenance: "draining" }),
      call: async (_principal, method) => {
        events.push(method);
        return { state: "draining" };
      },
      disconnect: async () => {
        events.push("disconnect");
      },
    });
    vi.stubEnv("TRUSTY_SQUIRE_BROKER_SOCKET", path);
    try {
      await expect(withBrokerMaintenance(async () => "plain-login")).rejects.toThrow(
        "Active workflows still own the browser",
      );
    } finally {
      vi.unstubAllEnvs();
      await broker.close();
      await rm(root, { recursive: true, force: true });
    }
    expect(events).toEqual(["disconnect"]);
  });
});

it("runs plain login over an endpoint whose broker no longer answers", async () => {
  const root = await mkdtemp(join(tmpdir(), "ts-maint-handshake-loss-"));
  const profile = join(root, "profile");
  const path = join(root, "b.sock");
  await mkdir(profile);
  const server = createServer((socket) => {
    socket.destroy();
    server.close();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
  vi.stubEnv("TRUSTY_SQUIRE_BROKER_SOCKET", path);
  vi.stubEnv("TRUSTY_SQUIRE_PROFILE_DIR", profile);
  try {
    vi.resetModules();
    const { withBrokerMaintenance: recoverMaintenance } = await import("../broker/maintenance.js");
    await expect(recoverMaintenance(async () => "plain-login")).resolves.toBe("plain-login");
  } finally {
    vi.unstubAllEnvs();
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("runs plain login without a broker endpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "ts-maint-none-"));
  vi.stubEnv("TRUSTY_SQUIRE_BROKER_SOCKET", join(root, "absent.sock"));
  try {
    expect(await lstat(join(root, "absent.sock")).catch(() => null)).toBeNull();
    await expect(withBrokerMaintenance(async () => "plain-login")).resolves.toBe("plain-login");
  } finally {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});