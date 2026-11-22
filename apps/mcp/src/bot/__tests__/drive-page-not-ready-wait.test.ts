import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { chromium, type Browser } from "playwright";
import type { ApiClient } from "../../api-client.js";
import { BrowserController } from "../browser.js";
import { DRIVE_WAIT_MS, runOperateDrive, type DriveDependencies } from "../operate-drive.js";
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

// Trace case: after the Google account choice the GSI popup posted its form to
// accounts.google.com/gsi/transform and closed. Every read of the closed page
// reported "navigating" at once, and the drive re-read it 68,926 times at one
// step without sleeping.
it("waits between reads of a page that stays navigating and ends by the step budget", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const root = "https://accounts.google.com/gsi/transform";
  await page.route("**/*", (route) =>
    route.fulfill({ contentType: "text/html", body: "<main><button>Continue</button></main>" }),
  );
  await page.goto(root);
  const started = await startHarnessProvisionSession({
    browser: BrowserController.fromHarnessPage(page),
    serviceUrl: root,
    format: "compact",
    initialObservation: "drive",
  });
  await page.close();
  let snapshots = 0;
  const askJev = vi.fn();
  const dependencies: DriveDependencies = {
    askJev,
    act,
    observe,
    startSession: async () => {
      throw new Error("existing session");
    },
    awaitVerification,
    injectCard: async () => ({ status: "unused" }),
    onSnapshot: async () => {
      snapshots += 1;
    },
  };
  try {
    const startedAt = Date.now();
    const result = await runOperateDrive(
      { session_id: started.session_id, goal: "create an API key", max_steps: 3, max_seconds: 30 },
      { useCredential: vi.fn() } as unknown as ApiClient,
      undefined,
      dependencies,
    );
    expect(result.status).toBe("budget");
    expect(result.steps).toBe(3);
    expect(askJev).not.toHaveBeenCalled();
    // The first read plus one re-read per spent step.
    expect(snapshots).toBe(4);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(3 * DRIVE_WAIT_MS - 100);
  } finally {
    await finishProvisionSession(started.session_id);
    await context.close();
  }
}, 30_000);
