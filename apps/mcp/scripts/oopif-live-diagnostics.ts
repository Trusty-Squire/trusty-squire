/**
 * MANUAL LIVE DIAGNOSTICS — throwaway, not a test. Never places an order.
 *
 * Reproduces the whitejade.xyz Shopify checkout OOPIF observation drop against
 * the real page with plain Playwright Chromium (no operator, no vault, no
 * card). It opens the product, adds to cart, walks to /checkout, waits for the
 * checkout.pci.shopifyinc.com card-field frames, then prints:
 *
 *   1. page.frames() URLs
 *   2. Target.getTargets iframe targets (targetId + url)
 *   3. Page.getFrameTree from the page session
 *   4. every IFRAME node the DOM walk sees (parent chain, shadow-root depth,
 *      CDP frameId, contentDocument presence)
 *   5. the outOfProcessFramesByCdpId match result per frame (URL match, child
 *      frame-tree root id, DOM frameId equality)
 *   6. the real captureBrowserUseDOM result: interactive elements and
 *      capture omissions
 *
 * Run:  cd apps/mcp && node_modules/.bin/tsx scripts/oopif-live-diagnostics.ts
 */
/* eslint-disable no-console -- manual diagnostics printer */
import { chromium } from "playwright";
import type { CDPSession, Frame, Page } from "playwright";
import type { BrowserUseNode } from "../src/bot/browser-use-serializer.js";
import { captureBrowserUseDOM } from "../src/bot/browser-use-capture.js";

const STORE = "https://whitejade.xyz";
const FRAME_HOST = "checkout.pci.shopifyinc.com";

interface RawNode {
  nodeId: number;
  nodeName?: string;
  attributes?: string[];
  children?: RawNode[];
  shadowRoots?: RawNode[];
  contentDocument?: RawNode;
  frameId?: string;
}

function attrs(a: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; a && i + 1 < a.length; i += 2) out[a[i]!] = a[i + 1]!;
  return out;
}

/** Collect every IFRAME element node plus the shadow-root nesting depth. */
function findIframes(
  node: RawNode,
  shadowDepth = 0,
  insideShadow = false,
  found: Array<{ node: RawNode; insideShadow: boolean; shadowDepth: number }> = [],
): Array<{ node: RawNode; insideShadow: boolean; shadowDepth: number }> {
  if (node.nodeName === "IFRAME")
    found.push({ node, insideShadow, shadowDepth });
  for (const child of node.children ?? []) findIframes(child, shadowDepth, insideShadow, found);
  for (const shadow of node.shadowRoots ?? [])
    for (const child of shadow.children ?? [])
      findIframes(child, shadowDepth + 1, true, found);
  return found;
}

