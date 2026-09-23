import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { chromium, type Browser } from "playwright";
import type { ApiClient } from "../../api-client.js";
import { BrowserController } from "../browser.js";
import { extractCredentials } from "../capture/capture.js";
import { emptyDriveState, runOperateDrive, type DriveDependencies } from "../operate-drive.js";
import {
  act,
  awaitVerification,
  finishProvisionSession,
  observe,
  startHarnessProvisionSession,
} from "../provision-session.js";
import { sessionForCall } from "../session/lifecycle.js";

vi.mock("../capture/capture.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../capture/capture.js")>();
  return { ...actual, extractCredentials: vi.fn(actual.extractCredentials) };
});

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
});
afterAll(async () => {
  await browser?.close();
});

const api = { useCredential: vi.fn() } as unknown as ApiClient;
const key = "re_abcdefGHIJKLmnop1234567";

async function withKeyPage(run: (sessionId: string) => Promise<void>): Promise<void> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const url = "https://app.example.test/keys";
  await page.route("**/*", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<main><h1>API keys</h1><label>API key <input readonly value="${key}"></label></main>`,
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

it("completes a readable key despite a binding from the previous page", async () => {
  await withKeyPage(async (sessionId) => {
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
      { session_id: sessionId, goal: "extract an API key", max_steps: 3, max_seconds: 2 },
      api,
      undefined,
      dependencies(askJev),
    );
    expect(result.status).toBe("complete");
    expect(askJev).toHaveBeenCalled();
  });
}, 15_000);

it("asks the model when automatic key completion is refused", async () => {
  await withKeyPage(async (sessionId) => {
    const session = sessionForCall(sessionId)!;
    session.drive = emptyDriveState("extract an API key", {});
    const realExtract = vi.mocked(extractCredentials).getMockImplementation()!;
    let reads = 0;
    vi.mocked(extractCredentials).mockImplementation(async (id) => {
      reads += 1;
      const extracted = await realExtract(id);
      return reads % 2 === 1 ? extracted : { ...extracted, credentials: {} };
    });
    const askJev = vi.fn<DriveDependencies["askJev"]>(async (_api, _state, questions) => ({
      attempts: 1,
      elapsedMs: 1,
      result: {
        answers: Object.fromEntries(
          Object.entries(questions).flatMap(([name, question]) => {
            if (question.type !== "choice") return [];
            const keys = Object.keys(question.criteria);
            const choice = name === "operation" ? "BLOCKED" : keys[0]!;
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
    try {
      const result = await runOperateDrive(
        { session_id: sessionId, goal: "extract an API key", max_steps: 3, max_seconds: 2 },
        api,
        undefined,
        dependencies(askJev),
      );
      expect(askJev).toHaveBeenCalledTimes(1);
      expect(result.status).toBe("stuck");
    } finally {
      vi.mocked(extractCredentials).mockImplementation(realExtract);
    }
  });
}, 15_000);
