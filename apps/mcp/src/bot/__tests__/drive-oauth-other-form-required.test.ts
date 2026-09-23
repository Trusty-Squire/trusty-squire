import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import type { ApiClient } from "../../api-client.js";
import { BrowserController } from "../browser.js";
import { OAUTH_PROVIDERS } from "../oauth-providers.js";
import { peakedProbabilities, runOperateDrive, type DriveDependencies } from "../operate-drive.js";
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
  it.each(["separate form", "outside a form"])(
    "dispatches an identity control %s while the email form is empty",
    async (placement) => {
      const provider = Object.keys(OAUTH_PROVIDERS)[0]!;
      const label = `Sign up with ${provider}`;
      const control = `<button type="button">${label}</button>`;
      const identityControl = placement === "separate form" ? `<form>${control}</form>` : control;
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(
        `data:text/html,${encodeURIComponent(
          `<form><label>Email address <input type="email" required></label><button>Continue</button></form>${identityControl}`,
        )}`,
      );
      const started = await startHarnessProvisionSession({
        browser: BrowserController.fromHarnessPage(page),
        serviceUrl: page.url(),
        format: "compact",
        initialObservation: "drive",
      });
      let dispatches = 0;
      try {
        const deps: DriveDependencies = {
          askJev: async (_api, _state, questions) => {
            const operation = questions.operation;
            const click = questions.CLICK_target;
            if (operation?.type !== "choice" || click?.type !== "choice") {
              throw new Error("OAuth action was not offered");
            }
            const target = Object.entries(click.criteria).find(([, description]) =>
              description.includes(label),
            )?.[0];
            if (target === undefined) throw new Error("OAuth target was not offered");
            return {
              attempts: 1,
              elapsedMs: 1,
              result: {
                answers: {
                  operation: {
                    choice: "CLICK",
                    confidence: 0.95,
                    probabilities: peakedProbabilities(Object.keys(operation.criteria), "CLICK"),
                  },
                  CLICK_target: {
                    choice: target,
                    confidence: 0.95,
                    probabilities: peakedProbabilities(Object.keys(click.criteria), target),
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
          driveAct: async () => {
            dispatches += 1;
            return { kind: "ok", combobox: false };
          },
        };
        await runOperateDrive(
          { session_id: started.session_id, goal: label, max_steps: 1 },
          {} as ApiClient,
          undefined,
          deps,
        );
        expect(dispatches).toBe(1);
      } finally {
        await finishProvisionSession(started.session_id);
        await context.close();
      }
    },
    30_000,
  );
});
