// Regression-eval harness for the measured context-minimization on the operator
// observe path (docs/DESIGN-observe-compact.md). The whole point of the change
// is a SMALLER host payload that is still LOSSLESS and never drops an actionable
// control — so this file asserts those invariants directly, each as a named test:
//
//   INV-lossless-resync       — base ⊕ deltas == ground truth at every step
//   INV-actionable-never-dropped — buttons/inputs/dismiss controls always survive
//   INV-clickable-unchanged   — an unchanged (not re-emitted) element still
//                               resolves by its stable ref through resolveTarget
//   INV-token-budget          — the delta path preserves the measured savings
//   INV-full-escape-hatch     — detail:"full" is byte-equivalent + un-deltified
//
// Fixtures are SYNTHETIC — realistic Casetify-style ~150-element pages with a
// nav, a footer, a cookie aside, and a sign-in dialog, built from the shapes in
// the design. NO real/captured credentials: every element's `value` is left
// null (the harness never sets a secret), per the no-real-creds rule.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type * as GoogleLoginModule from "../google-login.js";
import type { InteractiveElement } from "../browser.js";

// ── mocked substrate so we can drive the REAL observe()/startProvisionSession
//    against a synthetic page without a browser (mirrors operate-session-flow) ──
const h = vi.hoisted(() => ({
  providers: ["google"] as string[],
  oauthStatus: "already_valid" as string,
  currentUrl: "",
  mainDocumentEpoch: 0,
  elements: [] as unknown[],
  visibleText: "",
}));

vi.mock("../browser.js", () => ({
  BrowserController: class {
    constructor(_opts?: unknown) {}
    async start(): Promise<void> {}
    isConnected(): boolean {
      return true;
    }
    async goto(url: string): Promise<void> {
      h.currentUrl = url;
      h.mainDocumentEpoch += 1;
    }
    currentUrl(): string {
      return h.currentUrl;
    }
    mainDocumentIdentity(): string {
      return String(h.mainDocumentEpoch);
    }
    recoverActivePage(): void {}
    async extractInteractiveElements(): Promise<unknown[]> {
      return h.elements;
    }
    async extractVisibleText(): Promise<string> {
      return h.visibleText;
    }
    async waitForCaptchaChallengeToSettle(): Promise<boolean> {
      return true;
    }
    async dismissConsentBanner(): Promise<string | null> {
      return null;
    }
    async close(): Promise<void> {}
  },
}));

vi.mock("../google-login.js", async (importOriginal) => {
  const actual = await importOriginal<typeof GoogleLoginModule>();
  return {
    ...actual,
    detectActiveProviderSessions: async () => h.providers,
    ensureOAuthSession: async () => ({ status: h.oauthStatus }),
  };
});

import {
  buildCompactObservation,
  provisionElementRef,
  provisionElementRefs,
  stableElementId,
  resolveTarget,
  isActionableControl,
  isPlainChromeLink,
  startProvisionSession,
  observe,
  verifyPostcondition,
  closeAllProvisionSessions,
  parseElementsTable,
  type Observation,
  type ObserveDeltaState,
  type ObservedElement,
} from "../provision-session.js";

// The compact wire carries its element set as the columnar `el_table` (Phase 4).
// Decode it back to elements — the host does the same. Absent table = no elements.
function rows(obs: Observation): ObservedElement[] {
  return obs.el_table !== undefined ? parseElementsTable(obs.el_table) : [];
}

function el(partial: Partial<InteractiveElement>): InteractiveElement {
  return {
    index: 0,
    tag: "button",
    type: null,
    id: null,
    name: null,
    placeholder: null,
    ariaLabel: null,
    role: null,
    labelText: null,
    visibleText: null,
    selector: "sel",
    visible: true,
    inViewport: true,
    inConsentWidget: false,
    value: null,
    ...partial,
  };
}

// ── a realistic ~150-element Casetify-style page ──
//
// Regions: banner (logo + nav links + search input + cart), a cookie CONSENT
// ASIDE (with a "Close banner" button — a dismiss control that must survive), a
// FOOTER nav (with a "Manage cookies" button dismiss control + plain links), a
// sign-in DIALOG (with a "Dismiss sign-in" button dismiss control), and a main
// product grid (link + "Add to cart" button per product). Plain chrome links get
// collapsed; every button/input is kept.
interface PageOpts {
  cookieAside?: boolean; // the consent aside is present
  sortLabel?: string; // the "Sort" control's current label
  toast?: boolean; // an "Added to cart" toast dialog appeared
  products?: number;
}

function casetifyPage(opts: PageOpts = {}): InteractiveElement[] {
  const cookieAside = opts.cookieAside ?? true;
  const sortLabel = opts.sortLabel ?? "Sort: Featured";
  const products = opts.products ?? 40;
  const out: InteractiveElement[] = [];

  // banner
  out.push(
    el({
      tag: "a",
      role: "link",
      visibleText: "Casetify",
      href: "/",
      screenPath: "banner:top > link:home",
      container: "banner:top",
    }),
  );
  for (const nav of ["Shop", "Tech", "Collabs", "About", "Support"]) {
    out.push(
      el({
        tag: "a",
        role: "link",
        visibleText: nav,
        href: `/${nav.toLowerCase()}`,
        screenPath: `navigation:main > link:${nav.toLowerCase()}`,
        container: "navigation:main",
      }),
    );
  }
  out.push(
    el({
      tag: "input",
      type: "search",
      placeholder: "Search products",
      screenPath: "banner:top > input:search",
      container: "banner:top",
      selector: "#search",
    }),
  );
  out.push(
    el({
      tag: "button",
      role: "button",
      visibleText: "Cart",
      screenPath: "banner:top > button:cart",
      container: "banner:top",
      selector: "#cart",
    }),
  );

  // filters — a mix of buttons and a sort control whose label changes
  out.push(
    el({
      tag: "button",
      role: "button",
      visibleText: sortLabel,
      screenPath: "main:catalog > button:sort",
      container: "main:catalog",
      selector: "#sort",
    }),
  );
  for (const f of ["Phone", "Laptop", "Watch", "Audio"]) {
    out.push(
      el({
        tag: "button",
        role: "button",
        visibleText: f,
        screenPath: `main:catalog > button:filter-${f.toLowerCase()}`,
        container: "main:catalog",
        selector: `#f-${f}`,
      }),
    );
  }

  // product grid — link + Add-to-cart button per product
  for (let i = 0; i < products; i++) {
    out.push(
      el({
        tag: "a",
        role: "link",
        visibleText: `Product ${i}`,
        href: `/p/${i}`,
        screenPath: `main:catalog > article:product-${i} > link:title`,
        container: `article:product-${i}`,
      }),
    );
    out.push(
      el({
        tag: "button",
        role: "button",
        visibleText: "Add to cart",
        screenPath: `main:catalog > article:product-${i} > button:add`,
        container: `article:product-${i}`,
        selector: `#add-${i}`,
      }),
    );
  }

  // cookie consent aside — a dismiss control ("Close banner") + accept/reject +
  // two plain chrome links. The aside vanishes once dismissed.
  if (cookieAside) {
    out.push(
      el({
        tag: "button",
        role: "button",
        visibleText: "Close banner",
        screenPath: "aside:cookie-consent > button:close",
        container: "aside:cookie-consent",
        selector: "#cookie-close",
      }),
    );
    out.push(
      el({
        tag: "button",
        role: "button",
        visibleText: "Accept all",
        screenPath: "aside:cookie-consent > button:accept",
        container: "aside:cookie-consent",
        selector: "#cookie-accept",
      }),
    );
    out.push(
      el({
        tag: "button",
        role: "button",
        visibleText: "Reject all",
        screenPath: "aside:cookie-consent > button:reject",
        container: "aside:cookie-consent",
        selector: "#cookie-reject",
      }),
    );
    out.push(
      el({
        tag: "a",
        role: "link",
        visibleText: "Cookie policy",
        href: "/cookies",
        screenPath: "aside:cookie-consent > link:policy",
        container: "aside:cookie-consent",
      }),
    );
    out.push(
      el({
        tag: "a",
        role: "link",
        visibleText: "Privacy",
        href: "/privacy",
        screenPath: "aside:cookie-consent > link:privacy",
        container: "aside:cookie-consent",
      }),
    );
  }

  // sign-in promo dialog — a dismiss control inside a dialog
  out.push(
    el({
      tag: "button",
      role: "button",
      visibleText: "Dismiss sign-in",
      screenPath: "dialog:signin-promo > button:dismiss",
      container: "dialog:signin-promo",
      selector: "#signin-dismiss",
    }),
  );
  out.push(
    el({
      tag: "button",
      role: "button",
      visibleText: "Sign in",
      screenPath: "dialog:signin-promo > button:signin",
      container: "dialog:signin-promo",
      selector: "#signin",
    }),
  );
  out.push(
    el({
      tag: "input",
      type: "email",
      placeholder: "Email",
      screenPath: "dialog:signin-promo > input:email",
      container: "dialog:signin-promo",
      selector: "#signin-email",
    }),
  );

  // footer — a "Manage cookies" dismiss control inside navigation:footer, plus
  // MANY plain chrome links across footer landmarks (the collapse target).
  out.push(
    el({
      tag: "button",
      role: "button",
      visibleText: "Manage cookies",
      screenPath: "navigation:footer > button:manage-cookies",
      container: "navigation:footer",
      selector: "#manage-cookies",
    }),
  );
  for (const link of [
    "Careers",
    "Press",
    "Sustainability",
    "Wholesale",
    "Affiliates",
    "Returns",
    "Shipping",
    "Warranty",
    "Contact",
    "FAQ",
  ]) {
    out.push(
      el({
        tag: "a",
        role: "link",
        visibleText: link,
        href: `/${link.toLowerCase()}`,
        screenPath: `navigation:footer > link:${link.toLowerCase()}`,
        container: "navigation:footer",
      }),
    );
  }
  for (const social of ["Instagram", "TikTok", "YouTube", "X", "Facebook"]) {
    out.push(
      el({
        tag: "a",
        role: "link",
        visibleText: social,
        href: `/${social.toLowerCase()}`,
        screenPath: `section:social-links > link:${social.toLowerCase()}`,
        container: "section:social-links",
      }),
    );
  }
  out.push(
    el({
      tag: "a",
      role: "link",
      visibleText: "Terms",
      href: "/terms",
      screenPath: "section:copyright > link:terms",
      container: "section:copyright",
    }),
  );
  out.push(
    el({
      tag: "a",
      role: "link",
      visibleText: "© 2026 Casetify",
      href: "/legal",
      screenPath: "section:copyright > link:legal",
      container: "section:copyright",
    }),
  );
  // newsletter block: a plain link (collapsed) + a real input + button (kept)
  out.push(
    el({
      tag: "a",
      role: "link",
      visibleText: "Unsubscribe",
      href: "/news",
      screenPath: "section:newsletter > link:unsub",
      container: "section:newsletter",
    }),
  );
  out.push(
    el({
      tag: "input",
      type: "email",
      placeholder: "Newsletter email",
      screenPath: "section:newsletter > input:email",
      container: "section:newsletter",
      selector: "#news-email",
    }),
  );
  out.push(
    el({
      tag: "button",
      role: "button",
      visibleText: "Subscribe",
      screenPath: "section:newsletter > button:subscribe",
      container: "section:newsletter",
      selector: "#news-sub",
    }),
  );

  return out;
}

