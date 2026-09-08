import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z, type Tool } from "../../tools/index.js";
import type { SessionGuard } from "../../session-guard.js";

const state = vi.hoisted(() => ({
  sessions: new Map<
    string,
    {
      browser: {
        brokerTargetId(): Promise<string>;
        isConnected(): boolean;
        waitForThreeDsResolution(): Promise<"succeeded">;
      };
      pendingThreeDs: null;
    }
  >(),
  finish: vi.fn(),
}));

vi.mock("../session/lifecycle.js", () => ({
  sessionForCall: (sessionId: string) => state.sessions.get(sessionId),
  finishProvisionSession: state.finish,
  withProvisionSessionCall: async (_sessionId: string, operation: () => Promise<unknown>) =>
    await operation(),
}));

import { brokerAdmissionId } from "../broker/admission-context.js";
import { installBrokerBrowserCustody } from "../broker/custody.js";
import { DispatchJournal, START_DELIVERY_RETENTION_MS } from "../broker/dispatch-journal.js";
import { OperatorForwarder } from "../broker/forwarder.js";
import { forwarderId } from "../broker/lineage.js";
import { OperatorBroker } from "../broker/operator.js";
import { listenBroker } from "../broker/transport.js";
import type { TabCapability } from "../broker/authority.js";

beforeEach(() => {
  state.sessions.clear();
  state.finish.mockReset();
});

afterEach(() => {
  state.sessions.clear();
});

it("deregisters the lifecycle session when target discovery fails after start", async () => {
  const events: string[] = [];
  state.finish.mockImplementation(async (sessionId: string) => {
    events.push(`finish:${sessionId}`);
    state.sessions.delete(sessionId);
    return { session_id: sessionId, url: "", closed: true };
  });
  installBrokerBrowserCustody({
    acquire: async () => {
      throw new Error("not used");
    },
    cleanupAdmission: async (sessionId) => {
      events.push(`cleanup:${sessionId}`);
      return true;
    },
    release: async () => undefined,
    identity: async (operation) => await operation(),
  });
  const broker = new OperatorBroker(
    {
      accountId: "account",
      agentSessionToken: "token",
      apiBaseUrl: "http://unused.test",
      registryBaseUrl: "http://unused.test",
    },
    "cell",
  );
  const identity = await broker.authenticate("token", "agent", "a".repeat(43));
  if (identity === null) throw new Error("Test broker authentication failed");
  const principal = { ...identity, clientId: "client" };
  const internalId = "lifecycle-session";
  const startTool: Tool = {
    name: "operate_start",
    description: "",
    inputSchema: z.object({}).strict(),
    jsonInputSchema: {},
    handler: async () => {
      expect(brokerAdmissionId()).toBeDefined();
      state.sessions.set(internalId, {
        browser: {
          brokerTargetId: async () => {
            throw new Error("target discovery failed");
          },
          isConnected: () => true,
          waitForThreeDsResolution: async () => "succeeded",
        },
        pendingThreeDs: null,
      });
      return { session_id: internalId };
    },
  };
  Object.defineProperty(broker, "tools", { value: [startTool] });
  await broker.authority.claimForwarder(principal);

  await expect(
    broker.call(principal, "tool", { name: "operate_start", args: {} }, "request"),
  ).rejects.toThrow("target discovery failed");

  expect(state.sessions.size).toBe(0);
  expect(state.finish).toHaveBeenCalledWith(internalId);
  expect(events).toEqual([`finish:${internalId}`, expect.stringMatching(/^cleanup:/)]);
  expect(broker.authority.inventory()).toEqual({ active: 0, quarantined: 0, admitting: 0 });
});

