import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { chromium, type Browser } from "playwright";
import type { ApiClient } from "../../api-client.js";
import type { JevAnswer } from "../jev-client.js";
import { BrowserController } from "../browser.js";
import {
  DRIVE_FIXED_NONE,
  emptyDriveState,
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
import { sessionForCall } from "../session/lifecycle.js";
import { extractCredentials } from "../capture/capture.js";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
});
afterAll(async () => {
  await browser?.close();
});

it("creates a named key when existing keys are masked, then captures its one-time value", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const url = "https://app.example.test/settings/keys";
  const key = "sk_fixtureNewKey0123456789abcdefgh";
  await page.route("**/*", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><main>
        <h1>API Keys</h1>
        <label>Old API Key <input readonly value="sk_old_***"></label>
        <button id="open" type="button">Create API Key</button>
      </main>
      <script>
        document.querySelector('#open').addEventListener('click', () => {
          document.querySelector('main').innerHTML =
            '<h1>Create API Key</h1><form id="create-form">' +
            '<label>API Key Name <input name="key_name" required></label>' +
            '<button type="submit">Create Key</button></form>';
          document.querySelector('#create-form').addEventListener('submit', (event) => {
            event.preventDefault();
            const name = document.querySelector('[name=key_name]').value;
            if (!name) return;
            document.querySelector('main').innerHTML =
              '<h1>New API key</h1><p>Name: ' + name + '</p>' +
              '<label>Old API Key <input readonly value="sk_old_***"></label>' +
              '<label>API key <input readonly value="${key}"></label>';
          });
        });
      </script>`,
    }),
  );
  await page.goto(url);
  const started = await startHarnessProvisionSession({
    browser: BrowserController.fromHarnessPage(page),
    serviceUrl: url,
    format: "compact",
    initialObservation: "drive",
  });
  const api = { useCredential: vi.fn() } as unknown as ApiClient;
  const goal = "Create a new API key named Corpus Key and get its full value";
  const askJev: DriveDependencies["askJev"] = async (_api, _state, questions) => {
    const form = await page.locator("#create-form").count();
    const name = form ? await page.locator('[name="key_name"]').inputValue() : "";
    const revealed = await page.locator(`input[value="${key}"]`).count();
    const operation = revealed ? "DONE" : !form ? "CLICK" : name ? "CLICK" : "TYPE_TEXT";
    const answers: Record<string, JevAnswer> = {};
    for (const [questionName, question] of Object.entries(questions)) {
      if (question.type === "noul") {
        answers[questionName] = { noul: 0.05 };
        continue;
      }
      if (question.type !== "choice") continue;
      const entries = Object.entries(question.criteria);
      const choice =
        questionName === "operation"
          ? operation
          : questionName === "email_code_field"
            ? DRIVE_FIXED_NONE
            : questionName === "form_value_1"
              ? "key_name"
              : questionName === "TYPE_TEXT_target"
                ? entries.find(([, label]) => label.includes("API Key Name"))?.[0]
                : questionName === "CLICK_target"
                  ? entries.find(([, label]) =>
                      label.includes(form ? "Create Key" : "Create API Key"),
                    )?.[0]
                  : entries[0]?.[0];
      if (choice === undefined || !(choice in question.criteria)) continue;
      answers[questionName] = {
        choice,
        confidence: 0.98,
        probabilities: peakedProbabilities(Object.keys(question.criteria), choice),
      };
    }
    return { attempts: 1, elapsedMs: 1, result: { answers } };
  };
  try {
    sessionForCall(started.session_id)!.drive = emptyDriveState(goal, { key_name: "Corpus Key" });
    const result = await runOperateDrive(
      { session_id: started.session_id, goal, max_steps: 8, max_seconds: 20 },
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
      },
    );
    expect(result.status).toBe("complete");
    expect(await page.locator("main").innerText()).toContain("Name: Corpus Key");
    expect(await page.locator('[name="key_name"]').count()).toBe(0);
    const extracted = await extractCredentials(started.session_id);
    expect(Object.values(extracted.credentials)).toContain(key);
    expect(extracted.masked_remaining?.length).toBeGreaterThan(0);
  } finally {
    await finishProvisionSession(started.session_id);
    await context.close();
  }
}, 30_000);
