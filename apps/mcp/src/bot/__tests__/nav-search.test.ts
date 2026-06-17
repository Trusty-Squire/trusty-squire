// Unit tests for the pure nav-search primitives (slice 1 of the post-signup
// nav-search engine — DESIGN-post-signup-nav-search.md). These are browser-free:
// inventory/url/text in, decision out. They lock the behaviors the design's
// test plan requires (links+buttons in scope, deterministic ranking with a
// tiebreak signal, arrived-vs-start-of-gated goal classification).

import { describe, expect, it } from "vitest";
import type { InteractiveElement } from "../browser.js";
import {
  assessKeyGoal,
  enumerateCandidates,
  mergeInventories,
  resolveNavHref,
  isOffSiteHref,
  findOverlayDismiss,
  findWizardAdvance,
  planOnboardingChoice,
  planOverlayStep,
  rankCandidates,
  runNavSearch,
  scoreCandidate,
  type NavCandidate,
  type NavSearchBrowserPort,
} from "../nav-search.js";

function el(partial: Partial<InteractiveElement>): InteractiveElement {
  return {
    index: 0,
    tag: "a",
    type: null,
    id: null,
    name: null,
    placeholder: null,
    ariaLabel: null,
    role: null,
    labelText: null,
    visibleText: null,
    selector: "#el",
    visible: true,
    inViewport: true,
    inConsentWidget: false,
    ...partial,
  };
}

function cand(partial: Partial<NavCandidate>): NavCandidate {
  return { selector: "#c", href: null, text: "", isAnchor: true, inViewport: true, ...partial };
}

describe("enumerateCandidates", () => {
  it("includes links AND buttons (keys page is often a button, not an anchor)", () => {
    const inv = [
      el({ tag: "a", visibleText: "API Keys", href: "/settings/api-keys", selector: "#a" }),
      el({ tag: "button", visibleText: "Developers", selector: "#b" }),
      el({ tag: "input", type: "text", selector: "#in" }),
    ];
    const got = enumerateCandidates(inv).map((c) => c.selector);
    expect(got).toEqual(["#a", "#b"]);
  });

  it("includes role=link / role=button", () => {
    const inv = [
      el({ tag: "div", role: "button", visibleText: "Tokens", selector: "#r" }),
      el({ tag: "span", role: "link", visibleText: "Settings", href: "/settings", selector: "#l" }),
    ];
    expect(enumerateCandidates(inv).map((c) => c.selector).sort()).toEqual(["#l", "#r"]);
  });

  it("skips hidden elements and ones with neither text nor href", () => {
    const inv = [
      el({ tag: "a", visibleText: "Keys", href: "/keys", visible: false, selector: "#hidden" }),
      el({ tag: "button", visibleText: null, href: null, selector: "#empty" }),
      el({ tag: "a", visibleText: "Keys", href: "/keys", selector: "#ok" }),
    ];
    expect(enumerateCandidates(inv).map((c) => c.selector)).toEqual(["#ok"]);
  });

  it("folds visibleText/ariaLabel/title/iconLabel into one text field", () => {
    const inv = [el({ tag: "button", visibleText: null, ariaLabel: "API keys", selector: "#x" })];
    expect(enumerateCandidates(inv)[0]?.text).toBe("API keys");
  });

  it("never surfaces destructive actions (delete/revoke/deactivate) — they must not be auto-clicked", () => {
    const inv = [
      el({ tag: "button", visibleText: "Delete Account", selector: "#del" }),
      el({ tag: "button", visibleText: "Revoke token", selector: "#rev" }),
      el({ tag: "button", visibleText: "Deactivate", selector: "#deact" }),
      el({ tag: "a", visibleText: "Cancel subscription", href: "/billing/cancel", selector: "#cancel" }),
      el({ tag: "a", visibleText: "API Keys", href: "/settings/keys", selector: "#keep" }),
    ];
    expect(enumerateCandidates(inv).map((c) => c.selector)).toEqual(["#keep"]);
  });
});

