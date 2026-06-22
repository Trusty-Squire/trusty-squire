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

// Resolve a candidate's href to an absolute URL worth navigating to, or null
// when it isn't a real destination (empty, "#", javascript:, mailto:, or a bare
// fragment). Relative paths resolve against the current page URL. Pure.
export function resolveNavHref(href: string | null, currentUrl: string): string | null {
  if (href === null) return null;
  const h = href.trim();
  if (h.length === 0 || h === "#" || h.startsWith("#")) return null;
  if (/^(?:javascript:|mailto:|tel:)/i.test(h)) return null;
  try {
    const abs = new URL(h, currentUrl);
    if (abs.protocol !== "http:" && abs.protocol !== "https:") return null;
    // A link that points back to exactly where we are is not progress.
    if (abs.href === currentUrl) return null;
    return abs.href;
  } catch {
    return null;
  }
}

// True if `href` resolves to a DIFFERENT registrable domain than the page we're
// on — i.e. it would navigate off the authenticated app (e.g. console.neon.tech
// → neon.com/docs). The key hunt must stay inside the app; a marketing/docs link
// is a dead end that also burns the step budget and drops the session. Buttons
// and same-site/relative links are NOT off-site. Registrable domain = last two
// labels (good enough for these dev-tool hosts; no PSL dependency). Pure.
export function isOffSiteHref(currentUrl: string, href: string | null): boolean {
  const abs = resolveNavHref(href, currentUrl);
  if (abs === null) return false; // relative/self/non-navigable → never off-site
  try {
    const reg = (h: string): string => h.split(".").slice(-2).join(".");
    return reg(new URL(abs).hostname) !== reg(new URL(currentUrl).hostname);
  } catch {
    return true; // unparseable target → treat as off-site (don't follow)
  }
}

