import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import { BrowserController } from "../browser.js";
import { serializeBrowserUseDOM } from "../browser-use-serializer.js";
import {
  buildSafeControlsV2,
  encodeV2QueryPage,
  safeBlockersV2,
} from "../compact-observation-v2.js";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser?.close();
});
async function observe(page: Page) {
  const controller = new BrowserController({ humanize: false });
  const capture = await controller.extractBrowserUseObservation(page);
  const handles = new Map(capture.elements.map((e) => [e, `@e:${e.index}`]));
  const rows = buildSafeControlsV2({
    elements: capture.elements,
    handles,
    legacyRefs: handles,
    pageOrigin: "null",
    canonical: true,
  }).rows;
  const full = serializeBrowserUseDOM(capture.root, {
    ref: (n) => handles.get(capture.nodeElements.get(n.id)!) ?? "unbound",
  }).dom;
  const wire = encodeV2QueryPage({
    sessionId: "fixture",
    stage: "browse",
    pageUrl: "about:blank",
    semantics: {},
    rows,
    cursorFor: () => "cursor",
  }).payload;
  return { capture, rows, full, wire, blockers: safeBlockersV2(capture.root) };
}

it("matches rendered visibility through hidden ancestors while preserving below-fold controls", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`<button id="google">Google</button><label>Email<input id="email"></label>
      <div id="password-panel" style="opacity:0"><label>Password<input type="password" id="password"></label><button id="show">Show password</button></div>
      <div style="height:0;overflow:hidden"><button id="collapsed">Collapsed action</button></div>
      <div style="height:1500px"></div><button id="below">Below fold action</button>`);
    // Browser-rendered oracle: opacity is not inherited by computed style.
    expect(
      await page.locator("#password").evaluate((e) => e.checkVisibility({ opacityProperty: true })),
    ).toBe(false);
    const hidden = await observe(page);
    expect(hidden.full).not.toContain("Show password");
    expect(hidden.rows.some((r) => r.label === "@show-password")).toBe(false);
    expect(hidden.rows.some((r) => r.label === "@collapsed-action")).toBe(false);
    expect(hidden.rows.find((r) => r.label === "@below-fold-action")?.visibility).toBe("near");
    expect(hidden.full).not.toContain("Below fold action");
    expect(JSON.stringify(hidden.wire)).toContain("@below-fold-action|v=offscreen");
    await page.locator("#password-panel").evaluate((e) => ((e as HTMLElement).style.opacity = "1"));
    const shown = await observe(page);
    expect(shown.full).toContain("Show password");
    expect(shown.rows.some((r) => r.label === "@show-password")).toBe(true);
    expect(shown.capture.elements.find((e) => e.id === "google")?.observationIdentity).toBe(
      hidden.capture.elements.find((e) => e.id === "google")?.observationIdentity,
    );
  } finally {
    await page.close();
  }
});

it("does not rename a listener div or slider to button, and preserves separate duplicate legal links", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`<div id="container">Sign in</div><div role="slider" tabindex="0" aria-label="Volume">Volume</div>
      <p>Read <a href="#terms">Terms</a></p><p>Read <a href="#terms">Terms</a></p>`);
    await page.locator("#container").evaluate((e) => e.addEventListener("click", () => {}));
    const result = await observe(page);
    expect(result.full).toContain("<div");
    expect(result.rows.find((r) => r.label === "@sign-in")?.role).toBe("generic");
    expect(result.rows.find((r) => r.label === "@volume")?.role).toBe("slider");
    expect(JSON.stringify(result.wire)).toContain('"slider"');
    const links = result.rows.filter((r) => r.role === "link");
    expect(links).toHaveLength(2);
    expect(new Set(links.map((r) => r.ref)).size).toBe(2);
    for (const link of links) expect(result.full).toContain(link.ref);
  } finally {
    await page.close();
  }
});

it("retains rendered verification instructions and distinguishes a late error from extraction loss", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`<h1>Sign in</h1><p>Performing security verification</p>
      <div id="turnstile"><label><input type="checkbox">Verify you are human</label></div>
      <div role="alert" id="error" hidden>The External Account was not found</div>`);
    const before = await observe(page);
    expect(before.full).toContain("Performing security verification");
    expect(before.blockers.some((b) => b.text.includes("Performing security verification"))).toBe(
      true,
    );
    expect(before.blockers.some((b) => b.text.includes("External Account"))).toBe(false);
    await page.locator("#error").evaluate((e) => e.removeAttribute("hidden"));
    await page.locator("#error").waitFor({ state: "visible" });
    const settled = await observe(page);
    expect(settled.full).toContain("The External Account was not found");
    expect(settled.blockers).toContainEqual({
      kind: "validation",
      text: "The External Account was not found",
    });
  } finally {
    await page.close();
  }
});

