// Real-browser regression for the operator OAuth lifecycle. The provider popup
// intentionally redirects to a token-exchange page and then closes itself,
// which is the normal OAuth return shape that previously left the controller
// holding a detached Playwright Page. No external provider or credentials are
// involved: the fixture drives the same popup/redirect/close lifecycle locally.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import {
  BrowserController,
  OAuthAwaitingHumanError,
  OAuthFailedError,
  oauthErrorFromReturnUrl,
} from "../browser.js";
import {
  act,
  finishProvisionSession,
  observe,
  parseElementsTable,
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
      expect(result.oauth).toMatchObject({ state: "awaiting_human", next_action: "operate_observe" });
    } finally {
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
      await expect(controller.loginWithOAuth("#oauth", 6_000)).rejects.toBeInstanceOf(
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
      const settling = controller.settleAfterOAuth();
      await popup.close();
      await settling;

      expect(product.isClosed()).toBe(false);
      expect((controller as unknown as { page: Page }).page).toBe(product);
    } finally {
      await context.close().catch(() => undefined);
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
        window.open("https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=https%3A%2F%2Fproduct.test%2Fcallback");
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
      const providerUrl =
        `https://accounts.google.com/provider?redirect_uri=${encodeURIComponent(expectedReturnUrl)}`;
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
        expect(controller.currentUrl()).toBe(expectedReturnUrl);
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
      const expectedReturnUrl = "https://console.product.test/projects";
      const providerUrl =
        `https://accounts.google.com/provider?redirect_uri=${encodeURIComponent(expectedReturnUrl)}`;
      await context.route("https://product.test/**", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<button id="oauth" onclick='${
            topology === "popup" ? "window.open" : "location.assign"
          }(${JSON.stringify(providerUrl)})'>Continue</button>`,
        }),
      );
      await context.route("https://accounts.google.com/**", (route) =>
        route.fulfill({ status: 302, headers: { location: expectedReturnUrl } }),
      );
      await context.route("https://console.product.test/**", (route) =>
        route.fulfill({ contentType: "text/html", body: "<main>Projects</main>" }),
      );
      await product.goto("https://product.test/login");
      const controller = BrowserController.fromHarnessPage(product);
      try {
        await expect(controller.loginWithOAuth("#oauth", 500)).resolves.toBeUndefined();
        expect(controller.currentUrl()).toBe(expectedReturnUrl);
      } finally {
        await context.close();
      }
    },
  );

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

  it.each(["compact-v2", "legacy"])(
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
          ...(format === "compact-v2" ? { observationFormat: "compact-v2" as const } : {}),
        });
        sessionId = started.session_id;
        const oauthRef =
          format === "compact-v2"
            ? started.dom?.match(/@e:[A-Za-z0-9_-]+/)?.[0]
            : parseElementsTable(started.el_table ?? "")[0]?.ref;
        expect(oauthRef).toBeDefined();
        const result = await act(sessionId, {
          kind: "oauth_login",
          target: oauthRef!,
          provider: "google",
        });
        const refs =
          format === "compact-v2"
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

  it.each(["compact-v2", "legacy"])(
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
          ...(format === "compact-v2" ? { observationFormat: "compact-v2" as const } : {}),
        });
        sessionId = started.session_id;
        const oauthRef =
          format === "compact-v2"
            ? started.dom?.match(/@e:[A-Za-z0-9_-]+/)?.[0]
            : parseElementsTable(started.el_table ?? "")[0]?.ref;
        expect(oauthRef).toBeDefined();
        const result = await act(sessionId, {
          kind: "oauth_login",
          target: oauthRef!,
          provider: "google",
        });
        expect(result.url).toBe(expectedReturnUrl);
        if (format === "compact-v2") expect(result.dom).toContain("New project");
        else expect(result.el_table).toContain("New project");
      } finally {
        if (sessionId) await finishProvisionSession(sessionId);
        await context.close();
      }
    },
  );

  it.each(["compact-v2", "legacy"])(
    "rechecks completion when the outer action deadline wins during consent work (%s)",
    async (format) => {
    const context = await browser.newContext();
    const product = await context.newPage();
    const expectedReturnUrl = "https://console.product.test/projects";
    const previousTimeout = process.env.TRUSTY_SQUIRE_OAUTH_ACTION_TIMEOUT_MS;
    process.env.TRUSTY_SQUIRE_OAUTH_ACTION_TIMEOUT_MS = "1600";
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
        body: '<main>Consent</main><input id="project-name" required autocomplete="shipping address-line1" value="provider" onchange="document.body.dataset.shippingCommitted=\'provider\'"><select id="region"><option>Provider</option><option>Product</option></select>',
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
    let releaseConsent!: () => void;
    const consentGate = new Promise<boolean>((resolve) => {
      releaseConsent = () => resolve(true);
    });
    vi.spyOn(controller, "advanceOAuthConsent").mockImplementation(async () => {
      await product.goto("https://console.product.test/projects");
      return await consentGate;
    });
    let sessionId: string | undefined;
    try {
      const started = await startHarnessProvisionSession({
        browser: controller,
        serviceUrl: "https://product.test/login",
        ...(format === "compact-v2" ? { observationFormat: "compact-v2" as const } : {}),
      });
      sessionId = started.session_id;
      const refFrom = (observation: { dom?: string; el_table?: string }): string | undefined =>
        format === "compact-v2"
          ? observation.dom?.match(/@e:[A-Za-z0-9_-]+/)?.[0]
          : parseElementsTable(observation.el_table ?? "")[0]?.ref;
      const oauthRef = refFrom(started);
      expect(oauthRef).toBeDefined();
      const result = await act(sessionId, {
        kind: "oauth_login",
        target: oauthRef!,
        provider: "google",
      });
      expect(result.url).toBe("https://console.product.test/projects");
      expect(result.oauth).toBeUndefined();
      if (format === "compact-v2") expect(result).toMatchObject({ format: "compact-v2" });
      else expect(result.format).toBeUndefined();
      const productRefs =
        format === "compact-v2"
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
      expect(await product.locator("body").getAttribute("data-shipping-committed")).toBe("product");
      expect(await provider.locator("body").getAttribute("data-shipping-committed")).toBeNull();
      expect(await product.locator("body").getAttribute("data-project-clicked")).toBe("yes");
      expect((controller as unknown as { page: Page }).page.url()).toBe(
        "https://accounts.google.com/provider",
      );
      releaseConsent();
      await vi.waitFor(() =>
        expect((controller as unknown as { page: Page }).page.url()).toBe(expectedReturnUrl),
      );
      const settled = await observe(sessionId);
      expect(settled.url).toBe(expectedReturnUrl);
      if (format === "compact-v2") expect(settled).toMatchObject({ format: "compact-v2" });
      else expect(settled.format).toBeUndefined();
    } finally {
      releaseConsent();
      if (previousTimeout === undefined) delete process.env.TRUSTY_SQUIRE_OAUTH_ACTION_TIMEOUT_MS;
      else process.env.TRUSTY_SQUIRE_OAUTH_ACTION_TIMEOUT_MS = previousTimeout;
      if (sessionId) await finishProvisionSession(sessionId);
      await context.close();
    }
    },
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

  it.each([
    "https://identity.product.test/mfa",
    "https://product.test/mfa",
  ])("keeps %s pending despite a different initiated destination", async (mfaUrl) => {
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
  });

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

  it("completes a popup OAuth return to its same-origin callback", async () => {
    const context = await browser.newContext();
    const product = await context.newPage();
    const callbackUrl = "https://product.test/callback";
    await context.route("https://product.test/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: route.request().url() === callbackUrl
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

  it("completes a popup OAuth return inside the initiated destination document", async () => {
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
        body: `<script>setTimeout(() => location.href=${JSON.stringify(expectedReturnUrl)}, 50)</script>`,
      }),
    );
    await context.route("https://console.product.test/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<main>Projects</main><button>New project</button>",
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
      const result = await act(sessionId, {
        kind: "oauth_login",
        target: oauthRef!,
        provider: "google",
      });
      expect(result.url).toBe(expectedReturnUrl);
      expect(result.text).toContain("Projects");
      expect((controller as unknown as { page: Page }).page).toBe(product);
      expect(controller.completedOAuthPage()?.url()).toBe(expectedReturnUrl);
    } finally {
      if (sessionId) await finishProvisionSession(sessionId);
      await context.close();
    }
  });

  it.each(["compact-v2", "legacy"])(
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
          ...(format === "compact-v2" ? { observationFormat: "compact-v2" as const } : {}),
        });
        sessionId = started.session_id;
        const oauthRef =
          format === "compact-v2"
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

    try {
      const rejected = controller.loginWithOAuth("#oauth", 1_000, "google");
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
  });

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
          : '<button id="oauth" onclick="location.href=\'https://provider.test/oauth?redirect_uri=https%3A%2F%2Fproduct.test%2Fcallback\'">Login with Provider</button>',
      });
    });
    await context.route("https://provider.test/oauth**", async (route) => {
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
          : '<button id="oauth" onclick="location.href=\'https://provider.test/oauth?redirect_uri=https%3A%2F%2Fproduct.test%2Fcallback\'">Login with Provider</button>',
      });
    });
    await context.route("https://provider.test/oauth**", async (route) => {
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
          : '<button id="oauth" onclick="location.href=\'https://provider.test/oauth?redirect_uri=https%3A%2F%2Fproduct.test%2Fcallback\'">Login with Provider</button>',
      });
    });
    await context.route("https://provider.test/oauth**", async (route) => {
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
