import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z, type Tool } from "../../tools/index.js";
import type { ApiClient } from "../../api-client.js";
import type { SessionGuard } from "../../session-guard.js";

interface SessionDouble {
  browser: {
    brokerTargetId(): Promise<string>;
    isConnected(): boolean;
    maskOperatorOutput?(value: unknown): unknown;
  };
  pendingThreeDs: null;
}

const state = vi.hoisted(() => ({
  sessions: new Map<string, SessionDouble>(),
  finish: vi.fn(),
  forceFinish: vi.fn(),
  nextId: 0,
  dispatches: 0,
}));

vi.mock("../session/lifecycle.js", () => ({
  sessionForCall: (sessionId: string) => state.sessions.get(sessionId),
  finishProvisionSession: state.finish,
  forceFinishProvisionSession: state.forceFinish,
  withProvisionSessionCall: async (_sessionId: string, operation: () => Promise<unknown>) =>
    await operation(),
}));

vi.mock("../provision-session.js", () => ({
  maskOperatorSessionOutput: (_sessionId: string, value: unknown) => value,
  preparePublicOAuthLoginTarget: async () => undefined,
  withPreparedOAuthLoginTarget: async (_prepared: unknown, operation: () => Promise<unknown>) =>
    await operation(),
}));

import { OperatorBroker } from "../broker/operator.js";
import { OperatorForwarder } from "../broker/forwarder.js";
import { listenBroker } from "../broker/transport.js";

const account = {
  accountId: "account",
  agentSessionToken: "token",
  apiBaseUrl: "http://unused.test",
  registryBaseUrl: "http://unused.test",
};

const guard = {
  bind: async () => ({ agent_session_token: "token" }),
} as unknown as SessionGuard;

/** One physical browser, shared by every session on the broker. */
const sharedBrowser: SessionDouble["browser"] = {
  brokerTargetId: async () => "shared-browser",
  isConnected: () => true,
  maskOperatorOutput: (value) => value,
};

function tool(name: string, handler: Tool["handler"]): Tool {
  return {
    name,
    description: "",
    inputSchema: z.object({ session_id: z.string().optional() }).passthrough(),
    handler,
  } as unknown as Tool;
}

function api(): ApiClient {
  return {} as unknown as ApiClient;
}

function startTool(): Tool {
  return tool("operate_start", async () => {
    const id = `internal-${state.nextId++}`;
    state.sessions.set(id, { browser: sharedBrowser, pendingThreeDs: null });
    return { session_id: id, url: "https://shared.test" };
  });
}

