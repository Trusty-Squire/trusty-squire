import type * as SessionLifecycle from "../bot/session/lifecycle.js";
import { fixtureBrokerForwarder } from "./fixture-broker-forwarder.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type * as ProvisionSession from "../bot/provision-session.js";
import type { ApiClient } from "../api-client.js";
import { markOperatorMutationDispatchAttempted } from "../bot/request-cancellation.js";
vi.mock("../bot/session/lifecycle.js", async (original) => ({
  ...(await original<typeof SessionLifecycle>()),
  sessionForCall: () => ({
    browser: {
      brokerTargetId: async () => "fixture-target",
      isConnected: () => true,
    },
    pendingThreeDs: null,
    actionTrace: [],
  }),
  withProvisionSessionCall: async (_id: string, call: () => Promise<unknown>) => await call(),
}));
const state = vi.hoisted(() => ({ action: vi.fn(), capture: vi.fn() }));
vi.mock("../bot/provision-session.js", async (original) => ({
  ...(await original<typeof ProvisionSession>()),
  withProvisionSessionCall: async (_id: string, call: () => Promise<unknown>) => await call(),
  act: state.action,
  captureCredentialSource: state.capture,
  extractCredentials: async () => ({ credentials: { api_key: "fixture-secret" } }),
  observedHostsForSession: () => ["example.test"],
  finishProvisionSessionWithPreparation: async (
    _sessionId: string,
    prepare: () => Promise<unknown>,
  ) => ({
    finish: {
      session_id: _sessionId,
      operation_id: "fixture-finish",
      execution: "completed",
      mutation: "not_dispatched",
      cleanup: "closed",
      closed: true,
      url: "https://example.test/",
    },
    prepared: await prepare(),
  }),
}));
import { buildServer } from "../server.js";

it("keeps ordinary actions and vaulting usable while a capture is unresolved", async () => {
  const root = await mkdtemp(join(tmpdir(), "broker-capture-"));
  state.action.mockImplementation(async () => {
    await markOperatorMutationDispatchAttempted();
    return { done: true };
  });
  state.capture.mockResolvedValue({ candidate_count: 1, value: "fixture-secret" });
  const storeCredential = vi
    .fn()
    .mockRejectedValueOnce(new Error("storage lost"))
    .mockResolvedValue({
      reference: "vault://new",
      service: "Example",
      label: "fresh",
      field_names: ["value"],
      allowed_hosts: ["example.test"],
      created_at: new Date().toISOString(),
      updated: false,
    });
  const api = {
    setRequestingAgent: vi.fn(),
    storeCredential,
    withAuditContext: async (_context: unknown, operation: () => Promise<unknown>) =>
      await operation(),
  } as unknown as ApiClient;
  const fixture = await fixtureBrokerForwarder(root, api, "session");
  const { forwarder, sessionId } = fixture;
  const server = await buildServer(api, undefined, undefined, undefined, forwarder);
  const [transport, peer] = InMemoryTransport.createLinkedPair();
  await server.connect(peer);
  const client = new Client({ name: "capture-test", version: "1" });
  await client.connect(transport);
  const capture = { store: { service: "Example", label: "fresh" }, source: { role: "code" } };
  try {
    const first = await client.callTool({
      name: "operate_click",
      arguments: { session_id: sessionId, ref: "@create", capture },
    });
    expect(first.structuredContent).toMatchObject({ stored: false, retry: "extract_only" });
    const content = first.structuredContent as Record<string, unknown>;
    expect(typeof content.write_id).toBe("string");
    const write_id = content.write_id;
    // An unresolved capture must not wedge unrelated actions: a plain click
    // (no capture) proceeds while the write_id retry stays available.
    const ordinary = await client.callTool({
      name: "operate_click",
      arguments: { session_id: sessionId, ref: "@other" },
    });
    expect(ordinary.isError).not.toBe(true);
    // No custody fence: a repeated vaulting attempt proceeds like any other
    // capture and vaults through the resolved store.
    const repeated = await client.callTool({
      name: "operate_click",
      arguments: { session_id: sessionId, ref: "@create", capture },
    });
    expect(repeated.isError).not.toBe(true);
    expect(repeated.structuredContent).toMatchObject({ stored: true });
    expect(state.action).toHaveBeenCalledTimes(3); // first capture click + ordinary + repeated
    expect(storeCredential).toHaveBeenCalledTimes(2);
    const read = await client.callTool({
      name: "operate_extract",
      arguments: { session_id: sessionId },
    });
    expect(read.isError, JSON.stringify(read)).not.toBe(true);
    expect(read.structuredContent).toMatchObject({ credentials: { api_key: "fixture-secret" } });
    expect(storeCredential).toHaveBeenCalledTimes(2);
    const recovered = await client.callTool({
      name: "operate_extract",
      arguments: { session_id: sessionId, capture: { ...capture, write_id } },
    });
    expect(recovered.structuredContent).toMatchObject({ stored: true });
    // Store #1 = original capture (rejected, recovered later); #2 = the repeated
    // capture's own write; #3 = the write_id recovery of the original.
    const storeWriteIds = storeCredential.mock.calls.map(([input]) => input.write_id);
    expect(storeWriteIds[0]).toBe(write_id);
    expect(storeWriteIds[1]).not.toBe(write_id);
    expect(storeWriteIds[2]).toBe(write_id);
    expect(state.action).toHaveBeenCalledTimes(3);
    // Finish is the terminal: it proceeds (no custody fence) and retires the
    // session, so it must come last.
    const finish = await client.callTool({
      name: "operate_finish",
      arguments: { session_id: sessionId, outcome: "credentials", store: { service: "Example" } },
    });
    expect(finish.isError).not.toBe(true);
    expect(storeCredential).toHaveBeenCalledTimes(4); // + finish's own vault store
  } finally {
    await client.close();
    await server.close();
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});
