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

it("vaults a Vast-shaped hex key that only the Copy button puts on the clipboard", async () => {
  // Vast.ai's created-key dialog shows a truncated stub and writes the full
  // 64-char lowercase hex key to the clipboard; the key never enters the DOM.
  // An existing key's stub stays visible in the list behind the dialog.
  const key = "d7bd47d70c1e4f2a9b3c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f80bd4a";
  await context.clearPermissions();
  await page.evaluate(() => navigator.clipboard.writeText("")).catch(() => undefined);
  const html = `<!doctype html>
  <table><tr><th>Key</th></tr><tr><td>0a1b2c3d...9f8e</td></tr></table>
  <div role="dialog" aria-label="API key created">
    <h2>API key created</h2>
    <label>API key <input readonly value="${key.slice(0, 8)}...${key.slice(-4)}"></label>
    <button type="button" aria-label="Copy API key">Copy</button>
  </div>
  <script>document.querySelector('[aria-label="Copy API key"]')
    .addEventListener('click', () => navigator.clipboard.writeText(atob('${Buffer.from(key).toString("base64")}')));</script>`;
  await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto("http://127.0.0.1/");
  expect(await page.content()).not.toContain(key);

  const result = await extractCredentials("fixture-session");
  expect(result.credentials).toEqual({ api_key: key });
});
