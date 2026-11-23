import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { chromium, type Browser } from "playwright";
import type { ApiClient } from "../../api-client.js";
import { BrowserController } from "../browser.js";
import {
  DRIVE_EMAIL_CODE_QUESTION,
  DRIVE_INBOX_NO_MAIL_OUTCOME,
  emptyDriveState,
  inboxFoundNoMailHere,
  runOperateDrive,
  type DriveDependencies,
} from "../operate-drive.js";
import {
  act,
  finishProvisionSession,
  observe,
  startHarnessProvisionSession,
} from "../provision-session.js";
import { sessionForCall } from "../session/lifecycle.js";

// 1.1.48-rc.1 Token Harbor drive (trace L43-L50): the PIN never arrived, and
// the emailed-code question sent the drive back into the empty inbox each time
// even when the operation vote was CLICK.
const loginUrl = "https://tokenharbor.ai/login?next=%2Fdashboard";

describe("inboxFoundNoMailHere", () => {
  const miss = {
    step: 1,
    page: "https://tokenharbor.ai/login",
    action: "INBOX",
    outcome: DRIVE_INBOX_NO_MAIL_OUTCOME,
  };

  it("holds while the empty inbox read is the latest outcome on this page", () => {
    expect(inboxFoundNoMailHere([miss], loginUrl)).toBe(true);
  });

  it("is re-armed by a later action or on another page", () => {
    const resend = { ...miss, step: 2, action: "click Resend PIN", outcome: "page changed" };
    expect(inboxFoundNoMailHere([miss, resend], loginUrl)).toBe(false);
    expect(inboxFoundNoMailHere([miss], "https://tokenharbor.ai/signup")).toBe(false);
    expect(inboxFoundNoMailHere([], loginUrl)).toBe(false);
  });
});

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
});
afterAll(async () => {
  await browser?.close();
});

const api = { useCredential: vi.fn() } as unknown as ApiClient;
const goal = "Sign up for a brand-new free Token Harbor account with the one-time PIN.";
const pinPage = `<meta charset="utf-8"><main><h1>Sign in</h1>
  <button type="button">Sign in</button><button type="button">Sign up</button>
  <form>
    <label>Email <input type="email" required value="person@example.test"></label>
    <label>6-digit PIN <input inputmode="numeric" maxlength="6" placeholder="••••••"></label>
    <button type="button">Resend PIN</button>
  </form>
  <button type="button">Create an account</button></main>`;

type Questions = Parameters<DriveDependencies["askJev"]>[2];

function answering(pick: (name: string) => string | undefined): DriveDependencies["askJev"] {
  return async (_api, _state, questions: Questions) => ({
    attempts: 1,
    elapsedMs: 1,
    result: {
      answers: Object.fromEntries(
        Object.entries(questions).flatMap(([name, question]) => {
          if (question.type !== "choice") return [];
          const keys = Object.keys(question.criteria);
          const choice = pick(name) ?? keys[0]!;
          return [
            [
              name,
              {
                choice,
                confidence: 1,
                probabilities: Object.fromEntries(keys.map((key) => [key, key === choice ? 1 : 0])),
              },
            ],
          ];
        }),
      ),
    },
  });
}

