import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z, type Tool } from "../../tools/index.js";
import type { ApiClient } from "../../api-client.js";
import type { SessionGuard } from "../../session-guard.js";

const state = vi.hoisted(() => ({
  sessions: new Map<
    string,
    {
      browser: {
        brokerTargetId(): Promise<string>;
        isConnected(): boolean;
      };
      pendingThreeDs: null;
    }
  >(),
  finish: vi.fn(),
  forceFinish: vi.fn(),
}));

vi.mock("../session/lifecycle.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../session/lifecycle.js")>();
  return {
    ...actual,
    sessionForCall: (sessionId: string) => state.sessions.get(sessionId),
    finishProvisionSession: state.finish,
    forceFinishProvisionSession: state.forceFinish,
    withProvisionSessionCall: async (_sessionId: string, operation: () => Promise<unknown>) =>
      await operation(),
    withCeremonyStartAdmission: async (operation: () => Promise<unknown>) => await operation(),
  };
});

vi.mock("../provision-session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../provision-session.js")>();
  return {
    ...actual,
    maskOperatorSessionOutput: (_sessionId: string, value: unknown) => value,
    preparePublicOAuthLoginTarget: async () => undefined,
    withPreparedOAuthLoginTarget: async (_prepared: unknown, operation: () => Promise<unknown>) =>
      await operation(),
  };
});

import { OperatorBroker } from "../broker/operator.js";
import { OperatorForwarder } from "../broker/forwarder.js";
import { ProvenPreDispatchMutationError } from "../mutation-dispatch-evidence.js";
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

