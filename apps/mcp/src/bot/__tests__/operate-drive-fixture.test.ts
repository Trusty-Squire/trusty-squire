// Real-browser fixture for operate_drive: a multi-step signup completes in one
// call; a missing fact returns needs_value naming the field; a no-op action
// returns no_progress; resume with the value completes. Jev is mocked so the
// loop's wiring is under test; the credential-gated matrix replay covers live
// Jev confidence.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
import { act, observe, awaitVerification } from "../provision-session.js";
import { captureFrameSnapshot, driveRowsFromSnapshot } from "../drive-snapshot.js";
import { driveActOnPage, settleDriveStep } from "../drive-act.js";

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

async function openFixture(html: string, host: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const url = `https://${host}/`;
  await page.route("**/*", (route) =>
    route.fulfill({ contentType: "text/html", body: html }),
  );
  await page.goto(url);
  const started = await startHarnessProvisionSession({
    browser: BrowserController.fromHarnessPage(page),
    serviceUrl: url,
    format: "compact",
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
      const typed = await driveActOnPage(page, { kind: "type", target: email.ref, text: "ada@fixture.test" });
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

  it("returns a snapshot on a lazily-growing DOM instead of walking forever", async () => {
    const { context, page, started } = await openFixture(GROWING_HTML, "growing.test");
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