it("reports an empty inbox to the next decision instead of re-reading it", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: pinPage }));
  await page.goto(loginUrl);
  const started = await startHarnessProvisionSession({
    browser: BrowserController.fromHarnessPage(page),
    serviceUrl: loginUrl,
    format: "compact",
    initialObservation: "drive",
  });
  const sessionId = started.session_id;
  sessionForCall(sessionId)!.drive = emptyDriveState(goal, { email: "person@example.test" });
  let offset = 0;
  const awaitVerification = vi.fn<DriveDependencies["awaitVerification"]>(async () => {
    // The poll window elapses with nothing found.
    offset += 60_000;
    return { session_id: sessionId, found: false, code: null, link: null, messages: [] };
  });
  const base = {
    act,
    observe,
    startSession: async () => {
      throw new Error("existing session");
    },
    awaitVerification,
    injectCard: async () => ({ status: "unused" }),
  } satisfies Omit<DriveDependencies, "askJev">;
  try {
    const first = await runOperateDrive(
      { session_id: sessionId, goal, max_steps: 3, max_seconds: 30 },
      api,
      undefined,
      {
        ...base,
        now: () => Date.now() + offset,
        askJev: answering((name) =>
          name === DRIVE_EMAIL_CODE_QUESTION ? "code_field_1" : undefined,
        ),
      },
    );
    expect(awaitVerification).toHaveBeenCalledTimes(1);
    expect(first.status).toBe("needs_value");

    const asked: { questions: Questions; trail: unknown }[] = [];
    const record = answering((name) => (name === "operation" ? "BLOCKED" : undefined));
    const second = await runOperateDrive(
      { session_id: sessionId, goal, max_steps: 3, max_seconds: 30 },
      api,
      undefined,
      {
        ...base,
        askJev: async (client, state, questions) => {
          asked.push({ questions, trail: (state as { trail?: unknown }).trail });
          return await record(client, state, questions);
        },
      },
    );
    expect(awaitVerification).toHaveBeenCalledTimes(1);
    expect(second.status).toBe("stuck");
    expect(asked[0]?.questions).not.toHaveProperty(DRIVE_EMAIL_CODE_QUESTION);
    expect(JSON.stringify(asked[0]?.trail)).toContain(DRIVE_INBOX_NO_MAIL_OUTCOME);
  } finally {
    await finishProvisionSession(sessionId);
    await context.close();
  }
}, 20_000);

// 1.1.55-rc.1 Kenari drive (run 37, trace L18): max_seconds 45 ran out while the
// inbox poll was still inside its own window, and the drive reported stuck
// though the verification mail arrived the same minute.
it("resumes a budget-ended inbox poll and fills newly arrived mail", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: pinPage }));
  await page.goto(loginUrl);
  const started = await startHarnessProvisionSession({
    browser: BrowserController.fromHarnessPage(page),
    serviceUrl: loginUrl,
    format: "compact",
    initialObservation: "drive",
  });
  const sessionId = started.session_id;
  sessionForCall(sessionId)!.drive = emptyDriveState(goal, { email: "person@example.test" });
  let offset = 0;
  const awaitVerification = vi.fn<DriveDependencies["awaitVerification"]>(async () => {
    // Less than the 45 s poll window passes, but the 30 s budget is gone.
    offset += 29_000;
    return { session_id: sessionId, found: false, code: null, link: null, messages: [] };
  });
  try {
    const result = await runOperateDrive(
      { session_id: sessionId, goal, max_steps: 3, max_seconds: 30 },
      api,
      undefined,
      {
        act,
        observe,
        startSession: async () => {
          throw new Error("existing session");
        },
        awaitVerification,
        injectCard: async () => ({ status: "unused" }),
        now: () => Date.now() + offset,
        askJev: answering((name) =>
          name === DRIVE_EMAIL_CODE_QUESTION ? "code_field_1" : undefined,
        ),
      },
    );
    expect(awaitVerification).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("budget");

    awaitVerification.mockResolvedValue({
      session_id: sessionId,
      found: true,
      code: "482619",
      link: null,
    });
    const resumed = await runOperateDrive(
      { session_id: sessionId, goal, max_steps: 1, max_seconds: 30 },
      api,
      undefined,
      {
        act,
        observe,
        startSession: async () => {
          throw new Error("existing session");
        },
        awaitVerification,
        injectCard: async () => ({ status: "unused" }),
        askJev: answering((name) =>
          name === DRIVE_EMAIL_CODE_QUESTION ? "code_field_1" : undefined,
        ),
      },
    );
    expect(awaitVerification).toHaveBeenCalledTimes(2);
    expect(await page.getByLabel("6-digit PIN").inputValue()).toBe("482619");
    expect(resumed.trajectory.some((step) => step.action === "type_otp")).toBe(true);
  } finally {
    await finishProvisionSession(sessionId);
    await context.close();
  }
}, 20_000);

