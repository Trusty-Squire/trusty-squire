import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dispatchDriveAct } from "../act/act.js";
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
  `<h1>Sign in to BeatAPI</h1><a href="#home">BeatAPI home</a><button id="google" type="button" onclick="document.querySelector('#selected').textContent='Google clicked'">Continue with Google</button><button type="button" onclick="document.querySelector('#selected').textContent='GitHub clicked'">Continue with GitHub</button><a href="#signup">Sign Up</a><p id="selected" role="status">No account selected</p>`,
);
const chooser = page(
  `<h1>Choose an account</h1><button type="button">BeatAPI</button><a href="#a" onclick="document.querySelector('#selected').textContent='Signed in as Methoxine (methoxine@example.test)'">Methoxine methoxine@example.test</a><a href="#b">Bento Maker bento@example.test</a><a href="#c">Use another account</a><p id="selected" role="status">No account selected</p>`,
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
  it.each(["next-page", "same-page-remount"] as const)(
    "preserves page-bound refusal memory: %s",
    async (scenario) => {
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
      const menus: string[][] = [];
      const outcomes: unknown[] = [];
      let attemptedRefusal = false;
      try {
        const deps: DriveDependencies = {
          askJev: async (_api, _state, questions) => {
            const target = questions.CLICK_target;
            menus.push(target?.type === "choice" ? Object.values(target.criteria) : []);
            const wanted = !attemptedRefusal
              ? "Continue with Google"
              : scenario === "next-page" ? "Methoxine" : "Help";
            return vote(questions, wanted);
          },
          act,
          observe,
          startSession: async () => {
            throw new Error("fixture uses an existing session");
          },
          awaitVerification,
          injectCard: async () => ({ status: "unused" }),
          driveAct: async (sessionId, action, deadline) => {
            const target = "target" in action ? String(action.target) : action.kind;
            // Force an actual node-identity race after the drive's pre-act check.
            // The replacement looks identical but is not the registered node.
            const first = !attemptedRefusal;
            if (first) {
              attemptedRefusal = true;
              await tab.locator("#google").evaluate((node) => node.replaceWith(node.cloneNode(true)));
            }
            const outcome = await dispatchDriveAct(sessionId, action, deadline);
            outcomes.push({ target, outcome });
            if (first) {
              expect(outcome.kind).toBe("stale");
              refused.push(target);
            } else {
              expect(outcome.kind).toBe("ok");
              dispatched.push(target);
            }
            return outcome;
          },
        };
        const drive = async () =>
          await runOperateDrive(
            { session_id: started.session_id, goal: "sign in to BeatAPI", max_steps: 1 },
            {} as ApiClient,
            undefined,
            deps,
          );
        const firstResult = await drive();
        expect(refused).toHaveLength(1);
        expect(await tab.locator("#selected").textContent()).toBe("No account selected");
        if (scenario === "next-page") await tab.goto(chooser);
        else {
          // Remount once more and add an unrelated control on the SAME URL.
          await tab.locator("#google").evaluate((node) => node.replaceWith(node.cloneNode(true)));
          await tab.locator("h1").evaluate((node) => {
            const sibling = document.createElement("button");
            sibling.textContent = "Help";
            sibling.onclick = () => {
              document.querySelector("#selected")!.textContent = "Help clicked";
            };
            node.after(sibling);
          });
        }
        const secondResult = await drive();
        const nextTargets = menus[1]!;
        if (scenario === "next-page") {
          for (const tile of tiles) {
            expect(nextTargets.some((text) => text.includes(tile))).toBe(true);
          }
          // The refused sign-in ref is now the Methoxine tile, and its real
          // click handler must execute, not just get selected by the decider.
          expect(dispatched).toEqual(refused);
          expect(await tab.locator("#selected").textContent()).toBe(
            "Signed in as Methoxine (methoxine@example.test)",
          );
        } else {
          expect(nextTargets.some((text) => text.includes("Continue with Google"))).toBe(false);
          expect(nextTargets.some((text) => text.includes("Help"))).toBe(true);
          expect(nextTargets.some((text) => text.includes("BeatAPI home"))).toBe(true);
          expect(await tab.locator("#selected").textContent()).toBe("Help clicked");
        }
        const evidenceDir = process.env.SQUIRE_DRIVE_EVIDENCE_DIR;
        if (evidenceDir) {
          await tab.screenshot({ path: join(evidenceDir, `${scenario}.png`), fullPage: true });
          await writeFile(
            join(evidenceDir, `${scenario}.json`),
            JSON.stringify({
              scenario, menus, outcomes, firstResult, secondResult,
              selected: await tab.locator("#selected").textContent(),
            }, null, 2),
          );
        }
      } finally {
        await finishProvisionSession(started.session_id);
        await context.close();
      }
    },
    30_000,
  );
});
