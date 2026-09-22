// Real Chromium proof of the hard requirement behind the frozen Contract B
// wire: two SEPARATE agent clients, each with its own broker connection, drive
// their own operator session against ONE shared browser process — concurrently,
// over the real socket, through the real operator tools.
//
// broker-wire-protocol.test.ts pins the wire's contract with a session double;
// this file swaps the double for a real browser so the sharing claim is proven
// against real pages rather than a stub target id.

import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z, buildToolRegistry, type Tool } from "../../tools/index.js";
import type { ApiClient } from "../../api-client.js";
import type { SessionGuard } from "../../session-guard.js";
import { BrowserController } from "../browser.js";
import { startHarnessProvisionSession, closeAllProvisionSessions } from "../provision-session.js";
import { OperatorBroker } from "../broker/operator.js";
import { OperatorForwarder } from "../broker/forwarder.js";
import { listenBroker } from "../broker/transport.js";

let chromiumAvailable = false;
try {
  chromiumAvailable = existsSync(chromium.executablePath());
} catch {
  chromiumAvailable = false;
}
const describeChromium = chromiumAvailable ? describe : describe.skip;

// Each agent's forwarder names the enrolled account on its calls; the broker
// builds a client for it. The harness tools below never touch the API, so a
// stub client is enough.
const account = {
  account_id: "account",
  agent_session_token: "token",
  api_base_url: "http://unused.test",
};
const apiStub = { setRequestingAgent: () => undefined } as unknown as ApiClient;
const guard = { bind: async () => account } as unknown as SessionGuard;

describeChromium("two agents sharing one real browser over the Contract B wire", () => {
  let browser: Browser;
  let root: BrowserController;
  const attached: BrowserController[] = [];

  beforeEach(async () => {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    await context.route("**/*", async (route) => {
      const host = new URL(route.request().url()).host;
      await route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><title>${host}</title><body><h1>${host} workspace</h1><button>go ${host}</button></body>`,
      });
    });
    root = BrowserController.fromHarnessPage(await context.newPage());
  });

  afterEach(async () => {
    await closeAllProvisionSessions().catch(() => undefined);
    attached.splice(0);
    await browser?.close();
  });

  function sharedStartTool(): Tool {
    return {
      name: "operate_start",
      description: "",
      inputSchema: z.object({ service_url: z.string() }).passthrough(),
      handler: async (args: Record<string, unknown>) => {
        // Each agent's session gets its OWN page in the one shared browser —
        // the same attachment the broker performs for a live session.
        const controller = await BrowserController.attachSessionPage(root, { humanize: false });
        attached.push(controller);
        return await startHarnessProvisionSession({
          serviceUrl: String(args.service_url),
          browser: controller,
          format: "compact",
        });
      },
    } as unknown as Tool;
  }

  async function harness() {
    const dir = await mkdtemp(join(tmpdir(), "ts-broker-shared-"));
    const socket = join(dir, "b.sock");
    const broker = new OperatorBroker({
      registryBaseUrl: "http://unused.test",
      apiFactory: () => apiStub,
    });
    const tools = [
      sharedStartTool(),
      ...buildToolRegistry().filter((tool) => tool.name !== "operate_start"),
    ];
    Object.defineProperty(broker, "tools", { value: tools });
    const listener = await listenBroker(socket, {
      call: async (principal, method, params, requestId) =>
        method === "open" || method === "command"
          ? await broker.withRegisteredRequest(
              principal,
              requestId,
              async (signal) => await broker.call(principal, method, params, requestId, signal),
            )
          : await broker.call(principal, method, params, requestId),
      abort: (principal, requestId) => broker.cancel(principal, requestId),
      disconnect: async (principal, explicit) => await broker.disconnect(principal, explicit),
    });
    const alice = new OperatorForwarder(socket, guard);
    const bob = new OperatorForwarder(socket, guard);
    return {
      broker,
      alice,
      bob,
      close: async () => {
        await alice.close();
        await bob.close();
        await listener.close();
        await rm(dir, { recursive: true, force: true });
      },
    };
  }

  it("gives each agent its own live page and observation in the one shared browser", async () => {
    const run = await harness();
    try {
      const [startedAlice, startedBob] = (await Promise.all([
        run.alice.invoke("operate_start", { service_url: "https://agent-a.test/" }, "alice-start"),
        run.bob.invoke("operate_start", { service_url: "https://agent-b.test/" }, "bob-start"),
      ])) as [{ session_id: string }, { session_id: string }];

      expect(startedAlice.session_id).not.toBe(startedBob.session_id);
      expect(run.broker.authority.inventory().sessions).toBe(2);

      // One browser process, one context, both agents' pages live inside it.
      const contexts = browser.contexts();
      expect(contexts).toHaveLength(1);
      const shared = contexts[0];
      if (shared === undefined) throw new Error("no shared context");
      const pages = shared.pages();
      const pageOf = (controller: BrowserController) =>
        (controller as unknown as { page: Page }).page;
      expect(attached).toHaveLength(2);
      const [firstPage, secondPage] = attached.map(pageOf);
      if (firstPage === undefined || secondPage === undefined) throw new Error("no session pages");
      expect(firstPage).not.toBe(secondPage);
      expect(pages).toContain(firstPage);
      expect(pages).toContain(secondPage);
      expect(firstPage.context().browser()).toBe(secondPage.context().browser());

      // Concurrent observations: each agent reads its OWN page's real DOM.
      const [seenByAlice, seenByBob] = (await Promise.all([
        run.alice.invoke(
          "operate_observe",
          { session_id: startedAlice.session_id },
          "alice-observe",
        ),
        run.bob.invoke("operate_observe", { session_id: startedBob.session_id }, "bob-observe"),
      ])) as [{ session_id: string; url: string }, { session_id: string; url: string }];

      expect(seenByAlice.session_id).toBe(startedAlice.session_id);
      expect(seenByBob.session_id).toBe(startedBob.session_id);
      expect(seenByAlice.url).toContain("agent-a.test");
      expect(seenByBob.url).toContain("agent-b.test");
      expect(JSON.stringify(seenByAlice)).toContain("agent-a.test workspace");
      expect(JSON.stringify(seenByAlice)).not.toContain("agent-b.test workspace");
      expect(JSON.stringify(seenByBob)).toContain("agent-b.test workspace");

      // One agent navigating its own page leaves the other agent's page alone.
      await run.alice.invoke(
        "operate_navigate",
        { session_id: startedAlice.session_id, url: "https://agent-a.test/settings" },
        "alice-navigate",
      );
      const [aliceAfter, bobAfter] = (await Promise.all([
        run.alice.invoke("operate_observe", { session_id: startedAlice.session_id }, "alice-again"),
        run.bob.invoke("operate_observe", { session_id: startedBob.session_id }, "bob-again"),
      ])) as [{ url: string }, { url: string }];
      expect(aliceAfter.url).toContain("/settings");
      expect(bobAfter.url).toBe(seenByBob.url);
      expect(shared.pages()).toHaveLength(pages.length);
    } finally {
      await run.close();
    }
  }, 60_000);
});
