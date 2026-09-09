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
  forceFinish: vi.fn(),
}));

vi.mock("../session/lifecycle.js", () => ({
  sessionForCall: (sessionId: string) => state.sessions.get(sessionId),
  finishProvisionSession: state.finish,
  forceFinishProvisionSession: state.forceFinish,
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
  state.forceFinish.mockReset();
});

afterEach(() => {
  state.sessions.clear();
});

it("retains a replacement lineage binding through the old socket handoff", async () => {
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
  const first = { ...identity, clientId: "first" };
  await broker.connected(first);
  const replacementIdentity = await broker.authenticate("token", "agent", "a".repeat(43));
  if (replacementIdentity === null) throw new Error("Test replacement authentication failed");
  const replacement = { ...replacementIdentity, clientId: "replacement" };
  broker.authority.beginForwarderRelease(first);
  const handoff = Promise.resolve(broker.connected(replacement));
  await broker.disconnect(first);
  await handoff;

  await expect(
    broker.recover(replacement, {
      name: "operate_start",
      args: { service_url: "https://example.test" },
    }),
  ).resolves.toBeNull();
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
    orphanAdmission: async () => undefined,
    orphan: async () => undefined,
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

it("closes an explicitly released client session immediately", async () => {
  const root = await mkdtemp(join(tmpdir(), "ts-broker-explicit-start-"));
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
  const internalId = "explicit-close-session";
  const startTool: Tool = {
    name: "operate_start",
    description: "",
    inputSchema: z.object({}).strict(),
    jsonInputSchema: {},
    handler: async () => {
      state.sessions.set(internalId, {
        browser: {
          brokerTargetId: async () => "target",
          isConnected: () => true,
          waitForThreeDsResolution: async () => "succeeded",
        },
        pendingThreeDs: null,
      });
      return { session_id: internalId };
    },
  };
  Object.defineProperty(broker, "tools", { value: [startTool] });
  state.finish.mockImplementation(async (sessionId: string) => {
    state.sessions.delete(sessionId);
    return { session_id: sessionId, url: "", closed: true };
  });

  try {
    await broker.connected(principal);
    const started = (await broker.call(
      principal,
      "tool",
      { name: "operate_start", args: {} },
      "start-request",
    )) as { capability: TabCapability };
    await broker.acknowledge(principal, "start-request");
    expect(await journal.hasPendingStartDelivery(principal.forwarderId!)).toBe(true);

    await broker.disconnect(principal, true);

    expect(started.capability.sessionId).toBeDefined();
    expect(state.finish).toHaveBeenCalledWith(internalId);
    expect(state.sessions.size).toBe(0);
    expect(await journal.hasPendingStartDelivery(principal.forwarderId!)).toBe(false);
    expect(broker.authority.inventory()).toEqual({ active: 0, quarantined: 0, admitting: 0 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("quarantines an uncertain payment after explicit close and returns its recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "ts-broker-explicit-payment-"));
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
  const resumed = { ...principal, clientId: "resumed" };
  const internalId = "uncertain-payment-session";
  let paymentDispatches = 0;
  const startTool: Tool = {
    name: "operate_start",
    description: "",
    inputSchema: z.object({}).strict(),
    jsonInputSchema: {},
    handler: async () => {
      state.sessions.set(internalId, {
        browser: {
          brokerTargetId: async () => "target",
          isConnected: () => true,
          waitForThreeDsResolution: async () => "succeeded",
        },
        pendingThreeDs: null,
      });
      return { session_id: internalId };
    },
  };
  const payTool: Tool = {
    name: "operate_pay",
    description: "",
    inputSchema: z.object({ session_id: z.string() }).strict(),
    jsonInputSchema: {},
    handler: async () => {
      paymentDispatches += 1;
      return { status: "payment_outcome_unknown" };
    },
  };
  Object.defineProperty(broker, "tools", { value: [startTool, payTool] });
  state.finish.mockImplementation(async (sessionId: string) => {
    state.sessions.delete(sessionId);
    return { session_id: sessionId, url: "", closed: true };
  });
  state.forceFinish.mockImplementation(async (sessionId: string) => {
    state.sessions.delete(sessionId);
    return true;
  });

  try {
    await broker.connected(principal);
    const started = (await broker.call(
      principal,
      "tool",
      { name: "operate_start", args: {} },
      "start-request",
    )) as { capability: TabCapability };
    await broker.acknowledge(principal, "start-request");
    await broker.confirmStartDelivery(principal, { capability: started.capability });
    await broker.call(
      principal,
      "tool",
      {
        name: "operate_pay",
        args: { session_id: started.capability.sessionId },
        capability: started.capability,
      },
      "payment-request",
    );

    await broker.disconnect(principal, true);
    await broker.reap();

    expect(broker.authority.inventory()).toEqual({ active: 0, quarantined: 0, admitting: 0 });
    expect(state.sessions.size).toBe(0);
    expect(await journal.hasOutstanding(started.capability.sessionId, principal.forwarderId)).toBe(
      true,
    );

    await broker.connected(resumed);
    expect(await broker.reclaim(resumed)).toEqual({ capabilities: [] });
    await expect(
      broker.recover(resumed, {
        name: "operate_pay",
        args: { session_id: started.capability.sessionId },
      }),
    ).resolves.toMatchObject({
      requestId: "payment-request",
      result: {
        reconciliation: {
          request_id: "payment-request",
          operation: "operate_pay",
          status: "payment_outcome_unknown",
        },
      },
    });
    expect(paymentDispatches).toBe(1);
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
    state.forceFinish.mockImplementation(async (sessionId: string) => {
      state.sessions.delete(sessionId);
      return true;
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
      disconnect: async (principal, explicit) => await broker.disconnect(principal, explicit),
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
