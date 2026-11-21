import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { chromium, type Browser } from "playwright";
import type { ApiClient } from "../../api-client.js";
import { BrowserController } from "../browser.js";
import { runOperateDrive, type DriveDependencies } from "../operate-drive.js";
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
const STORED = { reference: "vault:kenari:free", service: "kenari", label: "Grunt Free" };

// A real snapshot must enumerate the value itself, including prefixless values
// and exact long input values, rather than relying on English Copy controls.
it.each([
  ["Salin", "sk-kenari-0123456789abcdefghijklmnopqrstuvwxyzABCDEFG", false],
  ["Salin", "0123456789abcdef".repeat(4), false],
  ["⧉", "opaque|value_".repeat(12), true],
] as const)(
  "stores a selected visible value beside %s (%s)",
  async (label, key, input) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const url = "https://kenari.example.test/keys";
    await page.route("**/*", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<main><h1>Kunci API</h1>${input ? `<input readonly value="${key}">` : `<div>${key}</div>`}
      <button onclick="throw new Error('Copy must not be clicked')">${label}</button>
      <code>export KENARI_API_KEY=your-key</code><p hidden>hidden-value</p>
      <input type="password" value="password-must-not-be-offered"></main>`,
      }),
    );
    await page.goto(url);
    const started = await startHarnessProvisionSession({
      browser: BrowserController.fromHarnessPage(page),
      serviceUrl: url,
      format: "compact",
      initialObservation: "drive",
    });
    const persistCredentials = vi.fn(async () => STORED);
    const askJev = vi.fn<DriveDependencies["askJev"]>(async (_api, _state, questions) => {
      expect(persistCredentials).not.toHaveBeenCalled();
      const save = questions.SAVE_target;
      expect(save?.type).toBe("choice");
      if (save?.type !== "choice") throw new Error("SAVE not offered");
      expect(Object.values(save.criteria)).not.toContain("hidden-value");
      expect(Object.values(save.criteria)).not.toContain("password-must-not-be-offered");
      const selected = Object.keys(save.criteria).find((choice) => save.criteria[choice] === key);
      expect(selected).toBeDefined();
      return {
        attempts: 1,
        elapsedMs: 1,
        result: {
          answers: Object.fromEntries(
            Object.entries(questions).map(([name, question]) => {
              if (question.type !== "choice") return [name, { noul: name === "dead_end" ? 0 : 1 }];
              const keys = Object.keys(question.criteria);
              const choice =
                name === "operation" ? "SAVE" : name === "SAVE_target" ? selected! : keys[0]!;
              return [
                name,
                {
                  choice,
                  confidence: 1,
                  probabilities: Object.fromEntries(
                    keys.map((key) => [key, key === choice ? 1 : 0]),
                  ),
                },
              ];
            }),
          ),
        },
      };
    });
    try {
      const result = await runOperateDrive(
        {
          session_id: started.session_id,
          goal: "Store the new API key",
          max_steps: 3,
          max_seconds: 10,
        },
        {} as ApiClient,
        { persistCredentials },
        { askJev, act, observe, awaitVerification, startSession: vi.fn(), injectCard: vi.fn() },
      );
      expect(askJev).toHaveBeenCalledOnce();
      expect(persistCredentials).toHaveBeenCalledOnce();
      expect(persistCredentials).toHaveBeenCalledWith(
        expect.objectContaining({ credentials: { api_key: key } }),
      );
      expect(result).toMatchObject({ status: "complete", stored: true });
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  },
  15_000,
);
