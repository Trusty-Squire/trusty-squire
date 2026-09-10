import type { ApiClient } from "../../api-client.js";
// Real-browser regression for the operator OAuth lifecycle. The provider popup
// intentionally redirects to a token-exchange page and then closes itself,
// which is the normal OAuth return shape that previously left the controller
// holding a detached Playwright Page. No external provider or credentials are
// involved: the fixture drives the same popup/redirect/close lifecycle locally.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "playwright";
import { checkoutFieldSetSignature } from "@trusty-squire/recipe-schema";
import {
  BrowserController,
  OAuthAwaitingHumanError,
  OAuthFailedError,
  OAuthOnboardingRequiredError,
  oauthErrorFromReturnUrl,
} from "../browser.js";
import {
  act,
  activeProvisionBrowserForPayment,
  awaitVerification,
  cartAdd,
  cartClear,
  captureScreenshot,
  checkoutShapeSignatureForSession,
  extractCredentials,
  finishProvisionSession,
  formSelectMany,
  observe,
  parseElementsTable,
  preparePublicOAuthLoginTarget,
  replayOperatorRecipe,
  startHarnessProvisionSession,
  verifyPostcondition,
  withPreparedOAuthLoginTarget,
} from "../provision-session.js";
import type { OperatorRecipe } from "../operator-recipe.js";
import { sessionForCall } from "../session/lifecycle.js";
import { ProvenPreDispatchMutationError } from "../mutation-dispatch-evidence.js";

const PRODUCT_URL = `data:text/html,${encodeURIComponent(`
  <!doctype html>
  <main id="state">Signed out</main>
  <button id="oauth" type="button" onclick="window.open('about:blank', 'provider-oauth')">
    Login with Provider
  </button>
`)}`;

let browser: Browser;

