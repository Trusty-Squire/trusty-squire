// Regression test for the operator's `text=`/`css=` locator click fallback.
//
// The live bug (casetify.com Impact-Case PDP): the "Add To Cart" control is a
// bare click-handler <div id=… action-type="ADD_TO_CART"> with no role, label,
// or test-id. The SELECTOR walk in extractInteractiveElements skips it (no
// interactive semantics) and the card scan drops it because it is the ~45th
// cursor:pointer card-eligible element and the scan hard-caps at MAX_CARDS(16),
// which is exhausted by earlier decorative clickable divs. So NO ref ever
// resolves to it and the host cannot click it.
//
// The fix: operate_act accepts a locator-form target — `text="Add To Cart"` or
// `css=<selector>` — resolved DIRECTLY against the live page by
// BrowserController.resolvePageTarget, which returns a live ElementHandle. It
// matches on rendered text (innerText, so hidden descendants don't leak), gates
// on a real click affordance, checks visibility through the ancestor chain,
// collapses a button and its inner <span> to one, refuses an ambiguous match,
// and pierces open shadow roots. clickHandle uses one actionability-checked click
// (noWaitAfter, so it can't throw post-dispatch and double-click); jsClickHandle
// is the explicit DOM-dispatch path through a transparent overlay. This test
// drives real Chromium. Synthetic fixtures only — no credentials.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { BrowserController } from "../browser.js";
import { parseLocatorTarget, shouldBlockUnsafeProvisionAction } from "../provision-session.js";

// Mirrors the Casetify shape: 20 decorative cursor:pointer card-eligible divs
// BEFORE a bare click-handler <div> CTA whose only child with text is a <span>.
// The 20 fillers exhaust the extractor's 16-card budget so the CTA is NOT
// emitted — the exact live miss. window.__cart increments when the CTA fires.
const CASETIFY_FIXTURE = `data:text/html,${encodeURIComponent(`
<!doctype html><html><body style="margin:0;padding:0">
  <div id="filler"></div>
  <script>
    window.__cart = 0;
    const filler = document.getElementById("filler");
    for (let i = 0; i < 20; i++) {
      const d = document.createElement("div");
      d.textContent = "Deco " + i;
      d.style.cssText = "cursor:pointer;width:120px;height:40px";
      filler.append(d);
    }
    const btn = document.createElement("div");
    btn.id = "PDP_2025_PRODUCT_ACTION_ADD_TO_CART_BTN";
    btn.setAttribute("action-type", "ADD_TO_CART");
    btn.style.cssText = "cursor:pointer;width:300px;height:46px";
    const span = document.createElement("span");
    span.textContent = "Add To Cart";
    span.style.cssText = "cursor:pointer";
    btn.append(span);
    btn.addEventListener("click", () => { window.__cart++; });
    document.body.append(btn);
  </script>
</body></html>`)}`;

// Two separate, non-nested "Add To Cart" buttons — resolvePageTarget must refuse
// rather than silently pick one.
const AMBIGUOUS_FIXTURE = `data:text/html,${encodeURIComponent(`
<!doctype html><html><body style="margin:0;padding:0">
  <div style="cursor:pointer;width:200px;height:40px">Add To Cart</div>
  <div style="cursor:pointer;width:200px;height:40px">Add To Cart</div>
</body></html>`)}`;

// A control whose text contains regex metacharacters — the resolver must match
// it LITERALLY (string comparison, not a regex built from user input).
const METACHAR_FIXTURE = `data:text/html,${encodeURIComponent(`
<!doctype html><html><body style="margin:0;padding:0">
  <script>
    window.__hit = 0;
    const b = document.createElement("button");
    b.textContent = "Delete (all) items [x]";
    b.addEventListener("click", () => { window.__hit++; });
    document.body.append(b);
  </script>
</body></html>`)}`;

// Prose that merely CONTAINS the words but carries no click affordance — must
// NOT be matched.
const PROSE_FIXTURE = `data:text/html,${encodeURIComponent(`
<!doctype html><html><body style="margin:0;padding:0">
  <p>Please remember to add to cart before you leave the page.</p>
