import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { OperatorForwarder } from "../broker/forwarder.js";
import { BrokerClient, listenBroker } from "../broker/transport.js";
import type { SessionGuard } from "../../session-guard.js";

describe("MCP broker forwarding", () => {
  it("returns a lost payment outcome without redispatching its request key", async () => {
    const root = await mkdtemp(join(tmpdir(), "ts-forward-reconcile-"));
    const path = join(root, "b.sock");
    const paymentRequest = "payment-request";
    let paymentDispatches = 0;
    let outcomeRecorded = false;
    let releasePayment!: () => void;
    let paymentEntered!: () => void;
    let paymentRecorded!: () => void;
    const paymentGate = new Promise<void>((resolve) => {
      releasePayment = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      paymentEntered = resolve;
    });
    const recorded = new Promise<void>((resolve) => {
      paymentRecorded = resolve;
    });
    const acknowledgements: string[] = [];
    const broker = await listenBroker(path, {
      authenticate: async () => ({ accountId: "account", agentId: "agent" }),
      call: async (_principal, method, params, requestId) => {
        if (method === "reconcile")
          return {
            outcomes: outcomeRecorded
              ? [{ sessionId: "session", requestId: paymentRequest, operation: "operate_pay" }]
              : [],
          };
        if (method === "acknowledge") {
          acknowledgements.push(String(params.requestId));
          return {};
        }
        if (params.name === "operate_start")
          return {
            capability: {
              cellId: "cell",
              browserEpoch: "epoch",
              sessionId: "session",
              targetId: "target",
              leaseGeneration: "one",
            },
            result: { session_id: "session" },
          };
        if (params.name === "operate_pay" && requestId === paymentRequest) {
          if (outcomeRecorded)
            return {
              result: {
                reconciliation: {
                  request_id: paymentRequest,
                  operation: "operate_pay",
                  outcome: "completed",
                },
              },
            };
          paymentDispatches++;
          paymentEntered();
          await paymentGate;
          outcomeRecorded = true;
          paymentRecorded();
          return { result: { charged: true } };
        }
        throw new Error(`Unexpected ${method}`);
      },
      disconnect: async () => undefined,
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
    const forwarder = new OperatorForwarder(path, guard);
    let lostClient: BrokerClient | undefined;
    try {
      await forwarder.invoke("operate_start", {}, "start-request");
      await expect.poll(() => acknowledgements).toEqual(["start-request"]);
      acknowledgements.length = 0;
      lostClient = await BrokerClient.connect(path, "test");
      const lost = lostClient.call(
        "tool",
        { name: "operate_pay", args: { session_id: "session" } },
        paymentRequest,
      );
      await entered;
      await lostClient.close();
      releasePayment();
      await recorded;
      await expect(lost).rejects.toThrow("connection lost");
      await expect(
        forwarder.invoke("operate_pay", { session_id: "session" }, paymentRequest),
      ).resolves.toEqual({
        reconciliation: {
          request_id: paymentRequest,
          operation: "operate_pay",
          outcome: "completed",
        },
      });
      expect(paymentDispatches).toBe(1);
      await expect.poll(() => acknowledgements).toEqual([paymentRequest]);
    } finally {
      await lostClient?.close();
      await forwarder.close();
      await broker.close();
      await rm(root, { recursive: true, force: true });
    }
  });

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
    let brokerClosed = false;
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
      const rejected = new OperatorForwarder(path, {
        ...guard,
        bind: async () => null,
      });
      await expect(rejected.invoke("operate_start", {})).rejects.toThrow("Connect before");
      expect(rejected.connected()).toBe(false);
      await expect(rejected.close()).resolves.toBeUndefined();
      expect(a.connected()).toBe(true);
      await broker.close();
      brokerClosed = true;
      await expect.poll(() => a.connected(), { timeout: 1_000 }).toBe(false);
    } finally {
      await a.close();
      await b.close();
      if (!brokerClosed) await broker.close();
      expect(clients.size).toBe(0);
      await rm(root, { recursive: true, force: true });
    }
  });
});