it("attributes broker proxy calls to their originating operator commands", async () => {
  const requests: Headers[] = [];
  const broker = new OperatorBroker(
    {
      accountId: "account",
      agentSessionToken: "token",
      apiBaseUrl: "http://unused.test",
      registryBaseUrl: "http://unused.test",
      fetch: (async (_input, init) => {
        requests.push(new Headers(init?.headers));
        return Response.json({
          response: { status: 200, headers: {}, body: "", truncated: false },
        });
      }) as typeof fetch,
    },
    "cell",
  );
  const identity = await broker.authenticate("token", "audited-agent", "a".repeat(43));
  if (identity === null) throw new Error("Test broker authentication failed");
  const principal = { ...identity, clientId: "client" };
  const internalId = "internal-session";
  state.finish.mockImplementation(async (sessionId: string) => {
    state.sessions.delete(sessionId);
    return { session_id: sessionId, url: "", closed: true };
  });
  state.sessions.set(internalId, {
    browser: {
      brokerTargetId: async () => "target",
      isConnected: () => true,
      waitForThreeDsResolution: async () => "succeeded",
    },
    pendingThreeDs: null,
  });
  const proxy = async (api: import("../../api-client.js").ApiClient | null) => {
    if (api === null) throw new Error("Missing broker API client");
    await api.useCredential({
      reference: "vault://account/service/credential",
      http: { method: "GET", url: "https://service.test/resource" },
    });
  };
  const startTool: Tool = {
    name: "operate_start",
    description: "",
    inputSchema: z.object({}).strict(),
    jsonInputSchema: {},
    handler: async (_args, api) => {
      await proxy(api);
      return { session_id: internalId };
    },
  };
  const clickTool: Tool = {
    name: "operate_click",
    description: "",
    inputSchema: z.object({ session_id: z.string() }).strict(),
    jsonInputSchema: {},
    handler: async (_args, api) => {
      await proxy(api);
      return { clicked: true };
    },
  };
  Object.defineProperty(broker, "tools", { value: [startTool, clickTool] });
  await broker.authority.claimForwarder(principal);

  const started = (await broker.call(
    principal,
    "tool",
    { name: "operate_start", args: {} },
    "start-request",
  )) as { capability: TabCapability };
  await broker.call(
    principal,
    "tool",
    {
      name: "operate_click",
      args: { session_id: started.capability.sessionId },
      capability: started.capability,
    },
    "click-request",
  );
  await broker.authority.close(principal, started.capability);

  expect(
    requests.map((headers) => ({
      agent: headers.get("X-Squire-Agent-Identity"),
      task: headers.get("X-Squire-Task-Id"),
      invocation: headers.get("X-Squire-Invocation-Id"),
      purpose: headers.get("X-Squire-Purpose"),
    })),
  ).toEqual([
    {
      agent: "audited-agent",
      task: "operate_start",
      invocation: "start-request",
      purpose: "operate_start",
    },
    {
      agent: "audited-agent",
      task: "operate_click",
      invocation: "click-request",
      purpose: "operate_click",
    },
  ]);
});