const CREDENTIAL_SEARCH_DEAD_END_PATH =
  /\/(?:(?:docs?|documentation|blog|support|pricing|legal|terms|privacy|contact|customers?)|auth\/(?:login|join|signup|sign-up|register|forgot-password|reset-password))(?:[/?#]|$)/i;

export function isCredentialSearchDeadEndHref(
  currentUrl: string,
  href: string | null,
): boolean {
  const abs = resolveNavHref(href, currentUrl);
  if (abs === null) return false;
  try {
    const url = new URL(abs);
    return CREDENTIAL_SEARCH_DEAD_END_PATH.test(url.pathname);
  } catch {
    return true;
  }
}

// Union two inventory snapshots, deduped by selector (first wins). Used to
// survive expandLatentNav's destructive menu-toggling: an affordance present
// in EITHER the pre- or post-expand read is kept, so an already-open dropdown
// that the toggle later closes still contributes its items. Pure.
export function mergeInventories(
  a: readonly InteractiveElement[],
  b: readonly InteractiveElement[],
): InteractiveElement[] {
  const bySelector = new Map<string, InteractiveElement>();
  for (const el of [...a, ...b]) {
    if (!bySelector.has(el.selector)) bySelector.set(el.selector, el);
  }
  return [...bySelector.values()];
}

// Destructive / irreversible actions nav-search must NEVER auto-click — neither
// by deterministic rank nor by LLM tiebreak. The search clicks affordances
// unattended chasing a key; a positional/portaled mis-click on one of these
// could delete the account or revoke a credential. Excluded at enumeration so
// no downstream path can ever reach them. (Observed: the LLM tiebreak once
// picked "Delete Account" on a settings page that had no keys.)
const DESTRUCTIVE_TEXT =
  /\b(?:delete|remove|deactivate|destroy|revoke|cancel\s+(?:account|subscription|plan)|close\s+account|wipe|reset\s+account|leave\s+(?:team|organization|org))\b/i;

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
    if (DESTRUCTIVE_TEXT.test(text)) continue; // never auto-click a destructive control
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
// extracts. Keep generic `/settings` and `/account` as container routes only:
// nested settings pages must carry a credential-shaped path segment. Otherwise
// tabbed settings apps such as Ona make `/settings/profile`, `/settings/secrets`,
// and `/settings/agent-policies` look like credential destinations and the loop
// wanders away from the real `/settings/personal-access-tokens` page.
export const KEYS_DESTINATION_URL =
  /(?:\/(?:api(?:[-_]?keys?|[-_]?tokens?)?|access[-_]?tokens?|auth[-_]?tokens?|authorization|secret[-_]?keys?|personal[-_]?access[-_]?tokens?|developers?|keys?|tokens?)(?:[/?#]|$)|\/(?:settings|account)(?:[?#]|\/?$)|[?#][^\s]*(?:api[-_]?keys?|api[-_]?tokens?|access[-_]?tokens?|auth[-_]?tokens?|personal[-_]?access[-_]?tokens?|keys?|tokens?))/i;
const KEYS_HREF = KEYS_DESTINATION_URL;
const KEYS_TEXT_STRONG = /\b(?:api|access|secret|auth|personal\s+access)\s*(?:keys?|tokens?)\b/i;
const KEYS_TEXT_WEAK = /\b(?:developers?|settings|account)\b/i;
const NEG_TEXT =
  /\b(?:billing|invoices?|docs|documentation|pricing|log\s*out|sign\s*out|keyboard\s+shortcuts)\b/i;
const TOKEN_CONTEXT_TEXT =
  /\b(?:api|access|auth|personal\s+access|secret|bearer)\s*(?:keys?|tokens?)\b/i;
const OBVIOUS_TOKEN_VALUE =
  /\b(?:sk|pk|rk|ghp|github_pat|pat|flyv1)[a-z0-9_./+=:-]{8,}\b/i;
const LONG_HEX_VALUE = /\b[a-f0-9]{12,}\b/i;

export function hasVisibleCredentialSignal(pageText: string): boolean {
  if (OBVIOUS_TOKEN_VALUE.test(pageText)) return true;
  return TOKEN_CONTEXT_TEXT.test(pageText) && LONG_HEX_VALUE.test(pageText);
}

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

function navUrlKey(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.href;
  } catch {
    return url;
  }
}

function candidateUrlKey(candidate: NavCandidate, currentUrl: string): string | null {
  const target = resolveNavHref(candidate.href, currentUrl);
  return target === null ? null : navUrlKey(target);
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
  const credentialSurface =
    KEYS_DESTINATION_URL.test(input.url) || TOKEN_CONTEXT_TEXT.test(input.pageText);
  // A create-key affordance on a key surface → mint a fresh key. This is checked
  // BEFORE the existing-account-no-extract heuristic below, and deliberately so:
  // an EMPTY keys table still renders its column headers ("Key name" / "Created" /
  // "Last used"), which that heuristic mistakes for an existing masked listing
  // (groq's /keys on a virgin account) — and then extraction finds nothing and the
  // loop wanders off-surface. When a "Create API Key" button is right there,
  // minting is unambiguously the move: it yields a fresh extractable key whether
  // the account is virgin OR has masked existing keys. A stray "create" button
  // elsewhere can't hijack the search — we gate on being on a key surface.
  const create = findCreateKeyAffordance(input.inventory);
  if (create !== null && credentialSurface) {
    return { kind: "create_gated", createSelector: create.selector };
  }
  // No create affordance, but an existing-key listing with no re-reveal (e.g.
  // Neon) IS arrival — the caller extracts/handles whatever is shown.
  if (
    detectExistingAccountNoExtract({
      url: input.url,
      pageText: input.pageText,
      lastPlannerReason: "",
    })
  ) {
    return { kind: "on_key_surface" };
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

// On an onboarding CHOICE step (a role/usage picker that gates progress — no
// nav, no skip, no Next: unify's "Just for me / For my team", imagekit's role
// select), "satisfy the minimal step": pick the LEAST-committal option so the
// flow advances toward the dashboard. Returns the selector, or null when this
// isn't a recognizable choice step (so the caller doesn't click random buttons).
const ONBOARDING_CONTEXT =
  /\b(?:how (?:do|will) you (?:plan to )?use|get started|welcome to|set\s*up your|tell us about|what brings you|choose your|select (?:your )?(?:a )?role|how do you describe)\b/i;
const MINIMAL_CHOICE =
  /\b(?:just for me|personal|individual|myself|solo|skip|i'?m an individual|for myself)\b/i;

export function planOnboardingChoice(input: {
  url: string;
  pageText: string;
  inventory: readonly InteractiveElement[];
}): string | null {
  const onboardingish =
    /\/(?:onboarding|welcome|setup|get-started)\b/i.test(input.url) ||
    ONBOARDING_CONTEXT.test(input.pageText);
  if (!onboardingish) return null;
  const choices = input.inventory.filter(
    (el) =>
      (el.tag === "button" || el.role === "button") &&
      el.visible !== false &&
      (el.visibleText ?? el.ariaLabel ?? "").trim().length > 0,
  );
  if (choices.length === 0) return null;
  const text = (el: InteractiveElement): string => (el.visibleText ?? el.ariaLabel ?? "").trim();
  const minimal = choices.find((el) => MINIMAL_CHOICE.test(text(el)));
  return (minimal ?? choices[0])!.selector;
}

export function isRequiredAccountSetupForm(
  inventory: readonly InteractiveElement[],
): boolean {
  const fieldText = (el: InteractiveElement): string =>
    [el.labelText, el.ariaLabel, el.placeholder, el.name, el.id, el.visibleText]
      .filter((s): s is string => s !== null && s !== undefined)
      .join(" ");

  const hasSetupNameInput = inventory.some((el) => {
    if (el.tag !== "input" || el.visible === false) return false;
    return /\b(?:organization|organisation|workspace|company|team|project)\s+name\b/i.test(
      fieldText(el),
    );
  });
  const hasCreateButton = inventory.some((el) => {
    if (!isClickable(el)) return false;
    return /\bcreate\s+(?:org|organization|organisation|workspace|team|project)\b/i.test(
      elText(el),
    );
  });
  if (hasSetupNameInput && hasCreateButton) return true;

  const visibleTextInputs = inventory.filter(
    (el) => el.tag === "input" && el.visible !== false && (el.type === null || el.type === "text"),
  );
  const hasUsername = visibleTextInputs.some((el) =>
    /\b(?:choose\s+)?user\s*name\b/i.test(fieldText(el)) ||
    /\b(?:choose\s+)?handle\b/i.test(fieldText(el)),
  );
  const hasFullName = visibleTextInputs.some((el) => /\bfull\s+name\b/i.test(fieldText(el)));
  const hasForwardButton = inventory.some((el) => {
    if (!isClickable(el)) return false;
    return /^\s*(?:next|continue|finish|done|get\s+started)\s*$/i.test(elText(el));
  });
  // Some onboarding flows (Val Town) require only a handle/username before
  // Continue. Treat that as a setup form too; otherwise the generic overlay
  // advance clicks Continue before the planner gets a chance to fill the field.
  return hasUsername && hasForwardButton && (hasFullName || visibleTextInputs.length === 1);
}

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
  // Direct navigation to a known URL. Preferred over clickSelector for anchor
  // candidates that carry a concrete href: a menu item inside a portaled/animated
  // dropdown (Radix popover, avatar menu) is a fragile click target — the popover
  // can close between read and click, so the click hits nothing and the URL never
  // changes. The href is the destination; go there directly.
  navigate(url: string): Promise<void>;
  pressEscape(): Promise<void>;
  settle(): Promise<void>; // bounded readiness wait (waitForInteractiveDom)
  expandLatentNav(): Promise<void>; // open hamburger/avatar/settings so hidden nav mounts
}

export interface NavSearchDeps {
  // Returns extracted credentials if the current page yields a key (handles
  // reveal/copy internally), else null. The goal verifier of last resort.
  extractKey(): Promise<Record<string, string> | null>;
  // Mint a fresh key on the CURRENT key surface: click the create affordance,
  // drive any "name + confirm" modal, poll for the server-rendered value, and
  // harvest it (revealing a masked-on-first-show value if needed). Returns the
  // credentials or null. Optional — when absent (unit tests with a fake port),
  // the create_gated branch falls back to a bare create-click + continue.
  mintKey?(): Promise<Record<string, string> | null>;
  // Capture-chain parity hook (A2 / OF#1): called once per step so auto-promote
  // still sees the round chain it depends on. `selector` is the affordance the
  // step acts on (so the synthesizer learns the real click target); absent on
  // the extract step. Best-effort; never throws.
  captureRound?: (ctx: {
    url: string;
    inventory: readonly InteractiveElement[];
    action: "navigate" | "create_key" | "overlay_dismiss" | "overlay_advance" | "extract";
    selector?: string;
  }) => Promise<void>;
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
  const sterileKeyUrls = new Set<string>(); // key-looking pages that yielded no progress
  let lastContainerUrl: string | null = null;

  const capture = async (
    action: "navigate" | "create_key" | "overlay_dismiss" | "overlay_advance" | "extract",
    inv: readonly InteractiveElement[],
    selector?: string,
  ): Promise<void> => {
    if (deps.captureRound === undefined) return;
    try {
      await deps.captureRound({
        url: browser.currentUrl(),
        inventory: inv,
        action,
        ...(selector !== undefined ? { selector } : {}),
      });
    } catch {
      // capture is best-effort — never fail the search
    }
  };

  for (let step = 0; step < maxSteps; step++) {
    await browser.settle();
    let inv = await browser.extractInventory();

    // Per-step diagnostic so a failed run is debuggable from the step trail
    // alone (URL + element count + goal verdict + text snippet) — mirrors the
    // greedy loop's "Inventory diagnostic" line. Without it an exhaustion is
    // a black box: we can't see what page each click landed on.
    {
      const durl = browser.currentUrl();
      const dtext = (await browser.extractText().catch(() => "")).replace(/\s+/g, " ").trim();
      const dgoal = assessKeyGoal({ url: durl, pageText: dtext, inventory: inv });
      log(
        `nav-search: step ${step} url=${durl} elements=${inv.length} goal=${dgoal.kind} ` +
          `text="${dtext.slice(0, 160)}"`,
      );
    }

    if (isRequiredAccountSetupForm(inv)) {
      log("nav-search: required account/workspace setup form detected — handing off to planner");
      return { kind: "no_self_serve_key" };
    }

    // 1) Goal check BEFORE overlay dismissal. Some apps render the credential
    // surface itself as a settings drawer/query panel (Ona:
    // ?user-settings=personal-access-tokens). The generic overlay dismissor sees
    // that drawer's close button and would close the key surface before we try
    // extraction/create. If the URL already says "credential surface", honor it
    // first; only dismiss overlays when we are not at the target.
    const url = browser.currentUrl();
    const text = await browser.extractText().catch(() => "");
    const goal = assessKeyGoal({ url, pageText: text, inventory: inv });
    if (!KEYS_DESTINATION_URL.test(url)) {
      lastContainerUrl = url;
    }
    if (goal.kind === "on_key_surface" || goal.kind === "create_gated") {
      const creds = await deps.extractKey().catch(() => null);
      if (creds !== null && Object.keys(creds).length > 0) {
        log(`nav-search: key extracted on ${url}`);
        await capture("extract", inv);
        return { kind: "found", credentials: creds };
      }
    }
    if (goal.kind === "create_gated" && !tried.has(goal.createSelector)) {
      tried.add(goal.createSelector);
      log(`nav-search: create-key subgoal → ${goal.createSelector}`);
      await capture("create_key", inv, goal.createSelector);
      if (deps.mintKey !== undefined) {
        const minted = await deps.mintKey().catch(() => null);
        if (minted !== null && Object.keys(minted).length > 0) {
          log(`nav-search: minted key on ${url}`);
          await capture("extract", inv);
          return { kind: "found", credentials: minted };
        }
        continue;
      }
      await browser.clickSelector(goal.createSelector).catch(() => {});
      continue;
    }

    // 2) Satisfy a required onboarding choice before generic overlay dismissal.
    // Runpod renders the API-key settings page behind a first-run modal with
    // choices like "Personal or hobby projects"; clicking Skip leaves the modal
    // re-presented, while selecting the least-committal option enables Continue
    // and clears the blocker. Handle that before the broad skip/close heuristic.
    const onboardingChoice = planOnboardingChoice({ url, pageText: text, inventory: inv });
    if (onboardingChoice !== null && !tried.has(onboardingChoice)) {
      tried.add(onboardingChoice);
      log(`nav-search: onboarding choice → ${onboardingChoice}`);
      await capture("overlay_advance", inv, onboardingChoice);
      await browser.clickSelector(onboardingChoice).catch(() => {});
      continue;
    }

    // 2) Clear a blocking onboarding overlay / modal before searching nav.
    const overlay = planOverlayStep(inv);
    if (overlay.kind !== "none" && !overlayTried.has(overlay.selector)) {
      overlayTried.add(overlay.selector);
      log(`nav-search: overlay ${overlay.kind} → ${overlay.selector}`);
      await capture(overlay.kind === "dismiss" ? "overlay_dismiss" : "overlay_advance", inv, overlay.selector);
      try {
      await browser.clickSelector(overlay.selector);
      } catch {
        await browser.pressEscape().catch(() => {}); // modal with no in-DOM close
      }
      continue;
    }

    // 3) Move: expand latent nav, then rank candidates from the UNION of the
    //    pre-expand and post-expand inventories. expandLatentNav toggles
    //    aria-haspopup menus blindly — if a menu (e.g. the user-avatar dropdown
    //    holding Account/Settings/Billing) was ALREADY open, the toggle closes
    //    it and a post-expand-only read loses exactly the keys-bearing nav. The
    //    union keeps an already-open menu's items AND adds a newly-opened one's.
    const invBefore = inv;
    await browser.expandLatentNav().catch(() => {});
    const invAfter = await browser.extractInventory();
    const mergedInv = mergeInventories(invBefore, invAfter);
    inv = mergedInv;
    // Drop already-tried AND off-site anchors: the key always lives inside the
    // authenticated app, never on its marketing/docs domain.
    const candidates = enumerateCandidates(mergedInv).filter(
      (c) =>
        !tried.has(c.selector) &&
        !isOffSiteHref(url, c.href) &&
        !isCredentialSearchDeadEndHref(url, c.href) &&
        !(
          candidateUrlKey(c, url) !== null &&
          sterileKeyUrls.has(candidateUrlKey(c, url)!)
        ),
    );
    const rank = rankCandidates(candidates);
    let pick: string | null = rank.ranked[0]?.selector ?? null;
    if (pick === null && rank.needsTiebreak && deps.tiebreak !== undefined && candidates.length > 0) {
      pick = await deps.tiebreak(candidates).catch(() => null);
      if (pick !== null && tried.has(pick)) pick = null;
    }
    if (pick === null) {
      if (
        KEYS_DESTINATION_URL.test(url) &&
        lastContainerUrl !== null &&
        navUrlKey(lastContainerUrl) !== navUrlKey(url) &&
        !sterileKeyUrls.has(navUrlKey(url)) &&
        !hasVisibleCredentialSignal(text)
      ) {
        sterileKeyUrls.add(navUrlKey(url));
        log(
          `nav-search: sterile key surface ${url} — no credential/create progress; ` +
            `returning to ${lastContainerUrl} to try an alternate path`,
        );
        await browser.navigate(lastContainerUrl).catch(() => {});
        continue;
      }
      // No rankable nav — but a gating onboarding CHOICE step (role/usage
      // picker) blocks the dashboard. Satisfy the minimal step to advance.
      const choice = planOnboardingChoice({ url, pageText: text, inventory: inv });
      if (choice !== null && !tried.has(choice)) {
        tried.add(choice);
        log(`nav-search: onboarding choice → ${choice}`);
        await capture("overlay_advance", inv, choice);
        await browser.clickSelector(choice).catch(() => {});
        continue;
      }
      // Dump what WAS on the page (text + href + selector) so an exhaustion is
      // diagnosable: did the keys nav exist but score 0, or was it genuinely
      // absent (behind a menu/icon we didn't expand)?
      const seen = enumerateCandidates(inv).map(
        (c) => `[${c.isAnchor ? "a" : "btn"}] "${c.text.slice(0, 40)}" href=${c.href ?? "-"} sel=${c.selector}`,
      );
      log(
        `nav-search: candidates exhausted — no self-serve key surface reachable. ` +
          `page had ${seen.length} clickable(s): ${seen.join(" | ")}`,
      );
      return { kind: "no_self_serve_key" };
    }
    tried.add(pick);
    const picked = candidates.find((c) => c.selector === pick);
    const pickText = picked?.text ?? "";
    // Prefer direct href-navigation for anchor picks: a click on a portaled/
    // animated dropdown item (avatar menu, Radix popover) is fragile and often
    // no-ops. The href is the known destination — go there.
    const hrefTarget = picked?.isAnchor === true ? resolveNavHref(picked.href, url) : null;
    await capture("navigate", inv, pick);
    if (hrefTarget !== null) {
      log(`nav-search: → "${pickText.slice(0, 40)}" via href ${hrefTarget}`);
      await browser.navigate(hrefTarget).catch(() => {});
    } else {
      log(`nav-search: → "${pickText.slice(0, 40)}" ${pick}`);
      await browser.clickSelector(pick).catch(() => {});
    }
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
