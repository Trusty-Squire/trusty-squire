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

  it("waits out live sessions and opens the window once they end", async () => {
    const root = await mkdtemp(join(tmpdir(), "ts-maint-busy-"));
    const path = join(root, "b.sock");
    const events: string[] = [];
    let connects = 0;
    const broker = await listenBroker(path, {
      authenticate: async () => ({ accountId: "account", agentId: "connect" }),
      connected: async () => {
        // A browser another session still owns is never closed underneath it;
        // the plain-login owner retries until those sessions end.
        connects += 1;
        return connects === 1 ? { maintenance: "draining" } : { maintenance: "ready" };
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
    vi.stubEnv("TRUSTY_SQUIRE_MAINTENANCE_DRAIN_WAIT_MS", "5000");
    try {
      await expect(
        withBrokerMaintenance(async () => {
          events.push("plain-login");
          return "plain-login";
        }),
      ).resolves.toBe("plain-login");
    } finally {
      vi.unstubAllEnvs();
      await broker.close();
      await rm(root, { recursive: true, force: true });
    }
    expect(connects).toBe(2);
    // The draining connection is dropped without claiming the window; the
    // retry is what opens it, and the lease boundary closes it.
    expect(events).toContain("plain-login");
    expect(events).toContain("close");
  });

  it("still waits out live sessions when the drain-wait variable is blank", async () => {
    // Blanking an env var is how a shell profile or an MCP config env block
    // neutralizes it. That must mean "unset" — coercing it to a zero deadline
    // would make the first `draining` answer fatal again.
    const root = await mkdtemp(join(tmpdir(), "ts-maint-blank-"));
    const path = join(root, "b.sock");
    let connects = 0;
    const broker = await listenBroker(path, {
      authenticate: async () => ({ accountId: "account", agentId: "connect" }),
      connected: async () => {
        connects += 1;
        return connects === 1 ? { maintenance: "draining" } : { maintenance: "ready" };
      },
      call: async () => ({ closed: true }),
      disconnect: async () => undefined,
    });
    vi.stubEnv("TRUSTY_SQUIRE_BROKER_SOCKET", path);
    vi.stubEnv("TRUSTY_SQUIRE_MAINTENANCE_DRAIN_WAIT_MS", "");
    try {
      await expect(withBrokerMaintenance(async () => "plain-login")).resolves.toBe("plain-login");
    } finally {
      vi.unstubAllEnvs();
      await broker.close();
      await rm(root, { recursive: true, force: true });
    }
    expect(connects).toBe(2);
  });

  it("reports the profile when live sessions never release the browser", async () => {
    const root = await mkdtemp(join(tmpdir(), "ts-maint-stuck-"));
    const path = join(root, "b.sock");
    const profile = join(root, "profile");
    await mkdir(profile, { recursive: true });
    let connects = 0;
    const broker = await listenBroker(path, {
      authenticate: async () => ({ accountId: "account", agentId: "connect" }),
      connected: async () => {
        connects += 1;
        return { maintenance: "draining" };
      },
      call: async () => ({ closed: true }),
      disconnect: async () => undefined,
    });
    vi.stubEnv("TRUSTY_SQUIRE_BROKER_SOCKET", path);
    // The deadline is the retry bound; zero makes the first `draining` final.
    vi.stubEnv("TRUSTY_SQUIRE_MAINTENANCE_DRAIN_WAIT_MS", "0");
    try {
      await expect(withBrokerMaintenance(async () => "plain-login")).rejects.toThrow(
        /still using the shared browser for .*profile; finish it and retry/,
      );
    } finally {
      vi.unstubAllEnvs();
      await broker.close();
      await rm(root, { recursive: true, force: true });
    }
    expect(connects).toBe(1);
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
