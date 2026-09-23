import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { chromium, type BrowserContext, type Page } from "playwright";
import { BrowserController } from "../../browser.js";
import { captureFrameSnapshot } from "../../drive-snapshot.js";
import * as lifecycle from "../../session/lifecycle.js";
import type { Session } from "../../session/model.js";
import { extractCredentials } from "../capture.js";

let profile: string;
let context: BrowserContext;
let page: Page;

beforeAll(async () => {
  profile = await mkdtemp(join(process.cwd(), ".capture-presentation-profile-"));
  context = await chromium.launchPersistentContext(profile, {
    channel: "chrome",
    headless: false,
    args: ["--no-sandbox"],
  });
  page = context.pages()[0] ?? (await context.newPage());
  vi.spyOn(lifecycle, "sessionForCall").mockReturnValue({
    browser: BrowserController.fromHarnessPage(page),
  } as Session);
});

afterAll(async () => {
  vi.restoreAllMocks();
  await context?.close();
  if (profile !== undefined) await rm(profile, { recursive: true, force: true });
});

it("copies from an unmarked presentation layer with masked code and unlabeled icon controls", async () => {
  const key = "fixture_Ab9Cd8Ef7Gh6Jk5Lm4Np3Qr2St1Uv0Wx9Yz8Ab7Cd6Ef5Gh4Jk3Lm2Np";
  const html = `<!doctype html><style>
    body { margin: 0; }
    [role="presentation"] { position: fixed; inset: 0; z-index: 1300; display: grid; place-items: center; background: rgba(0,0,0,.4); }
    [role="presentation"] > div { width: 440px; padding: 24px; background: white; }
    pre, code { width: 390px; }
    button { width: 40px; height: 40px; }
  </style>
  <div role="presentation" class="MuiModal-root"><div class="MuiPaper-root">
    <div><div><div><h2>API key generated</h2></div></div></div>
    <div class="value-row"><pre>********-****-****-****-************</pre>
      <code>********-****-****-****-************</code></div>
    <div><div><div><span><span>
      <button type="button" class="MuiButton-root"><svg data-testid="VisibilityIcon"></svg></button>
      <button type="button" class="MuiButton-root"><svg data-testid="ContentCopyIcon"></svg></button>
    </span></span></div></div></div>
  </div></div>
  <script>
    const [reveal, copy] = document.querySelectorAll('button');
    reveal.addEventListener('click', () => {
      document.querySelector('pre').textContent = '${key}';
      document.querySelector('code').textContent = '${key}';
    });
    copy.addEventListener('click', () => navigator.clipboard.writeText('${key}'));
  </script>`;
  await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto("http://127.0.0.1/");
  expect(await page.locator('dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]').count()).toBe(0);
  const snapshot = await captureFrameSnapshot(page, [], 0);
  expect(snapshot?.text).toContain("API key generated");
  expect(snapshot?.elements.some((element) => element.occludedBy === "overlay" || element.occludedBy === "dialog")).toBe(false);

  const result = await extractCredentials("fixture-session");
  expect(result.credentials.api_key).toBe(key);
  expect(await page.locator("pre").textContent()).toBe("********-****-****-****-************");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(key);
});
