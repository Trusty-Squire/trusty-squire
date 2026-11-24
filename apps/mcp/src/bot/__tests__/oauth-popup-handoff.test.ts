import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { chromium, type Browser } from "playwright";
import { BrowserController } from "../browser.js";
import { loginWithOAuth } from "../oauth-login.js";
import {
  act,
  finishProvisionSession,
  observe,
  preparePublicOAuthLoginTarget,
  startHarnessProvisionSession,
  withPreparedOAuthLoginTarget,
} from "../provision-session.js";
import { operateLoginTool } from "../../tools/provision-drive.js";

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

it.each(["popup", "tab"])(
  "continues on the signed-in opener after a Google %s posts back and closes",
  async (transport) => {
    const context = await browser.newContext();
    const product = await context.newPage();
    const productUrl = "https://product.test/login";
    const chooserUrl = "https://accounts.google.com/v3/signin/accountchooser";
    const consentUrl = "https://accounts.google.com/signin/oauth/consent";
    const relayUrl = "https://product.test/popup-relay";
    const postSignIn =
      "window.opener.postMessage('fixture-signed-in', 'https://product.test'); window.close()";
    const messageOrigin =
      transport === "popup" ? new URL(consentUrl).origin : new URL(relayUrl).origin;
    let sessionId: string | undefined;
    vi.stubEnv("TRUSTY_SQUIRE_OAUTH_ACTION_TIMEOUT_MS", "6000");
    vi.stubEnv("TRUSTY_SQUIRE_OAUTH_LOGIN_COOLDOWN_MS", "0");
    try {
      await context.route("https://myaccount.google.com/**", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: '<button aria-label="Google Account: Operator (operator@example.com)"></button>',
        }),
      );
      await context.route(productUrl, (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `
            <main>Signed out</main>
            <button id="sign-in" onclick="window.open('${chooserUrl}', '_blank', '${transport === "popup" ? "popup" : ""}')">Sign in with Google</button>
            <script>
              addEventListener('message', ({origin, data}) => {
                if (origin !== '${messageOrigin}' || data !== 'fixture-signed-in') return;
                document.getElementById('sign-in').remove();
                document.querySelector('main').innerHTML = '<h1>Signed in</h1><button>Account settings</button>';
                document.querySelector('main button').onclick = () => {
                  document.querySelector('main h1').textContent = 'Settings opened';
                };
              });
            </script>`,
        }),
      );
      await context.route(chooserUrl, (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<h1>Choose an account</h1>
            <button data-identifier="operator@example.com" onclick="location.href='${consentUrl}'">operator@example.com</button>`,
        }),
      );
      await context.route(consentUrl, (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<button onclick="${transport === "popup" ? postSignIn : `location.href='${relayUrl}'`}">Continue</button>`,
        }),
      );
      await context.route(relayUrl, (route) =>
        route.fulfill({ contentType: "text/html", body: `<script>${postSignIn}</script>` }),
      );

      const controller = BrowserController.fromHarnessPage(product);
      const started = await startHarnessProvisionSession({
        browser: controller,
        serviceUrl: productUrl,
        format: "full",
      });
      sessionId = started.session_id;
      const target = started.dom?.match(/@e:[A-Za-z0-9_-]+/)?.[0];
      expect(target).toBeDefined();
      const prepared = preparePublicOAuthLoginTarget(sessionId, target!);
      expect(prepared).toBeDefined();
      const result = await withPreparedOAuthLoginTarget(prepared!, () =>
        operateLoginTool.handler(
          { action: "oauth", session_id: started.session_id, ref: target!, provider: "google" },
          null,
        ),
      );
      expect(await product.locator("main").innerText()).toContain("Signed in");
      expect(controller.page).toBe(product);
      expect(context.pages()).toEqual([product]);
      expect(result).toMatchObject({
        url: productUrl,
        dom: expect.stringContaining("Signed in"),
      });
      expect(result).not.toHaveProperty("terminal");
      const observed = await observe(sessionId, "full");
      expect(observed.dom).toContain("Account settings");
      const settings = observed.dom?.match(/@e:[A-Za-z0-9_-]+/)?.[0];
      expect(settings).toBeDefined();
      await act(sessionId, { kind: "click", target: settings! });
      expect(await product.locator("main h1").innerText()).toBe("Settings opened");
    } finally {
      if (sessionId !== undefined) await finishProvisionSession(sessionId);
      await context.close();
      vi.unstubAllEnvs();
    }
  },
  15_000,
);
