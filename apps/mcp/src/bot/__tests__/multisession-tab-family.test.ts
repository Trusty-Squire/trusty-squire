// Real-Chromium proof of the tab-family isolation the experimental
// multisession flag (TRUSTY_SQUIRE_EXPERIMENTAL_MULTISESSION) depends on. Two
// BrowserControllers share ONE BrowserContext — a primary attached to its
// harness page and a satellite attached via BrowserController.attachSatellite —
// and the claims below are all about what the real OwnedPages registry and the
// browser networking do under that sharing:
//
//   - a popup opened from one session's page registers to THAT session only;
//     the other session can neither register it nor adopt it;
//   - closing a session's own pages closes its whole family (its page plus
//     every popup it owns) and nothing the other session owns;
//   - the satellite's page gets the same per-navigation normalization as the
//     primary's page (the evaluate-name shim and device spoof);
//   - all pages can reach arbitrary hosts, with either flag value.
//
// The lifecycle refcounting around this (who runs the real close, finish
// order) is covered with a fake controller in multisession-concurrency.test.ts.

import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserController } from "../browser.js";
import type { OwnedPages } from "../owned-pages.js";

let chromiumAvailable = false;
try {
  chromiumAvailable = existsSync(chromium.executablePath());
} catch {
  chromiumAvailable = false;
}

const describeChromium = chromiumAvailable ? describe : describe.skip;

type Internals = { page: Page | null; ownedPages: OwnedPages };
const internals = (controller: BrowserController): Internals => controller as unknown as Internals;

let server: Server;
let port: number;
let browser: Browser;
let context: BrowserContext;
let primaryPage: Page;
let primary: BrowserController;
let satellite: BrowserController;
let satellitePage: Page;
const apiHits: string[] = [];

const html = (name: string): string =>
  `<!doctype html><title>${name}</title><body><h1>${name}</h1></body>`;

async function openPopup(from: Page, url: string): Promise<Page> {
  const [popup] = await Promise.all([
    from.waitForEvent("popup"),
    from.evaluate((target) => {
      window.open(target, "_blank");
    }, url),
  ]);
  await popup.waitForLoadState("domcontentloaded");
  return popup;
}

async function fetchOutcome(from: Page, url: string): Promise<string> {
  return await from.evaluate(async (target) => {
    return await Promise.race([
      fetch(target).then(
        () => "resolved",
        () => "rejected",
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve("timed-out"), 2_000)),
    ]);
  }, url);
}

