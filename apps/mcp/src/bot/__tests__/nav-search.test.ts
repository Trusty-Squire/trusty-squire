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
  rankCandidates,
  scoreCandidate,
  type NavCandidate,
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
});
