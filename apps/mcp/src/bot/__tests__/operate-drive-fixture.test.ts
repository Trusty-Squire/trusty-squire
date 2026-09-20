// Real-browser fixture for operate_drive: a multi-step signup completes in one
// call; a missing fact returns needs_value naming the field; a no-op action
// returns no_progress; resume with the value completes. Jev is mocked so the
// loop's wiring is under test; the credential-gated matrix replay covers live
// Jev confidence.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import type { ApiClient } from "../../api-client.js";
import { BrowserController } from "../browser.js";
import { JevUnavailableError, type JevCallOutcome } from "../jev-client.js";
import {
  DRIVE_CONFIDENCE_THRESHOLD,
  runOperateDrive,
  type DriveDependencies,
} from "../operate-drive.js";
import { finishProvisionSession, startHarnessProvisionSession } from "../provision-session.js";
import {
  act,
  observe,
  awaitVerification,
  injectCardIntoSessionTargets,
} from "../provision-session.js";
import {
  captureFrameSnapshot,
  driveRowsFromSnapshot,
  snapshotToObservation,
} from "../drive-snapshot.js";
import { driveActOnPage, settleDriveStep } from "../drive-act.js";
import { sessionForCall } from "../session/lifecycle.js";
import { DriveEvaluateTimeout } from "../drive-evaluate.js";
import { attachOperatorRequestAbort, withOperatorRequestContext } from "../request-cancellation.js";

const SIGNUP_HTML = `<!doctype html><meta charset="utf-8"><title>Signup fixture</title>
<main>
  <h1>Create account</h1>
  <form id="f">
    <label>Email <input id="email" name="email" type="email"></label>
    <label>Company <input id="company" name="company" required></label>
    <button type="button" id="continue" onclick="
      const email = document.querySelector('#email').value;
      const company = document.querySelector('#company').value;
      if (!email || !company) return;
      document.querySelector('main').innerHTML = '<p id=done>Account created for '+email+' at '+company+'</p>';
    ">Continue</button>
  </form>
</main>`;

const NOOP_HTML = `<!doctype html><meta charset="utf-8"><title>Noop fixture</title>
<main><button id="noop">Do nothing</button><p id="status">idle</p></main>`;

const MULTI_STAGE_CHECKOUT_HTML = `<!doctype html><meta charset="utf-8"><title>Checkout fixture</title>
<main>
  <h1>Checkout</h1>
  <form id="f">
    <label>Email <input id="email" name="email" required></label>
    <label>First name <input id="first" name="first_name" required></label>
    <button type="button" id="continue" onclick="
      const email = document.querySelector('#email').value;
      const first = document.querySelector('#first').value;
      if (!email || !first) return;
      document.querySelector('main').innerHTML =
        '<label>Card number <input id=pan name=cardnumber></label><p id=stage>payment</p>';
    ">Continue</button>
  </form>
</main>`;

const GROWING_HTML = `<!doctype html><meta charset="utf-8"><title>Growing</title>
<main><a href="#keep">Keep</a><div id="sink"></div></main>
<script>
  const sink = document.getElementById("sink");
  setInterval(() => {
    for (let i = 0; i < 200; i += 1) {
      const node = document.createElement("span");
      node.textContent = "n" + i;
      sink.appendChild(node);
    }
  }, 0);
</script>`;

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
});
afterAll(async () => {
  await browser?.close();
});

function api(): ApiClient {
  return { useCredential: vi.fn() } as unknown as ApiClient;
}

function peaked(ids: string[], pick: string, peak = 0.91): Record<string, number> {
  const out: Record<string, number> = {};
  if (ids.length <= 1) {
    if (ids[0] !== undefined) out[ids[0]] = 1;
    return out;
  }
  const rest = (1 - peak) / (ids.length - 1);
  for (const id of ids) out[id] = id === pick ? peak : rest;
  return out;
}

function jevFromQuestions(
  questions: Record<string, { type?: string; criteria?: Record<string, string> }>,
  preferDone = false,
): JevCallOutcome {
  const answers: Record<
    string,
    { choice?: string; confidence?: number; probabilities?: Record<string, number> }
  > = {};
  const typeKeys = Object.keys(questions.TYPE_TEXT_target?.criteria ?? {});
  const selectKeys = Object.keys(questions.SELECT_target?.criteria ?? {});
  const clickKeys = Object.keys(questions.CLICK_target?.criteria ?? {});
  const pickOp = preferDone
    ? "DONE"
    : typeKeys.length > 0
      ? "TYPE_TEXT"
      : selectKeys.length > 0
        ? "SELECT"
        : clickKeys.length > 0
          ? "CLICK"
          : "DONE";
  for (const [name, question] of Object.entries(questions)) {
    if (question.criteria === undefined) continue;
    const keys = Object.keys(question.criteria);
    const pick =
      name === "operation"
        ? pickOp
        : name === "TYPE_TEXT_target"
          ? (typeKeys[0] ?? keys[0]!)
          : name === "SELECT_target"
            ? (selectKeys[0] ?? keys[0]!)
            : name === "CLICK_target"
              ? (clickKeys[0] ?? keys[0]!)
              : keys[0]!;
    answers[name] = {
      choice: pick,
      confidence: 0.93,
      probabilities: peaked(keys, pick),
    };
  }
  return { attempts: 1, elapsedMs: 12, result: { answers } };
}

function deps(ask: DriveDependencies["askJev"]): DriveDependencies {
  return {
    askJev: ask,
    act,
    observe,
    startSession: async () => {
      throw new Error("fixture uses an existing session");
    },
    awaitVerification,
    injectCard: async () => ({ status: "unused" }),
  };
}

async function openFixture(
  html: string,
  host: string,
  initialObservation: "standard" | "drive" = "standard",
) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const url = `https://${host}/`;
  await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto(url);
  const started = await startHarnessProvisionSession({
    browser: BrowserController.fromHarnessPage(page),
    serviceUrl: url,
    format: "compact",
    initialObservation,
  });
  return { context, page, started };
}

