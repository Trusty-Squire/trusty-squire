// nav-search.ts — goal-directed search over a dashboard's affordances for the
// POST-signup "find/create the API key" phase. This is strangler-fig slice 1 of
// de-monolithing agent.ts: the enumeration, ranking, and goal classification are
// PURE functions (inventory / url / text in, decision out — no browser, no LLM),
// so they're unit-testable in isolation. The browser-driving search loop (click →
// overlay → verify → extract) is a thin orchestrator over these, added in a later
// task. Design + reviewed decisions: docs/DESIGN-post-signup-nav-search.md.
//
// Why this exists: the current greedy postVerifyLoop guesses URLs (404s) and
// flails to a 600s timeout because it has no goal definition and no map. Every
// dashboard DOES expose a finite set of navigable affordances — links AND buttons,
// some behind expandable menus. Rank them deterministically toward "API keys",
// click the real ones, stop on a concrete goal. The LLM is a bounded tiebreaker,
// not the loop driver (reviewed decision A1).

import type { InteractiveElement } from "./browser.js";
import { findCreateKeyAffordance, detectExistingAccountNoExtract } from "./agent.js";

// A clickable affordance the search can navigate through. Links AND buttons —
// the keys page is often reached by a button, not an <a href> (outside-voice #2).
export interface NavCandidate {
  selector: string;
  href: string | null;
  text: string;
  isAnchor: boolean;
  inViewport: boolean;
}

// Pull the navigable affordances out of an inventory. Pure.
export function enumerateCandidates(inventory: readonly InteractiveElement[]): NavCandidate[] {
  const out: NavCandidate[] = [];
  for (const el of inventory) {
    const clickable =
      el.tag === "a" || el.tag === "button" || el.role === "link" || el.role === "button";
    if (!clickable) continue;
    if (el.visible === false) continue;
    const text = [el.visibleText, el.ariaLabel, el.title, el.labelText, el.iconLabel]
      .filter((s): s is string => s !== null && s !== undefined && s.length > 0)
      .join(" ")
      .trim();
    const href = el.href ?? null;
    if (text.length === 0 && (href === null || href.length === 0)) continue;
    out.push({
      selector: el.selector,
      href,
      text,
      isAnchor: el.tag === "a",
      inViewport: el.inViewport === true,
    });
  }
  return out;
}

