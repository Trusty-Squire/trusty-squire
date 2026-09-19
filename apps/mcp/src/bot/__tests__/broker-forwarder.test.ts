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
          expect(
            await forwarder.invoke(
              "operate_start",
              { service_url: "https://service.test" },
              "start",
            ),
          ).toEqual({
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
          await forwarder.invoke("operate_start", { service_url: "https://service.test" }, "start");
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
          await expect(
            forwarder.invoke("operate_start", { service_url: "https://service.test" }, "start"),
          ).rejects.toBeInstanceOf(ForwardedResultError);
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
            first.invoke("operate_start", { service_url: "https://service.test" }, "same-id"),
            second.invoke("operate_start", { service_url: "https://service.test" }, "same-id"),
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
          await forwarder.invoke("operate_start", { service_url: "https://service.test" }, "start");
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
      const call = forwarder.invoke(
        "operate_start",
        { service_url: "https://service.test" },
        "start",
      );
      const rejected = expect(call).rejects.toMatchObject({ code: "broker_lost" });
      await started;
      await broker.close();
      await rejected;
    } finally {
      await forwarder.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("replays the google_session wall on a refused-start id instead of stale_lease", async () => {
    const wall = {
      wall: "google_session",
      message:
        "No live Google session in your Chrome profile, so the operator cannot act as you yet. " +
        "Reconnect with `npx @trusty-squire/mcp connect --force-relogin=google` and retry " +
        "— the task has NOT started and nothing was changed.",
      resume: "connect" as const,
    };
    let calls = 0;
    await withBroker(
      "ts-forward-refused-start-",
      async (method, params) => {
        calls += 1;
        if (method === "open")
          return {
            observation: {
              session_id: "refused-one",
              format: "browser-use-dom",
              stage: "auth",
              url: "",
              needs_user: wall,
            },
          };
        return { result: params };
      },
      async (path) => {
        const forwarder = new OperatorForwarder(path, guard);
        try {
          const started = (await forwarder.invoke(
            "operate_start",
            { service_url: "https://service.test" },
            "start",
          )) as { session_id: string; needs_user: typeof wall };
          expect(started).toMatchObject({
            session_id: "refused-one",
            needs_user: { wall: "google_session", resume: "connect" },
          });
          expect(forwarder.sessionCount()).toBe(0);
          const observeCalls = calls;
          await expect(
            forwarder.invoke("operate_observe", { session_id: started.session_id }, "observe"),
          ).resolves.toMatchObject({
            session_id: "refused-one",
            needs_user: { wall: "google_session", resume: "connect", message: wall.message },
          });
          expect(calls).toBe(observeCalls);
          const finished = await forwarder.invoke(
            "operate_finish",
            { session_id: started.session_id },
            "finish",
          );
          expect(finished).toMatchObject({
            session_id: "refused-one",
            closed: true,
            mutation: "not_dispatched",
            cleanup: "closed",
            execution: "completed",
          });
          await expect(
            forwarder.invoke("operate_observe", { session_id: started.session_id }, "observe"),
          ).rejects.toMatchObject({ code: "stale_lease" });
        } finally {
          await forwarder.close();
        }
      },
    );
  });

  it("replays and finishes a refused drive-open without dispatching commands", async () => {
    const observation = { session_id: "drive-refused", needs_user: { wall: "google_session", message: "Connect first", resume: "connect" } };
    const seen: string[] = [];
    await withBroker("ts-drive-wall-", async (method) => {
      seen.push(method);
      return { observation };
    }, async (path) => {
      const forwarder = new OperatorForwarder(path, guard);
      try {
        await expect(forwarder.invoke("operate_drive", { url: "https://signup.test", goal: "sign up" }, "drive-wall")).resolves.toMatchObject({ status: "needs_value", field: "google_session", observation, steps: 0 });
        expect(forwarder.sessionCount()).toBe(0);
        await expect(forwarder.invoke("operate_observe", { session_id: "drive-refused" }, "wall-observe")).resolves.toEqual(observation);
        await expect(forwarder.invoke("operate_finish", { session_id: "drive-refused" }, "wall-finish")).resolves.toMatchObject({ closed: true, mutation: "not_dispatched", cleanup: "closed" });
        expect(seen).toEqual(["open"]);
        await expect(forwarder.invoke("operate_observe", { session_id: "drive-refused" }, "after-finish")).rejects.toMatchObject({ code: "stale_lease" });
      } finally { await forwarder.close(); }
    });
  });

  it("opens then commands when operate_drive is given a url instead of a session", async () => {
    const seen: { method: string; params: Record<string, unknown> }[] = [];
    await withBroker(
      "ts-forward-drive-",
      async (method, params) => {
        seen.push({ method, params });
        if (method === "open")
          return { sessionId: "session-drive", observation: { session_id: "session-drive" } };
        return { result: { status: "budget", session_id: "session-drive" } };
      },
      async (path) => {
        const forwarder = new OperatorForwarder(path, guard);
        try {
          expect(
            await forwarder.invoke(
              "operate_drive",
              { url: "https://signup.test/", goal: "create an account" },
              "drive",
            ),
          ).toEqual({ status: "budget", session_id: "session-drive" });
          expect(seen[0]).toMatchObject({
            method: "open",
            params: { serviceUrl: "https://signup.test/" },
          });
          expect(seen[1]).toMatchObject({
            method: "command",
            params: {
              sessionId: "session-drive",
              name: "operate_drive",
              args: { session_id: "session-drive", goal: "create an account" },
            },
          });
        } finally {
          await forwarder.close();
        }
      },
    );
  });
});