describe("mergeInventories", () => {
  it("unions both snapshots deduped by selector (an open-then-closed menu's items survive)", () => {
    const before = [
      el({ selector: "#avatar", visibleText: "User" }),
      el({ selector: "#account", visibleText: "Account" }), // menu item, open at entry
      el({ selector: "#billing", visibleText: "Billing" }),
    ];
    const after = [
      el({ selector: "#avatar", visibleText: "User" }), // menu re-closed by expand → items gone
      el({ selector: "#new", visibleText: "New" }), // a newly-revealed control
    ];
    const merged = mergeInventories(before, after).map((e) => e.selector).sort();
    expect(merged).toEqual(["#account", "#avatar", "#billing", "#new"]);
  });

  it("first occurrence wins on selector collision", () => {
    const a = [el({ selector: "#x", visibleText: "first" })];
    const b = [el({ selector: "#x", visibleText: "second" })];
    expect(mergeInventories(a, b)[0]?.visibleText).toBe("first");
  });
});

describe("resolveNavHref", () => {
  const here = "https://x.test/assistants";
  it("resolves a relative path against the current URL", () => {
    expect(resolveNavHref("/account", here)).toBe("https://x.test/account");
  });
  it("keeps an absolute http(s) URL", () => {
    expect(resolveNavHref("https://x.test/settings/keys", here)).toBe("https://x.test/settings/keys");
  });
  it("rejects non-destinations (#, javascript:, mailto:, empty)", () => {
    expect(resolveNavHref("#", here)).toBeNull();
    expect(resolveNavHref("#section", here)).toBeNull();
    expect(resolveNavHref("javascript:void(0)", here)).toBeNull();
    expect(resolveNavHref("mailto:a@b.c", here)).toBeNull();
    expect(resolveNavHref("", here)).toBeNull();
    expect(resolveNavHref(null, here)).toBeNull();
  });
  it("rejects a self-link (no progress)", () => {
    expect(resolveNavHref("/assistants", here)).toBeNull();
  });
});

describe("isOffSiteHref", () => {
  const app = "https://console.neon.tech/app/projects/x/settings";
  it("flags a link to the marketing/docs domain as off-site (the neon wander)", () => {
    expect(isOffSiteHref(app, "https://neon.com/docs/get-started")).toBe(true);
    expect(isOffSiteHref(app, "https://neon.com/blog/why")).toBe(true);
  });
  it("keeps same-registrable-domain links (app subdomains)", () => {
    expect(isOffSiteHref(app, "https://console.neon.tech/app/settings")).toBe(false);
    expect(isOffSiteHref(app, "https://api.neon.tech/v2/keys")).toBe(false);
    expect(isOffSiteHref(app, "/app/settings#api-keys")).toBe(false); // relative
  });
  it("treats non-navigable hrefs (null/#) as not-off-site (handled elsewhere)", () => {
    expect(isOffSiteHref(app, null)).toBe(false);
    expect(isOffSiteHref(app, "#")).toBe(false);
  });
});

describe("scoreCandidate", () => {
  it("scores a real keys href highest", () => {
    expect(scoreCandidate(cand({ href: "/settings/api-keys", text: "Settings" }))).toBeGreaterThan(
      scoreCandidate(cand({ href: null, text: "Settings" })),
    );
  });

  it("ranks explicit 'API keys' text above weak 'settings'", () => {
    expect(scoreCandidate(cand({ text: "API keys", isAnchor: false, inViewport: false }))).toBeGreaterThan(
      scoreCandidate(cand({ text: "Settings", isAnchor: false, inViewport: false })),
    );
  });

  it("zeroes obvious non-destinations (billing, docs, logout, keyboard shortcuts)", () => {
    expect(scoreCandidate(cand({ href: "/settings/billing", text: "Billing" }))).toBe(0);
    expect(scoreCandidate(cand({ href: "/docs", text: "Documentation" }))).toBe(0);
    expect(scoreCandidate(cand({ text: "Log out" }))).toBe(0);
    expect(scoreCandidate(cand({ href: "/help/shortcuts", text: "Keyboard shortcuts" }))).toBe(0);
  });

  it("a bare unrelated link scores 0", () => {
    expect(scoreCandidate(cand({ href: "/dashboard", text: "Dashboard" }))).toBe(0);
  });
});