</body></html>`)}`;

// A VISIBLE "Cancel" button that hides a "Delete account" span (display:none).
// text="Delete account" must NOT resolve to the Cancel button (textContent would
// have leaked the hidden text).
const HIDDEN_TEXT_FIXTURE = `data:text/html,${encodeURIComponent(`
<!doctype html><html><body style="margin:0;padding:0">
  <button id="cancel" style="width:200px;height:40px">Cancel<span style="display:none">Delete account</span></button>
</body></html>`)}`;

// A real button under an opacity:0 ANCESTOR — its own computed opacity is 1 and
// its rect is nonzero, so a self-only visibility check would wrongly click it.
const TRANSPARENT_ANCESTOR_FIXTURE = `data:text/html,${encodeURIComponent(`
<!doctype html><html><body style="margin:0;padding:0">
  <div style="opacity:0">
    <button style="width:200px;height:40px">Add To Cart</button>
  </div>
</body></html>`)}`;

// Two GENUINE nested interactive controls with the same label but distinct
// handlers — must be reported ambiguous, never silently collapsed to one.
const NESTED_STRONG_FIXTURE = `data:text/html,${encodeURIComponent(`
<!doctype html><html><body style="margin:0;padding:0">
  <div role="button" style="cursor:pointer;padding:20px">
    <button style="cursor:pointer">Delete</button>
  </div>
</body></html>`)}`;

// Two WEAK (bare cursor:pointer + addEventListener, no strong semantics) divs in
// a NESTING relationship, each with its own handler. Dropping the outer would
// pick the inner, whose click bubbles into the outer's handler too — a double
// dispatch. resolvePageTarget must report ambiguous, never silently inner-pick.
const NESTED_WEAK_FIXTURE = `data:text/html,${encodeURIComponent(`
<!doctype html><html><body style="margin:0;padding:0">
  <script>
    window.__outer = 0; window.__inner = 0;
    const outer = document.createElement("div");
    outer.style.cssText = "cursor:pointer;padding:24px";
    outer.addEventListener("click", () => { window.__outer++; });
    const inner = document.createElement("div");
    inner.textContent = "Add To Cart";
    inner.style.cssText = "cursor:pointer;width:200px;height:40px";
    inner.addEventListener("click", () => { window.__inner++; });
    outer.append(inner);
    document.body.append(outer);
  </script>
</body></html>`)}`;

const WEAK_ANCESTOR_STRONG_CHILD_FIXTURE = `data:text/html,${encodeURIComponent(`
<!doctype html><html><body style="margin:0;padding:0">
  <script>
    window.__outer = 0; window.__inner = 0;
    const outer = document.createElement("div");
    outer.style.cssText = "cursor:pointer;padding:24px";
    outer.addEventListener("click", () => { window.__outer++; });
    const inner = document.createElement("button");
    inner.textContent = "Add To Cart";
    inner.style.cssText = "cursor:pointer;width:200px;height:40px";
    inner.addEventListener("click", () => { window.__inner++; });
    outer.append(inner);
    document.body.append(outer);
  </script>
</body></html>`)}`;

const ICON_ONLY_SAVE_FIXTURE = `data:text/html,${encodeURIComponent(`
<!doctype html><html><body style="margin:0;padding:0">
  <button id="saveIcon" aria-label="saveProduct" title="PersistBillingProduct"
    name="save-product" value="save" action-type="SAVE_PRODUCT"
    style="width:40px;height:40px"></button>
</body></html>`)}`;

const ACTION_TYPE_ONLY_SAVE_FIXTURE = `data:text/html,${encodeURIComponent(`
<!doctype html><html><body style="margin:0;padding:0">
  <button id="x" action-type="SAVE_PRODUCT" style="width:40px;height:40px"></button>
</body></html>`)}`;

const LONG_METADATA_SAVE_FIXTURE = `data:text/html,${encodeURIComponent(`
<!doctype html><html><body style="margin:0;padding:0">
  <button id="${"benign".repeat(200)}" style="width:200px;height:40px">Save product</button>
