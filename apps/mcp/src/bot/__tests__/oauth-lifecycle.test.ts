// Real-browser regression for the operator OAuth lifecycle. The provider popup
// intentionally redirects to a token-exchange page and then closes itself,
// which is the normal OAuth return shape that previously left the controller
// holding a detached Playwright Page. No external provider or credentials are
// involved: the fixture drives the same popup/redirect/close lifecycle locally.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { BrowserController } from "../browser.js";
import {
  act,
  finishProvisionSession,
  observe,
  startHarnessProvisionSession,
} from "../provision-session.js";

const PRODUCT_URL = `data:text/html,${encodeURIComponent(`
  <!doctype html>
  <main id="state">Signed out</main>
  <button id="oauth" type="button" onclick="window.open('about:blank', 'provider-oauth')">
    Login with Provider
  </button>
`)}`;

let browser: Browser;

async function controllerForProduct(): Promise<{ controller: BrowserController; product: Page }> {
  const context = await browser.newContext();
  const product = await context.newPage();
  await product.goto(PRODUCT_URL);
  const controller = BrowserController.fromHarnessPage(product);
  return { controller, product };
}

describe("BrowserController OAuth popup lifecycle", () => {
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  });

  afterAll(async () => {
    await browser?.close();
  });

  it("admits Google only from the active browser context", async () => {
    const { controller, product } = await controllerForProduct();
    const context = product.context();
    try {
      await context.addCookies([
        {
          name: "SID",
          value: "live-google-session-cookie",
          domain: ".google.com",
          path: "/",
        },
      ]);

      await expect(controller.detectSessionProviders()).resolves.toEqual(["google"]);
    } finally {
      await context.close().catch(() => undefined);
    }
  });

  it("refuses an active context without a provider session", async () => {
    const { controller, product } = await controllerForProduct();
    const context = product.context();
    try {
      await expect(controller.detectSessionProviders()).resolves.toEqual([]);
    } finally {
      await context.close().catch(() => undefined);
    }
  });

  it("reattaches the active controller page when a provider closes its OAuth-return popup", async () => {
    const { controller, product } = await controllerForProduct();
    const context = product.context();
    let sessionId: string | null = null;
    try {
      const started = await startHarnessProvisionSession({
        browser: controller,
        serviceUrl: PRODUCT_URL,
      });
      sessionId = started.session_id;
      await controller.startOAuth("#oauth");
      const popup = (controller as unknown as { page: Page }).page;
      expect(popup).not.toBe(product);

      await popup.goto("data:text/html,provider-token-exchange");
      await popup.close();
      const transition = await observe(sessionId);

      expect(product.isClosed()).toBe(false);
      expect(context.pages()).toContain(product);
      expect((controller as unknown as { page: Page }).page).toBe(product);
      expect(transition.oauth).toMatchObject({
        state: "in_progress",
        provider_page: "closed_or_detached",
        next_action: "operate_observe",
      });
      expect(JSON.stringify(transition)).not.toContain(
        "Target page, context or browser has been closed",
      );
      const recovered = await observe(sessionId);
      expect(recovered.text).toContain("Signed out");
    } finally {
      if (sessionId !== null) await finishProvisionSession(sessionId).catch(() => undefined);
      await context.close().catch(() => undefined);
    }
  });

  it("keeps the operator product tab alive when the provider redirects then closes its popup", async () => {
    const { controller, product } = await controllerForProduct();
    const context = product.context();
    const providerReturned = product.waitForEvent("popup").then(async (popup) => {
      await popup.goto("data:text/html,provider-token-exchange");
      await product.locator("#state").evaluate((el) => {
        el.textContent = "Signed in";
      });
      await popup.close();
    });

    let sessionId: string | null = null;
    try {
      const started = await startHarnessProvisionSession({
        browser: controller,
        serviceUrl: PRODUCT_URL,
      });
      sessionId = started.session_id;
      const [result] = await Promise.all([
        act(sessionId, { kind: "oauth_login", target: "Login with Provider" }),
        providerReturned,
      ]);

      expect(product.isClosed()).toBe(false);
      expect((controller as unknown as { page: Page }).page).toBe(product);
      expect(controller.currentUrl()).toBe(PRODUCT_URL);
      expect(result.text).toContain("Signed in");
    } finally {
      if (sessionId !== null) await finishProvisionSession(sessionId).catch(() => undefined);
      await context.close().catch(() => undefined);
    }
  }, 20_000);

  it("tracks a popup opened after a delayed provider-button dispatch", async () => {
    const context = await browser.newContext();
    const product = await context.newPage();
    const delayedProductUrl = `data:text/html,${encodeURIComponent(`
      <main id="state">Signed out</main>
      <button id="oauth" disabled onclick="window.open('about:blank', 'provider-oauth')">
        Login with Provider
      </button>
      <script>setTimeout(() => { document.querySelector('#oauth').disabled = false }, 2300)</script>
    `)}`;
    await product.goto(delayedProductUrl);
    const controller = BrowserController.fromHarnessPage(product);
    const onPage = (candidate: Page): void => {
      void (async () => {
        if ((await candidate.opener()) !== product) return;
        await candidate.goto("data:text/html,provider-token-exchange");
        await product.locator("#state").evaluate((element) => {
          element.textContent = "Signed in";
        });
        await candidate.close();
      })();
    };
    context.on("page", onPage);

    try {
      await controller.loginWithOAuth("#oauth", 6_000);
      expect(product.isClosed()).toBe(false);
      expect((controller as unknown as { page: Page }).page).toBe(product);
      expect(await controller.extractVisibleText()).toContain("Signed in");
    } finally {
      context.off("page", onPage);
      await context.close().catch(() => undefined);
    }
  });

  it("settles a legacy popup close without closing the retained product page", async () => {
    const { controller, product } = await controllerForProduct();
    const context = product.context();
    try {
      await controller.startOAuth("#oauth");
      const popup = (controller as unknown as { page: Page }).page;
      const settling = controller.settleAfterOAuth();
      await popup.close();
      await settling;

      expect(product.isClosed()).toBe(false);
      expect((controller as unknown as { page: Page }).page).toBe(product);
    } finally {
      await context.close().catch(() => undefined);
    }
  });

  it("clicks a provider-less SPA OAuth control exactly once without probing its traffic", async () => {
    const context = await browser.newContext();
    const product = await context.newPage();
    await context.route("https://product.test/login", async (route) => {
      await route.fulfill({ contentType: "text/html", body: "<main>Login</main>" });
    });
    await context.route("https://accounts.google.com/**", async (route) => {
      await route.fulfill({
        contentType: "text/html",
        body: "<script>setTimeout(() => window.close(), 20)</script>",
      });
    });
    await product.goto("https://product.test/login");
    await product.evaluate(() => {
      const button = document.createElement("button");
      button.id = "oauth";
      button.textContent = "Continue";
      button.onclick = () => {
        document.body.dataset.oauthClicks = String(
          Number(document.body.dataset.oauthClicks ?? "0") + 1,
        );
        button.disabled = true;
        window.open("https://accounts.google.com/o/oauth2/v2/auth");
      };
      document.body.append(button);
    });
    const controller = BrowserController.fromHarnessPage(product);

    try {
      await controller.loginWithOAuth("#oauth", 2_000);
      expect(await product.locator("#oauth").count()).toBe(1);
      expect(await product.locator("#oauth").isDisabled()).toBe(true);
      expect(await product.locator("body").getAttribute("data-oauth-clicks")).toBe("1");
      expect(controller.currentUrl()).toBe("https://product.test/login");
    } finally {
      await context.close().catch(() => undefined);
    }
  });

  it("selects only the sealed data-identifier account", async () => {
    const context = await browser.newContext();
    const product = await context.newPage();
    let selectedAccount: string | null = null;
    let identityAuthUser: string | null = null;
    await context.route("https://product.test/**", async (route) => {
      const callback = route.request().url().endsWith("/callback");
      await route.fulfill({
        contentType: "text/html",
        body: callback
          ? '<script>window.opener.document.querySelector("#state").textContent="Signed in"; window.close()</script>'
          : '<main id="state">Signed out</main><button id="oauth" onclick="window.open(\'https://accounts.google.com/chooser\')">Continue</button>',
      });
    });
    await context.route("https://accounts.google.com/**", async (route) => {
      const requestUrl = route.request().url();
      const consent = requestUrl.includes("/consent?");
      if (consent) selectedAccount = new URL(requestUrl).searchParams.get("account");
      await route.fulfill({
        contentType: "text/html",
        body: consent
          ? "<button onclick=\"location.href='https://product.test/callback'\">Continue</button>"
          : `<button data-identifier="other@example.com" onclick="location.href='https://accounts.google.com/consent?account=other@example.com&amp;scope=openid'">other@example.com</button>
             <button data-identifier="worker@example.com" onclick="location.href='https://accounts.google.com/consent?account=worker@example.com&amp;scope=openid'">worker@example.com</button>`,
      });
    });
    await context.route("https://myaccount.google.com/**", async (route) => {
      identityAuthUser = new URL(route.request().url()).searchParams.get("authuser");
      await route.fulfill({
        contentType: "text/html",
        body: `<button aria-label="Google Account: Selected (${identityAuthUser ?? "default@example.com"})"></button>`,
      });
    });
    await product.goto("https://product.test/login");
    const controller = BrowserController.fromHarnessPage(product);

    try {
      await controller.loginWithOAuth("#oauth", 5_000, "google", "worker@example.com");
      await expect(product.locator("#state").textContent()).resolves.toBe("Signed in");
      expect(selectedAccount).toBe("worker@example.com");
      await expect(controller.detectGoogleAccountEmail("worker@example.com")).resolves.toBe(
        "worker@example.com",
      );
      expect(identityAuthUser).toBe("worker@example.com");
      expect(controller.currentUrl()).toBe("https://product.test/login");
    } finally {
      await context.close().catch(() => undefined);
    }
  });

  it("selects a sole Google account tile when session email metadata is unavailable", async () => {
    const context = await browser.newContext();
    const product = await context.newPage();
    let selectedAccount: string | null = null;
    await context.route("https://product.test/**", async (route) => {
      const callback = route.request().url().endsWith("/callback");
      await route.fulfill({
        contentType: "text/html",
        body: callback
          ? '<script>window.opener.document.querySelector("#state").textContent="Signed in"; window.close()</script>'
          : '<main id="state">Signed out</main><button id="oauth" onclick="window.open(\'https://accounts.google.com/v3/signin/accountchooser\')">Continue</button>',
      });
    });
    await context.route("https://accounts.google.com/**", async (route) => {
      const requestUrl = route.request().url();
      const consent = requestUrl.includes("/consent?");
      if (consent) selectedAccount = new URL(requestUrl).searchParams.get("account");
      await route.fulfill({
        contentType: "text/html",
        body: consent
          ? "<button onclick=\"location.href='https://product.test/callback'\">Continue</button>"
          : '<button data-identifier="only@example.com" onclick="location.href=\'https://accounts.google.com/consent?account=only@example.com&amp;scope=openid\'">only@example.com</button>',
      });
    });
    await product.goto("https://product.test/login");
    const controller = BrowserController.fromHarnessPage(product);

    try {
      await controller.loginWithOAuth("#oauth", 5_000, "google");
      await expect(product.locator("#state").textContent()).resolves.toBe("Signed in");
      expect(selectedAccount).toBe("only@example.com");
      expect(controller.currentUrl()).toBe("https://product.test/login");
    } finally {
      await context.close().catch(() => undefined);
    }
  });

  it("selects only the sealed Google account row without data-identifier", async () => {
    const context = await browser.newContext();
    const product = await context.newPage();
    let selectedAccount: string | null = null;
    await context.route("https://product.test/**", async (route) => {
      const callback = route.request().url().endsWith("/callback");
      await route.fulfill({
        contentType: "text/html",
        body: callback
          ? '<script>window.opener.document.querySelector("#state").textContent="Signed in"; window.close()</script>'
          : '<main id="state">Signed out</main><button id="oauth" onclick="window.open(\'https://accounts.google.com/v3/signin/accountchooser\')">Continue</button>',
      });
    });
    await context.route("https://accounts.google.com/**", async (route) => {
      const requestUrl = route.request().url();
      const consent = requestUrl.includes("/consent?");
      if (consent) selectedAccount = new URL(requestUrl).searchParams.get("account");
      await route.fulfill({
        contentType: "text/html",
        body: consent
          ? "<button onclick=\"location.href='https://product.test/callback'\">Continue</button>"
          : `<button onclick="location.href='https://accounts.google.com/consent?account=other@example.com&amp;scope=openid'">
               <span>Other User</span><span>other@example.com</span>
             </button>
             <button onclick="location.href='https://accounts.google.com/consent?account=worker@example.com&amp;scope=openid'">
               <span>Example User</span><span>worker@example.com</span>
             </button>
             <button>Use another account</button>`,
      });
    });
    await product.goto("https://product.test/login");
    const controller = BrowserController.fromHarnessPage(product);

    try {
      await controller.loginWithOAuth("#oauth", 5_000, "google", "worker@example.com");
      await expect(product.locator("#state").textContent()).resolves.toBe("Signed in");
      expect(selectedAccount).toBe("worker@example.com");
      expect(controller.currentUrl()).toBe("https://product.test/login");
    } finally {
      await context.close().catch(() => undefined);
    }
  });

  it("does not dispatch a DOM fallback click after its consent budget expires", async () => {
    const context = await browser.newContext();
    const product = await context.newPage();
    await product.setContent(`
      <a id="consent" href="#approved">Continue</a>
      <script>
        const consent = document.querySelector("#consent");
        consent.addEventListener("click", (event) => {
          event.preventDefault();
          document.body.dataset.consentClicks = String(
            Number(document.body.dataset.consentClicks || "0") + 1
          );
        });
        consent.getBoundingClientRect = () => {
          const end = Date.now() + 30;
          while (Date.now() < end) {}
          return { x: 0, y: 0, top: 0, left: 0, right: 100, bottom: 30, width: 100, height: 30 };
        };
      </script>
    `);
    const controller = BrowserController.fromHarnessPage(product);

    try {
      await expect(controller.advanceOAuthConsent("google", 5)).resolves.toBe(false);
      await expect(product.locator("body").getAttribute("data-consent-clicks")).resolves.toBeNull();
    } finally {
      await context.close().catch(() => undefined);
    }
  });

  it("returns a re-login result when Google never reaches its OAuth completion signal", async () => {
    const context = await browser.newContext();
    const product = await context.newPage();
    await context.route("https://product.test/**", async (route) => {
      await route.fulfill({
        contentType: "text/html",
        body: '<button id="oauth" onclick="window.open(\'https://accounts.google.com/provider\')">Continue</button>',
      });
    });
    await context.route("https://accounts.google.com/**", async (route) => {
      await route.fulfill({
        contentType: "text/html",
        body: "<main>Provider did not settle</main>",
      });
    });
    await product.goto("https://product.test/login");
    const controller = BrowserController.fromHarnessPage(product);
    const startedAt = Date.now();

    try {
      const rejected = controller.loginWithOAuth("#oauth", 1_000, "google");
      await expect(rejected).rejects.toMatchObject({
        code: "google_session",
        message: expect.stringMatching(/session may have expired.*re-login/i),
      });
      expect(Date.now() - startedAt).toBeLessThan(5_000);
    } finally {
      await context.close().catch(() => undefined);
    }
  });

  it("waits for a same-tab provider round trip to return and settle", async () => {
    const context = await browser.newContext();
    const product = await context.newPage();
    const productUrl = "https://product.test/login";
    await context.route("https://product.test/**", async (route) => {
      const callback = route.request().url().endsWith("/callback");
      await route.fulfill({
        contentType: "text/html",
        body: callback
          ? "<main>Signed in</main>"
          : '<button id="oauth" onclick="location.href=\'https://provider.test/oauth\'">Login with Provider</button>',
      });
    });
    await context.route("https://provider.test/oauth", async (route) => {
      await route.fulfill({
        contentType: "text/html",
        body: '<script>setTimeout(() => location.href="https://product.test/callback", 20)</script>',
      });
    });
    await product.goto(productUrl);
    const controller = BrowserController.fromHarnessPage(product);

    try {
      await controller.loginWithOAuth("#oauth", 3_000);
      expect(product.isClosed()).toBe(false);
      expect(controller.currentUrl()).toBe("https://product.test/callback");
      expect(await controller.extractVisibleText()).toContain("Signed in");
    } finally {
      await context.close().catch(() => undefined);
    }
  });
});
