// Real-Chromium, real-HTTP tests for operator-frame-support:
// extractInteractiveElements traversing child <iframe>s and tagging each
// element with the ORIGIN it actually came from (frameOrigin/frameUrl on
// InteractiveElement), plus the frame-aware act primitive (clickInFrame).
// Uses a tiny local HTTP server so a "same-origin" vs "cross-origin" iframe
// is a genuine origin difference (127.0.0.1 vs localhost, both loopback, no
// network egress) rather than something faked with a data: URL — data:
// frames get an opaque "null" origin and can't stand in for either case.
// Domain-lock GATING (which origins an act is allowed to touch) is covered
// separately, with a mocked browser, in operate-session-flow.test.ts — this
// file is about extraction/tagging/frame-resolution being correct against a
// real DOM.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "playwright";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { BrowserController } from "../browser.js";

function page_(body: string): string {
  return `<!doctype html><html><body style="margin:0;padding:20px">${body}</body></html>`;
}

let httpServer: Server;
let port: number;

beforeAll(async () => {
  httpServer = createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    if (req.url === "/parent") {
      res.end(
        page_(
          `<button data-testid="main-btn">Main Button</button>` +
            `<iframe src="http://127.0.0.1:${port}/frame-same" title="same" width="200" height="100"></iframe>` +
            `<iframe src="http://localhost:${port}/frame-cross" title="cross" width="200" height="100"></iframe>`,
        ),
      );
    } else if (req.url === "/frame-same") {
      res.end(page_(`<button data-testid="same-frame-btn">Same Frame Button</button>`));
    } else if (req.url === "/frame-cross") {
      res.end(page_(`<button data-testid="cross-frame-btn">Cross Frame Button</button>`));
    } else {
      res.statusCode = 404;
      res.end("not found");
    }
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()));
  port = (httpServer.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

let browser: Browser;

async function pageFor(url: string): Promise<{ ctrl: BrowserController; page: Page }> {
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: "networkidle" });
  const ctrl = new BrowserController({ humanize: false });
  // Same injection pattern as shadow-dom-topmost.test.ts: BrowserController's
  // browser is normally created by start() (network geo-probing + a
  // persistent profile launch), unsuitable for a unit test. Inject a
  // directly-launched page so the real extract/click methods run against
  // real Chromium.
  (ctrl as unknown as { page: Page }).page = page;
  return { ctrl, page };
}

describe("extractInteractiveElements — frame support (real Chromium, real HTTP)", () => {
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  });
  afterAll(async () => {
    await browser?.close();
  });

  it("surfaces same-origin AND cross-origin iframe elements, each tagged with its own frame origin — nothing flattened", async () => {
    const { ctrl, page } = await pageFor(`http://127.0.0.1:${port}/parent`);
    try {
      const els = await ctrl.extractInteractiveElements();
      const main = els.find((e) => e.testId === "main-btn");
      const same = els.find((e) => e.testId === "same-frame-btn");
      const cross = els.find((e) => e.testId === "cross-frame-btn");

      // Main-frame element stays untagged — byte-identical to pre-frame-support shape.
      expect(main).toBeDefined();
      expect(main?.frameOrigin ?? null).toBeNull();

      // Same-origin iframe surfaced, tagged with ITS OWN origin (identical to
      // the page here — the simplest "merchant's own iframe" case).
      expect(same).toBeDefined();
      expect(same?.frameOrigin).toBe(`http://127.0.0.1:${port}`);
      expect(same?.frameUrl).toBe(`http://127.0.0.1:${port}/frame-same`);

      // Cross-origin iframe ALSO surfaced (not flattened away at observe time —
      // gating happens at act time, per operate-session-flow.test.ts), tagged
      // with a genuinely different origin.
      expect(cross).toBeDefined();
      expect(cross?.frameOrigin).toBe(`http://localhost:${port}`);
      expect(cross?.frameOrigin).not.toBe(same?.frameOrigin ?? null);
    } finally {
      await page.close();
    }
  }, 30000);

  it("clicks a same-origin iframe element via clickInFrame, reaching the frame's own document", async () => {
    const { ctrl, page } = await pageFor(`http://127.0.0.1:${port}/parent`);
    try {
      const els = await ctrl.extractInteractiveElements();
      const same = els.find((e) => e.testId === "same-frame-btn");
      expect(same).toBeDefined();
      const frameUrl = same?.frameUrl ?? "";
      expect(frameUrl).toBe(`http://127.0.0.1:${port}/frame-same`);
      // Add a click handler inside the FRAME's own document (not the main
      // page) so a successful click can only be observed via that frame.
      const frame = page.frames().find((f) => f.url() === frameUrl);
      expect(frame).toBeDefined();
      await frame?.evaluate(() => {
        const btn = document.querySelector('[data-testid="same-frame-btn"]');
        btn?.addEventListener("click", () => btn.setAttribute("data-clicked", "1"));
      });
      await ctrl.clickInFrame(frameUrl, same?.selector ?? "");
      const clicked = await frame?.evaluate(
        () => document.querySelector('[data-testid="same-frame-btn"]')?.getAttribute("data-clicked"),
      );
      expect(clicked).toBe("1");
    } finally {
      await page.close();
    }
  }, 30000);

  it("skips a known captcha-challenge iframe — its content is not surfaced as el_table rows (regression: captcha handling unchanged)", async () => {
    const { ctrl, page } = await pageFor("about:blank");
    try {
      // Route interception, not a real network call: proves the SKIP is by
      // hostname pattern, without depending on internet access in CI.
      await page.route("https://challenges.cloudflare.com/**", async (route) => {
        await route.fulfill({
          contentType: "text/html",
          body: page_(`<button data-testid="captcha-internal-btn">Verify</button>`),
        });
      });
      await page.setContent(
        page_(
          `<button data-testid="main-btn">Main Button</button>` +
            `<iframe src="https://challenges.cloudflare.com/turnstile/v0/challenge" title="captcha" width="300" height="65"></iframe>`,
        ),
      );
      await page.waitForTimeout(500); // let the routed iframe response commit
      const els = await ctrl.extractInteractiveElements();
      expect(els.find((e) => e.testId === "main-btn")).toBeDefined();
      expect(els.find((e) => e.testId === "captcha-internal-btn")).toBeUndefined();
    } finally {
      await page.close();
    }
  }, 30000);

  it("negative control: a page with no iframes extracts exactly as before (regression)", async () => {
    const { ctrl, page } = await pageFor("about:blank");
    try {
      await page.setContent(page_(`<button data-testid="lonely-btn">Lonely Button</button>`));
      const els = await ctrl.extractInteractiveElements();
      expect(els).toHaveLength(1);
      expect(els[0]?.testId).toBe("lonely-btn");
      expect(els[0]?.frameOrigin ?? null).toBeNull();
    } finally {
      await page.close();
    }
  }, 30000);
});
