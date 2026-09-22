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

it("decides on a redirected page instead of spending steps on an undispatched click", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const root = "https://app.test";
  await page.route("**/*", (route) => {
    const path = new URL(route.request().url()).pathname;
    const body =
      path === "/after"
        ? '<main><button id="new">Generate API key</button><input id="changing" type="checkbox" aria-label="Loading state"></main>'
        : '<main><button id="old">API keys</button></main>';
    return route.fulfill({ contentType: "text/html", body });
  });
  await page.goto(root);
  const started = await startHarnessProvisionSession({
    browser: BrowserController.fromHarnessPage(page),
    serviceUrl: root,
    format: "compact",
    initialObservation: "drive",
  });
  let decisions = 0;
  const decidedUrls: string[] = [];
  const dependencies: DriveDependencies = {
    askJev: async (_api, _state, questions) => {
      decisions += 1;
      decidedUrls.push(page.url());
      if (decisions === 1) await page.goto(`${root}/after`);
      const clickCriteria =
        questions.CLICK_target?.type === "choice" ? questions.CLICK_target.criteria : {};
      const target =
        Object.entries(clickCriteria).find(([, label]) =>
          label.includes(decisions === 1 ? "API keys" : "Generate API key"),
        )?.[0] ?? Object.keys(clickCriteria)[0]!;
      const choices: Record<string, string> = { operation: "CLICK", CLICK_target: target };
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
      if (new URL(page.url()).pathname !== "/after") return;
      await page.locator("#changing").evaluate((element) => {
        if (element instanceof HTMLInputElement) element.checked = !element.checked;
      });
    },
  };
  try {
    const result = await runOperateDrive(
      { session_id: started.session_id, goal: "create an API key", max_steps: 8, max_seconds: 15 },
      { useCredential: vi.fn() } as unknown as ApiClient,
      undefined,
      dependencies,
    );
    expect(decisions).toBeGreaterThanOrEqual(2);
    expect(decidedUrls).toContain(`${root}/after`);
    expect(result.status).toBe("budget");
    expect(result.jev_calls).toBeGreaterThanOrEqual(2);
  } finally {
    await finishProvisionSession(started.session_id);
    await context.close();
  }
}, 30_000);
