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

// Deterministic relevance score toward an API-keys destination. The loose href
// tokens (settings/account/keys/tokens/developers) are trusted because an href
// is a structured path, not free text. NEG kills obvious non-destinations.
const KEYS_HREF =
  /\/(?:api[-_]?keys?|api[-_]?tokens?|access[-_]?tokens?|auth[-_]?tokens?|secret[-_]?keys?|personal[-_]?access[-_]?tokens?|developers?|settings|account|keys?|tokens?)(?:[/?#]|$)/i;
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

// A keys/settings/tokens-ish URL — the page where keys live or are created.
const KEYS_SURFACE_URL =
  /\/(?:api[-_]?keys?|api[-_]?tokens?|access[-_]?tokens?|secret[-_]?keys?|developers?|settings|account)(?:[/?#]|$)/i;

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
  if (create !== null && KEYS_SURFACE_URL.test(input.url)) {
    return { kind: "create_gated", createSelector: create.selector };
  }
  // On a keys/settings surface but no create affordance yet (key may be masked /
  // behind a reveal / already listed) → let the caller run the extractor.
  if (KEYS_SURFACE_URL.test(input.url)) {
    return { kind: "on_key_surface" };
  }
  // A create affordance off a non-key URL is still worth trying as a last move,
  // but it's not arrival — keep searching with it available to the caller.
  return { kind: "not_yet" };
}
