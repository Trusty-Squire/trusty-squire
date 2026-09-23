import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { BrowserController } from "../../browser.js";
import * as lifecycle from "../../session/lifecycle.js";
import * as provisionSession from "../../provision-session.js";
import type { Session } from "../../session/model.js";
import type { ApiClient } from "../../../api-client.js";
import { provisionExtractTool } from "../../../tools/provision-drive.js";

const key = "nqx_" + "Ab3dE7fG9hJ2kL4mN6pQ8rS1tU5vW7xY9zB2cD4eF6gH8j";
const bareKey = "a9B2c3D4e5F6g7H8i9J0".repeat(2);

let browser: Browser;
let page: Page;
let controller: BrowserController;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  page = await browser.newPage();
  controller = BrowserController.fromHarnessPage(page);
  vi.spyOn(lifecycle, "sessionForCall").mockReturnValue({
    browser: controller,
  } as Session);
  vi.spyOn(provisionSession, "observedHostsForSession").mockReturnValue([]);
});

afterAll(async () => {
  vi.restoreAllMocks();
  await browser?.close();
});

afterEach(async () => {
  await page.unrouteAll({ behavior: "wait" });
});

it("stores the visible new key from a table notice while older truncated rows stay masked", async () => {
  expect(key).toHaveLength(50);
  const html = `<!doctype html><meta charset="utf-8"><style>
    body { font-family: sans-serif; }
    .spacer { height: 460px; }
    table { width: 1080px; border-collapse: collapse; }
    td { padding: 12px; border-bottom: 1px solid #ddd; }
  </style>
  <h1>API Keys</h1><div class="spacer"></div>
  <table><tbody>
    <tr><td>
      <div>Make sure to copy your Personal API Key now because you will not be able to see this again after refreshing the page.</div>
      <p class="body-sm-regular line-clamp-1 flex-1 break-all text">${key}</p>
    </td></tr>
    <tr><td><p>nqx_6l…</p></td></tr>
    <tr><td><p>nqx_nb…</p></td></tr>
  </tbody></table>`;
  await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto("http://127.0.0.1/");

  const candidates = await controller.extractLabeledCredentialCandidates(page);
  expect(candidates).toContainEqual(
    expect.objectContaining({ value: key, label: null, isMasked: false }),
  );
  expect(candidates).toContainEqual(
    expect.objectContaining({ value: "nqx_6l…", isMasked: true }),
  );
  expect(candidates).toContainEqual(
    expect.objectContaining({ value: "nqx_nb…", isMasked: true }),
  );

  const storeCredential = vi.fn().mockResolvedValue({
    reference: "vault://fixture/new-key",
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
    stored_credential: { reference: "vault://fixture/new-key" },
    masked_remaining: ["masked credential"],
  });
  expect(JSON.stringify(storeCredential.mock.calls)).not.toContain("…");
});

it("stores a visible separatorless key from a text input without a copy notice", async () => {
  expect(bareKey).toHaveLength(40);
  const html = `<!doctype html><meta charset="utf-8"><style>
    input { width: 400px; height: 32px; }
  </style>
  <main>
    <h1>API Key</h1>
    <label>API Key <input type="text" value="${bareKey}"></label>
    <section><div>Previous API Key</div><p>••••••••</p></section>
  </main>`;
  await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto("http://127.0.0.1/");

  const candidates = await controller.extractLabeledCredentialCandidates(page);
  expect(candidates).toContainEqual(
    expect.objectContaining({ value: bareKey, isMasked: false }),
  );
  expect(candidates).toContainEqual(
    expect.objectContaining({ value: "••••••••", isMasked: true }),
  );

  const storeCredential = vi.fn().mockResolvedValue({
    reference: "vault://fixture/input-key",
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
  expect(storeCredential).toHaveBeenCalledWith(expect.objectContaining({ value: bareKey }));
  expect(result).toMatchObject({
    stored_credential: { reference: "vault://fixture/input-key" },
  });
  expect(JSON.stringify(storeCredential.mock.calls)).not.toContain("•");
});

it("does not choose arbitrarily between two full visible tokens", async () => {
  const otherKey = "Z8Y7x6W5v4U3t2S1r0Q9".repeat(2);
  await page.route("**/*", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><p>${bareKey}</p><p>${otherKey}</p>`,
    }),
  );
  await page.goto("http://127.0.0.1/");

  const storeCredential = vi.fn();
  const result = await provisionExtractTool.handler(
    { session_id: "fixture-session", store: { service: "fixture" } },
    { storeCredential } as unknown as ApiClient,
  );
  expect(storeCredential).not.toHaveBeenCalled();
  expect(result).toMatchObject({ credentials: {}, candidate_count: 2 });
});
