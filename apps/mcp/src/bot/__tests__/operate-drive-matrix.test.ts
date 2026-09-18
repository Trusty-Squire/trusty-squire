// Credential-gated replay of the scout coverage-matrix probes against a
// fixture page. Skipped without TRUSTY_SQUIRE_JEV_MATRIX=1 and an agent
// session token (does not read the operator's live session file). Every
// answer at or above DRIVE_CONFIDENCE_THRESHOLD must be correct — the
// regression test for the 0.6 constant.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { ApiClient } from "../../api-client.js";
import { BrowserController } from "../browser.js";
import { askJev } from "../jev-client.js";
import {
  DRIVE_CONFIDENCE_THRESHOLD,
  actionCriteria,
  buildDriveQuestions,
  buildJevState,
  wireRowsFromObservation,
} from "../operate-drive.js";
import { finishProvisionSession, startHarnessProvisionSession } from "../provision-session.js";

const live =
  process.env.TRUSTY_SQUIRE_JEV_MATRIX === "1" &&
  (process.env.TRUSTY_SQUIRE_AGENT_SESSION_TOKEN ?? "").length > 0;

const CHECKOUT_HTML = `<!doctype html><meta charset="utf-8"><title>Checkout fixture</title>
<main>
  <h1>Checkout</h1>
  <button id="cart">Open cart</button>
  <form>
    <label>Email <input id="email" name="email"></label>
    <label>First name <input id="first" name="first_name"></label>
    <label>Address <input id="address" name="address1"></label>
    <label>City <input id="city" name="city"></label>
    <label>State <select id="state" name="state"><option>California</option><option>Oregon</option></select></label>
    <label>ZIP <input id="zip" name="zip"></label>
    <button type="button" id="continue">Continue</button>
  </form>
</main>`;

const FACTS = {
  email: "ada@fixture.test",
  first_name: "Ada",
  city: "Oakland",
  zip: "94612",
  state: "California",
};

let browser: Browser;

beforeAll(async () => {
  if (!live) return;
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
});
afterAll(async () => {
  await browser?.close();
});

describe.skipIf(!live)("operate_drive coverage-matrix replay", () => {
  it("every answer above the confidence constant is correct", async () => {
    const page = await browser.newPage();
    const url = "https://matrix-checkout.test/checkouts/cn/fixture";
    await page.route("**/*", (route) =>
      route.fulfill({ contentType: "text/html", body: CHECKOUT_HTML }),
    );
    await page.goto(url);
    const started = await startHarnessProvisionSession({
      browser: BrowserController.fromHarnessPage(page),
      serviceUrl: url,
      format: "compact",
    });
    try {
      const rows = wireRowsFromObservation(started);
      const api = new ApiClient({
        apiBaseUrl: process.env.TRUSTY_SQUIRE_API_BASE ?? "https://trusty-squire-api.fly.dev",
        registryBaseUrl: "https://registry.trustysquire.ai",
        agentSessionToken: process.env.TRUSTY_SQUIRE_AGENT_SESSION_TOKEN ?? "",
        ...(process.env.TRUSTY_SQUIRE_ACCOUNT_ID === undefined
          ? {}
          : { accountId: process.env.TRUSTY_SQUIRE_ACCOUNT_ID }),
      });
      const questions = buildDriveQuestions(rows, FACTS);
      const state = buildJevState(
        "fill the checkout contact and shipping fields",
        Object.keys(FACTS),
        [],
        started.url,
        started.stage,
        rows,
      );
      const outcome = await askJev(api, state, questions);
      const next = outcome.result.answers.next_action;
      const value = outcome.result.answers.value;
      const complete = outcome.result.answers.goal_complete;
      const gatedCorrect: string[] = [];
      if ((next?.confidence ?? 0) >= DRIVE_CONFIDENCE_THRESHOLD) {
        expect(next?.choice).toBeDefined();
        expect(Object.keys(actionCriteria(rows))).toContain(next?.choice);
        gatedCorrect.push(`next_action:${next?.choice}`);
      }
      if ((value?.confidence ?? 0) >= DRIVE_CONFIDENCE_THRESHOLD) {
        expect(Object.keys(FACTS)).toContain(value?.choice);
        gatedCorrect.push(`value:${value?.choice}`);
      }
      if ((complete?.noul ?? 0) >= DRIVE_CONFIDENCE_THRESHOLD) {
        // Checkout is not complete on this fixture.
        expect(complete?.noul).toBeLessThan(DRIVE_CONFIDENCE_THRESHOLD);
      }
      expect(gatedCorrect.length).toBeGreaterThan(0);
    } finally {
      await finishProvisionSession(started.session_id);
      await page.context().close();
    }
  }, 60_000);
});
