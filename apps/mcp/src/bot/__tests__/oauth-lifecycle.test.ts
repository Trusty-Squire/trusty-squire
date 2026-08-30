// Real-browser regression for the operator OAuth lifecycle. The provider popup
// intentionally redirects to a token-exchange page and then closes itself,
// which is the normal OAuth return shape that previously left the controller
// holding a detached Playwright Page. No external provider or credentials are
// involved: the fixture drives the same popup/redirect/close lifecycle locally.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { BrowserController } from "../browser.js";
import { classifyOAuthProviderDestination } from "../oauth-destination.js";
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

  it.each([
    "https://tenant.auth0.com/authorize",
    "https://tenant.okta.com/oauth2/default/v1/authorize",
  ])("keeps generic broker destination %s unresolved", (destination) => {
    expect(
      classifyOAuthProviderDestination(destination, "https://product.test/login"),
    ).toBeNull();
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

  it.each([
    ["google", "https://accounts.google.com/o/oauth2/v2/auth"],
    ["other", "https://login.microsoftonline.com/common/oauth2/v2.0/authorize"],
  ] as const)("resolves a provider-less JavaScript OAuth control as %s", async (expected, url) => {
    const context = await browser.newContext();
    const product = await context.newPage();
    await context.route("https://product.test/login", async (route) => {
      await route.fulfill({
        contentType: "text/html",
        body: `<button id="oauth" onclick="window.open('${url}')">Continue</button>`,
      });
    });
    await context.route("https://accounts.google.com/**", async (route) => {
      await route.fulfill({ contentType: "text/html", body: "Google OAuth" });
    });
    await context.route("https://login.microsoftonline.com/**", async (route) => {
      await route.fulfill({ contentType: "text/html", body: "Microsoft OAuth" });
    });
    await product.goto("https://product.test/login");
    const controller = BrowserController.fromHarnessPage(product);

    try {
      await expect(controller.detectOAuthProviderDestination("#oauth", 2_000)).resolves.toBe(
        expected,
      );
      expect(controller.currentUrl()).toBe("https://product.test/login");
    } finally {
      await context.close().catch(() => undefined);
    }
  });

  it("resolves a provider from a control that exists only in live SPA state", async () => {
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
      await expect(controller.detectOAuthProviderDestination("#oauth", 2_000)).resolves.toBe(
        "google",
      );
      await controller.loginWithOAuth("#oauth", 2_000);
      await expect(product.locator("#oauth")).toHaveCount(1);
      await expect(product.locator("#oauth")).toBeDisabled();
      await expect(product.locator("body")).toHaveAttribute("data-oauth-clicks", "1");
      expect(controller.currentUrl()).toBe("https://product.test/login");
    } finally {
      await context.close().catch(() => undefined);
    }
  });

  it("resolves a same-origin GitHub route without entering Google", async () => {
    const context = await browser.newContext();
    const product = await context.newPage();
    await context.route("https://product.test/login", async (route) => {
      await route.fulfill({
        contentType: "text/html",
        body: '<form action="/oauth/github"><button id="oauth">Continue</button></form>',
      });
    });
    await product.goto("https://product.test/login");
    const controller = BrowserController.fromHarnessPage(product);

    try {
      await expect(controller.detectOAuthProviderDestination("#oauth", 2_000)).resolves.toBe(
        "github",
      );
      expect(controller.currentUrl()).toBe("https://product.test/login");
    } finally {
      await context.close().catch(() => undefined);
    }
  });

  it("keeps a generic Auth0 broker unresolved until Google identity is restored", async () => {
    const context = await browser.newContext();
    const product = await context.newPage();
    await context.route("https://product.test/**", async (route) => {
      await route.fulfill({
        contentType: "text/html",
        body:
          route.request().url() === "https://product.test/login"
            ? '<button id="oauth" onclick="window.open(\'https://tenant.auth0.com/authorize\')">Continue</button><output id="clicks">0</output><script>document.querySelector("#oauth").addEventListener("click", () => document.querySelector("#clicks").textContent = String(Number(document.querySelector("#clicks").textContent) + 1))</script>'
            : "<main>Signed in</main>",
      });
    });
    await context.route("https://tenant.auth0.com/authorize", async (route) => {
      await route.fulfill({
        contentType: "text/html",
        body: '<script>setTimeout(() => location.href="https://accounts.google.com/o/oauth2/auth", 100)</script>',
      });
    });
    await context.route("https://accounts.google.com/**", async (route) => {
      await route.fulfill({
        contentType: "text/html",
        body: '<script>setTimeout(() => window.close(), 20)</script>',
      });
    });
    await product.goto("https://product.test/login");
    const controller = BrowserController.fromHarnessPage(product);

    try {
      await expect(controller.detectOAuthProviderDestination("#oauth", 30)).resolves.toBeNull();
      await expect(
        controller.waitForPendingOAuthProviderDestination("#oauth", 2_000),
      ).resolves.toBe("google");
      await controller.loginWithOAuth("#oauth", 2_000, "google");
      await expect(product.locator("#clicks").textContent()).resolves.toBe("1");
      expect(controller.currentUrl()).toBe("https://product.test/login");
    } finally {
      await context.close().catch(() => undefined);
    }
  });

  it("ignores provider-shaped subresources while observing OAuth navigation", async () => {
    const context = await browser.newContext();
    const product = await context.newPage();
    await context.route("https://product.test/login", async (route) => {
      await route.fulfill({
        contentType: "text/html",
        body: `<button id="oauth">Continue</button>
          <script>
            document.querySelector("#oauth").addEventListener("click", () => {
              void fetch("https://accounts.google.com/oauth-preload");
              setTimeout(() => {
                window.open("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
              }, 50);
            });
          </script>`,
      });
    });
    await context.route("https://accounts.google.com/**", async (route) => {
      await route.fulfill({ body: "preloaded" });
    });
    await context.route("https://login.microsoftonline.com/**", async (route) => {
      await route.fulfill({ contentType: "text/html", body: "Microsoft OAuth" });
    });
    await product.goto("https://product.test/login");
    const controller = BrowserController.fromHarnessPage(product);

    try {
      await expect(controller.detectOAuthProviderDestination("#oauth", 2_000)).resolves.toBe(
        "other",
      );
      expect(controller.currentUrl()).toBe("https://product.test/login");
    } finally {
      await context.close().catch(() => undefined);
    }
  });

  it("completes Google account choice and consent inside one OAuth operation", async () => {
    const context = await browser.newContext();
    const product = await context.newPage();
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
      const consent = route.request().url().includes("/consent?");
      await route.fulfill({
        contentType: "text/html",
        body: consent
          ? '<button onclick="location.href=\'https://product.test/callback\'">Continue</button>'
          : '<button data-identifier="worker@example.com" onclick="location.href=\'https://accounts.google.com/consent?scope=openid%20email%20profile\'">worker@example.com</button>',
      });
    });
    await product.goto("https://product.test/login");
    const controller = BrowserController.fromHarnessPage(product);

    try {
      await controller.loginWithOAuth("#oauth", 5_000, "google");
      await expect(product.locator("#state").textContent()).resolves.toBe("Signed in");
      expect(controller.currentUrl()).toBe("https://product.test/login");
    } finally {
      await context.close().catch(() => undefined);
    }
  });

  it.each([
    "https://accounts.google.com/consent",
    "https://accounts.google.com/consent?scope=openid%20https://www.googleapis.com/auth/gmail.readonly",
  ])("never auto-approves unverified Google consent at %s", async (consentUrl) => {
    const context = await browser.newContext();
    const product = await context.newPage();
    let callbackRequests = 0;
    await context.route("https://product.test/**", async (route) => {
      if (route.request().url().endsWith("/callback")) callbackRequests += 1;
      await route.fulfill({
        contentType: "text/html",
        body: '<main id="state">Signed out</main><button id="oauth" onclick="window.open(\'' +
          consentUrl +
          "')\">Continue</button>",
      });
    });
    await context.route("https://accounts.google.com/**", async (route) => {
      await route.fulfill({
        contentType: "text/html",
        body: '<button onclick="location.href=\'https://product.test/callback\'">Continue</button>',
      });
    });
    await product.goto("https://product.test/login");
    const controller = BrowserController.fromHarnessPage(product);

    try {
      await expect(controller.loginWithOAuth("#oauth", 500, "google")).rejects.toThrow(
        "still awaiting the provider",
      );
      await expect(product.locator("#state").textContent()).resolves.toBe("Signed out");
      expect(callbackRequests).toBe(0);
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