function refFor(started: { safe_table?: unknown }, label: string): string {
  const rows = started.safe_table;
  if (!Array.isArray(rows)) throw new Error("no safe_table");
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const facts = String(row[2] ?? "");
    if (facts.split("|")[0] === label || facts.includes(label)) return String(row[0]);
  }
  throw new Error(`missing ${label}`);
}

describe("operate_drive real-browser fixture", () => {
  it.skipIf(process.env.DRIVE_WHITEJADE_STARTUP_AB !== "1")(
    "measures Whitejade drive startup with the general bypass kept versus deleted",
    async () => {
      const samples: Array<{ variant: string; elapsedMs: number; startupCaptures: number }> = [];
      for (let run = 0; run < 3; run += 1) {
        for (const variant of run % 2 === 0 ? ["kept", "deleted"] : ["deleted", "kept"]) {
          const context = await browser.newContext();
          const page = await context.newPage();
          const controller = BrowserController.fromHarnessPage(page);
          const original = controller.extractBrowserUseObservation.bind(controller);
          let starting = false;
          let startupCaptures = 0;
          vi.spyOn(controller, "extractBrowserUseObservation").mockImplementation(
            async (source, settle) => {
              if (starting) startupCaptures += 1;
              return await original(source, starting && variant === "kept" ? false : settle);
            },
          );
          let sessionId: string | undefined;
          try {
            const dependencies = deps(async (_api, _state, questions) =>
              jevFromQuestions(questions, true),
            );
            dependencies.startSession = async (options) => {
              starting = true;
              try {
                const started = await startHarnessProvisionSession({
                  ...options,
                  browser: controller,
                });
                sessionId = started.session_id;
                return started;
              } finally {
                starting = false;
              }
            };
            const begin = performance.now();
            const result = await runOperateDrive(
              {
                url: "https://whitejade.xyz/products/the-recovery-creme?variant=53574851297391",
                goal: "inspect the product page",
              },
              api(),
              undefined,
              dependencies,
            );
            const elapsedMs = performance.now() - begin;
            expect(result.status).toBe("complete");
            expect(result.observation?.url).toContain("whitejade.xyz");
            expect(startupCaptures).toBe(0);
            samples.push({ variant, elapsedMs, startupCaptures });
          } finally {
            if (sessionId !== undefined) await finishProvisionSession(sessionId);
            await context.close();
          }
        }
      }
      const median = (variant: string) =>
        samples
          .filter((sample) => sample.variant === variant)
          .map((sample) => sample.elapsedMs)
          .sort((a, b) => a - b)[1];
      writeFileSync(
        "../../drive-startup-review-evidence.json",
        JSON.stringify(
          {
            measuredAt: new Date().toISOString(),
            scope:
              "Live Whitejade product startup and DONE, mocked Jev; not a full checkout timing",
            comparison:
              "Kept variant forces startup general captures to skip settling; deleted uses normal settling",
            landed: "deleted",
            reason: "Drive startup never calls general observation in either variant",
            samples,
            mediansMs: { kept: median("kept"), deleted: median("deleted") },
          },
          null,
          2,
        ) + "\n",
      );
    },
    180_000,
  );

  it("keeps the full general settle for ordinary startup", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.route("**/*", (route) =>
      route.fulfill({ contentType: "text/html", body: NOOP_HTML }),
    );
    const controller = BrowserController.fromHarnessPage(page);
    const capture = vi.spyOn(controller, "extractBrowserUseObservation");
    let sessionId: string | undefined;
    try {
      const started = await startHarnessProvisionSession({
        browser: controller,
        serviceUrl: "https://ordinary-start.test/",
        format: "compact",
      });
      sessionId = started.session_id;
      expect(capture).toHaveBeenCalledWith(undefined, true);
    } finally {
      if (sessionId !== undefined) await finishProvisionSession(sessionId);
      await context.close();
    }
  }, 30_000);

  it("starts URL-owned drives with deferred general perception and snapshots directly", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.route("**/*", (route) =>
      route.fulfill({ contentType: "text/html", body: SIGNUP_HTML }),
    );
    let started: Awaited<ReturnType<typeof startHarnessProvisionSession>> | undefined;
    try {
      const startSession = vi.fn(
        async (options: Parameters<DriveDependencies["startSession"]>[0]) => {
          started = await startHarnessProvisionSession({
            ...options,
            browser: BrowserController.fromHarnessPage(page),
          });
          expect(started).not.toHaveProperty("safe_table");
          expect(started).not.toHaveProperty("dom");
          expect(sessionForCall(started.session_id)?.initializing).toBe(false);
          return started;
        },
      );
      const observeSpy = vi.fn(async () => {
        throw new Error("drive startup should not call the general observation");
      });
      const dependencies = deps(async (_api, _state, questions) =>
        jevFromQuestions(questions, true),
      );
      dependencies.startSession = startSession;
      dependencies.observe = observeSpy;

      const handoff = await runOperateDrive(
        {
          url: "https://signup-direct-start.test/",
          goal: "inspect this signup",
          facts: { email: "ada@fixture.test", company: "Acme" },
        },
        api(),
        undefined,
        dependencies,
      );

      expect(handoff.status).toBe("complete");
      expect(startSession).toHaveBeenCalledWith(
        expect.objectContaining({ initialObservation: "drive", format: "compact" }),
      );
      expect(observeSpy).not.toHaveBeenCalled();
      expect(handoff.observation?.safe_table).toBeDefined();
      expect(JSON.stringify(handoff.observation?.safe_table)).toContain("Email");
      expect(JSON.stringify(handoff.observation?.safe_table)).toContain("Company");
    } finally {
      if (started !== undefined) await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it("advances a multi-stage purchase goal when later-stage card fields are not yet present", async () => {
    const { context, page, started } = await openFixture(
      MULTI_STAGE_CHECKOUT_HTML,
      "multi-stage-checkout.test",
    );
    try {
      const dependencies = deps(async (_api, _state, questions) => jevFromQuestions(questions));
      dependencies.injectCard = async () => ({
        status: "pending_approval",
        approval_url: "https://trustysquire.ai/pay/fixture",
      });
      const result = await runOperateDrive(
        {
          session_id: started.session_id,
          goal:
            "Buy one item: fill the contact details, pay with the saved card, and stop when the order is confirmed",
          facts: {
            email: "ada@fixture.test",
            first_name: "Ada",
            card_ref: "card-1",
            merchant: "fixture.test",
          },
          max_steps: 8,
        },
        api(),
        undefined,
        dependencies,
      );
      expect(result.status).not.toBe("stuck");
      expect(result.trajectory.some((step) => step.action === "type")).toBe(true);
      const emailStillPresent = (await page.locator("#email").count()) > 0;
      if (emailStillPresent) {
        expect(await page.locator("#email").inputValue()).toBe("ada@fixture.test");
      } else {
        expect(await page.locator("#stage").textContent()).toBe("payment");
      }
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it("checks DONE against a fresh snapshot even on an unchanged page", async () => {
    const { context, started } = await openFixture(NOOP_HTML, "done-unchanged.test");
    try {
      let snapshots = 0;
      const dependencies = deps(async (_api, _state, questions) =>
        jevFromQuestions(questions, true),
      );
      dependencies.snapshot = async (sessionId) => {
        snapshots += 1;
        return await observe(sessionId, "compact");
      };
      const result = await runOperateDrive(
        { session_id: started.session_id, goal: "confirm the page is open" },
        api(),
        undefined,
        dependencies,
      );
      expect(result.status).toBe("complete");
      expect(result.jev_calls).toBe(1);
      expect(snapshots).toBe(2);
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it("recaptures when the page changes while DONE is being decided", async () => {
    const { context, page, started } = await openFixture(NOOP_HTML, "done-changing.test");
    try {
      let snapshots = 0;
      let decisions = 0;
      const dependencies = deps(async (_api, _state, questions) => {
        decisions += 1;
        if (decisions === 1) {
          await page.evaluate(() => {
            document.querySelector("#status")!.textContent = "changed";
          });
        }
        return jevFromQuestions(questions, true);
      });
      dependencies.snapshot = async (sessionId) => {
        snapshots += 1;
        return await observe(sessionId, "compact");
      };
      const result = await runOperateDrive(
        { session_id: started.session_id, goal: "confirm the page is open" },
        api(),
        undefined,
        dependencies,
      );
      expect(result.status).toBe("complete");
      expect(result.jev_calls).toBe(1);
      expect(snapshots).toBe(2);
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it.each(["checked", "disabled", "url", "frame"])(
    "reconsiders DONE when %s changes during the decision",
    async (change) => {
      const html = `<main><label>Notifications <input id="setting" type="checkbox" checked></label>
        <iframe srcdoc='<label>Frame setting <input value=original></label>'></iframe></main>`;
      const { context, page, started } = await openFixture(html, "done-state.test");
      try {
        let decisions = 0;
        const result = await runOperateDrive(
          {
            session_id: started.session_id,
            goal: "inspect settings",
            ...(change === "frame" ? { facts: { card_ref: "fixture-card" } } : {}),
          },
          api(),
          undefined,
          deps(async (_api, _state, questions) => {
            decisions += 1;
            if (decisions === 1) {
              if (change === "frame") {
                await page.frames()[1]!.evaluate(() => {
                  document.querySelector<HTMLInputElement>("input")!.value = "updated";
                });
              } else {
                await page.evaluate((kind) => {
                  const setting = document.querySelector<HTMLInputElement>("#setting")!;
                  if (kind === "checked") setting.checked = false;
                  if (kind === "disabled") setting.disabled = true;
                  if (kind === "url") history.pushState({}, "", "/updated");
                }, change);
              }
            }
            return jevFromQuestions(questions, true);
          }),
        );
        expect(result.status).toBe("complete");
        expect(decisions).toBe(2);
      } finally {
        await finishProvisionSession(started.session_id);
        await context.close();
      }
    },
    30_000,
  );

  it("retries an identical snapshot when content moves after capture", async () => {
    const { context, page, started } = await openFixture(NOOP_HTML, "capture-race.test");
    try {
      let snapshots = 0;
      let decisions = 0;
      const dependencies = deps(async (_api, state, questions) => {
        decisions += 1;
        if (decisions === 2) expect(JSON.stringify(state)).toMatch(/ready.now/i);
        return jevFromQuestions(questions, decisions > 1);
      });
      dependencies.snapshot = async (sessionId) => {
        const snapshot = await captureFrameSnapshot(page, [], 0);
        if (snapshot === null) throw new Error("missing fixture snapshot");
        const captured = snapshotToObservation(
          snapshot,
          sessionId,
          driveRowsFromSnapshot(snapshot),
        );
        snapshots += 1;
        if (snapshots === 2) {
          await page.evaluate(() => {
            document.querySelector("button")!.textContent = "Ready now";
          });
        }
        return captured;
      };
      const result = await runOperateDrive(
        { session_id: started.session_id, goal: "click and inspect" },
        api(),
        undefined,
        dependencies,
      );
      expect(result.status).toBe("complete");
      expect(decisions).toBe(2);
      expect(snapshots).toBe(4);
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it("adopts a popup whose initial response takes 150ms", async () => {
    const html = `<main><a href="/destination" target="_blank">Open destination</a></main>`;
    const { context, started } = await openFixture(html, "delayed-popup.test");
    try {
      await context.route("**/destination", async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        await route.fulfill({ contentType: "text/html", body: "<main>Destination ready</main>" });
      });
      let decisions = 0;
      const result = await runOperateDrive(
        { session_id: started.session_id, goal: "open destination" },
        api(),
        undefined,
        deps(async (_api, _state, questions) => {
          decisions += 1;
          return jevFromQuestions(questions, decisions > 1);
        }),
      );
      expect(result.status).toBe("complete");
      expect(result.observation?.url).toBe("https://delayed-popup.test/destination");
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it("completes a multi-step signup in one call", async () => {
    const { context, page, started } = await openFixture(SIGNUP_HTML, "signup-complete.test");
    try {
      let round = 0;
      const handoff = await runOperateDrive(
        {
          session_id: started.session_id,
          goal: "create an account",
          facts: { email: "ada@fixture.test", company: "Acme" },
        },
        api(),
        undefined,
        deps(async (_api, _state, questions) => {
          round += 1;
          return jevFromQuestions(questions, round > 3);
        }),
      );
      expect(handoff.status).toBe("complete");
      expect(await page.locator("#done").textContent()).toContain("ada@fixture.test");
      expect(handoff.trajectory.length).toBeGreaterThanOrEqual(3);
      expect(handoff.observation?.session_id).toBe(started.session_id);
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 60_000);

  it("snapshots visible-text labels and all headings, then acts through the registry", async () => {
    const { context, page, started } = await openFixture(SIGNUP_HTML, "signup-snapshot.test");
    try {
      const snap = await captureFrameSnapshot(page, [], 0);
      expect(snap).not.toBeNull();
      if (snap === null) return;
      expect(snap.headings).toEqual(expect.arrayContaining(["Create account"]));
      expect(snap.elements.some((element) => element.label.includes("Email"))).toBe(true);
      expect(snap.elements.some((element) => element.label.includes("Continue"))).toBe(true);
      expect(JSON.stringify(snap.elements)).not.toContain("zurich-largest-city");
      const rows = driveRowsFromSnapshot(snap);
      expect(rows.some((row) => (row[2] ?? "").includes("Email"))).toBe(true);
      const email = snap.elements.find((element) => element.label.includes("Email"));
      expect(email).toBeDefined();
      if (email === undefined) return;
      const typed = await driveActOnPage(page, {
        kind: "type",
        target: email.ref,
        text: "ada@fixture.test",
      });
      expect(typed.kind).toBe("ok");
      await settleDriveStep(page, typed.kind === "ok" && typed.combobox);
      expect(await page.locator("#email").inputValue()).toBe("ada@fixture.test");
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it("returns needs_value naming a field with no matching fact, then resume completes", async () => {
    const { context, page, started } = await openFixture(SIGNUP_HTML, "signup-missing.test");
    try {
      const companyRef = refFor(started, "@company");
      const missing = await runOperateDrive(
        {
          session_id: started.session_id,
          goal: "create an account",
          facts: { email: "ada@fixture.test" },
        },
        api(),
        undefined,
        deps(async () => {
          throw new Error("jev should not run for a required field with no fact");
        }),
      );
      expect(missing.status).toBe("needs_value");
      expect(missing.field).toMatch(/company/i);
      let round = 0;
      const resumed = await runOperateDrive(
        {
          session_id: started.session_id,
          goal: "create an account",
          facts: { email: "ada@fixture.test", company: "Acme" },
          answer: companyRef,
        },
        api(),
        undefined,
        deps(async (_api, _state, questions) => {
          round += 1;
          return jevFromQuestions(questions, round > 2);
        }),
      );
      expect(resumed.status).toBe("complete");
      expect(await page.locator("#done").textContent()).toContain("Acme");
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 60_000);

  it("returns no_progress when the chosen action does not change the page", async () => {
    const { context, started } = await openFixture(NOOP_HTML, "signup-noop.test");
    try {
      const handoff = await runOperateDrive(
        {
          session_id: started.session_id,
          goal: "click the button that does nothing",
          max_steps: 5,
        },
        api(),
        undefined,
        deps(async (_api, _state, questions) => jevFromQuestions(questions)),
      );
      expect(handoff.status).toBe("no_progress");
      expect(handoff.trajectory.length).toBeGreaterThanOrEqual(1);
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 60_000);

  it("returns jev_unavailable when the client budget is exhausted", async () => {
    const { context, started } = await openFixture(NOOP_HTML, "signup-jev.test");
    try {
      const handoff = await runOperateDrive(
        {
          session_id: started.session_id,
          goal: "anything",
        },
        api(),
        undefined,
        deps(async () => {
          throw new JevUnavailableError("jev_unavailable: retried 503/503", [503, 503], 2, 400);
        }),
      );
      expect(handoff.status).toBe("jev_unavailable");
      expect(handoff.jev_retried).toContain("503");
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it("refuses a second in-flight drive as busy", async () => {
    const { context, started } = await openFixture(NOOP_HTML, "signup-busy.test");
    try {
      const { sessionForCall } = await import("../session/lifecycle.js");
      const session = sessionForCall(started.session_id);
      expect(session).toBeDefined();
      if (session === undefined) return;
      session.drive = {
        running: true,
        goal: "already running",
        facts: {},
        trajectory: [],
        history: [],
        filledRefs: [],
        lastQuestion: null,
        lastActionKey: null,
        lastFingerprint: null,
        jevCalls: 1,
        staleNonWait: 0,
        boundFingerprint: null,
        consumedActionKey: null,
        lastActProfile: null,
      };
      const handoff = await runOperateDrive(
        { session_id: started.session_id, goal: "another drive" },
        api(),
      );
      expect(handoff.status).toBe("busy");
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it.each(["offscreen", "occluded"] as const)(
    "yields a %s Country combobox to model recovery before retrying",
    async (placement) => {
      const html = `<!doctype html><title>Country picker</title>
<main style="${placement === "offscreen" ? "padding-top:1800px;padding-bottom:120px" : ""}">
  <div role="combobox" aria-label="Country" id="country" tabindex="0"
    style="width:200px;height:40px" onclick="document.querySelector('#options').hidden=false">Choose country</div>
  <div id="options" hidden><button onclick="
    document.querySelector('#country').textContent='Canada';
    document.querySelector('#options').hidden=true;
  ">Canada</button></div>
</main>
${
  placement === "occluded"
    ? `<div id="cover" style="position:absolute;top:0;left:0;width:220px;height:60px"></div>
<button style="margin-top:80px" onclick="document.querySelector('#cover').remove();this.remove()">Dismiss</button>`
    : ""
}`;
      const { context, page, started } = await openFixture(html, `country-${placement}.test`);
      const outcomes: string[] = [];
      let modelCalls = 0;
      try {
        const dependencies = deps(async (_api, _state, questions) => {
          modelCalls += 1;
          if (modelCalls > 2) return jevFromQuestions(questions, true);
          if (modelCalls === 1) {
            expect(outcomes).toEqual(["stale"]);
            expect(await page.locator("#options").isVisible()).toBe(false);
          } else {
            expect(outcomes).toEqual(["stale", "ok", "ok"]);
            expect(await page.locator("#options").isVisible()).toBe(true);
          }
          const operation = modelCalls === 1 && placement === "offscreen" ? "SCROLL" : "CLICK";
          const head = questions[`${operation}_target`];
          if (head?.type !== "choice") throw new Error(`missing ${operation} recovery`);
          const target =
            operation === "SCROLL"
              ? "bottom"
              : Object.keys(head.criteria).find(
                  (key) => head.criteria[key] === (modelCalls === 1 ? "Dismiss" : "Canada"),
                );
          if (target === undefined) throw new Error("missing recovery target");
          const result = jevFromQuestions(questions);
          for (const [name, pick] of [
            ["operation", operation],
            [`${operation}_target`, target],
          ] as const) {
            const question = questions[name];
            if (question?.type !== "choice") throw new Error(`missing ${name}`);
            result.result.answers[name] = {
              choice: pick,
              confidence: 0.93,
              probabilities: peaked(Object.keys(question.criteria), pick),
            };
          }
          return result;
        });
        dependencies.driveAct = async (_sessionId, action) => {
          const result = await driveActOnPage(page, action);
          outcomes.push(result.kind);
          if (outcomes.length === 1) {
            expect(result.kind).toBe("stale");
            await page.locator("#country").evaluate((element) => {
              element.setAttribute("aria-label", "Country choice");
            });
          }
          return result;
        };
        const handoff = await runOperateDrive(
          {
            session_id: started.session_id,
            goal: "Choose Canada as the country",
            facts: { country: "Canada" },
            max_steps: 8,
          },
          api(),
          undefined,
          dependencies,
        );
        expect(handoff.status).toBe("complete");
        expect(modelCalls).toBe(3);
        expect(outcomes).toEqual(["stale", "ok", "ok", "ok"]);
        expect(await page.locator("#country").textContent()).toBe("Canada");
        expect(handoff.trajectory[0]?.action).toBe(placement === "offscreen" ? "scroll" : "click");
      } finally {
        await finishProvisionSession(started.session_id);
        await context.close();
      }
    },
    30_000,
  );

  it.each(["button", "option"])(
    "yields Billing Country's Canada %s without marking Shipping Country filled",
    async (role) => {
      const { context, page, started } = await openFixture(
        `<!doctype html><title>Shipping and billing</title>
<div id="shipping" role="combobox" aria-label="Shipping Country" tabindex="0"
  onclick="window.shippingClicks=(window.shippingClicks||0)+1">United States</div>
<div id="billing" role="combobox" aria-label="Billing Country" aria-controls="billing-menu"
  aria-expanded="true" tabindex="0">United States</div>
<div id="billing-menu" role="listbox"><div role="${role}" tabindex="0" onclick="
  document.querySelector('#billing').textContent='Canada';
  document.querySelector('#billing-menu').hidden=true;
">Canada</div></div>`,
        `country-ownership-${role}.test`,
      );
      const ask = vi.fn<DriveDependencies["askJev"]>(async (_api, _state, questions) => {
        expect(await page.locator("#shipping").textContent()).toBe("United States");
        expect(await page.locator("#billing").textContent()).toBe("United States");
        expect(await page.evaluate("window.shippingClicks || 0")).toBe(0);
        expect(sessionForCall(started.session_id)?.drive?.filledRefs).toEqual([]);
        return jevFromQuestions(questions, true);
      });
      try {
        const handoff = await runOperateDrive(
          {
            session_id: started.session_id,
            goal: "Choose Canada for Shipping Country",
            facts: { country: "Canada" },
            max_steps: 1,
          },
          api(),
          undefined,
          deps(ask),
        );
        expect(ask).toHaveBeenCalledOnce();
        expect(handoff.trajectory).toEqual([]);
        expect(sessionForCall(started.session_id)?.drive?.filledRefs).toEqual([]);
      } finally {
        await finishProvisionSession(started.session_id);
        await context.close();
      }
    },
    30_000,
  );

  it("attempts an unchanged fact-backed combobox only once before asking the model", async () => {
    const { context, page, started } = await openFixture(
      `<!doctype html><title>Country picker</title>
<div role="combobox" aria-label="Country" tabindex="0" onclick="window.clicks=(window.clicks||0)+1">Choose country</div>`,
      "country-noop.test",
    );
    const ask = vi.fn<DriveDependencies["askJev"]>(async (_api, _state, questions) => {
      expect(await page.evaluate("window.clicks")).toBe(1);
      return jevFromQuestions(questions, true);
    });
    try {
      const handoff = await runOperateDrive(
        {
          session_id: started.session_id,
          goal: "Choose Canada as the country",
          facts: { country: "Canada" },
          max_steps: 5,
        },
        api(),
        undefined,
        deps(ask),
      );
      expect(ask).toHaveBeenCalledOnce();
      expect(handoff.status).toBe("complete");
      expect(await page.evaluate("window.clicks")).toBe(1);
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it("keeps offscreen fields and drops ordinary offscreen buttons", async () => {
    const html = `<!doctype html><meta charset="utf-8"><title>Picker viewport</title>
<main style="min-height:4000px">
  <label>Departure <input id="dep" aria-haspopup="dialog"></label>
  <label>Company <input id="company" style="position:absolute;top:5000px"></label>
  <button type="button" id="done">Done</button>
  <div id="days">${Array.from(
    { length: 40 },
    (_, i) =>
      `<button type="button" style="position:absolute;top:${3000 + i * 40}px">Day ${i + 1}</button>`,
  ).join("")}</div>
</main>`;
    const { context, page, started } = await openFixture(html, "picker-viewport.test");
    try {
      const snap = await captureFrameSnapshot(page, [], 0);
      expect(snap).not.toBeNull();
      if (snap === null) return;
      const labels = snap.elements.map((element) => element.label);
      expect(labels.some((label) => label.includes("Departure"))).toBe(true);
      expect(labels.some((label) => label.includes("Company"))).toBe(true);
      expect(labels).toContain("Done");
      expect(labels.filter((label) => /^Day \d+$/.test(label))).toEqual([]);
      const company = snap.elements.find((element) => element.label.includes("Company"));
      expect(company?.offscreen).toBe(true);
      expect(company?.role).toBe("textbox");
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it("types into the remounted overlay input a picker click focused", async () => {
    const html = `<!doctype html><meta charset="utf-8"><title>Origin picker</title>
<label>Where from? <input id="from" role="combobox" aria-haspopup="listbox" value="Philadelphia"></label>
<div id="overlay"></div>
<script>
  document.getElementById("from").addEventListener("click", () => {
    setTimeout(() => {
      const input = document.createElement("input");
      input.id = "else";
      input.setAttribute("role", "combobox");
      input.setAttribute("aria-label", "Where else?");
      input.value = "Philadelphia";
      const list = document.createElement("div");
      list.setAttribute("role", "listbox");
      const option = document.createElement("div");
      option.setAttribute("role", "option");
      option.textContent = "Philadelphia, Pennsylvania";
      list.appendChild(option);
      document.getElementById("overlay").replaceChildren(input, list);
      input.focus();
      input.select();
      input.addEventListener("input", () => {
        const typed = input.value;
        setTimeout(() => {
          option.textContent = typed.includes("Zurich")
            ? "Zurich Airport (ZRH)"
            : "Philadelphia, Pennsylvania";
        }, 80);
      });
    }, 80);
  });
</script>`;
    const { context, page, started } = await openFixture(html, "picker-overlay-type.test");
    try {
      const snap = await captureFrameSnapshot(page, [], 0);
      const from = snap?.elements.find((element) => element.label.includes("Where from?"));
      expect(from).toBeDefined();
      if (from === undefined) return;
      const typed = await driveActOnPage(page, {
        kind: "type",
        target: from.ref,
        text: "Zurich",
      });
      expect(typed.kind).toBe("ok");
      expect(await page.locator("#else").inputValue()).toBe("Zurich");
      expect(await page.locator('[role="option"]').textContent()).toBe("Zurich Airport (ZRH)");
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it("waits for date-grid cells after a click-open", async () => {
    const html = `<!doctype html><meta charset="utf-8"><title>Date picker</title>
<label>Departure <input id="dep" aria-haspopup="dialog" readonly></label>
<div id="cal"></div>
<script>
  document.getElementById("dep").addEventListener("click", () => {
    setTimeout(() => {
      const grid = document.createElement("div");
      grid.setAttribute("role", "grid");
      const cell = document.createElement("button");
      cell.setAttribute("role", "gridcell");
      cell.textContent = "Sunday, September 20, 2026";
      grid.appendChild(cell);
      document.getElementById("cal").appendChild(grid);
    }, 80);
  });
</script>`;
    const { context, page, started } = await openFixture(html, "date-settle.test");
    try {
      const snap = await captureFrameSnapshot(page, [], 0);
      const departure = snap?.elements.find((element) => element.label.includes("Departure"));
      expect(departure).toBeDefined();
      if (departure === undefined) return;
      const acted = await driveActOnPage(page, { kind: "click", target: departure.ref });
      expect(acted.kind).toBe("ok");
      if (acted.kind !== "ok") return;
      expect(acted.combobox).toBe(true);
      const waited = await settleDriveStep(page, acted.combobox);
      expect(waited).toBeGreaterThan(0);
      expect(await page.locator('[role="gridcell"]').count()).toBe(1);
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it("returns a snapshot on a lazily-growing DOM instead of walking forever", async () => {
    // Exercise drive capture without first walking the growing DOM through
    // general observation during fixture setup.
    const { context, page, started } = await openFixture(GROWING_HTML, "growing.test", "drive");
    try {
      await page.waitForTimeout(50);
      const startedAt = Date.now();
      const snapshot = await captureFrameSnapshot(page, [], 0);
      expect(Date.now() - startedAt).toBeLessThan(3_000);
      expect(snapshot).not.toBeNull();
      expect(snapshot?.timedOut).not.toBe(true);
      expect(snapshot?.elements.some((element) => element.label === "Keep")).toBe(true);
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);
});

describe("coverage-matrix constant", () => {
  it("stays in the measured gap between wrong and correct answers", () => {
    expect(DRIVE_CONFIDENCE_THRESHOLD).toBeGreaterThan(0.41);
    expect(DRIVE_CONFIDENCE_THRESHOLD).toBeLessThanOrEqual(0.65);
  });
});

describe("drive review regressions", () => {
  it("masks dropdown choices and traces while selecting their original labels", async () => {
    const { context, page, started } = await openFixture(
      '<label>Saved method<select id="method"><option>Choose</option><option value="visa">Visa 41111111****1111</option></select></label>',
      "masked-options.test",
    );
    const dir = mkdtempSync(join(process.cwd(), ".drive-trace-test-"));
    const tracePath = join(dir, "trace.jsonl");
    const previousTrace = process.env.DRIVE_TRACE_PATH;
    process.env.DRIVE_TRACE_PATH = tracePath;
    try {
      sessionForCall(started.session_id)!.browser.registerCardValueOutputMask({
        pan: "4111111111111111",
        cvv: "739",
      });
      let calls = 0;
      const result = await runOperateDrive(
        { session_id: started.session_id, goal: "choose saved method", max_steps: 1 },
        api(),
        undefined,
        deps(async (_api, state, questions) => {
          calls++;
          expect(JSON.stringify({ state, questions })).not.toContain("41111111");
          const question = questions.SELECT_target;
          if (question?.type !== "choice") throw new Error("missing SELECT choices");
          const pick = Object.keys(question.criteria).find((key) =>
            question.criteria[key]!.includes("[card number]"),
          )!;
          expect(pick).toBeDefined();
          const outcome = jevFromQuestions(questions);
          outcome.result.answers.SELECT_target = {
            choice: pick,
            confidence: 0.93,
            probabilities: peaked(Object.keys(question.criteria), pick),
          };
          return outcome;
        }),
      );
      expect(calls).toBe(1);
      expect(result.status).toBe("budget");
      expect(await page.locator("#method").inputValue()).toBe("visa");
      const trace = readFileSync(tracePath, "utf8");
      expect(trace).not.toContain("41111111");
      expect(trace).toContain("[card number]");
    } finally {
      if (previousTrace === undefined) delete process.env.DRIVE_TRACE_PATH;
      else process.env.DRIVE_TRACE_PATH = previousTrace;
      rmSync(dir, { recursive: true, force: true });
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it.each(["type", "select"])(
    "does not retain a completed %s ref after navigation",
    async (action) => {
      const html =
        action === "type"
          ? '<form action="/next"><label>Search <input id="field" type="search" name="q" oninput="location.href=\'/next\'"></label></form>'
          : '<label>Country <select id="field" onchange="location.href=\'/next\'"><option value="">Choose</option><option>Canada</option></select></label>';
      const { context, page, started } = await openFixture(html, "fill-navigation.test");
      try {
        await page.route("**/next*", (route) =>
          route.fulfill({
            contentType: "text/html",
            body: '<label>Email <input id="email" type="email" required></label>',
          }),
        );
        const dependencies = deps(async (_api, _state, questions) => jevFromQuestions(questions));
        const result = await runOperateDrive(
          {
            session_id: started.session_id,
            goal: "open form",
            facts: action === "type" ? { query: "hello" } : { country: "Canada" },
          },
          api(),
          undefined,
          dependencies,
        );
        expect(result.status).toBe("needs_value");
        expect(result.field).toBe("Email");
        expect(await page.locator("#email").inputValue()).toBe("");
        expect(sessionForCall(started.session_id)!.drive!.filledRefs).toEqual([]);
      } finally {
        await finishProvisionSession(started.session_id);
        await context.close();
      }
    },
    30_000,
  );

  it.each(["same-origin", "cross-origin", "same-url", "srcdoc"])(
    "keeps reused hosted-field selectors frame-scoped (%s)",
    async (frameKind) => {
      const context = await browser.newContext();
      const page = await context.newPage();
      let sessionId: string | undefined;
      try {
        const panUrl = "https://provider.test/pan";
        const cvvUrl =
          frameKind === "cross-origin"
            ? "https://cvv-provider.test/cvv"
            : "https://provider.test/cvv";
        await page.route(panUrl, (route) =>
          route.fulfill({
            contentType: "text/html",
            body: '<label>Card number <input id="field" autocomplete="cc-number"></label>',
          }),
        );
        await page.route(cvvUrl, (route) =>
          route.fulfill({
            contentType: "text/html",
            body: '<label>CVV <input id="field" autocomplete="cc-csc"></label>',
          }),
        );
        let frameMarkup = `<iframe id="pan" src="${panUrl}"></iframe><iframe id="cvv" src="${cvvUrl}"></iframe>`;
        if (frameKind === "same-url") {
          const shared = "https://provider.test/shared";
          await page.route(shared, (route) =>
            route.fulfill({
              contentType: "text/html",
              body: `<label><span id="label"></span><input id="field"></label><script>document.querySelector('#label').textContent = window.name === 'pan' ? 'Card number' : 'CVV';</script>`,
            }),
          );
          frameMarkup = `<iframe id="pan" name="pan" src="${shared}"></iframe><iframe id="cvv" name="cvv" src="${shared}"></iframe>`;
        } else if (frameKind === "srcdoc") {
          frameMarkup = `<iframe id="pan" srcdoc="<label>Card number <input id='field'></label>"></iframe><iframe id="cvv" srcdoc="<label>CVV <input id='field'></label>"></iframe>`;
        }
        const url = "https://hosted-checkout.test/checkout";
        await page.route(url, (route) =>
          route.fulfill({
            contentType: "text/html",
            body: `<input id="field" aria-label="Unrelated" value="unchanged">${frameMarkup}`,
          }),
        );
        await page.goto(url);
        const started = await startHarnessProvisionSession({
          browser: BrowserController.fromHarnessPage(page),
          serviceUrl: url,
          format: "compact",
        });
        sessionId = started.session_id;
        const card = {
          pan: "4111111111111111",
          cvv: "739",
          exp_month: "12",
          exp_year: "2030",
          name: "Ada",
          billing: { line1: "1 Main St", city: "Boston", postal_code: "02110", country: "US" },
        };
        const dependencies = deps(async () => {
          throw new Error("card fill should not call Jev");
        });
        let injections = 0;
        dependencies.injectCard = async (_session, args) => {
          injections += 1;
          expect(args.fields.pan?.ref).not.toBe(args.fields.cvv?.ref);
          const fields = await injectCardIntoSessionTargets(started.session_id, card, args.fields);
          expect(fields).toEqual({ pan: { status: "filled" }, cvv: { status: "filled" } });
          return { status: "card_injected", complete: true, fields };
        };
        const result = await runOperateDrive(
          {
            session_id: started.session_id,
            goal: "fill card",
            facts: { card_ref: "card" },
            max_steps: 1,
          },
          api(),
          undefined,
          dependencies,
        );
        expect(result.status).toBe("budget");
        expect(injections).toBe(1);
        expect(await page.frameLocator("#pan").locator("#field").inputValue()).toBe(card.pan);
        expect(await page.frameLocator("#cvv").locator("#field").inputValue()).toBe(card.cvv);
        expect(await page.locator("#field").inputValue()).toBe("unchanged");
      } finally {
        if (sessionId !== undefined) await finishProvisionSession(sessionId);
        await context.close();
      }
    },
    30_000,
  );

  it("aborts a stalled card-ref lookup and returns evaluate_timeout without injection", async () => {
    const { context, page, started } = await openFixture(
      '<label>Card number <input id="pan"></label>',
      "lookup-timeout.test",
    );
    const controller = new AbortController();
    attachOperatorRequestAbort(controller.signal, (reason) => controller.abort(reason));
    const session = sessionForCall(started.session_id)!;
    const extract = session.browser.extractInteractiveElements.bind(session.browser);
    const frame = page.mainFrame();
    let evaluation: { mockRestore(): void } | undefined;
    const extraction = vi
      .spyOn(session.browser, "extractInteractiveElements")
      .mockImplementation(async (...args) => {
        const fresh = await extract(...args);
        evaluation = vi
          .spyOn(frame, "evaluate")
          .mockImplementationOnce(() => new Promise(() => undefined));
        return fresh;
      });
    try {
      await page.goto("https://lookup-timeout.test/checkout");
      const dependencies = deps(async () => {
        throw new Error("unexpected Jev call");
      });
      const injection = vi.fn(async () => ({ status: "unused" }));
      dependencies.injectCard = injection;
      const result = await withOperatorRequestContext(controller.signal, () =>
        runOperateDrive(
          { session_id: started.session_id, goal: "fill card", facts: { card_ref: "card" } },
          api(),
          undefined,
          dependencies,
        ),
      );
      expect(result.status).toBe("evaluate_timeout");
      expect(controller.signal.aborted).toBe(true);
      expect(injection).not.toHaveBeenCalled();
    } finally {
      evaluation?.mockRestore();
      extraction.mockRestore();
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it("registers compact injection refs and retries after four incomplete fills", async () => {
    const { context, page, started } = await openFixture(
      '<label>Card number <input id="pan" autocomplete="cc-number"></label><label>CVV <input id="cvv" autocomplete="cc-csc"></label>',
      "checkout.test",
    );
    try {
      await page.goto("https://checkout.test/checkout");
      const session = sessionForCall(started.session_id)!;
      expect(session.compactV2Active).toBe(true);
      const card = {
        pan: "4111111111111111",
        cvv: "739",
        exp_month: "12",
        exp_year: "2030",
        name: "Ada",
        billing: { line1: "1 Main St", city: "Boston", postal_code: "02110", country: "US" },
      };
      let attempts = 0;
      const dependencies = deps(async (_api, _state, questions) =>
        jevFromQuestions(questions, true),
      );
      dependencies.injectCard = async (_session, args) => {
        attempts += 1;
        const fields = await injectCardIntoSessionTargets(started.session_id, card, args.fields);
        expect(fields).toEqual({ pan: { status: "filled" }, cvv: { status: "filled" } });
        session.releasedPaymentCard = {
          approvalId: "approved",
          approvalUrl: "https://approval.test",
          checkout: {
            merchant: "test",
            checkout_origin: "https://checkout.test",
            amount_cents: 100,
            currency: "USD",
          },
          cardRef: "card",
          last4: "1111",
          deadline: Date.now() + 60_000,
          card,
        };
        return { status: "card_injected", complete: attempts > 4, fields };
      };
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        const result = await runOperateDrive(
          { session_id: started.session_id, goal: "fill card", facts: { card_ref: "card" } },
          api(),
          undefined,
          dependencies,
        );
        expect(result.status).toBe(attempt <= 4 ? "card_incomplete" : "complete");
      }
      expect(attempts).toBe(5);
      expect(await page.locator("#pan").inputValue()).toBe(card.pan);
      expect(await page.locator("#cvv").inputValue()).toBe(card.cvv);
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 60_000);

  it.each([
    "4111111111111111",
    "4111+1111+1111+1111",
    "4111%201111%201111%201111",
    "4111%C2%B71111%C2%B71111%C2%B71111",
  ])(
    "masks GET query card values before Jev and handoff serialization: %s",
    async (encodedPan) => {
      const { context, page, started } = await openFixture(NOOP_HTML, "card-query.test");
      try {
        const pan = "4111111111111111";
        sessionForCall(started.session_id)!.browser.registerCardValueOutputMask({
          pan,
          cvv: "739",
        });
        await page.goto(`https://card-query.test/?pan=${encodedPan}`);
        const urls: string[] = [];
        const dependencies = deps(async (_api, state, questions) => {
          const serialized = JSON.stringify(state);
          expect(serialized).not.toContain(pan);
          expect(
            new URL((state as { page: { url: string } }).page.url).searchParams.get("pan"),
          ).toBe("[card number]");
          urls.push((state as { page: { url: string } }).page.url);
          return jevFromQuestions(questions, true);
        });
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const result = await runOperateDrive(
            { session_id: started.session_id, goal: "read page" },
            api(),
            undefined,
            dependencies,
          );
          expect(result.status).toBe("complete");
          expect(JSON.stringify(result)).not.toContain(pan);
          expect(new URL(result.observation!.url).searchParams.get("pan")).toBe("[card number]");
        }
        expect(urls).toHaveLength(2);
        expect(urls[0]).toBe(urls[1]);
      } finally {
        await finishProvisionSession(started.session_id);
        await context.close();
      }
    },
    30_000,
  );

  it.each(["detached", "timeout"])(
    "does not type when reselection is %s",
    async (failure) => {
      const { context, page, started } = await openFixture(
        '<label>Email <input id="email" value="original"></label><input id="other">',
        "reselect.test",
      );
      try {
        const snapshot = await captureFrameSnapshot(page, [], 0);
        const target = snapshot!.elements.find((element) => element.label.includes("Email"))!;
        const frame = page.mainFrame();
        const original = frame.evaluate.bind(frame);
        const spy =
          failure === "timeout"
            ? vi
                .spyOn(frame, "evaluate")
                .mockImplementationOnce(original)
                .mockRejectedValueOnce(new DriveEvaluateTimeout(1))
            : undefined;
        if (failure === "detached") {
          await page.locator("#email").evaluate((element) =>
            element.addEventListener("click", () => {
              element.remove();
              document.querySelector<HTMLInputElement>("#other")!.focus();
            }),
          );
        }
        try {
          const result = await driveActOnPage(page, {
            kind: "type",
            target: target.ref,
            text: "new value",
          });
          expect(result.kind).toBe("stale");
          expect(await page.locator("#other").inputValue()).toBe("");
          if (failure === "timeout")
            expect(await page.locator("#email").inputValue()).toBe("original");
        } finally {
          spy?.mockRestore();
        }
      } finally {
        await finishProvisionSession(started.session_id);
        await context.close();
      }
    },
    30_000,
  );
});
