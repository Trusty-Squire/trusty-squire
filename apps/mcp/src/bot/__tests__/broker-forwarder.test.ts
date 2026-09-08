import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { OperatorForwarder } from "../broker/forwarder.js";
import { listenBroker } from "../broker/transport.js";
import type { SessionGuard } from "../../session-guard.js";

describe("MCP broker forwarding", () => {
  it("pins a connection's capabilities and forwards rendered secrets without masking", async () => {
    const root = await mkdtemp(join(tmpdir(), "ts-forward-"));
    const path = join(root, "b.sock");
    let calls = 0;
    const clients = new Set<string>();
    const broker = await listenBroker(path, {
      authenticate: async (token) =>
        token === "test" ? { accountId: "account", agentId: "agent" } : null,
      call: async (principal, _method, params) => {
        calls++;
        clients.add(principal.clientId);
        if (params.name === "operate_start") {
          const capability = {
            cellId: "cell",
            browserEpoch: "epoch",
            sessionId: principal.clientId,
            targetId: principal.clientId,
            leaseGeneration: "one",
          };
          return { capability, result: { session_id: principal.clientId } };
        }
        return { result: { dom: "| Access Key: fixture-visible-value" } };
      },
      disconnect: async (principal) => {
        clients.delete(principal.clientId);
      },
    });
    const guard: SessionGuard = {
      bind: async () => ({
        account_id: "account",
        agent_session_token: "test",
        api_base_url: "http://unused.test",
        saved_at: "",
      }),
      inspect: async () => ({ problem: null }),
      boundAccountId: () => "account",
    };
    const a = new OperatorForwarder(path, guard),
      b = new OperatorForwarder(path, guard);
    try {
      const first = (await a.invoke("operate_start", {})) as { session_id: string };
      const second = (await b.invoke("operate_start", {})) as { session_id: string };
      expect(first.session_id).not.toBe(second.session_id);
      const before = calls;
      await expect(b.invoke("operate_observe", { session_id: first.session_id })).rejects.toThrow(
        "not owned",
      );
      expect(calls).toBe(before);
      expect(await a.invoke("operate_observe", { session_id: first.session_id })).toEqual({
        dom: "| Access Key: fixture-visible-value",
      });
      await a.invoke("operate_finish", { session_id: first.session_id });
      expect(a.sessionCount()).toBe(0);
      expect(b.sessionCount()).toBe(1);
    } finally {
      await a.close();
      await b.close();
      await broker.close();
      expect(clients.size).toBe(0);
      await rm(root, { recursive: true, force: true });
    }
  });
});
