// Regression: the drive's stop reason is the LOOP's own account of why it
// stopped, never text scraped from the page.
//
// A broad validation-blocker rule promoted any visible `role=status` / polite
// live region / `*-feedback`-classed element whose text merely contained an
// error-ish word. A customer testimonial and a raw JSON payload then became the
// `NONE_OF_THESE` stop reason verbatim. This test drives the real loop against a
// page carrying exactly that chrome and asserts the reason stays deterministic
// while the prose stays out of the blocker list. A genuinely control-bound
// validation message must still surface, so the rule tightens promotion instead
// of removing the signal.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { chromium, type Browser } from "playwright";
import type { ApiClient } from "../../api-client.js";
import { BrowserController } from "../browser.js";
import type { JevCallOutcome } from "../jev-client.js";
import { runOperateDrive, type DriveDependencies } from "../operate-drive.js";
import {
  act,
  observe,
  awaitVerification,
  finishProvisionSession,
  startHarnessProvisionSession,
} from "../provision-session.js";

const TESTIMONIAL = '"The must-have tool our team never knew we failed without." — Ada, Acme Inc.';
const PAYLOAD = '{"error":"not found","payload":{"rows":[1,2,3],"note":"please provide more"}}';
const FIELD_ERROR = "Please enter a valid work email address.";
const URL = "https://stop-reason-fixture.test/";

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

function alwaysNone(): DriveDependencies["askJev"] {
  return async (_api, _state, questions) => {
    const answers: Record<
      string,
      { choice?: string; confidence?: number; probabilities?: Record<string, number> }
    > = {};
    for (const [name, question] of Object.entries(questions)) {
      const keys = question.type === "choice" ? Object.keys(question.criteria) : [];
      if (keys.length === 0) continue;
      const pick =
        name === "operation"
          ? keys.includes("NONE_OF_THESE")
            ? "NONE_OF_THESE"
            : keys[0]!
          : keys[0]!;
      const probabilities: Record<string, number> = {};
      for (const key of keys) {
        probabilities[key] = key === pick ? 0.9 : keys.length > 1 ? 0.1 / (keys.length - 1) : 1;
      }
      answers[name] = { choice: pick, confidence: 0.9, probabilities };
    }
    return { attempts: 1, elapsedMs: 1, result: { answers } } as JevCallOutcome;
  };
}

const PAGE = `<!doctype html><meta charset="utf-8"><title>Acme</title>
<main>
  <h1>Welcome</h1>
  <form onsubmit="return false">
    <label>Email <input id="email" name="email" type="email"
      aria-invalid="true" aria-errormessage="email-error"></label>
    <button id="submit" type="submit">Continue</button>
  </form>
  <p id="email-error">${FIELD_ERROR}</p>
  <div role="status" class="customer-feedback">${TESTIMONIAL}</div>
  <pre role="status" id="payload">${PAYLOAD}</pre>
</main>`;

describe("drive stop reason is not page prose", () => {
  it("keeps passive page copy out of the blocker list and the stop reason", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.route("**/*", (route) =>
      route.fulfill({ contentType: "text/html; charset=utf-8", body: PAGE }),
    );
    await page.goto(URL);
    const started = await startHarnessProvisionSession({
      browser: BrowserController.fromHarnessPage(page),
      serviceUrl: URL,
      format: "compact",
      initialObservation: "drive",
    });
    const dependencies: DriveDependencies = {
      askJev: alwaysNone(),
      act,
      observe,
      startSession: async () => {
        throw new Error("existing session");
      },
      awaitVerification,
      injectCard: async () => ({ status: "unused" }),
    };
    try {
      const result = await runOperateDrive(
        { session_id: started.session_id, goal: "sign in to Acme", max_steps: 8, max_seconds: 20 },
        api(),
        undefined,
        dependencies,
      );
      const observation = await observe(started.session_id, "compact");
      const blockerTexts = (observation.semantic?.blockers ?? []).map((blocker) => blocker.text);

      // A testimonial and a serialized payload are not assertions about the
      // action just taken: they never become blockers.
      expect(blockerTexts).not.toContain(TESTIMONIAL);
      expect(blockerTexts).not.toContain(PAYLOAD);
      // A control-bound validation message still surfaces.
      expect(blockerTexts).toContain(FIELD_ERROR);

      // The stop reason is the loop's own deterministic account, not page text.
      expect(result.reason ?? "").not.toContain("never knew we failed");
      expect(result.reason ?? "").not.toContain("not found");
      expect(result.reason ?? "").toMatch(
        /^(?:nothing on the page can advance the goal|inbox poll found nothing)/,
      );
    } finally {
      await finishProvisionSession(started.session_id).catch(() => undefined);
      await context.close();
    }
  }, 60_000);
});
