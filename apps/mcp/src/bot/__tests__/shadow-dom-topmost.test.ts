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
import { provisionElementRefs, resolveTarget } from "../provision-session.js";

// An open-shadow-root button that flips its own text on click, plus a plain
// light-DOM button as the unchanged control. Nothing overlaps either button.
const SHADOW_FIXTURE = `data:text/html,${encodeURIComponent(`
<!doctype html><html><body style="margin:0;padding:40px">
  <button id="plain" data-testid="plain-btn">Plain Button</button>
  <cart-widget></cart-widget>
  <script>
    class CtaLabel extends HTMLElement {
      constructor() {
        super();
        const root = this.attachShadow({ mode: "open" });
        root.innerHTML = '<span>Add To Cart</span>';
      }
    }
    customElements.define("cta-label", CtaLabel);

    class CartWidget extends HTMLElement {
      constructor() {
        super();
        const root = this.attachShadow({ mode: "open" });
        root.innerHTML =
          '<button id="buy" data-testid="add-to-cart" aria-label="Add To Cart" style="position:relative;width:180px;height:64px;font-size:18px"><cta-label style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center"></cta-label></button>';
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
  <button id="plain" data-testid="plain-btn">${"<span>".repeat(80)}Plain Button${"</span>".repeat(80)}</button>
</body></html>`)}`;

const SLOTTED_FIXTURE = `data:text/html,${encodeURIComponent(`
<!doctype html><html><body style="margin:0;padding:40px">
  <slotted-widget style="display:inline-block">
    <span data-testid="slotted-label" style="display:block;padding:20px">Slotted Add To Cart</span>
  </slotted-widget>
  <script>
    class SlottedWidget extends HTMLElement {
      constructor() {
        super();
        const root = this.attachShadow({ mode: "open" });
        root.innerHTML =
          '<button id="inner" data-testid="slotted-cta" style="padding:0;font-size:18px"><slot></slot></button>';
      }
    }
    customElements.define("slotted-widget", SlottedWidget);
  </script>
</body></html>`)}`;

const DEEP_SHADOW_FIXTURE = `data:text/html,${encodeURIComponent(`
<!doctype html><html><body style="margin:0;padding:40px">
  <script>
    let host = document.createElement("div");
    document.body.append(host);
    for (let depth = 0; depth < 40; depth += 1) {
      const root = host.attachShadow({ mode: "open" });
      if (depth === 39) {
        root.innerHTML =
          '<button data-testid="deep-shadow-cta" style="width:180px;height:64px">Deep Add To Cart</button>';
      } else {
        const next = document.createElement("div");
        root.append(next);
        host = next;
      }
    }
  </script>
</body></html>`)}`;

const DEEP_SLOTTED_FIXTURE = `data:text/html,${encodeURIComponent(`
<!doctype html><html><body style="margin:0;padding:40px">
  <script>
    let content = document.createElement("span");
    content.textContent = "Deep Slotted Add To Cart";
    for (let depth = 79; depth >= 0; depth -= 1) {
      const host = document.createElement("div");
      host.append(content);
      const root = host.attachShadow({ mode: "open" });
      root.innerHTML = depth === 0
        ? '<button data-testid="deep-slotted-cta" style="padding:20px"><slot></slot></button>'
        : '<slot></slot>';
      content = host;
    }
    document.body.append(content);
  </script>
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
      const cta = els.find((e) => e.testId === "add-to-cart");

      // (a) surfaced by the extractor (shadow-root walk).
      expect(cta).toBeDefined();

      // (b) judged topmost — nothing covers it. Pre-fix this was
      // topmost:false / occludedBy:"cart-widget" because
      // document.elementFromPoint returned the host, not the inner button.
      expect(cta?.topmost).toBe(true);
      expect(cta?.occludedBy).toBeNull();

      // (c) clickable by the ref/selector the extractor emitted — the click
      // must reach the shadow-nested button and fire its handler.
      const generation = 1;
      const ref = cta === undefined ? undefined : provisionElementRefs(els, generation).get(cta);
      expect(ref).toMatch(/^@g1:/);
      const resolved = resolveTarget(els, ref ?? "", generation);
      expect(resolved).toBe(cta);
      expect(resolved?.visibleText ?? resolved?.ariaLabel).toBe("Add To Cart");
      await ctrl.click(resolved?.selector ?? "");
      const flipped = await page.evaluate(
        () => document.querySelector("cart-widget")?.shadowRoot?.querySelector("#buy")?.textContent,
      );
      expect(flipped).toBe("ADDED");
    } finally {
      await page.close();
    }
  }, 30000);

  it("negative control: plain-DOM extraction is unchanged (button present + topmost)", async () => {
    const { ctrl, page } = await pageFor(PLAIN_FIXTURE);
    try {
      const hitDepth = await page.evaluate(() => {
        const button = document.querySelector("#plain");
        if (!(button instanceof HTMLElement)) return 0;
        const rect = button.getBoundingClientRect();
        let hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        let depth = 0;
        while (hit !== null && hit !== button) {
          hit = hit.parentElement;
          depth += 1;
        }
        return depth;
      });
      expect(hitDepth).toBeGreaterThan(64);

      const els = await ctrl.extractInteractiveElements();
      const plain = els.find((e) => e.visibleText === "Plain Button");
      expect(plain).toBeDefined();
      expect(plain?.topmost).toBe(true);
      expect(plain?.occludedBy).toBeNull();
    } finally {
      await page.close();
    }
  }, 30000);

  it("treats a slotted label as owned by its shadow-root button", async () => {
    const { ctrl, page } = await pageFor(SLOTTED_FIXTURE);
    try {
      const deepestHit = await page.evaluate(() => {
        const host = document.querySelector("slotted-widget");
        const button = host?.shadowRoot?.querySelector("#inner");
        if (!(host instanceof HTMLElement) || !(button instanceof HTMLElement)) return null;
        const rect = button.getBoundingClientRect();
        return host.shadowRoot
          ?.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
          ?.getAttribute("data-testid");
      });
      expect(deepestHit).toBe("slotted-label");

      const els = await ctrl.extractInteractiveElements();
      const cta = els.find((e) => e.testId === "slotted-cta");
      expect(cta).toBeDefined();
      expect(cta?.topmost).toBe(true);
      expect(cta?.occludedBy).toBeNull();
    } finally {
      await page.close();
    }
  }, 30000);

  it("descends through more than 32 nested open shadow roots", async () => {
    const { ctrl, page } = await pageFor(DEEP_SHADOW_FIXTURE);
    try {
      const els = await ctrl.extractInteractiveElements();
      const cta = els.find((e) => e.testId === "deep-shadow-cta");
      expect(cta).toBeDefined();
      expect(cta?.topmost).toBe(true);
      expect(cta?.occludedBy).toBeNull();
    } finally {
      await page.close();
    }
  }, 30000);

  it("walks more than 64 composed ancestors to a shadow-root button", async () => {
    const { ctrl, page } = await pageFor(DEEP_SLOTTED_FIXTURE);
    try {
      const els = await ctrl.extractInteractiveElements();
      const cta = els.find((e) => e.testId === "deep-slotted-cta");
      expect(cta).toBeDefined();
      expect(cta?.topmost).toBe(true);
      expect(cta?.occludedBy).toBeNull();
    } finally {
      await page.close();
    }
  }, 30000);
});