async function dump(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  try {
    console.log("=== 1. page.frames() ===");
    for (const f of page.frames())
      console.log(`  name=${JSON.stringify(f.name())} detached=${f.isDetached()} url=${f.url()}`);

    console.log("=== 2. Target.getTargets (iframe-type targets) ===");
    const targets = await cdp.send("Target.getTargets");
    for (const t of targets.targetInfos)
      if (t.type === "iframe")
        console.log(`  targetId=${t.targetId} url=${JSON.stringify(t.url)}`);

    console.log("=== 3. Page.getFrameTree (page session) ===");
    const tree = await cdp.send("Page.getFrameTree");
    const printTree = (t: typeof tree.frameTree, indent: string): void => {
      console.log(`${indent}frame id=${t.frame.id} url=${JSON.stringify(t.frame.url)}`);
      for (const c of t.childFrames ?? []) printTree(c, `${indent}  `);
    };
    printTree(tree.frameTree, "  ");

    console.log("=== 4. DOM.getDocument IFRAME nodes (page session, pierce) ===");
    const dom = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
    for (const found of findIframes(dom.root as unknown as RawNode)) {
      const a = attrs(found.node.attributes);
      console.log(
        `  iframe name=${JSON.stringify(a.name ?? "")} frameId=${a.frameId ?? found.node.frameId ?? "UNDEFINED"} ` +
          `insideShadowRoot=${found.insideShadow} shadowDepth=${found.shadowDepth} src=${a.src ?? ""} ` +
          `contentDocument=${found.node.contentDocument ? "present" : "absent"}`,
      );
    }

    console.log("=== 5. outOfProcessFramesByCdpId match probe ===");
    const oopifUrls = new Set(
      targets.targetInfos
        .filter((t) => t.type === "iframe" && t.url !== "")
        .map((t) => t.url),
    );
    const rootId = tree.frameTree.frame.id;
    for (const frame of page.frames()) {
      if (frame === page.mainFrame() || frame.isDetached()) continue;
      const urlMatch = oopifUrls.has(frame.url());
      let childRoot: string | null = null;
      let sessionError: string | null = null;
      let session: CDPSession | null = null;
      try {
        session = await page.context().newCDPSession(frame);
        const childTree = await session.send("Page.getFrameTree");
        childRoot = childTree.frameTree.frame.id;
      } catch (e) {
        sessionError = String(e);
      } finally {
        await session?.detach().catch(() => undefined);
      }
      const matched =
        childRoot !== null && childRoot !== rootId
          ? "BOUND (map key = child root id)"
          : childRoot === rootId
            ? "REJECTED: child root == page root"
            : "UNBOUND: child frame-tree failed";
      console.log(
        `  frame url=${JSON.stringify(frame.url())}\n    targetUrlExactMatch=${urlMatch} childRootId=${childRoot} ${matched}${sessionError ? ` err=${sessionError}` : ""}`,
      );
    }
    // Cross-check: do target URLs match frame URLs at all?
    const frameUrls = new Set(
      page.frames().filter((f) => f !== page.mainFrame()).map((f) => f.url()),
    );
    for (const u of oopifUrls)
      if (!frameUrls.has(u))
        console.log(`  URL MISMATCH: target url has no page.frames() equal:\n    target: ${JSON.stringify(u)}`);

    console.log("=== 6. captureBrowserUseDOM ===");
    const framePath = (frame: Frame): string => {
      const indexes: number[] = [];
      let current: Frame | null = frame;
      while (current !== null) {
        const parent = current.parentFrame();
        if (parent === null) break;
        const index = parent.childFrames().indexOf(current);
        if (index < 0) return "";
        indexes.unshift(index);
        current = parent;
      }
      return indexes.join("/");
    };
    const capture = await captureBrowserUseDOM(page, [], framePath);
    console.log(`  elements=${capture.elements.length}`);
    for (const el of capture.elements)
      console.log(
        `    [${el.index}] ${el.tag} role=${el.role ?? ""} name=${JSON.stringify(el.name ?? el.ariaLabel ?? "")} frameUrl=${el.frameUrl ?? "-"}`,
      );
    console.log(`  omissions=${capture.omissions.length}`);
    for (const o of capture.omissions)
      console.log(`    kind=${o.kind} framePath=${o.framePath ?? "-"} url=${o.url}`);
    console.log("=== 7. capture-tree IFRAME nodes (attachFrames gate values) ===");
    const walkTree = (n: BrowserUseNode, depth = 0): void => {
      if (["IFRAME", "FRAME"].includes(n.nodeName))
        console.log(
          `  ${"  ".repeat(depth)}iframe name=${JSON.stringify(n.attributes.name ?? "")} ` +
            `visible=${n.visible} rendered=${String((n as unknown as { rendered?: boolean }).rendered)} ` +
            `bounds=${n.bounds ? `${n.bounds.width}x${n.bounds.height}@${n.bounds.x},${n.bounds.y}` : "null"} ` +
            `snapshot=${n.snapshot} contentDocument=${n.contentDocument ? "present" : "absent"} src=${(n.attributes.src ?? "").slice(0, 80)}`,
        );
      for (const c of n.children) walkTree(c, depth + 1);
      if (n.contentDocument) walkTree(n.contentDocument, depth + 1);
    };
    walkTree(capture.root);
    if (capture.elements.length === 0 && capture.omissions.length === 0)
      console.log("  >>> SILENT DROP REPRODUCED: no elements, no omissions");
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const browser = await chromium.launch({
    headless: true,
    // Production Chrome site-isolates cross-site frames by default; Playwright's
    // Chromium build does not. Force the real shape.
    args: ["--site-per-process"],
  });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const productUrl = `${STORE}/products/collagen-glow-sheet-mask`;
    console.log(`# navigating to ${productUrl}`);
    await page.goto(productUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

    // Add to cart.
    const add = page
      .locator('button[name="add"], form[action*="/cart/add"] button[type="submit"]')
      .first();
    await add.waitFor({ state: "visible", timeout: 30000 });
    await add.click();
    console.log("# added to cart");
    await page.waitForTimeout(2000);

    // Straight to checkout.
    await page.goto(`${STORE}/checkout`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => undefined);
    console.log(`# on checkout: ${page.url()}`);

    // Fill contact + shipping so the payment section renders its card frames.
    const email = page.locator('input[name="email"], input[type="email"]').first();
    if (await email.isVisible().catch(() => false)) {
      await email.fill("diag@example.com");
      console.log("# filled email");
    }
    for (const [sel, value] of [
      ['input[name="firstName"]', "Diag"],
      ['input[name="lastName"]', "Agent"],
      ['input[name="address1"]', "1 Test Street"],
      ['input[name="city"]', "Testville"],
      ['input[name="postalCode"]', "10000"],
      ['input[name="phone"]', "5551234567"],
    ] as const) {
      const field = page.locator(sel).first();
      if (await field.isVisible().catch(() => false)) {
        await field.fill(value).catch(() => undefined);
      }
    }
    // Country/zone selects if present.
    for (const sel of ['select[name="countryCode"]', 'select[name="provinceCode"]']) {
      const field = page.locator(sel).first();
      if (await field.isVisible().catch(() => false)) {
        const options = await field.locator("option").all();
        if (options.length > 1) await field.selectOption({ index: 1 }).catch(() => undefined);
      }
    }
    console.log("# filled delivery form (best effort)");
    await page.waitForTimeout(2000);

    // Wait for the hosted card frames.
    try {
      await page
        .waitForSelector(`iframe[src*="${FRAME_HOST}"]`, { timeout: 45000 })
        .then(() => console.log("# card iframe element present"));
    } catch {
      console.log("# no iframe[src*=checkout.pci...] appeared within 45s");
    }
    for (let i = 0; i < 30; i++) {
      if (page.frames().some((f) => f.url().includes(FRAME_HOST))) break;
      await page.waitForTimeout(1000);
    }
    await dump(page);
    await page.screenshot({ path: "scripts/oopif-live-diagnostics.png", fullPage: true }).catch(() => undefined);
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exitCode = 1;
});
