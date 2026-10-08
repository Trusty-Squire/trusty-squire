import type * as SessionLifecycle from "../bot/session/lifecycle.js";
import { fixtureBrokerForwarder } from "./fixture-broker-forwarder.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { chromium, type BrowserContext, type Page } from "playwright";
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
  observedHostsForSession: () => ["shape-fixture.test"],
}));
import { buildServer } from "../server.js";

// Values a shape check would reject: no known prefix, hex, short, all
// uppercase, UUID-like. Each source below proves where the value came from.
const SHAPES = [
  ["64-char lowercase hex", "d7bd47d70c1e4f2a9b3c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f80bd4a"],
  ["short", "Ab3kZ9"],
  ["all-uppercase", "QWERTYUIOPASDFGHJKLZ"],
  ["UUID-like", "123e4567-e89b-12d3-a456-426614174000"],
  ["unprefixed mixed", "kq3ZpX9vLmT2"],
] as const;

let root: string;
let context: BrowserContext;
let page: Page;
let client: Client;
let close: () => Promise<void>;
const storeCredential = vi.fn(async () => ({
  reference: "vault://fixture/shape",
  service: "Shape fixture",
  label: "default",
  field_names: ["value"],
  allowed_hosts: ["shape-fixture.test"],
  created_at: "2026-10-07T00:00:00Z",
  updated: false,
}));

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "capture-shape-e2e-"));
  context = await chromium.launchPersistentContext(join(root, "profile"), {
    channel: "chrome",
    headless: true,
    args: ["--no-sandbox"],
  });
  page = context.pages()[0] ?? (await context.newPage());
  const controller = BrowserController.fromHarnessPage(page);
  const browser = Object.assign(Object.create(controller) as BrowserController, {
    brokerTargetId: async () => "fixture-target",
    isConnected: () => true,
  });
  const session = vi.spyOn(lifecycle, "sessionForCall").mockReturnValue({
    pendingThreeDs: null,
    actionTrace: [],
    browser,
  } as unknown as Session);
  const api = { setRequestingAgent: vi.fn(), storeCredential } as unknown as ApiClient;
  const fixture = await fixtureBrokerForwarder(root, api, "fixture");
  const server = await buildServer(api, undefined, undefined, undefined, fixture.forwarder);
  const [transport, peer] = InMemoryTransport.createLinkedPair();
  await server.connect(peer);
  client = new Client({ name: "shape-fixture", version: "1" });
  await client.connect(transport);
  // The agent's own operate_click: a real click on the Copy button.
  state.action.mockImplementation(async () => {
    await markOperatorMutationDispatchAttempted();
    await page.getByRole("button", { name: "Copy API key", exact: true }).click();
    return { done: true };
  });
  close = async () => {
    await client.close();
    await server.close();
    await fixture.close();
    session.mockRestore();
  };
  const sessionId = fixture.sessionId;
  call = async (name, args) =>
    await client.callTool({ name, arguments: { session_id: sessionId, ...args } });
}, 30_000);

afterAll(async () => {
  await close?.();
  await context?.close();
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

let call: (name: string, args: Record<string, unknown>) => ReturnType<Client["callTool"]>;

/** A created-key dialog: a stub, the full key in a readonly input that only a
 * targeted capture reads, and a Copy button that writes the key. */
async function showKey(key: string, inputValue: string): Promise<void> {
  const html = `<!doctype html><div role="dialog" aria-label="API key created">
    <h2>API key created</h2><label>API key <input id="key" readonly value="${inputValue}"></label>
    <button type="button" aria-label="Copy API key">Copy</button></div>
    <script>document.querySelector('[aria-label="Copy API key"]').addEventListener('click',
      () => navigator.clipboard.writeText(atob('${Buffer.from(key).toString("base64")}')));</script>`;
  await page.unrouteAll();
  await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto("http://127.0.0.1/");
}

function storedValue(): unknown {
  return (storeCredential.mock.lastCall as unknown as [{ value?: string }] | undefined)?.[0]?.value;
}

it.each(SHAPES)(
  "stores a %s key from a Copy click with a clipboard capture",
  async (_n, key) => {
    await showKey(key, "••••");
    storeCredential.mockClear();
    const result = await call("operate_click", {
      ref: "@copy",
      capture: { store: { service: "Shape fixture" }, source: { clipboard: true } },
    });
    expect(result.structuredContent, JSON.stringify(result)).toMatchObject({ stored: true });
    expect(storedValue()).toBe(key);
  },
  30_000,
);

it.each(SHAPES)(
  "stores a %s key from a targeted element",
  async (_n, key) => {
    await showKey(key, key);
    storeCredential.mockClear();
    const result = await call("operate_extract", {
      capture: { store: { service: "Shape fixture" }, source: { selector: "#key" } },
    });
    expect(result.structuredContent, JSON.stringify(result)).toMatchObject({ stored: true });
    expect(storedValue()).toBe(key);
  },
  30_000,
);

it.each(SHAPES)(
  "stores a %s key with operate_extract after the agent clicked Copy",
  async (_n, key) => {
    await showKey(key, "••••");
    // The agent's click leaves the key on the clipboard, so extraction's own
    // Copy click writes the same value again.
    await call("operate_click", { ref: "@copy" });
    storeCredential.mockClear();
    const result = await call("operate_extract", { store: { service: "Shape fixture" } });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(storeCredential).toHaveBeenCalledTimes(1);
    expect(storedValue()).toBe(key);
  },
  30_000,
);

it("stores nothing for a plain-text key with no target and no Copy click", async () => {
  // Assembled at runtime so secret scanning does not flag fixture data.
  const key = "sk" + "_live_fixturekey0123456789abcdef";
  const html = `<!doctype html><main><h1>API keys</h1>
    <p>Your key: <code>${key}</code></p><label>API key <input readonly value="${key}"></label></main>`;
  await page.unrouteAll();
  await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto("http://127.0.0.1/");
  storeCredential.mockClear();
  const result = await call("operate_extract", { store: { service: "Shape fixture" } });
  expect(storeCredential).not.toHaveBeenCalled();
  const content = result.structuredContent as Record<string, unknown>;
  expect(content.credentials).toEqual({});
  expect(content.error).toContain("operate_observe");
  expect(content.error).toContain("capture");
  // No candidate list, masked or not, and no part of the key.
  expect(Object.keys(content).sort()).toEqual(["credentials", "error", "session_id", "url"]);
  expect(JSON.stringify(result)).not.toContain(key.slice(8, 24));
}, 30_000);