it("settles no-page starts without retaining a recoverable mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "ts-broker-no-page-"));
  const journal = new DispatchJournal(join(root, "dispatch.jsonl"));
  const broker = new OperatorBroker(
    {
      accountId: "account",
      agentSessionToken: "token",
      apiBaseUrl: "http://unused.test",
      registryBaseUrl: "http://unused.test",
    },
    "cell",
    journal,
  );
  const identity = await broker.authenticate("token", "agent", "a".repeat(43));
  if (identity === null) throw new Error("Test broker authentication failed");
  const principal = { ...identity, clientId: "client" };
  const guidance = { needs_user: { wall: "google_session", resume: "connect" } };
  const noPageTool = (name: "operate_start" | "operate_recipe_run"): Tool => ({
    name,
    description: "",
    inputSchema: z.object({}).strict(),
    jsonInputSchema: {},
    handler: async () => {
      const sessionId = brokerAdmissionId();
      if (sessionId === undefined) throw new Error("Missing broker admission ID");
      return { session_id: sessionId, ...guidance };
    },
  });
  Object.defineProperty(broker, "tools", {
    value: [noPageTool("operate_start"), noPageTool("operate_recipe_run")],
  });
  state.finish.mockImplementation(async (sessionId: string) => ({
    session_id: sessionId,
    url: "",
    closed: true,
  }));
  try {
    await broker.authority.claimForwarder(principal);
    await expect(
      broker.call(principal, "tool", { name: "operate_start", args: {} }, "start-request"),
    ).resolves.toMatchObject({ result: guidance });
    await expect(
      broker.call(principal, "tool", { name: "operate_recipe_run", args: {} }, "recipe-request"),
    ).resolves.toMatchObject({ result: guidance });
    expect(state.finish).toHaveBeenCalledTimes(2);
    await expect(journal.assertReconciled()).resolves.toBeUndefined();
    await expect(
      broker.recover(principal, { name: "operate_recipe_run", args: {} }),
    ).resolves.toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("retains acknowledged start control until a same-lineage follow-up", async () => {
  const guard: SessionGuard = {
    bind: async () => ({
      account_id: "account",
      agent_session_token: "token",
      api_base_url: "http://unused.test",
      saved_at: "",
    }),
    inspect: async () => ({ problem: null }),
    boundAccountId: () => "account",
  };
  for (const name of ["operate_start", "operate_recipe_run"] as const) {
    const root = await mkdtemp(join(tmpdir(), `ts-broker-${name}-delivery-`));
    const path = join(root, "broker.sock");
    const journal = new DispatchJournal(join(root, "dispatch.jsonl"));
    const broker = new OperatorBroker(
      {
        accountId: "account",
        agentSessionToken: "token",
        apiBaseUrl: "http://unused.test",
        registryBaseUrl: "http://unused.test",
      },
      "cell",
      journal,
    );
    const startTool: Tool = {
      name,
      description: "",
      inputSchema: z.object({}).strict(),
      jsonInputSchema: {},
      handler: async () => {
        const sessionId = brokerAdmissionId();
        if (sessionId === undefined) throw new Error("Missing broker admission ID");
        state.sessions.set(sessionId, {
          browser: {
            brokerTargetId: async () => "target",
            isConnected: () => true,
            waitForThreeDsResolution: async () => "succeeded",
          },
          pendingThreeDs: null,
        });
        return { session_id: sessionId };
      },
    };
    const sessionTool = (toolName: "operate_observe" | "operate_finish"): Tool => ({
      name: toolName,
      description: "",
      inputSchema: z.object({ session_id: z.string() }).strict(),
      jsonInputSchema: {},
      handler: async () => (toolName === "operate_observe" ? { dom: "ready" } : { done: true }),
    });
    Object.defineProperty(broker, "tools", {
      value: [startTool, sessionTool("operate_observe"), sessionTool("operate_finish")],
    });
    state.finish.mockImplementation(async (sessionId: string) => {
      state.sessions.delete(sessionId);
      return { session_id: sessionId, url: "", closed: true };
    });
    const listener = await listenBroker(path, {
      authenticate: async (token, agentId, lineageCredential) =>
        await broker.authenticate(token, agentId, lineageCredential),
      connected: async (principal) => await broker.connected(principal),
      call: async (principal, method, params, requestId) => {
        if (method === "recover") return await broker.recover(principal, params);
        if (method === "reclaim") return await broker.reclaim(principal);
        if (method === "acknowledge") {
          await broker.acknowledge(principal, String(params.requestId));
          return {};
        }
        if (method === "confirm_start") {
          await broker.confirmStartDelivery(principal, params);
          return {};
        }
        return await broker.call(principal, method, params, requestId);
      },
      disconnect: async (principal) => await broker.disconnect(principal),
    });
    const original = new OperatorForwarder(path, guard, "a".repeat(43));
    const foreign = new OperatorForwarder(path, guard, "b".repeat(43));
    const restarted = new OperatorForwarder(path, guard, "a".repeat(43));
    const expired = new OperatorForwarder(path, guard, "a".repeat(43));
    try {
      const started = (await original.invoke(name, {}, "original-start-id")) as {
        session_id: string;
      };
      await original.close();
      await expect
        .poll(() => broker.authority.inventory())
        .toEqual({
          active: 0,
          quarantined: 1,
          admitting: 0,
        });
      expect(await journal.hasPendingStartDelivery(forwarderId("a".repeat(43)))).toBe(true);
      await broker.reap(Date.now() + START_DELIVERY_RETENTION_MS - 1_000);
      expect(broker.authority.inventory()).toEqual({ active: 0, quarantined: 1, admitting: 0 });
      await expect(
        foreign.invoke(name, {}, "foreign-recovery-id", { recover: true }),
      ).rejects.toThrow("No matching durable outcome");
      expect(state.sessions.size).toBe(1);
      await expect(
        restarted.invoke(name, {}, "recovery-id", { recover: true }),
      ).resolves.toMatchObject({ session_id: started.session_id });
      await expect(
        restarted.invoke("operate_observe", { session_id: started.session_id }, "delivery-id"),
      ).resolves.toEqual({ dom: "ready" });
      expect(await journal.hasPendingStartDelivery(forwarderId("a".repeat(43)))).toBe(false);
      await restarted.invoke("operate_finish", { session_id: started.session_id }, "finish-id");
      expect(state.sessions.size).toBe(0);
      expect(broker.authority.inventory()).toEqual({ active: 0, quarantined: 0, admitting: 0 });
      await restarted.invoke(name, {}, "expiring-start-id");
      await restarted.close();
      await expect
        .poll(() => broker.authority.inventory())
        .toEqual({
          active: 0,
          quarantined: 1,
          admitting: 0,
        });
      await broker.reap(Date.now() + START_DELIVERY_RETENTION_MS);
      expect(state.sessions.size).toBe(0);
      expect(broker.authority.inventory()).toEqual({ active: 0, quarantined: 0, admitting: 0 });
      await expect(
        expired.invoke(name, {}, "expired-recovery-id", { recover: true }),
      ).rejects.toThrow("No matching durable outcome");
    } finally {
      await original.close();
      await foreign.close();
      await restarted.close();
      await expired.close();
      await listener.close();
      await rm(root, { recursive: true, force: true });
    }
  }
});
