import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import type { ApiClient } from "../../api-client.js";
import { BrowserController } from "../browser.js";
import type { JevQuestion } from "../jev-client.js";
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

function page(html: string): string {
  return `data:text/html,${encodeURIComponent(html)}`;
}

// A recorded BeatAPI run (emails replaced): the sign-in page's "Continue with
// Google" was refused, and the next drive call on Google's chooser was never
// offered the account tile that took the same per-page ref.
const signIn = page(
  `<h1>Sign in to BeatAPI</h1><a href="#home">BeatAPI home</a><button type="button">Continue with Google</button><button type="button">Continue with GitHub</button><a href="#signup">Sign Up</a>`,
);
const chooser = page(
  `<h1>Choose an account</h1><button type="button">BeatAPI</button><a href="#a">Methoxine methoxine@example.test</a><a href="#b">Bento Maker bento@example.test</a><a href="#c">Use another account</a>`,
);
const tiles = ["BeatAPI", "Methoxine", "Bento Maker", "Use another account"];

function vote(questions: Record<string, JevQuestion>, label: string) {
  const operation = questions.operation;
  const target = questions.CLICK_target;
  const emailCode = questions[DRIVE_EMAIL_CODE_QUESTION];
  if (operation?.type !== "choice" || target?.type !== "choice") {
    throw new Error("Vote questions were not offered");
  }
  const slug = Object.entries(target.criteria).find(([, text]) => text.includes(label))?.[0];
  if (slug === undefined) throw new Error(`${label} was not offered`);
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
        ...(emailCode?.type === "choice"
          ? {
              [DRIVE_EMAIL_CODE_QUESTION]: {
                choice: "none",
                confidence: 0.95,
                probabilities: peakedProbabilities(Object.keys(emailCode.criteria), "none"),
              },
            }
          : {}),
        CLICK_target: {
          choice: slug,
          confidence: 0.95,
          probabilities: peakedProbabilities(Object.keys(target.criteria), slug),
        },
      },
    },
  };
}

describe("a refused act on one page", () => {
  it("does not hide the control that reuses its ref on the next page", async () => {
    const context = await browser.newContext();
    const tab = await context.newPage();
    await tab.goto(signIn);
    const started = await startHarnessProvisionSession({
      browser: BrowserController.fromHarnessPage(tab),
      serviceUrl: tab.url(),
      format: "compact",
      initialObservation: "drive",
    });
    const refused: string[] = [];
    const dispatched: string[] = [];
    let chooserTargets: string[] = [];
    try {
      const deps: DriveDependencies = {
        askJev: async (_api, _state, questions) => {
          if (tab.url() === signIn) return vote(questions, "Continue with Google");
          const target = questions.CLICK_target;
          chooserTargets = target?.type === "choice" ? Object.values(target.criteria) : [];
          return vote(questions, "Methoxine");
        },
        act,
        observe,
        startSession: async () => {
          throw new Error("fixture uses an existing session");
        },
        awaitVerification,
        injectCard: async () => ({ status: "unused" }),
        driveAct: async (_sessionId, action) => {
          const target = "target" in action ? String(action.target) : action.kind;
          if (tab.url() === signIn) {
            refused.push(target);
            return { kind: "stale", reason: "stale_ref" };
          }
          dispatched.push(target);
          return { kind: "ok", combobox: false };
        },
      };
      const drive = async () =>
        await runOperateDrive(
          { session_id: started.session_id, goal: "sign in to BeatAPI", max_steps: 1 },
          {} as ApiClient,
          undefined,
          deps,
        );
      await drive();
      expect(refused).toHaveLength(1);
      await tab.goto(chooser);
      await drive();
      for (const tile of tiles) {
        expect(chooserTargets.some((text) => text.includes(tile))).toBe(true);
      }
      // The refused sign-in ref is the one the chooser gave the Methoxine tile.
      expect(dispatched).toEqual(refused);
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);
});