// The 6-observe sequence (all one URL, so obs2..obs6 are deltas).
function sequence(): InteractiveElement[][] {
  const seq0 = casetifyPage(); // full page, cookie aside present
  const seq1 = casetifyPage({ cookieAside: false }); // banner dismissed (removals)
  const seq2 = casetifyPage({ cookieAside: false, sortLabel: "Sort: Price ↑" }); // 1 changed
  const seq3 = casetifyPage({ cookieAside: false, sortLabel: "Sort: Price ↑" }); // identical (repeat)
  const seq4 = casetifyPage({ cookieAside: false, sortLabel: "Sort: Price ↑" }); // identical (repeat)
  const seq5 = casetifyPage({ cookieAside: false, sortLabel: "Sort: Price ↑", toast: false });
  // obs6: a toast dialog appears (additions)
  seq5.push(
    el({
      tag: "button",
      role: "button",
      visibleText: "View cart",
      screenPath: "dialog:toast > button:view",
      container: "dialog:toast",
      selector: "#toast-view",
    }),
  );
  seq5.push(
    el({
      tag: "button",
      role: "button",
      visibleText: "Dismiss toast",
      screenPath: "dialog:toast > button:dismiss",
      container: "dialog:toast",
      selector: "#toast-dismiss",
    }),
  );
  return [seq0, seq1, seq2, seq3, seq4, seq5];
}

const URL = "https://www.casetify.com/collections/tech";

// Drive the pure delta core across the sequence, threading state. Optional
// per-step `texts` exercise the page-text delta (default: empty text).
function driveCore(
  seq: InteractiveElement[][],
  texts?: string[],
): Array<ReturnType<typeof buildCompactObservation>> {
  let prev: ObserveDeltaState | null = null;
  const out: Array<ReturnType<typeof buildCompactObservation>> = [];
  seq.forEach((elements, i) => {
    const built = buildCompactObservation({
      sessionId: "s",
      url: URL,
      text: texts?.[i] ?? "",
      elements,
      prev,
    });
    out.push(built);
    prev = built.nextState;
  });
  return out;
}

