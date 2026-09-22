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

it("spends each step on a model decision when controls change after every snapshot", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const root = "http://127.0.0.1/";
  await page.route("**/*", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<main><button>Generate API key</button><input type="checkbox" aria-label="State"></main>',
    }),
  );
  await page.goto(root);
  const started = await startHarnessProvisionSession({
    browser: BrowserController.fromHarnessPage(page),
    serviceUrl: root,
    format: "compact",
    initialObservation: "drive",
  });
  let decisions = 0;
  const dependencies: DriveDependencies = {
    askJev: async (_api, _state, questions) => {
      decisions += 1;
      const criteria =
        questions.CLICK_target?.type === "choice" ? questions.CLICK_target.criteria : {};
      const choices: Record<string, string> = {
        operation: "CLICK",
        CLICK_target: Object.keys(criteria)[0]!,
      };
      const answers = Object.fromEntries(
        Object.entries(choices).map(([name, choice]) => {
          const question = questions[name];
          const keys = question?.type === "choice" ? Object.keys(question.criteria) : [];
          return [
            name,
            {
              choice,
              confidence: 0.95,
              probabilities: Object.fromEntries(
                keys.map((key) => [
                  key,
                  keys.length === 1 ? 1 : key === choice ? 0.95 : 0.05 / (keys.length - 1),
                ]),
              ),
            },
          ];
        }),
      );
      return { attempts: 1, elapsedMs: 1, result: { answers } };
    },
    act,
    observe,
    startSession: async () => {
      throw new Error("existing session");
    },
    awaitVerification,
    injectCard: async () => ({ status: "unused" }),
    onSnapshot: async () => {
      await page.locator('input[type="checkbox"]').evaluate((element) => {
        if (element instanceof HTMLInputElement) element.checked = !element.checked;
      });
    },
  };
  try {
    const result = await runOperateDrive(
      { session_id: started.session_id, goal: "create an API key", max_steps: 4, max_seconds: 20 },
      { useCredential: vi.fn() } as unknown as ApiClient,
      undefined,
      dependencies,
    );
    expect(result.status).toBe("budget");
    expect(result.trajectory).toHaveLength(0);
    expect(decisions).toBe(4);
    expect(result.steps).toBe(decisions);
  } finally {
    await finishProvisionSession(started.session_id);
    await context.close();
  }
}, 30_000);
