import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import type { ApiClient } from "../../api-client.js";
import { BrowserController } from "../browser.js";
import { OAUTH_PROVIDERS } from "../oauth-providers.js";
import { ensureGeneratedFacts, peakedProbabilities, resumeAction, resumeAnswerOptions, runOperateDrive, type DriveDependencies, type WireRow } from "../operate-drive.js";
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

function chooseOauth(label: string): DriveDependencies["askJev"] {
  return async (_api, _state, questions) => {
    const operation = questions.operation;
    const click = questions.CLICK_target;
    if (operation?.type !== "choice" || click?.type !== "choice") {
      throw new Error("OAuth action was not offered to the model");
    }
    const target = Object.entries(click.criteria).find(([, description]) =>
      description.includes(label),
    )?.[0];
    if (target === undefined) throw new Error("OAuth target was not offered to the model");
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
  };
}

describe("drive OAuth trace", () => {
  it("keeps signed-out providers out of human resume choices", () => {
    const rows: WireRow[] = [
      ["@github", "b", "Continue with GitHub"],
      ["@google", "b", "Continue with Google"],
      ["@microsoft", "b", "Continue with Microsoft"],
      ["@hasura", "b", "Continue with Hasura"],
    ];
    const options = resumeAnswerOptions(rows, {}, "Sign in to Neon", false, "https://console.neon.tech/login", ["google"]);
    expect(Object.values(options)).toContain("Continue with Google");
    expect(Object.values(options)).not.toContain("Continue with GitHub");
    expect(Object.values(options)).not.toContain("Continue with Microsoft");
    expect(Object.values(options)).not.toContain("Continue with Hasura");
    expect(resumeAction("@github", rows, {}, "Sign in to Neon", undefined, "https://console.neon.tech/login", ["google"])).toMatchObject({
      kind: "invalid_answer",
      reason: "resume_not_current_option",
    });
    expect(resumeAction("@microsoft", rows, {}, "Sign in to Neon", undefined, "https://console.neon.tech/login", ["google"]).kind).toBe("invalid_answer");
  });

  it("offers the live Google provider instead of signed-out GitHub on a login page", async () => {
    const context = await browser.newContext();
    await context.route("https://myaccount.google.com/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<button aria-label="Google Account: Operator (operator@example.com)"></button>',
      }),
    );
    const page = await context.newPage();
    await page.goto(
      `data:text/html,${encodeURIComponent('<main><h1>Sign in</h1><label>Email <input name="email" type="email"></label><label>Password <input name="password" type="password"></label><button>Continue with GitHub</button><button>Continue with Google</button></main>')}`,
    );
    const started = await startHarnessProvisionSession({
      browser: BrowserController.fromHarnessPage(page),
      serviceUrl: page.url(),
      format: "compact",
      initialObservation: "drive",
    });
    try {
      const offered: string[][] = [];
      const actions: string[] = [];
      const deps: DriveDependencies = {
        askJev: async (_api, _state, questions) => {
          const click = questions.CLICK_target;
          const operation = questions.operation;
          if (click?.type !== "choice" || operation?.type !== "choice") throw new Error("No OAuth choices");
          offered.push(Object.values(click.criteria));
          const first = Object.keys(click.criteria)[0]!;
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
                  choice: first,
                  confidence: 0.95,
                  probabilities: peakedProbabilities(Object.keys(click.criteria), first),
                },
              },
            },
          };
        },
        act,
        observe,
        startSession: async () => { throw new Error("existing session"); },
        awaitVerification,
        injectCard: async () => ({ status: "unused" }),
        driveAct: async (_sessionId, action) => {
          actions.push(action.kind === "oauth_login" ? action.provider ?? "unknown" : action.kind);
          return {
            kind: "ok",
            combobox: false,
            needsUser: { wall: "google_session", message: "Connect first", resume: "connect" },
          };
        },
      };
      await runOperateDrive({ session_id: started.session_id, goal: "Sign in to Neon", max_steps: 2 }, {} as ApiClient, undefined, deps);
      expect(offered[0]).toContain("Continue with Google");
      expect(offered[0]).not.toContain("Continue with GitHub");
      expect(actions).toEqual(["google"]);
      expect(await page.locator('input[type="password"]').inputValue()).toBe("");
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

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
        askJev: chooseOauth(label),
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
      expect(result.needs_user).toMatchObject({ wall: "google_session", resume: "connect" });
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

  it("hands a human OAuth challenge back with the existing connect route", async () => {
    const context = await browser.newContext();
    await context.route("https://github.com/login", (route) =>
      route.fulfill({ contentType: "text/html", body: "<main>Sign in to GitHub</main>" }),
    );
    const page = await context.newPage();
    await page.goto(`data:text/html,${encodeURIComponent("<button>Continue with GitHub</button>")}`);
    const started = await startHarnessProvisionSession({
      browser: BrowserController.fromHarnessPage(page),
      serviceUrl: page.url(),
      format: "compact",
      initialObservation: "drive",
    });
    try {
      const deps: DriveDependencies = {
        askJev: chooseOauth("Continue with GitHub"),
        act,
        observe,
        startSession: async () => { throw new Error("existing session"); },
        awaitVerification,
        injectCard: async () => ({ status: "unused" }),
        driveAct: async () => {
          await page.goto("https://github.com/login");
          return {
            kind: "ok",
            combobox: false,
            oauth: {
              state: "awaiting_human",
              reason: "Provider asks for a person to sign in",
              next_action: "operate_observe",
            },
          };
        },
      };
      const result = await runOperateDrive(
        { session_id: started.session_id, goal: "Sign in to Neon", max_steps: 2 },
        {} as ApiClient,
        undefined,
        deps,
      );
      expect(result.needs_user).toMatchObject({ resume: "connect" });
      expect(result.question).toContain("connect");
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it("does not type a generated password into a login page with no caller facts", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`data:text/html,${encodeURIComponent('<main><h1>Sign in</h1><label>Password <input type="password" name="password" required></label><button>Sign in</button></main>')}`);
    const started = await startHarnessProvisionSession({
      browser: BrowserController.fromHarnessPage(page),
      serviceUrl: page.url(),
      format: "compact",
      initialObservation: "drive",
    });
    try {
      const deps: DriveDependencies = {
        askJev: async (_api, _state, questions) => {
          const operation = questions.operation;
          if (operation?.type !== "choice") throw new Error("No operation choices");
          const type = questions.TYPE_TEXT_target;
          const choice = type?.type === "choice" ? "TYPE_TEXT" : "BLOCKED";
          const answers: Record<string, { choice: string; confidence: number; probabilities: Record<string, number> }> = {
            operation: {
              choice,
              confidence: 0.95,
              probabilities: peakedProbabilities(Object.keys(operation.criteria), choice),
            },
          };
          if (type?.type === "choice") {
            const target = Object.keys(type.criteria)[0]!;
            answers.TYPE_TEXT_target = {
              choice: target,
              confidence: 0.95,
              probabilities: peakedProbabilities(Object.keys(type.criteria), target),
            };
          }
          return { attempts: 1, elapsedMs: 1, result: { answers } };
        },
        act,
        observe,
        startSession: async () => { throw new Error("existing session"); },
        awaitVerification,
        injectCard: async () => ({ status: "unused" }),
      };
      await runOperateDrive(
        { session_id: started.session_id, goal: "Sign in to Neon", max_steps: 1 },
        {} as ApiClient,
        undefined,
        deps,
      );
      expect(await page.locator('input[type="password"]').inputValue()).toBe("");
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it("still generates and types a password on a new-account form", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`data:text/html,${encodeURIComponent('<main><h1>Create an account</h1><label>Password <input type="password" name="password" required></label><button>Create account</button></main>')}`);
    const started = await startHarnessProvisionSession({
      browser: BrowserController.fromHarnessPage(page),
      serviceUrl: page.url(),
      format: "compact",
      initialObservation: "drive",
    });
    try {
      const deps: DriveDependencies = {
        askJev: async (_api, _state, questions) => {
          const operation = questions.operation;
          const type = questions.TYPE_TEXT_target;
          if (operation?.type !== "choice" || type?.type !== "choice") throw new Error("No password choice");
          const target = Object.keys(type.criteria)[0]!;
          return {
            attempts: 1,
            elapsedMs: 1,
            result: {
              answers: {
                operation: {
                  choice: "TYPE_TEXT",
                  confidence: 0.95,
                  probabilities: peakedProbabilities(Object.keys(operation.criteria), "TYPE_TEXT"),
                },
                TYPE_TEXT_target: {
                  choice: target,
                  confidence: 0.95,
                  probabilities: peakedProbabilities(Object.keys(type.criteria), target),
                },
              },
            },
          };
        },
        act,
        observe,
        startSession: async () => { throw new Error("existing session"); },
        awaitVerification,
        injectCard: async () => ({ status: "unused" }),
      };
      await runOperateDrive(
        { session_id: started.session_id, goal: "Sign up for Neon", max_steps: 1 },
        {} as ApiClient,
        undefined,
        deps,
      );
      expect(await page.locator('input[type="password"]').inputValue()).not.toBe("");
      const loginRows: WireRow[] = [
        ["@password", "t", "Password|f=password"],
        ["@signup", "l", "Sign up for an account"],
        ["@login", "b", "Log in"],
      ];
      expect(ensureGeneratedFacts(loginRows, {}, {
        pageUrl: "https://console.neon.tech/login",
        goal: "Sign up for Neon",
      }).password).toBeUndefined();
    } finally {
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
        askJev: chooseOauth(label),
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
