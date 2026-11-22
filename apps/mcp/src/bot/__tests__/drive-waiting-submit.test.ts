import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { chromium, type Browser } from "playwright";
import type { ApiClient } from "../../api-client.js";
import { BrowserController } from "../browser.js";
import { runOperateDrive, type DriveDependencies } from "../operate-drive.js";
import type { JevQuestion } from "../jev-client.js";
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

const api = { useCredential: vi.fn() } as unknown as ApiClient;

// Darus's register form (squire-1.1.58 L160), whose submit is not English.
const page = `<main><h1>Daftar</h1><form onsubmit="return false">
  <label>Nama Anda <input name="nama" required></label>
  <button type="submit">Daftar sekarang</button>
</form></main>`;

it("keeps a refused submit offered beside the field it waits on", async () => {
  const context = await browser.newContext();
  const tab = await context.newPage();
  const url = "https://gateway.example.test/masuk";
  await tab.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: page }));
  await tab.goto(url);
  const started = await startHarnessProvisionSession({
    browser: BrowserController.fromHarnessPage(tab),
    serviceUrl: url,
    format: "compact",
    initialObservation: "drive",
  });
  try {
    const asked: Record<string, JevQuestion>[] = [];
    const askJev = vi.fn<DriveDependencies["askJev"]>(async (_api, _state, questions) => {
      asked.push(questions);
      return {
        attempts: 1,
        elapsedMs: 1,
        result: {
          answers: Object.fromEntries(
            Object.entries(questions).flatMap(([name, question]) => {
              if (question.type !== "choice") return [];
              const keys = Object.keys(question.criteria);
              const choice =
                name === "operation"
                  ? "CLICK"
                  : name === "CLICK_target"
                    ? (keys.find((key) => question.criteria[key]!.startsWith("Daftar sekarang")) ??
                      keys[0]!)
                    : name === "email_code_field"
                      ? "none"
                      : keys[0]!;
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
      };
    });
    const driveAct = vi.fn<NonNullable<DriveDependencies["driveAct"]>>(async () => {
      throw new Error("the refused submit must not dispatch");
    });
    const result = await runOperateDrive(
      { session_id: started.session_id, goal: "register grunt", max_steps: 6, max_seconds: 10 },
      api,
      undefined,
      {
        askJev,
        act,
        observe,
        startSession: async () => {
          throw new Error("existing session");
        },
        awaitVerification,
        injectCard: async () => ({ status: "unused" }),
        driveAct,
      },
    );
    expect(driveAct).not.toHaveBeenCalled();
    expect(asked.length).toBeGreaterThan(2);
    const second = asked[1]!;
    const clicks = second.CLICK_target?.type === "choice" ? second.CLICK_target.criteria : {};
    expect(Object.values(clicks)).toContain(
      "Daftar sekarang (waits for the empty Nama Anda field)",
    );
    const fields =
      second.TYPE_TEXT_target?.type === "choice" ? second.TYPE_TEXT_target.criteria : {};
    expect(Object.values(fields)).toContain("Nama Anda");
    expect(result.status).toBe("budget");
  } finally {
    await finishProvisionSession(started.session_id);
    await context.close();
  }
}, 20_000);
