import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { BrowserController } from "../../browser.js";
import * as lifecycle from "../../session/lifecycle.js";
import * as provisionSession from "../../provision-session.js";
import type { Session } from "../../session/model.js";
import type { ApiClient } from "../../../api-client.js";
import { provisionExtractTool } from "../../../tools/provision-drive.js";
import { extractCredentials } from "../capture.js";

const key = "fixture_" + "Ab9Cd8Ef7Gh6Jk5Lm4Np3Qr2St1Uv0Wx9Yz8Ab7Cd6Ef5Gh4Jk3Lm2Np1Qr0";
const mask = "********-****-****-****-************";

let browser: Browser;
let context: BrowserContext;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await context?.close();
});

afterAll(async () => {
  await browser?.close();
});

async function openDialog(copyWritesKey: boolean): Promise<void> {
  context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  page = await context.newPage();
  const html = `<!doctype html><style>
    .field { display: flex; align-items: center; position: relative; width: 190px; overflow: hidden; }
    .value { position: absolute; left: 0; top: 0; pointer-events: none; font-family: monospace; white-space: nowrap; }
    .value::after { content: attr(data-value); }
    .masked .value { display: none; }
    .revealed .mask { opacity: 0; }
    button { flex: none; }
  </style>
  <section role="dialog" aria-label="API key generated">
    <h2>API key generated</h2>
    <div>Key</div>
    <div class="field masked" id="field">
      <span class="mask">${mask}</span>
      <span class="value" data-value="${key}"></span>
      <button type="button" id="eye"><svg width="16" height="16"><circle cx="8" cy="8" r="4"/></svg></button>
      <button type="button" data-testid="clipboard-action"><svg width="16" height="16"><rect width="12" height="12"/></svg></button>
    </div>
    <button type="button">Close</button>
  </section>
  <script>
    document.querySelector('#eye').addEventListener('click', () => {
      document.querySelector('#field').classList.toggle('masked');
      document.querySelector('#field').classList.toggle('revealed');
    });
    ${copyWritesKey ? `document.querySelector('[data-testid="clipboard-action"]').addEventListener('click', () => navigator.clipboard.writeText('${key}'));` : ""}
  </script>`;
  await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto("http://127.0.0.1/");
  const controller = BrowserController.fromHarnessPage(page);
  vi.spyOn(lifecycle, "sessionForCall").mockReturnValue({
    browser: controller,
  } as Session);
}

it("captures the full key after an unlabeled eye reveals a visually clipped field", async () => {
  await openDialog(true);
  await page.locator("#eye").click();
  expect(await page.evaluate(() => Boolean(navigator.clipboard))).toBe(true);
  expect(
    await page.locator(".value").evaluate((el) => getComputedStyle(el, "::after").content),
  ).toContain(key);

  vi.spyOn(provisionSession, "observedHostsForSession").mockReturnValue([]);
  const storeCredential = vi.fn().mockResolvedValue({
    reference: "vault://fixture/created-key",
    service: "fixture",
    label: undefined,
    field_names: ["api_key"],
    allowed_hosts: [],
    updated: false,
  });
  const result = await provisionExtractTool.handler(
    { session_id: "fixture-session", store: { service: "fixture" } },
    { storeCredential } as unknown as ApiClient,
  );
  expect(storeCredential).toHaveBeenCalledWith(expect.objectContaining({ value: key }));
  expect(result).toMatchObject({
    candidate_count: 1,
    stored_credential: { reference: "vault://fixture/created-key" },
  });
  expect(result).not.toHaveProperty("masked_remaining");
});

it("keeps a genuinely unread value masked", async () => {
  await openDialog(false);
  const extracted = await extractCredentials("fixture-session");
  expect(extracted.credentials.api_key).toBeUndefined();
  expect(extracted.masked_remaining?.length).toBeGreaterThan(0);
});
