import type * as SessionLifecycle from "../bot/session/lifecycle.js";
import { fixtureBrokerForwarder } from "./fixture-broker-forwarder.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { chromium } from "playwright";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type * as ProvisionSession from "../bot/provision-session.js";
import type { ApiClient } from "../api-client.js";
import type { Session } from "../bot/session/model.js";
import { BrowserController } from "../bot/browser.js";
import * as lifecycle from "../bot/session/lifecycle.js";
import { markOperatorMutationDispatchAttempted } from "../bot/request-cancellation.js";

vi.mock("../bot/session/lifecycle.js", async (original) => ({
  ...(await original<typeof SessionLifecycle>()),
  withProvisionSessionCall: async (_id: string, call: () => Promise<unknown>) => await call(),
}));
const state = vi.hoisted(() => ({ action: vi.fn() }));
vi.mock("../bot/provision-session.js", async (original) => ({
  ...(await original<typeof ProvisionSession>()),
  withProvisionSessionCall: async (_id: string, call: () => Promise<unknown>) => await call(),
  act: state.action,
  observedHostsForSession: () => ["vast-fixture.test"],
}));
import { buildServer } from "../server.js";

it("vaults a key that a Copy click writes only to the clipboard, without echoing it", async () => {
  // Vast.ai shape: the created-key dialog shows a truncated stub, and the
  // "Copy API key" button writes the full 64-char hex key to the clipboard.
  const key = "d7bd47d70c1e4f2a9b3c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f80bd4a";
  const stub = `${key.slice(0, 8)}...${key.slice(-4)}`;
  const root = await mkdtemp(join(tmpdir(), "clipboard-e2e-"));
  const context = await chromium.launchPersistentContext(join(root, "profile"), {
    channel: "chrome",
    headless: true,
    args: ["--no-sandbox"],
  });
  const page = context.pages()[0] ?? (await context.newPage());
  const controller = BrowserController.fromHarnessPage(page);
  const session = vi.spyOn(lifecycle, "sessionForCall").mockReturnValue({
    pendingThreeDs: null,
    actionTrace: [],
    browser: {
      activePage: () => page,
      waitForInteractiveDom: async () => undefined,
      brokerTargetId: async () => "fixture-target",
      isConnected: () => true,
      readClipboard: (target: typeof page) => controller.readClipboard(target),
    },
  } as unknown as Session);
  const storeCredential = vi.fn(async () => ({
    reference: "vault://fixture/vast",
    service: "Vast fixture",
    label: "default",
    field_names: ["value"],
    allowed_hosts: ["vast-fixture.test"],
    created_at: "2026-10-07T00:00:00Z",
    updated: false,
  }));
  const api = { setRequestingAgent: vi.fn(), storeCredential } as unknown as ApiClient;
  const fixture = await fixtureBrokerForwarder(root, api, "fixture");
  const server = await buildServer(api, undefined, undefined, undefined, fixture.forwarder);
  const [transport, peer] = InMemoryTransport.createLinkedPair();
  await server.connect(peer);
  const client = new Client({ name: "clipboard-fixture", version: "1" });
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown>) =>
    await client.callTool({ name, arguments: { session_id: fixture.sessionId, ...args } });
  const capture = { store: { service: "Vast fixture" }, source: { clipboard: true } };
  state.action.mockImplementation(async () => {
    await markOperatorMutationDispatchAttempted();
    await page.getByRole("button", { name: "Copy API key", exact: true }).click();
    return { done: true };
  });
  // The key reaches the page only as base64 inside the click handler.
  const html = `<!doctype html><div role="dialog" aria-label="API key created">
    <h2>API key created</h2><label>API key <input readonly value="${stub}"></label>
    <button type="button" aria-label="Copy API key">Copy</button></div>
    <script>document.querySelector('[aria-label="Copy API key"]').addEventListener('click',
      () => navigator.clipboard.writeText(atob('${Buffer.from(key).toString("base64")}')));</script>`;
  await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: html }));
  try {
    await page.goto("http://127.0.0.1/");
    expect(await page.content()).not.toContain(key);

    const copied = await call("operate_click", { ref: "@copy", capture });
    expect(copied.isError, JSON.stringify(copied)).not.toBe(true);
    expect(storeCredential).toHaveBeenCalledTimes(1);
    expect(storeCredential).toHaveBeenLastCalledWith(expect.objectContaining({ value: key }));
    expect(copied.structuredContent).toMatchObject({
      stored: true,
      resolved_source: { clipboard: true },
    });
    const echoed = JSON.stringify(copied);
    for (const part of [key, key.slice(8, -4), key.slice(16, 48)])
      expect(echoed).not.toContain(part);

    // A second click writes the same value: the clipboard did not change, so
    // nothing is stored and the stale value is never vaulted.
    const repeated = await call("operate_click", { ref: "@copy", capture });
    expect(repeated.structuredContent).toMatchObject({
      stored: false,
      error: "capture_clipboard_unchanged",
      retry: "extract_only",
    });
    expect(JSON.stringify(repeated)).not.toContain(key.slice(16, 48));
    expect(storeCredential).toHaveBeenCalledTimes(1);

    // The clipboard source needs a click's before/after proof.
    const extracted = await call("operate_extract", { capture });
    expect(extracted.isError).toBe(true);
    expect(JSON.stringify(extracted)).toContain("only valid on operate_click");
    expect(storeCredential).toHaveBeenCalledTimes(1);
  } finally {
    await client.close();
    await server.close();
    await fixture.close();
    session.mockRestore();
    await context.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