function refBodies(m: Map<string, ObservedElement>): string {
  return JSON.stringify([...m.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

describe("observe-delta harness", () => {
  it("INV-lossless-resync: base ⊕ deltas == ground truth at every step", () => {
    const seq = sequence();
    const builds = driveCore(seq);

    // Sanity: obs1 is a full snapshot, obs2..obs6 are deltas (same URL, low churn).
    expect(builds[0]!.observation.delta).toBe(false);
    for (let i = 1; i < builds.length; i++) {
      expect(builds[i]!.observation.delta, `obs${i + 1} should be a delta`).toBe(true);
    }

    // The reconstruction base is NOT a fiction: the persisted snapshot
    // (fileElements) covers EXACTLY the complete set (fullByRef), and obs1's
    // emitted wire payload is that set minus the collapsed chrome links — which
    // are recoverable from the persisted file. So "base = complete persisted set"
    // is proven, not assumed.
    const obs1 = builds[0]!.observation;
    const fileRefs = new Set(builds[0]!.fileElements.map((e) => e.ref));
    expect(fileRefs).toEqual(new Set(builds[0]!.fullByRef.keys()));
    const emittedRefs0 = new Set(rows(obs1).map((e) => e.ref));
    const missingFromWire = [...fileRefs].filter((r) => !emittedRefs0.has(r));
    expect(missingFromWire.length).toBe(obs1.chrome_links_collapsed);
    // Every ref the wire dropped is retrievable from the persisted snapshot.
    for (const r of missingFromWire) expect(fileRefs.has(r)).toBe(true);

    // Reconstruct the host's running view: base = the COMPLETE snapshot the host
    // holds after obs1 (the persisted file == fullByRef), then apply each emitted
    // delta's changed upserts + removed deletes. It must equal ground truth.
    const recon = new Map(builds[0]!.fullByRef);
    for (let i = 1; i < builds.length; i++) {
      const obs = builds[i]!.observation;
      for (const e of rows(obs)) recon.set(e.ref, e);
      for (const ref of obs.removed ?? []) recon.delete(ref);
      expect(refBodies(recon), `resync mismatch at obs${i + 1}`).toBe(
        refBodies(builds[i]!.fullByRef),
      );
    }
  });

  it("INV-actionable-never-dropped: dismiss/consent/gate controls always survive a full observe", () => {
    const builds = driveCore(sequence());
    const obs1 = builds[0]!.observation; // the FULL emit (only place collapse runs)
    const emittedLabels = new Set(rows(obs1).map((e) => e.label));

    // The three real failing cases from the analysis — a dismiss control in an
    // aside, in navigation:footer, and in a dialog — must all be emitted.
    expect(emittedLabels.has("Close banner")).toBe(true); // aside
    expect(emittedLabels.has("Manage cookies")).toBe(true); // navigation:footer
    expect(emittedLabels.has("Dismiss sign-in")).toBe(true); // dialog

    // Generically: EVERY actionable control in the ground truth is emitted (never
    // collapsed), even though plain chrome links WERE collapsed.
    const emittedRefs = new Set(rows(obs1).map((e) => e.ref));
    const source = sequence()[0]!;
    const sourceRefs = provisionElementRefs(source);
    let actionableCount = 0;
    let collapsedLinks = 0;
    for (const src of source) {
      if (isActionableControl(src)) {
        actionableCount += 1;
        const ref = sourceRefs.get(src);
        expect(ref && emittedRefs.has(ref), `actionable "${src.visibleText}" dropped`).toBe(true);
      }
      if (isPlainChromeLink(src)) collapsedLinks += 1;
    }
    expect(actionableCount).toBeGreaterThan(40); // the grid's Add-to-cart buttons etc.
    // Collapse actually fired (this is a chrome-heavy page) but only on links.
    expect(obs1.chrome_links_collapsed).toBe(collapsedLinks);
    expect(collapsedLinks).toBeGreaterThan(0);
  });

  it("INV-actionable-never-dropped: a dismiss control shipped as a bare <a> (no nav href) is NOT collapsed", () => {
    // Codex-review hardening: the collapse must key on "is this a NAV link" (real
    // href), not just tag===a. A "Manage cookies"/"Close" action-link has no href
    // (or href="#") and must survive even in a chrome region.
    const page: InteractiveElement[] = [
      el({
        tag: "a",
        role: "link",
        visibleText: "Manage cookies",
        href: null,
        screenPath: "navigation:footer > link:manage",
        container: "navigation:footer",
      }),
      el({
        tag: "a",
        role: "link",
        visibleText: "Close banner",
        href: "#",
        screenPath: "aside:cookie > link:close",
        container: "aside:cookie",
      }),
      el({
        tag: "a",
        role: "link",
        visibleText: "Close banner",
        href: "#close", // a #-FRAGMENT action link (not exactly "#")
        screenPath: "aside:cookie > link:close-frag",
        container: "aside:cookie",
        selector: "#close-frag",
      }),
      el({
        tag: "a",
        role: "link",
        visibleText: "Accept cookies", // consent control WITH a real fallback URL
        href: "/cookie-settings",
        inConsentWidget: true,
        screenPath: "aside:cookie > link:accept",
        container: "aside:cookie",
        selector: "#accept-cookies",
      }),
      el({
        tag: "a",
        role: "link",
        visibleText: "Decline", // consent verb with a real URL, NOT in a widget
        href: "/consent/decline",
        screenPath: "navigation:footer > link:decline",
        container: "navigation:footer",
        selector: "#decline",
      }),
      el({
        tag: "a",
        role: "link",
        visibleText: "Careers",
        href: "/careers",
        screenPath: "navigation:footer > link:careers",
        container: "navigation:footer",
      }),
    ];
    expect(isPlainChromeLink(page[0]!)).toBe(false); // no href → kept
    expect(isPlainChromeLink(page[1]!)).toBe(false); // href="#" → kept
    expect(isPlainChromeLink(page[2]!)).toBe(false); // href="#close" fragment → kept
    expect(isPlainChromeLink(page[3]!)).toBe(false); // consent widget + real URL → kept
    expect(isPlainChromeLink(page[4]!)).toBe(false); // "Decline" consent verb → kept
    expect(isPlainChromeLink(page[5]!)).toBe(true); // real nav link → collapsible

    const built = buildCompactObservation({
      sessionId: "s",
      url: URL,
      text: "",
      elements: page,
      prev: null,
    });
    const labels = new Set(rows(built.observation).map((e) => e.label));
    expect(labels.has("Manage cookies")).toBe(true);
    expect(labels.has("Close banner")).toBe(true); // both bare and #close variants
    expect(labels.has("Accept cookies")).toBe(true); // consent anchor with a URL
    expect(labels.has("Careers")).toBe(false); // the only true nav link collapsed
    expect(built.observation.chrome_links_collapsed).toBe(1);
  });

  it("field elision preserves input action types and hrefs verbatim", () => {
    const built = buildCompactObservation({
      sessionId: "s",
      url: URL,
      text: "",
      elements: [
        el({
          tag: "input",
          type: "submit",
          visibleText: "Submit input",
          selector: "#submit-input",
        }),
        el({
          tag: "input",
          type: "button",
          visibleText: "Button input",
          selector: "#button-input",
        }),
        el({
          tag: "button",
          type: "submit",
          visibleText: "Submit button",
          selector: "#submit-button",
        }),
        el({
          tag: "input",
          role: "button",
          type: "submit",
          visibleText: "Role button",
          selector: "#role-button",
        }),
        el({
          tag: "input",
          type: "text",
          visibleText: "Text input",
          selector: "#text-input",
        }),
        el({
          tag: "a",
          role: "link",
          visibleText: "Settings",
          href: "  settings?tab=profile#name  ",
          selector: "#settings",
        }),
      ],
      prev: null,
      encode: "json",
      elide: true,
    });
    const byLabel = new Map(built.observation.elements!.map((entry) => [entry.label, entry]));

    expect(byLabel.get("Submit input")?.type).toBe("submit");
    expect(byLabel.get("Button input")?.type).toBe("button");
    expect(byLabel.get("Submit button")?.type).toBeUndefined();
    expect(byLabel.get("Role button")?.type).toBeUndefined();
    expect(byLabel.get("Text input")?.type).toBeUndefined();
    expect(byLabel.get("Settings")?.href).toBe("  settings?tab=profile#name  ");
  });

  it("same-hash duplicates: removing one is lossless and the vanished ordinal resolves to null (never a cross-group mis-click to a distinct element)", () => {
    // Two STRUCTURALLY IDENTICAL buttons (same stableElementId) → refs _1/_2.
    const twin = (): InteractiveElement =>
      el({
        tag: "button",
        role: "button",
        visibleText: "Remove",
        screenPath: "list:cart > button:remove",
        container: "list:cart",
      });
    const before = [twin(), twin()];
    const refsBefore = provisionElementRefs(before);
    const ref1 = refsBefore.get(before[0]!)!;
    const ref2 = refsBefore.get(before[1]!)!;
    expect(ref1).toMatch(/_1$/);
    expect(ref2).toMatch(/_2$/);

    // Observe once (full), then remove the FIRST twin and observe again (delta).
    const b1 = buildCompactObservation({
      sessionId: "s",
      url: URL,
      text: "",
      elements: before,
      prev: null,
    });
    const after = [twin()]; // one identical button remains
    const b2 = buildCompactObservation({
      sessionId: "s",
      url: URL,
      text: "",
      elements: after,
      prev: b1.nextState,
    });

    // Lossless: the delta reports one ref removed, one unchanged; reconstruction
    // from base ⊕ delta equals the true (single-element) set.
    expect(b2.observation.delta).toBe(true);
    expect(b2.observation.removed).toEqual([ref2]); // the surplus ordinal is gone
    const recon = new Map(b1.fullByRef);
    for (const e of rows(b2.observation)) recon.set(e.ref, e);
    for (const r of b2.observation.removed ?? []) recon.delete(r);
    expect(refBodies(recon)).toBe(refBodies(b2.fullByRef));

    // The vanished ordinal resolves to null (graceful), NOT a distinct element.
    expect(resolveTarget(after, ref2)).toBeNull();
    // The surviving ordinal resolves to a same-hash element (interchangeable).
    expect(resolveTarget(after, ref1)?.selector).toBe(after[0]!.selector);
  });

  it("distinct-selector siblings: removing the first NEVER retargets the survivor by its old ref", () => {
    // The realistic cart case: two "Remove" buttons, same label/path/role but
    // DIFFERENT selectors (folded into stableElementId). They get DISTINCT refs
    // (each ordinal _1), so removing the first cannot silently retarget the second.
    const remove = (selector: string): InteractiveElement =>
      el({
        tag: "button",
        role: "button",
        visibleText: "Remove",
        screenPath: "list:cart > button:remove",
        container: "list:cart",
        selector,
      });
    const before = [remove("#remove-0"), remove("#remove-1")];
    const refsBefore = provisionElementRefs(before);
    const refA = refsBefore.get(before[0]!) as string; // the one we will remove
    const refB = refsBefore.get(before[1]!) as string; // the survivor
    expect(refA).not.toBe(refB);

    const b1 = buildCompactObservation({
      sessionId: "s",
      url: URL,
      text: "",
      elements: before,
      prev: null,
    });
    const after = [remove("#remove-1")]; // #remove-0 gone; #remove-1 survives
    const b2 = buildCompactObservation({
      sessionId: "s",
      url: URL,
      text: "",
      elements: after,
      prev: b1.nextState,
    });

    // removed reporting is consistent: exactly the removed element's ref.
    expect(b2.observation.delta).toBe(true);
    expect(b2.observation.removed).toEqual([refA]);
    expect(b2.observation.unchanged).toBe(1); // the survivor was NOT re-emitted

    // The removed element's OLD ref resolves to NULL — it does NOT retarget the
    // survivor (which is a DISTINCT node), so the host re-observes instead of
    // mis-clicking. The survivor's own ref still resolves to the survivor.
    expect(resolveTarget(after, refA)).toBeNull();
    expect(resolveTarget(after, refB)?.selector).toBe("#remove-1");

    // Lossless reconstruction.
    const recon = new Map(b1.fullByRef);
    for (const e of rows(b2.observation)) recon.set(e.ref, e);
    for (const r of b2.observation.removed ?? []) recon.delete(r);
    expect(refBodies(recon)).toBe(refBodies(b2.fullByRef));
  });

  it("#399 positional-selector Remove-button group: removing a row invalidates every group ref so no stale ref retargets a survivor", () => {
    // A per-row "Remove" button list — same label/path/role, distinguished ONLY
    // by a positional selector. Six stable buttons dilute churn so this stays a
    // DELTA (so `removed` is emitted). The group's composition FINGERPRINT makes
    // its members "volatile": removing a row changes the fingerprint, so every
    // old group ref (departed AND survivors') is invalidated and can never
    // resolve to a survivor.
    const removeBtn = (position: number): InteractiveElement =>
      el({
        tag: "button",
        role: "button",
        visibleText: "Remove",
        screenPath: "list:cart > button:remove",
        container: "list:cart",
        selector: `ul>li:nth-of-type(${position})>button`,
      });
    const stable = [0, 1, 2, 3, 4, 5].map((i) =>
      el({
        tag: "button",
        role: "button",
        visibleText: `Item ${i}`,
        screenPath: `list:cart > article:item-${i} > button:open`,
        selector: `#open-${i}`,
      }),
    );
    const before = [removeBtn(1), removeBtn(2), removeBtn(3), ...stable];
    const refsBefore = provisionElementRefs(before);
    const removedNodeRef = refsBefore.get(before[0]!) as string; // row 1 — removed
    const survivor2OldRef = refsBefore.get(before[1]!) as string; // row 2
    const survivor3OldRef = refsBefore.get(before[2]!) as string; // row 3

    const b1 = buildCompactObservation({
      sessionId: "s",
      url: URL,
      text: "",
      elements: before,
      prev: null,
    });
    // Row 1 removed → rows 2 & 3 slide up onto nth-of-type(1) and (2).
    const after = [removeBtn(1), removeBtn(2), ...stable];
    const b2 = buildCompactObservation({
      sessionId: "s",
      url: URL,
      text: "",
      elements: after,
      prev: b1.nextState,
    });

    expect(b2.observation.delta).toBe(true);
    // `removed` names the departed row...
    expect(b2.observation.removed).toContain(removedNodeRef);
    // ...and EVERY ref the host is told to drop is genuinely dead — none of them
    // resolves to a surviving element (the crux of #399, incl. the two survivors'
    // now-invalid old refs).
    for (const ref of b2.observation.removed ?? []) {
      expect(resolveTarget(after, ref)).toBeNull();
    }
    expect(resolveTarget(after, removedNodeRef)).toBeNull();
    expect(resolveTarget(after, survivor2OldRef)).toBeNull();
    expect(resolveTarget(after, survivor3OldRef)).toBeNull();

    // The survivors are still reachable — by their CURRENT (re-minted) refs.
    const refsAfter = provisionElementRefs(after);
    expect(resolveTarget(after, refsAfter.get(after[0]!) as string)).toBe(after[0]);
    expect(resolveTarget(after, refsAfter.get(after[1]!) as string)).toBe(after[1]);

    // WITHIN-TURN (no re-observe): the host deletes row 1 then, still holding
    // observation-1 refs, tries to act on row 2 by its OLD ref against a fresh
    // extraction. `resolveTarget` is exactly the act path — it returns null
    // (fingerprint changed), forcing a re-observe rather than deleting row 3.
    expect(resolveTarget(after, survivor2OldRef)).toBeNull();

    // Lossless reconstruction (base ⊕ changed ⊖ removed == ground truth).
    const recon = new Map(b1.fullByRef);
    for (const e of rows(b2.observation)) recon.set(e.ref, e);
    for (const r of b2.observation.removed ?? []) recon.delete(r);
    expect(refBodies(recon)).toBe(refBodies(b2.fullByRef));
  });

  it("#399 positional-selector checkbox siblings (differing checked state): removing the first nulls its ref, never retargeting the survivor", () => {
    const checkbox = (position: number, checked: boolean): InteractiveElement =>
      el({
        tag: "input",
        type: "checkbox",
        role: "checkbox",
        visibleText: "Notify me",
        screenPath: "list:settings > checkbox:notify",
        container: "list:settings",
        selector: `ul>li:nth-of-type(${position})>input`,
        checked,
      });
    const keepers = [1, 2, 3].map((index) =>
      el({
        visibleText: `Keep ${index}`,
        screenPath: `main:settings > button:keep-${index}`,
        selector: `#keep-${index}`,
      }),
    );
    // Two same-label checkboxes with DIFFERENT checked state (the exact finding).
    const before = [checkbox(1, true), checkbox(2, false), ...keepers];
    const refsBefore = provisionElementRefs(before);
    const removedNodeRef = refsBefore.get(before[0]!) as string; // checked=true, removed
    const survivorOldRef = refsBefore.get(before[1]!) as string; // checked=false, survives
    expect(removedNodeRef).not.toBe(survivorOldRef);

    const b1 = buildCompactObservation({
      sessionId: "s",
      url: URL,
      text: "",
      elements: before,
      prev: null,
    });
    // First checkbox removed; the survivor (checked=false) slides onto nth(1).
    const after = [checkbox(1, false), ...keepers];
    const b2 = buildCompactObservation({
      sessionId: "s",
      url: URL,
      text: "",
      elements: after,
      prev: b1.nextState,
    });

    expect(b2.observation.delta).toBe(true);
    // `removed` names the departed node, and only dead refs.
    expect(b2.observation.removed).toContain(removedNodeRef);
    for (const ref of b2.observation.removed ?? []) {
      expect(resolveTarget(after, ref)).toBeNull();
    }
    // The removed node's old ref resolves to NULL — it does NOT retarget the
    // survivor, even though the survivor now occupies its DOM slot.
    expect(resolveTarget(after, removedNodeRef)).toBeNull();
    expect(resolveTarget(after, survivorOldRef)).toBeNull();
    // The survivor stays reachable by its own CURRENT ref, carrying its real
    // (checked=false) state — no cross-node confusion.
    const survivorCurrentRef = provisionElementRefs(after).get(after[0]!) as string;
    expect(survivorCurrentRef).not.toBe(removedNodeRef);
    expect(resolveTarget(after, survivorCurrentRef)).toBe(after[0]);
    expect(after[0]!.checked).toBe(false);

    // Lossless reconstruction.
    const recon = new Map(b1.fullByRef);
    for (const e of rows(b2.observation)) recon.set(e.ref, e);
    for (const r of b2.observation.removed ?? []) recon.delete(r);
    expect(refBodies(recon)).toBe(refBodies(b2.fullByRef));
  });

  it("#399 quoted attribute values are NOT misread as positional (stable selectors keep plain, unprefixed refs)", () => {
    // The selector VALUE merely contains ":nth-child(" — the selector itself is a
    // STABLE data attribute and must not be treated as a recycling positional
    // combinator, or it would wrongly get a fingerprint prefix (a byte regression).
    const mk = (key: string): InteractiveElement =>
      el({
        tag: "button",
        role: "button",
        visibleText: "Pick",
        screenPath: "list:opts > button:pick",
        container: "list:opts",
        selector: `[data-key="${key}"]`,
      });
    const els = [mk("a:nth-child(1)"), mk("b:nth-child(2)")];
    const refs = provisionElementRefs(els);
    // Plain stableElementId ref — no "<fp>-" fingerprint prefix.
    for (const e of els) expect(refs.get(e)).toBe(`@e:${stableElementId(e)}_1`);
    // Each resolves to itself by its own distinct stable identity.
    expect(resolveTarget(els, refs.get(els[0]!) as string)).toBe(els[0]);
    expect(resolveTarget(els, refs.get(els[1]!) as string)).toBe(els[1]);
  });

  it("#399 mixed-selector base groups fingerprint only their positional siblings", () => {
    const sibling = (selector: string): InteractiveElement =>
      el({
        tag: "button",
        role: "button",
        visibleText: "Remove",
        screenPath: "list:cart > button:remove",
        container: "list:cart",
        selector,
      });
    const stable = sibling("#keep");
    const removed = sibling("ul>li:nth-of-type(1)>button");
    const survivor = sibling("ul>li:nth-of-type(2)>button");
    const before = [stable, removed, survivor];
    const refsBefore = provisionElementRefs(before);
    const stableRef = refsBefore.get(stable) as string;
    const removedRef = refsBefore.get(removed) as string;
    const survivorRef = refsBefore.get(survivor) as string;

    expect(stableRef).toBe(`@e:${stableElementId(stable)}_1`);
    for (const positional of [removed, survivor]) {
      const ref = refsBefore.get(positional) as string;
      expect(ref).not.toBe(`@e:${stableElementId(positional)}_1`);
      expect(ref).toMatch(/^@e:[A-Za-z0-9_-]{12}-[A-Za-z0-9_-]{12}_1$/);
      expect(ref.endsWith(`-${stableElementId(positional)}_1`)).toBe(true);
    }

    const after = [stable, sibling("ul>li:nth-of-type(1)>button")];
    const refsAfter = provisionElementRefs(after);
    expect(refsAfter.get(stable)).toBe(stableRef);
    expect(resolveTarget(after, stableRef)).toBe(after[0]);
    expect(resolveTarget(after, removedRef)).toBeNull();
    expect(resolveTarget(after, survivorRef)).toBeNull();
  });

  it("INV-clickable-unchanged: an unchanged, not-re-emitted element still resolves by its stable ref", () => {
    const seq = sequence();
    const builds = driveCore(seq);

    // obs3 (index 2) is a delta vs obs2. A product's Add-to-cart button is
    // identical across seq[1] and seq[2], so it is NOT re-emitted in obs3.
    const obs3 = builds[2]!.observation;
    expect(obs3.delta).toBe(true);

    const target = seq[2]!.find(
      (e) =>
        e.visibleText === "Add to cart" &&
        e.screenPath === "main:catalog > article:product-7 > button:add",
    )!;
    const ref = provisionElementRefs(seq[2]!).get(target)!;

    // It was collapsed into the {unchanged: N} count, not re-sent.
    expect(rows(obs3).some((e) => e.ref === ref)).toBe(false);
    expect(obs3.unchanged).toBeGreaterThan(100);

    // But the host can still click it: resolve the STALE ref against the live
    // element list (what act() re-extracts) — routed through resolveTarget.
    const resolved = resolveTarget(seq[2]!, ref);
    expect(resolved?.selector).toBe("#add-7");

    // And a ref whose element is gone fails gracefully (null → host re-observes),
    // never a mis-click: the cookie "Close banner" is gone after obs1.
    const goneRef = provisionElementRef(
      sequence()[0]!.find((e) => e.visibleText === "Close banner")!,
    );
    expect(resolveTarget(seq[2]!, goneRef)).toBeNull();
  });

  it("INV-token-budget: the delta path meaningfully shrinks a repeated-observe run (delta not silently disabled)", () => {
    // NOTE: the ≥50%-aggregate guard against REAL data lives in the corpus test
    // below; docs/DESIGN-observe-compact.md owns the current measured aggregate.
    // The per-run tail legitimately dips under 20% (single-observe / high-churn
    // runs), so a per-run <30% assertion would false-fail. This synthetic case is
    // a multi-observe run with repetition, so it clears the floor with margin and
    // guards against a regression that silently turns delta OFF.
    const builds = driveCore(sequence());
    let baseline = 0;
    let deltaTotal = 0;
    for (const b of builds) {
      baseline += JSON.stringify(b.fileElements).length; // pre-change full-with-path payload
      deltaTotal += JSON.stringify(b.observation).length; // the emitted delta path
    }
    const saving = 1 - deltaTotal / baseline;
    // eslint-disable-next-line no-console
    console.log(
      `INV-token-budget (synthetic run): delta ${deltaTotal}B vs baseline ${baseline}B → ${(saving * 100).toFixed(1)}% saved`,
    );
    expect(saving).toBeGreaterThanOrEqual(0.5);
  });

  it("INV-text-delta-lossless: reconstructing page text from (base ⊕ text-deltas) equals ground truth; reports text saving", () => {
    // Realistic page-text blobs — obs2 & obs4 repeat the prior round's text
    // (corpus-measured: ~38% of re-observes have byte-identical text).
    const A = "Create your account. ".repeat(80);
    const B = "Verify your email address to continue. ".repeat(80);
    const C = "Your API key is ready. Copy it now — it won't be shown again. ".repeat(40);
    const texts = [A, A, B, B, B, C]; // ground truth per observe
    const builds = driveCore(sequence(), texts);

    // obs1 is a full snapshot → full text, no marker.
    expect(builds[0]!.observation.text).toBe(A);
    expect(builds[0]!.observation.text_unchanged).toBeUndefined();

    // Reconstruct text: base = obs1 text; on each delta, reuse prior when
    // text_unchanged, else adopt the emitted text. Must equal ground truth.
    let reconText = builds[0]!.observation.text;
    let textBaseline = 0;
    let textDelta = 0;
    builds.forEach((b, i) => {
      textBaseline += JSON.stringify(texts[i]).length; // pre-change: full text every observe
      const obs = b.observation;
      if (i > 0) {
        if (obs.text_unchanged === true) {
          expect(obs.text).toBe(""); // blob omitted when unchanged
        } else {
          reconText = obs.text;
        }
      }
      textDelta += JSON.stringify(obs.text).length;
      expect(reconText, `text resync mismatch at obs${i + 1}`).toBe(texts[i]);
    });

    // The repeats (obs2, obs4, obs5) were emitted as markers, not blobs.
    expect(builds[1]!.observation.text_unchanged).toBe(true);
    expect(builds[3]!.observation.text_unchanged).toBe(true);
    expect(builds[4]!.observation.text_unchanged).toBe(true);
    // obs3 & obs6 changed → full text re-emitted.
    expect(builds[2]!.observation.text_unchanged).toBeUndefined();
    expect(builds[5]!.observation.text_unchanged).toBeUndefined();

    const saving = 1 - textDelta / textBaseline;
    // eslint-disable-next-line no-console
    console.log(
      `INV-text-delta: text ${textDelta}B vs baseline ${textBaseline}B → ${(saving * 100).toFixed(1)}% saved`,
    );
    expect(saving).toBeGreaterThan(0);
  });
});

// ── corpus-driven token-budget over REAL multi-observe traces ──
//
// Runs only where the onboarding corpus exists (a dev box). Groups the per-round
// captures into runs, replays each run through the delta core, and asserts the
// TOKEN-WEIGHTED aggregate saving across the sample is ≥ 50%; the design doc
// owns the current measured aggregate. Per-run savings are PRINTED
// (p10/median/p90) but NOT asserted — the tail legitimately includes
// single-observe and high-churn runs near 0%.
// `value` is never committed and is replaced with a same-length placeholder here
// so the field-fill change-signal survives without carrying any real secret.
function corpusDir(): string {
  const override = (process.env.TRUSTY_SQUIRE_CORPUS_DIR ?? "").trim();
  if (override.length > 0) return override;
  return join(process.env.HOME ?? "", ".trusty-squire", "corpus", "onboarding");
}

interface CorpusElement {
  tag?: string;
  type?: string | null;
  role?: string | null;
  href?: string | null;
  labelText?: string | null;
  visibleText?: string | null;
  ariaLabel?: string | null;
  placeholder?: string | null;
  name?: string | null;
  selector?: string;
  landmark?: string | null;
  testId?: string | null;
  checked?: boolean | null;
  value?: string | null;
}

// Map a corpus inventory element to an InteractiveElement. `selector` is the
// stable per-element identity across rounds (the coordinator's delta key), so it
// anchors the identity hash via screenPath; `landmark` becomes the container.
function fromCorpus(c: CorpusElement): InteractiveElement {
  const rawLen = typeof c.value === "string" ? c.value.length : 0;
  return el({
    tag: c.tag ?? "div",
    type: c.type ?? null,
    role: c.role ?? null,
    href: c.href ?? null,
    labelText: c.labelText ?? null,
    visibleText: c.visibleText ?? null,
    ariaLabel: c.ariaLabel ?? null,
    placeholder: c.placeholder ?? null,
    name: c.name ?? null,
    selector: c.selector ?? "sel",
    screenPath: c.selector ?? null, // selector = the stable delta key
    container: c.landmark ?? null,
    checked: c.checked ?? null,
    // Length-preserving placeholder — never a real captured value.
    value: rawLen > 0 ? "x".repeat(Math.min(rawLen, 200)) : null,
  });
}

function normUrl(u: string | undefined): string {
  if (typeof u !== "string" || u.length === 0) return "about:blank";
  try {
    const p = new globalThis.URL(u);
    return `${p.origin}${p.pathname}`; // strip query/hash — same PATH = same page
  } catch {
    return u;
  }
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (i - lo);
}

describe("observe-delta corpus budget (real multi-observe traces)", () => {
  const dir = corpusDir();
  const hasCorpus = (() => {
    try {
      return existsSync(dir);
    } catch {
      return false;
    }
  })();
  const maybe = hasCorpus ? it : it.skip;

  maybe(
    "INV-token-budget (corpus): token-weighted aggregate saving ≥ 50%; prints p10/median/p90",
    () => {
      const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
      // Group by "<service>-<runid>", ordered by round N.
      const runs = new Map<string, Array<{ n: number; file: string }>>();
      for (const f of files) {
        const m = f.match(/^(.*)-r(\d+)\.json$/);
        if (m === null) continue;
        const key = m[1] as string;
        const n = Number.parseInt(m[2] as string, 10);
        const list = runs.get(key) ?? [];
        list.push({ n, file: f });
        runs.set(key, list);
      }
      // Bound runtime: sample up to N runs (state.html makes files large).
      const RUN_CAP = Number(process.env.TS_CORPUS_RUN_CAP ?? "500");
      const runKeys = [...runs.keys()].sort().slice(0, RUN_CAP);

      let aggBaseline = 0;
      let aggDelta = 0;
      const perRunSaving: number[] = [];
      let observesMeasured = 0;
      for (const key of runKeys) {
        const rounds = (runs.get(key) as Array<{ n: number; file: string }>).sort(
          (a, b) => a.n - b.n,
        );
        let prev: ObserveDeltaState | null = null;
        let runBaseline = 0;
        let runDelta = 0;
        for (const { file } of rounds) {
          let doc: { inventory?: CorpusElement[]; state?: { url?: string } };
          try {
            doc = JSON.parse(readFileSync(join(dir, file), "utf8"));
          } catch {
            continue;
          }
          const inv = doc.inventory ?? [];
          if (inv.length === 0) continue;
          const elements = inv.map(fromCorpus);
          const url = normUrl(doc.state?.url);
          const built = buildCompactObservation({ sessionId: key, url, text: "", elements, prev });
          prev = built.nextState;
          runBaseline += JSON.stringify(built.fileElements).length;
          runDelta += JSON.stringify(built.observation).length;
          observesMeasured += 1;
        }
        if (runBaseline === 0) continue;
        aggBaseline += runBaseline;
        aggDelta += runDelta;
        perRunSaving.push(1 - runDelta / runBaseline);
      }

      expect(perRunSaving.length).toBeGreaterThan(20); // meaningful sample
      const aggregate = 1 - aggDelta / aggBaseline;
      perRunSaving.sort((a, b) => a - b);
      const p10 = quantile(perRunSaving, 0.1);
      const median = quantile(perRunSaving, 0.5);
      const p90 = quantile(perRunSaving, 0.9);
      // eslint-disable-next-line no-console
      console.log(
        `INV-token-budget (corpus): ${perRunSaving.length} runs / ${observesMeasured} observes | ` +
          `token-weighted aggregate saving ${(aggregate * 100).toFixed(1)}% ` +
          `(${aggBaseline}B → ${aggDelta}B) | per-run p10 ${(p10 * 100).toFixed(1)}% ` +
          `median ${(median * 100).toFixed(1)}% p90 ${(p90 * 100).toFixed(1)}%`,
      );
      expect(aggregate).toBeGreaterThanOrEqual(0.5);
    },
    60_000,
  );
});

// ── MARGINAL saving of columnar / type-elision / combined, ON TOP OF the delta
//    baseline (Phase 4) ──
//
// The delta baseline is the #398 wire: elements as a JSON array, no columnar, no
// elision (encode:"json", elide:false). Each transform is replayed over the SAME
// real corpus stream as an independent delta run so its own delta decisions are
// consistent. Every measurement covers the whole production-shaped observation:
// corpus-derived page text plus the fixed snapshot_file cost, not only elements.
//   columnar     = encode:"columnar", elide:false
//   type-elision = encode:"json",     elide:true
//   combined     = encode:"columnar", elide:true   (= production)
// Aggregate marginal = 1 - sum(transform) / sum(baseline). Per-run
// p10/median/p90 are printed, not gated; fixed overhead dominates the tail.
describe("observe-delta Phase-4 marginal (columnar / type-elision / combined)", () => {
  const dir = corpusDir();
  const hasCorpus = (() => {
    try {
      return existsSync(dir);
    } catch {
      return false;
    }
  })();
  const maybe = hasCorpus ? it : it.skip;

  maybe(
    "production-shaped marginal over the delta baseline; prints p10/median/p90",
    () => {
      const SNAPSHOT_FILE_BYTES = 90;
      const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
      const runs = new Map<string, Array<{ n: number; file: string }>>();
      for (const f of files) {
        const m = f.match(/^(.*)-r(\d+)\.json$/);
        if (m === null) continue;
        const key = m[1] as string;
        const list = runs.get(key) ?? [];
        list.push({ n: Number.parseInt(m[2] as string, 10), file: f });
        runs.set(key, list);
      }
      const RUN_CAP = Number(process.env.TS_CORPUS_RUN_CAP ?? "500");
      const runKeys = [...runs.keys()].sort().slice(0, RUN_CAP);

      const variants = {
        baseline: { encode: "json" as const, elide: false },
        columnar: { encode: "columnar" as const, elide: false },
        elision: { encode: "json" as const, elide: true },
        combined: { encode: "columnar" as const, elide: true },
      };
      const agg: Record<keyof typeof variants, number> = {
        baseline: 0,
        columnar: 0,
        elision: 0,
        combined: 0,
      };
      const perRun: Record<"columnar" | "typeElision" | "combined", number[]> = {
        columnar: [],
        typeElision: [],
        combined: [],
      };
      let observesMeasured = 0;

      for (const key of runKeys) {
        const rounds = (runs.get(key) as Array<{ n: number; file: string }>).sort(
          (a, b) => a.n - b.n,
        );
        // Parse each round once; replay the identical stream per variant.
        const stream: Array<{ elements: InteractiveElement[]; url: string; text: string }> = [];
        for (const { file } of rounds) {
          let doc: { inventory?: CorpusElement[]; state?: { url?: string; html?: string } };
          try {
            doc = JSON.parse(readFileSync(join(dir, file), "utf8"));
          } catch {
            continue;
          }
          const inv = doc.inventory ?? [];
          if (inv.length === 0) continue;
          const html = doc.state?.html ?? "";
          const text = html
            .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
            .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
            .replace(/<[^>]*>/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 4000);
          stream.push({ elements: inv.map(fromCorpus), url: normUrl(doc.state?.url), text });
        }
        if (stream.length === 0) continue;

        const runBytes: Record<keyof typeof variants, number> = {
          baseline: 0,
          columnar: 0,
          elision: 0,
          combined: 0,
        };
        for (const [name, opt] of Object.entries(variants) as Array<
          [keyof typeof variants, { encode: "json" | "columnar"; elide: boolean }]
        >) {
          let prev: ObserveDeltaState | null = null;
          for (const { elements, url, text } of stream) {
            const built = buildCompactObservation({
              sessionId: key,
              url,
              text,
              elements,
              prev,
              encode: opt.encode,
              elide: opt.elide,
            });
            prev = built.nextState;
            runBytes[name] += JSON.stringify(built.observation).length + SNAPSHOT_FILE_BYTES;
          }
        }
        observesMeasured += stream.length;
        for (const k of ["baseline", "columnar", "elision", "combined"] as const) {
          agg[k] += runBytes[k];
        }
        if (runBytes.baseline > 0) {
          perRun.columnar.push(1 - runBytes.columnar / runBytes.baseline);
          perRun.typeElision.push(1 - runBytes.elision / runBytes.baseline);
          perRun.combined.push(1 - runBytes.combined / runBytes.baseline);
        }
      }

      expect(perRun.columnar.length).toBeGreaterThan(20);
      const marginal = {
        columnar: 1 - agg.columnar / agg.baseline,
        elision: 1 - agg.elision / agg.baseline,
        combined: 1 - agg.combined / agg.baseline,
      };
      const report = (label: "columnar" | "typeElision" | "combined"): string => {
        const s = [...perRun[label]].sort((a, b) => a - b);
        const aggregate = label === "typeElision" ? marginal.elision : marginal[label];
        return (
          `${label === "typeElision" ? "type-elision" : label} aggregate ${(aggregate * 100).toFixed(1)}% | ` +
          `per-run p10 ${(quantile(s, 0.1) * 100).toFixed(1)}% ` +
          `median ${(quantile(s, 0.5) * 100).toFixed(1)}% p90 ${(quantile(s, 0.9) * 100).toFixed(1)}%`
        );
      };
      // eslint-disable-next-line no-console
      console.log(
        `Phase-4 marginal (${perRun.columnar.length} runs / ${observesMeasured} observes | ` +
          `baseline ${agg.baseline}B)\n  ${report("columnar")}\n  ${report("typeElision")}\n  ${report("combined")}`,
      );

      expect(marginal.columnar).toBeGreaterThanOrEqual(0.1);
      // Type elision is retained only as a small, safe, net-positive reduction.
      // It is measured and printed but is too small on the whole payload to gate.
      expect(marginal.combined).toBeGreaterThanOrEqual(marginal.columnar);
    },
    60_000,
  );
});

// #2 (stable-ref-includes-mutable-path) — ASSESS + report. Measures how often the
// REGION field that feeds stableElementId flips for a control that is otherwise
// the same across a same-URL re-observe (which re-mints its ref). Matched by
// `selector` (the per-control stable key). NOTE: the captured corpus does not
// store the live extractor's `screenPath` (only the stable HTML5 `landmark`), so
// this measures the landmark→container proxy — the closest region signal the
// corpus carries; the live screenPath rate is bounded by, not identical to, this.
describe("observe-delta mutable-path re-mint rate (#2 assessment)", () => {
  const dir = corpusDir();
  const hasCorpus = (() => {
    try {
      return existsSync(dir);
    } catch {
      return false;
    }
  })();
  const maybe = hasCorpus ? it : it.skip;

  maybe(
    "reports how often the region field re-mints a stable control's ref on a re-observe",
    () => {
      const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
      const runs = new Map<string, Array<{ n: number; file: string }>>();
      for (const f of files) {
        const m = f.match(/^(.*)-r(\d+)\.json$/);
        if (m === null) continue;
        const list = runs.get(m[1] as string) ?? [];
        list.push({ n: Number.parseInt(m[2] as string, 10), file: f });
        runs.set(m[1] as string, list);
      }
      const RUN_CAP = Number(process.env.TS_CORPUS_RUN_CAP ?? "500");
      const runKeys = [...runs.keys()].sort().slice(0, RUN_CAP);

      let matched = 0; // same selector present in both consecutive rounds
      let regionRemint = 0; // …whose region (container) field changed → ref re-mint
      let identityRemint = 0; // …whose full stableElementId changed (any cause)
      for (const key of runKeys) {
        const rounds = (runs.get(key) as Array<{ n: number; file: string }>).sort(
          (a, b) => a.n - b.n,
        );
        let prev: { url: string; bySel: Map<string, InteractiveElement> } | null = null;
        for (const { file } of rounds) {
          let doc: { inventory?: CorpusElement[]; state?: { url?: string } };
          try {
            doc = JSON.parse(readFileSync(join(dir, file), "utf8"));
          } catch {
            continue;
          }
          const inv = doc.inventory ?? [];
          if (inv.length === 0) continue;
          const url = normUrl(doc.state?.url);
          const bySel = new Map<string, InteractiveElement>();
          for (const c of inv) {
            const mapped = fromCorpus(c);
            // Isolate the REGION field: give every element the SAME screenPath so
            // only `container` (the region proxy) can move the identity here.
            mapped.screenPath = mapped.selector;
            bySel.set(mapped.selector, mapped);
          }
          if (prev !== null && prev.url === url) {
            for (const [sel, cur] of bySel) {
              const before = prev.bySel.get(sel);
              if (before === undefined) continue;
              matched += 1;
              if ((before.container ?? "") !== (cur.container ?? "")) regionRemint += 1;
              if (stableElementId(before) !== stableElementId(cur)) identityRemint += 1;
            }
          }
          prev = { url, bySel };
        }
      }

      expect(matched).toBeGreaterThan(100);
      const regionRate = regionRemint / matched;
      const identityRate = identityRemint / matched;
      // eslint-disable-next-line no-console
      console.log(
        `#2 mutable-path assessment: ${matched} same-selector re-observe pairs | ` +
          `region-field(container) re-mints ${regionRemint} = ${(regionRate * 100).toFixed(2)}% | ` +
          `any-cause identity re-mints ${(identityRate * 100).toFixed(2)}% ` +
          `(screenPath not captured in corpus — landmark proxy)`,
      );
      // Assertion only guards that the region field is NOT a dominant churn source
      // (a regression that made region text mutable would spike this). Advisory
      // threshold, generous.
      expect(regionRate).toBeLessThan(0.25);
    },
    60_000,
  );
});

describe("observe-delta wiring (real observe() over a mocked browser)", () => {
  let dir: string;
  let compactV2ModeBeforeTest: string | undefined;
  beforeEach(() => {
    compactV2ModeBeforeTest = process.env.TRUSTY_SQUIRE_OBSERVE_V2;
    process.env.TRUSTY_SQUIRE_OBSERVE_V2 = "off";
    h.providers = ["google"];
    h.oauthStatus = "already_valid";
    h.visibleText = "";
    h.currentUrl = "";
    h.mainDocumentEpoch = 0;
    dir = mkdtempSync(join(tmpdir(), "ts-observe-"));
    process.env.TRUSTY_SQUIRE_OBSERVE_DIR = dir;
  });
  afterEach(async () => {
    await closeAllProvisionSessions();
    if (compactV2ModeBeforeTest === undefined) delete process.env.TRUSTY_SQUIRE_OBSERVE_V2;
    else process.env.TRUSTY_SQUIRE_OBSERVE_V2 = compactV2ModeBeforeTest;
    delete process.env.TRUSTY_SQUIRE_OBSERVE_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it("persists the COMPLETE snapshot every observe and emits an element+text delta on the second", async () => {
    h.elements = casetifyPage();
    h.visibleText = "Shop the tech collection. New arrivals every week.";
    const start = await startProvisionSession({ serviceUrl: URL });
    const sid = start.session_id;
    // start's observation is a full snapshot with a snapshot_file pointer + full text.
    expect(start.delta).toBe(false);
    expect(typeof start.snapshot_file).toBe("string");
    expect(start.text).toContain("Shop the tech collection");
    expect(start.text_unchanged).toBeUndefined();

    // A second observe of the SAME page + SAME text → delta, everything unchanged,
    // and the text blob is collapsed to a marker.
    const obs2 = await observe(sid, "compact");
    expect(obs2.delta).toBe(true);
    expect(rows(obs2).length).toBe(0);
    expect(obs2.unchanged).toBe(h.elements.length);
    expect(obs2.text_unchanged).toBe(true);
    expect(obs2.text).toBe("");

    // The persisted file is the COMPLETE inventory (path included) — the re-expand
    // safety net, NOT the trimmed delta.
    const snap = JSON.parse(readFileSync(obs2.snapshot_file as string, "utf8"));
    expect(snap.elements.length).toBe(h.elements.length);
    expect(snap.elements.some((e: ObservedElement) => typeof e.path === "string")).toBe(true);
    expect(snap.text_truncated).toBe(false);
  });

  it("persists the text truncation marker with the capped snapshot text", async () => {
    h.elements = casetifyPage();
    h.visibleText = "x".repeat(4001);

    const start = await startProvisionSession({ serviceUrl: URL });
    const snap = JSON.parse(readFileSync(start.snapshot_file as string, "utf8"));

    expect(start.text_truncated).toBe(true);
    expect(snap.text).toHaveLength(4000);
    expect(snap.text_truncated).toBe(true);
  });

  it("keeps a caller-owned parent unchanged and secures the session directory", async () => {
    chmodSync(dir, 0o755);
    h.elements = casetifyPage();
    h.visibleText = "Account token details";

    const start = await startProvisionSession({ serviceUrl: URL });
    const snapshotFile = start.snapshot_file as string;

    expect(statSync(dir).mode & 0o777).toBe(0o755);
    expect(statSync(dirname(snapshotFile)).mode & 0o777).toBe(0o700);
    expect(statSync(snapshotFile).mode & 0o777).toBe(0o600);
  });

  it("persist FAILURE → full uncollapsed response, no snapshot_file, delta baseline NOT advanced", async () => {
    h.elements = casetifyPage().map((element) =>
      element.container === "dialog:signin-promo"
        ? { ...element, inDialog: true, topmost: true }
        : element,
    );
    h.visibleText = "Shop the tech collection.";
    // obs1: persist SUCCEEDS, establishes the delta baseline.
    const start = await startProvisionSession({ serviceUrl: URL });
    const sid = start.session_id;
    expect(typeof start.snapshot_file).toBe("string");
    expect(start.modal_active).toBe(true);
    const snapshotFile = start.snapshot_file as string;
    const collapsedCount = start.chrome_links_collapsed ?? 0;
    expect(collapsedCount).toBeGreaterThan(0); // obs1 collapsed some chrome links

    // Make persistence FAIL: point the observe dir under a regular FILE so
    // mkdirSync throws (ENOTDIR).
    const blocker = join(dir, "blocker-file");
    writeFileSync(blocker, "x");
    process.env.TRUSTY_SQUIRE_OBSERVE_DIR = join(blocker, "cannot-mkdir");

    // obs2: same page → WOULD be a delta, but persist fails → FULL, UNCOLLAPSED,
    // no snapshot_file, and the baseline must NOT advance.
    const obs2 = await observe(sid, "compact");
    expect(obs2.delta).toBe(false); // NOT a delta (no recovery file)
    expect(obs2.snapshot_file).toBeUndefined();
    expect(obs2.chrome_links_collapsed).toBeUndefined(); // uncollapsed
    expect(obs2.modal_active).toBe(true);
    expect(rows(obs2).length).toBe(h.elements.length); // EVERY element inline
    expect(obs2.unchanged).toBeUndefined();
    expect(existsSync(snapshotFile)).toBe(false);

    // Restore persistence; obs3 must be a FRESH FULL snapshot (delta:false), NOT
    // a delta against the pre-failure baseline — the failed observe INVALIDATED
    // the baseline, so the next observe re-syncs the host from a full snapshot
    // (with its own recovery file) rather than an A-relative delta.
    process.env.TRUSTY_SQUIRE_OBSERVE_DIR = dir;
    const obs3 = await observe(sid, "compact");
    expect(obs3.delta).toBe(false);
    expect(typeof obs3.snapshot_file).toBe("string");
  });

  it("remove-then-restore across a failed persist does NOT desync the host (codex #2)", async () => {
    // The exact desync sequence: baseline A has element X; B removes X while
    // persistence fails; C restores X byte-identically to A. If the failed observe
    // left the baseline at A, the A→C delta would report X unchanged and the host
    // (which reset to B, without X) would never re-add it. Invalidating the
    // baseline on failure forces C to be a full re-sync, so X is present.
    const withX = (): unknown[] => [
      el({
        tag: "button",
        role: "button",
        visibleText: "Continue",
        screenPath: "form:x > button:continue",
        selector: "#continue",
      }),
      el({
        tag: "button",
        role: "button",
        visibleText: "Special X",
        screenPath: "form:x > button:x",
        selector: "#x",
      }),
    ];
    const withoutX = (): unknown[] => [
      el({
        tag: "button",
        role: "button",
        visibleText: "Continue",
        screenPath: "form:x > button:continue",
        selector: "#continue",
      }),
    ];
    h.elements = withX();
    h.visibleText = "Form";
    const a = await startProvisionSession({ serviceUrl: URL }); // A: {Continue, X}
    expect(rows(a).some((e) => e.label === "Special X")).toBe(true);

    // B: X removed, persistence FAILS.
    const blocker = join(dir, "blk");
    writeFileSync(blocker, "x");
    process.env.TRUSTY_SQUIRE_OBSERVE_DIR = join(blocker, "no");
    h.elements = withoutX();
    const b = await observe(a.session_id, "compact");
    expect(b.delta).toBe(false); // full uncollapsed fallback
    expect(rows(b).some((e) => e.label === "Special X")).toBe(false);

    // C: X restored (byte-identical to A), persistence RESTORED.
    process.env.TRUSTY_SQUIRE_OBSERVE_DIR = dir;
    h.elements = withX();
    const c = await observe(a.session_id, "compact");
    // The host must SEE X again — reconstruct C's full set from the emitted
    // payload (a full re-sync, so elements are complete inline).
    const cView =
      c.delta === true
        ? // (would be the buggy path) apply delta to B's view — X would be missing
          null
        : new Map(rows(c).map((e) => [e.ref, e]));
    expect(c.delta).toBe(false); // full re-sync, not an A-relative delta
    expect(
      [...(cView as Map<string, ObservedElement>).values()].some((e) => e.label === "Special X"),
    ).toBe(true);
  });

  it("#399 remove-then-restore across a failed persist keeps a volatile positional-sibling group in sync", async () => {
    // Same failed-persist desync sequence, but the churning elements are a
    // VOLATILE positional-selector group (per-row Remove buttons). Their group
    // identities are recomputed every observe (issue #399); this proves that
    // recomputation composes with the failed-persist baseline invalidation — the
    // host never desyncs, and the restored row reappears.
    const rowElements = (count: number): unknown[] => {
      const out: unknown[] = [
        el({
          tag: "button",
          role: "button",
          visibleText: "Done",
          screenPath: "list:rows > button:done",
          selector: "#done",
        }),
      ];
      for (let i = 1; i <= count; i++) {
        out.push(
          el({
            tag: "button",
            role: "button",
            visibleText: "Remove",
            screenPath: "list:rows > button:remove",
            container: "list:rows",
            selector: `ul>li:nth-of-type(${i})>button`,
          }),
        );
      }
      return out;
    };
    const removeCount = (obs: Observation): number =>
      rows(obs).filter((e) => e.label === "Remove").length;

    h.elements = rowElements(3); // A: Done + 3 Remove rows
    h.visibleText = "Rows";
    const a = await startProvisionSession({ serviceUrl: URL });
    expect(removeCount(a)).toBe(3);

    // B: one row removed while persistence FAILS → full uncollapsed fallback,
    // delta baseline invalidated.
    const blocker = join(dir, "blk-vol");
    writeFileSync(blocker, "x");
    process.env.TRUSTY_SQUIRE_OBSERVE_DIR = join(blocker, "no");
    h.elements = rowElements(2);
    const b = await observe(a.session_id, "compact");
    expect(b.delta).toBe(false);
    expect(removeCount(b)).toBe(2);

    // C: row restored, persistence RESTORED → a FRESH full re-sync (not an
    // A-relative delta), so the host sees all three rows again — the volatile
    // group's per-observe identity recomputation never desyncs across the failure
    // boundary.
    process.env.TRUSTY_SQUIRE_OBSERVE_DIR = dir;
    h.elements = rowElements(3);
    const c = await observe(a.session_id, "compact");
    expect(c.delta).toBe(false);
    expect(removeCount(c)).toBe(3);
    // No duplicate refs survived the churn.
    const refsC = rows(c).map((e) => e.ref);
    expect(new Set(refsC).size).toBe(refsC.length);
  });

  it("detail:full refreshes the persisted snapshot as a side-effect (no stale re-expansion)", async () => {
    h.elements = casetifyPage();
    h.visibleText = "Page A";
    const start = await startProvisionSession({ serviceUrl: URL });
    const sid = start.session_id;
    const snapshotFile = start.snapshot_file as string;

    // Navigate to a DIFFERENT page, observed ONLY through full mode.
    const pageB = [
      el({
        tag: "button",
        role: "button",
        visibleText: "Only on B",
        screenPath: "main:b > button:x",
        selector: "#b",
      }),
    ];
    h.elements = pageB;
    h.visibleText = "Page B";
    const full = await observe(sid, "full");
    // The full payload stays byte-equivalent (no snapshot_file field surfaced).
    expect(full.snapshot_file).toBeUndefined();

    // But the persisted file was refreshed to page B — re-expansion is NOT stale.
    const snap = JSON.parse(readFileSync(snapshotFile, "utf8"));
    expect(snap.elements.length).toBe(1);
    expect(snap.elements[0].label).toBe("Only on B");
    expect(snap.elements.some((e: ObservedElement) => e.label === "Casetify")).toBe(false);
  });

  it("detail:full invalidates the compact baseline before a same-length value change", async () => {
    const field = (value: string): InteractiveElement =>
      el({
        tag: "input",
        role: "textbox",
        visibleText: "Workspace",
        value,
        selector: "#workspace",
        screenPath: "form:workspace > input:workspace",
      });
    h.elements = [field("alpha")];
    const start = await startProvisionSession({ serviceUrl: URL });

    const full = await observe(start.session_id, "full");
    expect(full.elements![0]?.value).toBe("alpha");

    h.elements = [field("bravo")];
    const compact = await observe(start.session_id, "compact");
    expect(compact.delta).toBe(false);
    expect(rows(compact)[0]?.value_len).toBe(5);

    const next = await observe(start.session_id, "compact");
    expect(next.delta).toBe(true);
  });

  it("detail:full removes a stale snapshot when its side-effect persist fails", async () => {
    h.elements = casetifyPage();
    h.visibleText = "Account page";
    const start = await startProvisionSession({ serviceUrl: URL });
    const sid = start.session_id;
    const snapshotFile = start.snapshot_file as string;
    const fullBeforeFailure = await observe(sid, "full");

    mkdirSync(join(dirname(snapshotFile), `.observe-${sid}-3.tmp`));
    const fullAfterFailure = await observe(sid, "full");

    expect(fullAfterFailure).toEqual(fullBeforeFailure);
    expect(existsSync(snapshotFile)).toBe(false);

    const compact = await observe(sid, "compact");
    expect(compact.delta).toBe(false);
    expect(typeof compact.snapshot_file).toBe("string");
  });

  it("uses current full page text for internal postcondition checks", async () => {
    h.elements = casetifyPage();
    h.visibleText = "Workspace setup complete";
    const start = await startProvisionSession({ serviceUrl: URL });

    const result = await verifyPostcondition(start.session_id, {
      kind: "execute_capability",
      describe: "Workspace setup completed",
      success_signal: { text_present: "Workspace setup complete" },
    });

    expect(result.confirmed).toBe(true);
  });

  it("INV-full-escape-hatch: detail:full is byte-equivalent and un-deltified regardless of delta history", async () => {
    h.elements = casetifyPage();
    const start = await startProvisionSession({ serviceUrl: URL });
    const sid = start.session_id;

    const full1 = await observe(sid, "full");
    // A compact observe in between mutates the delta baseline...
    await observe(sid, "compact");
    // ...but a second full observe of the identical page is byte-identical.
    const full2 = await observe(sid, "full");

    // No delta machinery ever leaks into the escape hatch, and NO field is
    // elided: full keeps every element (no collapse) with the complete legacy
    // field set (path, container, value, checked, ...).
    for (const f of [full1, full2]) {
      expect(f.delta).toBeUndefined();
      expect(f.unchanged).toBeUndefined();
      expect(f.chrome_links_collapsed).toBeUndefined();
      expect(f.text_unchanged).toBeUndefined();
      expect(f.snapshot_file).toBeUndefined(); // escape hatch is the legacy shape
      expect(f.elements!.length).toBe(h.elements.length);
      for (const e of f.elements!) {
        const bag = e as unknown as Record<string, unknown>;
        for (const field of [
          "ref",
          "label",
          "tag",
          "role",
          "type",
          "value",
          "checked",
          "href",
          "testId",
          "path",
          "container",
          "topmost",
          "occluded_by",
        ]) {
          expect(field in bag, `full element missing "${field}"`).toBe(true);
        }
      }
      expect(f.screen).toBeDefined();
      expect(f.accessibility).toBeDefined();
    }
    // The ENTIRE full payload is identical across the two calls — the compact
    // observe that ran in between (mutating delta state) did not perturb ANY field
    // (elements, screen, accessibility, text, guidance, url, session_id).
    expect(full1).toEqual(full2);
  });
});
