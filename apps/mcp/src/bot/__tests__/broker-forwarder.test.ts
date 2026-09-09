import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { OperatorForwarder } from "../broker/forwarder.js";
import { listenBroker } from "../broker/transport.js";
import type { BrokerClient } from "../broker/transport.js";
import type { SessionGuard } from "../../session-guard.js";
import { ProvenPreDispatchMutationError } from "../mutation-dispatch-evidence.js";

const credential = (character: string) => character.repeat(43);

describe("MCP broker forwarding", () => {
  it("acknowledges a delivered pre-dispatch failure before rejecting it", async () => {
    const root = await mkdtemp(join(tmpdir(), "ts-forward-pre-dispatch-"));
    const path = join(root, "b.sock");
    const acknowledgements: string[] = [];
    const capability = {
      cellId: "cell",
      browserEpoch: "epoch",
      sessionId: "session",
      targetId: "target",
      leaseGeneration: "one",
    };
    const broker = await listenBroker(path, {
      authenticate: async () => ({ accountId: "account", agentId: "agent" }),
      call: async (_principal, method, params, requestId) => {
        if (method === "reclaim") return { capabilities: [] };
        if (method === "confirm_start") return {};
        if (method === "acknowledge") {
          acknowledgements.push(String(params.requestId));
          return {};
        }
        if (params.name === "operate_start")
          return { capability, result: { session_id: capability.sessionId } };
        if (params.name === "operate_login")
          return {
            preDispatchFailure: { error: "stale_ref", dispatch: "not_dispatched" },
          };
        if (params.name === "operate_observe") return { result: { dom: "still available" } };
        throw new Error(`Unexpected ${method}:${requestId}`);
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
    const forwarder = new OperatorForwarder(path, guard, credential("a"));
    try {
      await forwarder.invoke("operate_start", {}, "start");
      await expect(
        forwarder.invoke(
          "operate_login",
          { session_id: "session", provider: "google", ref: "@e:changed" },
          "login",
        ),
      ).rejects.toBeInstanceOf(ProvenPreDispatchMutationError);
      expect(acknowledgements).toHaveLength(2);
      await expect(
        forwarder.invoke("operate_observe", { session_id: "session" }, "observe"),
      ).resolves.toEqual({ dom: "still available" });
    } finally {
      await forwarder.close();
      await broker.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("waits for broker acknowledgement before resolving a forwarded call", async () => {
    const root = await mkdtemp(join(tmpdir(), "ts-forward-ack-"));
    const path = join(root, "b.sock");
    let release!: () => void;
    let acknowledged = false;
    const persisted = new Promise<void>((resolve) => {
      release = resolve;
    });
    const broker = await listenBroker(path, {
      authenticate: async () => ({ accountId: "account", agentId: "agent" }),
      call: async (_principal, method) => {
        if (method === "recover") return null;
        if (method === "acknowledge") {
          acknowledged = true;
          await persisted;
          return {};
        }
        return { result: { accepted: true } };
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
    const forwarder = new OperatorForwarder(path, guard, credential("a"));
    try {
      let settled = false;
      const invocation = forwarder.invoke("operate_recipe_run", {}, "request").then((result) => {
        settled = true;
        return result;
      });
      await expect.poll(() => acknowledged).toBe(true);
      expect(settled).toBe(false);
      release();
      await expect(invocation).resolves.toEqual({ accepted: true });
    } finally {
      await forwarder.close();
      await broker.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns a lost payment outcome without redispatching its request key", async () => {
    const root = await mkdtemp(join(tmpdir(), "ts-forward-reconcile-"));
    const path = join(root, "b.sock");
    let paymentRequest = "";
    const capability = {
      cellId: "cell",
      browserEpoch: "epoch",
      sessionId: "session",
      targetId: "target",
      leaseGeneration: "one",
    };
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
        if (method === "reclaim") return { capabilities: [capability] };
        if (method === "confirm_start") return {};
        if (method === "recover") {
          expect(params).toMatchObject({ name: "operate_pay", args: { session_id: "session" } });
          expect(params).not.toHaveProperty("callerRequestHash");
          return outcomeRecorded && params.name === "operate_pay"
            ? {
                requestId: paymentRequest,
                result: {
                  reconciliation: {
                    request_id: paymentRequest,
                    operation: "operate_pay",
                    status: "payment_3ds_required",
                    next: { tool: "operate_payment_status", wait_seconds: 0 },
                  },
                },
              }
            : null;
        }
        if (method === "acknowledge") {
          acknowledgements.push(String(params.requestId));
          return {};
        }
        if (params.name === "operate_start")
          return {
            capability,
            result: { session_id: "session" },
          };
        if (params.name === "operate_pay") {
          paymentRequest = requestId;
          paymentDispatches++;
          paymentEntered();
          await paymentGate;
          outcomeRecorded = true;
          paymentRecorded();
          return {
            result: {
              status: "payment_3ds_required",
              next: { tool: "operate_payment_status", wait_seconds: 0 },
            },
          };
        }
        if (params.name === "operate_payment_status") {
          if (requestId === paymentRequest)
            throw new Error("restarted status reused the payment request key");
          return { result: { status: "completed" } };
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
    const forwarder = new OperatorForwarder(path, guard, credential("a"));
    const restarted = new OperatorForwarder(path, guard, credential("a"));
    try {
      await forwarder.invoke("operate_start", {}, "start-request");
      await expect.poll(() => acknowledgements).toHaveLength(1);
      acknowledgements.length = 0;
      const lost = forwarder.invoke("operate_pay", { session_id: "session" }, "7");
      await entered;
      await (forwarder as unknown as { client?: BrokerClient }).client?.close();
      releasePayment();
      await recorded;
      await expect(lost).rejects.toThrow("connection lost");
      await expect(
        restarted.invoke("operate_pay", { session_id: "session" }, "reset-payment-id", {
          recover: true,
        }),
      ).resolves.toEqual({
        reconciliation: {
          request_id: paymentRequest,
          operation: "operate_pay",
          status: "payment_3ds_required",
          next: { tool: "operate_payment_status", wait_seconds: 0 },
        },
      });
      await expect(
        restarted.invoke("operate_payment_status", { session_id: "session" }, "7"),
      ).resolves.toEqual({ status: "completed" });
      expect(paymentDispatches).toBe(1);
      await expect.poll(() => acknowledgements).toContain(paymentRequest);
    } finally {
      await forwarder.close();
      await restarted.close();
      await broker.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires an explicit recovery signal before reusing a reset request ID", async () => {
    const root = await mkdtemp(join(tmpdir(), "ts-forward-explicit-recovery-"));
    const path = join(root, "b.sock");
    const capability = {
      cellId: "cell",
      browserEpoch: "epoch",
      sessionId: "session",
      targetId: "target",
      leaseGeneration: "one",
    };
    let recoveries = 0;
    let dispatches = 0;
    const broker = await listenBroker(path, {
      authenticate: async () => ({ accountId: "account", agentId: "agent" }),
      call: async (_principal, method, params) => {
        if (method === "reclaim") return { capabilities: [capability] };
        if (method === "confirm_start") return {};
        if (method === "acknowledge") return {};
        if (method === "recover") {
          recoveries++;
          expect(params).not.toHaveProperty("callerRequestHash");
          return {
            requestId: "prior-broker-request",
            result: {
              reconciliation: {
                request_id: "prior-broker-request",
                operation: "operate_click",
                status: "completed",
              },
            },
          };
        }
        dispatches++;
        expect(params).toMatchObject({ name: "operate_click", capability });
        return { result: { dispatched: true } };
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
    const forwarder = new OperatorForwarder(path, guard, credential("a"));
    try {
      await expect(
        forwarder.invoke("operate_click", { session_id: "session", ref: "@continue" }, "1"),
      ).resolves.toEqual({ dispatched: true });
      expect(recoveries).toBe(0);
      expect(dispatches).toBe(1);
      await expect(
        forwarder.invoke(
          "operate_click",
          { session_id: "session", ref: "@continue" },
          "reset-click-id",
          { recover: true },
        ),
      ).resolves.toMatchObject({ reconciliation: { request_id: "prior-broker-request" } });
      expect(recoveries).toBe(1);
      expect(dispatches).toBe(1);
    } finally {
      await forwarder.close();
      await broker.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("recovers a lost start reply without opening another session", async () => {
    const root = await mkdtemp(join(tmpdir(), "ts-forward-start-recovery-"));
    const path = join(root, "b.sock");
    const capability = {
      cellId: "cell",
      browserEpoch: "epoch",
      sessionId: "session",
      targetId: "target",
      leaseGeneration: "one",
    };
    let starts = 0;
    let startEntered!: () => void;
    let releaseStart!: () => void;
    const entered = new Promise<void>((resolve) => {
      startEntered = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const acknowledgements: string[] = [];
    const broker = await listenBroker(path, {
      authenticate: async () => ({ accountId: "account", agentId: "agent" }),
      call: async (_principal, method, params) => {
        if (method === "reclaim") return { capabilities: starts === 0 ? [] : [capability] };
        if (method === "confirm_start") return {};
        if (method === "acknowledge") {
          acknowledgements.push(String(params.requestId));
          return {};
        }
        if (method === "recover") {
          expect(params).toMatchObject({ name: "operate_start", args: {} });
          expect(params).not.toHaveProperty("callerRequestHash");
          return {
            requestId: "lost-start-request",
            capability,
            result: { session_id: "session", broker: { targetId: "target" } },
          };
        }
        if (params.name === "operate_start") {
          starts++;
          startEntered();
          await released;
          return { capability, result: { session_id: "session" } };
        }
        if (params.name === "operate_observe")
          return { result: { session_id: "session", dom: "ready" } };
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
    const forwarder = new OperatorForwarder(path, guard, credential("a"));
    const restarted = new OperatorForwarder(path, guard, credential("a"));
    try {
      const lost = forwarder.invoke("operate_start", {}, "1");
      await entered;
      await (forwarder as unknown as { client?: BrokerClient }).client?.close();
      releaseStart();
      await expect(lost).rejects.toThrow("connection lost");
      await expect(
        restarted.invoke("operate_start", {}, "reset-start-id", { recover: true }),
      ).resolves.toMatchObject({
        session_id: "session",
      });
      await expect(
        restarted.invoke("operate_observe", { session_id: "session" }, "2"),
      ).resolves.toMatchObject({
        dom: "ready",
      });
      expect(starts).toBe(1);
      expect(restarted.sessionCount()).toBe(1);
      expect(acknowledgements).toEqual(["lost-start-request", expect.any(String)]);
    } finally {
      await forwarder.close();
      await restarted.close();
      await broker.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("replaces stale local sessions when a new broker reclaims none", async () => {
    const root = await mkdtemp(join(tmpdir(), "ts-forward-replacement-"));
    const path = join(root, "b.sock");
    let starts = 0;
    const broker = await listenBroker(path, {
      authenticate: async () => ({ accountId: "account", agentId: "agent" }),
      call: async (_principal, method, params) => {
        if (method === "reclaim") return { capabilities: [] };
        if (method === "acknowledge") return {};
        if (method === "confirm_start") return {};
        if (params.name === "operate_start") {
          starts += 1;
          const sessionId = `session-${starts}`;
          return {
            capability: {
              cellId: "cell",
              browserEpoch: "epoch",
              sessionId,
              targetId: sessionId,
              leaseGeneration: "one",
            },
            result: { session_id: sessionId },
          };
        }
        if (params.name === "operate_observe") {
          expect(params).toMatchObject({ args: { session_id: "session-2" } });
          return { result: { dom: "second broker" } };
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
    const forwarder = new OperatorForwarder(path, guard, credential("a"));
    try {
      await forwarder.invoke("operate_start", {}, "first-start");
      await (forwarder as unknown as { client?: BrokerClient }).client?.close();
      await forwarder.invoke("operate_start", {}, "second-start");

      expect(forwarder.sessionCount()).toBe(1);
      await expect(forwarder.invoke("operate_observe", {}, "observe")).resolves.toEqual({
        dom: "second broker",
      });
    } finally {
      await forwarder.close();
      await broker.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("namespaces matching MCP request IDs across independent clients", async () => {
    const root = await mkdtemp(join(tmpdir(), "ts-forward-keys-"));
    const path = join(root, "b.sock");
    const requests = new Set<string>();
    let dispatches = 0;
    const broker = await listenBroker(path, {
      authenticate: async () => ({ accountId: "account", agentId: "local-agent" }),
      call: async (_principal, method, _params, requestId) => {
        if (method === "recover") return null;
        if (method === "acknowledge") return {};
        if (method === "reclaim") return { capabilities: [] };
        if (requests.has(requestId))
          return {
            result: {
              reconciliation: { request_id: requestId, operation: "operate_recipe_run" },
            },
          };
        requests.add(requestId);
        dispatches++;
        return { result: { dispatched: requestId } };
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
    const forwarders = [
      new OperatorForwarder(path, guard, credential("a")),
      new OperatorForwarder(path, guard, credential("b")),
      new OperatorForwarder(path, guard, credential("c")),
    ];
    try {
      const results = await Promise.all(
        forwarders.map(async (forwarder) => await forwarder.invoke("operate_recipe_run", {}, "7")),
      );
      expect(results).toHaveLength(3);
      expect(dispatches).toBe(3);
      expect(requests.size).toBe(3);
    } finally {
      await Promise.all(forwarders.map(async (forwarder) => await forwarder.close()));
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
      call: async (principal, method, params) => {
        if (method === "reclaim") return { capabilities: [] };
        if (method === "confirm_start") return {};
        if (method === "acknowledge") return {};
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
    const a = new OperatorForwarder(path, guard, credential("a")),
      b = new OperatorForwarder(path, guard, credential("b"));
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
      const rejected = new OperatorForwarder(
        path,
        {
          ...guard,
          bind: async () => null,
        },
        credential("c"),
      );
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