// THE key-destination URL pattern — the single source of truth used by BOTH the
// ranker (href match) and the goal verifier (am I on a key surface?). They MUST
// agree: if the ranker navigates to a URL it thinks is a key destination, the
// goal verifier has to recognize the same URL, or the loop arrives and never
// extracts. The loose tokens (settings/account/keys/tokens/developers) are
// trusted because an href/url is a structured path, not free text.
export const KEYS_DESTINATION_URL =
  /\/(?:api[-_]?keys?|api[-_]?tokens?|access[-_]?tokens?|auth[-_]?tokens?|secret[-_]?keys?|personal[-_]?access[-_]?tokens?|developers?|settings|account|keys?|tokens?)(?:[/?#]|$)/i;
const KEYS_HREF = KEYS_DESTINATION_URL;
const KEYS_TEXT_STRONG = /\b(?:api|access|secret|auth|personal\s+access)\s*(?:keys?|tokens?)\b/i;
const KEYS_TEXT_WEAK = /\b(?:developers?|settings|account)\b/i;
const NEG_TEXT =
  /\b(?:billing|invoices?|docs|documentation|pricing|log\s*out|sign\s*out|keyboard\s+shortcuts)\b/i;

export function scoreCandidate(c: NavCandidate): number {
  if (NEG_TEXT.test(c.text)) return 0;
  // Base = keys relevance. Anchor/viewport are TIEBREAKERS that only apply on a
  // relevant base — otherwise every visible link would score >0 and a plain
  // "Dashboard" link would rank as a candidate.
  let base = 0;
  if (c.href !== null && KEYS_HREF.test(c.href)) base += 4; // a real navigable path
  if (KEYS_TEXT_STRONG.test(c.text))
    base += 3; // explicit "API key(s)/token(s)"
  else if (KEYS_TEXT_WEAK.test(c.text)) base += 1; // settings/account/developers
  if (base === 0) return 0; // no keys relevance → not a candidate
  let s = base;
  if (c.isAnchor) s += 1; // prefer real anchors over role=button
  if (c.inViewport) s += 1;
  return s;
}

export interface RankResult {
  // Candidates with score > 0, descending. Empty when nothing looked relevant.
  ranked: NavCandidate[];
  // True when the deterministic ranker can't decide: nothing scored, OR the top
  // two tie. The caller (search loop) then asks the LLM to break the tie — the
  // ONLY place the LLM touches the hot loop (reviewed decision A1).
  needsTiebreak: boolean;
}

export function rankCandidates(candidates: readonly NavCandidate[]): RankResult {
  const scored = candidates
    .map((c) => ({ c, s: scoreCandidate(c) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);
  const ranked = scored.map((x) => x.c);
  const needsTiebreak =
    ranked.length === 0 || (scored.length >= 2 && scored[0]!.s === scored[1]!.s);
  return { ranked, needsTiebreak };
}

// Goal assessment for the current page. PURE over the page signals. Distinguishes
// "we've ARRIVED at a key surface" from "this is the START of a gated create flow"
// (a 'Create API key' button is a subgoal, not arrival — outside-voice #3) from
// "not there yet, keep searching".
export type GoalAssessment =
  | { kind: "create_gated"; createSelector: string } // a create-key affordance → click it (subgoal)
  | { kind: "on_key_surface" } // looks like the keys page → caller runs the real extractor
  | { kind: "not_yet" };

export function assessKeyGoal(input: {
  url: string;
  pageText: string;
  inventory: readonly InteractiveElement[];
}): GoalAssessment {
  // An existing-key listing with no re-reveal (e.g. Neon) IS arrival — the caller
  // extracts/handles it. Strongest signal first.
  if (
    detectExistingAccountNoExtract({
      url: input.url,
      pageText: input.pageText,
      lastPlannerReason: "",
    })
  ) {
    return { kind: "on_key_surface" };
  }
  // A create-key affordance → this is the create-flow start, a subgoal. Only
  // treat it as the goal-action when we're plausibly on a key surface (avoids
  // a stray "create" button elsewhere hijacking the search).
  const create = findCreateKeyAffordance(input.inventory);
  if (create !== null && KEYS_DESTINATION_URL.test(input.url)) {
    return { kind: "create_gated", createSelector: create.selector };
  }
  // On a keys/settings surface but no create affordance yet (key may be masked /
  // behind a reveal / already listed) → let the caller run the extractor.
  if (KEYS_DESTINATION_URL.test(input.url)) {
    return { kind: "on_key_surface" };
  }
  // A create affordance off a non-key URL is still worth trying as a last move,
  // but it's not arrival — keep searching with it available to the caller.
  return { kind: "not_yet" };
}

// ── overlay / wizard handling (T3) ───────────────────────────────────────────
// Onboarding wizards and modals are a RECURRING obstacle (imagekit role-select,
// unify "Hire Assistant", "name your project") — each currently re-improvised and
// trapped the bot. One mechanism: when blocked, DISMISS the overlay (skip/close)
// or, failing that, ADVANCE the wizard (Next/Continue). Pure detection here; the
// click (and an Escape-key fallback) is the loop's browser action.

// Generalizes the inline WIZARD_FORWARD (agent.ts:10413). A forward control that
// advances a multi-step onboarding wizard.
const WIZARD_ADVANCE =
  /^\s*(?:next|continue|submit|finish|done|get\s+started|let'?s\s+go|proceed)\s*$/i;
// A control that skips/closes an onboarding step or modal entirely — preferred
// over advancing, since skipping gets us to the dashboard fastest.
const OVERLAY_DISMISS =
  /\b(?:skip(?:\s+for\s+now)?|dismiss|not\s+now|maybe\s+later|no\s+thanks?|close|×|✕|✖)\b/i;

function isClickable(el: InteractiveElement): boolean {
  return (
    (el.tag === "button" || el.tag === "a" || el.role === "button" || el.role === "link") &&
    el.visible !== false
  );
}

function elText(el: InteractiveElement): string {
  return [el.visibleText, el.ariaLabel, el.title, el.labelText, el.iconLabel]
    .filter((s): s is string => s !== null && s !== undefined && s.length > 0)
    .join(" ")
    .trim();
}

// Find a skip/close affordance for a blocking onboarding step or modal. Pure.
export function findOverlayDismiss(
  inventory: readonly InteractiveElement[],
): InteractiveElement | null {
  for (const el of inventory) {
    if (!isClickable(el)) continue;
    const t = elText(el);
    if (t.length === 0) continue;
    // Long text that merely CONTAINS "close" (e.g. "Close your first deal") is
    // not a dismiss control — require the control to be short/affordance-shaped.
    if (t.length > 24) continue;
    if (OVERLAY_DISMISS.test(t)) return el;
  }
  return null;
}

// Find a Next/Continue-style control that advances a wizard. Pure. Matches on
// the WHOLE label (anchored) so a "Continue with Google" OAuth button or a
// "Submit feedback" doesn't trip it.
export function findWizardAdvance(
  inventory: readonly InteractiveElement[],
): InteractiveElement | null {
  for (const el of inventory) {
    if (!isClickable(el)) continue;
    if (WIZARD_ADVANCE.test(elText(el))) return el;
  }
  return null;
}

export type OverlayStep =
  | { kind: "dismiss"; selector: string }
  | { kind: "advance"; selector: string }
  | { kind: "none" };

// ── the search loop (T4) ─────────────────────────────────────────────────────
// Drives the browser through the dashboard using the pure primitives above:
// each step — settle → clear any blocking overlay → check the goal → else
// expand latent nav, rank candidates, click the best untried one. Bounded by a
// tried-set (keyed by affordance SELECTOR, not URL — SPA re-renders make URL
// keys unstable, outside-voice #4) and a step cap. Frontier exhaustion is an
// HONEST `no_self_serve_key`, not a 600s timeout.
//
// The browser is a narrow port (only the methods the loop needs) so the loop is
// unit-testable with a fake. The real wiring (T5) adapts BrowserController +
// the existing extractor/capture to this port behind the NAV_SEARCH flag.

export interface NavSearchBrowserPort {
  currentUrl(): string;
  extractText(): Promise<string>;
  extractInventory(): Promise<InteractiveElement[]>;
  clickSelector(selector: string): Promise<void>;
  pressEscape(): Promise<void>;
  settle(): Promise<void>; // bounded readiness wait (waitForInteractiveDom)
  expandLatentNav(): Promise<void>; // open hamburger/avatar/settings so hidden nav mounts
}

export interface NavSearchDeps {
  // Returns extracted credentials if the current page yields a key (handles
  // reveal/copy internally), else null. The goal verifier of last resort.
  extractKey(): Promise<Record<string, string> | null>;
  // Capture-chain parity hook (A2 / OF#1): called once per step so auto-promote
  // still sees the round chain it depends on. Best-effort; never throws.
  captureRound?: (ctx: { url: string; inventory: readonly InteractiveElement[]; action: string }) => Promise<void>;
  // LLM tiebreaker: pick a selector from candidates when the deterministic
  // ranker can't decide (needsTiebreak). The ONLY place the LLM touches the loop.
  tiebreak?: (candidates: readonly NavCandidate[]) => Promise<string | null>;
  maxSteps?: number;
  log?: (line: string) => void;
}

export type NavSearchResult =
  | { kind: "found"; credentials: Record<string, string> }
  | { kind: "no_self_serve_key" }; // frontier exhausted or step cap with no key

export async function runNavSearch(
  browser: NavSearchBrowserPort,
  deps: NavSearchDeps,
): Promise<NavSearchResult> {
  const maxSteps = deps.maxSteps ?? 12;
  const log = deps.log ?? (() => {});
  const tried = new Set<string>(); // affordance selectors already clicked
  const overlayTried = new Set<string>(); // overlay controls already actioned

  const capture = async (action: string, inv: readonly InteractiveElement[]): Promise<void> => {
    if (deps.captureRound === undefined) return;
    try {
      await deps.captureRound({ url: browser.currentUrl(), inventory: inv, action });
    } catch {
      // capture is best-effort — never fail the search
    }
  };

  for (let step = 0; step < maxSteps; step++) {
    await browser.settle();
    let inv = await browser.extractInventory();

    // 1) Clear a blocking onboarding overlay / modal before anything else.
    const overlay = planOverlayStep(inv);
    if (overlay.kind !== "none" && !overlayTried.has(overlay.selector)) {
      overlayTried.add(overlay.selector);
      log(`nav-search: overlay ${overlay.kind} → ${overlay.selector}`);
      await capture(`overlay_${overlay.kind}`, inv);
      try {
        await browser.clickSelector(overlay.selector);
      } catch {
        await browser.pressEscape().catch(() => {}); // modal with no in-DOM close
      }
      continue;
    }

    // 2) Goal check. Try extraction whenever we're plausibly on a key surface
    //    (on_key_surface OR create_gated — both imply we're at the keys page,
    //    and after a create-click the key may now be present). Extraction-first
    //    so a freshly-created key isn't missed because the create button persists.
    const url = browser.currentUrl();
    const text = await browser.extractText().catch(() => "");
    const goal = assessKeyGoal({ url, pageText: text, inventory: inv });
    if (goal.kind === "on_key_surface" || goal.kind === "create_gated") {
      const creds = await deps.extractKey().catch(() => null);
      if (creds !== null && Object.keys(creds).length > 0) {
        log(`nav-search: key extracted on ${url}`);
        await capture("extract", inv);
        return { kind: "found", credentials: creds };
      }
    }
    // 2b) No key yet, but a create affordance is available and untried → use it.
    if (goal.kind === "create_gated" && !tried.has(goal.createSelector)) {
      tried.add(goal.createSelector);
      log(`nav-search: create-key subgoal → ${goal.createSelector}`);
      await capture("create_key", inv);
      await browser.clickSelector(goal.createSelector).catch(() => {});
      continue;
    }

    // 3) Move: expand latent nav, re-read, rank candidates, click the best
    //    unsearched one (LLM tiebreak only when the deterministic ranker can't).
    await browser.expandLatentNav().catch(() => {});
    inv = await browser.extractInventory();
    const candidates = enumerateCandidates(inv).filter((c) => !tried.has(c.selector));
    const rank = rankCandidates(candidates);
    let pick: string | null = rank.ranked[0]?.selector ?? null;
    if (pick === null && rank.needsTiebreak && deps.tiebreak !== undefined && candidates.length > 0) {
      pick = await deps.tiebreak(candidates).catch(() => null);
      if (pick !== null && tried.has(pick)) pick = null;
    }
    if (pick === null) {
      log("nav-search: candidates exhausted — no self-serve key surface reachable");
      return { kind: "no_self_serve_key" };
    }
    tried.add(pick);
    log(`nav-search: → ${pick}`);
    await capture("navigate", inv);
    await browser.clickSelector(pick).catch(() => {});
  }

  log(`nav-search: step cap (${maxSteps}) reached without a key`);
  return { kind: "no_self_serve_key" };
}

// Plan one step to get past a blocking overlay/wizard: prefer dismissing
// (skip/close — exits the wizard) over advancing (only when there's no skip).
// Pure; the caller clicks the selector (with an Escape-key fallback for modals
// that expose no in-DOM close control).
export function planOverlayStep(inventory: readonly InteractiveElement[]): OverlayStep {
  const dismiss = findOverlayDismiss(inventory);
  if (dismiss !== null) return { kind: "dismiss", selector: dismiss.selector };
  const advance = findWizardAdvance(inventory);
  if (advance !== null) return { kind: "advance", selector: advance.selector };
  return { kind: "none" };
}
