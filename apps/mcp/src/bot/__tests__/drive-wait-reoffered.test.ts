import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { chromium, type Browser } from "playwright";
import type { ApiClient } from "../../api-client.js";
import { BrowserController } from "../browser.js";
import { runOperateDrive, type DriveDependencies } from "../operate-drive.js";
import {
  act,
  awaitVerification,
  finishProvisionSession,
  observe,
  startHarnessProvisionSession,
} from "../provision-session.js";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
});
afterAll(async () => {
  await browser?.close();
});

// Gauntlet drive-trace lines 39-41 (Pollinations /keys): the nav shell stayed
// nav-only after a model WAIT, so WAIT was marked dead and dropped from the
// next menu, and the drive stopped on NONE_OF_THESE before the key list loaded.
const NAV = [
  "Credits",
  "Quests",
  "My listings",
  "Keys",
  "Activity",
  "News & FAQ",
  "Models",
  "Agents",
  "MCP",
  "Sandboxes",
  "Docs",
];

it("offers WAIT again after a model WAIT left the page unchanged", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const root = "http://127.0.0.1/keys";
  await page.route("**/*", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<nav>${NAV.map((label) => `<a href="/${label.toLowerCase().replace(/\W+/g, "-")}">${label}</a>`).join("")}</nav><main></main>`,
    }),
  );
  await page.goto(root);
  const started = await startHarnessProvisionSession({
    browser: BrowserController.fromHarnessPage(page),
    serviceUrl: root,
    format: "compact",
    initialObservation: "drive",
  });
  const menus: string[][] = [];
  const dependencies: DriveDependencies = {
    askJev: async (_api, _state, questions) => {
      const operation = questions.operation;
      const keys = operation?.type === "choice" ? Object.keys(operation.criteria) : [];
      menus.push(keys);
      const choice = keys.includes("WAIT") ? "WAIT" : "NONE_OF_THESE";
      const answers = {
        operation: {
          choice,
          confidence: 0.95,
          probabilities: Object.fromEntries(
            keys.map((key) => [key, key === choice ? 0.96 : 0.04 / (keys.length - 1)]),
          ),
        },
      };
      return { attempts: 1, elapsedMs: 1, result: { answers } };
    },
    act,
    observe,
    startSession: async () => {
      throw new Error("existing session");
    },
    awaitVerification,
    injectCard: async () => ({ status: "unused" }),
  };
  try {
    const result = await runOperateDrive(
      {
        session_id: started.session_id,
        goal: "Get or reuse the existing Pollinations secret key",
        max_steps: 3,
        max_seconds: 30,
      },
      { useCredential: vi.fn() } as unknown as ApiClient,
      undefined,
      dependencies,
    );
    expect(menus.length).toBeGreaterThanOrEqual(2);
    for (const menu of menus) expect(menu).toContain("WAIT");
    expect(result.trajectory.filter((step) => step.action === "wait").length).toBe(menus.length);
  } finally {
    await finishProvisionSession(started.session_id);
    await context.close();
  }
}, 45_000);
