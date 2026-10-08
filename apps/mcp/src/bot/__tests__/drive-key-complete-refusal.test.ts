import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { chromium, type Browser } from "playwright";
import type { ApiClient } from "../../api-client.js";
import { BrowserController } from "../browser.js";
import { emptyDriveState, runOperateDrive, type DriveDependencies } from "../operate-drive.js";
import {
  act,
  awaitVerification,
  finishProvisionSession,
  observe,
  startHarnessProvisionSession,
} from "../provision-session.js";
import { sessionForCall } from "../session/lifecycle.js";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
});
afterAll(async () => {
  await browser?.close();
});

const api = { useCredential: vi.fn() } as unknown as ApiClient;
const key = "re_abcdefGHIJKLmnop1234567";

// The Copy click is the source the drive stores a key from.
const copyKeyPage = `<main><h1>API keys</h1><div role="dialog" aria-label="API key created">
  <label>API key <input readonly value="${key}"></label>
  <button type="button" aria-label="Copy API key"
    onclick="navigator.clipboard.writeText('${key}')">Copy</button></div></main>`;

async function withKeyPage(
  body: string,
  run: (sessionId: string) => Promise<void>,
  path = "/keys",
): Promise<void> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const url = `https://app.example.test${path}`;
  await page.route("**/*", (route) =>
    route.fulfill({
      contentType: "text/html",
      body,
    }),
  );
  await page.goto(url);
  const started = await startHarnessProvisionSession({
    browser: BrowserController.fromHarnessPage(page),
    serviceUrl: url,
    format: "compact",
    initialObservation: "drive",
  });
  try {
    await run(started.session_id);
  } finally {
    await finishProvisionSession(started.session_id);
    await context.close();
  }
}

function dependencies(askJev: DriveDependencies["askJev"]): DriveDependencies {
  return {
    askJev,
    act,
    observe,
    startSession: async () => {
      throw new Error("existing session");
    },
    awaitVerification,
    injectCard: async () => ({ status: "unused" }),
  };
}

it("trusts DONE on a copy-capable page despite a binding from the previous page", async () => {
  await withKeyPage(copyKeyPage, async (sessionId) => {
    const session = sessionForCall(sessionId)!;
    session.drive = emptyDriveState("extract an API key", {});
    session.drive.boundFingerprint = "previous page";
    const askJev = vi.fn<DriveDependencies["askJev"]>(async (_api, _state, questions) => ({
      attempts: 1,
      elapsedMs: 1,
      result: {
        answers: Object.fromEntries(
          Object.entries(questions).flatMap(([name, question]) => {
            if (question.type !== "choice") return [];
            const keys = Object.keys(question.criteria);
            const choice = name === "operation" ? "DONE" : keys[0]!;
            return [
              [
                name,
                {
                  choice,
                  confidence: 1,
                  probabilities: Object.fromEntries(
                    keys.map((key) => [key, key === choice ? 1 : 0]),
                  ),
                },
              ],
            ];
          }),
        ),
      },
    }));
    const result = await runOperateDrive(
      { session_id: sessionId, goal: "extract an API key", max_steps: 3, max_seconds: 10 },
      api,
      undefined,
      dependencies(askJev),
    );
    expect(result.status).toBe("complete");
    expect(askJev).toHaveBeenCalled();
  });
}, 15_000);

it("trusts the model's DONE on a page without a key", async () => {
  await withKeyPage("<main><h1>API keys</h1><button>Create key</button><p>No key yet</p></main>", async (sessionId) => {
    const session = sessionForCall(sessionId)!;
    session.drive = emptyDriveState("extract an API key", {});
    const askJev = vi.fn<DriveDependencies["askJev"]>(async (_api, _state, questions) => ({
      attempts: 1,
      elapsedMs: 1,
      result: {
        answers: Object.fromEntries(
          Object.entries(questions).flatMap(([name, question]) => {
            if (question.type !== "choice") return [];
            const keys = Object.keys(question.criteria);
            const choice = name === "operation" ? "DONE" : keys[0]!;
            return [
              [
                name,
                {
                  choice,
                  confidence: 1,
                  probabilities: Object.fromEntries(
                    keys.map((key) => [key, key === choice ? 1 : 0]),
                  ),
                },
              ],
            ];
          }),
        ),
      },
    }));
    const result = await runOperateDrive(
      { session_id: sessionId, goal: "extract an API key", max_steps: 3, max_seconds: 10 },
      api,
      undefined,
      dependencies(askJev),
    );
    expect(askJev).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("complete");
  });
}, 15_000);

it.each([
  { label: "Rotate key", path: "/keys" },
  { label: "Delete key", path: "/keys" },
  { label: "Revoke credential", path: "/keys" },
  { label: "Reset", path: "/keys" },
  { label: "Delete", path: "/settings" },
])(
  "hands $label back before dispatch",
  async ({ label, path }) => {
    await withKeyPage(`<main><h1>API keys</h1><button>${label}</button></main>`, async (sessionId) => {
      const driveAct = vi.fn<NonNullable<DriveDependencies["driveAct"]>>(async () => {
        throw new Error("mutation action must not dispatch");
      });
      const askJev = vi.fn<DriveDependencies["askJev"]>(async (_api, _state, questions) => ({
        attempts: 1,
        elapsedMs: 1,
        result: {
          answers: Object.fromEntries(
            Object.entries(questions).flatMap(([name, question]) => {
              if (question.type !== "choice") return [];
              const keys = Object.keys(question.criteria);
              const choice = name === "operation" ? "CLICK" :
                name === "CLICK_target"
                  ? keys.find((candidate) => question.criteria[candidate]?.includes(label)) ?? keys[0]!
                  : keys[0]!;
              return [[name, {
                choice,
                confidence: 1,
                probabilities: Object.fromEntries(keys.map((key) => [key, key === choice ? 1 : 0])),
              }]];
            }),
          ),
        },
      }));
      const result = await runOperateDrive(
        { session_id: sessionId, goal: "manage my API key", max_steps: 3, max_seconds: 3 },
        api,
        undefined,
        { ...dependencies(askJev), driveAct },
      );
      expect(result.status).toBe("stuck");
      expect(result.reason).toContain(`operator decision required before ${label}`);
      expect(result.reason).toContain("no action was dispatched");
      expect(driveAct).not.toHaveBeenCalled();
    }, path);
  },
  15_000,
);
