import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { ForwardedResultError, OperatorForwarder } from "../broker/forwarder.js";
import { listenBroker } from "../broker/transport.js";
import { BrokerRefusal } from "../broker/refusal.js";
import type { SessionGuard } from "../../session-guard.js";
import { ProvenPreDispatchMutationError } from "../mutation-dispatch-evidence.js";

const guard = {
  bind: async () => ({
    account_id: "account",
    agent_session_token: "test",
    api_base_url: "http://unused.test",
    saved_at: "",
  }),
  inspect: async () => ({ problem: null }),
  boundAccountId: () => "account",
} as unknown as SessionGuard;

async function withBroker<T>(
  prefix: string,
  call: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  run: (path: string) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const path = join(root, "b.sock");
  const broker = await listenBroker(path, {
    authenticate: async () => ({ accountId: "account", agentId: "agent" }),
    call: async (_principal, method, params) => await call(method, params),
    disconnect: async () => undefined,
  });
  try {
    return await run(path);
  } finally {
    await broker.close();
    await rm(root, { recursive: true, force: true });
  }
}

describe("MCP broker forwarding over the Contract B wire", () => {
  it("opens a session, tracks it, and fills it into later commands", async () => {
    const seen: { method: string; params: Record<string, unknown> }[] = [];
    await withBroker(
      "ts-forward-start-",
      async (method, params) => {
        seen.push({ method, params });
        if (method === "open")
          return { sessionId: "session-one", observation: { session_id: "session-one" } };
        return { result: { ok: true } };
      },
      async (path) => {
        const forwarder = new OperatorForwarder(path, guard);
        try {
          expect(await forwarder.invoke("operate_start", {}, "start")).toEqual({
            session_id: "session-one",
          });
          expect(forwarder.sessionCount()).toBe(1);
          expect(await forwarder.invoke("operate_observe", {}, "observe")).toEqual({ ok: true });
          expect(seen[0]).toMatchObject({ method: "open" });
          expect(seen[1]).toMatchObject({
            method: "command",
            params: {
              sessionId: "session-one",
              name: "operate_observe",
              args: { session_id: "session-one" },
            },
          });
        } finally {
          await forwarder.close();
        }
      },
    );
  });

  it("refuses a session this connection does not own without contacting the broker", async () => {
    let calls = 0;
    await withBroker(
      "ts-forward-foreign-",
      async () => {
        calls += 1;
        return { result: {} };
      },
      async (path) => {
        const forwarder = new OperatorForwarder(path, guard);
        try {
          await expect(
            forwarder.invoke("operate_click", { session_id: "not-mine" }, "click"),
          ).rejects.toMatchObject({ code: "stale_lease" });
          expect(calls).toBe(0);
        } finally {
          await forwarder.close();
        }
      },
    );
  });

  it("delivers a proven pre-dispatch failure as a retryable mutation error", async () => {
    await withBroker(
      "ts-forward-predispatch-",
      async (method) =>
        method === "open"
          ? { sessionId: "session-one", observation: { session_id: "session-one" } }
          : { preDispatchFailure: { error: "stale_ref", dispatch: "not_dispatched" } },
      async (path) => {
        const forwarder = new OperatorForwarder(path, guard);
        try {
          await forwarder.invoke("operate_start", {}, "start");
          await expect(forwarder.invoke("operate_click", {}, "click")).rejects.toBeInstanceOf(
            ProvenPreDispatchMutationError,
          );
        } finally {
          await forwarder.close();
        }
      },
    );
  });

  it("rejects a malformed open reply", async () => {
    await withBroker(
      "ts-forward-badstart-",
      async () => ({ sessionId: "session-one", observation: { session_id: "other-session" } }),
      async (path) => {
        const forwarder = new OperatorForwarder(path, guard);
        try {
          await expect(forwarder.invoke("operate_start", {}, "start")).rejects.toBeInstanceOf(
            ForwardedResultError,
          );
        } finally {
          await forwarder.close();
        }
      },
    );
  });

  it("keeps matching request ids on separate connections independent", async () => {
    await withBroker(
      "ts-forward-namespace-",
      async (method, params) => ({
        sessionId: "session-one",
        observation: { session_id: "session-one", service: method },
        result: params,
      }),
      async (path) => {
        const first = new OperatorForwarder(path, guard);
        const second = new OperatorForwarder(path, guard);
        try {
          const [a, b] = await Promise.all([
            first.invoke("operate_start", {}, "same-id"),
            second.invoke("operate_start", {}, "same-id"),
          ]);
          expect(a).toMatchObject({ session_id: "session-one" });
          expect(b).toMatchObject({ session_id: "session-one" });
        } finally {
          await first.close();
          await second.close();
        }
      },
    );
  });

  it("drops a finished session and refuses to reuse it afterwards", async () => {
    await withBroker(
      "ts-forward-finish-",
      async (method) =>
        method === "open"
          ? { sessionId: "session-one", observation: { session_id: "session-one" } }
          : { closed: true, result: { closed: true } },
      async (path) => {
        const forwarder = new OperatorForwarder(path, guard);
        try {
          await forwarder.invoke("operate_start", {}, "start");
          await forwarder.invoke("operate_finish", { session_id: "session-one" }, "finish");
          expect(forwarder.sessionCount()).toBe(0);
          await expect(
            forwarder.invoke("operate_observe", { session_id: "session-one" }, "observe"),
          ).rejects.toBeInstanceOf(BrokerRefusal);
        } finally {
          await forwarder.close();
        }
      },
    );
  });

  it("reports broker loss on an in-flight call without replaying it", async () => {
    const root = await mkdtemp(join(tmpdir(), "ts-forward-lost-"));
    const path = join(root, "b.sock");
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const broker = await listenBroker(path, {
      authenticate: async () => ({ accountId: "account", agentId: "agent" }),
      call: async () => {
        entered();
        return await new Promise<never>(() => undefined);
      },
      disconnect: async () => undefined,
    });
    const forwarder = new OperatorForwarder(path, guard);
    try {
      const call = forwarder.invoke("operate_start", {}, "start");
      const rejected = expect(call).rejects.toMatchObject({ code: "broker_lost" });
      await started;
      await broker.close();
      await rejected;
    } finally {
      await forwarder.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});