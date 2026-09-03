// Real-browser regression for new-tab adoption.
//
// The live miss (Resend magic link in Gmail, rc.22): the "Log in to Resend"
// button is a `target=_blank` anchor. Clicking it opened a second tab and the
// operator stayed on the Gmail tab, so every subsequent observe/act read the
// inbox instead of the login page — link-based email verification was
// unreachable. Reading the href instead is not a workaround: the link carries a
// single-use login token, so `extract` seals it and must never hand it to the
// host as text. Following the tab navigates the browser and exposes nothing.
//
// Synthetic fixtures only — the "token" here is a literal in this file.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { BrowserController } from "../browser.js";
import {
  act,
  finishProvisionSession,
  observe,
  startHarnessProvisionSession,
} from "../provision-session.js";

// Stands in for the single-use login token a magic link carries. It must never
// reach the caller as text — the operator follows the tab instead.
const LOGIN_TOKEN = "SUPER-SECRET-LOGIN-TOKEN";
const MAGIC_LINK = `https://product.test/verify?token=${LOGIN_TOKEN}`;

const INBOX_HTML = `
  <!doctype html>
  <main id="state">Inbox</main>
  <a id="magic" href="${MAGIC_LINK}" target="_blank">Log in to Product</a>
  <button id="popup" type="button" onclick="window.open('${MAGIC_LINK}', '_blank')">
    Open login window
  </button>
  <button id="inert" type="button" onclick="document.querySelector('#state').textContent = 'Marked read'">
    Mark as read
  </button>
`;

let browser: Browser;

// The verify hop consumes its token and redirects, exactly like a real magic
// link: the landed page carries no token, so a leak would have to come from the
// operator, not the fixture. The redirect is client-side because Playwright's
// route.fulfill cannot serve a 3xx (Chrome rejects the bodyless response).
async function routedContext(): Promise<BrowserContext> {
  const context = await browser.newContext();
  await context.route(
    (url) => url.hostname === "mail.test" && url.pathname === "/inbox",
    async (route) => {
      await route.fulfill({ contentType: "text/html", body: INBOX_HTML });
    },
  );
  await context.route(
    (url) => url.hostname === "product.test" && url.pathname === "/verify",
    async (route) => {
      await route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><script>location.replace("https://product.test/welcome")</script>',
      });
    },
  );
  await context.route(
    (url) => url.hostname === "product.test" && url.pathname === "/welcome",
    async (route) => {
      await route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><main>Signed in to Product</main>",
      });
    },
  );
  return context;
}

async function inboxSession(): Promise<{
  context: BrowserContext;
  controller: BrowserController;
  inbox: Page;
  sessionId: string;
}> {
  const context = await routedContext();
  const inbox = await context.newPage();
  await inbox.goto("https://mail.test/inbox", { waitUntil: "domcontentloaded" });
  const controller = BrowserController.fromHarnessPage(inbox);
  const started = await startHarnessProvisionSession({
    browser: controller,
    serviceUrl: "https://mail.test/inbox",
  });
  return { context, controller, inbox, sessionId: started.session_id };
}

function activePage(controller: BrowserController): Page | null {
  return (controller as unknown as { page: Page | null }).page;
}

describe("operator new-tab adoption", () => {
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  });

  afterAll(async () => {
    await browser?.close();
  });

  it("follows a target=_blank magic link into the tab it opens", async () => {
    const { context, controller, inbox, sessionId } = await inboxSession();
    try {
      await act(sessionId, { kind: "click", target: "css=#magic" });

      const adopted = activePage(controller);
      expect(adopted).not.toBe(inbox);
      expect(inbox.isClosed()).toBe(false);
      expect(controller.currentUrl()).toBe("https://product.test/welcome");

      const transition = await observe(sessionId, "full");
      expect(transition.url).toBe("https://product.test/welcome");
      expect(transition.text).toContain("Signed in to Product");
      expect(transition.text).not.toContain("Inbox");
      // The token stays in the browser. Nothing the caller receives carries it.
      expect(JSON.stringify(transition)).not.toContain(LOGIN_TOKEN);
    } finally {
      await finishProvisionSession(sessionId).catch(() => undefined);
      await context.close().catch(() => undefined);
    }
  }, 30_000);

  it("follows a window.open login window the same way", async () => {
    const { context, controller, inbox, sessionId } = await inboxSession();
    try {
      const result = await act(sessionId, { kind: "click", target: "css=#popup" });

      expect(activePage(controller)).not.toBe(inbox);
      expect(controller.currentUrl()).toBe("https://product.test/welcome");
      expect(JSON.stringify(result)).not.toContain(LOGIN_TOKEN);
      await expect(observe(sessionId)).resolves.toMatchObject({
        url: "https://product.test/welcome",
      });
    } finally {
      await finishProvisionSession(sessionId).catch(() => undefined);
      await context.close().catch(() => undefined);
    }
  }, 30_000);

  it("follows a magic link clicked through an observed ref, not just a locator", async () => {
    const { context, controller, inbox, sessionId } = await inboxSession();
    try {
      const full = await observe(sessionId, "full");
      const ref = full.elements?.find((el) => /Log in to Product/i.test(el.label))?.ref;
      expect(ref).toMatch(/^@e:/);

      await act(sessionId, { kind: "click", target: ref! });

      expect(activePage(controller)).not.toBe(inbox);
      expect(controller.currentUrl()).toBe("https://product.test/welcome");
    } finally {
      await finishProvisionSession(sessionId).catch(() => undefined);
      await context.close().catch(() => undefined);
    }
  }, 30_000);

  it("leaves the active page alone when a click opens no tab", async () => {
    const { context, controller, inbox, sessionId } = await inboxSession();
    try {
      const transition = await act(sessionId, { kind: "click", target: "css=#inert" });

      expect(activePage(controller)).toBe(inbox);
      expect(controller.currentUrl()).toBe("https://mail.test/inbox");
      expect(transition.text).toContain("Marked read");
      expect(context.pages().filter((page) => !page.isClosed())).toHaveLength(1);
    } finally {
      await finishProvisionSession(sessionId).catch(() => undefined);
      await context.close().catch(() => undefined);
    }
  }, 30_000);
});
