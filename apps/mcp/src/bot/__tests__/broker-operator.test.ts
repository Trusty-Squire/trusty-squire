import {
  persistOperatorTerminalReceipt,
  settleOperatorTerminalReceipt,
  markOperatorMutationDispatchAttempted,
} from "../request-cancellation.js";
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z, type Tool, type ToolContext } from "../../tools/index.js";
import type { ApiClient } from "../../api-client.js";
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
  prepareOAuth: vi.fn(),
  preparedOAuth: undefined as unknown,
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
  preparePublicOAuthLoginTarget: (sessionId: string, target: string) =>
    state.prepareOAuth(sessionId, target),
  withPreparedOAuthLoginTarget: async (prepared: unknown, operation: () => Promise<unknown>) => {
    const previous = state.preparedOAuth;
    state.preparedOAuth = prepared;
    try {
      return await operation();
    } finally {
      state.preparedOAuth = previous;
    }
  },
}));

import { brokerAdmissionId } from "../broker/admission-context.js";
import { installBrokerBrowserCustody } from "../broker/custody.js";
import { DispatchJournal } from "../broker/dispatch-journal.js";
import { OperatorForwarder } from "../broker/forwarder.js";
import { forwarderId } from "../broker/lineage.js";
import { OperatorBroker } from "../broker/operator.js";
import { BrokerRefusal } from "../broker/refusal.js";
import { listenBroker } from "../broker/transport.js";
import type { BrokerPrincipal } from "../broker/authority.js";
import { ProvenPreDispatchMutationError } from "../mutation-dispatch-evidence.js";

beforeEach(() => {
  state.sessions.clear();
  state.finish.mockReset();
  state.forceFinish.mockReset();
  state.prepareOAuth.mockReset();
  state.prepareOAuth.mockReturnValue(undefined);
  state.preparedOAuth = undefined;
});

afterEach(() => {
  state.sessions.clear();
});

