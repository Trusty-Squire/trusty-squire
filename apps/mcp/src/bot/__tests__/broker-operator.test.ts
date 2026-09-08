import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z, type Tool } from "../../tools/index.js";

const state = vi.hoisted(() => ({
  sessions: new Map<string, { browser: { brokerTargetId(): Promise<string> } }>(),
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
import { DispatchJournal } from "../broker/dispatch-journal.js";
import { OperatorBroker } from "../broker/operator.js";

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
        },
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
  state.finish.mockImplementation(async (sessionId: string) => ({ session_id: sessionId, url: "", closed: true }));
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
