import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { chromium, type Page } from "playwright";
import type { ExpectedEndState } from "./types.js";

export interface ColdDriverResult {
  turns: number;
  tokens: number;
  end_state: ExpectedEndState;
}

export interface LiveCheckoutResult extends ColdDriverResult {
  wall_clock_ms: number;
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
  drive: (page: Page) => Promise<ColdDriverResult>,
): Promise<LiveCheckoutResult> {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext();
  const page = await context.newPage();
  const started = performance.now();
  try {
    await page.goto("https://whitejade.xyz", {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    const result = await drive(page);
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
