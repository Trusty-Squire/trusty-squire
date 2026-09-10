import {
  persistOperatorTerminalReceipt,
  settleOperatorTerminalReceipt,
  markOperatorMutationDispatchAttempted,
} from "../request-cancellation.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
import { DispatchJournal, START_DELIVERY_RETENTION_MS } from "../broker/dispatch-journal.js";
import { OperatorForwarder } from "../broker/forwarder.js";
import { forwarderId } from "../broker/lineage.js";
import { OperatorBroker } from "../broker/operator.js";
import { listenBroker } from "../broker/transport.js";
import type { BrokerPrincipal, TabCapability } from "../broker/authority.js";
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
    "cell",
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
    capability: TabCapability;
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
    )) as { capability: TabCapability };
    await broker.acknowledge(principal, `start-${index}`);
    await broker.confirmStartDelivery(principal, { capability: started.capability });
    clients.push({ principal, capability: started.capability });
  }

  try {
    const login = (index: number, requestId: string) => {
      const client = clients[index]!;
      const args = {
        session_id: client.capability.sessionId,
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
      journal.hasOutstanding(clients[2]!.capability.sessionId, clients[2]!.principal.forwarderId),
    ).resolves.toBe(false);
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

it("recovers an explicitly proven stale-ref pre-dispatch failure without replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "ts-broker-pre-dispatch-"));
  const path = join(root, "dispatch.jsonl");
  const journal = new DispatchJournal(path);
  const retainedSessionId = "546b6f5a-930e-4473-8aec-43fc355fd108";
  const retainedRequestId =
    "4ae34aeb-e1b8-4457-a99b-72ac418600ca:4e07408562bedb8b60ce05c1decfe3ad16b72230967de01f640b7e4729b49fce";
  const lineageCredential = "a".repeat(43);
  const retainedForwarderId = forwarderId(lineageCredential);
  const retainedInputHash = "retained-input-hash";
  await journal.record(retainedSessionId, retainedRequestId, "entered", {
    forwarderId: retainedForwarderId,
    operation: "operate_login",
    inputHash: retainedInputHash,
  });
  const authorization = await journal.retainedXataPreDispatchAuthorization();
  if (authorization === undefined) throw new Error("Retained authorization was not captured");
  const broker = new OperatorBroker(
    {
      accountId: "account",
      agentSessionToken: "token",
      apiBaseUrl: "http://unused.test",
      registryBaseUrl: "http://unused.test",
    },
    "cell",
    journal,
    authorization,
  );
  const identity = await broker.authenticate("token", "agent", lineageCredential);
  if (identity === null) throw new Error("Test broker authentication failed");
  const principal = { ...identity, clientId: "client" };
  const internalId = "new-session";
  let loginAttempts = 0;
  let observations = 0;
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
      loginAttempts += 1;
      return { unexpected: true };
    },
  };
  const observeTool: Tool = {
    name: "operate_observe",
    description: "",
    inputSchema: z.object({ session_id: z.string() }).strict(),
    jsonInputSchema: {},
    handler: async () => ({ observed: ++observations }),
  };
  Object.defineProperty(broker, "tools", { value: [startTool, loginTool, observeTool] });

  try {
    await broker.connected(principal);
    const args = {
      session_id: retainedSessionId,
      provider: "google" as const,
      ref: "reconciliation-only:no-dispatch",
    };
    const recoveryRequest = {
      name: "operate_login",
      args,
      preDispatchFailure: {
        requestId: retainedRequestId,
        error: "stale_ref" as const,
        dispatch: "not_dispatched" as const,
      },
    };
    await journal.record(retainedSessionId, retainedRequestId, "entered", {
      forwarderId: retainedForwarderId,
      operation: "operate_login",
    });
    await expect(broker.recover(principal, recoveryRequest)).resolves.toBeNull();
    await journal.record(retainedSessionId, retainedRequestId, "entered", {
      forwarderId: retainedForwarderId,
      operation: "operate_login",
      inputHash: "different-input-hash",
    });
    await expect(broker.recover(principal, recoveryRequest)).resolves.toBeNull();
    await journal.record(retainedSessionId, retainedRequestId, "entered", {
      forwarderId: retainedForwarderId,
      operation: "operate_login",
      inputHash: retainedInputHash,
    });
    await expect(journal.hasOutstanding(retainedSessionId)).resolves.toBe(true);

    const foreignIdentity = await broker.authenticate("token", "other-agent", "b".repeat(43));
    if (foreignIdentity === null) throw new Error("Foreign broker authentication failed");
    await expect(
      broker.recover(
        { ...foreignIdentity, clientId: "foreign-client" },
        {
          name: "operate_login",
          args,
          preDispatchFailure: {
            requestId: retainedRequestId,
            error: "stale_ref",
            dispatch: "not_dispatched",
          },
        },
      ),
    ).resolves.toBeNull();
    await expect(journal.hasOutstanding(retainedSessionId)).resolves.toBe(true);

    const recovered = await broker.recover(principal, recoveryRequest);
    expect(recovered).toEqual({
      requestId: retainedRequestId,
      result: {
        reconciliation: {
          request_id: retainedRequestId,
          operation: "operate_login",
          status: "not_dispatched",
          error: "stale_ref",
        },
      },
    });
    await expect(journal.hasOutstanding(retainedSessionId)).resolves.toBe(false);
    await broker.acknowledge(principal, retainedRequestId);
    await expect(journal.hasOutstanding(retainedSessionId)).resolves.toBe(false);
    const restartedJournal = new DispatchJournal(path);
    const restartedAuthorization = await restartedJournal.retainedXataPreDispatchAuthorization();
    if (restartedAuthorization === undefined)
      throw new Error("Settled authorization was not restored");
    const restartedBroker = new OperatorBroker(
      {
        accountId: "account",
        agentSessionToken: "token",
        apiBaseUrl: "http://unused.test",
        registryBaseUrl: "http://unused.test",
      },
      "restarted-cell",
      restartedJournal,
      restartedAuthorization,
    );
    Object.defineProperty(restartedBroker, "tools", {
      value: [startTool, loginTool, observeTool],
    });
    const restartedIdentity = await restartedBroker.authenticate(
      "token",
      "agent",
      lineageCredential,
    );
    if (restartedIdentity === null) throw new Error("Restarted broker authentication failed");
    const journalBeforeReplay = await readFile(path, "utf8");
    await expect(
      restartedBroker.recover(
        { ...restartedIdentity, clientId: "restarted-client" },
        recoveryRequest,
      ),
    ).resolves.toEqual(recovered);
    await expect(readFile(path, "utf8")).resolves.toBe(journalBeforeReplay);
    expect(loginAttempts).toBe(0);

    const started = (await broker.call(
      principal,
      "tool",
      { name: "operate_start", args: {} },
      "start-request",
    )) as { capability: TabCapability };
    await broker.acknowledge(principal, "start-request");
    await broker.confirmStartDelivery(principal, { capability: started.capability });

    await expect(
      broker.call(
        principal,
        "tool",
        {
          name: "operate_observe",
          args: { session_id: started.capability.sessionId },
          capability: started.capability,
        },
        "observe-request",
      ),
    ).resolves.toMatchObject({ result: { observed: 1 } });
    await expect(new DispatchJournal(path).assertReconciled()).resolves.toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("keeps an ambiguous thrown mutation fenced and unrecoverable", async () => {
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
    "cell",
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
    )) as { capability: TabCapability };
    await broker.acknowledge(principal, "start-request");
    await broker.confirmStartDelivery(principal, { capability: started.capability });
    const args = {
      session_id: started.capability.sessionId,
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
    await expect(
      broker.recover(principal, {
        name: "operate_login",
        args,
        preDispatchFailure: {
          requestId: "login-request",
          error: "stale_ref",
          dispatch: "not_dispatched",
        },
      }),
    ).resolves.toMatchObject({
      requestId: "login-request",
      result: { reconciliation: { status: "unknown", request_id: "login-request" } },
    });
    await expect(new DispatchJournal(path).assertReconciled()).rejects.toThrow(
      "lost mutation custody",
    );
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
      handler: async () =>
        toolName === "operate_observe" ? { dom: "ready" } : { done: true, closed: true },
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

it("retains pre-registration cancellations without crossing connection identities", async () => {
  const broker = new OperatorBroker(
    {
      accountId: "account",
      agentSessionToken: "token",
      apiBaseUrl: "http://unused.test",
      registryBaseUrl: "http://unused.test",
    },
    "cell",
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

it("bounds cancellation tombstones instead of evicting older cancellation evidence", async () => {
  const broker = new OperatorBroker(
    {
      accountId: "account",
      agentSessionToken: "token",
      apiBaseUrl: "http://unused.test",
      registryBaseUrl: "http://unused.test",
    },
    "cell",
  );
  const owner = { accountId: "account", agentId: "agent", clientId: "one" };
  for (let i = 0; i < 8192; i++) broker.cancel(owner, String(i));
  expect(() => broker.cancel(owner, "overflow")).toThrow("budget exhausted");
  await expect(broker.call(owner, "wrong-method", {}, "0")).rejects.toThrow(
    "cancelled before registration",
  );
});

it("permits only lineage-bound extraction recovery for a journaled capture write", async () => {
  const root = await mkdtemp(join(tmpdir(), "ts-capture-recovery-"));
  try {
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
    const identity = await broker.authenticate("token", "agent", "c".repeat(43));
    if (identity === null) throw new Error("authentication failed");
    const principal = { ...identity, clientId: "client" };
    const capability = {
      cellId: "cell",
      browserEpoch: "epoch",
      sessionId: "session",
      targetId: "target",
      leaseGeneration: "lease",
    };
    const hasCapability = vi.spyOn(broker.authority, "hasCapability").mockReturnValue(true);
    const params = {
      name: "operate_extract",
      capability,
      args: { session_id: "session", capture: { write_id: "capture-1" } },
    };
    expect(await broker.canReconcileCapture(principal, params)).toBe(false);
    await journal.record("session", "create", "unknown", {
      forwarderId: identity.forwarderId!,
      operation: "operate_click",
      outcome: {
        status: "unknown",
        reason: "cancelled",
        capture: { write_id: "capture-1", stored: false, storage: "unknown" },
      },
    });
    expect(await broker.canReconcileCapture(principal, params)).toBe(true);
    expect(await broker.canReconcileCapture(principal, { ...params, name: "operate_click" })).toBe(
      false,
    );
    expect(await broker.canReconcileCapture({ ...principal, forwarderId: "foreign" }, params)).toBe(
      false,
    );
    expect(
      await broker.canReconcileCapture(principal, {
        ...params,
        args: { session_id: "session", capture: { write_id: "guessed" } },
      }),
    ).toBe(false);
    hasCapability.mockReturnValue(false);
    expect(await broker.canReconcileCapture(principal, params)).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
    "cell",
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
    )) as { capability: TabCapability };
    await broker.acknowledge(principal, "start");
    await broker.confirmStartDelivery(principal, { capability });
    const work = broker
      .call(
        principal,
        "tool",
        { name: "operate_navigate", capability, args: { session_id: capability.sessionId } },
        "navigate",
      )
      .catch((error: unknown) => error);
    await started;
    broker.cancel(principal, "navigate");
    release();
    await work;
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
      "cell",
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
      )) as { capability: TabCapability };
      await broker.acknowledge(principal, "start");
      await broker.confirmStartDelivery(principal, { capability });

      const action = broker.call(
        principal,
        "tool",
        {
          name: "operate_click",
          capability,
          args: { session_id: capability.sessionId, ref: "@e:continue" },
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
    "cell",
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
    )) as { capability: TabCapability };
    await broker.acknowledge(principal, "start");
    await broker.confirmStartDelivery(principal, { capability });
    expect(
      await broker.call(
        principal,
        "tool",
        { name: "operate_finish", capability, args: { session_id: capability.sessionId } },
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
        { name: "operate_finish", capability, args: { session_id: capability.sessionId } },
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

it("refuses credential finish when capture becomes unresolved during call draining", async () => {
  const root = await mkdtemp(join(tmpdir(), "finish-capture-"));
  const journal = new DispatchJournal(join(root, "journal.jsonl"));
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
      name: "operate_finish",
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
    )) as { capability: TabCapability };
    await broker.acknowledge(principal, "start");
    await broker.confirmStartDelivery(principal, { capability });
    const work = broker
      .call(
        principal,
        "tool",
        { name: "operate_finish", capability, args: { session_id: capability.sessionId } },
        "navigate",
      )
      .catch((error: unknown) => error);
    await started;
    await journal.recordCapture(
      identity.forwarderId!,
      capability.sessionId,
      "create",
      {
        write_id: "original",
        binding: "service",
        stored: false,
        storage: "unknown",
      },
      false,
    );
    release();
    expect(await work).toMatchObject({ message: expect.stringContaining("original capture") });
    expect(dispatch).not.toHaveBeenCalled();
  } finally {
    release();
    await rm(root, { recursive: true, force: true });
  }
});
