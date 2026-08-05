import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { chromium, type Page } from "playwright";
import { endStatesMatch } from "./corpus.js";
import type { ExpectedEndState, ShoppingTaskRecord } from "./types.js";

export interface ColdDriverResult {
  turns: number;
  tokens: number;
  end_state: ExpectedEndState;
}

export interface LiveCheckoutResult extends ColdDriverResult {
  wall_clock_ms: number;
}

export function assertLiveCheckoutEndState(
  task: ShoppingTaskRecord,
  actual: ExpectedEndState,
): void {
  if (!endStatesMatch(actual, task.expected_end_state)) {
    throw new Error(`${task.task_id}: live checkout did not reach its expected end state`);
  }
}

export function whitejadeCartPermalink(task: ShoppingTaskRecord): string {
  if (task.domain !== "whitejade.xyz" || task.params.product_variant_id === undefined) {
    throw new Error(`${task.task_id}: live checkout requires a whitejade product variant`);
  }
  return `https://whitejade.xyz/cart/${encodeURIComponent(task.params.product_variant_id)}:1`;
}

function assertStableHarEntry(entryUrl: string): void {
  const pathname = new URL(entryUrl).pathname.toLowerCase();
  if (pathname === "/cart" || pathname.startsWith("/cart/") || pathname.startsWith("/checkout")) {
    throw new Error("checkout/cart pages are live-only and must never be written to a HAR");
  }
}

// Small live-seed helper. It records the navigation response through
// Playwright's native HAR writer while aborting non-document resources; the
// frozen replay runs with JavaScript disabled and the same missing-request
// policy, so a seed stays compact without a custom VCR layer.
export async function recordFrozenDocumentHar(entryUrl: string, harPath: string): Promise<string> {
  assertStableHarEntry(entryUrl);
  mkdirSync(dirname(harPath), { recursive: true });
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({
    javaScriptEnabled: false,
    recordHar: {
      path: harPath,
      content: "embed",
      mode: "minimal",
      urlFilter: entryUrl,
    },
  });
  await context.route("**/*", async (route) => {
    if (route.request().resourceType() === "document") await route.continue();
    else await route.abort();
  });
  const page = await context.newPage();
  try {
    await page.goto(entryUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    return page.url();
  } finally {
    await context.close();
    await browser.close();
  }
}

// Checkout is deliberately live-only. Shopify checkout URLs are session-keyed,
// so this path has no recordHar and installs no HAR route (especially no
// notFound="abort"). The supplied driver is the existing guarded operator/LLM
// path; the harness only measures it and checks its returned end state.
export async function runLiveWhitejadeCheckout(
  task: ShoppingTaskRecord,
  drive: (page: Page) => Promise<ColdDriverResult>,
): Promise<LiveCheckoutResult> {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext();
  const page = await context.newPage();
  const started = performance.now();
  try {
    await page.goto(whitejadeCartPermalink(task), {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    if (!new URL(page.url()).pathname.startsWith("/checkouts/")) {
      throw new Error(`${task.task_id}: whitejade did not enter live checkout`);
    }
    const result = await drive(page);
    assertLiveCheckoutEndState(task, result.end_state);
    return {
      ...result,
      wall_clock_ms: Math.round(performance.now() - started),
    };
  } finally {
    await context.close();
    await browser.close();
  }
}

export async function replayFrozenHar<T>(
  entryUrl: string,
  harPath: string,
  observe: (page: Page) => Promise<T>,
): Promise<T> {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.routeFromHAR(harPath, { update: false, notFound: "abort" });
  try {
    await page.goto(entryUrl, { waitUntil: "domcontentloaded" });
    return await observe(page);
  } finally {
    await context.close();
    await browser.close();
  }
}