it("carries queued OAuth authority from broker admission through final dispatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "ts-broker-queued-oauth-"));
  const journal = new DispatchJournal(join(root, "dispatch.jsonl"));
  const broker = new OperatorBroker(
    {
      accountId: "account",
      agentSessionToken: "token",
      apiBaseUrl: "http://unused.test",
      registryBaseUrl: "http://unused.test",
    },
    journal,
  );
  const internalIds = ["blocker", "unchanged", "changed"];
  const targets = new Map(
    internalIds.map((sessionId) => [
      sessionId,
      { ref: `@e:${sessionId}`, version: 1, expiresAt: Number.POSITIVE_INFINITY },
    ]),
  );
  let startIndex = 0;
  let releaseBlocker!: () => void;
  let blockerEntered!: () => void;
  const blockerGate = new Promise<void>((resolve) => {
    releaseBlocker = resolve;
  });
  const blockerStarted = new Promise<void>((resolve) => {
    blockerEntered = resolve;
  });
  const preparedSignals = new Map<string, () => void>();
  const preparedPromises = new Map<string, Promise<void>>(
    ["unchanged", "changed"].map((sessionId): [string, Promise<void>] => [
      sessionId,
      new Promise<void>((resolve) => preparedSignals.set(sessionId, resolve)),
    ]),
  );
  const dispatched: string[] = [];

  state.prepareOAuth.mockImplementation((sessionId: string, ref: string) => {
    const target = targets.get(sessionId);
    if (target === undefined || target.ref !== ref || target.expiresAt < Date.now()) {
      throw new ProvenPreDispatchMutationError("stale_ref");
    }
    preparedSignals.get(sessionId)?.();
    return { sessionId, target: ref, version: target.version };
  });

  const startTool: Tool = {
    name: "operate_start",
    description: "",
    inputSchema: z.object({}).strict(),
    jsonInputSchema: {},
    handler: async () => {
      const sessionId = internalIds[startIndex++]!;
      state.sessions.set(sessionId, {
        browser: {
          brokerTargetId: async () => `target-${sessionId}`,
          isConnected: () => true,
          waitForThreeDsResolution: async () => "succeeded",
        },
        pendingThreeDs: null,
      });
      return { session_id: sessionId };
    },
  };
  const loginTool: Tool<{ session_id: string; provider: "google"; ref: string }> = {
    name: "operate_login",
    description: "",
    inputSchema: z
      .object({ session_id: z.string(), provider: z.literal("google"), ref: z.string() })
      .strict(),
    jsonInputSchema: {},
    handler: async (args) => {
      const prepared = state.preparedOAuth as
        | { sessionId: string; target: string; version: number }
        | undefined;
      const target = targets.get(args.session_id);
      if (
        prepared === undefined ||
        prepared.sessionId !== args.session_id ||
        prepared.target !== args.ref ||
        target === undefined ||
        prepared.version !== target.version
      ) {
        throw new ProvenPreDispatchMutationError("stale_ref");
      }
      if (args.session_id === "blocker") {
        blockerEntered();
        await blockerGate;
      }
      dispatched.push(args.session_id);
      return { session_id: args.session_id, status: "completed" };
    },
  };
  Object.defineProperty(broker, "tools", { value: [startTool, loginTool] });

  const clients: Array<{
    principal: BrokerPrincipal;
    capability: string;
  }> = [];
  for (const [index] of internalIds.entries()) {
    const identity = await broker.authenticate("token", `agent-${index}`, String(index).repeat(43));
    if (identity === null) throw new Error("Test broker authentication failed");
    const principal = { ...identity, clientId: `client-${index}` };
    await broker.connected(principal);
    const started = (await broker.call(
      principal,
      "tool",
      { name: "operate_start", args: {} },
      `start-${index}`,
    )) as { capability: string };
    await broker.acknowledge(principal, `start-${index}`);
    clients.push({ principal, capability: started.capability });
  }

  try {
    const login = (index: number, requestId: string) => {
      const client = clients[index]!;
      const args = {
        session_id: client.capability,
        provider: "google" as const,
        ref: `@e:${internalIds[index]}`,
      };
      return {
        args,
        result: broker.call(
          client.principal,
          "tool",
          { name: "operate_login", args, capability: client.capability },
          requestId,
        ),
      };
    };

    const blocking = login(0, "login-blocker").result;
    await blockerStarted;
    const unchanged = login(1, "login-unchanged");
    await preparedPromises.get("unchanged");
    targets.get("unchanged")!.expiresAt = Date.now() - 1;
    const changed = login(2, "login-changed");
    await preparedPromises.get("changed");
    targets.get("changed")!.version += 1;
    releaseBlocker();

    await expect(blocking).resolves.toMatchObject({ result: { status: "completed" } });
    await expect(unchanged.result).resolves.toMatchObject({ result: { status: "completed" } });
    await expect(changed.result).resolves.toEqual({
      preDispatchFailure: { error: "stale_ref", dispatch: "not_dispatched" },
    });
    expect(dispatched).toEqual(["blocker", "unchanged"]);
    await broker.acknowledge(clients[2]!.principal, "login-changed");
    await expect(
      broker.recover(clients[2]!.principal, {
        name: "operate_login",
        args: changed.args,
      }),
    ).resolves.toMatchObject({
      result: { reconciliation: { status: "not_dispatched", error: "stale_ref" } },
    });
  } finally {
    releaseBlocker();
    await rm(root, { recursive: true, force: true });
  }
});

