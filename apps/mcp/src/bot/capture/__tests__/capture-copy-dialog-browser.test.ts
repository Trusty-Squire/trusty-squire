import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { chromium, type BrowserContext, type Page } from "playwright";
import { BrowserController } from "../../browser.js";
import * as lifecycle from "../../session/lifecycle.js";
import type { Session } from "../../session/model.js";
import { extractCredentials } from "../capture.js";

let profile: string;
let context: BrowserContext;
let page: Page;

beforeAll(async () => {
  // This fixture uses an isolated persistent profile and never touches the
  // broker's live profile.
  profile = await mkdtemp(join(process.cwd(), ".capture-copy-profile-"));
  context = await chromium.launchPersistentContext(profile, {
    channel: "chrome",
    headless: true,
    args: ["--no-sandbox"],
  });
  page = context.pages()[0] ?? (await context.newPage());
  const controller = BrowserController.fromHarnessPage(page);
  vi.spyOn(lifecycle, "sessionForCall").mockReturnValue({ browser: controller } as Session);
});

afterAll(async () => {
  vi.restoreAllMocks();
  await context?.close();
  if (profile !== undefined) await rm(profile, { recursive: true, force: true });
});

it.each([
  ["presentation with aria-modal", 'role="presentation" aria-modal="true"'],
  ["unmarked covering layer", ""],
])("copies a generated key from a %s in Chrome", async (_name, attributes) => {
  const key =
    "fixture_Ab9Cd8Ef7Gh6Jk5Lm4Np3Qr2St1Uv0Wx9Yz8Ab7Cd6Ef5Gh4Jk3Lm2Np" +
    (attributes.length > 0 ? "1" : "2");
  await context.clearPermissions();
  const html = `<!doctype html><style>
    body { margin: 0; }
    #background { position: absolute; top: 45%; left: 45%; }
    #cover { position: fixed; inset: 0; background: rgba(0,0,0,.4); display: grid; place-items: center; }
    #card { background: white; padding: 24px; }
    #value::after { content: attr(data-key); }
  </style>
  <button id="background">API key settings</button>
  <div id="cover"><section id="card" ${attributes}>
    <h2>API key generated</h2><div>Key: ********-****-****</div>
    <span id="value" data-key="${key}" style="display:none"></span>
    <button type="button" data-testid="clipboard-action" aria-label="Copy API key">Copy</button>
    <button type="button">Close</button>
  </section></div>
  <script>document.querySelector('[data-testid="clipboard-action"]')
    .addEventListener('click', () => navigator.clipboard.writeText('${key}'));</script>`;
  await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto("http://127.0.0.1/");
  const before = await page.evaluate(
    async () =>
      (await navigator.permissions.query({ name: "clipboard-read" as PermissionName })).state,
  );
  expect(before).not.toBe("granted");

  const result = await extractCredentials("fixture-session");
  expect(result.credentials.api_key).toBe(key);
  expect(
    await page.evaluate(
      async () =>
        (await navigator.permissions.query({ name: "clipboard-read" as PermissionName })).state,
    ),
  ).toBe("granted");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(key);
});