async function harness(tools: Tool[]) {
  const root = await mkdtemp(join(tmpdir(), "ts-broker-wire-"));
  const socket = join(root, "b.sock");
  const broker = new OperatorBroker(account);
  Object.defineProperty(broker, "tools", { value: tools });
  const listener = await listenBroker(socket, {
    authenticate: async (token, agentId) => await broker.authenticate(token, agentId),
    connected: (principal) => {
      (broker as unknown as { apis: Map<string, ApiClient> }).apis.set(principal.clientId, api());
    },
    call: async (principal, method, params, requestId) => {
      // Mirror the daemon: register open/command before dispatch so a dropped
      // connection aborts exactly that connection's in-flight work.
      if (method === "open" || method === "command")
        return await broker.withRegisteredRequest(
          principal,
          requestId,
          async (signal) => await broker.call(principal, method, params, requestId, signal),
        );
      return await broker.call(principal, method, params, requestId);
    },
    abort: (principal, requestId) => broker.cancel(principal, requestId),
    disconnect: async (principal, explicit) => await broker.disconnect(principal, explicit),
  });
  const a = new OperatorForwarder(socket, guard);
  const b = new OperatorForwarder(socket, guard);
  return {
    broker,
    a,
    b,
    close: async () => {
      await a.close();
      await b.close();
      await listener.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

beforeEach(() => {
  state.sessions.clear();
  state.nextId = 0;
  state.dispatches = 0;
  state.finish.mockReset();
  state.forceFinish.mockReset();
  state.finish.mockResolvedValue({ closed: true });
  state.forceFinish.mockResolvedValue(true);
});

afterEach(() => state.sessions.clear());

it("drives two clients' sessions on one shared browser across the Contract B wire", async () => {
  const run = await harness([
    startTool(),
    tool("operate_observe", async (args) => ({
      session_id: args.session_id,
      dom: `dom:${args.session_id}`,
    })),
  ]);
  try {
    const startedA = (await run.a.invoke("operate_start", {}, "a-start")) as {
      session_id: string;
      broker: { targetId: string };
    };
    const startedB = (await run.b.invoke("operate_start", {}, "b-start")) as {
      session_id: string;
      broker: { targetId: string };
    };
    // Two independently opened sessions resolving the same physical browser.
    expect(startedA.session_id).not.toBe(startedB.session_id);
    expect(startedA.broker.targetId).toBe("shared-browser");
    expect(startedB.broker.targetId).toBe("shared-browser");
    expect(run.broker.authority.inventory().sessions).toBe(2);
    const [observedA, observedB] = await Promise.all([
      run.a.invoke("operate_observe", { session_id: startedA.session_id }, "a-observe"),
      run.b.invoke("operate_observe", { session_id: startedB.session_id }, "b-observe"),
    ]);
    expect(observedA).toMatchObject({ dom: expect.stringContaining("dom:") });
    expect(observedB).toMatchObject({ dom: expect.stringContaining("dom:") });
    expect(observedA).not.toEqual(observedB);
  } finally {
    await run.close();
  }
});

it("aborts only the dropped client's in-flight work and leaves the other session intact", async () => {
  let blockedEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    blockedEntered = resolve;
  });
  let blockedAborted = false;
  const run = await harness([
    startTool(),
    tool("operate_observe", async (args) => ({ session_id: args.session_id, dom: "intact" })),
    tool("operate_wait", async (_args, _api, context) => {
      blockedEntered();
      await new Promise<void>((resolve) => {
        if (context?.signal?.aborted) return resolve();
        context?.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      blockedAborted = true;
      throw context?.signal?.reason ?? new Error("aborted");
    }),
  ]);
  try {
    const startedA = (await run.a.invoke("operate_start", {}, "a-start")) as {
      session_id: string;
    };
    const startedB = (await run.b.invoke("operate_start", {}, "b-start")) as {
      session_id: string;
    };
    expect(run.broker.authority.inventory().sessions).toBe(2);

    const inFlight = run.a.invoke("operate_wait", { session_id: startedA.session_id }, "a-wait");
    const aborted = expect(inFlight).rejects.toMatchObject({ code: "broker_lost" });
    await entered;
    // A drops its socket without a close frame: connection loss, not release.
    await run.a.close();
    await aborted;
    await expect.poll(() => blockedAborted).toBe(true);

    // B's session was never touched by A's loss.
    await expect(
      run.b.invoke("operate_observe", { session_id: startedB.session_id }, "b-observe"),
    ).resolves.toMatchObject({ dom: "intact" });
    expect(run.b.sessionCount()).toBe(1);
  } finally {
    await run.close();
  }
});

it("does not execute a repeated command with the same request id twice", async () => {
  const run = await harness([
    startTool(),
    tool("operate_click", async (args) => {
      state.dispatches += 1;
      return { session_id: args.session_id, clicked: true };
    }),
  ]);
  try {
    const started = (await run.a.invoke("operate_start", {}, "start")) as { session_id: string };
    const first = await run.a.invoke(
      "operate_click",
      { session_id: started.session_id },
      "mutate-same-id",
    );
    expect(first).toMatchObject({ clicked: true });
    const second = await run.a.invoke(
      "operate_click",
      { session_id: started.session_id },
      "mutate-same-id",
    );
    expect(second).toEqual(first);
    expect(state.dispatches).toBe(1);
  } finally {
    await run.close();
  }
});
it("cancels one command without costing the caller its connection or its other session", async () => {
  let blockedEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    blockedEntered = resolve;
  });
  let blockedAborted = false;
  const run = await harness([
    startTool(),
    tool("operate_observe", async (args) => ({ session_id: args.session_id, dom: "intact" })),
    tool("operate_wait", async (_args, _api, context) => {
      blockedEntered();
      await new Promise<void>((resolve) => {
        if (context?.signal?.aborted) return resolve();
        context?.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      blockedAborted = true;
      throw context?.signal?.reason ?? new Error("aborted");
    }),
  ]);
  try {
    // One agent owning two sessions (a composite chain) plus a second agent.
    const first = (await run.a.invoke("operate_start", {}, "a-start-1")) as { session_id: string };
    const second = (await run.a.invoke("operate_start", {}, "a-start-2")) as { session_id: string };
    const other = (await run.b.invoke("operate_start", {}, "b-start")) as { session_id: string };
    expect(run.broker.authority.inventory().sessions).toBe(3);

    const controller = new AbortController();
    const inFlight = run.a.invoke(
      "operate_wait",
      { session_id: first.session_id },
      "a-wait",
      controller.signal,
    );
    const cancelled = expect(inFlight).rejects.toMatchObject({ code: "cancelled" });
    await entered;
    controller.abort();
    await cancelled;
    await expect.poll(() => blockedAborted).toBe(true);

    // The cancel cost exactly one request: no session anywhere was closed.
    expect(run.a.connected()).toBe(true);
    expect(run.a.sessionCount()).toBe(2);
    expect(run.broker.authority.inventory().sessions).toBe(3);
    await expect(
      run.a.invoke("operate_observe", { session_id: second.session_id }, "a-observe-2"),
    ).resolves.toMatchObject({ dom: "intact" });
    await expect(
      run.a.invoke("operate_observe", { session_id: first.session_id }, "a-observe-1"),
    ).resolves.toMatchObject({ dom: "intact" });
    await expect(
      run.b.invoke("operate_observe", { session_id: other.session_id }, "b-observe"),
    ).resolves.toMatchObject({ dom: "intact" });
  } finally {
    await run.close();
  }
});