it("reports a settled account error independently of challenge presence", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(
      '<button>Google</button><div role="alert" hidden>The External Account was not found</div>',
    );
    const before = await observe(page);
    expect(before.blockers).toEqual([]);
    await page.locator('[role="alert"]').evaluate((e) => e.removeAttribute("hidden"));
    const after = await observe(page);
    expect(after.full).toContain("The External Account was not found");
    expect(after.blockers).toEqual([
      { kind: "validation", text: "The External Account was not found" },
    ]);
  } finally {
    await page.close();
  }
});

it("keeps scrollable offscreen controls reachable with the same identity after scrolling", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(
      '<div id="scroll" style="height:60px;overflow:auto"><div style="height:500px"></div><button id="next">Next step</button></div>',
    );
    const before = await observe(page);
    expect(before.full).not.toContain("Next step");
    expect(before.rows.find((r) => r.label === "@next-step")?.visibility).toBe("near");
    await page.locator("#next").scrollIntoViewIfNeeded();
    const after = await observe(page);
    expect(after.full).toContain("Next step");
    expect(after.rows.find((r) => r.label === "@next-step")?.visibility).toBe("viewport");
    expect(after.capture.elements.find((e) => e.id === "next")?.observationIdentity).toBe(
      before.capture.elements.find((e) => e.id === "next")?.observationIdentity,
    );
  } finally {
    await page.close();
  }
});

it.each([
  ["fixed", "", true],
  ["fixed", "transform:translateZ(0)", false],
  ["absolute", "", true],
  ["absolute", "position:relative", false],
])("respects %s containing blocks with wrapper %s", async (position, wrapper, rendered) => {
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <div style="width:100px;height:30px;overflow:hidden;${wrapper}">
        <div style="position:${position};top:100px;left:200px">
          <button id="signup" onclick="this.textContent='Signup clicked'">Signup action</button>
        </div>
      </div>`);
    const hit = await page.locator("#signup").evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return element.contains(
        document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2),
      );
    });
    expect(hit).toBe(rendered);
    const result = await observe(page);
    expect(result.rows.some((row) => row.label === "@signup-action")).toBe(rendered);
    expect(result.full.includes("Signup action")).toBe(rendered);
    if (rendered) {
      expect(result.rows.find((row) => row.label === "@signup-action")?.visibility).toBe(
        "viewport",
      );
      await page.locator("#signup").click({ timeout: 1000 });
      expect(await page.locator("#signup").innerText()).toBe("Signup clicked");
    }
  } finally {
    await page.close();
  }
});

it("keeps visible fixed-shell blockers without restoring hidden descendant evidence", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`<!doctype html>
      <style>body { margin:0 } #shell { position:fixed; inset:0 }</style>
      <main id="shell">
        <p>Performing security verification</p>
        <p role="alert">The External Account was not found</p>
        <div style="opacity:0"><p role="alert">Hidden opacity error</p><p>Performing security verification opacity</p></div>
        <div style="display:none"><p role="alert">Hidden display error</p></div>
        <div style="visibility:hidden"><p role="alert">Hidden visibility error</p></div>
        <div style="height:0;overflow:hidden"><p role="alert">Hidden clipped error</p></div>
        <iframe style="display:none" srcdoc='<p role="alert">Hidden frame error</p>'></iframe>
      </main>`);
    expect(
      await page.locator("body").evaluate((element) => element.getBoundingClientRect().height),
    ).toBe(0);
    const result = await observe(page);
    expect(result.blockers).toEqual([
      { kind: "challenge", text: "Performing security verification", target: "unavailable" },
      { kind: "validation", text: "The External Account was not found" },
    ]);
    await page
      .locator("#shell")
      .evaluate((element) => ((element as HTMLElement).style.opacity = "0"));
    expect((await observe(page)).blockers).toEqual([]);
  } finally {
    await page.close();
  }
});
