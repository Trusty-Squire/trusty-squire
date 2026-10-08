import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { BrowserController } from "../browser.js";
import { driveKeyEvidence, driveKeyGoalComplete } from "../operate-drive.js";
import { finishProvisionSession, startHarnessProvisionSession } from "../provision-session.js";

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
});

afterAll(async () => {
  await browser?.close();
});

describe("drive key-goal evidence", () => {
  it("does not complete on a page that shows values but has no Copy-click key", async () => {
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
      const evidence = await driveKeyEvidence(started.session_id);
      expect(evidence.credentials).toEqual({});
      expect(driveKeyGoalComplete(evidence)).toBe(false);
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it("completes on any storable extracted value, whatever its shape", () => {
    for (const value of [
      "d7bd47d70c1e4f2a9b3c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f80bd4a",
      "Ab3kZ9",
    ])
      expect(driveKeyGoalComplete({ credentials: { api_key: value } })).toBe(true);
    expect(
      driveKeyGoalComplete({
        credentials: { project_id: "proj_abc123def456", api_key_truncated: "sk-…abcd" },
      }),
    ).toBe(false);
  });
});
