// Real-Chromium proof of the tab-family isolation the experimental
// multisession flag (TRUSTY_SQUIRE_EXPERIMENTAL_MULTISESSION) depends on. Two
// BrowserControllers share ONE BrowserContext — a primary attached to its
// harness page and a satellite attached via BrowserController.attachSatellite —
// and the claims below are all about what the real OwnedPages registry and the
// real context-scoped host-scope guard do under that sharing:
//
//   - a popup opened from one session's page registers to THAT session only;
//     the other session can neither register it nor adopt it;
//   - closing a session's own pages closes its whole family (its page plus
//     every popup it owns) and nothing the other session owns;
//   - the satellite's page gets the same per-navigation normalization as the
//     primary's page (the evaluate-name shim and device spoof);
//   - with the flag off the host-scope guard judges every request
//     unconditionally; with it on, each session's guard judges only its own
//     claimed pages, so a different-site session is not aborted by its
//     neighbour's scope, while an unclaimed page still answers to every guard.
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

  it("flag off: a guard judges every request on the context, with no page-ownership bypass", async () => {
    await primary.setHostScopeAllowedHosts(() => ["127.0.0.1"]);
    await satellite.setHostScopeAllowedHosts(() => ["localhost"]);

    // The primary's own in-scope call is still judged by the satellite's
    // guard (installed later, so it runs first) and aborted — the shipped
    // single-session behavior, where no second guard ever exists.
    expect(await fetchOutcome(primaryPage, `http://127.0.0.1:${port}/api/primary`)).toBe(
      "rejected",
    );
    expect(apiHits).toHaveLength(0);
  }, 30_000);

  it("flag on: scopes each session's host-scope guard to its own claimed pages on the shared context", async () => {
    process.env.TRUSTY_SQUIRE_EXPERIMENTAL_MULTISESSION = "1";
    await primary.setHostScopeAllowedHosts(() => ["127.0.0.1"]);
    await satellite.setHostScopeAllowedHosts(() => ["localhost"]);

    // Each session's own in-scope API call reaches the network even though
    // the OTHER session's guard, also installed on this context, would abort
    // that host if it judged the request.
    expect(await fetchOutcome(primaryPage, `http://127.0.0.1:${port}/api/primary`)).toBe(
      "resolved",
    );
    expect(await fetchOutcome(satellitePage, `http://localhost:${port}/api/satellite`)).toBe(
      "resolved",
    );
    expect(apiHits).toEqual([`127.0.0.1:${port}/api/primary`, `localhost:${port}/api/satellite`]);

    // Each guard still fails closed for its OWN page's out-of-scope call.
    expect(await fetchOutcome(primaryPage, `http://localhost:${port}/api/blocked`)).toBe(
      "rejected",
    );
    expect(await fetchOutcome(satellitePage, `http://127.0.0.1:${port}/api/blocked`)).toBe(
      "rejected",
    );
    expect(apiHits).toHaveLength(2);

    // A page NO session has claimed is judged by every guard on the context:
    // while the satellite is live its ["localhost"] guard aborts this call.
    const unclaimed = await context.newPage();
    await unclaimed.goto(`http://127.0.0.1:${port}/unclaimed`);
    expect(await fetchOutcome(unclaimed, `http://127.0.0.1:${port}/api/unclaimed`)).toBe(
      "rejected",
    );
    expect(apiHits).toHaveLength(2);

    // A finished satellite's guard is unrouted, so only the primary's
    // ["127.0.0.1"] guard remains to judge the same unclaimed page.
    await satellite.closeOwnPagesOnly();
    expect(await fetchOutcome(unclaimed, `http://127.0.0.1:${port}/api/unclaimed`)).toBe(
      "resolved",
    );
    expect(await fetchOutcome(primaryPage, `http://127.0.0.1:${port}/api/after`)).toBe("resolved");
    expect(apiHits).toHaveLength(4);
  }, 30_000);
});
