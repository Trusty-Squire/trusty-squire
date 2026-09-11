import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type * as ProvisionSession from "../bot/provision-session.js";
import type { ApiClient } from "../api-client.js";
import { markOperatorMutationDispatchAttempted } from "../bot/request-cancellation.js";
const state = vi.hoisted(() => ({ action: vi.fn(), capture: vi.fn() }));
vi.mock("../bot/provision-session.js", async (original) => ({
  ...(await original<typeof ProvisionSession>()),
  withProvisionSessionCall: async (_id: string, call: () => Promise<unknown>) => await call(),
  act: state.action,
  captureCredentialSource: state.capture,
  extractCredentials: async () => ({ credentials: { api_key: "fixture-secret" } }),
  observedHostsForSession: () => ["example.test"],
}));
import { buildServer } from "../server.js";
import { DispatchJournal } from "../bot/broker/dispatch-journal.js";

it("keeps ordinary actions usable while a capture is unresolved, fencing only re-creation", async () => {
  const root = await mkdtemp(join(tmpdir(), "direct-capture-"));
  const journal = new DispatchJournal(join(root, "journal.jsonl"));
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
  const server = await buildServer(
    { setRequestingAgent: vi.fn(), storeCredential } as unknown as ApiClient,
    undefined,
    undefined,
    undefined,
    undefined,
    { journal, lineage: () => "lineage" },
  );
  const [transport, peer] = InMemoryTransport.createLinkedPair();
  await server.connect(peer);
  const client = new Client({ name: "capture-test", version: "1" });
  await client.connect(transport);
  const capture = { store: { service: "Example", label: "fresh" }, source: { role: "code" } };
  try {
    const first = await client.callTool({
      name: "operate_click",
      arguments: { session_id: "session", ref: "@create", capture },
    });
    expect(first.structuredContent).toMatchObject({ stored: false, retry: "extract_only" });
    const content = first.structuredContent as Record<string, unknown>;
    expect(typeof content.write_id).toBe("string");
    const write_id = content.write_id;
    // An unresolved capture must not wedge unrelated actions: a plain click
    // (no capture) proceeds while the write_id retry stays available.
    const ordinary = await client.callTool({
      name: "operate_click",
      arguments: { session_id: "session", ref: "@other" },
    });
    expect(ordinary.isError).not.toBe(true);
    // Only a NEW vaulting attempt — a repeated key creation — is fenced.
    const repeated = await client.callTool({
      name: "operate_click",
      arguments: { session_id: "session", ref: "@create", capture },
    });
    expect(repeated.isError).toBe(true);
    expect(state.action).toHaveBeenCalledTimes(2); // first capture click + ordinary click
    const finish = await client.callTool({
      name: "operate_finish",
      arguments: { session_id: "session", outcome: "credentials", store: { service: "Example" } },
    });
    expect(finish.isError).toBe(true);
    expect(storeCredential).toHaveBeenCalledOnce();
    const wrong = await client.callTool({
      name: "operate_extract",
      arguments: { session_id: "session", capture: { ...capture, write_id: "other" } },
    });
    expect(wrong.isError).toBe(true);
    expect(state.capture).toHaveBeenCalledOnce();
    const newStore = await client.callTool({
      name: "operate_extract",
      arguments: { session_id: "session", store: capture.store },
    });
    expect(newStore.isError).toBe(true);
    expect(storeCredential).toHaveBeenCalledOnce();
    const read = await client.callTool({
      name: "operate_extract",
      arguments: { session_id: "session" },
    });
    expect(read.isError).not.toBe(true);
    expect(read.structuredContent).toMatchObject({ credentials: { api_key: "fixture-secret" } });
    expect(storeCredential).toHaveBeenCalledOnce();
    const recovered = await client.callTool({
      name: "operate_extract",
      arguments: { session_id: "session", capture: { ...capture, write_id } },
    });
    expect(recovered.structuredContent).toMatchObject({ stored: true });
    expect(storeCredential.mock.calls.map(([input]) => input.write_id)).toEqual([
      write_id,
      write_id,
    ]);
    expect(state.action).toHaveBeenCalledTimes(2);
  } finally {
    await client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