describe("rankCandidates", () => {
  it("orders by score, drops zero-score, and the keys link wins", () => {
    const r = rankCandidates([
      cand({ selector: "#dash", href: "/dashboard", text: "Dashboard" }),
      cand({ selector: "#keys", href: "/settings/api-keys", text: "API Keys" }),
      cand({ selector: "#set", href: "/settings", text: "Settings" }),
    ]);
    expect(r.ranked[0]?.selector).toBe("#keys");
    expect(r.ranked.map((c) => c.selector)).not.toContain("#dash"); // zero-score dropped
    expect(r.needsTiebreak).toBe(false);
  });

  it("flags needsTiebreak when nothing scores (LLM must decide)", () => {
    const r = rankCandidates([
      cand({ href: "/dashboard", text: "Dashboard" }),
      cand({ href: "/home", text: "Home" }),
    ]);
    expect(r.ranked).toHaveLength(0);
    expect(r.needsTiebreak).toBe(true);
  });

  it("flags needsTiebreak when the top two tie", () => {
    const r = rankCandidates([
      cand({ selector: "#a", href: "/settings", text: "Settings", isAnchor: true, inViewport: true }),
      cand({ selector: "#b", href: "/account", text: "Account", isAnchor: true, inViewport: true }),
    ]);
    expect(r.needsTiebreak).toBe(true);
  });
});

describe("assessKeyGoal", () => {
  const dashInv = [el({ tag: "a", visibleText: "Dashboard", href: "/", selector: "#d" })];

  it("create-key affordance on a keys surface → create_gated (subgoal, not arrival)", () => {
    const inv = [el({ tag: "button", visibleText: "Create API key", selector: "#create" })];
    const g = assessKeyGoal({ url: "https://x.test/settings/api-keys", pageText: "API keys", inventory: inv });
    expect(g.kind).toBe("create_gated");
    if (g.kind === "create_gated") expect(g.createSelector).toBe("#create");
  });

  it("keys/settings URL with no create affordance → on_key_surface (caller extracts)", () => {
    const g = assessKeyGoal({ url: "https://x.test/settings/keys", pageText: "Your API key", inventory: dashInv });
    expect(g.kind).toBe("on_key_surface");
  });

  it("a normal dashboard URL → not_yet (keep searching)", () => {
    const g = assessKeyGoal({ url: "https://x.test/app/home", pageText: "Welcome", inventory: dashInv });
    expect(g.kind).toBe("not_yet");
  });

  it("a 'Create' button OFF a key surface does not hijack as create_gated", () => {
    const inv = [el({ tag: "button", visibleText: "Create API key", selector: "#create" })];
    const g = assessKeyGoal({ url: "https://x.test/app/projects", pageText: "Projects", inventory: inv });
    expect(g.kind).toBe("not_yet");
  });

  it("empty keys table (header text trips existing-account heuristic) but with a create button → create_gated, not on_key_surface", () => {
    // Regression: groq's virgin /keys renders an EMPTY table whose column
    // headers ("Key name" + "Last used") satisfy detectExistingAccountNoExtract
    // (2 existing-key word signals on a /keys URL). Pre-fix that won, returned
    // on_key_surface, extraction found nothing, and the loop wandered to
    // /settings. The visible "Create API Key" button must win → mint instead.
    const inv = [el({ tag: "button", visibleText: "Create API Key", selector: "#create" })];
    const g = assessKeyGoal({
      url: "https://console.groq.com/keys",
      pageText: "API Keys Manage your project API keys. Key name Created Last used",
      inventory: inv,
    });
    expect(g.kind).toBe("create_gated");
    if (g.kind === "create_gated") expect(g.createSelector).toBe("#create");
  });
});

