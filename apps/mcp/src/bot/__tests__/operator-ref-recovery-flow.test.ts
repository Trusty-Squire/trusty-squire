import { expect, it } from "vitest";
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BrowserController } from "../browser.js";
import { startHarnessProvisionSession, finishProvisionSession } from "../provision-session.js";
import { ProvenPreDispatchMutationError } from "../mutation-dispatch-evidence.js";
import {
  operateClickTool,
  operateNavigateTool,
  provisionObserveTool,
} from "../../tools/provision-drive.js";

it("recovers through the public tools after a checkout rerender and a removed control", async () => {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage();
  const url = "https://checkout-recovery.test/";
  const transcript: unknown[] = [];
  const evidence = process.env.OPERATOR_REF_EVIDENCE_DIR;
  let sessionId: string | undefined;
  await page.route(`${url}**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<h1>Checkout fixture</h1><main><button id="continue" onclick="document.querySelector('output').textContent='Continued once'">Continue</button></main><output>Awaiting action</output>`,
    }),
  );
  try {
    const start = await startHarnessProvisionSession({
      browser: BrowserController.fromHarnessPage(page),
      serviceUrl: url,
      format: "compact",
    });
    sessionId = start.session_id;
    transcript.push({
      step: "start (harness browser; real public action handlers)",
      response: start,
    });
    const rows = (start as unknown as { safe_table: string[][] }).safe_table;
    const ref = rows.find((row) => row[2]?.split("|")[0] === "@continue")![0]!;
    await page.evaluate(() => {
      const main = document.querySelector("main")!;
      main.innerHTML = `<section><p>Hydrated layout</p>${main.innerHTML}</section>`;
    });
    const clicked = await operateClickTool.handler({ session_id: sessionId, ref }, null);
    expect(await page.locator("output").textContent()).toBe("Continued once");
    transcript.push({
      step: "operate_click with original ref after node replacement and layout change",
      ref,
      response: clicked,
      pageOutput: await page.locator("output").textContent(),
    });
    // A different authored identity must not inherit the authority of the old ref.
    await page.evaluate(() => {
      document.querySelector("main")!.innerHTML =
        `<button id="different" onclick="document.querySelector('output').textContent='WRONG TARGET'">Continue</button>`;
    });
    const failure = await operateClickTool
      .handler({ session_id: sessionId, ref }, null)
      .catch((error) => error);
    expect(failure).toBeInstanceOf(ProvenPreDispatchMutationError);
    if (!(failure instanceof ProvenPreDispatchMutationError)) throw failure;
    expect(await page.locator("output").textContent()).toBe("Continued once");
    transcript.push({
      step: "operate_click after original identity disappeared",
      error: { name: failure.name, code: failure.code, dispatch: failure.dispatch },
      pageOutput: await page.locator("output").textContent(),
    });
    const observed = await provisionObserveTool.handler({ session_id: sessionId }, null);
    expect(observed).toHaveProperty("session_id", sessionId);
    transcript.push({
      step: "operate_observe in same session after stale_ref",
      response: observed,
    });
    const navigated = await operateNavigateTool.handler(
      { session_id: sessionId, url: `${url}recovered` },
      null,
    );
    expect(page.url()).toBe(`${url}recovered`);
    transcript.push({
      step: "operate_navigate in same session after stale_ref",
      response: navigated,
      pageUrl: page.url(),
    });
    if (evidence) {
      await mkdir(evidence, { recursive: true });
      await writeFile(
        join(evidence, "spa-recovery-tool-responses.json"),
        JSON.stringify(transcript, null, 2),
      );
    }
  } finally {
    if (sessionId) await finishProvisionSession(sessionId);
    await browser.close();
  }
}, 30_000);
