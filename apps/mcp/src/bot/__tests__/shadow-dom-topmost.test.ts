// Regression test: the operator's DOM extractor must judge occlusion for an
// element nested in an OPEN shadow root correctly. extractInteractiveElements
// already recurses into open shadow roots (collectAcrossShadowRoots, PR #90),
// so a shadow-DOM CTA IS surfaced. The residual defect this covers is that
// topmostStatus hit-tested with document.elementFromPoint, which returns the
// shadow HOST rather than the control inside the host's shadow root — so a
// storefront that renders "Add To Cart" inside a web component (Casetify,
// Klarna widgets) had its CTA reported topmost:false / occludedBy:<host>. The
// host agent then treats the button as covered and never clicks it. The fix
// descends through open shadow roots at the hit point. This test drives a real
// Chromium page: extraction, topmost judgment, and click-by-ref are all
// exercised end-to-end. A plain-DOM control confirms the descent is a no-op for
// normal elements. Synthetic fixture only — no real credentials.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { BrowserController } from "../browser.js";

// An open-shadow-root button that flips its own text on click, plus a plain
// light-DOM button as the unchanged control. Nothing overlaps either button.
const SHADOW_FIXTURE = `data:text/html,${encodeURIComponent(`
<!doctype html><html><body style="margin:0;padding:40px">
  <button id="plain" data-testid="plain-btn">Plain Button</button>
  <cart-widget></cart-widget>
  <script>
    class CartWidget extends HTMLElement {
      constructor() {
        super();
        const root = this.attachShadow({ mode: "open" });
        root.innerHTML =
          '<button id="buy" data-testid="add-to-cart" style="padding:20px;font-size:18px">Add To Cart</button>';
        const btn = root.getElementById("buy");
        btn.addEventListener("click", function () { btn.textContent = "ADDED"; });
      }
    }
    customElements.define("cart-widget", CartWidget);
  </script>
</body></html>`)}`;

// A plain page with no shadow DOM — the negative control for "normal-DOM
// extraction is unchanged".
const PLAIN_FIXTURE = `data:text/html,${encodeURIComponent(`
<!doctype html><html><body style="margin:0;padding:40px">
  <button id="plain" data-testid="plain-btn">Plain Button</button>
</body></html>`)}`;

let browser: Browser;

async function pageFor(url: string): Promise<{ ctrl: BrowserController; page: Page }> {
  const page = await browser.newPage();
  await page.goto(url);
  const ctrl = new BrowserController({ humanize: false });
  // The controller's browser is normally created by start(), which does
  // network geo-probing + a persistent profile launch unsuitable for a unit
  // test. Inject a directly-launched page so the REAL extract/click methods run
  // against real Chromium. Mirrors the private-field access in
  // browser-humanize.test.ts.
  (ctrl as unknown as { page: Page }).page = page;
  return { ctrl, page };
}

describe("extractInteractiveElements — open shadow root occlusion (real Chromium)", () => {
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  });
  afterAll(async () => {
    await browser?.close();
  });

  it("surfaces a shadow-nested button, reports it topmost, and clicks it by ref", async () => {
    const { ctrl, page } = await pageFor(SHADOW_FIXTURE);
    try {
      const els = await ctrl.extractInteractiveElements();
      const cta = els.find((e) => e.visibleText === "Add To Cart");

      // (a) surfaced by the extractor (shadow-root walk).
      expect(cta).toBeDefined();

      // (b) judged topmost — nothing covers it. Pre-fix this was
      // topmost:false / occludedBy:"cart-widget" because
      // document.elementFromPoint returned the host, not the inner button.
      expect(cta?.topmost).toBe(true);
      expect(cta?.occludedBy).toBeNull();

      // (c) clickable by the ref/selector the extractor emitted — the click
      // must reach the shadow-nested button and fire its handler.
      await ctrl.click(cta?.selector ?? "");
      const flipped = await page.evaluate(
        () =>
          document
            .querySelector("cart-widget")
            ?.shadowRoot?.querySelector("#buy")?.textContent,
      );
      expect(flipped).toBe("ADDED");
    } finally {
      await page.close();
    }
  }, 30000);

  it("negative control: plain-DOM extraction is unchanged (button present + topmost)", async () => {
    const { ctrl, page } = await pageFor(PLAIN_FIXTURE);
    try {
      const els = await ctrl.extractInteractiveElements();
      const plain = els.find((e) => e.visibleText === "Plain Button");
      expect(plain).toBeDefined();
      expect(plain?.topmost).toBe(true);
      expect(plain?.occludedBy).toBeNull();
    } finally {
      await page.close();
    }
  }, 30000);
});
