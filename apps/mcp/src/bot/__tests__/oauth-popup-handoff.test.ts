import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { BrowserController } from "../browser.js";
import { loginWithOAuth } from "../oauth-login.js";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
});
afterAll(async () => {
  await browser?.close();
});

it("follows a popup when its opener also navigates during the identity handoff", async () => {
  const context = await browser.newContext();
  const product = await context.newPage();
  const productOrigin = "https://product.test";
  const providerOrigin = "https://accounts.google.com";
  const returnUrl = `${productOrigin}/callback`;
  const providerUrl = `${providerOrigin}/v3/signin/accountchooser?redirect_uri=${encodeURIComponent(returnUrl)}`;
  let selectedAccount: string | null = null;
  await context.route(`${productOrigin}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    await route.fulfill({
      contentType: "text/html",
      body:
        path === "/callback"
          ? `<main id="state">Signed in</main><script>if (window.opener) { window.opener.location.href="${productOrigin}/dashboard"; window.close() }</script>`
          : path === "/dashboard"
            ? '<main id="state">Signed in</main>'
            : `<main id="state">Signed out</main><button id="oauth" onclick="window.open('${providerUrl}'); location.assign('/signin?refresh=1')">Connect identity</button>`,
    });
  });
  await context.route(`${providerOrigin}/**`, async (route) => {
    const requestUrl = route.request().url();
    const consent = requestUrl.includes("/consent?");
    if (!consent) await new Promise((resolve) => setTimeout(resolve, 150));
    if (consent) selectedAccount = new URL(requestUrl).searchParams.get("account");
    await route.fulfill({
      contentType: "text/html",
      body: consent
        ? `<button onclick="location.href='${returnUrl}'">Continue</button>`
        : `<button data-identifier="worker@example.com" onclick="location.href='${providerOrigin}/consent?account=worker@example.com'">worker@example.com</button>`,
    });
  });
  await product.goto(`${productOrigin}/signin`);
  const controller = BrowserController.fromHarnessPage(product);
  try {
    await loginWithOAuth(controller, "#oauth", 5_000, "google", "worker@example.com");
    expect(selectedAccount).toBe("worker@example.com");
    await expect(product.locator("#state").textContent()).resolves.toBe("Signed in");
    expect(controller.page).toBe(product);
  } finally {
    await context.close();
  }
}, 15_000);
