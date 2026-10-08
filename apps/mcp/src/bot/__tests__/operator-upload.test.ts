import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import { expect, it } from "vitest";
import { BrowserController } from "../browser.js";
import { finishProvisionSession, startHarnessProvisionSession } from "../provision-session.js";
import { operateUploadTool } from "../../tools/provision-drive.js";

it("uploads a local file through a button-backed file chooser", async () => {
  const fixtureDir = await mkdtemp(join(process.cwd(), ".operator-upload-fixture-"));
  const filePath = join(fixtureDir, "app-release.aab");
  let browser: Browser | undefined;
  const url = "https://upload-fixture.test/";
  let sessionId: string | undefined;
  try {
    await writeFile(filePath, "synthetic app bundle");
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
    const page = await browser.newPage();
    await page.route(url, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<button type="button" onclick="document.querySelector('#bundle').click()">Upload app bundles</button>
          <input id="bundle" type="file" hidden onchange="document.querySelector('output').textContent = this.files[0].name + ':' + this.files[0].size">
          <output></output>`,
      }),
    );
    const started = await startHarnessProvisionSession({
      browser: BrowserController.fromHarnessPage(page),
      serviceUrl: url,
      format: "compact",
    });
    sessionId = started.session_id;
    const rows = (started as unknown as { safe_table: string[][] }).safe_table;
    const target = rows.find((row) => row[2]?.split("|")[0] === "@upload-app-bundles")?.[0];
    expect(target).toBeDefined();
    const result = await operateUploadTool.handler(
      { session_id: sessionId, target: target!, path: filePath },
      null,
    );
    expect(result).toHaveProperty("session_id", sessionId);
    expect(await page.locator("output").textContent()).toBe("app-release.aab:20");
  } finally {
    if (sessionId) await finishProvisionSession(sessionId);
    await browser?.close();
    await rm(fixtureDir, { recursive: true, force: true });
  }
}, 30_000);