it("keeps an ambiguous thrown mutation unrecoverable", async () => {
  const root = await mkdtemp(join(tmpdir(), "ts-broker-ambiguous-dispatch-"));
  const path = join(root, "dispatch.jsonl");
  const journal = new DispatchJournal(path);
  const broker = new OperatorBroker(
    {
      accountId: "account",
      agentSessionToken: "token",
      apiBaseUrl: "http://unused.test",
      registryBaseUrl: "http://unused.test",
    },
    journal,
  );
  const identity = await broker.authenticate("token", "agent", "a".repeat(43));
  if (identity === null) throw new Error("Test broker authentication failed");
  const principal = { ...identity, clientId: "client" };
  const internalId = "ambiguous-session";
  let loginCalls = 0;
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
  const loginTool: Tool = {
    name: "operate_login",
    description: "",
    inputSchema: z
      .object({ session_id: z.string(), provider: z.literal("google"), ref: z.string() })
      .strict(),
    jsonInputSchema: {},
    handler: async () => {
      loginCalls += 1;
      throw new Error("provider navigation may already have dispatched");
    },
  };
  Object.defineProperty(broker, "tools", { value: [startTool, loginTool] });

  try {
    await broker.connected(principal);
    const started = (await broker.call(
      principal,
      "tool",
      { name: "operate_start", args: {} },
      "start-request",
    )) as { capability: string };
    await broker.acknowledge(principal, "start-request");
    const args = {
      session_id: started.capability,
      provider: "google" as const,
      ref: "@e:possibly-dispatched",
    };
    await expect(
      broker.call(
        principal,
        "tool",
        { name: "operate_login", args, capability: started.capability },
        "login-request",
      ),
    ).rejects.toMatchObject({
      code: "tool_execution_failed",
      message: expect.stringMatching(
        /may already have dispatched; session_id=.*; operation=operate_login; operation_id=login-request; mutation=unknown; recovery=.*do_not_replay/,
      ),
    });
    await expect(broker.recover(principal, { name: "operate_login", args })).resolves.toMatchObject(
      {
        requestId: "login-request",
        result: {
          reconciliation: {
            status: "unknown",
            operation: "operate_login",
            request_id: "login-request",
          },
        },
      },
    );
    await expect(new DispatchJournal(path).assertReconciled()).resolves.toBeUndefined();
    expect(loginCalls).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("retains a replacement lineage binding through the old socket handoff", async () => {
  const broker = new OperatorBroker(
    {
      accountId: "account",
      agentSessionToken: "token",
      apiBaseUrl: "http://unused.test",
      registryBaseUrl: "http://unused.test",
    },
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
  });
  const broker = new OperatorBroker(
    {
      accountId: "account",
      agentSessionToken: "token",
      apiBaseUrl: "http://unused.test",
      registryBaseUrl: "http://unused.test",
    },
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
  const proxy = async (api: ApiClient | null) => {
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
  )) as { capability: string };
  await broker.call(
    principal,
    "tool",
    {
      name: "operate_click",
      args: { session_id: started.capability },
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
    )) as { capability: string };
    await broker.acknowledge(principal, "start-request");

    await broker.disconnect(principal, true);

    expect(started.capability).toBeDefined();
    expect(state.finish).toHaveBeenCalledWith(internalId);
    expect(state.sessions.size).toBe(0);
    expect(broker.authority.inventory()).toEqual({ active: 0, quarantined: 0, admitting: 0 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("retains pre-registration cancellations without crossing connection identities", async () => {
  const broker = new OperatorBroker(
    {
      accountId: "account",
      agentSessionToken: "token",
      apiBaseUrl: "http://unused.test",
      registryBaseUrl: "http://unused.test",
    },
  );
  const owner = { accountId: "account", agentId: "agent", clientId: "one" };
  const foreign = { ...owner, clientId: "two" };
  expect(broker.cancel(owner, "queued")).toBe(true);
  await expect(broker.call(foreign, "wrong-method", {}, "queued")).rejects.toThrow(
    "Unknown broker method",
  );
  await expect(broker.call(owner, "wrong-method", {}, "queued")).rejects.toThrow(
    "cancelled before registration",
  );
  // Consumed cancellation cannot leak into another request.
  await expect(broker.call(owner, "wrong-method", {}, "different")).rejects.toThrow(
    "Unknown broker method",
  );
});


it("records cancelled navigation before its executor checkpoint as not dispatched", async () => {
  const root = await mkdtemp(join(tmpdir(), "navigate-checkpoint-"));
  const journal = new DispatchJournal(join(root, "journal.jsonl"));
  const broker = new OperatorBroker(
    {
      accountId: "account",
      agentSessionToken: "token",
      apiBaseUrl: "http://unused.test",
      registryBaseUrl: "http://unused.test",
    },
    journal,
  );
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const dispatch = vi.fn();
  const tools: Tool[] = [
    {
      name: "operate_start",
      description: "",
      inputSchema: z.object({}),
      jsonInputSchema: {},
      handler: async () => {
        state.sessions.set("internal", {
          browser: {
            brokerTargetId: async () => "target",
            isConnected: () => true,
            waitForThreeDsResolution: async () => "succeeded",
          },
          pendingThreeDs: null,
        });
        return { session_id: "internal" };
      },
    },
    {
      name: "operate_navigate",
      description: "",
      inputSchema: z.object({ session_id: z.string() }),
      jsonInputSchema: {},
      handler: async () => {
        entered();
        await gate;
        await markOperatorMutationDispatchAttempted();
        dispatch();
        return {};
      },
    },
  ];
  Object.defineProperty(broker, "tools", { value: tools });
  try {
    const identity = await broker.authenticate("token", "agent", "n".repeat(43));
    if (!identity) throw new Error("authentication failed");
    const principal = { ...identity, clientId: "client" };
    await broker.connected(principal);
    const { capability } = (await broker.call(
      principal,
      "tool",
      { name: "operate_start", args: {} },
      "start",
    )) as { capability: string };
    await broker.acknowledge(principal, "start");
    const work = broker
      .call(
        principal,
        "tool",
        { name: "operate_navigate", capability, args: { session_id: capability } },
        "navigate",
      )
      .catch((error: unknown) => error);
    await started;
    broker.cancel(principal, "navigate");
    release();
    const cancellation = await work;
    expect(cancellation).toBeInstanceOf(BrokerRefusal);
    expect(cancellation).toMatchObject({
      code: "cancelled",
      message: expect.stringMatching(
        /Caller cancelled the request; session_id=.*; operation=operate_navigate; operation_id=navigate; mutation=not_dispatched; recovery=operate_observe_then_retry/,
      ),
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(await journal.completedOutcome(identity.forwarderId!, "navigate")).toMatchObject({
      outcome: { status: "not_dispatched", error: "cancelled" },
    });
  } finally {
    release();
    await rm(root, { recursive: true, force: true });
  }
});

it.each([
  ["consent", "https://app.example.test/onboarding", "form"],
  ["onboarding", "https://app.example.test/home", "app"],
])(
  "keeps an observed successful %s transition when cancellation arrives after dispatch",
  async (_transition, resultUrl, resultStage) => {
    const root = await mkdtemp(join(tmpdir(), "late-action-cancel-"));
    const journal = new DispatchJournal(join(root, "journal.jsonl"));
    const broker = new OperatorBroker(
      {
        accountId: "account",
        agentSessionToken: "token",
        apiBaseUrl: "http://unused.test",
        registryBaseUrl: "http://unused.test",
      },
      journal,
    );
    let dispatched!: () => void;
    let release!: () => void;
    const dispatchObserved = new Promise<void>((resolve) => {
      dispatched = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let actionCalls = 0;
    const tools: Tool[] = [
      {
        name: "operate_start",
        description: "",
        inputSchema: z.object({}),
        jsonInputSchema: {},
        handler: async () => {
          state.sessions.set("internal", {
            browser: {
              brokerTargetId: async () => "target",
              isConnected: () => true,
              waitForThreeDsResolution: async () => "succeeded",
            },
            pendingThreeDs: null,
          });
          return { session_id: "internal" };
        },
      },
      {
        name: "operate_click",
        description: "",
        inputSchema: z.object({ session_id: z.string(), ref: z.string() }),
        jsonInputSchema: {},
        handler: async (args) => {
          actionCalls += 1;
          await markOperatorMutationDispatchAttempted();
          dispatched();
          await gate;
          return {
            session_id: args.session_id,
            url: resultUrl,
            stage: resultStage,
          };
        },
      },
    ];
    Object.defineProperty(broker, "tools", { value: tools });
    try {
      const identity = await broker.authenticate("token", "agent", "o".repeat(43));
      if (!identity) throw new Error("authentication failed");
      const principal = { ...identity, clientId: "client" };
      await broker.connected(principal);
      const { capability } = (await broker.call(
        principal,
        "tool",
        { name: "operate_start", args: {} },
        "start",
      )) as { capability: string };
      await broker.acknowledge(principal, "start");

      const action = broker.call(
        principal,
        "tool",
        {
          name: "operate_click",
          capability,
          args: { session_id: capability, ref: "@e:continue" },
        },
        "continue",
      );
      await dispatchObserved;
      broker.cancel(principal, "continue");
      release();

      await expect(action).resolves.toMatchObject({
        result: { url: resultUrl, stage: resultStage },
      });
      expect(actionCalls).toBe(1);
      await expect(
        journal.completedOutcome(identity.forwarderId!, "continue"),
      ).resolves.toMatchObject({
        outcome: { status: "completed" },
      });
    } finally {
      release();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it("retires a closing actor when terminal cleanup settles after delivery", async () => {
  const root = await mkdtemp(join(tmpdir(), "late-finish-"));
  const journal = new DispatchJournal(join(root, "journal.jsonl"));
  const broker = new OperatorBroker(
    {
      accountId: "account",
      agentSessionToken: "token",
      apiBaseUrl: "http://unused.test",
      registryBaseUrl: "http://unused.test",
    },
    journal,
  );
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let cleanup: Promise<void> | undefined;
  let count = 0;
  const tools: Tool[] = [
    {
      name: "operate_start",
      description: "",
      inputSchema: z.object({ service_url: z.string() }),
      jsonInputSchema: {},
      handler: async () => {
        const id = `internal-${++count}`;
        state.sessions.set(id, {
          browser: {
            brokerTargetId: async () => id,
            isConnected: () => true,
            waitForThreeDsResolution: async () => "succeeded",
          },
          pendingThreeDs: null,
        });
        return { session_id: id };
      },
    },
    {
      name: "operate_finish",
      description: "",
      inputSchema: z.object({ session_id: z.string() }),
      jsonInputSchema: {},
      handler: async (args) => {
        const { session_id } = z.object({ session_id: z.string() }).parse(args);
        cleanup = (async () => {
          await gate;
          await persistOperatorTerminalReceipt({
            session_id,
            operation_id: "finish",
            execution: "completed",
            mutation: "not_dispatched",
            cleanup: "closed",
            closed: true,
          });
          state.sessions.delete(session_id);
          settleOperatorTerminalReceipt();
        })();
        return { session_id: args.session_id, closed: false, cleanup: "closing" };
      },
    },
  ];
  Object.defineProperty(broker, "tools", { value: tools });
  try {
    const identity = await broker.authenticate("token", "agent", "q".repeat(43));
    if (!identity) throw new Error("authentication failed");
    const principal = { ...identity, clientId: "client" };
    await broker.connected(principal);
    const { capability } = (await broker.call(
      principal,
      "tool",
      { name: "operate_start", args: { service_url: "https://resend.com/" } },
      "start",
    )) as { capability: string };
    await broker.acknowledge(principal, "start");
    expect(
      await broker.call(
        principal,
        "tool",
        { name: "operate_finish", capability, args: { session_id: capability } },
        "finish",
      ),
    ).toMatchObject({ result: { closed: false } });
    expect(broker.authority.inventory().quarantined).toBe(1);
    release();
    await cleanup;
    expect(broker.authority.inventory()).toEqual({ active: 0, quarantined: 0, admitting: 0 });
    expect(
      await broker.call(
        principal,
        "tool",
        { name: "operate_finish", capability, args: { session_id: capability } },
        "retry",
      ),
    ).toMatchObject({ result: { closed: true, cleanup: "already_closed" } });
    expect(
      await broker.call(
        principal,
        "tool",
        { name: "operate_start", args: { service_url: "https://resend.com/" } },
        "next",
      ),
    ).toHaveProperty("capability");
  } finally {
    release();
    await cleanup;
    await rm(root, { recursive: true, force: true });
  }
});

it("delivers broker approval notifications to the originating MCP client before payment completes", async () => {
  const { buildServer } = await import("../../server.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { LoggingMessageNotificationSchema } = await import("@modelcontextprotocol/sdk/types.js");
  const root = await mkdtemp(join(tmpdir(), "ts-broker-notify-"));
  const path = join(root, "b.sock");
  const broker = new OperatorBroker(
    {
      accountId: "account",
      agentSessionToken: "token",
      apiBaseUrl: "http://unused.test",
      registryBaseUrl: "http://unused.test",
    },
  );
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let starts = 0;
  Object.defineProperty(broker, "tools", {
    value: [
      {
        name: "operate_start",
        description: "",
        inputSchema: z.object({}),
        jsonInputSchema: {},
        handler: async () => {
          const id = `internal-${++starts}`;
          state.sessions.set(id, {
            browser: {
              brokerTargetId: async () => id,
              isConnected: () => true,
              waitForThreeDsResolution: async () => "succeeded",
            },
            pendingThreeDs: null,
          });
          return { session_id: id };
        },
      },
      {
        name: "inject_card",
        description: "",
        inputSchema: z.object({ session_id: z.string() }),
        jsonInputSchema: {},
        handler: async (_args: unknown, _api: unknown, context?: ToolContext) => {
          await context!.notifyUser!("Approve payment on your phone", {
            approval_url: "https://approval.test/payment",
          });
          await waiting;
          return { status: "approval_pending" };
        },
      },
    ],
  });
  const listener = await listenBroker(path, {
    authenticate: (...args) => broker.authenticate(...args),
    connected: (principal) => broker.connected(principal),
    call: async (principal, method, params, id) => {
      if (method === "reclaim") return broker.reclaim(principal);
      if (method === "acknowledge") {
        await broker.acknowledge(principal, String(params.requestId));
        return {};
      }
      return broker.call(principal, method, params, id);
    },
    disconnect: (principal, explicit) => broker.disconnect(principal, explicit),
  });
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
  const forwarders = [
    new OperatorForwarder(path, guard, "a".repeat(43)),
    new OperatorForwarder(path, guard, "b".repeat(43)),
  ];
  const clients: InstanceType<typeof Client>[] = [];
  const messages: unknown[][] = [[], []];
  try {
    for (const [index, forwarder] of forwarders.entries()) {
      const server = await buildServer(
        { setRequestingAgent: () => undefined } as unknown as ApiClient,
        undefined,
        undefined,
        guard,
        forwarder,
      );
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client({ name: `notify-${index}`, version: "1" });
      client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
        messages[index]!.push(notification.params);
      });
      await client.connect(clientTransport);
      clients.push(client);
    }
    const started = (await forwarders[0]!.invoke("operate_start", {}, "start")) as {
      session_id: string;
    };
    let completed = false;
    const payment = clients[0]!
      .callTool({
        name: "inject_card",
        arguments: {
          session_id: started.session_id,
          merchant: "Test merchant",
          amount_cents: 100,
          currency: "USD",
          card_ref: "fixture-card",
          fields: { pan: { ref: "@pan" } },
          item: "Test purchase",
          reason: "Verify approval delivery",
        },
      })
      .finally(() => {
        completed = true;
      });
    await expect
      .poll(() => messages[0])
      .toEqual([
        {
          level: "notice",
          logger: "trusty-squire",
          data: {
            message: "Approve payment on your phone",
            approval_url: "https://approval.test/payment",
          },
        },
      ]);
    expect(completed).toBe(false);
    expect(messages[1]).toEqual([]);
    process.stdout.write(
      "broker approval delivery before completion:" +
        " " +
        JSON.stringify({
          originatingClient: messages[0],
          siblingClient: messages[1],
          paymentCompleted: completed,
        }) +
        "\n",
    );
    release();
    const result = await payment;
    expect(result.isError).not.toBe(true);
  } finally {
    release();
    await Promise.all(clients.map((client) => client.close()));
    await Promise.all(forwarders.map((forwarder) => forwarder.close()));
    await listener.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("does not fence stale refs or reconciled not-dispatched outcomes on the same lineage", async () => {
  const root = await mkdtemp(join(tmpdir(), "ts-ref-lineage-"));
  const journal = new DispatchJournal(join(root, "dispatch.jsonl"));
  const broker = new OperatorBroker(
    {
      accountId: "account",
      agentSessionToken: "token",
      apiBaseUrl: "http://unused.test",
      registryBaseUrl: "http://unused.test",
    },
    journal,
  );
  let nextSession = 0;
  let dispatchBeforeFailure = false;
  const start: Tool = {
    name: "operate_start",
    description: "",
    inputSchema: z.object({}),
    jsonInputSchema: {},
    handler: async () => {
      const id = `internal-${++nextSession}`;
      state.sessions.set(id, {
        browser: {
          brokerTargetId: async () => `target-${id}`,
          isConnected: () => true,
          waitForThreeDsResolution: async () => "succeeded",
        },
        pendingThreeDs: null,
      });
      return { session_id: id };
    },
  };
  const action = (name: string): Tool => ({
    name,
    description: "",
    inputSchema: z.object({ session_id: z.string() }),
    jsonInputSchema: {},
    handler: async () => {
      if (name === "operate_click") {
        if (dispatchBeforeFailure) await markOperatorMutationDispatchAttempted();
        throw new ProvenPreDispatchMutationError("stale_ref");
      }
      return { ok: true };
    },
  });
  Object.defineProperty(broker, "tools", {
    value: [start, action("operate_click"), action("operate_observe"), action("operate_navigate")],
  });
  const identity = await broker.authenticate("token", "agent", "a".repeat(43));
  const principal = { ...identity!, clientId: "client" };
  await broker.connected(principal);
  try {
    const started = (await broker.call(
      principal,
      "tool",
      { name: "operate_start", args: {} },
      "start",
    )) as { capability: string };
    await broker.acknowledge(principal, "start");
    const args = { session_id: started.capability };
    await expect(
      broker.call(
        principal,
        "tool",
        { name: "operate_click", args, capability: started.capability },
        "click",
      ),
    ).resolves.toEqual({ preDispatchFailure: { error: "stale_ref", dispatch: "not_dispatched" } });
    // No delivery acknowledgement or out-of-band recover metadata is needed.
    for (const name of ["operate_observe", "operate_navigate"]) {
      await expect(
        broker.call(principal, "tool", { name, args, capability: started.capability }, name),
      ).resolves.toMatchObject({ result: { ok: true } });
      await broker.acknowledge(principal, name);
    }
    await journal.record(args.session_id, "old-reconciled", "observed_result", {
      forwarderId: principal.forwarderId!,
      operation: "operate_click",
      dispatchTracked: true,
      outcome: { status: "not_dispatched", error: "stale_ref" },
    });
    await journal.assertReconciled();
    await expect(
      broker.call(principal, "tool", { name: "operate_start", args: {} }, "fresh-start"),
    ).resolves.toHaveProperty("capability");
    dispatchBeforeFailure = true;
    await expect(
      broker.call(
        principal,
        "tool",
        { name: "operate_click", args, capability: started.capability },
        "uncertain-click",
      ),
    ).rejects.toThrow("mutation=unknown");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
