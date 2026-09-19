import { lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
vi.mock("../../session-guard.js", () => ({
  createSessionGuard: () => ({ bind: async () => ({ agent_session_token: "test" }) }),
}));
import { withBrokerMaintenance } from "../broker/maintenance.js";
import { profilePathIdentity } from "../profile.js";
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

  it("fails fast and names the profile whose browser is still owned", async () => {
    // Only a connect that genuinely needs the login ceremony reaches here, so a
    // busy browser is reported at once. The message must name the profile the
    // caller actually addressed — naming the process default instead is the
    // wrong-profile defect this whole path exists to fix, so the assertion is
    // the exact interpolated path, not any path that happens to say "profile".
    const root = await mkdtemp(join(tmpdir(), "ts-maint-stuck-"));
    const path = join(root, "b.sock");
    const profile = join(root, "profile");
    await mkdir(profile, { recursive: true });
    let connects = 0;
    let released = false;
    const broker = await listenBroker(path, {
      authenticate: async () => ({ accountId: "account", agentId: "connect" }),
      connected: async () => {
        connects += 1;
        return { maintenance: "draining" };
      },
      call: async () => {
        released = true;
        return { closed: true };
      },
      disconnect: async () => undefined,
    });
    vi.stubEnv("TRUSTY_SQUIRE_BROKER_SOCKET", path);
    vi.stubEnv("TRUSTY_SQUIRE_PROFILE_DIR", profile);
    let ran = false;
    try {
      await expect(
        withBrokerMaintenance(async () => {
          ran = true;
          return "plain-login";
        }),
      ).rejects.toThrow(
        `A Trusty Squire session is still using the shared browser for ` +
          `${profilePathIdentity(profile)}; finish it and retry. ` +
          `No operator command was dispatched`,
      );
    } finally {
      vi.unstubAllEnvs();
      await broker.close();
      await rm(root, { recursive: true, force: true });
    }
    // One attempt, no login, and the window was never claimed.
    expect(connects).toBe(1);
    expect(ran).toBe(false);
    expect(released).toBe(false);
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
