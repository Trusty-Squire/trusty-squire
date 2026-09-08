import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
