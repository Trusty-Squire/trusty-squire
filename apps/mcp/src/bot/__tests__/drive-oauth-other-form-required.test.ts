import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import type { ApiClient } from "../../api-client.js";
import { BrowserController } from "../browser.js";
import { OAUTH_PROVIDERS } from "../oauth-providers.js";
import {
  DRIVE_EMAIL_CODE_QUESTION,
  peakedProbabilities,
  runOperateDrive,
  type DriveDependencies,
} from "../operate-drive.js";
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

describe("drive OAuth dispatch beside a required email form", () => {
  it.each([
    ["separate form", false, "CLICK"],
    ["separate form", true, "CLICK"],
    ["separate form", true, "TYPE_TEXT"],
    ["outside a form", false, "CLICK"],
    ["outside a form", true, "CLICK"],
    ["outside a form", true, "TYPE_TEXT"],
  ] as const)(
    "honors a vote beside a control %s with supplied email %s and operation %s",
    async (placement, suppliedEmail, selectedOperation) => {
      const provider = Object.keys(OAUTH_PROVIDERS)[0]!;
      const label = `Sign up with ${provider}`;
      const control = `<button type="button">${label}</button>`;
      const identityControl = placement === "separate form" ? `<form>${control}</form>` : control;
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(
        `data:text/html,${encodeURIComponent(
          `<form><label>Email address <input type="email" required></label><label>Password <input type="password" required></label><button>Continue</button></form>${identityControl}`,
        )}`,
      );
      const started = await startHarnessProvisionSession({
        browser: BrowserController.fromHarnessPage(page),
        serviceUrl: page.url(),
        format: "compact",
        initialObservation: "drive",
      });
      const dispatches: Array<{ kind: string; text?: string }> = [];
      let votes = 0;
      try {
        const deps: DriveDependencies = {
          askJev: async (_api, _state, questions) => {
            votes += 1;
            const operation = questions.operation;
            const targetQuestion = questions[`${selectedOperation}_target`];
            const emailCode = questions[DRIVE_EMAIL_CODE_QUESTION];
            if (
              operation?.type !== "choice" ||
              targetQuestion?.type !== "choice" ||
              emailCode?.type !== "choice"
            ) {
              throw new Error("Vote questions were not offered");
            }
            const target = Object.entries(targetQuestion.criteria).find(([, description]) =>
              description.includes(selectedOperation === "CLICK" ? label : "Email address"),
            )?.[0];
            if (target === undefined) throw new Error("Selected target was not offered");
            return {
              attempts: 1,
              elapsedMs: 1,
              result: {
                answers: {
                  operation: {
                    choice: selectedOperation,
                    confidence: 0.95,
                    probabilities: peakedProbabilities(
                      Object.keys(operation.criteria),
                      selectedOperation,
                    ),
                  },
                  [DRIVE_EMAIL_CODE_QUESTION]: {
                    choice: "none",
                    confidence: 0.95,
                    probabilities: peakedProbabilities(Object.keys(emailCode.criteria), "none"),
                  },
                  [`${selectedOperation}_target`]: {
                    choice: target,
                    confidence: 0.95,
                    probabilities: peakedProbabilities(Object.keys(targetQuestion.criteria), target),
                  },
                },
              },
            };
          },
          act,
          observe,
          startSession: async () => {
            throw new Error("fixture uses an existing session");
          },
          awaitVerification,
          injectCard: async () => ({ status: "unused" }),
          driveAct: async (_sessionId, action) => {
            dispatches.push(action);
            return { kind: "ok", combobox: false };
          },
        };
        await runOperateDrive(
          {
            session_id: started.session_id,
            goal: label,
            facts: suppliedEmail ? { email: "new-user@example.test" } : {},
            max_steps: 1,
          },
          {} as ApiClient,
          undefined,
          deps,
        );
        expect(votes).toBe(1);
        expect(dispatches).toHaveLength(1);
        expect(dispatches[0]).toMatchObject(
          selectedOperation === "CLICK"
            ? { kind: "oauth_login" }
            : { kind: "type", text: "new-user@example.test" },
        );
        expect(await page.locator('input[type="email"]').inputValue()).toBe("");
        expect(await page.locator('input[type="password"]').inputValue()).toBe("");
      } finally {
        await finishProvisionSession(started.session_id);
        await context.close();
      }
    },
    30_000,
  );
});