</body></html>`)}`;

const LONG_SAFETY_SUFFIX_FIXTURES = [
  {
    source: "visible text",
    fixture: `data:text/html,${encodeURIComponent(`
<!doctype html><html><body style="margin:0;padding:0">
  <button style="width:200px;height:40px">${"Benign ".repeat(40)}Save product</button>
</body></html>`)}`,
  },
  {
    source: "aria-label",
    fixture: `data:text/html,${encodeURIComponent(`
<!doctype html><html><body style="margin:0;padding:0">
  <button aria-label="${"benign ".repeat(40)}Save product" style="width:200px;height:40px"></button>
</body></html>`)}`,
  },
] as const;

// Many visible divs — css=div must return ambiguous via the pool cap without
// running the pairwise O(n^2) nesting scan over all of them.
const MANY_DIVS_FIXTURE = `data:text/html,${encodeURIComponent(`
<!doctype html><html><body style="margin:0;padding:0"><script>
  for (let i = 0; i < 200; i++) {
    const d = document.createElement("div");
    d.textContent = "row " + i;
    d.style.cssText = "width:100px;height:10px";
    document.body.append(d);
  }
</script></body></html>`)}`;

// A resolvable but DISABLED button — clickHandle must refuse rather than
// no-op a native disabled control (which act() would wrongly audit as success).
const DISABLED_FIXTURE = `data:text/html,${encodeURIComponent(`
<!doctype html><html><body style="margin:0;padding:0">
  <script>
    window.__cart = 0;
    const b = document.createElement("button");
    b.textContent = "Add To Cart";
    b.disabled = true;
    b.style.cssText = "width:200px;height:40px";
    b.addEventListener("click", () => { window.__cart++; });
    document.body.append(b);
  </script>
</body></html>`)}`;

const ARIA_DISABLED_FIXTURE = `data:text/html,${encodeURIComponent(`
<!doctype html><html><body style="margin:0;padding:0">
  <script>
    window.__cart = 0;
    const wrapper = document.createElement("div");
    wrapper.setAttribute("aria-disabled", "true");
    const b = document.createElement("div");
    b.textContent = "Add To Cart";
    b.style.cssText = "cursor:pointer;width:200px;height:40px";
    b.addEventListener("click", () => { window.__cart++; });
    wrapper.append(b);
    document.body.append(wrapper);
  </script>
</body></html>`)}`;

const DETACHED_FIXTURE = `data:text/html,${encodeURIComponent(`
<!doctype html><html><body style="margin:0;padding:0">
  <button id="buy" style="width:200px;height:40px">Add To Cart</button>
</body></html>`)}`;

const OVERLAY_FIXTURE = `data:text/html,${encodeURIComponent(`
<!doctype html><html><body style="margin:0;padding:0">
  <script>
    window.__cart = 0;
    const b = document.createElement("button");
    b.textContent = "Add To Cart";
    b.style.cssText = "width:200px;height:40px";
    b.addEventListener("click", () => { window.__cart++; });
    document.body.append(b);
    const overlay = document.createElement("div");
    overlay.id = "overlay";
    overlay.style.cssText = "position:fixed;inset:0;z-index:10;background:transparent";
    document.body.append(overlay);
  </script>
</body></html>`)}`;

// CTA rendered inside an OPEN shadow root — resolvePageTarget must pierce it.
const SHADOW_FIXTURE = `data:text/html,${encodeURIComponent(`
<!doctype html><html><body style="margin:0;padding:0">
  <cart-widget></cart-widget>
  <script>
    window.__cart = 0;
    class CartWidget extends HTMLElement {
      constructor() {
        super();
        const root = this.attachShadow({ mode: "open" });
        const d = document.createElement("div");
        d.setAttribute("action-type", "ADD_TO_CART");
        d.style.cssText = "cursor:pointer;width:200px;height:46px";
        d.textContent = "Add To Cart";
        d.addEventListener("click", () => { window.__cart++; });
        root.append(d);
      }
    }
    customElements.define("cart-widget", CartWidget);
  </script>