// 1.1.61 Token Harbor drive, run 2 (trace L69254-L69265): the code dialog's
// input is type=password, so after the inbox read typed the code the row showed
// only that it held a value. The drive offered the field again and re-read the
// inbox eight times instead of pressing Verify.
it.each([
  '<label>Verification code <input type="password" inputmode="numeric" maxlength="6" pattern="[0-9]*"></label>',
  '<input type="password" placeholder="Verification code" inputmode="numeric" maxlength="6" pattern="[0-9]*">',
])("submits and re-arms a masked code field: %s", async (control) => {
  const codePage = `<meta charset="utf-8"><main><h1>API keys</h1>
    <div role="dialog" aria-label="Show plaintext key">
      <p>We sent a verification code to your email.</p>
      ${control}
      <button type="button">Cancel</button>
      <button type="button" onclick="document.querySelector('input').value = ''">Resend PIN</button>
      <button type="button" onclick="document.body.dataset.verified = document.querySelector('input').value">Verify</button>
    </div></main>`;
  const keysUrl = "https://tokenharbor.ai/dashboard/api-keys";
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: codePage }));
  await page.goto(keysUrl);
  const started = await startHarnessProvisionSession({
    browser: BrowserController.fromHarnessPage(page),
    serviceUrl: keysUrl,
    format: "compact",
    initialObservation: "drive",
  });
  const sessionId = started.session_id;
  const revealGoal = "Show the plaintext key: type the emailed code and press Verify.";
  sessionForCall(sessionId)!.drive = emptyDriveState(revealGoal, { email: "person@example.test" });
  const awaitVerification = vi.fn<DriveDependencies["awaitVerification"]>(async () => ({
    session_id: sessionId,
    found: true,
    code: "482619",
    link: null,
  }));
  const pick: DriveDependencies["askJev"] = async (client, state, questions) =>
    await answering((name) => {
      if (name === DRIVE_EMAIL_CODE_QUESTION) return "code_field_1";
      if (name === "operation") return "CLICK";
      const question = questions[name];
      if (name !== "CLICK_target" || question?.type !== "choice") return undefined;
      return Object.keys(question.criteria).find((key) => question.criteria[key] === "Verify");
    })(client, state, questions);
  try {
    const result = await runOperateDrive(
      { session_id: sessionId, goal: revealGoal, max_steps: 3, max_seconds: 30 },
      api,
      undefined,
      {
        act,
        observe,
        startSession: async () => {
          throw new Error("existing session");
        },
        awaitVerification,
        injectCard: async () => ({ status: "unused" }),
        askJev: pick,
      },
    );
    expect(awaitVerification).toHaveBeenCalledTimes(1);
    expect(result.trajectory.some((step) => step.action === "type_otp")).toBe(true);
    expect(await page.evaluate(() => document.body.dataset.verified)).toBe("482619");
    await page.getByRole("button", { name: "Resend PIN" }).click();
    awaitVerification.mockResolvedValue({
      session_id: sessionId,
      found: true,
      code: "739152",
      link: null,
    });
    const resumed = await runOperateDrive(
      { session_id: sessionId, goal: revealGoal, max_steps: 1, max_seconds: 30 },
      api,
      undefined,
      {
        act,
        observe,
        startSession: async () => {
          throw new Error("existing session");
        },
        awaitVerification,
        injectCard: async () => ({ status: "unused" }),
        askJev: pick,
      },
    );
    expect(awaitVerification).toHaveBeenCalledTimes(2);
    expect(await page.locator("input").inputValue()).toBe("739152");
    expect(resumed.trajectory.some((step) => step.action === "type_otp")).toBe(true);
  } finally {
    await finishProvisionSession(sessionId);
    await context.close();
  }
}, 20_000);
