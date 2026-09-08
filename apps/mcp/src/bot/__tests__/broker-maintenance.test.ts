import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
vi.mock("../../session-guard.js", () => ({
  createSessionGuard: () => ({ bind: async () => ({ agent_session_token: "test" }) }),
}));
import { withBrokerMaintenance } from "../broker/maintenance.js";
import { listenBroker } from "../broker/transport.js";

describe("plain-login broker maintenance", () => {
  it("drains before running plain login, retains the connection, and resumes even when login fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "ts-maint-"));
    const path = join(root, "b.sock");
    const events: string[] = [];
    let probes = 0;
    const broker = await listenBroker(path, {
      authenticate: async () => ({ accountId: "account", agentId: "connect" }),
      call: async (_principal, method) => {
        events.push(method);
        return {
          state: method === "maintenance" ? (++probes === 1 ? "draining" : "ready") : "resumed",
        };
      },
      disconnect: async () => {
        events.push("disconnect");
      },
    });
    vi.stubEnv("TRUSTY_SQUIRE_BROKER_SOCKET", path);
    vi.stubEnv("TRUSTY_SQUIRE_FORWARDER_CREDENTIAL", "a".repeat(43));
    try {
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
    expect(events).toEqual(["maintenance", "maintenance", "plain-login", "resume", "disconnect"]);
  });
});

it("reclaims a verified stale endpoint before the plain login lifecycle", async () => {
  const root = await mkdtemp(join(tmpdir(), "ts-maint-stale-"));
  const profile = join(root, "profile");
  const path = join(root, "b.sock");
  await mkdir(profile);
  await writeFile(path, "stale endpoint");
  const socket = await lstat(path);
  await writeFile(
    `${path}.owner.json`,
    JSON.stringify({
      version: 1,
      pid: process.pid,
      start_time: "not-this-process",
      profileDir: profile,
      inode: socket.ino,
      device: socket.dev,
    }),
  );
  vi.stubEnv("TRUSTY_SQUIRE_BROKER_SOCKET", path);
  vi.stubEnv("TRUSTY_SQUIRE_FORWARDER_CREDENTIAL", "a".repeat(43));
  vi.stubEnv("TRUSTY_SQUIRE_PROFILE_DIR", profile);
  try {
    vi.resetModules();
    const { withBrokerMaintenance: recoverMaintenance } = await import("../broker/maintenance.js");
    await expect(recoverMaintenance(async () => "plain-login")).resolves.toBe("plain-login");
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(`${path}.owner.json`)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});

it("refuses stale-endpoint reclamation while its broker owner is live", async () => {
  const root = await mkdtemp(join(tmpdir(), "ts-maint-live-"));
  const profile = join(root, "profile");
  const path = join(root, "b.sock");
  await mkdir(profile);
  vi.stubEnv("TRUSTY_SQUIRE_BROKER_SOCKET", path);
  vi.stubEnv("TRUSTY_SQUIRE_FORWARDER_CREDENTIAL", "a".repeat(43));
  vi.stubEnv("TRUSTY_SQUIRE_PROFILE_DIR", profile);
  try {
    vi.resetModules();
    const { processBirthIdentity } = await import("../profile.js");
    const birth = processBirthIdentity(process.pid);
    expect(birth).not.toBeNull();
    if (birth === null) throw new Error("Process birth identity is unavailable");
    await writeFile(path, "live endpoint");
    const socket = await lstat(path);
    await writeFile(
      `${path}.owner.json`,
      JSON.stringify({
        version: 1,
        ...birth,
        profileDir: profile,
        inode: socket.ino,
        device: socket.dev,
      }),
    );
    const { withBrokerMaintenance: recoverMaintenance } = await import("../broker/maintenance.js");
    let plainLoginCalled = false;
    await expect(
      recoverMaintenance(async () => {
        plainLoginCalled = true;
      }),
    ).rejects.toThrow("Endpoint belongs to a live or unproven broker");
    expect(plainLoginCalled).toBe(false);
    await expect(lstat(path)).resolves.toBeDefined();
    await expect(lstat(`${path}.owner.json`)).resolves.toBeDefined();
  } finally {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});