describe("findOverlayDismiss / findWizardAdvance / planOverlayStep", () => {
  it("finds skip/close/not-now dismiss affordances", () => {
    expect(findOverlayDismiss([el({ tag: "button", visibleText: "Skip", selector: "#s" })])?.selector).toBe("#s");
    expect(findOverlayDismiss([el({ tag: "button", visibleText: "Skip for now", selector: "#s2" })])?.selector).toBe("#s2");
    expect(findOverlayDismiss([el({ tag: "button", ariaLabel: "Close", visibleText: null, selector: "#x" })])?.selector).toBe("#x");
    expect(findOverlayDismiss([el({ tag: "button", visibleText: "Maybe later", selector: "#l" })])?.selector).toBe("#l");
  });

  it("does NOT treat long text merely containing 'close' as a dismiss control", () => {
    expect(findOverlayDismiss([el({ tag: "button", visibleText: "Close your first deal today", selector: "#deal" })])).toBeNull();
  });

  it("finds Next/Continue/Get started wizard-advance controls (anchored)", () => {
    expect(findWizardAdvance([el({ tag: "button", visibleText: "Next", selector: "#n" })])?.selector).toBe("#n");
    expect(findWizardAdvance([el({ tag: "button", visibleText: "Get started", selector: "#g" })])?.selector).toBe("#g");
  });

  it("does NOT match 'Continue with Google' or 'Submit feedback' (whole-label anchor)", () => {
    expect(findWizardAdvance([el({ tag: "button", visibleText: "Continue with Google", selector: "#goog" })])).toBeNull();
    expect(findWizardAdvance([el({ tag: "button", visibleText: "Submit feedback", selector: "#fb" })])).toBeNull();
  });

  it("planOverlayStep prefers dismiss over advance, then advance, then none", () => {
    const both = [
      el({ tag: "button", visibleText: "Next", selector: "#next" }),
      el({ tag: "button", visibleText: "Skip", selector: "#skip" }),
    ];
    expect(planOverlayStep(both)).toEqual({ kind: "dismiss", selector: "#skip" });
    expect(planOverlayStep([el({ tag: "button", visibleText: "Continue", selector: "#c" })])).toEqual({ kind: "advance", selector: "#c" });
    expect(planOverlayStep([el({ tag: "button", visibleText: "Dashboard", selector: "#d" })])).toEqual({ kind: "none" });
  });
});

// ── search loop (T4) — driven by a scriptable fake browser ───────────────────
interface FakePage {
  url: string;
  text: string;
  inv: InteractiveElement[];
}

class FakeBrowser implements NavSearchBrowserPort {
  page: FakePage;
  readonly transitions: Map<string, FakePage>;
  expandedTo: FakePage | null;
  escapes = 0;
  constructor(start: FakePage, transitions: Record<string, FakePage>, expandedTo: FakePage | null = null) {
    this.page = start;
    this.transitions = new Map(Object.entries(transitions));
    this.expandedTo = expandedTo;
  }
  currentUrl(): string {
    return this.page.url;
  }
  async extractText(): Promise<string> {
    return this.page.text;
  }
  async extractInventory(): Promise<InteractiveElement[]> {
    return this.page.inv;
  }
  async clickSelector(sel: string): Promise<void> {
    const next = this.transitions.get(sel);
    if (next) this.page = next;
  }
  async navigate(url: string): Promise<void> {
    // Transitions may be keyed by selector (click) OR by absolute URL (href-nav).
    const next = this.transitions.get(url);
    this.page = next ?? { url, text: "", inv: [] };
  }
  async pressEscape(): Promise<void> {
    this.escapes += 1;
  }
  async settle(): Promise<void> {}
  async expandLatentNav(): Promise<void> {
    if (this.expandedTo) this.page = this.expandedTo;
  }
}