describeChromium("experimental multisession — real tab-family isolation", () => {
  beforeEach(async () => {
    apiHits.length = 0;
    server = createServer((req, res) => {
      if (req.url?.startsWith("/api")) {
        apiHits.push(`${req.headers.host ?? ""}${req.url}`);
        res.writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "*" });
        res.end("ok");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(html(req.url ?? "/"));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
    primaryPage = await context.newPage();
    await primaryPage.goto(`http://127.0.0.1:${port}/primary`);
    primary = BrowserController.fromHarnessPage(primaryPage);
    satellite = await BrowserController.attachSatellite(primary, { humanize: false });
    const attached = internals(satellite).page;
    if (attached === null) throw new Error("satellite attached no page");
    satellitePage = attached;
    await satellitePage.goto(`http://localhost:${port}/satellite`);
  }, 60_000);

  afterEach(async () => {
    delete process.env.TRUSTY_SQUIRE_EXPERIMENTAL_MULTISESSION;
    await browser?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("gives the satellite its own page in the shared context, distinct from the primary's", () => {
    expect(satellitePage).not.toBe(primaryPage);
    expect(satellitePage.context()).toBe(context);
    expect(internals(primary).ownedPages.has(primaryPage)).toBe(true);
    expect(internals(primary).ownedPages.has(satellitePage)).toBe(false);
    expect(internals(satellite).ownedPages.has(satellitePage)).toBe(true);
    expect(internals(satellite).ownedPages.has(primaryPage)).toBe(false);
  });

  it("raises on-demand GSI from the session-owned page beside the broker root", async () => {
    await satellitePage.setContent('<button id="gsi">Continue with Google</button>');
    await satellitePage.evaluate(() => {
      let prompts = 0;
      (globalThis as typeof globalThis & { gsiPrompts: () => number }).gsiPrompts = () => prompts;
      (globalThis as typeof globalThis & { google: unknown }).google = {
        accounts: { id: { prompt: () => prompts++ } },
      };
    });
    const cdp = { send: async () => undefined, on: () => undefined };
    const session = vi.spyOn(context, "newCDPSession").mockResolvedValue(cdp as never);
    try {
      await expect(satellite.tryGoogleGsiLogin("#gsi", 1)).resolves.toEqual({
        ok: false,
        via: "none",
      });
      expect(
        await satellitePage.evaluate(() =>
          (globalThis as typeof globalThis & { gsiPrompts: () => number }).gsiPrompts(),
        ),
      ).toBe(1);
    } finally {
      session.mockRestore();
    }
  });

  it("registers a popup to its opener's session only and refuses it to the other", async () => {
    primary.armOpenedTabAdoption();
    satellite.armOpenedTabAdoption();
    const popup = await openPopup(primaryPage, `http://127.0.0.1:${port}/primary-popup`);

    expect(internals(primary).ownedPages.has(popup)).toBe(true);
    expect(internals(satellite).ownedPages.has(popup)).toBe(false);
    expect(() => internals(satellite).ownedPages.register(popup)).toThrow(
      "Browser page already belongs to another session",
    );
    expect(internals(satellite).ownedPages.has(popup)).toBe(false);

    expect(await satellite.adoptOpenedTab(200)).toBeNull();
    expect(internals(satellite).page).toBe(satellitePage);
    expect(await primary.adoptOpenedTab(200)).toBe(`http://127.0.0.1:${port}/primary-popup`);
    expect(internals(primary).page).toBe(popup);

    // And symmetrically from the satellite's side.
    primary.armOpenedTabAdoption();
    satellite.armOpenedTabAdoption();
    const satellitePopup = await openPopup(
      satellitePage,
      `http://localhost:${port}/satellite-popup`,
    );
    expect(internals(satellite).ownedPages.has(satellitePopup)).toBe(true);
    expect(internals(primary).ownedPages.has(satellitePopup)).toBe(false);
    expect(() => internals(primary).ownedPages.register(satellitePopup)).toThrow(
      "Browser page already belongs to another session",
    );
    expect(await primary.adoptOpenedTab(200)).toBeNull();
    expect(internals(primary).page).toBe(popup);
    expect(await satellite.adoptOpenedTab(200)).toBe(`http://localhost:${port}/satellite-popup`);
  }, 30_000);

  it("closeOwnPagesOnly closes the satellite's whole family and nothing of the primary's", async () => {
    satellite.armOpenedTabAdoption();
    const satellitePopup = await openPopup(
      satellitePage,
      `http://localhost:${port}/satellite-popup`,
    );
    await satellite.adoptOpenedTab(200);
    primary.armOpenedTabAdoption();
    const primaryPopup = await openPopup(primaryPage, `http://127.0.0.1:${port}/primary-popup`);

    expect(await satellite.closeOwnPagesOnly()).toBe("closed");

    expect(satellitePage.isClosed()).toBe(true);
    expect(satellitePopup.isClosed()).toBe(true);
    expect(primaryPage.isClosed()).toBe(false);
    expect(primaryPopup.isClosed()).toBe(false);
    expect(context.pages()).toEqual(expect.arrayContaining([primaryPage, primaryPopup]));
    expect(context.pages()).toHaveLength(2);
    expect(internals(primary).ownedPages.has(primaryPage)).toBe(true);
    expect(internals(primary).ownedPages.has(primaryPopup)).toBe(true);
    expect(await primaryPage.evaluate(() => document.title)).toBe("/primary");
  }, 30_000);

  it("installs the primary's per-navigation page normalization on the satellite's page", async () => {
    const normalized = async (page: Page): Promise<boolean> =>
      await page.evaluate(() => typeof (globalThis as { __name?: unknown }).__name === "function");
    await satellitePage.goto(`http://localhost:${port}/satellite-again`);
    await expect.poll(async () => await normalized(satellitePage), { timeout: 5_000 }).toBe(true);
    expect(
      await satellitePage.evaluate(() => [
        navigator.hardwareConcurrency,
        (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
      ]),
    ).toEqual([8, 8]);

    // The environment itself does none of this: a page no controller
    // attached, in the same context, stays raw.
    const raw = await context.newPage();
    await raw.goto(`http://localhost:${port}/raw`);
    expect(await normalized(raw)).toBe(false);
  }, 30_000);

  it.each(["0", "1"])(
    "allows cross-host requests for every tab family (flag=%s)",
    async (flag) => {
      process.env.TRUSTY_SQUIRE_EXPERIMENTAL_MULTISESSION = flag;
      expect(await fetchOutcome(primaryPage, `http://localhost:${port}/api/primary`)).toBe(
        "resolved",
      );
      expect(await fetchOutcome(satellitePage, `http://127.0.0.1:${port}/api/satellite`)).toBe(
        "resolved",
      );
      const unclaimed = await context.newPage();
      await unclaimed.goto(`http://127.0.0.1:${port}/unclaimed`);
      expect(await fetchOutcome(unclaimed, `http://localhost:${port}/api/unclaimed`)).toBe(
        "resolved",
      );
      await satellite.closeOwnPagesOnly();
      expect(await fetchOutcome(primaryPage, `http://localhost:${port}/api/after`)).toBe(
        "resolved",
      );
      expect(apiHits).toHaveLength(4);
    },
    30_000,
  );
});