async function harness(tools: Tool[]) {
  const root = await mkdtemp(join(tmpdir(), "ts-broker-operator-"));
  const broker = new OperatorBroker(account);
  Object.defineProperty(broker, "tools", { value: tools });
  const listener = await listenBroker(join(root, "b.sock"), {
    authenticate: async (token, agentId) => await broker.authenticate(token, agentId),
    connected: (principal) => {
      (broker as unknown as { apis: Map<string, ApiClient> }).apis.set(principal.clientId, api());
    },
    call: async (principal, method, params, requestId) => {
      // Mirror the daemon: open/command register before dispatch so a dropped
      // connection aborts the in-flight request.
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
  const forwarder = new OperatorForwarder(join(root, "b.sock"), guard);
  return {
    broker,
    forwarder,
    close: async () => {
      await forwarder.close();
      await listener.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function withSession(id: string, overrides: { connected?: boolean } = {}): void {
  state.sessions.set(id, {
    pendingThreeDs: null,
    browser: {
      brokerTargetId: async () => `target:${id}`,
      isConnected: () => overrides.connected ?? true,
    },
  });
}

beforeEach(() => {
  state.sessions.clear();
  state.finish.mockReset();
  state.forceFinish.mockReset();
  state.finish.mockResolvedValue({ closed: true });
  state.forceFinish.mockResolvedValue(true);
});

afterEach(() => state.sessions.clear());

it("starts a session, remaps it, and routes later commands to the same internal session", async () => {
  const seen: Record<string, unknown>[] = [];
  withSession("internal-one");
  const run = await harness([
    tool("operate_start", async () => ({ session_id: "internal-one", url: "https://a.test" })),
    tool("operate_observe", async (args) => {
      seen.push(args as Record<string, unknown>);
      return { session_id: args.session_id, dom: "fixture" };
    }),
  ]);
  try {
    const started = (await run.forwarder.invoke(
      "operate_start",
      { service_url: "https://service.test" },
      "start",
    )) as {
      session_id: string;
      broker: { targetId: string };
    };
    expect(started.session_id).not.toBe("internal-one");
    expect(started.broker.targetId).toBe("target:internal-one");
    await expect(
      run.forwarder.invoke("operate_observe", { session_id: started.session_id }, "observe"),
    ).resolves.toEqual({ session_id: started.session_id, dom: "fixture" });
    expect(seen[0]).toMatchObject({ session_id: "internal-one" });
  } finally {
    await run.close();
  }
});

it("settles a start with no live page instead of retaining the session", async () => {
  const run = await harness([
    tool("operate_start", async () => ({
      session_id: "internal-missing",
      needs_user: { provider: "google" },
    })),
  ]);
  try {
    const started = (await run.forwarder.invoke(
      "operate_start",
      { service_url: "https://service.test" },
      "start",
    )) as { session_id: string };
    expect(started).toMatchObject({
      needs_user: { provider: "google" },
    });
    expect(run.broker.authority.inventory().sessions).toBe(0);
    await expect(
      run.forwarder.invoke("operate_observe", { session_id: started.session_id }, "observe-wall"),
    ).resolves.toMatchObject({
      session_id: started.session_id,
      needs_user: { provider: "google" },
    });
  } finally {
    await run.close();
  }
});

it("retires the broker session when a terminal finish reports closed", async () => {
  withSession("internal-two");
  const run = await harness([
    tool("operate_start", async () => ({ session_id: "internal-two" })),
    tool("operate_finish", async () => ({ closed: true, url: "https://a.test" })),
  ]);
  try {
    const started = (await run.forwarder.invoke(
      "operate_start",
      { service_url: "https://service.test" },
      "start",
    )) as {
      session_id: string;
    };
    expect(run.broker.authority.inventory().sessions).toBe(1);
    await run.forwarder.invoke("operate_finish", { session_id: started.session_id }, "finish");
    expect(run.broker.authority.inventory().sessions).toBe(0);
    expect(run.forwarder.sessionCount()).toBe(0);
  } finally {
    await run.close();
  }
});

it("delivers a proven pre-dispatch failure as a retryable mutation error", async () => {
  withSession("internal-three");
  const failure = new ProvenPreDispatchMutationError("stale_ref");
  const run = await harness([
    tool("operate_start", async () => ({ session_id: "internal-three" })),
    tool("operate_click", async () => {
      throw failure;
    }),
  ]);
  try {
    const started = (await run.forwarder.invoke(
      "operate_start",
      { service_url: "https://service.test" },
      "start",
    )) as {
      session_id: string;
    };
    await expect(
      run.forwarder.invoke("operate_click", { session_id: started.session_id }, "click"),
    ).rejects.toBeInstanceOf(ProvenPreDispatchMutationError);
  } finally {
    await run.close();
  }
});

it("reports a lost browser transport to the caller without replaying the command", async () => {
  withSession("internal-four", { connected: false });
  const run = await harness([
    tool("operate_start", async () => ({ session_id: "internal-four" })),
    tool("operate_click", async () => ({ clicked: true })),
  ]);
  try {
    const started = (await run.forwarder.invoke(
      "operate_start",
      { service_url: "https://service.test" },
      "start",
    )) as {
      session_id: string;
    };
    await expect(
      run.forwarder.invoke("operate_click", { session_id: started.session_id }, "click"),
    ).rejects.toMatchObject({ code: "browser_lost" });
  } finally {
    await run.close();
  }
});

it("relays an in-flight approval notification to the calling client before the result", async () => {
  withSession("internal-five");
  const run = await harness([
    tool("operate_start", async () => ({ session_id: "internal-five" })),
    tool("operate_click", async (_args, _api, context) => {
      await context?.notifyUser?.("approve", { url: "https://approve.test" });
      return { clicked: true };
    }),
  ]);
  const notifications: string[] = [];
  try {
    const started = (await run.forwarder.invoke(
      "operate_start",
      { service_url: "https://service.test" },
      "start",
    )) as {
      session_id: string;
    };
    await run.forwarder.invoke(
      "operate_click",
      { session_id: started.session_id },
      "click",
      undefined,
      async (message) => {
        notifications.push(message);
      },
    );
    expect(notifications).toEqual(["approve"]);
  } finally {
    await run.close();
  }
});

it("aborts an in-flight command when its connection drops, without replaying it", async () => {
  withSession("internal-six");
  let entered!: () => void;
  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let aborted = false;
  const run = await harness([
    tool("operate_start", async () => ({ session_id: "internal-six" })),
    tool("operate_click", async (_args, _api, context) => {
      entered();
      await new Promise<void>((resolve) => {
        context?.signal?.addEventListener(
          "abort",
          () => {
            aborted = true;
            resolve();
          },
          { once: true },
        );
      });
      throw context?.signal?.reason ?? new Error("aborted");
    }),
  ]);
  try {
    const started = (await run.forwarder.invoke(
      "operate_start",
      { service_url: "https://service.test" },
      "start",
    )) as {
      session_id: string;
    };
    const call = run.forwarder.invoke("operate_click", { session_id: started.session_id }, "click");
    await enteredPromise;
    await run.forwarder.close();
    await expect(call).rejects.toMatchObject({ code: "broker_lost" });
    await expect.poll(() => aborted).toBe(true);
  } finally {
    await run.close();
  }
});

it("aborts only the caller's own request and keeps the connection and session usable", async () => {
  withSession("internal-seven");
  let entered!: () => void;
  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let aborted = false;
  const run = await harness([
    tool("operate_start", async () => ({ session_id: "internal-seven" })),
    tool("operate_click", async (_args, _api, context) => {
      entered();
      await new Promise<void>((resolve) => {
        if (context?.signal?.aborted) return resolve();
        context?.signal?.addEventListener(
          "abort",
          () => {
            aborted = true;
            resolve();
          },
          { once: true },
        );
      });
      throw context?.signal?.reason ?? new Error("aborted");
    }),
    tool("operate_observe", async (args) => ({ session_id: args.session_id, dom: "intact" })),
  ]);
  try {
    const started = (await run.forwarder.invoke(
      "operate_start",
      { service_url: "https://service.test" },
      "start",
    )) as {
      session_id: string;
    };
    const controller = new AbortController();
    const call = run.forwarder.invoke(
      "operate_click",
      { session_id: started.session_id },
      "click",
      controller.signal,
    );
    const rejected = expect(call).rejects.toMatchObject({ code: "cancelled" });
    await enteredPromise;
    controller.abort();
    await rejected;
    await expect.poll(() => aborted).toBe(true);

    // The socket was never dropped, so the lease and its session survive.
    expect(run.forwarder.connected()).toBe(true);
    expect(run.forwarder.sessionCount()).toBe(1);
    expect(run.broker.authority.inventory().sessions).toBe(1);
    await expect(
      run.forwarder.invoke("operate_observe", { session_id: started.session_id }, "observe"),
    ).resolves.toMatchObject({ dom: "intact" });
  } finally {
    await run.close();
  }
});

it("refuses operate_finish as a command; finish is the close operation", async () => {
  withSession("internal-eight");
  const run = await harness([
    tool("operate_start", async () => ({ session_id: "internal-eight" })),
    tool("operate_finish", async () => ({ closed: true })),
  ]);
  try {
    const started = (await run.forwarder.invoke(
      "operate_start",
      { service_url: "https://service.test" },
      "start",
    )) as {
      session_id: string;
    };
    await expect(
      run.broker.call(
        { accountId: "account", agentId: "agent", clientId: "direct" },
        "command",
        {
          sessionId: started.session_id,
          name: "operate_finish",
          args: { session_id: started.session_id },
        },
        "finish-command",
      ),
    ).rejects.toMatchObject({ code: "unknown_tool" });
  } finally {
    await run.close();
  }
});