</body></html>`)}`;

const SHADOW_ARIA_DISABLED_FIXTURE = `data:text/html,${encodeURIComponent(`
<!doctype html><html><body style="margin:0;padding:0">
  <cart-widget aria-disabled="true"></cart-widget>
  <script>
    window.__cart = 0;
    class CartWidget extends HTMLElement {
      constructor() {
        super();
        const root = this.attachShadow({ mode: "open" });
        const d = document.createElement("div");
        d.setAttribute("action-type", "ADD_TO_CART");
        d.style.cssText = "cursor:pointer;width:200px;height:46px";
        d.textContent = "Add To Cart";
        d.addEventListener("click", () => { window.__cart++; });
        root.append(d);
      }
    }
    customElements.define("cart-widget", CartWidget);
  </script>
</body></html>`)}`;

let browser: Browser;

async function pageFor(url: string): Promise<{ ctrl: BrowserController; page: Page }> {
  const page = await browser.newPage();
  await page.goto(url);
  const ctrl = new BrowserController({ humanize: false });
  // Inject a directly-launched page so the REAL methods run against real
  // Chromium (mirrors shadow-dom-topmost.test.ts / browser-humanize.test.ts).
  (ctrl as unknown as { page: Page }).page = page;
  return { ctrl, page };
}

const cart = (page: Page): Promise<number> =>
  page.evaluate(() => (window as unknown as { __cart: number }).__cart);

describe("parseLocatorTarget", () => {
  it("parses text= with and without quotes", () => {
    expect(parseLocatorTarget("text=Add To Cart")).toEqual({ mode: "text", value: "Add To Cart" });
    expect(parseLocatorTarget('text="Add To Cart"')).toEqual({ mode: "text", value: "Add To Cart" });
    expect(parseLocatorTarget("text='Buy now'")).toEqual({ mode: "text", value: "Buy now" });
  });
  it("parses css=", () => {
    expect(parseLocatorTarget("css=#buy-btn")).toEqual({ mode: "css", value: "#buy-btn" });
    expect(parseLocatorTarget("CSS=.a > .b")).toEqual({ mode: "css", value: ".a > .b" });
  });
  it("returns null for a plain label or an @e: ref", () => {
    expect(parseLocatorTarget("Add To Cart")).toBeNull();
    expect(parseLocatorTarget("@e:abc123_1")).toBeNull();
    expect(parseLocatorTarget("text=")).toBeNull();
  });
});