describe("runNavSearch", () => {
  it("finds the key by navigating the real API-keys nav link (href-first)", async () => {
    const keysPage: FakePage = { url: "https://x.test/settings/api-keys", text: "Your API key", inv: [] };
    const browser = new FakeBrowser(
      { url: "https://x.test/app", text: "Dashboard", inv: [el({ tag: "a", visibleText: "API Keys", href: "/settings/api-keys", selector: "#keys" })] },
      // Anchor picks navigate by resolved href, so key the transition by URL.
      { "https://x.test/settings/api-keys": keysPage },
    );
    const res = await runNavSearch(browser, {
      extractKey: async () => (browser.currentUrl().includes("api-keys") ? { api_key: "sk_1" } : null),
    });
    expect(res).toEqual({ kind: "found", credentials: { api_key: "sk_1" } });
  });

  it("runs the create-key subgoal then extracts the freshly created key", async () => {
    const created: FakePage = {
      url: "https://x.test/settings/api-keys",
      text: "API keys sk_new123",
      inv: [el({ tag: "button", visibleText: "Create API key", selector: "#create" })],
    };
    const browser = new FakeBrowser(
      { url: "https://x.test/settings/api-keys", text: "API keys", inv: [el({ tag: "button", visibleText: "Create API key", selector: "#create" })] },
      { "#create": created },
    );
    const res = await runNavSearch(browser, {
      extractKey: async () => (browser.page.text.includes("sk_") ? { api_key: "sk_new123" } : null),
    });
    expect(res).toEqual({ kind: "found", credentials: { api_key: "sk_new123" } });
  });

  it("dismisses a blocking overlay before navigating, then finds the key", async () => {
    const keysPage: FakePage = { url: "https://x.test/settings/api-keys", text: "key", inv: [] };
    const afterDismiss: FakePage = { url: "https://x.test/app", text: "Dashboard", inv: [el({ tag: "a", visibleText: "API Keys", href: "/settings/api-keys", selector: "#keys" })] };
    const browser = new FakeBrowser(
      { url: "https://x.test/app", text: "Welcome", inv: [el({ tag: "button", visibleText: "Skip", selector: "#skip" }), el({ tag: "a", visibleText: "API Keys", href: "/settings/api-keys", selector: "#keys" })] },
      { "#skip": afterDismiss, "https://x.test/settings/api-keys": keysPage },
    );
    const res = await runNavSearch(browser, {
      extractKey: async () => (browser.currentUrl().includes("api-keys") ? { api_key: "sk_d" } : null),
    });
    expect(res).toEqual({ kind: "found", credentials: { api_key: "sk_d" } });
  });

  it("returns no_self_serve_key when no candidate is reachable", async () => {
    const browser = new FakeBrowser(
      { url: "https://x.test/app", text: "Dashboard", inv: [el({ tag: "a", visibleText: "Dashboard", href: "/app", selector: "#d" }), el({ tag: "a", visibleText: "Billing", href: "/billing", selector: "#b" })] },
      {},
    );
    const res = await runNavSearch(browser, { extractKey: async () => null });
    expect(res).toEqual({ kind: "no_self_serve_key" });
  });

  it("uses the LLM tiebreak when the deterministic ranker can't decide", async () => {
    // Both candidates are unrankable (no keys signal in href OR text), so the
    // deterministic ranker scores nothing → needsTiebreak → the LLM picks.
    const keysPage: FakePage = { url: "https://x.test/settings/api-keys", text: "key", inv: [] };
    const browser = new FakeBrowser(
      { url: "https://x.test/app", text: "Dashboard", inv: [el({ tag: "a", visibleText: "Workspace", href: "/app/ws", selector: "#ws" }), el({ tag: "a", visibleText: "Build", href: "/app/build", selector: "#build" })] },
      { "https://x.test/app/build": keysPage },
    );
    let tiebreakCalls = 0;
    const res = await runNavSearch(browser, {
      extractKey: async () => (browser.currentUrl().includes("api-keys") ? { api_key: "sk_tb" } : null),
      tiebreak: async (cands) => {
        tiebreakCalls += 1;
        return cands.find((c) => c.href === "/app/build")?.selector ?? null;
      },
    });
    expect(res).toEqual({ kind: "found", credentials: { api_key: "sk_tb" } });
    expect(tiebreakCalls).toBeGreaterThan(0);
  });

  it("reaches keys via an avatar-menu anchor by href even though the click target is fragile (unify class)", async () => {
    // The dashboard exposes the settings nav only inside a dropdown that
    // expandLatentNav opens; the "Account" anchor is portaled. clickSelector on
    // it no-ops (the menu closes), so the loop must navigate by its href instead.
    const accountPage: FakePage = {
      url: "https://console.unify.test/account",
      text: "Account API keys",
      inv: [el({ tag: "button", visibleText: "Create API key", selector: "#mk" })],
    };
    const dashboard: FakePage = {
      url: "https://console.unify.test/assistants",
      text: "Select an assistant",
      inv: [el({ tag: "button", ariaLabel: "User Avatar", selector: "#avatar" })],
    };
    // expandLatentNav reveals the dropdown's items (Account/Billing).
    const expanded: FakePage = {
      url: "https://console.unify.test/assistants",
      text: "Account Billing Sign out",
      inv: [
        el({ tag: "button", ariaLabel: "User Avatar", selector: "#avatar" }),
        el({ tag: "a", visibleText: "Account", href: "/account", selector: "body > div:nth-of-type(2) > a:nth-of-type(1)" }),
        el({ tag: "a", visibleText: "Billing", href: "/billing", selector: "body > div:nth-of-type(2) > a:nth-of-type(2)" }),
      ],
    };
    const browser = new FakeBrowser(
      dashboard,
      // Account is reached by href-nav (NOT by its fragile selector); the
      // selector deliberately has no transition, so a clickSelector would no-op.
      { "https://console.unify.test/account": accountPage },
      expanded,
    );
    const res = await runNavSearch(browser, {
      extractKey: async () => (browser.currentUrl().includes("/account") ? { api_key: "sk_acct" } : null),
    });
    expect(res).toEqual({ kind: "found", credentials: { api_key: "sk_acct" } });
  });

  it("calls captureRound each step (capture-chain parity, A2/OF#1)", async () => {
    const keysPage: FakePage = { url: "https://x.test/settings/api-keys", text: "key", inv: [] };
    const browser = new FakeBrowser(
      { url: "https://x.test/app", text: "Dashboard", inv: [el({ tag: "a", visibleText: "API Keys", href: "/settings/api-keys", selector: "#keys" })] },
      { "https://x.test/settings/api-keys": keysPage },
    );
    const actions: string[] = [];
    await runNavSearch(browser, {
      extractKey: async () => (browser.currentUrl().includes("api-keys") ? { api_key: "sk_c" } : null),
      captureRound: async (ctx) => { actions.push(ctx.action); },
    });
    expect(actions).toContain("navigate");
    expect(actions).toContain("extract");
  });
});

describe("planOnboardingChoice", () => {
  it("picks the least-committal option on an onboarding role-picker (unify class)", () => {
    const inv = [
      el({ tag: "button", visibleText: "Just for me", selector: "#me" }),
      el({ tag: "button", visibleText: "For my team", selector: "#team" }),
    ];
    expect(planOnboardingChoice({ url: "https://console.unify.ai/login/onboarding", pageText: "How do you plan to use the platform?", inventory: inv })).toBe("#me");
  });

  it("falls back to the first choice when no minimal option matches", () => {
    const inv = [
      el({ tag: "button", visibleText: "Engineering", selector: "#eng" }),
      el({ tag: "button", visibleText: "Marketing", selector: "#mkt" }),
    ];
    expect(planOnboardingChoice({ url: "https://x/welcome", pageText: "Welcome to X", inventory: inv })).toBe("#eng");
  });

  it("returns null when the page is NOT an onboarding step (no random clicks)", () => {
    const inv = [el({ tag: "button", visibleText: "Save", selector: "#save" })];
    expect(planOnboardingChoice({ url: "https://x/app/dashboard", pageText: "Your dashboard", inventory: inv })).toBeNull();
  });
});
