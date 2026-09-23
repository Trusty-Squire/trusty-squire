import { it } from "vitest";
import { chromium } from "playwright";
import { BrowserController } from "../browser.js";
import { runOperateDrive } from "../operate-drive.js";
import {
  finishProvisionSession,
  observe,
  startHarnessProvisionSession,
} from "../provision-session.js";

const url = "https://ref-benchmark.test/form";
const html = `<!doctype html><title>Ref benchmark</title><main>${Array.from(
  { length: 250 },
  (_, index) => `<label>Field ${index}<input id="f${index}" name="f${index}"></label>`,
).join("")}</main>`;

function summary(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    medianMs: sorted[Math.floor(sorted.length / 2)],
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
  };
}

it("records drive snapshot and canonical observation timing on 250 controls", async () => {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: html }));
    await page.goto(url);
    const controller = BrowserController.fromHarnessPage(page);
    const started = await startHarnessProvisionSession({
      browser: controller,
      serviceUrl: url,
      format: "compact",
      initialObservation: "drive",
    });
    try {
      const drive: number[] = [];
      const canonical: number[] = [];
      for (let index = 0; index < 13; index++) {
        let start = performance.now();
        await runOperateDrive(
          { session_id: started.session_id, goal: "inspect", max_steps: 0 },
          null,
        );
        drive.push(performance.now() - start);
        start = performance.now();
        await observe(started.session_id, "compact");
        canonical.push(performance.now() - start);
      }
      process.stdout.write(
        `${JSON.stringify({ controls: 250, runs: 13, drive: summary(drive), observe: summary(canonical) })}\n`,
      );
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  } finally {
    await browser.close();
  }
}, 180_000);
