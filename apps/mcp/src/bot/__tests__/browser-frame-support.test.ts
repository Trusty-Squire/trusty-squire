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
    } else if (req.url === "/frame-duplicate") {
      res.end(
        page_(
          `<button>Frame Button</button><script>document.querySelector('button').textContent = window.name;</script>`,
        ),
      );
    } else if (req.url === "/frame-same") {
      res.end(page_(`<button data-testid="same-frame-btn">Same Frame Button</button>`));
    } else if (req.url === "/frame-select") {
      res.end(
        page_(
          `<label for="shipping">Shipping Method</label>` +
            `<select id="shipping" data-testid="shipping-select">` +
            `<option value="">Choose…</option>` +
            `<option value="std">Standard</option>` +
            `<option value="exp">Express</option>` +
            `</select>`,
        ),
      );
    } else if (req.url === "/frame-cross") {
      res.end(
        page_(
          `<button data-testid="cross-frame-btn">Cross Frame Button</button>` +
            `<input data-testid="cross-frame-input" aria-label="Promo code">`,
        ),
      );
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
      await ctrl.clickInFrame(
        {
          frameUrl,
          frameOrigin: same?.frameOrigin ?? "",
          framePath: same?.framePath ?? "",
        },
        same?.selector ?? "",
      );
      const clicked = await frame?.evaluate(() =>
        document.querySelector('[data-testid="same-frame-btn"]')?.getAttribute("data-clicked"),
      );
      expect(clicked).toBe("1");
    } finally {
      await page.close();
    }
  }, 30000);

  it("surfaces an unconfirmed JavaScript-populated about:blank frame as opaque", async () => {
    const { ctrl, page } = await pageFor(`http://127.0.0.1:${port}/parent`);
    try {
      await page.evaluate(() => {
        document.body.innerHTML = '<iframe id="blank"></iframe>';
        const frame = document.querySelector<HTMLIFrameElement>("#blank")!;
        frame.contentDocument!.body.innerHTML =
          '<button data-testid="blank-button">Blank Button</button>';
      });
      const els = await ctrl.extractInteractiveElements();
      const blank = els.find((element) => element.testId === "blank-button");
      expect(blank?.frameUrl).toBe("about:blank");
      expect(blank?.frameOrigin).toBe("null");
      expect(blank?.frameOpaque).toBe(true);
      expect(blank?.framePath).toBe("0");
    } finally {
      await page.close();
    }
  }, 30000);

  it("keeps a sandboxed srcdoc document opaque after its sandbox attribute is removed", async () => {
    const { ctrl, page } = await pageFor(`http://127.0.0.1:${port}/parent`);
    try {
      await page.setContent(
        page_(
          `<iframe sandbox="allow-scripts" srcdoc='<button data-testid="opaque-button">Opaque</button>'></iframe>`,
        ),
      );
      await page.waitForTimeout(100);
      await page.locator("iframe").evaluate((frame) => frame.removeAttribute("sandbox"));
      const els = await ctrl.extractInteractiveElements();
      const opaque = els.find((element) => element.testId === "opaque-button");
      expect(opaque?.frameOrigin).toBe("null");
      expect(opaque?.frameOpaque).toBe(true);
      expect(opaque?.frameOrigin).not.toBe(`http://127.0.0.1:${port}`);
    } finally {
      await page.close();
    }
  }, 30000);

  it("selects an option in a same-origin iframe <select> via selectInFrame — value committed and change fired atomically", async () => {
    const { ctrl, page } = await pageFor(`http://127.0.0.1:${port}/parent`);
    try {
      await page.setContent(
        page_(`<iframe src="http://127.0.0.1:${port}/frame-select" title="select"></iframe>`),
      );
      await page.waitForLoadState("networkidle");
      const els = await ctrl.extractInteractiveElements();
      const sel = els.find((e) => e.testId === "shipping-select");
      expect(sel).toBeDefined();
      expect(sel?.frameOrigin).toBe(`http://127.0.0.1:${port}`);
      const frame = page.frames().find((f) => f.url() === sel?.frameUrl);
      expect(frame).toBeDefined();
      // The merchant form listens on `change` — a selection that doesn't
      // fire it never reaches the form's state. Observe it in the FRAME's
      // own document.
      await frame?.evaluate(() => {
        const select = document.querySelector('[data-testid="shipping-select"]');
        select?.addEventListener("change", () => select.setAttribute("data-changed", "1"));
      });
      const committed = await ctrl.selectInFrame(
        {
          frameUrl: sel?.frameUrl ?? "",
          frameOrigin: sel?.frameOrigin ?? "",
          framePath: sel?.framePath ?? "",
        },
        sel?.selector ?? "",
        "express",
      );
      expect(committed).toBe("Express");
      const state = await frame?.evaluate(() => {
        const select = document.querySelector<HTMLSelectElement>(
          '[data-testid="shipping-select"]',
        );
        return { value: select?.value, changed: select?.getAttribute("data-changed") };
      });
      expect(state).toEqual({ value: "exp", changed: "1" });
    } finally {
      await page.close();
    }
  }, 30000);

  it("selectInFrame reaches a native <select> through its associated <label> selector", async () => {
    const { ctrl, page } = await pageFor(`http://127.0.0.1:${port}/parent`);
    try {
      await page.setContent(
        page_(`<iframe src="http://127.0.0.1:${port}/frame-select" title="select"></iframe>`),
      );
      await page.waitForLoadState("networkidle");
      const frame = page.frames().find((f) => f.url()?.endsWith("/frame-select"));
      expect(frame).toBeDefined();
      const committed = await ctrl.selectInFrame(
        {
          frameUrl: frame?.url() ?? "",
          frameOrigin: `http://127.0.0.1:${port}`,
          framePath: "0",
        },
        'label[for="shipping"]',
        "standard",
      );
      expect(committed).toBe("Standard");
      expect(
        await frame?.evaluate(
          () => document.querySelector<HTMLSelectElement>("#shipping")?.value,
        ),
      ).toBe("std");
    } finally {
      await page.close();
    }
  }, 30000);

  it("tags a sandboxed (allow-scripts, no allow-same-origin) frame opaque even when its URL is a real same-origin URL", async () => {
    const { ctrl, page } = await pageFor(`http://127.0.0.1:${port}/parent`);
    try {
      // The nonblank-sandbox-origin-bypass case: the frame's URL says
      // "same origin as the page", but sandbox without allow-same-origin
      // gives it an OPAQUE active origin per spec — tagging by URL would
      // let the same-domain secret gate trust it.
      await page.setContent(
        page_(
          `<iframe sandbox="allow-scripts" src="http://127.0.0.1:${port}/frame-same"></iframe>`,
        ),
      );
      await page.waitForLoadState("networkidle");
      const els = await ctrl.extractInteractiveElements();
      const sandboxed = els.find((element) => element.testId === "same-frame-btn");
      expect(sandboxed).toBeDefined();
      expect(sandboxed?.frameOrigin).toBe("null");
      expect(sandboxed?.frameOpaque).toBe(true);
    } finally {
      await page.close();
    }
  }, 30000);

  it("keeps a sandbox='allow-scripts allow-same-origin' frame trusted by its URL (the sandbox rule only ever ADDS a restriction)", async () => {
    const { ctrl, page } = await pageFor(`http://127.0.0.1:${port}/parent`);
    try {
      await page.setContent(
        page_(
          `<iframe sandbox="allow-scripts allow-same-origin" src="http://127.0.0.1:${port}/frame-same"></iframe>`,
        ),
      );
      await page.waitForLoadState("networkidle");
      const els = await ctrl.extractInteractiveElements();
      const framed = els.find((element) => element.testId === "same-frame-btn");
      expect(framed).toBeDefined();
      expect(framed?.frameOrigin).toBe(`http://127.0.0.1:${port}`);
      expect(framed?.frameOpaque ?? false).toBe(false);
    } finally {
      await page.close();
    }
  }, 30000);

  it("resolves locator targets in frames and reports cross-context ambiguity", async () => {
    const { ctrl, page } = await pageFor(`http://127.0.0.1:${port}/parent`);
    try {
      const resolved = await ctrl.resolvePageTarget("text", "Same Frame Button");
      expect(resolved.ok).toBe(true);
      if (resolved.ok) {
        expect(resolved.frameTarget?.frameOrigin).toBe(`http://127.0.0.1:${port}`);
        expect(resolved.frameTarget?.framePath).toBe("0");
        await resolved.handle.dispose();
      }
      const cssResolved = await ctrl.resolvePageTarget("css", '[data-testid="cross-frame-btn"]');
      expect(cssResolved.ok).toBe(true);
      if (cssResolved.ok) {
        expect(cssResolved.frameTarget?.frameOrigin).toBe(`http://localhost:${port}`);
        await cssResolved.handle.dispose();
      }
      const typeResolved = await ctrl.resolvePageTarget("text", "Promo code", "type");
      expect(typeResolved.ok).toBe(true);
      if (typeResolved.ok) {
        expect(typeResolved.frameTarget?.frameOrigin).toBe(`http://localhost:${port}`);
        await ctrl.typeHandle(typeResolved.handle, "SAVE10");
        expect(await typeResolved.handle.inputValue()).toBe("SAVE10");
        await typeResolved.handle.dispose();
      }
      await page.evaluate(() => {
        const button = document.createElement("button");
        button.textContent = "Same Frame Button";
        document.body.append(button);
      });
      const ambiguous = await ctrl.resolvePageTarget("text", "Same Frame Button");
      expect(ambiguous).toMatchObject({ ok: false, reason: "ambiguous" });
    } finally {
      await page.close();
    }
  }, 30000);

  it("uses frame paths when duplicate frame URLs share the same selector", async () => {
    const { ctrl, page } = await pageFor(`http://127.0.0.1:${port}/parent`);
    try {
      await page.setContent(
        page_(
          `<iframe name="First" src="http://127.0.0.1:${port}/frame-duplicate"></iframe>` +
            `<iframe name="Second" src="http://127.0.0.1:${port}/frame-duplicate"></iframe>`,
        ),
      );
      await page.waitForLoadState("networkidle");
      const els = await ctrl.extractInteractiveElements();
      const second = els.find((element) => element.visibleText === "Second");
      expect(second?.framePath).toBe("1");
      const secondFrame = page.frames().find((frame) => frame.name() === "Second")!;
      await secondFrame.evaluate(() => {
        document.querySelector("button")?.addEventListener("click", () => {
          document.body.dataset.clicked = "yes";
        });
      });
      await ctrl.clickInFrame(
        {
          frameUrl: second?.frameUrl ?? "",
          frameOrigin: second?.frameOrigin ?? "",
          framePath: second?.framePath ?? "",
        },
        second?.selector ?? "",
      );
      expect(await secondFrame.evaluate(() => document.body.dataset.clicked)).toBe("yes");
      const firstFrame = page.frames().find((frame) => frame.name() === "First")!;
      expect(await firstFrame.evaluate(() => document.body.dataset.clicked)).toBeUndefined();
    } finally {
      await page.close();
    }
  }, 30000);

  it("redacts a detached frame URL from action errors", async () => {
    const { ctrl, page } = await pageFor(`http://127.0.0.1:${port}/parent`);
    try {
      const target = {
        framePath: "99",
        frameOrigin: `http://127.0.0.1:${port}`,
        frameUrl: `http://127.0.0.1:${port}/frame?secret=never-disclose#token`,
      };
      const errors = await Promise.all([
        ctrl.clickInFrame(target, "button").catch((error: unknown) => error),
        ctrl.typeInFrame(target, "input", "x").catch((error: unknown) => error),
        ctrl.clickViaJsInFrame(target, "button").catch((error: unknown) => error),
      ]);
      for (const error of errors) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain(target.frameOrigin);
        expect((error as Error).message).not.toMatch(/never-disclose|token/);
      }
    } finally {
      await page.close();
    }
  }, 30000);

  it("refuses a stale frame target after the frame navigates to another origin", async () => {
    const { ctrl, page } = await pageFor(`http://127.0.0.1:${port}/parent`);
    try {
      const same = (await ctrl.extractInteractiveElements()).find(
        (element) => element.testId === "same-frame-btn",
      );
      expect(same).toBeDefined();
      const liveFrame = page.frames().find((frame) => frame.url() === same?.frameUrl);
      expect(liveFrame).toBeDefined();
      await page.locator('iframe[title="same"]').evaluate((iframe, nextUrl) => {
        (iframe as HTMLIFrameElement).src = nextUrl;
      }, `http://localhost:${port}/frame-cross`);
      await liveFrame?.waitForURL(`http://localhost:${port}/frame-cross`);
      await expect(
        ctrl.clickInFrame(
          {
            framePath: same?.framePath ?? "",
            frameOrigin: same?.frameOrigin ?? "",
            frameUrl: same?.frameUrl ?? "",
          },
          '[data-testid="cross-frame-btn"]',
        ),
      ).rejects.toThrow(/frame is no longer present/i);
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

  it("skips blank descendants nested under a known captcha frame", async () => {
    const { ctrl, page } = await pageFor("about:blank");
    try {
      await page.route("https://challenges.cloudflare.com/**", async (route) => {
        await route.fulfill({
          contentType: "text/html",
          body: page_(
            `<iframe srcdoc='<button data-testid="nested-captcha-btn">Verify nested</button>'></iframe>`,
          ),
        });
      });
      await page.setContent(
        page_(
          `<iframe src="https://challenges.cloudflare.com/turnstile/v0/challenge" width="300" height="65"></iframe>`,
        ),
      );
      await page.waitForTimeout(500);
      const els = await ctrl.extractInteractiveElements();
      expect(els.find((element) => element.testId === "nested-captcha-btn")).toBeUndefined();
      expect(await ctrl.resolvePageTarget("text", "Verify nested")).toMatchObject({
        ok: false,
        reason: "none",
      });
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
