import { mkdtemp, rm } from "node:fs/promises";
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
