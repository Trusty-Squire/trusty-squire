import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import type { ApiClient } from "../../api-client.js";
import { BrowserController } from "../browser.js";
import { OAUTH_PROVIDERS } from "../oauth-providers.js";
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

describe("drive OAuth trace", () => {
  it("records dispatch and handoff when identity admission returns before a click", async () => {
    const provider = Object.keys(OAUTH_PROVIDERS)[0]!;
    const context = await browser.newContext();
    const page = await context.newPage();
    const label = `Sign up with ${provider}`;
    await page.goto(`data:text/html,${encodeURIComponent(`<button>${label}</button>`)}`);
    const started = await startHarnessProvisionSession({
      browser: BrowserController.fromHarnessPage(page),
      serviceUrl: page.url(),
      format: "compact",
      initialObservation: "drive",
    });
    const tracePath = join(process.cwd(), `.drive-oauth-trace-${randomUUID()}.jsonl`);
    const priorTracePath = process.env.DRIVE_TRACE_PATH;
    writeFileSync(tracePath, "");
    process.env.DRIVE_TRACE_PATH = tracePath;
    try {
      const deps: DriveDependencies = {
        askJev: async () => {
          throw new Error("the named provider should be chosen without the model");
        },
        act,
        observe,
        startSession: async () => {
          throw new Error("fixture uses an existing session");
        },
        awaitVerification,
        injectCard: async () => ({ status: "unused" }),
        driveAct: async () => ({
          kind: "ok",
          combobox: false,
          needsUser: {
            wall: "google_session",
            message: "Identity session is required",
            resume: "connect",
          },
        }),
      };
      const result = await runOperateDrive(
        { session_id: started.session_id, goal: `Sign up with ${provider}`, max_steps: 2 },
        {} as ApiClient,
        undefined,
        deps,
      );
      expect(result.status).toBe("needs_value");
      const records = readFileSync(tracePath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { at: string });
      expect(records.map((record) => record.at)).toContain("oauth_dispatch");
      expect(records.map((record) => record.at)).toContain("oauth_handoff");
    } finally {
      if (priorTracePath === undefined) delete process.env.DRIVE_TRACE_PATH;
      else process.env.DRIVE_TRACE_PATH = priorTracePath;
      unlinkSync(tracePath);
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it("follows a new identity tab when the dispatched action leaves the opener active", async () => {
    const provider = Object.keys(OAUTH_PROVIDERS)[0]!;
    const context = await browser.newContext();
    const page = await context.newPage();
    const label = `Sign up with ${provider}`;
    const origin = "http://127.0.0.1";
    await context.route(`${origin}/**`, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: route.request().url().endsWith("/handoff")
          ? "<main>Identity handoff</main>"
          : `<button onclick="window.open('/handoff', '_blank')">${label}</button>`,
      }),
    );
    await page.goto(`${origin}/signup`);
    const started = await startHarnessProvisionSession({
      browser: BrowserController.fromHarnessPage(page),
      serviceUrl: page.url(),
      format: "compact",
      initialObservation: "drive",
    });
    try {
      const deps: DriveDependencies = {
        askJev: async () => {
          throw new Error("the named provider should be chosen without the model");
        },
        act,
        observe,
        startSession: async () => {
          throw new Error("fixture uses an existing session");
        },
        awaitVerification,
        injectCard: async () => ({ status: "unused" }),
        driveAct: async () => {
          const opened = page.waitForEvent("popup");
          await page.getByRole("button", { name: label }).click();
          await (await opened).waitForLoadState("domcontentloaded");
          return { kind: "ok", combobox: false };
        },
      };
      const result = await runOperateDrive(
        { session_id: started.session_id, goal: `Sign up with ${provider}`, max_steps: 1 },
        {} as ApiClient,
        undefined,
        deps,
      );
      expect(result.observation?.dom).toContain("Identity handoff");
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);
});
