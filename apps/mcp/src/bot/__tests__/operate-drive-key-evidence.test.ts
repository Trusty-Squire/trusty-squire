import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { BrowserController } from "../browser.js";
import { extractCredentials } from "../capture/capture.js";
import { finishProvisionSession, startHarnessProvisionSession } from "../provision-session.js";

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
});

afterAll(async () => {
  await browser?.close();
});

describe("credential capture from a key page", () => {
  it("does not extract a key from connection examples without a Copy source", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const html = `<!doctype html><main>
      <h1>Create a table</h1>
      <label>Region <input readonly value="us-east-1"></label>
      <label>Table name <input readonly value="sample_table"></label>
      <label>URI <input readonly value="db://sample_project"></label>
      <label>Project ID <input readonly value="proj_abc123def456"></label>
      <pre>connect(uri="db://sample_project", api_key="YOUR_API_KEY")</pre>
      <button>Generate API key</button>
    </main>`;
    await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: html }));
    await page.goto("https://example.test/create_table");
    const started = await startHarnessProvisionSession({
      browser: BrowserController.fromHarnessPage(page),
      serviceUrl: page.url(),
      format: "compact",
    });
    try {
      const evidence = await extractCredentials(started.session_id);
      expect(evidence.credentials).toEqual({});
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

});
