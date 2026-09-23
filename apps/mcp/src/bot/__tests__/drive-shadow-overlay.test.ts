import { existsSync } from "node:fs";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import { identityFromDriveElement, resolveLiveControlIdentity } from "../act/identity.js";
import { captureFrameSnapshot, driveRowsFromSnapshot } from "../drive-snapshot.js";

const available = existsSync(chromium.executablePath());
let browser: Browser | undefined;

beforeAll(async () => {
  if (available) browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
});

afterAll(async () => {
  await browser?.close();
});

it.skipIf(!available)("includes an open-shadow overlay's controls and visible key", async () => {
  const page = await browser!.newPage();
  try {
    await page.goto(
      `data:text/html,${encodeURIComponent(`
      <!doctype html><html><body>
        <button id="background">Underlying action</button>
        <overlay-shell></overlay-shell>
        <script>
          const shell = document.querySelector('overlay-shell').attachShadow({ mode: 'open' });
          shell.innerHTML = '<div style="position:fixed;inset:0;background:white;z-index:10;padding:40px">' +
            '<h2>New credential</h2><code>sk_test_1234567890abcdef</code>' +
            '<button id="dismiss">Continue</button></div>';
          shell.getElementById('dismiss').onclick = () => document.querySelector('overlay-shell').remove();
        </script>
      </body></html>
    `)}`,
    );

    const snapshot = await captureFrameSnapshot(page, [], 0);
    expect(snapshot).not.toBeNull();
    const background = snapshot!.elements.find((el) => el.label === "Underlying action");
    expect(background?.occludedBy).toBe("overlay");
    const dismiss = snapshot!.elements.find((el) => el.label === "Continue");
    expect(dismiss).toBeDefined();
    expect(driveRowsFromSnapshot(snapshot!).some((row) => row[0] === dismiss!.ref)).toBe(true);
    expect(snapshot!.text).toContain("sk_test_1234567890abcdef");
    expect(snapshot!.headings).toContain("New credential");

    const identity = identityFromDriveElement(dismiss!, snapshot!.url);
    const live = await resolveLiveControlIdentity(page, dismiss!.ref, identity);
    expect(live?.selector).toBe(dismiss!.selector);
    await page.locator(live!.selector).click();
    expect(await page.locator("overlay-shell").count()).toBe(0);
  } finally {
    await page.close();
  }
});