const PAYMENT_FIXTURE_CARD = {
  pan: "4242424242424242",
  exp_month: "12",
  exp_year: "30",
  cvv: "123",
  name: "Synthetic Cardholder",
  billing: {
    line1: "123 Synthetic Street",
    city: "Testville",
    postal_code: "10001",
    country: "US",
  },
};

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

  it("returns relying-party required information without treating its Continue as provider consent", async () => {
    const context = await browser.newContext();
    const product = await context.newPage();
    const callback = "https://product.test/auth/callback";
    const provider = `https://accounts.google.com/oauth?redirect_uri=${encodeURIComponent(callback)}`;
    await context.route("**/*", async (route) => {
      const url = route.request().url();
      await route.fulfill({
        contentType: "text/html",
        body:
          url === "https://product.test/login"
            ? `<button id="oauth" onclick='location.href=${JSON.stringify(provider)}'>Google</button>`
            : url.startsWith("https://accounts.google.com/")
              ? '<script>location.href="https://product.test/required-information"</script>'
              : '<input id="name" required><button id="continue" onclick="document.body.dataset.clicked=(Number(document.body.dataset.clicked||0)+1)">Continue</button>',
      });
    });
    await product.goto("https://product.test/login");
    const controller = BrowserController.fromHarnessPage(product);
    try {
      await expect(controller.loginWithOAuth("#oauth", 1_500, "google")).rejects.toBeInstanceOf(
        OAuthOnboardingRequiredError,
      );
      expect(product.url()).toBe("https://product.test/required-information");
      expect(await product.locator("body").getAttribute("data-clicked")).toBeNull();
      await expect(controller.advanceOAuthConsent("google", 50)).resolves.toBe(false);
      expect(await product.locator("body").getAttribute("data-clicked")).toBeNull();
    } finally {
      await context.close();
    }
  });

  it("does not repeat a consent click or start a second attempt while the owned attempt can settle", async () => {
    const context = await browser.newContext();
    const product = await context.newPage();
    await context.route("https://product.test/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<button id="oauth" onclick="location.href=\'https://accounts.google.com/pending\'">Google</button>',
      }),
    );
    await context.route("https://accounts.google.com/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<button id="continue" onclick="document.body.dataset.clicks=(Number(document.body.dataset.clicks||0)+1)">Continue</button>',
      }),
    );
    await product.goto("https://accounts.google.com/pending");
    const controller = BrowserController.fromHarnessPage(product);
    try {
      (
        controller as unknown as {
          activeOAuthAttempt: {
            id: string;
            provider: "google";
            productPage: Page;
            productDocumentId: string;
            providerPage: Page;
            providerDocumentId: string;
            reporter: undefined;
            reportedChallenges: Map<string, undefined>;
          };
        }
      ).activeOAuthAttempt = {
        id: "attempt-1",
        provider: "google",
        productPage: product,
        productDocumentId: controller.mainDocumentIdentity(product),
        providerPage: product,
        providerDocumentId: controller.mainDocumentIdentity(product),
        reporter: undefined,
        reportedChallenges: new Map(),
      };
      await expect(controller.advanceOAuthConsent("google", 500)).resolves.toBe(true);
      expect(await product.locator("body").getAttribute("data-clicks")).toBe("1");
      await expect(controller.advanceOAuthConsent("google", 500)).resolves.toBe(false);
      expect(await product.locator("body").getAttribute("data-clicks")).toBe("1");
      await product.reload();
      await expect(controller.advanceOAuthConsent("google", 500)).resolves.toBe(false);
      expect(await product.locator("body").getAttribute("data-clicks")).toBeNull();
      const driver = (controller as unknown as { pageDriver: Record<string, unknown> }).pageDriver;
      driver.oauthProductPage = product;
      driver.oauthProviderPage = product;
      await expect(controller.loginWithOAuth("#oauth", 100, "google")).rejects.toMatchObject({
        message: expect.stringContaining("second authorization attempt was not started"),
      });
      expect(await product.locator("body").getAttribute("data-clicks")).toBeNull();
    } finally {
      await context.close();
    }
  });

  it("returns an attempt-bound Google number immediately and stops consent automation", async () => {
    const context = await browser.newContext();
    const product = await context.newPage();
    const challengeUrl =
      "https://accounts.google.com/v3/signin/challenge/dp?redirect_uri=https%3A%2F%2Fproduct.test%2Fcallback";
    await context.route("https://product.test/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<button id="oauth" onclick='location.href=${JSON.stringify(challengeUrl)}'>Google</button>`,
      }),
    );
    await context.route("https://accounts.google.com/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<main>Verify it's you — Tap 28 on your phone to sign in</main>
          <button id="continue" onclick="document.body.dataset.clicked='yes'">Continue</button>`,
      }),
    );
    await product.goto("https://product.test/login");
    const controller = BrowserController.fromHarnessPage(product);
    const reporter = vi.fn(
      async (challenge: { attempt_id: string; challenge_revision: string }) => ({
        sent: false,
        deduped: false,
        attempt_id: challenge.attempt_id,
        challenge_revision: challenge.challenge_revision,
        delivery: { channel: null, status: "failed" as const, error: "smtp_error" },
      }),
    );
    try {
      const error = await controller
        .loginWithOAuth(
          "#oauth",
          2_000,
          "google",
          undefined,
          undefined,
          undefined,
          undefined,
          reporter,
        )
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(OAuthAwaitingHumanError);
      expect(error).toMatchObject({
        challenge: {
          provider: "google",
          kind: "number_match",
          number: "28",
          expires_at: null,
        },
        notification: {
          sent: false,
          delivery: { status: "failed", error: "smtp_error" },
        },
      });
      expect(reporter).toHaveBeenCalledOnce();
      expect(await product.locator("body").getAttribute("data-clicked")).toBeNull();
    } finally {
      await context.close();
    }
  });

  it("projects changed Google challenge revisions through ordinary observations and clears disappeared challenges", async () => {
    const context = await browser.newContext();
    const product = await context.newPage();
    const challengeUrl = "https://accounts.google.com/v3/signin/challenge/dp";
    await context.route("https://product.test/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<button id="oauth" onclick='location.href=${JSON.stringify(challengeUrl)}'>Continue with Google</button>`,
      }),
    );
    await context.route("https://accounts.google.com/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<main>Verify it's you — Tap 28 on your phone</main><button onclick="document.body.dataset.clicked='yes'">Continue</button>`,
      }),
    );
    await product.goto("https://product.test/login");
    const controller = BrowserController.fromHarnessPage(product);
    const notifyHeightenedAuth = vi.fn(
      async (input: { attempt_id: string; challenge_revision: string }, signal: AbortSignal) => {
        expect(signal).toBeInstanceOf(AbortSignal);
        return {
          sent: false,
          deduped: false,
          attempt_id: input.attempt_id,
          challenge_revision: input.challenge_revision,
          delivery: { channel: null, status: "failed" as const, error: "fixture_delivery_failure" },
        };
      },
    );
    let sessionId: string | undefined;
    try {
      const started = await startHarnessProvisionSession({
        browser: controller,
        serviceUrl: "https://product.test/login",
        api: { notifyHeightenedAuth } as unknown as ApiClient,
      });
      sessionId = started.session_id;
      const ref = parseElementsTable(started.el_table ?? "").find(
        (element) => element.label === "Continue with Google",
      )?.ref;
      expect(ref).toBeDefined();
      const first = await act(sessionId, { kind: "oauth_login", target: ref!, provider: "google" });
      expect(first.oauth).toMatchObject({
        state: "awaiting_human",
        challenge: { number: "28" },
        notification: { delivery: { status: "failed" } },
      });
      expect(notifyHeightenedAuth).toHaveBeenCalledTimes(1);
      const same = await observe(sessionId);
      expect(same.oauth).toMatchObject({ challenge: { number: "28" } });
      expect(notifyHeightenedAuth).toHaveBeenCalledTimes(1);
      await product.locator("main").evaluate((node) => {
        node.textContent = "Verify it's you — Tap 64 on your phone";
      });
      const changed = await observe(sessionId);
      expect(changed.oauth).toMatchObject({
        challenge: { number: "64" },
        notification: { delivery: { status: "failed" } },
      });
      expect(notifyHeightenedAuth).toHaveBeenCalledTimes(2);
      expect(notifyHeightenedAuth.mock.calls[1]![0].challenge_revision).not.toBe(
        notifyHeightenedAuth.mock.calls[0]![0].challenge_revision,
      );
      expect(notifyHeightenedAuth.mock.calls[1]![0].attempt_id).toBe(
        notifyHeightenedAuth.mock.calls[0]![0].attempt_id,
      );
      expect(await product.locator("body").getAttribute("data-clicked")).toBeNull();
      await product.goto("https://product.test/done");
      const disappeared = await observe(sessionId);
      expect(disappeared.oauth).toBeUndefined();
      expect(notifyHeightenedAuth).toHaveBeenCalledTimes(2);
    } finally {
      if (sessionId !== undefined) await finishProvisionSession(sessionId).catch(() => undefined);
      await context.close();
    }
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

  it("binds payment checkout work to an OAuth completion page", async () => {
    const context = await browser.newContext();
    const product = await context.newPage();
    const productUrl = "https://product.test/checkout";
    const returnUrl = "https://console.product.test/return";
    const previousTimeout = process.env.TRUSTY_SQUIRE_OAUTH_ACTION_TIMEOUT_MS;
    const previousCooldown = process.env.TRUSTY_SQUIRE_OAUTH_LOGIN_COOLDOWN_MS;
    process.env.TRUSTY_SQUIRE_OAUTH_ACTION_TIMEOUT_MS = "5000";
    process.env.TRUSTY_SQUIRE_OAUTH_LOGIN_COOLDOWN_MS = "0";
    let sessionId: string | undefined;
    const checkout = (total: string, submit: string) => `
      <main>Order total ${total}</main>
      <form>
        <input id="pan" autocomplete="cc-number">
        <input id="expiry" autocomplete="cc-exp">
        <input id="cvv" autocomplete="cc-csc">
        <input id="name" autocomplete="cc-name">
        <button type="button" onclick="fetch('/payments', { method: 'POST' }); history.pushState({}, '', '${submit}'); document.querySelector('main').textContent = 'Your order is confirmed Confirmation # source-123'">Pay now</button>
      </form>`;
    try {
      await context.route("https://product.test/**", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `${checkout("$98.76", "/thank-you/product-987")}<button id="oauth" onclick='window.open(${JSON.stringify(
            `https://accounts.google.com/provider?redirect_uri=${encodeURIComponent(returnUrl)}`,
          )})'>Continue with Google</button>`,
        }),
      );
      await context.route("https://accounts.google.com/**", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<script>location.replace(${JSON.stringify(returnUrl)})</script>`,
        }),
      );
      await context.route("https://console.product.test/**", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: checkout("$12.34", "/thank-you/source-123"),
        }),
      );
      await product.goto(productUrl);
      const controller = BrowserController.fromHarnessPage(product);
      const started = await startHarnessProvisionSession({
        browser: controller,
        serviceUrl: productUrl,
      });
      sessionId = started.session_id;
      const oauthRef = parseElementsTable(started.el_table ?? "").find(
        (element) => element.label === "Continue with Google",
      )?.ref;
      expect(oauthRef).toBeDefined();
      await act(sessionId, { kind: "oauth_login", target: oauthRef!, provider: "google" });

      const payment = await activeProvisionBrowserForPayment(sessionForCall(sessionId)!);
      await expect(payment.fillAndSubmitCheckout(PAYMENT_FIXTURE_CARD)).resolves.toMatchObject({
        order_confirmed: true,
      });
      const source = controller.completedOAuthPage()!;
      expect(source.url()).toContain("/thank-you/source-123");
      expect(product.url()).toBe(productUrl);
      expect(await product.locator("#pan").inputValue()).toBe("");
      expect(await product.locator("#expiry").inputValue()).toBe("");
      expect(await product.locator("#cvv").inputValue()).toBe("");
    } finally {
      if (previousTimeout === undefined) delete process.env.TRUSTY_SQUIRE_OAUTH_ACTION_TIMEOUT_MS;
      else process.env.TRUSTY_SQUIRE_OAUTH_ACTION_TIMEOUT_MS = previousTimeout;
      if (previousCooldown === undefined) delete process.env.TRUSTY_SQUIRE_OAUTH_LOGIN_COOLDOWN_MS;
      else process.env.TRUSTY_SQUIRE_OAUTH_LOGIN_COOLDOWN_MS = previousCooldown;
      if (sessionId !== undefined) await finishProvisionSession(sessionId);
      await context.close();
    }
  }, 20_000);

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
    const previousTimeout = process.env.TRUSTY_SQUIRE_OAUTH_ACTION_TIMEOUT_MS;
    const previousCooldown = process.env.TRUSTY_SQUIRE_OAUTH_LOGIN_COOLDOWN_MS;
    process.env.TRUSTY_SQUIRE_OAUTH_ACTION_TIMEOUT_MS = "1000";
    process.env.TRUSTY_SQUIRE_OAUTH_LOGIN_COOLDOWN_MS = "0";
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
      expect(result.oauth).toMatchObject({
        state: "awaiting_human",
        next_action: "operate_observe",
      });
    } finally {
      if (previousTimeout === undefined) delete process.env.TRUSTY_SQUIRE_OAUTH_ACTION_TIMEOUT_MS;
      else process.env.TRUSTY_SQUIRE_OAUTH_ACTION_TIMEOUT_MS = previousTimeout;
      if (previousCooldown === undefined) delete process.env.TRUSTY_SQUIRE_OAUTH_LOGIN_COOLDOWN_MS;
      else process.env.TRUSTY_SQUIRE_OAUTH_LOGIN_COOLDOWN_MS = previousCooldown;
      if (sessionId !== null) await finishProvisionSession(sessionId).catch(() => undefined);
      await context.close().catch(() => undefined);
    }
  }, 20_000);

  it("keeps a delayed popup dispatch pending without a return destination", async () => {
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
      await expect(controller.loginWithOAuth("#oauth", 3_000)).rejects.toBeInstanceOf(
        OAuthAwaitingHumanError,
      );
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
      const settling = controller.settleAfterOAuth(popup);
      await popup.close();
      await settling;

      expect(product.isClosed()).toBe(false);
      expect((controller as unknown as { page: Page }).page).toBe(product);
    } finally {
      await context.close().catch(() => undefined);
    }
  });

  it("refuses a legacy settle after a foreign tab is adopted", async () => {
    const { controller, product } = await controllerForProduct();
    const context = product.context();
    const foreignUrl = "https://foreign.test/adopted";
    let sessionId: string | undefined;
    try {
      await context.route("https://foreign.test/**", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: '<main id="foreign-state">Foreign tab</main>',
        }),
      );
      const started = await startHarnessProvisionSession({
        browser: controller,
        serviceUrl: PRODUCT_URL,
      });
      sessionId = started.session_id;
      await controller.startOAuth("#oauth");
      const source = (controller as unknown as { page: Page }).page;
      await source.setContent(
        `<button id="open-foreign" onclick="window.open('${foreignUrl}')">Open foreign tab</button>`,
      );

      const opened = await act(sessionId, { kind: "click", target: "Open foreign tab" });
      const foreign = context.pages().find((page) => page.url() === foreignUrl);
      expect(opened.url).toBe(foreignUrl);
      expect(foreign).toBeDefined();

      await expect(act(sessionId, { kind: "oauth_settle" })).rejects.toThrow(
        "OAuth lifecycle no longer matches the resolved operation page",
      );
      expect(product.isClosed()).toBe(false);
      expect(source.isClosed()).toBe(false);
      await expect(foreign!.locator("#foreign-state").textContent()).resolves.toBe("Foreign tab");
      expect((controller as unknown as { page: Page }).page).toBe(foreign);
    } finally {
      if (sessionId !== undefined) await finishProvisionSession(sessionId);
      await context.close().catch(() => undefined);
    }
  });

  it("refuses settlement when the product page closed before waiting", async () => {
    const { controller, product } = await controllerForProduct();
    const context = product.context();
    try {
      await controller.startOAuth("#oauth");
      const provider = (controller as unknown as { page: Page }).page;
      const unrelatedPromise = product.waitForEvent("popup");
      await product.evaluate(() => window.open("about:blank"));
      const unrelated = await unrelatedPromise;
      await unrelated.setContent('<main id="unrelated-state">Unrelated tab</main>');
      await product.close();

      await expect(controller.settleAfterOAuth(provider)).rejects.toThrow(
        "OAuth lifecycle no longer matches the resolved operation page",
      );
      expect(provider.isClosed()).toBe(false);
      await expect(unrelated.locator("#unrelated-state").textContent()).resolves.toBe(
        "Unrelated tab",
      );
      expect((controller as unknown as { page: Page }).page).toBe(provider);
    } finally {
      await context.close().catch(() => undefined);
    }
  });

  it("refuses settlement when the product page closes during its wait", async () => {
    const { controller, product } = await controllerForProduct();
    const context = product.context();
    try {
      await controller.startOAuth("#oauth");
      const provider = (controller as unknown as { page: Page }).page;
      const unrelatedPromise = product.waitForEvent("popup");
      await product.evaluate(() => window.open("about:blank"));
      const unrelated = await unrelatedPromise;
      await unrelated.setContent('<main id="unrelated-state">Unrelated tab</main>');

      const settling = controller.settleAfterOAuth(provider);
      await product.close();
      await expect(settling).rejects.toThrow("OAuth lifecycle product page became unavailable");
      expect(provider.isClosed()).toBe(false);
      await expect(unrelated.locator("#unrelated-state").textContent()).resolves.toBe(
        "Unrelated tab",
      );
      expect((controller as unknown as { page: Page }).page).toBe(provider);
    } finally {
      await context.close().catch(() => undefined);
    }
  });

  it("closes a live provider when its product lineage remains proven", async () => {
    const { controller, product } = await controllerForProduct();
    const context = product.context();
    try {
      await controller.startOAuth("#oauth");
      const provider = (controller as unknown as { page: Page }).page;
      const sleepSpy = vi
        .spyOn(controller as unknown as { sleep(ms: number): Promise<void> }, "sleep")
        .mockResolvedValue();
      try {
        await controller.settleAfterOAuth(provider);

        expect(product.isClosed()).toBe(false);
        expect(provider.isClosed()).toBe(true);
        expect((controller as unknown as { page: Page }).page).toBe(product);
      } finally {
        sleepSpy.mockRestore();
      }
    } finally {
      await context.close().catch(() => undefined);
    }
  });

  it("retains the provider when the product closes at teardown dispatch", async () => {
    const { controller, product } = await controllerForProduct();
    const context = product.context();
    try {
      await controller.startOAuth("#oauth");
      const provider = (controller as unknown as { page: Page }).page;
      let sleeps = 0;
      const sleepSpy = vi
        .spyOn(controller as unknown as { sleep(ms: number): Promise<void> }, "sleep")
        .mockImplementation(async () => {
          sleeps += 1;
          if (sleeps === 12) await product.close();
        });
      try {
        await expect(controller.settleAfterOAuth(provider)).rejects.toThrow(
          "OAuth lifecycle product page became unavailable",
        );
        expect(provider.isClosed()).toBe(false);
      } finally {
        sleepSpy.mockRestore();
      }
    } finally {
      await context.close().catch(() => undefined);
    }
  });

  it("returns a source-page scroll observation despite concurrent tab adoption", async () => {
    const context = await browser.newContext();
    const product = await context.newPage();
    const productUrl = "https://product.test/login";
    const sourceUrl = "https://console.product.test/source";
    const ordinaryUrl = "https://console.product.test/ordinary";
    let sessionId: string | undefined;
    try {
      await context.route("https://product.test/**", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<button id="oauth" onclick='window.open(${JSON.stringify(
            `https://accounts.google.com/provider?redirect_uri=${encodeURIComponent(sourceUrl)}`,
          )})'>Continue</button>`,
        }),
      );
      await context.route("https://accounts.google.com/**", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<script>location.replace(${JSON.stringify(sourceUrl)})</script>`,
        }),
      );
      await context.route("https://console.product.test/**", (route) =>
        route.fulfill({
          contentType: "text/html",
          body:
            route.request().url() === ordinaryUrl
              ? "<main>Ordinary tab</main>"
              : `<!doctype html><html><body style="min-height: 5000px"><main>Source tab</main><button id="open" onclick="window.open('${ordinaryUrl}')">Open ordinary tab</button></body></html>`,
        }),
      );
      await product.goto(productUrl);
      const controller = BrowserController.fromHarnessPage(product);
      const started = await startHarnessProvisionSession({
        browser: controller,
        serviceUrl: productUrl,
      });
      sessionId = started.session_id;
      const oauthRef = parseElementsTable(started.el_table ?? "")[0]?.ref;
      expect(oauthRef).toBeDefined();
      const returned = await act(sessionId, {
        kind: "oauth_login",
        target: oauthRef!,
        provider: "google",
      });
      const ordinaryRef = parseElementsTable(returned.el_table ?? "").find(
        (element) => element.label === "Open ordinary tab",
      )?.ref;
      expect(ordinaryRef).toBeDefined();
      const source = controller.completedOAuthPage()!;

      let scrollEntered!: () => void;
      let resumeScroll!: () => void;
      const scrollStarted = new Promise<void>((resolve) => {
        scrollEntered = resolve;
      });
      const scrollResume = new Promise<void>((resolve) => {
        resumeScroll = resolve;
      });
      const originalScroll = controller.scrollViewport.bind(controller);
      const scrollSpy = vi
        .spyOn(controller, "scrollViewport")
        .mockImplementation(async (direction = "down", page = null): Promise<void> => {
          await originalScroll(direction, page);
          scrollEntered();
          await scrollResume;
        });

      const scrolling = act(sessionId, { kind: "scroll", direction: "bottom" });
      await scrollStarted;
      const opened = await act(sessionId, { kind: "click", target: ordinaryRef! });
      resumeScroll();
      const scrolled = await scrolling;

      expect(opened.url).toBe(ordinaryUrl);
      expect(scrolled.url).toBe(sourceUrl);
      expect(scrolled.text).toContain("Source tab");
      expect(scrollSpy).toHaveBeenCalledWith("bottom", source);
      expect((await observe(sessionId)).url).toBe(ordinaryUrl);
      scrollSpy.mockRestore();
    } finally {
      if (sessionId !== undefined) await finishProvisionSession(sessionId);
      await context.close();
    }
  });

  it("keeps a provider-less SPA OAuth control pending after its popup closes", async () => {
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
        window.open(
          "https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=https%3A%2F%2Fproduct.test%2Fcallback",
        );
      };
      document.body.append(button);
    });
    const controller = BrowserController.fromHarnessPage(product);

    try {
      await expect(controller.loginWithOAuth("#oauth", 2_000)).rejects.toBeInstanceOf(
        OAuthAwaitingHumanError,
      );
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
          ? '<main id="state">Signed in</main><script>if (window.opener) { window.opener.location.href="https://product.test/callback"; window.close() }</script>'
          : '<main id="state">Signed out</main><button id="oauth" onclick="window.open(\'https://accounts.google.com/chooser?redirect_uri=https%3A%2F%2Fproduct.test%2Fcallback\')">Continue</button>',
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
      expect(controller.currentUrl()).toBe("https://product.test/callback");
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
          ? '<main id="state">Signed in</main><script>if (window.opener) { window.opener.location.href="https://product.test/callback"; window.close() }</script>'
          : '<main id="state">Signed out</main><button id="oauth" onclick="window.open(\'https://accounts.google.com/v3/signin/accountchooser?redirect_uri=https%3A%2F%2Fproduct.test%2Fcallback\')">Continue</button>',
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
      expect(controller.currentUrl()).toBe("https://product.test/callback");
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
          ? '<main id="state">Signed in</main><script>if (window.opener) { window.opener.location.href="https://product.test/callback"; window.close() }</script>'
          : '<main id="state">Signed out</main><button id="oauth" onclick="window.open(\'https://accounts.google.com/v3/signin/accountchooser?redirect_uri=https%3A%2F%2Fproduct.test%2Fcallback\')">Continue</button>',
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
      expect(controller.currentUrl()).toBe("https://product.test/callback");
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

  it("completes a same-tab OAuth return to the product console on a sibling host", async () => {
    const context = await browser.newContext();
    const product = await context.newPage();
    const expectedReturnUrl = "https://console.product.test/projects";
    await context.route("https://product.test/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<button id="oauth" onclick='location.href=${JSON.stringify(
          `https://accounts.google.com/provider?redirect_uri=${encodeURIComponent(expectedReturnUrl)}`,
        )}'>Continue</button>`,
      }),
    );
    await context.route("https://accounts.google.com/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<script>setTimeout(() => location.href=${JSON.stringify(expectedReturnUrl)}, 50)</script>`,
      }),
    );
    await context.route("https://console.product.test/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<main>Projects</main>",
      }),
    );
    await product.goto("https://product.test/login");
    const controller = BrowserController.fromHarnessPage(product);
    try {
      await expect(controller.loginWithOAuth("#oauth", 1_500, "google")).resolves.toBeUndefined();
      expect(controller.currentUrl()).toBe("https://console.product.test/projects");
    } finally {
      await context.close();
    }
  });

  it.each(["same-tab", "popup"] as const)(
    "captures the redirect target before a fast %s OAuth return",
    async (topology) => {
      const context = await browser.newContext();
      const product = await context.newPage();
      const expectedReturnUrl = "https://console.product.test/projects";
      const providerUrl = `https://accounts.google.com/provider?redirect_uri=${encodeURIComponent(expectedReturnUrl)}`;
      await context.route("https://product.test/**", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<button id="oauth" onclick='${
            topology === "popup" ? "window.open" : "location.assign"
          }(${JSON.stringify(providerUrl)})'>Continue</button>`,
        }),
      );
      await context.route("https://accounts.google.com/**", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<script>location.replace(${JSON.stringify(expectedReturnUrl)})</script>`,
        }),
      );
      await context.route("https://console.product.test/**", (route) =>
        route.fulfill({ contentType: "text/html", body: "<main>Projects</main>" }),
      );
      await product.goto("https://product.test/login");
      const controller = BrowserController.fromHarnessPage(product);
      try {
        await expect(controller.loginWithOAuth("#oauth", 500)).resolves.toBeUndefined();
        expect(controller.completedOAuthPage()?.url()).toBe(expectedReturnUrl);
      } finally {
        await context.close();
      }
    },
  );

  it.each(["same-tab", "popup"] as const)(
    "captures the redirect target from a fast %s HTTP redirect",
    async (topology) => {
      const context = await browser.newContext();
      const product = await context.newPage();
      let expectedReturnUrl = "";
      const returnTarget = createServer((_request, response) => {
        response.writeHead(200, { "content-type": "text/html" });
        response.end("<main>Projects</main>");
      });
      await new Promise<void>((resolve) => returnTarget.listen(0, "127.0.0.1", resolve));
      const { port: returnPort } = returnTarget.address() as AddressInfo;
      expectedReturnUrl = `http://127.0.0.1:${returnPort}/projects`;
      const providerUrl = `https://accounts.google.com/provider?redirect_uri=${encodeURIComponent(expectedReturnUrl)}`;
      await context.route(providerUrl, (route) =>
        route.fulfill({ status: 302, headers: { location: expectedReturnUrl } }),
      );
      await context.route("https://product.test/**", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<button id="oauth" onclick='${
            topology === "popup" ? "window.open" : "location.assign"
          }(${JSON.stringify(providerUrl)})'>Continue</button>`,
        }),
      );
      await product.goto("https://product.test/login");
      const controller = BrowserController.fromHarnessPage(product);
      try {
        await expect(controller.loginWithOAuth("#oauth", 500)).resolves.toBeUndefined();
        expect(controller.completedOAuthPage()?.url()).toBe(expectedReturnUrl);
      } finally {
        await context.close();
        await new Promise<void>((resolve, reject) =>
          returnTarget.close((error) => (error === undefined ? resolve() : reject(error))),
        );
      }
    },
  );

  it("ignores an unrelated context navigation while capturing a popup redirect", async () => {
    const context = await browser.newContext();
    const product = await context.newPage();
    const expectedReturnUrl = "https://console.product.test/projects";
    const unrelatedReturnUrl = "https://other.test/return";
    const providerUrl = `https://accounts.google.com/provider?redirect_uri=${encodeURIComponent(expectedReturnUrl)}`;
    await context.route("https://product.test/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<button id="oauth" onclick='window.oauthClicked = true; setTimeout(() => window.open(${JSON.stringify(
          providerUrl,
        )}), 100)'>Continue</button>`,
      }),
    );
    await context.route("https://accounts.google.com/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<script>location.href=${JSON.stringify(expectedReturnUrl)}</script>`,
      }),
    );
    await context.route("https://console.product.test/**", (route) =>
      route.fulfill({ contentType: "text/html", body: "<main>Projects</main>" }),
    );
    await context.route("https://unrelated.test/**", (route) =>
      route.fulfill({ contentType: "text/html", body: "<main>Unrelated</main>" }),
    );
    await product.goto("https://product.test/login");
    const controller = BrowserController.fromHarnessPage(product);
    try {
      const login = controller.loginWithOAuth("#oauth", 1_000);
      await product.waitForFunction(
        () => (window as { oauthClicked?: boolean }).oauthClicked === true,
      );
      const unrelated = await context.newPage();
      await unrelated.goto(
        `https://unrelated.test/authorize?redirect_uri=${encodeURIComponent(unrelatedReturnUrl)}`,
      );
      await expect(login).resolves.toBeUndefined();
      expect(controller.completedOAuthPage()?.url()).toBe(expectedReturnUrl);
      expect(unrelated.isClosed()).toBe(false);
    } finally {
      await context.close();
    }
  });

  it("keeps a return with a non-OAuth query challenge pending", async () => {
    const context = await browser.newContext();
    const product = await context.newPage();
    const expectedReturnUrl = "https://console.product.test/projects?organization=expected";
    const challengeUrl = `${expectedReturnUrl}&mfa=required`;
    await context.route("https://product.test/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<button id="oauth" onclick='location.assign(${JSON.stringify(
          `https://accounts.google.com/provider?redirect_uri=${encodeURIComponent(expectedReturnUrl)}`,
        )})'>Continue</button>`,
      }),
    );
    await context.route("https://accounts.google.com/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<script>location.replace(${JSON.stringify(challengeUrl)})</script>`,
      }),
    );
    await context.route("https://console.product.test/**", (route) =>
      route.fulfill({ contentType: "text/html", body: "<main>Enter verification code</main>" }),
    );
    await product.goto("https://product.test/login");
    const controller = BrowserController.fromHarnessPage(product);
    try {
      await expect(controller.loginWithOAuth("#oauth", 500)).rejects.toBeInstanceOf(
        OAuthAwaitingHumanError,
      );
    } finally {
      await context.close();
    }
  });

  it.each(["browser-use-dom", "legacy"])(
    "binds type and select refs to a same-tab OAuth return (%s)",
    async (format) => {
      const context = await browser.newContext();
      const product = await context.newPage();
      const expectedReturnUrl = "https://console.product.test/projects";
      await context.route("https://product.test/**", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<button id="oauth" onclick='location.href=${JSON.stringify(
            `https://accounts.google.com/provider?redirect_uri=${encodeURIComponent(expectedReturnUrl)}`,
          )}'>Continue</button>`,
        }),
      );
      await context.route("https://accounts.google.com/**", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<script>setTimeout(() => location.href=${JSON.stringify(expectedReturnUrl)}, 50)</script>`,
        }),
      );
      await context.route("https://console.product.test/**", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: '<main>Projects</main><input id="project-name" value=""><select id="region"><option>Provider</option><option>Product</option></select>',
        }),
      );
      await product.goto("https://product.test/login");
      const controller = BrowserController.fromHarnessPage(product);
      let sessionId: string | undefined;
      try {
        const started = await startHarnessProvisionSession({
          browser: controller,
          serviceUrl: "https://product.test/login",
          ...(format === "browser-use-dom"
            ? { observationFormat: "browser-use-dom" as const }
            : {}),
        });
        sessionId = started.session_id;
        const oauthRef =
          format === "browser-use-dom"
            ? started.dom?.match(/@e:[A-Za-z0-9_-]+/)?.[0]
            : parseElementsTable(started.el_table ?? "")[0]?.ref;
        expect(oauthRef).toBeDefined();
        const result = await act(sessionId, {
          kind: "oauth_login",
          target: oauthRef!,
          provider: "google",
        });
        const refs =
          format === "browser-use-dom"
            ? [...(result.dom ?? "").matchAll(/\[(@e:[^\]]+)\]</g)].map((match) => match[1]!)
            : parseElementsTable(result.el_table ?? "").map((element) => element.ref);
        const [typeRef, selectRef] = refs;
        expect(typeRef).toBeDefined();
        expect(selectRef).toBeDefined();
        await act(sessionId, { kind: "type", target: typeRef!, text: "product" });
        await act(sessionId, { kind: "select", target: selectRef!, text: "Product" });
        expect(await product.locator("#project-name").inputValue()).toBe("product");
        expect(await product.locator("#region").inputValue()).toBe("Product");
      } finally {
        if (sessionId) await finishProvisionSession(sessionId);
        await context.close();
      }
    },
  );

  it.each(["browser-use-dom", "legacy"])(
    "observes a normal popup return from its completed page (%s)",
    async (format) => {
      const context = await browser.newContext();
      const product = await context.newPage();
      const expectedReturnUrl = "https://console.product.test/projects";
      await context.route("https://product.test/**", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<button id="oauth" onclick='window.open(${JSON.stringify(
            `https://accounts.google.com/provider?redirect_uri=${encodeURIComponent(expectedReturnUrl)}`,
          )})'>Continue</button>`,
        }),
      );
      await context.route("https://accounts.google.com/**", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<script>location.replace(${JSON.stringify(expectedReturnUrl)})</script>`,
        }),
      );
      await context.route("https://console.product.test/**", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: '<main>Projects</main><button id="new-project">New project</button>',
        }),
      );
      await product.goto("https://product.test/login");
      const controller = BrowserController.fromHarnessPage(product);
      let sessionId: string | undefined;
      try {
        const started = await startHarnessProvisionSession({
          browser: controller,
          serviceUrl: "https://product.test/login",
          ...(format === "browser-use-dom"
            ? { observationFormat: "browser-use-dom" as const }
            : {}),
        });
        sessionId = started.session_id;
        const oauthRef =
          format === "browser-use-dom"
            ? started.dom?.match(/@e:[A-Za-z0-9_-]+/)?.[0]
            : parseElementsTable(started.el_table ?? "")[0]?.ref;
        expect(oauthRef).toBeDefined();
        const result = await act(sessionId, {
          kind: "oauth_login",
          target: oauthRef!,
          provider: "google",
        });
        expect(result.url).toBe(expectedReturnUrl);
        if (format === "browser-use-dom") expect(result.dom).toContain("New project");
        else expect(result.el_table).toContain("New project");
      } finally {
        if (sessionId) await finishProvisionSession(sessionId);
        await context.close();
      }
    },
  );

  it("settles an atomic popup return on its retained product page", async () => {
    const context = await browser.newContext();
    const product = await context.newPage();
    const expectedReturnUrl = "https://console.product.test/projects";
    await context.route("https://product.test/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body:
          route.request().url() === "https://product.test/other"
            ? "<main>Other product page</main>"
            : `<button id="oauth" onclick='window.open(${JSON.stringify(
                `https://accounts.google.com/provider?redirect_uri=${encodeURIComponent(expectedReturnUrl)}`,
              )})'>Continue</button><button id="product-action" onclick="document.body.dataset.productAction = 'yes'">Product action</button>`,
      }),
    );
    await context.route("https://accounts.google.com/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<script>location.replace(${JSON.stringify(expectedReturnUrl)})</script>`,
      }),
    );
    await context.route("https://console.product.test/**", (route) =>
      route.fulfill({ contentType: "text/html", body: "<main>Projects</main>" }),
    );
    await product.goto("https://product.test/login");
    const controller = BrowserController.fromHarnessPage(product);
    let sessionId: string | undefined;
    try {
      const started = await startHarnessProvisionSession({
        browser: controller,
        serviceUrl: "https://product.test/login",
      });
      sessionId = started.session_id;
      const oauthRef = parseElementsTable(started.el_table ?? "")[0]?.ref;
      expect(oauthRef).toBeDefined();
      await act(sessionId, { kind: "oauth_login", target: oauthRef!, provider: "google" });
      const provider = controller.completedOAuthPage();
      expect(provider).not.toBeNull();
      const sleepSpy = vi
        .spyOn(controller as unknown as { sleep(ms: number): Promise<void> }, "sleep")
        .mockResolvedValue();
      try {
        const settled = await act(sessionId, { kind: "oauth_settle" });
        expect(settled.url).toBe("https://product.test/login");
        expect(settled.el_table).toContain("Continue");
        expect(provider?.isClosed()).toBe(true);
        expect(product.isClosed()).toBe(false);
        expect((controller as unknown as { page: Page }).page).toBe(product);
        const productActionRef = parseElementsTable(settled.el_table ?? "").find(
          (element) => element.label === "Product action",
        )?.ref;
        expect(productActionRef).toBeDefined();
        await act(sessionId, { kind: "click", target: productActionRef! });
        expect(await product.locator("body").getAttribute("data-product-action")).toBe("yes");
        await expect(act(sessionId, { kind: "press", key: "Enter" })).resolves.toMatchObject({
          url: "https://product.test/login",
        });
        await expect(
          act(sessionId, { kind: "goto", url: "https://product.test/other" }),
        ).resolves.toMatchObject({
          url: "https://product.test/other",
        });
      } finally {
        sleepSpy.mockRestore();
      }
    } finally {
      if (sessionId) await finishProvisionSession(sessionId);
      await context.close();
    }
  });

  it.each(["completed", "awaiting_human"] as const)(
    "reports a reused-session popup as %s while the initiating click is still pending",
    async (outcome) => {
      const context = await browser.newContext();
      const product = await context.newPage();
      const returnUrl = "https://console.product.test/projects";
      const providerUrl = `https://accounts.google.com/provider?redirect_uri=${encodeURIComponent(returnUrl)}`;
      const previousTimeout = process.env.TRUSTY_SQUIRE_OAUTH_ACTION_TIMEOUT_MS;
      const previousCooldown = process.env.TRUSTY_SQUIRE_OAUTH_LOGIN_COOLDOWN_MS;
      // Allow the preceding test's default three-second lease cooldown to drain.
      process.env.TRUSTY_SQUIRE_OAUTH_ACTION_TIMEOUT_MS = "5000";
      process.env.TRUSTY_SQUIRE_OAUTH_LOGIN_COOLDOWN_MS = "0";
      await context.route("https://product.test/**", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<button id="oauth" onclick='window.open(${JSON.stringify(providerUrl)})'>Continue with Google</button>`,
        }),
      );
      await context.route("https://accounts.google.com/**", (route) =>
        route.fulfill({
          contentType: "text/html",
          body:
            outcome === "completed"
              ? `<script>location.replace(${JSON.stringify(returnUrl)})</script>`
              : "<main>Sign in to Google</main>",
        }),
      );
      await context.route("https://console.product.test/**", (route) =>
        route.fulfill({ contentType: "text/html", body: "<button>New project</button>" }),
      );
      await product.goto("https://product.test/login");
      const controller = BrowserController.fromHarnessPage(product);
      let releaseClick!: () => void;
      const clickGate = new Promise<void>((resolve) => {
        releaseClick = resolve;
      });
      let popup: Page | undefined;
      vi.spyOn(controller, "click").mockImplementationOnce(async (selector) => {
        const opened = product.waitForEvent("popup");
        await product.locator(selector).click();
        popup = await opened;
        await popup.waitForURL(outcome === "completed" ? returnUrl : providerUrl);
        // The page can finish OAuth before Playwright's initiating action
        // resolves. Hold that acknowledgement past the outer action window.
        await clickGate;
      });
      let sessionId: string | undefined;
      try {
        const started = await startHarnessProvisionSession({
          browser: controller,
          serviceUrl: "https://product.test/login",
          observationFormat: "browser-use-dom",
        });
        sessionId = started.session_id;
        const target = started.dom?.match(/@e:[A-Za-z0-9_-]+/)?.[0];
        expect(target).toBeDefined();
        const result = await act(sessionId, {
          kind: "oauth_login",
          target: target!,
          provider: "google",
        });
        expect(popup?.url()).toBe(outcome === "completed" ? returnUrl : providerUrl);
        if (outcome === "completed") {
          expect(result.oauth).toBeUndefined();
          expect(result.url).toBe(returnUrl);
          expect(result.dom).toContain("New project");
        } else {
          expect(result.oauth?.state).toBe("awaiting_human");
        }
        releaseClick();
        if (outcome === "completed") {
          await vi.waitFor(() => expect(controller.completedOAuthPage()?.url()).toBe(returnUrl));
          const next = await observe(sessionId);
          expect(next.url).toBe(returnUrl);
          expect(next.oauth?.state).not.toBe("awaiting_human");
        }
      } finally {
        releaseClick();
        if (previousTimeout === undefined) delete process.env.TRUSTY_SQUIRE_OAUTH_ACTION_TIMEOUT_MS;
        else process.env.TRUSTY_SQUIRE_OAUTH_ACTION_TIMEOUT_MS = previousTimeout;
        if (previousCooldown === undefined)
          delete process.env.TRUSTY_SQUIRE_OAUTH_LOGIN_COOLDOWN_MS;
        else process.env.TRUSTY_SQUIRE_OAUTH_LOGIN_COOLDOWN_MS = previousCooldown;
        if (sessionId) await finishProvisionSession(sessionId);
        await context.close();
      }
    },
    10_000,
  );

  it.each(["browser-use-dom", "legacy"])(
    "rechecks completion when the outer action deadline wins during consent work (%s)",
    async (format) => {
      const context = await browser.newContext();
      const product = await context.newPage();
      const expectedReturnUrl = "https://console.product.test/projects";
      const previousTimeout = process.env.TRUSTY_SQUIRE_OAUTH_ACTION_TIMEOUT_MS;
      const previousCooldown = process.env.TRUSTY_SQUIRE_OAUTH_LOGIN_COOLDOWN_MS;
      // The human phase now receives a fresh configured budget once the popup
      // handoff is established. Leave enough wall-clock room for the compact
      // observation setup, then prove that this handoff deadline still wins
      // while consent work remains pending.
      process.env.TRUSTY_SQUIRE_OAUTH_ACTION_TIMEOUT_MS = "6000";
      process.env.TRUSTY_SQUIRE_OAUTH_LOGIN_COOLDOWN_MS = "0";
      await context.route("https://product.test/**", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<button id="oauth" onclick='window.open(${JSON.stringify(
            `https://accounts.google.com/provider?redirect_uri=${encodeURIComponent(expectedReturnUrl)}`,
          )})'>Continue</button>`,
        }),
      );
      await context.route("https://accounts.google.com/**", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: '<main>Example wants access to your Google Account</main><input id="project-name" required autocomplete="shipping address-line1" value="provider" onchange="document.body.dataset.shippingCommitted=\'provider\'"><select id="region"><option>Provider</option><option>Product</option></select>',
        }),
      );
      await context.route("https://console.product.test/**", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: '<main>Projects</main><input id="project-name" required autocomplete="shipping address-line1" value="" onchange="document.body.dataset.shippingCommitted=\'product\'"><select id="region"><option>Provider</option><option>Product</option></select><button id="new-project" onclick="document.body.dataset.projectClicked=\'yes\'">New project</button>',
        }),
      );
      await product.goto("https://product.test/login");
      const controller = BrowserController.fromHarnessPage(product);
      vi.spyOn(
        controller as unknown as {
          waitForOAuthLifecycle: (...args: unknown[]) => Promise<Page | null>;
        },
        "waitForOAuthLifecycle",
      ).mockResolvedValueOnce(null);
      let releaseConsent!: () => void;
      let consentStarted = false;
      const consentGate = new Promise<boolean>((resolve) => {
        releaseConsent = () => resolve(true);
      });
      vi.spyOn(controller, "advanceOAuthConsent").mockImplementation(async () => {
        await product.goto("https://console.product.test/projects");
        consentStarted = true;
        return await consentGate;
      });
      let sessionId: string | undefined;
      try {
        const started = await startHarnessProvisionSession({
          browser: controller,
          serviceUrl: "https://product.test/login",
          ...(format === "browser-use-dom"
            ? { observationFormat: "browser-use-dom" as const }
            : {}),
        });
        sessionId = started.session_id;
        const refFrom = (observation: { dom?: string; el_table?: string }): string | undefined =>
          format === "browser-use-dom"
            ? observation.dom?.match(/@e:[A-Za-z0-9_-]+/)?.[0]
            : parseElementsTable(observation.el_table ?? "")[0]?.ref;
        const oauthRef = refFrom(started);
        expect(oauthRef).toBeDefined();
        const result = await act(sessionId, {
          kind: "oauth_login",
          target: oauthRef!,
          provider: "google",
        });
        expect(consentStarted).toBe(true);
        expect(result.url).toBe("https://console.product.test/projects");
        expect(result.oauth).toBeUndefined();
        if (format === "browser-use-dom")
          expect(result).toMatchObject({ format: "browser-use-dom" });
        else expect(result.format).toBeUndefined();
        const productRefs =
          format === "browser-use-dom"
            ? [...(result.dom ?? "").matchAll(/\[(@e:[^\]]+)\]</g)].map((match) => match[1]!)
            : parseElementsTable(result.el_table ?? "").map((element) => element.ref);
        const [typeRef, selectRef, productRef] = productRefs;
        expect(typeRef).toBeDefined();
        expect(selectRef).toBeDefined();
        expect(productRef).toBeDefined();
        await act(sessionId, { kind: "type", target: typeRef!, text: "product" });
        await act(sessionId, { kind: "select", target: selectRef!, text: "Product" });
        await act(sessionId, { kind: "click", target: productRef! });
        expect(await product.locator("#project-name").inputValue()).toBe("product");
        expect(await product.locator("#region").inputValue()).toBe("Product");
        const provider = (controller as unknown as { page: Page }).page;
        expect(await provider.locator("#project-name").inputValue()).toBe("provider");
        expect(await provider.locator("#region").inputValue()).toBe("Provider");
        expect(await product.locator("body").getAttribute("data-shipping-committed")).toBe(
          "product",
        );
        expect(await provider.locator("body").getAttribute("data-shipping-committed")).toBeNull();
        expect(await product.locator("body").getAttribute("data-project-clicked")).toBe("yes");
        expect((controller as unknown as { page: Page }).page.url()).toBe(
          `https://accounts.google.com/provider?redirect_uri=${encodeURIComponent(expectedReturnUrl)}`,
        );
        releaseConsent();
        await vi.waitFor(() =>
          expect((controller as unknown as { page: Page }).page.url()).toBe(expectedReturnUrl),
        );
        const settled = await observe(sessionId);
        expect(settled.url).toBe(expectedReturnUrl);
        if (format === "browser-use-dom")
          expect(settled).toMatchObject({ format: "browser-use-dom" });
        else expect(settled.format).toBeUndefined();
      } finally {
        releaseConsent();
        if (previousTimeout === undefined) delete process.env.TRUSTY_SQUIRE_OAUTH_ACTION_TIMEOUT_MS;
        else process.env.TRUSTY_SQUIRE_OAUTH_ACTION_TIMEOUT_MS = previousTimeout;
        if (previousCooldown === undefined)
          delete process.env.TRUSTY_SQUIRE_OAUTH_LOGIN_COOLDOWN_MS;
        else process.env.TRUSTY_SQUIRE_OAUTH_LOGIN_COOLDOWN_MS = previousCooldown;
        if (sessionId) await finishProvisionSession(sessionId);
        await context.close();
      }
    },
    15_000,
  );

  it.each([
    "https://auth.product.test/consent",
    "https://console.product.test/challenge",
    "https://unrelated.test/projects",
  ])("keeps %s pending after provider navigation", async (destination) => {
    const context = await browser.newContext();
    const product = await context.newPage();
    await context.route("**/*", (route) =>
      route.fulfill({
        contentType: "text/html",
        body:
          route.request().url() === "https://product.test/login"
            ? '<button id="oauth" onclick="location.href=\'https://accounts.google.com/provider\'">Continue</button>'
            : route.request().url().startsWith("https://accounts.google.com/")
              ? `<script>setTimeout(() => location.href=${JSON.stringify(destination)}, 50)</script>`
              : "<main>Approve sign-in</main>",
      }),
    );
    await product.goto("https://product.test/login");
    const controller = BrowserController.fromHarnessPage(product);
    try {
      await expect(controller.loginWithOAuth("#oauth", 800, "google")).rejects.toBeInstanceOf(
        OAuthAwaitingHumanError,
      );
    } finally {
      await context.close();
    }
  });

  it.each(["https://identity.product.test/mfa", "https://product.test/mfa"])(
    "keeps %s pending despite a different initiated destination",
    async (mfaUrl) => {
      const context = await browser.newContext();
      const product = await context.newPage();
      const expectedReturnUrl = "https://console.product.test/projects";
      await context.route("**/*", (route) =>
        route.fulfill({
          contentType: "text/html",
          body:
            route.request().url() === "https://product.test/login"
              ? `<button id="oauth" onclick='location.href=${JSON.stringify(
                  `https://accounts.google.com/provider?redirect_uri=${encodeURIComponent(expectedReturnUrl)}`,
                )}'>Continue</button>`
              : route.request().url().startsWith("https://accounts.google.com/")
                ? `<script>setTimeout(() => location.href=${JSON.stringify(mfaUrl)}, 50)</script>`
                : "<main>Approve sign-in</main>",
        }),
      );
      await product.goto("https://product.test/login");
      const controller = BrowserController.fromHarnessPage(product);
      try {
        await expect(controller.loginWithOAuth("#oauth", 800, "google")).rejects.toBeInstanceOf(
          OAuthAwaitingHumanError,
        );
      } finally {
        await context.close();
      }
    },
  );

  it("keeps a return with mismatched fixed redirect query pending", async () => {
    const context = await browser.newContext();
    const product = await context.newPage();
    const expectedReturnUrl = "https://console.product.test/projects?organization=expected";
    const mismatchedReturnUrl =
      "https://console.product.test/projects?organization=other&code=oauth-code";
    await context.route("**/*", (route) =>
      route.fulfill({
        contentType: "text/html",
        body:
          route.request().url() === "https://product.test/login"
            ? `<button id="oauth" onclick='location.href=${JSON.stringify(
                `https://accounts.google.com/provider?redirect_uri=${encodeURIComponent(expectedReturnUrl)}`,
              )}'>Continue</button>`
            : route.request().url().startsWith("https://accounts.google.com/")
              ? `<script>setTimeout(() => location.href=${JSON.stringify(mismatchedReturnUrl)}, 50)</script>`
              : "<main>Approve sign-in</main>",
      }),
    );
    await product.goto("https://product.test/login");
    const controller = BrowserController.fromHarnessPage(product);
    try {
      await expect(controller.loginWithOAuth("#oauth", 800, "google")).rejects.toBeInstanceOf(
        OAuthAwaitingHumanError,
      );
    } finally {
      await context.close();
    }
  });

  it("keeps a return with conflicting duplicate fixed redirect query pending", async () => {
    const context = await browser.newContext();
    const product = await context.newPage();
    const expectedReturnUrl = "https://console.product.test/projects?organization=expected";
    const conflictingReturnUrl =
      "https://console.product.test/projects?organization=other&organization=expected&code=oauth-code";
    await context.route("**/*", (route) =>
      route.fulfill({
        contentType: "text/html",
        body:
          route.request().url() === "https://product.test/login"
            ? `<button id="oauth" onclick='location.href=${JSON.stringify(
                `https://accounts.google.com/provider?redirect_uri=${encodeURIComponent(expectedReturnUrl)}`,
              )}'>Continue</button>`
            : route.request().url().startsWith("https://accounts.google.com/")
              ? `<script>setTimeout(() => location.href=${JSON.stringify(conflictingReturnUrl)}, 50)</script>`
              : "<main>Approve sign-in</main>",
      }),
    );
    await product.goto("https://product.test/login");
    const controller = BrowserController.fromHarnessPage(product);
    try {
      await expect(controller.loginWithOAuth("#oauth", 800, "google")).rejects.toBeInstanceOf(
        OAuthAwaitingHumanError,
      );
    } finally {
      await context.close();
    }
  });

  it("accepts OAuth response parameters after matching fixed redirect query", async () => {
    const context = await browser.newContext();
    const product = await context.newPage();
    const expectedReturnUrl = "https://console.product.test/projects?organization=expected";
    const returnedUrl = `${expectedReturnUrl}&code=oauth-code&state=oauth-state`;
    await context.route("**/*", (route) =>
      route.fulfill({
        contentType: "text/html",
        body:
          route.request().url() === "https://product.test/login"
            ? `<button id="oauth" onclick='location.href=${JSON.stringify(
                `https://accounts.google.com/provider?redirect_uri=${encodeURIComponent(expectedReturnUrl)}`,
              )}'>Continue</button>`
            : route.request().url().startsWith("https://accounts.google.com/")
              ? `<script>setTimeout(() => location.href=${JSON.stringify(returnedUrl)}, 50)</script>`
              : "<main>Projects</main>",
      }),
    );
    await product.goto("https://product.test/login");
    const controller = BrowserController.fromHarnessPage(product);
    try {
      await expect(controller.loginWithOAuth("#oauth", 800, "google")).resolves.toBeUndefined();
      expect(controller.currentUrl()).toBe(returnedUrl);
    } finally {
      await context.close();
    }
  });

  it("waits through a stable owned callback before completing on its dashboard", async () => {
    const context = await browser.newContext();
    const product = await context.newPage();
    const dashboardUrl = "https://resend.test/emails";
    const callbackUrl = `https://resend.test/auth/callback?redirect_uri=${encodeURIComponent(dashboardUrl)}`;
    const providerUrl = `https://accounts.google.com/provider?redirect_uri=${encodeURIComponent(callbackUrl)}`;
    await context.route("**/*", (route) => {
      const url = route.request().url();
      return route.fulfill({
        contentType: "text/html",
        body:
          url === "https://resend.test/signup"
            ? `<button id="oauth" onclick='location.href=${JSON.stringify(providerUrl)}'>Continue</button>`
            : url.startsWith("https://accounts.google.com/")
              ? `<script>location.href=${JSON.stringify(callbackUrl)}</script>`
              : url === callbackUrl
                ? `<script>setTimeout(() => location.replace(${JSON.stringify(dashboardUrl)}), 120)</script>`
                : "<main>Emails</main>",
      });
    });
    await product.goto("https://resend.test/signup");
    const controller = BrowserController.fromHarnessPage(product);
    try {
      await expect(controller.loginWithOAuth("#oauth", 800, "google")).resolves.toBeUndefined();
      expect(controller.currentUrl()).toBe(dashboardUrl);
    } finally {
      await context.close();
    }
  });

  it("keeps an unchanged observed OAuth target valid while it waits behind the shared lane", async () => {
    const previousTimeout = process.env.TRUSTY_SQUIRE_OAUTH_ACTION_TIMEOUT_MS;
    const previousCooldown = process.env.TRUSTY_SQUIRE_OAUTH_LOGIN_COOLDOWN_MS;
    process.env.TRUSTY_SQUIRE_OAUTH_ACTION_TIMEOUT_MS = "3000";
    process.env.TRUSTY_SQUIRE_OAUTH_LOGIN_COOLDOWN_MS = "0";
    const sessions: Array<{ context: Awaited<ReturnType<typeof browser.newContext>>; id: string }> =
      [];
    const startOAuthFixture = async (name: string, providerDelayMs: number) => {
      const context = await browser.newContext();
      const product = await context.newPage();
      const productUrl = `https://${name}.queue.test/login`;
      const returnUrl = `https://${name}.queue.test/dashboard`;
      const providerUrl = `https://accounts.google.com/${name}?redirect_uri=${encodeURIComponent(returnUrl)}`;
      await context.route("**/*", (route) => {
        const url = route.request().url();
        return route.fulfill({
          contentType: "text/html",
          body:
            url === productUrl
              ? `<button id="oauth" onclick='window.open(${JSON.stringify(providerUrl)})'>Continue with Google</button>`
              : url.startsWith(`https://accounts.google.com/${name}`)
                ? `<script>setTimeout(() => location.replace(${JSON.stringify(returnUrl)}), ${providerDelayMs})</script>`
                : "<main>Authenticated dashboard</main>",
        });
      });
      await product.goto(productUrl);
      const controller = BrowserController.fromHarnessPage(product);
      const started = await startHarnessProvisionSession({
        browser: controller,
        serviceUrl: productUrl,
        observationFormat: "browser-use-dom",
      });
      const ref = started.dom?.match(/@e:[A-Za-z0-9_-]+/)?.[0];
      expect(ref).toBeDefined();
      sessions.push({ context, id: started.session_id });
      return { product, id: started.session_id, ref: ref!, returnUrl };
    };

    try {
      const immediate = await startOAuthFixture("immediate", 0);
      sessionForCall(immediate.id)!.compactV2Index!.expiresAt = Date.now() + 200;
      await expect(
        act(immediate.id, { kind: "oauth_login", target: immediate.ref, provider: "google" }),
      ).resolves.toMatchObject({ url: immediate.returnUrl });

      const blocker = await startOAuthFixture("blocker", 700);
      const queued = await startOAuthFixture("queued", 0);
      const blockerPopup = blocker.product.waitForEvent("popup");
      const blockingLogin = act(blocker.id, {
        kind: "oauth_login",
        target: blocker.ref,
        provider: "google",
      });
      await blockerPopup;
      sessionForCall(queued.id)!.compactV2Index!.expiresAt = Date.now() + 100;
      const queuedLogin = act(queued.id, {
        kind: "oauth_login",
        target: queued.ref,
        provider: "google",
      });

      await expect(blockingLogin).resolves.toMatchObject({ url: blocker.returnUrl });
      await expect(queuedLogin).resolves.toMatchObject({ url: queued.returnUrl });
    } finally {
      if (previousTimeout === undefined) delete process.env.TRUSTY_SQUIRE_OAUTH_ACTION_TIMEOUT_MS;
      else process.env.TRUSTY_SQUIRE_OAUTH_ACTION_TIMEOUT_MS = previousTimeout;
      if (previousCooldown === undefined) delete process.env.TRUSTY_SQUIRE_OAUTH_LOGIN_COOLDOWN_MS;
      else process.env.TRUSTY_SQUIRE_OAUTH_LOGIN_COOLDOWN_MS = previousCooldown;
      for (const session of sessions.reverse()) {
        await finishProvisionSession(session.id);
        await session.context.close();
      }
    }
  });

  it("rejects a compact OAuth target replaced during recovery-page setup", async () => {
    const context = await browser.newContext();
    const product = await context.newPage();
    const productUrl = "https://setup-gap.test/login";
    const providerUrl = `https://accounts.google.com/provider?redirect_uri=${encodeURIComponent(
      "https://setup-gap.test/dashboard",
    )}`;
    let sessionId: string | undefined;
    await context.route("**/*", (route) => {
      const url = route.request().url();
      if (url === productUrl) {
        return route.fulfill({
          contentType: "text/html",
          body: `<button id="oauth" onclick='location.href=${JSON.stringify(providerUrl)}'>Continue with Google</button>`,
        });
      }
      return route.fulfill({ contentType: "text/html", body: "<main>Provider</main>" });
    });
    await product.goto(productUrl);
    const controller = BrowserController.fromHarnessPage(product);
    try {
      const started = await startHarnessProvisionSession({
        browser: controller,
        serviceUrl: productUrl,
        observationFormat: "browser-use-dom",
      });
      sessionId = started.session_id;
      const ref = started.dom?.match(/@e:[A-Za-z0-9_-]+/)?.[0];
      expect(ref).toBeDefined();
      const createRecoveryPage = context.newPage.bind(context);
      const recoverySetup = vi.spyOn(context, "newPage").mockImplementation(async () => {
        const recovery = await createRecoveryPage();
        await product.locator("#oauth").evaluate((element) => {
          element.outerHTML =
            '<button id="oauth" onclick="document.body.dataset.danger = \'clicked\'">Delete account</button>';
        });
        return recovery;
      });
      const prepared = preparePublicOAuthLoginTarget(sessionId, ref!);
      expect(prepared).toBeDefined();
      await expect(
        withPreparedOAuthLoginTarget(prepared!, () =>
          act(sessionId!, { kind: "oauth_login", target: ref!, provider: "google" }),
        ),
      ).rejects.toBeInstanceOf(ProvenPreDispatchMutationError);
      recoverySetup.mockRestore();
      expect(await product.locator("body").getAttribute("data-danger")).toBeNull();
    } finally {
      if (sessionId !== undefined) await finishProvisionSession(sessionId);
      await context.close();
    }
  });

  it("rejects a same-selector OAuth replacement at click dispatch", async () => {
    const context = await browser.newContext();
    const product = await context.newPage();
    const productUrl = "https://dispatch-gap.test/login";
    const providerUrl = `https://accounts.google.com/provider?redirect_uri=${encodeURIComponent(
      "https://dispatch-gap.test/dashboard",
    )}`;
    let sessionId: string | undefined;
    await context.route("**/*", (route) => {
      const url = route.request().url();
      if (url === productUrl) {
        return route.fulfill({
          contentType: "text/html",
          body: `<button id="oauth" onclick='location.href=${JSON.stringify(providerUrl)}'>Continue with Google</button>`,
        });
      }
      return route.fulfill({ contentType: "text/html", body: "<main>Provider</main>" });
    });
    await product.goto(productUrl);
    const controller = BrowserController.fromHarnessPage(product);
    try {
      const started = await startHarnessProvisionSession({
        browser: controller,
        serviceUrl: productUrl,
        observationFormat: "browser-use-dom",
      });
      sessionId = started.session_id;
      const ref = started.dom?.match(/@e:[A-Za-z0-9_-]+/)?.[0];
      expect(ref).toBeDefined();
      const matchesTarget = controller.matchesOAuthClickTarget.bind(controller);
      const dispatch = vi
        .spyOn(controller, "matchesOAuthClickTarget")
        .mockImplementation(async (handle, selector) => {
          await product.locator("#oauth").evaluate((element) => {
            element.outerHTML =
              '<button id="oauth" onclick="document.body.dataset.danger = \'clicked\'">Delete account</button>';
          });
          return await matchesTarget(handle, selector);
        });
      const prepared = preparePublicOAuthLoginTarget(sessionId, ref!);
      expect(prepared).toBeDefined();
      await expect(
        withPreparedOAuthLoginTarget(prepared!, () =>
          act(sessionId!, { kind: "oauth_login", target: ref!, provider: "google" }),
        ),
      ).rejects.toBeInstanceOf(ProvenPreDispatchMutationError);
      dispatch.mockRestore();
      expect(await product.locator("body").getAttribute("data-danger")).toBeNull();
    } finally {
      if (sessionId !== undefined) await finishProvisionSession(sessionId);
      await context.close();
    }
  });

  it("rejects changed OAuth intent on the same node after actionability", async () => {
    const context = await browser.newContext();
    const product = await context.newPage();
    const productUrl = "https://intent-gap.test/login";
    const providerUrl = `https://accounts.google.com/provider?redirect_uri=${encodeURIComponent(
      "https://intent-gap.test/dashboard",
    )}`;
    let sessionId: string | undefined;
    await context.route("**/*", (route) =>
      route.fulfill({
        contentType: "text/html",
        body:
          route.request().url() === productUrl
            ? `<button id="oauth" onclick='location.href=${JSON.stringify(providerUrl)}'>Continue with Google</button>`
            : "<main>Provider</main>",
      }),
    );
    await product.goto(productUrl);
    const controller = BrowserController.fromHarnessPage(product);
    try {
      const started = await startHarnessProvisionSession({
        browser: controller,
        serviceUrl: productUrl,
        observationFormat: "browser-use-dom",
      });
      sessionId = started.session_id;
      const ref = started.dom?.match(/@e:[A-Za-z0-9_-]+/)?.[0];
      expect(ref).toBeDefined();
      const matchesTarget = controller.matchesOAuthClickTarget.bind(controller);
      const dispatch = vi
        .spyOn(controller, "matchesOAuthClickTarget")
        .mockImplementation(async (handle, selector) => {
          await product.locator("#oauth").evaluate((element) => {
            element.textContent = "Delete account";
            element.setAttribute("onclick", "document.body.dataset.danger = 'clicked'");
          });
          return await matchesTarget(handle, selector);
        });
      const prepared = preparePublicOAuthLoginTarget(sessionId, ref!);
      expect(prepared).toBeDefined();
      await expect(
        withPreparedOAuthLoginTarget(prepared!, () =>
          act(sessionId!, { kind: "oauth_login", target: ref!, provider: "google" }),
        ),
      ).rejects.toBeInstanceOf(ProvenPreDispatchMutationError);
      dispatch.mockRestore();
      expect(await product.locator("body").getAttribute("data-danger")).toBeNull();
    } finally {
      if (sessionId !== undefined) await finishProvisionSession(sessionId);
      await context.close();
    }
  });

  it("rejects an owned return chain longer than callback then dashboard", async () => {
    const context = await browser.newContext();
    const product = await context.newPage();
    const dashboardUrl = "https://resend.test/emails";
    const secondCallbackUrl = `https://resend.test/auth/exchange?redirect_uri=${encodeURIComponent(dashboardUrl)}`;
    const firstCallbackUrl = `https://resend.test/auth/callback?redirect_uri=${encodeURIComponent(secondCallbackUrl)}`;
    const providerUrl = `https://accounts.google.com/provider?redirect_uri=${encodeURIComponent(firstCallbackUrl)}`;
    await context.route("**/*", (route) => {
      const url = route.request().url();
      return route.fulfill({
        contentType: "text/html",
        body:
          url === "https://resend.test/signup"
            ? `<button id="oauth" onclick='location.href=${JSON.stringify(providerUrl)}'>Continue</button>`
            : url === providerUrl
              ? `<script>location.href=${JSON.stringify(firstCallbackUrl)}</script>`
              : url === firstCallbackUrl
                ? `<script>location.href=${JSON.stringify(secondCallbackUrl)}</script>`
                : url === secondCallbackUrl
                  ? `<script>setTimeout(() => location.replace(${JSON.stringify(dashboardUrl)}), 120)</script>`
                  : "<main>Emails</main>",
      });
    });
    await product.goto("https://resend.test/signup");
    const controller = BrowserController.fromHarnessPage(product);
    try {
      await expect(controller.loginWithOAuth("#oauth", 500, "google")).rejects.toBeInstanceOf(
        OAuthAwaitingHumanError,
      );
      expect(controller.currentUrl()).toBe(dashboardUrl);
    } finally {
      await context.close();
    }
  });

  it("does not complete when a stable intermediate callback returns to login", async () => {
    const context = await browser.newContext();
    const product = await context.newPage();
    const dashboardUrl = "https://resend.test/emails";
    const loginUrl = "https://resend.test/login";
    const callbackUrl = `https://resend.test/auth/callback?redirect_uri=${encodeURIComponent(dashboardUrl)}`;
    const providerUrl = `https://accounts.google.com/provider?redirect_uri=${encodeURIComponent(callbackUrl)}`;
    await context.route("**/*", (route) => {
      const url = route.request().url();
      return route.fulfill({
        contentType: "text/html",
        body:
          url === "https://resend.test/signup"
            ? `<button id="oauth" onclick='location.href=${JSON.stringify(providerUrl)}'>Continue</button>`
            : url === providerUrl
              ? `<script>location.href=${JSON.stringify(callbackUrl)}</script>`
              : url === callbackUrl
                ? `<script>setTimeout(() => location.replace(${JSON.stringify(loginUrl)}), 120)</script>`
                : "<main>Login</main>",
      });
    });
    await product.goto("https://resend.test/signup");
    const controller = BrowserController.fromHarnessPage(product);
    try {
      await expect(controller.loginWithOAuth("#oauth", 500, "google")).rejects.toBeInstanceOf(
        OAuthAwaitingHumanError,
      );
      expect(controller.currentUrl()).toBe(loginUrl);
    } finally {
      await context.close();
    }
  });

  it("keeps an unrelated same-origin page pending after an owned OAuth callback", async () => {
    const context = await browser.newContext();
    const product = await context.newPage();
    const dashboardUrl = "https://resend.test/emails";
    const unrelatedUrl = "https://resend.test/settings";
    const callbackUrl = `https://resend.test/auth/callback?redirect_uri=${encodeURIComponent(dashboardUrl)}`;
    const providerUrl = `https://accounts.google.com/provider?redirect_uri=${encodeURIComponent(callbackUrl)}`;
    await context.route("**/*", (route) => {
      const url = route.request().url();
      return route.fulfill({
        contentType: "text/html",
        body:
          url === "https://resend.test/signup"
            ? `<button id="oauth" onclick='location.href=${JSON.stringify(providerUrl)}'>Continue</button>`
            : url.startsWith("https://accounts.google.com/")
              ? `<script>location.href=${JSON.stringify(callbackUrl)}</script>`
              : url === callbackUrl
                ? `<script>location.replace(${JSON.stringify(unrelatedUrl)})</script>`
                : "<main>Settings</main>",
      });
    });
    await product.goto("https://resend.test/signup");
    const controller = BrowserController.fromHarnessPage(product);
    try {
      await expect(controller.loginWithOAuth("#oauth", 500, "google")).rejects.toBeInstanceOf(
        OAuthAwaitingHumanError,
      );
      expect(controller.currentUrl()).toBe(unrelatedUrl);
    } finally {
      await context.close();
    }
  });

  it("does not accept a delayed callback in a provider-origin return cycle", async () => {
    const context = await browser.newContext();
    const product = await context.newPage();
    const providerBaseUrl = "https://accounts.google.com/provider";
    const providerReturnUrl = "https://accounts.google.com/oauth/authorize";
    const callbackUrl = `https://resend.test/auth/callback?redirect_uri=${encodeURIComponent(providerReturnUrl)}`;
    const providerStartUrl = `${providerBaseUrl}?redirect_uri=${encodeURIComponent(callbackUrl)}`;
    let providerVisits = 0;
    await context.route("**/*", (route) => {
      const url = route.request().url();
      if (url === "https://resend.test/signup") {
        return route.fulfill({
          contentType: "text/html",
          body: `<button id="oauth" onclick='window.open(${JSON.stringify(providerStartUrl)})'>Continue</button>`,
        });
      }
      if (url === providerStartUrl) {
        return route.fulfill({ status: 302, headers: { location: providerBaseUrl } });
      }
      return route.fulfill({
        contentType: "text/html",
        body:
          url === providerBaseUrl
            ? ++providerVisits === 1
              ? `<script>location.href=${JSON.stringify(callbackUrl)}</script>`
              : "<main>Provider</main>"
            : url === callbackUrl
              ? `<script>setTimeout(() => location.replace(${JSON.stringify(providerReturnUrl)}), 120)</script>`
              : "<main>Provider</main>",
      });
    });
    await product.goto("https://resend.test/signup");
    const controller = BrowserController.fromHarnessPage(product);
    const completion = { check: undefined as undefined | (() => Promise<unknown>) };
    try {
      await expect(
        controller.loginWithOAuth("#oauth", 500, undefined, undefined, (check) => {
          completion.check = check;
        }),
      ).rejects.toBeInstanceOf(OAuthAwaitingHumanError);
      expect(completion.check).toBeDefined();
      await expect(completion.check?.()).resolves.toBeNull();
      expect(controller.currentUrl()).toBe("https://resend.test/signup");
    } finally {
      await context.close();
    }
  });

  it("invalidates a callback chain that cycles to a query variant of its provider", async () => {
    const context = await browser.newContext();
    const product = await context.newPage();
    const providerUrl = "https://accounts.google.com/provider";
    const providerVariantUrl = `${providerUrl}?prompt=none`;
    const callbackUrl = `https://resend.test/auth/callback?redirect_uri=${encodeURIComponent(providerVariantUrl)}`;
    const providerStartUrl = `${providerUrl}?redirect_uri=${encodeURIComponent(callbackUrl)}`;
    await context.route("**/*", (route) => {
      const url = route.request().url();
      return route.fulfill({
        contentType: "text/html",
        body:
          url === "https://resend.test/signup"
            ? `<button id="oauth" onclick='location.href=${JSON.stringify(providerStartUrl)}'>Continue</button>`
            : url === providerStartUrl
              ? `<script>location.href=${JSON.stringify(callbackUrl)}</script>`
              : url === callbackUrl
                ? `<script>setTimeout(() => location.replace(${JSON.stringify(providerVariantUrl)}), 120)</script>`
                : "<main>Provider</main>",
      });
    });
    await product.goto("https://resend.test/signup");
    const controller = BrowserController.fromHarnessPage(product);
    try {
      await expect(controller.loginWithOAuth("#oauth", 500, "google")).rejects.toBeInstanceOf(
        OAuthAwaitingHumanError,
      );
      expect(controller.currentUrl()).toBe(providerVariantUrl);
    } finally {
      await context.close();
    }
  });

  it("rejects a cross-provider destination anywhere in the owned return chain", async () => {
    const context = await browser.newContext();
    const product = await context.newPage();
    const foreignProviderUrl = "https://accounts.google.com/consent";
    const callbackUrl = `https://resend.test/auth/callback?redirect_uri=${encodeURIComponent(
      foreignProviderUrl,
    )}`;
    const providerUrl = `https://github.com/login/oauth/authorize?redirect_uri=${encodeURIComponent(
      callbackUrl,
    )}`;
    await context.route("**/*", (route) => {
      const url = route.request().url();
      return route.fulfill({
        contentType: "text/html",
        body:
          url === "https://resend.test/signup"
            ? `<button id="oauth" onclick='location.href=${JSON.stringify(providerUrl)}'>Continue</button>`
            : url === providerUrl
              ? `<script>location.href=${JSON.stringify(callbackUrl)}</script>`
              : url === callbackUrl
                ? `<script>location.replace(${JSON.stringify(foreignProviderUrl)})</script>`
                : "<main>Google consent</main>",
      });
    });
    await product.goto("https://resend.test/signup");
    const controller = BrowserController.fromHarnessPage(product);
    try {
      await expect(controller.loginWithOAuth("#oauth", 500)).rejects.toBeInstanceOf(
        OAuthAwaitingHumanError,
      );
      expect(controller.currentUrl()).toBe(foreignProviderUrl);
    } finally {
      await context.close();
    }
  });

  it("keeps providerless replay nonterminal for an unrecognized product mediator", async () => {
    const context = await browser.newContext();
    const product = await context.newPage();
    const providerUrl = "https://accounts.google.com/provider";
    const mediatorUrl = `https://auth.resend.test/start?redirect_uri=${encodeURIComponent(providerUrl)}`;
    await context.route("**/*", (route) => {
      const url = route.request().url();
      return route.fulfill({
        contentType: "text/html",
        body:
          url === "https://app.resend.test/signup"
            ? `<button id="oauth" onclick='location.href=${JSON.stringify(mediatorUrl)}'>Continue</button>`
            : url === mediatorUrl
              ? `<script>location.href=${JSON.stringify(providerUrl)}</script>`
              : "<main>Provider</main>",
      });
    });
    await product.goto("https://app.resend.test/signup");
    const controller = BrowserController.fromHarnessPage(product);
    try {
      await expect(controller.loginWithOAuth("#oauth", 500)).rejects.toBeInstanceOf(
        OAuthAwaitingHumanError,
      );
      expect(controller.currentUrl()).toBe(providerUrl);
    } finally {
      await context.close();
    }
  });

  it("does not attribute a product auth-start redirect as the provider root", async () => {
    const context = await browser.newContext();
    const product = await context.newPage();
    const providerUrl = "https://accounts.google.com/provider";
    const productStartUrl = `https://resend.test/auth/start?redirect_uri=${encodeURIComponent(providerUrl)}`;
    await context.route("**/*", (route) => {
      const url = route.request().url();
      return route.fulfill({
        contentType: "text/html",
        body:
          url === "https://resend.test/signup"
            ? `<button id="oauth" onclick='location.href=${JSON.stringify(productStartUrl)}'>Continue</button>`
            : url === productStartUrl
              ? `<script>location.href=${JSON.stringify(providerUrl)}</script>`
              : "<main>Google</main>",
      });
    });
    await product.goto("https://resend.test/signup");
    const controller = BrowserController.fromHarnessPage(product);
    const completion = { check: undefined as undefined | (() => Promise<unknown>) };
    try {
      await expect(
        controller.loginWithOAuth("#oauth", 500, "google", undefined, (check) => {
          completion.check = check;
        }),
      ).rejects.toBeInstanceOf(OAuthAwaitingHumanError);
      expect(completion.check).toBeDefined();
      await expect(completion.check?.()).resolves.toBeNull();
      expect(controller.currentUrl()).toBe(providerUrl);
    } finally {
      await context.close();
    }
  });

  it("does not extend the owned return chain from later nested navigations", async () => {
    const context = await browser.newContext();
    const product = await context.newPage();
    const dashboardUrl = "https://resend.test/emails";
    const laterCallbackUrl = `https://resend.test/auth/later?redirect_uri=${encodeURIComponent(dashboardUrl)}`;
    const firstCallbackUrl = "https://resend.test/auth/first";
    const providerUrl = `https://accounts.google.com/provider?redirect_uri=${encodeURIComponent(firstCallbackUrl)}`;
    await context.route("**/*", (route) => {
      const url = route.request().url();
      return route.fulfill({
        contentType: "text/html",
        body:
          url === "https://resend.test/signup"
            ? `<button id="oauth" onclick='location.href=${JSON.stringify(providerUrl)}'>Continue</button>`
            : url === providerUrl
              ? `<script>location.href=${JSON.stringify(firstCallbackUrl)}</script>`
              : url === firstCallbackUrl
                ? `<script>location.href=${JSON.stringify(laterCallbackUrl)}</script>`
                : url === laterCallbackUrl
                  ? `<script>location.replace(${JSON.stringify(dashboardUrl)})</script>`
                  : "<main>Emails</main>",
      });
    });
    await product.goto("https://resend.test/signup");
    const controller = BrowserController.fromHarnessPage(product);
    const completion = { check: undefined as undefined | (() => Promise<unknown>) };
    try {
      await expect(
        controller.loginWithOAuth("#oauth", 500, undefined, undefined, (check) => {
          completion.check = check;
        }),
      ).rejects.toBeInstanceOf(OAuthAwaitingHumanError);
      expect(completion.check).toBeDefined();
      await expect(completion.check?.()).resolves.toBeNull();
      expect(controller.currentUrl()).toBe(dashboardUrl);
    } finally {
      await context.close();
    }
  });

  it("completes a popup OAuth return to its same-origin callback", async () => {
    const context = await browser.newContext();
    const product = await context.newPage();
    const callbackUrl = "https://product.test/callback";
    await context.route("https://product.test/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body:
          route.request().url() === callbackUrl
            ? "<main>Signed in</main>"
            : `<button id="oauth" onclick='window.open(${JSON.stringify(
                `https://accounts.google.com/provider?redirect_uri=${encodeURIComponent(callbackUrl)}`,
              )})'>Continue</button>`,
      }),
    );
    await context.route("https://accounts.google.com/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<script>setTimeout(() => opener.location.href=${JSON.stringify(callbackUrl)}, 50)</script>`,
      }),
    );
    await product.goto("https://product.test/login");
    const controller = BrowserController.fromHarnessPage(product);
    try {
      await expect(controller.loginWithOAuth("#oauth", 1_500, "google")).resolves.toBeUndefined();
      expect(controller.currentUrl()).toBe(callbackUrl);
    } finally {
      await context.close();
    }
  });

  it.each(["oauth_login", "oauth_click"] as const)(
    "returns a popup OAuth completion from its initiated destination document (%s)",
    async (kind) => {
      const context = await browser.newContext();
      const product = await context.newPage();
      const productUrl = "https://mail.google.com/checkout";
      const expectedReturnUrl = "https://console.product.test/checkout";
      const cartUrl = "https://console.product.test/cart";
      const controls = `<form onsubmit="event.preventDefault(); document.body.dataset.submits = String(+(document.body.dataset.submits || 0) + 1)">
        <label>Project name<input id="name"></label><button>Create</button></form>
        <label>Phone country
          <select id="phone-country" name="phone_country">
            <option value="CA" selected>Canada (+1)</option>
            <option value="US">United States (+1)</option>
          </select>
        </label>
        <label>Workspace
          <select id="workspace" name="workspace" data-testid="workspace">
            <option value="alpha" selected>Alpha</option>
            <option value="beta">Beta</option>
          </select>
        </label>
        <label>Region
          <select id="region" name="region" data-testid="region">
            <option value="us" selected>US</option>
            <option value="eu">EU</option>
          </select>
        </label>
        <label>Replay name<input id="replay-name" name="full_name" type="text" autocomplete="name" data-testid="replay-name"></label>
        <input type="hidden" name="__CHECKOUT_FIELD__">
        <div>Total USD $__TOTAL__</div>
        <div>API Key <span id="credential">••••</span><button id="reveal" onclick="document.querySelector('#credential').textContent = window.credentialValue">Show API key</button></div>
        <button id="add" onclick="window.open('${cartUrl}')">Add to Cart</button>
        <div id="line" data-testid="line-item" hidden>
          <a href="/products/popup" data-product-identity="popup-product">Popup product</a>
          <span>Quantity 1</span><span data-options-hash="popup-options"></span>
        </div>
        <button id="open-new-tab" onclick="window.open('https://console.product.test/opened')">Open settings</button>
        <button id="open-replay-tab" onclick="window.open('https://console.product.test/replay-opened')">Open replay tab</button>
        <div style="height:4000px"></div>
        <script>
          document.body.dataset.enters = '0';
          document.body.dataset.scrolls = '0';
          window.credentialValue = '__CREDENTIAL__';
          document.addEventListener('keydown', e => {
            if (e.key === 'Enter') document.body.dataset.enters = String(+document.body.dataset.enters + 1);
          });
          window.addEventListener('scroll', () => document.body.dataset.scrolls = String(+document.body.dataset.scrolls + 1));
          const nativeFetch = window.fetch.bind(window);
          window.fetch = (...args) => {
            if (new URL(args[0], location.href).pathname === '/cart/clear.js') {
              document.body.dataset.cartClears = String(+(document.body.dataset.cartClears || 0) + 1);
            }
            return nativeFetch(...args);
          };
        </script>`;
      await context.route("https://mail.google.com/**", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<button id="oauth" onclick='window.open(${JSON.stringify(
            `https://accounts.google.com/provider?redirect_uri=${encodeURIComponent(expectedReturnUrl)}`,
          )})'>Continue</button>${controls
            .replaceAll("__CHECKOUT_FIELD__", "product_checkout_marker")
            .replaceAll("__TOTAL__", "99.99")
            .replaceAll("__CREDENTIAL__", "sk_product_abcdefgh1234567890")}`,
        }),
      );
      await context.route("https://accounts.google.com/**", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<script>setTimeout(() => location.href=${JSON.stringify(expectedReturnUrl)}, 50)</script>`,
        }),
      );
      await context.route("https://console.product.test/**", (route) => {
        const sourceControls = controls
          .replaceAll("__CHECKOUT_FIELD__", "source_checkout_marker")
          .replaceAll("__TOTAL__", "12.34")
          .replaceAll("__CREDENTIAL__", "sk_source_abcdefgh1234567890");
        return route.fulfill({
          contentType: "text/html",
          body:
            route.request().url() === "https://console.product.test/opened"
              ? '<label>Opened setting<input id="opened-setting"></label>'
              : route.request().url() === "https://console.product.test/replay-opened"
                ? '<main>Projects</main><label>Replay name<input id="replay-name" name="full_name" type="text" autocomplete="name" data-testid="replay-name"></label><button id="open-new-tab" onclick="window.open(\'https://console.product.test/opened\')">Open settings</button>'
                : route.request().url() === cartUrl
                  ? `<main>Projects</main>${sourceControls}<script>document.querySelector('#line')?.removeAttribute('hidden')</script>`
                  : `<main>Projects</main><button>New project</button>${sourceControls}`,
        });
      });
      await product.goto(productUrl);
      const productCredentialBefore = await product.locator("#credential").textContent();
      const controller = BrowserController.fromHarnessPage(product);
      let sessionId: string | undefined;
      try {
        const started = await startHarnessProvisionSession({
          browser: controller,
          serviceUrl: productUrl,
        });
        sessionId = started.session_id;
        const oauthRef = parseElementsTable(started.el_table ?? "")[0]?.ref;
        expect(oauthRef).toBeDefined();
        const result = await act(sessionId, {
          kind,
          target: oauthRef!,
          provider: "google",
        });
        expect(result.url).toBe(expectedReturnUrl);
        expect(result.text).toContain("Projects");
        expect((controller as unknown as { page: Page }).page).toBe(product);
        const source = controller.completedOAuthPage()!;
        expect(source.url()).toBe(expectedReturnUrl);
        const reobserved = await observe(sessionId, "full");
        expect(reobserved.url).toBe(expectedReturnUrl);
        expect(reobserved.checkout_state?.payable_total).toEqual({
          amount_cents: 1234,
          currency: "USD",
        });
        expect(await product.locator("body").innerText()).toContain("Total USD $99.99");
        const screenshot = await captureScreenshot(sessionId);
        expect(screenshot.url).toBe(expectedReturnUrl);
        const postcondition = await verifyPostcondition(sessionId, {
          kind: "execute_capability",
          describe: "Projects are visible",
          success_signal: { text_present: "Projects" },
        });
        expect(postcondition).toMatchObject({ confirmed: true });
        const checkoutSignature = await checkoutShapeSignatureForSession(sessionId);
        const productSignature = checkoutFieldSetSignature(
          await product
            .locator("input,select,textarea")
            .evaluateAll((elements) =>
              elements
                .map((element) => element.getAttribute("name") ?? element.getAttribute("id") ?? "")
                .filter((name) => name.length > 0),
            ),
        );
        expect(checkoutSignature).not.toBe(productSignature);
        const extracted = await extractCredentials(sessionId);
        expect(extracted.url).toBe(expectedReturnUrl);
        expect(Object.values(extracted.credentials)).toContain("sk_source_abcdefgh1234567890");
        expect(await source.locator("#credential").textContent()).toBe(
          "sk_source_abcdefgh1234567890",
        );
        expect(await product.locator("#credential").textContent()).toBe(productCredentialBefore);
        await source.evaluate(() => {
          document.body.insertAdjacentHTML(
            "beforeend",
            '<div><span>••••</span><button id="concurrent-reveal" onclick="document.body.dataset.concurrentReveal = \'started\'; this.previousElementSibling.textContent = window.credentialValue">Show API key</button></div>',
          );
        });
        const concurrentExtract = extractCredentials(sessionId);
        await source.waitForFunction(() => document.body.dataset.concurrentReveal === "started");
        await controller.goto("https://mail.google.com/concurrent-original");
        expect(source.url()).toBe(expectedReturnUrl);
        expect(product.url()).toBe("https://mail.google.com/concurrent-original");
        expect(Object.values((await concurrentExtract).credentials)).toContain(
          "sk_source_abcdefgh1234567890",
        );
        await controller.goto(productUrl);
        const inputRef = parseElementsTable(result.el_table ?? "").find(
          (el) => el.label === "Project name",
        )?.ref;
        expect(inputRef).toBeDefined();
        await act(sessionId, { kind: "type", target: inputRef!, text: "Popup project" });
        expect(await source.locator("#name").inputValue()).toBe("Popup project");
        expect(await product.locator("#name").inputValue()).toBe("");
        expect(await controller.focusedElementLabels(source)).toContain("Project name");
        expect(await controller.focusedElementLabels(product)).not.toContain("Project name");
        const pressed = await act(sessionId, { kind: "press", key: "Enter" });
        expect(pressed.url).toBe(expectedReturnUrl);
        expect(await source.locator("body").getAttribute("data-enters")).toBe("1");
        expect(await source.locator("body").getAttribute("data-submits")).toBe("1");
        expect(await product.locator("body").getAttribute("data-enters")).toBe("0");
        expect(await product.locator("body").getAttribute("data-submits")).toBeNull();
        const scrolled = await act(sessionId, { kind: "scroll", direction: "bottom" });
        expect(scrolled.url).toBe(expectedReturnUrl);
        expect(await source.evaluate(() => scrollY)).toBeGreaterThan(0);
        expect(+(await source.locator("body").getAttribute("data-scrolls"))!).toBeGreaterThan(0);
        expect(await product.evaluate(() => scrollY)).toBe(0);
        expect(await product.locator("body").getAttribute("data-scrolls")).toBe("0");
        const countrySet = await act(sessionId, { kind: "set_phone_country", country: "US" });
        expect(countrySet.url).toBe(expectedReturnUrl);
        expect(await source.locator("#phone-country").inputValue()).toBe("US");
        expect(await product.locator("#phone-country").inputValue()).toBe("CA");
        const controlRefs = reobserved.elements ?? [];
        const workspaceRef = controlRefs.find(
          (el) => el.tag === "select" && el.testId === "workspace",
        )?.ref;
        const regionRef = controlRefs.find(
          (el) => el.tag === "select" && el.testId === "region",
        )?.ref;
        expect(workspaceRef).toBeDefined();
        expect(regionRef).toBeDefined();
        const selected = await formSelectMany(sessionId, {
          [workspaceRef!]: "beta",
          [regionRef!]: "eu",
        });
        expect(selected.observation.url).toBe(expectedReturnUrl);
        expect(await source.locator("#workspace").inputValue()).toBe("beta");
        expect(await source.locator("#region").inputValue()).toBe("eu");
        expect(await product.locator("#workspace").inputValue()).toBe("alpha");
        expect(await product.locator("#region").inputValue()).toBe("us");
        const cartPagePromise = source.waitForEvent("popup");
        const cart = await cartAdd(sessionId, "popup-product", "popup-options", "popup-cart");
        const cartPage = await cartPagePromise;
        expect(cart).toMatchObject({
          status: "added",
          cart_delta: "+1",
          postcondition: { quantity: 1 },
        });
        expect(cart.cart_url).toBe(cartUrl);
        expect(cartPage.url()).toBe(cartUrl);
        expect(await cartPage.locator("#line").isVisible()).toBe(true);
        expect(await source.locator("#line").isHidden()).toBe(true);
        expect(await product.locator("#line").isHidden()).toBe(true);
        await cartClear(sessionId);
        expect(await cartPage.locator("body").getAttribute("data-cart-clears")).toBe("1");
        expect(await source.locator("body").getAttribute("data-cart-clears")).toBeNull();
        expect(await product.locator("body").getAttribute("data-cart-clears")).toBeNull();
        const replayRecipe: OperatorRecipe = {
          name: "set-popup-contact",
          schema_version: 1,
          goal: "Set the contact name",
          verb: "configure",
          domain: "product.test",
          entry_url: expectedReturnUrl,
          allowed_hosts: ["console.product.test"],
          trace: [
            {
              action: {
                kind: "click",
                target: {
                  dom_hint: { id: "open-replay-tab" },
                  accessible_name: "Open replay tab",
                  css: "#open-replay-tab",
                },
              },
            },
            {
              action: {
                kind: "type",
                target: {
                  dom_hint: { testid: "replay-name", name: "full_name" },
                  accessible_name: "Replay name",
                  css: "#replay-name",
                  field_role: "ac:name",
                },
                value: { hole: "contact.name" },
              },
            },
          ],
          secrets: [],
          postcondition: {
            kind: "execute_capability",
            describe: "Contact name is set",
            success_signal: { text_present: "Projects" },
          },
        };
        const replayPagePromise = cartPage.waitForEvent("popup");
        const replayed = await replayOperatorRecipe(sessionId, replayRecipe, {
          "contact.name": "Popup replay",
        });
        const replayPage = await replayPagePromise;
        expect(replayed).toMatchObject({
          status: "complete",
          observation: { url: "https://console.product.test/replay-opened" },
        });
        expect(await replayPage.locator("#replay-name").inputValue()).toBe("Popup replay");
        expect(await cartPage.locator("#replay-name").inputValue()).toBe("");
        expect(await source.locator("#replay-name").inputValue()).toBe("");
        expect(await product.locator("#replay-name").inputValue()).toBe("");
        expect(
          sessionForCall(sessionId)?.actionTrace.some((entry) => entry.action.kind === "type"),
        ).toBe(true);
        const beforeOpen = await observe(sessionId, "full");
        const openRef = (beforeOpen.elements ?? []).find((el) => el.label === "Open settings")?.ref;
        expect(openRef).toBeDefined();
        const openedPagePromise = replayPage.waitForEvent("popup");
        const opened = await act(sessionId, { kind: "click", target: openRef! });
        const openedPage = await openedPagePromise;
        expect(opened.url).toBe("https://console.product.test/opened");
        expect(openedPage.url()).toBe("https://console.product.test/opened");
        const openedInputRef = parseElementsTable(opened.el_table ?? "").find(
          (el) => el.label === "Opened setting",
        )?.ref;
        expect(openedInputRef).toBeDefined();
        await act(sessionId, { kind: "type", target: openedInputRef!, text: "New tab setting" });
        expect(await openedPage.locator("#opened-setting").inputValue()).toBe("New tab setting");
        expect(source.url()).toBe(expectedReturnUrl);
        expect(cartPage.url()).toBe(cartUrl);
        expect(replayPage.url()).toBe("https://console.product.test/replay-opened");
        expect(product.url()).toBe(productUrl);
        const destination = "https://console.product.test/settings";
        await act(sessionId, { kind: "allow_host", host: "console.product.test" });
        const navigated = await act(sessionId, { kind: "goto", url: destination });
        expect(navigated.url).toBe(destination);
        expect(openedPage.url()).toBe(destination);
        expect(source.url()).toBe(expectedReturnUrl);
        expect(cartPage.url()).toBe(cartUrl);
        expect(replayPage.url()).toBe("https://console.product.test/replay-opened");
        expect(product.url()).toBe(productUrl);
      } finally {
        if (sessionId) await finishProvisionSession(sessionId);
        await context.close();
      }
    },
    20_000,
  );

  it("keeps concurrent inbox verification on its captured page after source-tab adoption", async () => {
    const context = await browser.newContext();
    const product = await context.newPage();
    const productUrl = "https://mail.google.com/product";
    const returnUrl = "https://console.product.test/return";
    const openedUrl = "https://console.product.test/opened";
    const previousTimeout = process.env.TRUSTY_SQUIRE_OAUTH_ACTION_TIMEOUT_MS;
    process.env.TRUSTY_SQUIRE_OAUTH_ACTION_TIMEOUT_MS = "5000";
    let sessionId: string | undefined;
    try {
      await context.route("https://mail.google.com/**", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<button id="oauth" onclick='window.open(${JSON.stringify(
            `https://accounts.google.com/provider?redirect_uri=${encodeURIComponent(returnUrl)}`,
          )})'>Continue</button>`,
        }),
      );
      await context.route("https://accounts.google.com/**", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<script>setTimeout(() => location.href=${JSON.stringify(returnUrl)}, 20)</script>`,
        }),
      );
      await context.route("https://console.product.test/**", (route) =>
        route.fulfill({
          contentType: "text/html",
          body:
            route.request().url() === openedUrl
              ? '<main>Opened operator tab</main><button id="queued-oauth" onclick="document.body.dataset.oauthClicked = \'1\'">Continue with Google</button>'
              : `<main>Returned operator tab</main><button id="open" onclick="window.open('${openedUrl}')">Open tab</button><button id="queued-oauth">Continue with Google</button>`,
        }),
      );
      await context.route("https://mail.google.com/mail/u/0/**", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<div role="link" id="mail-row" onclick="location.hash = 'search/verification/abcdefghijkl'">Verification message for the newly created operator account</div><main>Your verification code is 481920. This verification message remains available while the account setup finishes, so return to the operator after entering the code and continue configuring the new workspace.</main>`,
        }),
      );
      await product.goto(productUrl);
      const controller = BrowserController.fromHarnessPage(product);
      const started = await startHarnessProvisionSession({
        browser: controller,
        serviceUrl: productUrl,
      });
      sessionId = started.session_id;
      const oauthRef = parseElementsTable(started.el_table ?? "")[0]?.ref;
      expect(oauthRef).toBeDefined();
      const returned = await act(sessionId, {
        kind: "oauth_login",
        target: oauthRef!,
        provider: "google",
      });
      const source = controller.completedOAuthPage()!;
      const openRef = parseElementsTable(returned.el_table ?? "").find(
        (element) => element.label === "Open tab",
      )?.ref;
      const queuedOauthRef = parseElementsTable(returned.el_table ?? "").find(
        (element) => element.label === "Continue with Google",
      )?.ref;
      expect(openRef).toBeDefined();
      expect(queuedOauthRef).toBeDefined();

      let enteredInbox!: () => void;
      let resumeInbox!: () => void;
      const inboxEntered = new Promise<void>((resolve) => {
        enteredInbox = resolve;
      });
      const inboxResume = new Promise<void>((resolve) => {
        resumeInbox = resolve;
      });
      const originalTemporaryScope = controller.withTemporaryHostScopeAllowedHosts.bind(controller);
      const temporaryScopeSpy = vi
        .spyOn(controller, "withTemporaryHostScopeAllowedHosts")
        .mockImplementation(
          async <T>(hosts: readonly string[], operation: () => Promise<T>): Promise<T> => {
            if (hosts.includes("mail.google.com")) {
              enteredInbox();
              await inboxResume;
            }
            return await originalTemporaryScope(hosts, operation);
          },
        );

      const verification = awaitVerification(sessionId);
      await inboxEntered;
      const queuedOauth = act(sessionId, {
        kind: "oauth_login",
        target: queuedOauthRef!,
        provider: "google",
      });
      const openedPagePromise = source.waitForEvent("popup");
      const opened = await act(sessionId, { kind: "click", target: openRef! });
      const openedPage = await openedPagePromise;
      expect(opened.url).toBe(openedUrl);
      resumeInbox();
      const result = await verification;
      temporaryScopeSpy.mockRestore();

      expect(result).toMatchObject({ found: true, code: "481920" });
      await expect(queuedOauth).rejects.toBeInstanceOf(ProvenPreDispatchMutationError);
      expect(source.url()).toContain("mail.google.com/mail/u/0/#search/");
      expect(product.url()).toBe(productUrl);
      expect(openedPage.url()).toBe(openedUrl);
      expect(await openedPage.locator("main").innerText()).toBe("Opened operator tab");
      expect(await openedPage.locator("body").getAttribute("data-oauth-clicked")).toBeNull();
    } finally {
      if (previousTimeout === undefined) delete process.env.TRUSTY_SQUIRE_OAUTH_ACTION_TIMEOUT_MS;
      else process.env.TRUSTY_SQUIRE_OAUTH_ACTION_TIMEOUT_MS = previousTimeout;
      if (sessionId) await finishProvisionSession(sessionId);
      await context.close();
    }
  }, 20_000);

  it("keeps concurrent source-page clicks paired with their own tabs", async () => {
    const context = await browser.newContext();
    const product = await context.newPage();
    const productUrl = "https://product.test/login";
    const returnUrl = "https://console.product.test/return";
    const firstUrl = "https://console.product.test/first";
    const secondUrl = "https://console.product.test/second";
    let sessionId: string | undefined;
    try {
      await context.route("https://product.test/**", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<button id="oauth" onclick='window.open(${JSON.stringify(
            `https://accounts.google.com/provider?redirect_uri=${encodeURIComponent(returnUrl)}`,
          )})'>Continue</button>`,
        }),
      );
      await context.route("https://accounts.google.com/**", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<script>location.replace(${JSON.stringify(returnUrl)})</script>`,
        }),
      );
      await context.route("https://console.product.test/**", (route) => {
        const url = route.request().url();
        const body =
          url === firstUrl
            ? "<main>First tab</main>"
            : url === secondUrl
              ? "<main>Second tab</main>"
              : `<button id="first" onclick="window.open('${firstUrl}')">Open first tab</button><button id="second" onclick="window.open('${secondUrl}')">Open second tab</button>`;
        return route.fulfill({ contentType: "text/html", body });
      });
      await product.goto(productUrl);
      const controller = BrowserController.fromHarnessPage(product);
      const started = await startHarnessProvisionSession({
        browser: controller,
        serviceUrl: productUrl,
      });
      sessionId = started.session_id;
      const oauthRef = parseElementsTable(started.el_table ?? "")[0]?.ref;
      expect(oauthRef).toBeDefined();
      const returned = await act(sessionId, {
        kind: "oauth_login",
        target: oauthRef!,
        provider: "google",
      });
      const firstRef = parseElementsTable(returned.el_table ?? "").find(
        (element) => element.label === "Open first tab",
      )?.ref;
      const secondRef = parseElementsTable(returned.el_table ?? "").find(
        (element) => element.label === "Open second tab",
      )?.ref;
      expect(firstRef).toBeDefined();
      expect(secondRef).toBeDefined();

      let firstAdoptionEntered!: () => void;
      let resumeFirstAdoption!: () => void;
      const firstAdoption = new Promise<void>((resolve) => {
        firstAdoptionEntered = resolve;
      });
      const firstAdoptionResume = new Promise<void>((resolve) => {
        resumeFirstAdoption = resolve;
      });
      const originalAdopt = controller.adoptOpenedTab.bind(controller);
      let firstCall = true;
      const adoptionSpy = vi
        .spyOn(controller, "adoptOpenedTab")
        .mockImplementation(async (graceMs?: number): Promise<string | null> => {
          if (firstCall) {
            firstCall = false;
            firstAdoptionEntered();
            await firstAdoptionResume;
          }
          return await originalAdopt(graceMs);
        });

      const first = act(sessionId, { kind: "click", target: firstRef! });
      await firstAdoption;
      const second = act(sessionId, { kind: "click", target: secondRef! });
      resumeFirstAdoption();
      const [firstResult, secondResult] = await Promise.all([first, second]);
      adoptionSpy.mockRestore();

      expect(firstResult.url).toBe(firstUrl);
      expect(secondResult.url).toBe(secondUrl);
      await expect(
        context
          .pages()
          .find((page) => page.url() === firstUrl)!
          .locator("main")
          .textContent(),
      ).resolves.toBe("First tab");
      await expect(
        context
          .pages()
          .find((page) => page.url() === secondUrl)!
          .locator("main")
          .textContent(),
      ).resolves.toBe("Second tab");
    } finally {
      if (sessionId !== undefined) await finishProvisionSession(sessionId);
      await context.close();
    }
  });

  it("does not let an OAuth popup replace a queued ordinary click", async () => {
    const context = await browser.newContext();
    const product = await context.newPage();
    const productUrl = "https://product.test/login";
    const ordinaryUrl = "https://console.product.test/ordinary";
    const oauthReturnUrl = "https://console.product.test/oauth-return";
    let sessionId: string | undefined;
    try {
      await context.route("https://product.test/**", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<button id="ordinary" onclick="window.open('${ordinaryUrl}')">Open ordinary tab</button><button id="oauth" onclick='window.open(${JSON.stringify(
            `https://accounts.google.com/provider?redirect_uri=${encodeURIComponent(oauthReturnUrl)}`,
          )})'>Continue with Google</button>`,
        }),
      );
      await context.route("https://accounts.google.com/**", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<script>location.replace(${JSON.stringify(oauthReturnUrl)})</script>`,
        }),
      );
      await context.route("https://console.product.test/**", (route) =>
        route.fulfill({
          contentType: "text/html",
          body:
            route.request().url() === ordinaryUrl
              ? "<main>Ordinary tab</main>"
              : "<main>OAuth return tab</main>",
        }),
      );
      await product.goto(productUrl);
      const controller = BrowserController.fromHarnessPage(product);
      const started = await startHarnessProvisionSession({
        browser: controller,
        serviceUrl: productUrl,
      });
      sessionId = started.session_id;
      const ordinaryRef = parseElementsTable(started.el_table ?? "").find(
        (element) => element.label === "Open ordinary tab",
      )?.ref;
      const oauthRef = parseElementsTable(started.el_table ?? "").find(
        (element) => element.label === "Continue with Google",
      )?.ref;
      expect(ordinaryRef).toBeDefined();
      expect(oauthRef).toBeDefined();

      let ordinaryAdoptionEntered!: () => void;
      let resumeOrdinaryAdoption!: () => void;
      const ordinaryAdoption = new Promise<void>((resolve) => {
        ordinaryAdoptionEntered = resolve;
      });
      const ordinaryAdoptionResume = new Promise<void>((resolve) => {
        resumeOrdinaryAdoption = resolve;
      });
      const originalAdopt = controller.adoptOpenedTab.bind(controller);
      let firstCall = true;
      const adoptionSpy = vi
        .spyOn(controller, "adoptOpenedTab")
        .mockImplementation(async (graceMs?: number): Promise<string | null> => {
          if (firstCall) {
            firstCall = false;
            ordinaryAdoptionEntered();
            await ordinaryAdoptionResume;
          }
          return await originalAdopt(graceMs);
        });

      const ordinary = act(sessionId, { kind: "click", target: ordinaryRef! });
      await ordinaryAdoption;
      const popupBeforeRelease = product
        .waitForEvent("popup")
        .then(() => true)
        .catch(() => false);
      const oauth = act(sessionId, {
        kind: "oauth_login",
        target: oauthRef!,
        provider: "google",
      });
      await expect(
        Promise.race([
          popupBeforeRelease,
          new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
        ]),
      ).resolves.toBe(false);
      resumeOrdinaryAdoption();

      const ordinaryResult = await ordinary;
      adoptionSpy.mockRestore();
      expect(ordinaryResult.url).toBe(ordinaryUrl);
      await expect(oauth).rejects.toThrow("stale_ref");
      expect(context.pages().some((page) => page.url() === oauthReturnUrl)).toBe(false);
    } finally {
      if (sessionId !== undefined) await finishProvisionSession(sessionId);
      await context.close();
    }
  });

  it("keeps queued ordinary clicks on their captured page", async () => {
    const context = await browser.newContext();
    const product = await context.newPage();
    const productUrl = "https://product.test/editor";
    const firstUrl = "https://product.test/first";
    const secondUrl = "https://product.test/second";
    let sessionId: string | undefined;
    try {
      await context.route("https://product.test/**", (route) => {
        const url = route.request().url();
        const body =
          url === firstUrl
            ? "<main>First tab</main><button onclick=\"document.body.dataset.wrongTabClicked = 'yes'\">Open second tab</button>"
            : url === secondUrl
              ? "<main>Second tab</main>"
              : `<button id="first" onclick="window.open('${firstUrl}')">Open first tab</button><button id="second" onclick="window.open('${secondUrl}')">Open second tab</button>`;
        return route.fulfill({ contentType: "text/html", body });
      });
      await product.goto(productUrl);
      const controller = BrowserController.fromHarnessPage(product);
      const started = await startHarnessProvisionSession({
        browser: controller,
        serviceUrl: productUrl,
      });
      sessionId = started.session_id;
      const firstRef = parseElementsTable(started.el_table ?? "").find(
        (element) => element.label === "Open first tab",
      )?.ref;
      const secondRef = parseElementsTable(started.el_table ?? "").find(
        (element) => element.label === "Open second tab",
      )?.ref;
      expect(firstRef).toBeDefined();
      expect(secondRef).toBeDefined();

      let firstAdoptionEntered!: () => void;
      let resumeFirstAdoption!: () => void;
      const firstAdoption = new Promise<void>((resolve) => {
        firstAdoptionEntered = resolve;
      });
      const firstAdoptionResume = new Promise<void>((resolve) => {
        resumeFirstAdoption = resolve;
      });
      const originalAdopt = controller.adoptOpenedTab.bind(controller);
      let firstCall = true;
      const adoptionSpy = vi
        .spyOn(controller, "adoptOpenedTab")
        .mockImplementation(async (graceMs?: number): Promise<string | null> => {
          if (firstCall) {
            firstCall = false;
            firstAdoptionEntered();
            await firstAdoptionResume;
          }
          return await originalAdopt(graceMs);
        });

      const first = act(sessionId, { kind: "click", target: firstRef! });
      await firstAdoption;
      const second = act(sessionId, { kind: "click", target: secondRef! });
      resumeFirstAdoption();
      const [firstResult, secondResult] = await Promise.all([first, second]);
      adoptionSpy.mockRestore();

      const firstPage = context.pages().find((page) => page.url() === firstUrl)!;
      expect(firstResult.url).toBe(firstUrl);
      expect(secondResult.url).toBe(secondUrl);
      await expect(
        firstPage.locator("body").getAttribute("data-wrong-tab-clicked"),
      ).resolves.toBeNull();
      await expect(product.locator("#second").count()).resolves.toBe(1);
    } finally {
      if (sessionId !== undefined) await finishProvisionSession(sessionId);
      await context.close();
    }
  });

  it("adopts an ordinary newly opened tab for the resulting and next action", async () => {
    const context = await browser.newContext();
    const product = await context.newPage();
    const productUrl = "https://product.test/editor";
    const openedUrl = "https://product.test/opened-editor";
    await context.route("https://product.test/editor", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<button id="open" onclick='window.open(${JSON.stringify(openedUrl)})'>Open editor</button>`,
      }),
    );
    await context.route("https://product.test/opened-editor", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<label>Opened title<input id="opened-title"></label>`,
      }),
    );
    await product.goto(productUrl);
    const controller = BrowserController.fromHarnessPage(product);
    let sessionId: string | undefined;
    try {
      const started = await startHarnessProvisionSession({
        browser: controller,
        serviceUrl: productUrl,
      });
      sessionId = started.session_id;
      const openRef = parseElementsTable(started.el_table ?? "").find(
        (element) => element.label === "Open editor",
      )?.ref;
      expect(openRef).toBeDefined();
      const popupPromise = product.waitForEvent("popup");
      const opened = await act(sessionId, { kind: "click", target: openRef! });
      const popup = await popupPromise;
      expect(opened.url).toBe(openedUrl);
      expect(controller.currentUrl()).toBe(openedUrl);
      const observed = await observe(sessionId);
      expect(observed.url).toBe(openedUrl);
      const openedTitleRef = parseElementsTable(opened.el_table ?? "").find(
        (element) => element.label === "Opened title",
      )?.ref;
      expect(openedTitleRef).toBeDefined();
      const typed = await act(sessionId, {
        kind: "type",
        target: openedTitleRef!,
        text: "New tab title",
      });
      expect(typed.url).toBe(openedUrl);
      expect(await popup.locator("#opened-title").inputValue()).toBe("New tab title");
      expect(await product.locator("#opened-title").count()).toBe(0);
    } finally {
      if (sessionId) await finishProvisionSession(sessionId);
      await context.close();
    }
  });

  it("keeps cart add bookkeeping on its adopted tab during a concurrent click", async () => {
    const context = await browser.newContext();
    const product = await context.newPage();
    const productUrl = "https://product.test/cart-source";
    const cartUrl = "https://product.test/cart";
    const distractionUrl = "https://product.test/distraction";
    await context.route("https://product.test/**", (route) => {
      const url = route.request().url();
      return route.fulfill({
        contentType: "text/html",
        body:
          url === cartUrl
            ? `<main>Cart</main><div id="line" data-testid="line-item"><a href="/products/popup" data-product-identity="popup-product">Popup product</a> <span>Quantity 1</span> <span data-options-hash="popup-options"></span></div><button id="distraction" onclick="window.open('${distractionUrl}')">Open distraction</button>`
            : url === distractionUrl
              ? "<main>Distraction</main>"
              : `<button id="add" onclick="window.open('${cartUrl}')">Add to Cart</button>`,
      });
    });
    await product.goto(productUrl);
    const controller = BrowserController.fromHarnessPage(product);
    const lineReader = controller as unknown as {
      readCheckoutReviewLineItems: (...args: unknown[]) => Promise<unknown>;
    };
    const originalRead = lineReader.readCheckoutReviewLineItems;
    let releaseCartRead: () => void = () => undefined;
    const cartReadPaused = new Promise<void>((resolve) => {
      let paused = false;
      lineReader.readCheckoutReviewLineItems = async (...args) => {
        const page = args[1] as Page | undefined;
        if (!paused && page?.url() === cartUrl) {
          paused = true;
          resolve();
          await new Promise<void>((release) => {
            releaseCartRead = release;
          });
        }
        return await originalRead.apply(controller, args);
      };
    });
    let sessionId: string | undefined;
    try {
      const started = await startHarnessProvisionSession({
        browser: controller,
        serviceUrl: productUrl,
      });
      sessionId = started.session_id;
      const adding = cartAdd(sessionId, "popup-product", "popup-options", "popup-cart");
      await cartReadPaused;
      const distraction = await act(sessionId, { kind: "click", target: "Open distraction" });
      expect(distraction.url).toBe(distractionUrl);
      releaseCartRead();
      const added = await adding;
      expect(added).toMatchObject({
        status: "added",
        cart_url: cartUrl,
        postcondition: { quantity: 1 },
      });
      expect(product.url()).toBe(productUrl);
      await expect(product.locator("text=Popup product").count()).resolves.toBe(0);
    } finally {
      releaseCartRead();
      lineReader.readCheckoutReviewLineItems = originalRead;
      if (sessionId) await finishProvisionSession(sessionId);
      await context.close();
    }
  });

  it("keeps recipe continuation on its adopted tab during a concurrent click", async () => {
    const context = await browser.newContext();
    const product = await context.newPage();
    const productUrl = "https://product.test/replay-source";
    const replayUrl = "https://product.test/replay";
    const distractionUrl = "https://product.test/replay-distraction";
    await context.route("https://product.test/**", (route) => {
      const url = route.request().url();
      return route.fulfill({
        contentType: "text/html",
        body:
          url === replayUrl
            ? `<main>Replay</main><label>Replay name<input id="replay-name" name="full_name" type="text" autocomplete="name" data-testid="replay-name"></label><button id="distraction" onclick="window.open('${distractionUrl}')">Open distraction</button>`
            : url === distractionUrl
              ? '<main>Distraction</main><label>Replay name<input id="replay-name" name="full_name" type="text" autocomplete="name" data-testid="replay-name"></label>'
              : `<button id="open-replay" onclick="window.open('${replayUrl}')">Open replay</button>`,
      });
    });
    await product.goto(productUrl);
    const controller = BrowserController.fromHarnessPage(product);
    let sessionId: string | undefined;
    try {
      const started = await startHarnessProvisionSession({
        browser: controller,
        serviceUrl: productUrl,
      });
      sessionId = started.session_id;
      const recipe: OperatorRecipe = {
        name: "replay-adoption",
        schema_version: 1,
        goal: "Set replay name",
        verb: "configure",
        domain: "product.test",
        entry_url: productUrl,
        allowed_hosts: ["product.test"],
        trace: [
          {
            action: {
              kind: "click",
              target: { dom_hint: { id: "open-replay" }, css: "#open-replay" },
            },
          },
          {
            action: {
              kind: "type",
              target: {
                dom_hint: { testid: "replay-name", name: "full_name" },
                accessible_name: "Replay name",
                css: "#replay-name",
                field_role: "ac:name",
              },
              value: { hole: "contact.name" },
            },
          },
        ],
        secrets: [],
        postcondition: {
          kind: "execute_capability",
          describe: "Replay name is set",
          success_signal: { text_present: "Replay" },
        },
      };
      const replayed = await replayOperatorRecipe(
        sessionId,
        recipe,
        { "contact.name": "Adopted replay" },
        0,
        {
          beforeStep: async ({ step_index }) => {
            if (step_index !== 1) return;
            const distraction = await act(sessionId!, {
              kind: "click",
              target: "Open distraction",
            });
            expect(distraction.url).toBe(distractionUrl);
          },
        },
      );
      const replay = context.pages().find((page) => page.url() === replayUrl)!;
      const distraction = context.pages().find((page) => page.url() === distractionUrl)!;
      expect(replayed).toMatchObject({ status: "complete", observation: { url: replayUrl } });
      expect(await replay.locator("#replay-name").inputValue()).toBe("Adopted replay");
      expect(await distraction.locator("#replay-name").inputValue()).toBe("");
    } finally {
      if (sessionId) await finishProvisionSession(sessionId);
      await context.close();
    }
  });

  it("rejects a closed completion source instead of clicking a colliding product control", async () => {
    const context = await browser.newContext();
    const product = await context.newPage();
    const expectedReturnUrl = "https://console.product.test/projects";
    await context.route("https://product.test/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<button id="oauth" onclick='window.open(${JSON.stringify(
          `https://accounts.google.com/provider?redirect_uri=${encodeURIComponent(expectedReturnUrl)}`,
        )})'>Continue</button><button id="shared" onclick="document.body.dataset.productClicked = 'yes'">New project</button>`,
      }),
    );
    await context.route("https://accounts.google.com/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<script>location.href=${JSON.stringify(expectedReturnUrl)}</script>`,
      }),
    );
    await context.route("https://console.product.test/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<main>Projects</main><button id="shared">New project</button>',
      }),
    );
    await product.goto("https://product.test/login");
    const controller = BrowserController.fromHarnessPage(product);
    let sessionId: string | undefined;
    try {
      const started = await startHarnessProvisionSession({
        browser: controller,
        serviceUrl: "https://product.test/login",
      });
      sessionId = started.session_id;
      const oauthRef = parseElementsTable(started.el_table ?? "")[0]?.ref;
      expect(oauthRef).toBeDefined();
      const completed = await act(sessionId, {
        kind: "oauth_login",
        target: oauthRef!,
        provider: "google",
      });
      const sourceRef = parseElementsTable(completed.el_table ?? "").find(
        (element) => element.label === "New project",
      )?.ref;
      expect(sourceRef).toBeDefined();
      const completionPage = controller.completedOAuthPage();
      expect(completionPage).not.toBeNull();
      await completionPage?.close();
      await expect(act(sessionId, { kind: "click", target: sourceRef! })).rejects.toMatchObject({
        code: "target_stale",
      });
      await expect(act(sessionId, { kind: "press", key: "Enter" })).rejects.toThrow(
        "action source page is closed",
      );
      await expect(act(sessionId, { kind: "scroll", direction: "bottom" })).rejects.toThrow(
        "action source page is closed",
      );
      await expect(
        act(sessionId, { kind: "goto", url: "https://product.test/other" }),
      ).rejects.toThrow("action source page is closed");
      const recovered = await observe(sessionId);
      expect(recovered.url).toBe("https://product.test/login");
      expect(recovered.el_table).toContain("Continue");
      expect(product.url()).toBe("https://product.test/login");
      expect(await product.locator("body").getAttribute("data-product-clicked")).toBeNull();
    } finally {
      if (sessionId) await finishProvisionSession(sessionId);
      await context.close();
    }
  });

  it.each(["browser-use-dom", "legacy"])(
    "returns a terminal completion snapshot after an observed popup return closes (%s)",
    async (format) => {
      const context = await browser.newContext();
      const product = await context.newPage();
      const expectedReturnUrl = "https://console.product.test/projects";
      await context.route("https://product.test/**", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<main>Login</main><button id="oauth" onclick='window.open(${JSON.stringify(
            `https://accounts.google.com/provider?redirect_uri=${encodeURIComponent(expectedReturnUrl)}`,
          )})'>Continue</button>`,
        }),
      );
      await context.route("https://accounts.google.com/**", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<script>location.href=${JSON.stringify(expectedReturnUrl)}</script>`,
        }),
      );
      await context.route("https://console.product.test/**", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: "<main>Projects</main><script>window.close()</script>",
        }),
      );
      await product.goto("https://product.test/login");
      const controller = BrowserController.fromHarnessPage(product);
      let sessionId: string | undefined;
      try {
        const started = await startHarnessProvisionSession({
          browser: controller,
          serviceUrl: "https://product.test/login",
          ...(format === "browser-use-dom"
            ? { observationFormat: "browser-use-dom" as const }
            : {}),
        });
        sessionId = started.session_id;
        const oauthRef =
          format === "browser-use-dom"
            ? started.dom?.match(/@e:[A-Za-z0-9_-]+/)?.[0]
            : parseElementsTable(started.el_table ?? "")[0]?.ref;
        expect(oauthRef).toBeDefined();
        const result = await act(sessionId, {
          kind: "oauth_login",
          target: oauthRef!,
          provider: "google",
        });
        expect(result).toMatchObject({
          url: expectedReturnUrl,
          terminal: {
            state: "oauth_completed",
            refs: "unavailable",
            next_action: "operate_observe",
          },
        });
        expect(result.el_table).toBeUndefined();
        expect(result.dom).toBeUndefined();
        const handoff = await observe(sessionId);
        expect(handoff.url).toBe("https://product.test/login");
        expect(handoff.terminal).toBeUndefined();
      } finally {
        if (sessionId) await finishProvisionSession(sessionId);
        await context.close();
      }
    },
  );

  it("retains a same-tab return as terminal completion when the product document closes", async () => {
    const context = await browser.newContext();
    const product = await context.newPage();
    const expectedReturnUrl = "https://console.product.test/projects";
    await context.route("https://product.test/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<button id="oauth" onclick='location.href=${JSON.stringify(
          `https://accounts.google.com/provider?redirect_uri=${encodeURIComponent(expectedReturnUrl)}`,
        )}'>Continue</button>`,
      }),
    );
    await context.route("https://accounts.google.com/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<script>location.href=${JSON.stringify(expectedReturnUrl)}</script>`,
      }),
    );
    await context.route("https://console.product.test/**", (route) =>
      route.fulfill({ contentType: "text/html", body: "<main>Projects</main>" }),
    );
    await product.goto("https://product.test/login");
    const controller = BrowserController.fromHarnessPage(product);
    product.on("framenavigated", (frame) => {
      if (frame === product.mainFrame() && frame.url() === expectedReturnUrl) {
        setTimeout(() => void product.close(), 0);
      }
    });
    try {
      await controller.loginWithOAuth("#oauth", 1_000);
      expect(controller.takeOAuthTerminalCompletionUrl()).toBe(expectedReturnUrl);
      expect(controller.takeOAuthTerminalCompletionUrl()).toBeNull();
    } finally {
      await context.close();
    }
  });

  it("invalidates a popup return when its opener moves to a challenge", async () => {
    const context = await browser.newContext();
    const product = await context.newPage();
    const expectedReturnUrl = "https://console.product.test/projects";
    const challengeUrl = "https://product.test/mfa";
    await context.route("https://product.test/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body:
          route.request().url() === challengeUrl
            ? "<main>Enter your verification code</main>"
            : `<button id="oauth" onclick='window.open(${JSON.stringify(
                `https://accounts.google.com/provider?redirect_uri=${encodeURIComponent(expectedReturnUrl)}`,
              )})'>Continue</button>`,
      }),
    );
    await context.route("https://accounts.google.com/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<script>location.href=${JSON.stringify(expectedReturnUrl)}</script>`,
      }),
    );
    await context.route("https://console.product.test/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<script>window.opener.location.href=${JSON.stringify(challengeUrl)}; window.close()</script>`,
      }),
    );
    await product.goto("https://product.test/login");
    const controller = BrowserController.fromHarnessPage(product);
    try {
      await expect(controller.loginWithOAuth("#oauth", 1_000)).rejects.toBeInstanceOf(
        OAuthAwaitingHumanError,
      );
      expect(controller.takeOAuthTerminalCompletionUrl()).toBeNull();
    } finally {
      await context.close();
    }
  });

  it("keeps a popup pending after its observed return navigates to a challenge", async () => {
    const context = await browser.newContext();
    const product = await context.newPage();
    const expectedReturnUrl = "https://console.product.test/projects";
    const challengeUrl = "https://console.product.test/mfa";
    await context.route("https://product.test/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<button id="oauth" onclick='window.open(${JSON.stringify(
          `https://accounts.google.com/provider?redirect_uri=${encodeURIComponent(expectedReturnUrl)}`,
        )})'>Continue</button>`,
      }),
    );
    await context.route("https://accounts.google.com/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<script>location.href=${JSON.stringify(expectedReturnUrl)}</script>`,
      }),
    );
    await context.route("https://console.product.test/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body:
          route.request().url() === expectedReturnUrl
            ? `<script>location.href=${JSON.stringify(challengeUrl)}</script>`
            : "<main>Enter your verification code</main><script>window.close()</script>",
      }),
    );
    await product.goto("https://product.test/login");
    const controller = BrowserController.fromHarnessPage(product);
    try {
      await expect(controller.loginWithOAuth("#oauth", 500)).rejects.toBeInstanceOf(
        OAuthAwaitingHumanError,
      );
    } finally {
      await context.close();
    }
  });

  it("keeps a popup pending after its observed return changes to a hash-routed challenge", async () => {
    const context = await browser.newContext();
    const product = await context.newPage();
    const expectedReturnUrl = "https://console.product.test/projects";
    await context.route("https://product.test/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<button id="oauth" onclick='window.open(${JSON.stringify(
          `https://accounts.google.com/provider?redirect_uri=${encodeURIComponent(expectedReturnUrl)}`,
        )})'>Continue</button>`,
      }),
    );
    await context.route("https://accounts.google.com/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<script>location.href=${JSON.stringify(expectedReturnUrl)}</script>`,
      }),
    );
    await context.route("https://console.product.test/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<script>location.hash = "/mfa"; setTimeout(() => window.close(), 20)</script>',
      }),
    );
    await product.goto("https://product.test/login");
    const controller = BrowserController.fromHarnessPage(product);
    try {
      await expect(controller.loginWithOAuth("#oauth", 500)).rejects.toBeInstanceOf(
        OAuthAwaitingHumanError,
      );
    } finally {
      await context.close();
    }
  });

  it("accepts an OAuth response fragment at the exact return destination", async () => {
    const context = await browser.newContext();
    const product = await context.newPage();
    const expectedReturnUrl = "https://console.product.test/projects";
    const responseUrl = `${expectedReturnUrl}#code=returned-code&state=attempt-state`;
    await context.route("https://product.test/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<button id="oauth" onclick='location.href=${JSON.stringify(
          `https://accounts.google.com/provider?redirect_uri=${encodeURIComponent(expectedReturnUrl)}`,
        )}'>Continue</button>`,
      }),
    );
    await context.route("https://accounts.google.com/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<script>location.href=${JSON.stringify(responseUrl)}</script>`,
      }),
    );
    await context.route("https://console.product.test/**", (route) =>
      route.fulfill({ contentType: "text/html", body: "<main>Projects</main>" }),
    );
    await product.goto("https://product.test/login");
    const controller = BrowserController.fromHarnessPage(product);
    try {
      await expect(controller.loginWithOAuth("#oauth", 500)).resolves.toBeUndefined();
      expect(controller.currentUrl()).toBe(responseUrl);
    } finally {
      await context.close();
    }
  });

  it("binds tracked clicks to their provided source page", async () => {
    const context = await browser.newContext();
    const product = await context.newPage();
    const provider = await context.newPage();
    await product.setContent(
      '<button id="place-order" onclick="document.body.dataset.clicked=\'product\'">Place order</button>',
    );
    await provider.setContent(
      '<button id="place-order" onclick="document.body.dataset.clicked=\'provider\'">Place order</button>',
    );
    const controller = BrowserController.fromHarnessPage(provider);
    try {
      await controller.clickWithDispatchTracking(
        { kind: "selector", selector: "#place-order", method: "click" },
        () => false,
        undefined,
        product,
      );
      expect(await product.locator("body").getAttribute("data-clicked")).toBe("product");
      expect(await provider.locator("body").getAttribute("data-clicked")).toBeNull();
    } finally {
      await context.close();
    }
  });

  it("resolves a label fallback from the supplied source page", async () => {
    const context = await browser.newContext();
    const product = await context.newPage();
    const provider = await context.newPage();
    await product.setContent(
      '<div class="n-form-group__row"><label id="region-label">Region</label><select id="product-region"><option>Provider</option><option>Product</option></select></div>',
    );
    await provider.setContent(
      '<div class="n-form-group__row"><label id="region-label">Region</label><select id="provider-region"><option>Provider</option><option>Product</option></select></div>',
    );
    const controller = BrowserController.fromHarnessPage(provider);
    try {
      await controller.selectOptionOnPage(product, "#region-label", "Product");
      expect(await product.locator("#product-region").inputValue()).toBe("Product");
      expect(await provider.locator("#provider-region").inputValue()).toBe("Provider");
    } finally {
      await context.close();
    }
  });

  it("reports awaiting_human — never a guessed cause — when Google never reaches its OAuth completion signal", async () => {
    // Fix C regression: this used to reject with a fabricated cause ("the
    // saved session may have expired") even though nothing observed here
    // proves the session expired — the provider simply never returned
    // control. A live dogfood run hit exactly this shape (a routine 2FA
    // challenge, not an expired session) and the false cause made the agent
    // relay wrong information to the operator.
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
    const budgetMs = 3_000;

    try {
      // Direct callers do not supply the facade's handoff callback, so their
      // explicit total budget must remain the whole lifecycle's ceiling.
      const rejected = controller.loginWithOAuth("#oauth", budgetMs, "google");
      await expect(rejected).rejects.toBeInstanceOf(OAuthAwaitingHumanError);
      await expect(rejected).rejects.toMatchObject({
        message: expect.stringMatching(/has not returned to https:\/\/product\.test/i),
      });
      await expect(rejected).rejects.not.toMatchObject({
        message: expect.stringMatching(/expired|force-relogin|oauth_settle|retry oauth_login/i),
      });
      await expect(rejected).rejects.toMatchObject({
        message: expect.stringMatching(/operate_observe/),
      });
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(budgetMs - 500);
      expect(Date.now() - startedAt).toBeLessThan(5_000);
      // The pending challenge must stay reachable: the provider popup is still
      // open and is the controller's active page, so operate_observe reads it.
      const popup = context
        .pages()
        .find((page) => page.url().startsWith("https://accounts.google.com/"));
      expect(popup?.isClosed()).toBe(false);
      expect((controller as unknown as { page: Page }).page).toBe(popup);
      expect(controller.currentUrl()).toBe("https://accounts.google.com/provider");
      expect(product.isClosed()).toBe(false);
      expect(await controller.extractVisibleText()).toContain("Provider did not settle");
    } finally {
      await context.close().catch(() => undefined);
    }
  }, 6_000);

  it("reports failed when a popup carries the denial to the callback and then closes itself", async () => {
    const context = await browser.newContext();
    const product = await context.newPage();
    await context.route("https://product.test/**", async (route) => {
      const callback = route.request().url().includes("/callback");
      await route.fulfill({
        contentType: "text/html",
        body: callback
          ? "<main>Login cancelled</main><script>setTimeout(() => window.close(), 20)</script>"
          : '<button id="oauth" onclick="window.open(\'https://provider.test/oauth\')">Login with Provider</button>',
      });
    });
    await context.route("https://provider.test/oauth", async (route) => {
      await route.fulfill({
        contentType: "text/html",
        body: '<script>setTimeout(() => location.href="https://product.test/callback?error=access_denied", 20)</script>',
      });
    });
    await product.goto("https://product.test/login");
    const controller = BrowserController.fromHarnessPage(product);

    try {
      const rejected = controller.loginWithOAuth("#oauth", 3_000);
      await expect(rejected).rejects.toBeInstanceOf(OAuthFailedError);
      await expect(rejected).rejects.toMatchObject({
        message: expect.stringMatching(/error=access_denied/),
      });
      expect(product.isClosed()).toBe(false);
      expect(controller.currentUrl()).toBe("https://product.test/login");
    } finally {
      await context.close().catch(() => undefined);
    }
  });

  it("keeps the same-tab flow pending when its product page closes", async () => {
    const context = await browser.newContext();
    const product = await context.newPage();
    await context.route("https://product.test/**", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      await route.fulfill({
        contentType: "text/html",
        body: '<button id="oauth" onclick="location.href=\'https://provider.test/oauth\'">Login with Provider</button>',
      });
    });
    await context.route("https://provider.test/oauth", async (route) => {
      await route.fulfill({ contentType: "text/html", body: "<main>Provider challenge</main>" });
    });
    await product.goto("https://product.test/login");
    const controller = BrowserController.fromHarnessPage(product);
    const budgetMs = 1_500;

    try {
      const login = controller.loginWithOAuth("#oauth", budgetMs);
      setTimeout(() => void product.close().catch(() => undefined), budgetMs - 50);
      await expect(login).rejects.toBeInstanceOf(OAuthAwaitingHumanError);
      expect(product.isClosed()).toBe(true);
      expect(controller.currentUrl()).toBe("https://product.test/login");
    } finally {
      await context.close().catch(() => undefined);
    }
  });

  it("reports failed with the provider's own error code when the return carries error=access_denied", async () => {
    const context = await browser.newContext();
    const product = await context.newPage();
    await context.route("https://product.test/**", async (route) => {
      const callback = route.request().url().includes("/callback");
      await route.fulfill({
        contentType: "text/html",
        body: callback
          ? "<main>Login cancelled</main>"
          : '<button id="oauth" onclick="location.href=\'https://accounts.google.com/oauth?redirect_uri=https%3A%2F%2Fproduct.test%2Fcallback\'">Login with Provider</button>',
      });
    });
    await context.route("https://accounts.google.com/oauth**", async (route) => {
      await route.fulfill({
        contentType: "text/html",
        body: '<script>setTimeout(() => location.href="https://product.test/callback?error=access_denied&error_description=The+user+denied+access", 20)</script>',
      });
    });
    await product.goto("https://product.test/login");
    const controller = BrowserController.fromHarnessPage(product);

    try {
      const rejected = controller.loginWithOAuth("#oauth", 3_000);
      await expect(rejected).rejects.toBeInstanceOf(OAuthFailedError);
      await expect(rejected).rejects.toMatchObject({
        message: expect.stringMatching(/error=access_denied \(The user denied access\)/),
      });
      expect(product.isClosed()).toBe(false);
    } finally {
      await context.close().catch(() => undefined);
    }
  });

  it("does not report completion for a same-tab control that never left the product origin", async () => {
    // A disabled/no-op OAuth control (or a One-Tap affordance that never
    // redirects) leaves the page on the product origin for the whole budget.
    // Still being on the product origin at the deadline is not a return from
    // the provider, so this must stay awaiting_human rather than resolve as
    // a completed login.
    const context = await browser.newContext();
    const product = await context.newPage();
    await context.route("https://product.test/**", async (route) => {
      await route.fulfill({
        contentType: "text/html",
        body: '<button id="oauth" onclick="event.preventDefault()">Continue</button>',
      });
    });
    await product.goto("https://product.test/login");
    const controller = BrowserController.fromHarnessPage(product);

    try {
      await expect(controller.loginWithOAuth("#oauth", 1_000)).rejects.toBeInstanceOf(
        OAuthAwaitingHumanError,
      );
      expect(product.isClosed()).toBe(false);
      expect(controller.currentUrl()).toBe("https://product.test/login");
    } finally {
      await context.close().catch(() => undefined);
    }
  });

  it("does not re-arm the human deadline when the OAuth control never hands off", async () => {
    const context = await browser.newContext();
    const product = await context.newPage();
    await context.route("https://product.test/**", async (route) => {
      await route.fulfill({
        contentType: "text/html",
        body: '<button id="oauth" onclick="event.preventDefault()">Continue</button>',
      });
    });
    await product.goto("https://product.test/login");
    const controller = BrowserController.fromHarnessPage(product);
    const handoff = vi.fn(() => {
      throw new Error("unexpected human handoff");
    });

    try {
      await expect(
        controller.loginWithOAuth("#oauth", 2_500, "google", undefined, undefined, handoff),
      ).rejects.toBeInstanceOf(OAuthAwaitingHumanError);
      expect(handoff).not.toHaveBeenCalled();
    } finally {
      await context.close().catch(() => undefined);
    }
  });

  it("extends a delayed same-tab facade handoff from its navigation", async () => {
    const context = await browser.newContext();
    const product = await context.newPage();
    const previousTimeout = process.env.TRUSTY_SQUIRE_OAUTH_ACTION_TIMEOUT_MS;
    const previousCooldown = process.env.TRUSTY_SQUIRE_OAUTH_LOGIN_COOLDOWN_MS;
    process.env.TRUSTY_SQUIRE_OAUTH_ACTION_TIMEOUT_MS = "3000";
    process.env.TRUSTY_SQUIRE_OAUTH_LOGIN_COOLDOWN_MS = "0";
    await context.route("https://product.test/**", async (route) => {
      const callback = route.request().url().endsWith("/callback");
      await route.fulfill({
        contentType: "text/html",
        body: callback
          ? "<main>Signed in</main>"
          : '<button id="oauth" onclick="setTimeout(() => location.href = \'https://provider.test/oauth?redirect_uri=https%3A%2F%2Fproduct.test%2Fcallback\', 2300)">Continue</button>',
      });
    });
    await context.route("https://provider.test/oauth**", async (route) => {
      await route.fulfill({
        contentType: "text/html",
        body: '<script>setTimeout(() => location.href = "https://product.test/callback", 900)</script>',
      });
    });
    await product.goto("https://product.test/login");
    const controller = BrowserController.fromHarnessPage(product);
    let sessionId: string | undefined;

    try {
      const started = await startHarnessProvisionSession({
        browser: controller,
        serviceUrl: "https://product.test/login",
      });
      sessionId = started.session_id;
      const oauthRef = parseElementsTable(started.el_table ?? "")[0]?.ref;
      expect(oauthRef).toBeDefined();
      await expect(
        act(sessionId, { kind: "oauth_login", target: oauthRef!, provider: "google" }),
      ).resolves.toMatchObject({ url: "https://product.test/callback" });
    } finally {
      if (previousTimeout === undefined) delete process.env.TRUSTY_SQUIRE_OAUTH_ACTION_TIMEOUT_MS;
      else process.env.TRUSTY_SQUIRE_OAUTH_ACTION_TIMEOUT_MS = previousTimeout;
      if (previousCooldown === undefined) delete process.env.TRUSTY_SQUIRE_OAUTH_LOGIN_COOLDOWN_MS;
      else process.env.TRUSTY_SQUIRE_OAUTH_LOGIN_COOLDOWN_MS = previousCooldown;
      if (sessionId !== undefined) await finishProvisionSession(sessionId);
      await context.close().catch(() => undefined);
    }
  }, 10_000);

  it("ignores an error= parameter the page already carried before this attempt", async () => {
    // A stale denial from an earlier attempt is still in the address bar; this
    // attempt never navigates, so nothing was observed and it must not fail.
    const context = await browser.newContext();
    const product = await context.newPage();
    await context.route("https://product.test/**", async (route) => {
      await route.fulfill({
        contentType: "text/html",
        body: '<button id="oauth" onclick="event.preventDefault()">Continue</button>',
      });
    });
    await product.goto("https://product.test/login?error=access_denied");
    const controller = BrowserController.fromHarnessPage(product);

    try {
      await expect(controller.loginWithOAuth("#oauth", 1_000)).rejects.toBeInstanceOf(
        OAuthAwaitingHumanError,
      );
      expect(controller.currentUrl()).toBe("https://product.test/login?error=access_denied");
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
          : '<button id="oauth" onclick="location.href=\'https://accounts.google.com/oauth?redirect_uri=https%3A%2F%2Fproduct.test%2Fcallback\'">Login with Provider</button>',
      });
    });
    await context.route("https://accounts.google.com/oauth**", async (route) => {
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

  it("recognizes a settled same-tab return while the authenticated dashboard keeps polling", async () => {
    const context = await browser.newContext();
    const product = await context.newPage();
    const productUrl = "https://product.test/login";
    await context.route("https://product.test/**", async (route) => {
      const requestUrl = route.request().url();
      if (requestUrl.endsWith("/pulse")) {
        await route.fulfill({ status: 204 });
        return;
      }
      const callback = requestUrl.endsWith("/callback");
      await route.fulfill({
        contentType: "text/html",
        body: callback
          ? '<main>Signed in</main><script>setInterval(() => fetch("/pulse"), 25)</script>'
          : '<button id="oauth" onclick="location.href=\'https://accounts.google.com/oauth?redirect_uri=https%3A%2F%2Fproduct.test%2Fcallback\'">Login with Provider</button>',
      });
    });
    await context.route("https://accounts.google.com/oauth**", async (route) => {
      await route.fulfill({
        contentType: "text/html",
        body: '<script>setTimeout(() => location.href="https://product.test/callback", 100)</script>',
      });
    });
    await product.goto(productUrl);
    const controller = BrowserController.fromHarnessPage(product);

    try {
      await controller.loginWithOAuth("#oauth", 1_500);
      expect(controller.currentUrl()).toBe("https://product.test/callback");
      expect(await controller.extractVisibleText()).toContain("Signed in");
    } finally {
      await context.close().catch(() => undefined);
    }
  });
});

describe("oauthErrorFromReturnUrl (observed OAuth denial)", () => {
  it("reads a standard error code and its description from the query", () => {
    expect(
      oauthErrorFromReturnUrl(
        "https://product.test/callback?error=access_denied&error_description=User+cancelled&state=x",
      ),
    ).toEqual({ error: "access_denied", description: "User cancelled" });
  });

  it("reads an implicit-flow error from the fragment", () => {
    expect(oauthErrorFromReturnUrl("https://product.test/cb#error=consent_required")).toEqual({
      error: "consent_required",
      description: null,
    });
  });

  it("treats a return with no error parameter, or free text where a code belongs, as no denial", () => {
    expect(oauthErrorFromReturnUrl("https://product.test/callback?code=abc&state=x")).toBeNull();
    expect(
      oauthErrorFromReturnUrl("https://product.test/?error=Something%20went%20wrong"),
    ).toBeNull();
    expect(oauthErrorFromReturnUrl("not a url")).toBeNull();
  });
});
