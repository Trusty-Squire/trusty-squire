// Eval: compact observation payload must be INFORMATION-EQUIVALENT to full for
// every planner-relevant field, so flipping BOT_OBSERVE_COMPACT can't cause a
// "confident wrong click" (Hypatia's concern in the design review).
//
// This is the sufficient-condition eval: it proves no perception/disambiguation
// data a planner relies on is lost. (Whether the LLM is *comfortable* with the
// compact shape is a format/prompt question for a live smoke once published —
// not a missing-data question, which is what this guards.)
//
// Three properties, asserted through the REAL toCompactElement over a corpus of
// hard cases (repeated buttons, modal overlays, icon-only, signup error states,
// checkbox states):
//   P1 coverage      — every element's ref survives, 1:1, no element dropped.
//   P2 load-bearing  — occluded_by / topmost-false / href / testId / checked /
//                      path / value-presence are preserved.
//   P3 no-ambiguity  — two elements that collapse to the same compact shape were
//                      already identical on every planner field in full mode
//                      (i.e. dropping `container` and raw `value` never becomes
//                      the SOLE distinguisher between two targets).

import { describe, it, expect } from "vitest";
import type { InteractiveElement } from "../browser.js";
import { toCompactElement, elementRef } from "../provision-session.js";

function el(over: Partial<InteractiveElement>): InteractiveElement {
  return {
    index: 0, tag: "button", type: null, id: null, name: null, placeholder: null,
    ariaLabel: null, role: null, labelText: null, visibleText: null, selector: "x",
    visible: true, inViewport: true, inConsentWidget: false, ...over,
  };
}

const NONE = new Set<string>();

// Planner-relevant identity of a SOURCE element, including the fields compact
// alters (container + raw value) — the baseline "what full mode can distinguish".
function fullKey(e: InteractiveElement): string {
  return JSON.stringify([
    elementRef(e), e.tag, e.role, e.type, e.href ?? null, e.screenPath ?? null,
    e.container ?? null, e.checked ?? null, e.topmost ?? null, e.occludedBy ?? null,
    e.value ?? null,
  ]);
}
// Identity derivable from the COMPACT element (no ref).
function compactKey(c: ReturnType<typeof toCompactElement>): string {
  return JSON.stringify([
    c.label, c.tag, c.role ?? null, c.type ?? null, c.href ?? null, c.path ?? null,
    "checked" in c ? c.checked : null, "topmost" in c ? c.topmost : null,
    c.occluded_by ?? null, c.value_len ?? 0,
  ]);
}

function evalSet(name: string, els: InteractiveElement[]): void {
  const compact = els.map((e, i) => toCompactElement(e, `@g1:r${i}`, NONE));

  // P1 — coverage: 1:1, refs preserved, none dropped.
  expect(compact.length).toBe(els.length);
  expect(compact.map((c) => c.ref)).toEqual(els.map((_, i) => `@g1:r${i}`));

  // P2 — load-bearing fields preserved.
  els.forEach((e, i) => {
    const c = compact[i]!;
    if (e.occludedBy) expect(c.occluded_by).toBe(e.occludedBy);
    if (e.topmost === false) expect(c.topmost).toBe(false);
    if (e.href) expect(c.href).toBe(e.href);
    if (e.testId) expect(c.testId).toBe(e.testId);
    if (e.checked !== null && e.checked !== undefined) expect(c.checked).toBe(e.checked);
    if (e.screenPath) expect(c.path).toBe(e.screenPath);
    if (e.value) expect(c.value_len).toBe(e.value.length);
    // never the raw value
    const bag = c as unknown as Record<string, unknown>;
    expect(bag.value).toBeUndefined();
    if (e.container) expect(bag.container).toBeUndefined();
  });

  // P3 — no new ambiguity: each compactKey maps to exactly one fullKey.
  const merged = new Map<string, Set<string>>();
  compact.forEach((c, i) => {
    const ck = compactKey(c);
    if (!merged.has(ck)) merged.set(ck, new Set());
    merged.get(ck)!.add(fullKey(els[i]!));
  });
  const collisions = [...merged.entries()].filter(([, fulls]) => fulls.size > 1);
  expect(collisions, `${name}: compaction merged distinguishable elements`).toEqual([]);
}

describe("observe-compact eval — information equivalence on hard cases", () => {
  it("repeated buttons disambiguate by path (GCP-style 'Show key' rows)", () => {
    evalSet("repeated-show-key", [
      el({ tag: "button", visibleText: "Show key", screenPath: "row:browser-key > button:show-key", container: "row:browser-key" }),
      el({ tag: "button", visibleText: "Show key", screenPath: "row:server-key > button:show-key", container: "row:server-key" }),
      el({ tag: "button", visibleText: "More options", screenPath: "row:browser-key > button:more", container: "row:browser-key" }),
      el({ tag: "button", visibleText: "More options", screenPath: "row:server-key > button:more", container: "row:server-key" }),
    ]);
  });

  it("link vs button with the same label disambiguate by tag+href (OpenRouter nav 'Models')", () => {
    evalSet("nav-models", [
      el({ tag: "a", role: "link", visibleText: "Models", href: "/models", screenPath: "nav:top > link:models", container: "nav:top" }),
      el({ tag: "button", visibleText: "Models", screenPath: "nav:top > button:models", container: "nav:top" }),
    ]);
  });

  it("modal overlay: background duplicate distinguished by occluded_by/topmost", () => {
    evalSet("modal-overlay", [
      el({ tag: "button", visibleText: "Continue", topmost: true, screenPath: "dialog:add-key > button:continue", container: "dialog:add-key" }),
      el({ tag: "button", visibleText: "Continue", topmost: false, occludedBy: "dialog:add-key", screenPath: "form:signup > button:continue", container: "form:signup" }),
    ]);
  });

  it("icon-only controls keep their derived label + testId", () => {
    evalSet("icon-only", [
      el({ tag: "button", visibleText: null, ariaLabel: "Copy key", testId: "copy-key", screenPath: "dialog:key > button:copy", container: "dialog:key" }),
      el({ tag: "button", visibleText: null, iconLabel: "Sign in with Google", screenPath: "main:signin > button:google", container: "main:signin" }),
    ]);
  });

  it("signup error state: error region + the email field it refers to stay distinct", () => {
    evalSet("signup-error", [
      el({ tag: "div", role: "alert", visibleText: "Sorry, we don't allow public domains", screenPath: "form:signup > alert:email-error", container: "form:signup" }),
      el({ tag: "input", type: "email", value: "user@gmail.com", screenPath: "form:signup > input:work-email", container: "form:signup" }),
      el({ tag: "input", type: "text", value: "Acme", screenPath: "form:signup > input:org", container: "form:signup" }),
    ]);
  });

  it("checkbox states (true/false) survive for real checkables", () => {
    evalSet("checkboxes", [
      el({ tag: "input", type: "checkbox", checked: false, visibleText: "I agree to the Terms", screenPath: "form:signup > checkbox:tos", container: "form:signup" }),
      el({ tag: "input", type: "checkbox", checked: true, visibleText: "Subscribe", screenPath: "form:signup > checkbox:news", container: "form:signup" }),
    ]);
  });
});