describe("resolvePageTarget (real Chromium)", () => {
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  });
  afterAll(async () => {
    await browser?.close();
  });

  it("resolves + clicks a bare CTA div the extractor never emitted", async () => {
    const { ctrl, page } = await pageFor(CASETIFY_FIXTURE);
    try {
      // Precondition: the extractor genuinely misses this CTA (the live bug).
      const els = await ctrl.extractInteractiveElements();
      const emitted = els.filter((e) => /add to cart/i.test(e.visibleText ?? ""));
      expect(emitted).toHaveLength(0);

      const resolved = await ctrl.resolvePageTarget("text", "Add To Cart");
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) throw new Error("unreachable");
      expect(resolved.text).toBe("Add To Cart");
      expect(resolved.safetyText).toContain("add to cart");

      await ctrl.clickHandle(resolved.handle);
      await resolved.handle.dispose();
      // Exactly one dispatch — the actionability click must not double-fire.
      expect(await cart(page)).toBe(1);
    } finally {
      await page.close();
    }
  });

  it("refuses an ambiguous text match and lists candidates", async () => {
    const { ctrl, page } = await pageFor(AMBIGUOUS_FIXTURE);
    try {
      const resolved = await ctrl.resolvePageTarget("text", "Add To Cart");
      expect(resolved.ok).toBe(false);
      if (resolved.ok) throw new Error("unreachable");
      expect(resolved.reason).toBe("ambiguous");
      expect(resolved.candidates.length).toBe(2);
    } finally {
      await page.close();
    }
  });

  it("reports none when nothing matches", async () => {
    const { ctrl, page } = await pageFor(CASETIFY_FIXTURE);
    try {
      const resolved = await ctrl.resolvePageTarget("text", "Checkout Now");
      expect(resolved.ok).toBe(false);
      if (resolved.ok) throw new Error("unreachable");
      expect(resolved.reason).toBe("none");
    } finally {
      await page.close();
    }
  });

  it("matches regex-metachar text literally (no injection)", async () => {
    const { ctrl, page } = await pageFor(METACHAR_FIXTURE);
    try {
      const resolved = await ctrl.resolvePageTarget("text", "Delete (all) items [x]");
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) throw new Error("unreachable");
      await ctrl.clickHandle(resolved.handle);
      await resolved.handle.dispose();
      expect(await page.evaluate(() => (window as unknown as { __hit: number }).__hit)).toBe(1);
    } finally {
      await page.close();
    }
  });

  it("does NOT match affordance-less prose that merely contains the words", async () => {
    const { ctrl, page } = await pageFor(PROSE_FIXTURE);
    try {
      const resolved = await ctrl.resolvePageTarget("text", "add to cart");
      expect(resolved.ok).toBe(false);
    } finally {
      await page.close();
    }
  });

  it("resolves + clicks via a css= selector", async () => {
    const { ctrl, page } = await pageFor(CASETIFY_FIXTURE);
    try {
      const resolved = await ctrl.resolvePageTarget("css", "#PDP_2025_PRODUCT_ACTION_ADD_TO_CART_BTN");
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) throw new Error("unreachable");
      await ctrl.clickHandle(resolved.handle);
      await resolved.handle.dispose();
      expect(await cart(page)).toBe(1);
    } finally {
      await page.close();
    }
  });

  it("returns accessible metadata separately from the visible audit label", async () => {
    const { ctrl, page } = await pageFor(ICON_ONLY_SAVE_FIXTURE);
    try {
      const resolved = await ctrl.resolvePageTarget("css", "#saveIcon");
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) throw new Error("unreachable");
      expect(resolved.text).toBe("");
      expect(resolved.safetyText).toContain("save product");
      expect(resolved.safetyText).toContain("persist billing product");
      expect(resolved.safetyText).toContain("save icon");
      await resolved.handle.dispose();
    } finally {
      await page.close();
    }
  });

  it("token-normalizes action-type safety metadata", async () => {
    const { ctrl, page } = await pageFor(ACTION_TYPE_ONLY_SAVE_FIXTURE);
    try {
      const resolved = await ctrl.resolvePageTarget("css", "#x");
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) throw new Error("unreachable");
      expect(resolved.text).toBe("");
      expect(resolved.safetyText).toContain("save product");
      expect(resolved.safetyText).not.toContain("SAVE_PRODUCT");
      await resolved.handle.dispose();
    } finally {
      await page.close();
    }
  });

  it("blocks visible billing text despite long benign metadata", async () => {
    const { ctrl, page } = await pageFor(LONG_METADATA_SAVE_FIXTURE);
    try {
      const resolved = await ctrl.resolvePageTarget("css", "button");
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) throw new Error("unreachable");
      expect(resolved.safetyText.startsWith("save product")).toBe(true);
      expect(
        shouldBlockUnsafeProvisionAction(
          "Dashboard Products Live mode",
          { kind: "click", target: resolved.safetyText },
          { redactTarget: true },
        ),
      ).toMatch(/Mode safety guard/);
      await resolved.handle.dispose();
    } finally {
      await page.close();
    }
  });

  it.each(LONG_SAFETY_SUFFIX_FIXTURES)(
    "blocks billing text after long benign $source content",
    async ({ fixture }) => {
      const { ctrl, page } = await pageFor(fixture);
      try {
        const resolved = await ctrl.resolvePageTarget("css", "button");
        expect(resolved.ok).toBe(true);
        if (!resolved.ok) throw new Error("unreachable");
        expect(resolved.safetyText).toContain("save product");
        expect(
          shouldBlockUnsafeProvisionAction(
            "Dashboard Products Live mode",
            { kind: "click", target: resolved.safetyText },
            { redactTarget: true },
          ),
        ).toMatch(/Mode safety guard/);
        await resolved.handle.dispose();
      } finally {
        await page.close();
      }
    },
  );

  it("pierces an open shadow root", async () => {
    const { ctrl, page } = await pageFor(SHADOW_FIXTURE);
    try {
      const resolved = await ctrl.resolvePageTarget("text", "Add To Cart");
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) throw new Error("unreachable");
      await ctrl.clickHandle(resolved.handle);
      await resolved.handle.dispose();
      expect(await cart(page)).toBe(1);
    } finally {
      await page.close();
    }
  });

  it("refuses a shadow-root control disabled by its host", async () => {
    const { ctrl, page } = await pageFor(SHADOW_ARIA_DISABLED_FIXTURE);
    try {
      const resolved = await ctrl.resolvePageTarget("text", "Add To Cart");
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) throw new Error("unreachable");
      await expect(ctrl.clickHandle(resolved.handle)).rejects.toThrow(/disabled/);
      await expect(ctrl.jsClickHandle(resolved.handle)).rejects.toThrow(/disabled/);
      await resolved.handle.dispose();
      expect(await cart(page)).toBe(0);
    } finally {
      await page.close();
    }
  });

  it("js_click fires the handler via the resolved handle", async () => {
    const { ctrl, page } = await pageFor(CASETIFY_FIXTURE);
    try {
      const resolved = await ctrl.resolvePageTarget("text", "Add To Cart");
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) throw new Error("unreachable");
      await ctrl.jsClickHandle(resolved.handle);
      await resolved.handle.dispose();
      expect(await cart(page)).toBe(1);
    } finally {
      await page.close();
    }
  });

  it("does not match hidden descendant text (uses rendered text)", async () => {
    const { ctrl, page } = await pageFor(HIDDEN_TEXT_FIXTURE);
    try {
      const resolved = await ctrl.resolvePageTarget("text", "Delete account");
      expect(resolved.ok).toBe(false);
      const visible = await ctrl.resolvePageTarget("text", "Cancel");
      expect(visible.ok).toBe(true);
      if (visible.ok) await visible.handle.dispose();
    } finally {
      await page.close();
    }
  });

  it("treats a control under an opacity:0 ancestor as invisible", async () => {
    const { ctrl, page } = await pageFor(TRANSPARENT_ANCESTOR_FIXTURE);
    try {
      const resolved = await ctrl.resolvePageTarget("text", "Add To Cart");
      expect(resolved.ok).toBe(false);
      if (resolved.ok) throw new Error("unreachable");
      expect(resolved.reason).toBe("none");
    } finally {
      await page.close();
    }
  });

  it("refuses to click a disabled control (no false-success no-op)", async () => {
    const { ctrl, page } = await pageFor(DISABLED_FIXTURE);
    try {
      const resolved = await ctrl.resolvePageTarget("text", "Add To Cart");
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) throw new Error("unreachable");
      await expect(ctrl.clickHandle(resolved.handle)).rejects.toThrow(/disabled/);
      await expect(ctrl.jsClickHandle(resolved.handle)).rejects.toThrow(/disabled/);
      await resolved.handle.dispose();
      expect(await cart(page)).toBe(0);
    } finally {
      await page.close();
    }
  });

  it("refuses js_click when an ancestor is aria-disabled", async () => {
    const { ctrl, page } = await pageFor(ARIA_DISABLED_FIXTURE);
    try {
      const resolved = await ctrl.resolvePageTarget("text", "Add To Cart");
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) throw new Error("unreachable");
      await expect(ctrl.jsClickHandle(resolved.handle)).rejects.toThrow(/disabled/);
      await resolved.handle.dispose();
      expect(await cart(page)).toBe(0);
    } finally {
      await page.close();
    }
  });

  it("refuses detached locator handles", async () => {
    const { ctrl, page } = await pageFor(DETACHED_FIXTURE);
    try {
      const resolved = await ctrl.resolvePageTarget("text", "Add To Cart");
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) throw new Error("unreachable");
      await page.evaluate(() => document.querySelector("#buy")?.remove());
      await expect(ctrl.clickHandle(resolved.handle)).rejects.toThrow(/detached/);
      await expect(ctrl.jsClickHandle(resolved.handle)).rejects.toThrow(/detached/);
      await resolved.handle.dispose();
    } finally {
      await page.close();
    }
  });

  it(
    "click rejects an overlay while explicit js_click dispatches once",
    async () => {
      const { ctrl, page } = await pageFor(OVERLAY_FIXTURE);
      try {
        const resolved = await ctrl.resolvePageTarget("text", "Add To Cart");
        expect(resolved.ok).toBe(true);
        if (!resolved.ok) throw new Error("unreachable");
        await expect(ctrl.clickHandle(resolved.handle)).rejects.toThrow();
        expect(await cart(page)).toBe(0);
        await ctrl.jsClickHandle(resolved.handle);
        await resolved.handle.dispose();
        expect(await cart(page)).toBe(1);
      } finally {
        await page.close();
      }
    },
    12_000,
  );

  it("keeps two genuine nested controls ambiguous (no silent inner-pick)", async () => {
    const { ctrl, page } = await pageFor(NESTED_STRONG_FIXTURE);
    try {
      const resolved = await ctrl.resolvePageTarget("text", "Delete");
      expect(resolved.ok).toBe(false);
      if (resolved.ok) throw new Error("unreachable");
      expect(resolved.reason).toBe("ambiguous");
    } finally {
      await page.close();
    }
  });

  it("does not crash on a broad css selector — returns ambiguous", async () => {
    const { ctrl, page } = await pageFor(AMBIGUOUS_FIXTURE);
    try {
      const resolved = await ctrl.resolvePageTarget("css", "div");
      expect(resolved.ok).toBe(false);
      if (resolved.ok) throw new Error("unreachable");
      expect(resolved.reason).toBe("ambiguous");
    } finally {
      await page.close();
    }
  });

  it("keeps two nested WEAK click-divs ambiguous (no bubble double-dispatch)", async () => {
    const { ctrl, page } = await pageFor(NESTED_WEAK_FIXTURE);
    try {
      const resolved = await ctrl.resolvePageTarget("text", "Add To Cart");
      // Both bare divs carry their own listener; picking the inner would bubble
      // into the outer and fire both. Must refuse instead.
      expect(resolved.ok).toBe(false);
      if (resolved.ok) throw new Error("unreachable");
      expect(resolved.reason).toBe("ambiguous");
      expect(await page.evaluate(() => (window as unknown as { __outer: number }).__outer)).toBe(0);
      expect(await page.evaluate(() => (window as unknown as { __inner: number }).__inner)).toBe(0);
    } finally {
      await page.close();
    }
  });

  it("keeps a weak handler ancestor wrapping a strong control ambiguous", async () => {
    const { ctrl, page } = await pageFor(WEAK_ANCESTOR_STRONG_CHILD_FIXTURE);
    try {
      const resolved = await ctrl.resolvePageTarget("text", "Add To Cart");
      expect(resolved.ok).toBe(false);
      if (resolved.ok) throw new Error("unreachable");
      expect(resolved.reason).toBe("ambiguous");
      expect(await page.evaluate(() => (window as unknown as { __outer: number }).__outer)).toBe(0);
      expect(await page.evaluate(() => (window as unknown as { __inner: number }).__inner)).toBe(0);
    } finally {
      await page.close();
    }
  });

  it("short-circuits a huge candidate pool to ambiguous (no O(n^2) stall)", async () => {
    const { ctrl, page } = await pageFor(MANY_DIVS_FIXTURE);
    try {
      const resolved = await ctrl.resolvePageTarget("css", "div");
      expect(resolved.ok).toBe(false);
      if (resolved.ok) throw new Error("unreachable");
      expect(resolved.reason).toBe("ambiguous");
    } finally {
      await page.close();
    }
  });
});
