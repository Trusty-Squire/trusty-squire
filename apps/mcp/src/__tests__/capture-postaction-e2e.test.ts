import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { chromium, type Page } from "playwright";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type * as ProvisionSession from "../bot/provision-session.js";
import type { ApiClient } from "../api-client.js";
import type { Session } from "../bot/session/model.js";
import * as lifecycle from "../bot/session/lifecycle.js";
import { markOperatorMutationDispatchAttempted } from "../bot/request-cancellation.js";

const state = vi.hoisted(() => ({ action: vi.fn() }));
vi.mock("../bot/provision-session.js", async (original) => ({
  ...(await original<typeof ProvisionSession>()),
  withProvisionSessionCall: async (_id: string, call: () => Promise<unknown>) => await call(),
  act: state.action,
  observedHostsForSession: () => ["groq-fixture.test"],
}));
import { buildServer } from "../server.js";
import { DispatchJournal } from "../bot/broker/dispatch-journal.js";

it("captures a created key through MCP and recovers an unchanged source without replaying creation", async () => {
  const root = await mkdtemp(join(tmpdir(), "postaction-e2e-"));
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const page: Page = await browser.newPage();
  const session = vi.spyOn(lifecycle, "sessionForCall").mockReturnValue({
    browser: { activePage: () => page, waitForInteractiveDom: async () => undefined },
  } as unknown as Session);
  const writes: unknown[] = [];
  const storeCredential = vi.fn(async (input) => {
    writes.push(input);
    return { reference: "vault://fixture/key", service: "Groq fixture", label: "fresh",
      field_names: ["value"], allowed_hosts: ["groq-fixture.test"],
      created_at: "2026-09-11T00:00:00Z", updated: false };
  });
  const server = await buildServer(
    { setRequestingAgent: vi.fn(), storeCredential } as unknown as ApiClient,
    undefined, undefined, undefined, undefined,
    { journal: new DispatchJournal(join(root, "journal.jsonl")), lineage: () => "fixture" },
  );
  const [transport, peer] = InMemoryTransport.createLinkedPair();
  await server.connect(peer);
  const client = new Client({ name: "postaction-fixture", version: "1" });
  await client.connect(transport);
  const transcript: unknown[] = [];
  const evidence = process.env.CAPTURE_TEST_EVIDENCE_DIR;
  const capture = { store: { service: "Groq fixture", label: "fresh" }, source: { role: "textbox" } };
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: { session_id: "fixture", ...args } });
    transcript.push({ name, arguments: args, response: result });
    return result;
  };
  state.action.mockImplementation(async () => {
    await markOperatorMutationDispatchAttempted();
    await page.getByRole("button", { name: "Create key", exact: true }).click();
    return { done: true };
  });
  try {
    if (evidence) await mkdir(evidence, { recursive: true });
    await page.setContent(`<h1>API keys — Groq-shaped fixture</h1>
      <label>Display name <input value="My key display name"></label>
      <button onclick="setTimeout(() => { document.body.innerHTML = '<h1>API keys — Groq-shaped fixture</h1><section role=dialog aria-label=Created><h2>Created API key</h2><label>API key <input value=gsk_fixture_created></label></section>'; }, 400)">Create key</button>`);
    if (evidence) await page.screenshot({ path: join(evidence, "before-create.png") });
    const created = await call("operate_click", { ref: "@create", capture });
    expect(created.isError).not.toBe(true);
    expect(storeCredential).toHaveBeenLastCalledWith(expect.objectContaining({ value: "gsk_fixture_created" }));
    expect(created.structuredContent).toMatchObject({ stored: true,
      resolved_source: { tag: "input", role: "textbox", name: "API key" } });
    expect(JSON.stringify(created)).not.toContain("gsk_fixture_created");
    if (evidence) await page.screenshot({ path: join(evidence, "after-create.png") });

    await page.setContent(`<h1>Unchanged creation result</h1><label>Display name <input value="My key display name"></label><button onclick="document.body.dataset.clicks = String(Number(document.body.dataset.clicks || 0) + 1)">Create key</button>`);
    const unresolved = await call("operate_click", { ref: "@create", capture });
    expect(unresolved.structuredContent).toMatchObject({ stored: false, storage: "unknown", error: "capture_pre_action_only", retry: "extract_only" });
    expect(JSON.stringify(unresolved)).not.toContain("My key display name");
    expect(storeCredential).toHaveBeenCalledTimes(1);
    const write_id = (unresolved.structuredContent as Record<string, unknown>).write_id;
    const ordinary = await call("operate_click", { ref: "@create" });
    expect(ordinary.isError).not.toBe(true);
    expect(await page.locator("body").getAttribute("data-clicks")).toBe("2");
    expect((await call("operate_click", { ref: "@create", capture })).isError).toBe(true);
    expect((await call("operate_extract", { store: capture.store })).isError).toBe(true);
    expect((await call("operate_finish", { outcome: "credentials", store: capture.store })).isError).toBe(true);
    expect(storeCredential).toHaveBeenCalledTimes(1);
    await page.setContent('<h1>Delayed result ready for extraction</h1><label>API key <input value="gsk_fixture_recovered"></label>');
    const recovered = await call("operate_extract", { capture: { ...capture, write_id } });
    expect(recovered.structuredContent).toMatchObject({ stored: true, write_id,
      resolved_source: { tag: "input", role: "textbox", name: "API key" } });
    expect(storeCredential).toHaveBeenLastCalledWith(expect.objectContaining({ value: "gsk_fixture_recovered", write_id }));
    expect(state.action).toHaveBeenCalledTimes(3);
    if (evidence) await writeFile(join(evidence, "mcp-capture-transcript.json"), JSON.stringify({
      scope: "MCP client/server with real Chromium capture; action adapter clicks the fixture button; vault API is an in-memory test double. All values are synthetic.",
      transcript, vaultRequests: writes, dispatchedClicks: state.action.mock.calls.length,
    }, null, 2));
  } finally {
    await client.close();
    await server.close();
    session.mockRestore();
    await browser.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
