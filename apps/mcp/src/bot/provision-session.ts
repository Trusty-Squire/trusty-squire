// Phase 1 — the session-holding "thick tools" surface a frontier host agent
// drives. MCP tool calls are stateless, but a provision run needs ONE live
// browser held across many calls; this module is that registry + the
// observe/act loop over the existing BrowserController substrate.
//
// Two findings from the 2026-06 spikes are load-bearing here:
//  - target elements by TEXT/ROLE with re-resolution every act, never by a
//    positional index (indices drift as the SPA re-renders).
//  - the OAuth popup is the fragile part; route OAuth clicks through the
//    substrate's startOAuth/settleAfterOAuth, which already adopt the popup.
//
// Design notes:
//  - domain-scope gates only AGENT-INITIATED `goto`. Organic OAuth redirects
//    (which bounce through accounts.google.com, *.firebaseapp.com, etc.) are
//    not navigation the agent chose, so they are never blocked.
//  - no credential is ever read back to the agent except via the explicit
//    `finish`/extract path; the vault stays write-only.

import { createHash, randomInt, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { chmodSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BrowserController,
  type InteractiveElement,
  type PageTargetSafetySignals,
} from "./browser.js";
import { TwoCaptchaSolver, type TwoCaptchaVaultProxy } from "./captcha-solver-2captcha.js";
import type { ApiClient } from "../api-client.js";
import { extractApiKeyFromText, isTruncatedCapture } from "./credential-text.js";
import { pickVerificationLink } from "./email-verification.js";
import { detectActiveProviderSessions, ensureOAuthSession } from "./google-login.js";
import { loggedInEmail } from "./login-state.js";
import { loginSessionGuidance } from "./skill-hint.js";
import {
  type OperatorRecipe,
  type TraceEntry,
  type TraceAction,
  type RecipeHole,
  type RecipeTarget,
  type OperatorVerb,
  type KnownRecipeInputs,
  type Postcondition,
  type PostconditionResult,
  type PostconditionSnapshot,
  checkSuccessSignal,
  bindKnownEmailTemplate,
  bindRecipePostcondition,
  bindRecipeTarget,
  bindRecipeValue,
  cssEscapeRecipeValue,
  fillTemplate,
  hasRecipeTargetCandidate,
  isSingleUseUrl,
  knownRecipeInputValue,
  operatorRecipeDomain,
  resolveRecipeFieldTarget,
  resolveRecipeRepairTarget,
  resolveRecipeTarget,
  verifyFilledFieldValues,
  writeRecipe,
} from "./operator-recipe.js";
import {
  captureOnboardingRound,
  currentRunId,
  resetCaptureChain,
  resolveCaptureDir,
  type OnboardingRoundCapture,
} from "./onboarding-capture.js";
import {
  promoteToSkill,
  pickRowDisambiguator,
  pickStableDomHint,
  pickHrefHint,
  type PromoteResult,
} from "./promote-to-skill.js";
import { serviceSlugFromHost } from "@trusty-squire/skill-schema";
import type { PostVerifyStep } from "./provision-types.js";
import {
  looksLikeCodeIdentifier,
  looksLikeCredentialValue,
  isCredentialNoise,
  findCredentialTokens,
  keyFamilyPrefix,
  pickRelaxedNearCopyCredential,
} from "./credential-shape.js";
import type { OAuthProviderId } from "./oauth-providers.js";
import {
  initialExtractionState,
  accumulateCandidate,
  hasFullHit,
  resolveExtraction,
  type CandidateClass,
} from "./extraction.js";

// Identity-provider + auth-handler hosts a signup legitimately bounces
// through. Used to widen domain-scope so an OAuth `goto` (rare) isn't blocked.
// Organic redirects are already exempt (scope only gates explicit goto).
const DEFAULT_AUTH_HOSTS: readonly string[] = [
  "accounts.google.com",
  "github.com",
  "login.microsoftonline.com",
  "appleid.apple.com",
];

export interface ObservedElement {
  // Stable action handle for this element identity. Prefer this as
  // operate_act.target; it remains reusable across observations while the
  // element exists, and a removed or changed identity fails to resolve.
  ref: string;
  // Human label for display/backcompat. operate_act still accepts labels, but
  // generated refs are safer on pages with repeated labels.
  label: string;
  tag: string;
  // Below ref/label/tag, fields are nullable in FULL mode (emitted as null) and
  // OMITTED entirely in compact mode when empty — hence
  // optional. `value_len` replaces `value` in compact (never the raw value).
  role?: string | null;
  type?: string | null;
  value?: string | null;
  value_len?: number;
  checked?: boolean | null;
  // Link target, so the agent can see where a nav item goes and `goto` it
  // directly instead of guessing URLs (a live LangWatch run hit a 404 guessing
  // /settings because the sidebar "Settings" is a hover-expand with the real
  // path only in its href). Null for non-link elements.
  href?: string | null;
  // The site's own stable test hook (data-testid/-cy/-qa), the most
  // refactor-resilient target when present.
  testId?: string | null;
  // DOM-derived screen context for non-vision host agents. `path` is a compact
  // targetable label such as "dialog:finish-account > button:create-account".
  // Compact wire payloads omit it; the complete snapshot file retains it.
  path?: string | null;
  // `container` is redundant with `path` (path = "<container> > <kind>:<label>")
  // and is OMITTED in compact mode.
  container?: string | null;
  topmost?: boolean | null;
  occluded_by?: string | null;
}

export interface ScreenRegion {
  id: string;
  role: string;
  topmost: boolean;
  occluded_by: string | null;
  children: Array<{
    ref: string;
    role: string | null;
    text: string | null;
    href: string | null;
    topmost: boolean | null;
    occluded_by: string | null;
  }>;
}

export interface ScreenOutline {
  foreground: string | null;
  mode_markers: string[];
  regions: ScreenRegion[];
}

export interface Observation {
  session_id: string;
  url: string;
  // Registry route guidance, present ONLY on the first (start) observation when
  // a skill exists for the service. The host agent reads it before driving.
  hint?: string;
  // Layout-aware page prose (innerText) so the agent can read passages,
  // questions, masked-key hints, etc. Capped to keep tool payloads bounded.
  text: string;
  // Domain-aware steering for the host planner. This is not a script; it is
  // guardrail context for states the raw page text routinely misleads agents on.
  guidance?: string;
  // Compact relational view of interactive DOM regions. This is intentionally
  // smaller than raw DOM but preserves hierarchy/occlusion that flat text loses.
  screen?: ScreenOutline;
  // AXI-style planner scan surface. Additive in full mode: the rich `elements`
  // inventory remains the source of truth for actionability/state.
  accessibility?: AccessibilitySnapshot;
  // FULL-mode element inventory (the legacy escape hatch): one JSON object per
  // element with every field. In COMPACT mode `elements` is absent and the
  // element set rides on `el_table` instead (see below).
  elements?: ObservedElement[];
  // COMPACT-mode element inventory as a tab-delimited table (docs/DESIGN-observe-
  // compact.md § Phase 4). The first line is a tab-joined HEADER naming the
  // columns present in this emit (a subset of ref,label,tag,role,type,value_len,
  // checked,href,testId,topmost,occluded_by, always starting ref,label,tag);
  // each following line is ONE element, tab-joined cells in header order. An
  // empty cell means the field is absent for that element. Tab, newline,
  // carriage-return and backslash inside a cell are backslash-escaped (\t \n \r
  // \\). Numeric (value_len) and boolean (checked,topmost) cells are their plain
  // text form. On a DELTA emit `el_table` carries ONLY the changed elements (same
  // upsert-by-ref/`removed`/`unchanged` semantics as before); it is ABSENT when
  // no element changed. On a FULL emit it is the resync set (minus collapsed
  // chrome links, which stay in snapshot_file). `detail:"full"` uses `elements`
  // (JSON), never this.
  el_table?: string;
  // Compact-mode bookkeeping so omission is never silent: the complete current
  // element count (including delta/collapsed omissions), and whether page text
  // was capped at 4000 characters. Absent in full mode.
  elements_total?: number;
  text_truncated?: boolean;
  // Per-session observe delta (docs/DESIGN-observe-compact.md). On a DELTA emit,
  // `el_table` carries ONLY the rows whose compact form changed vs the previous
  // observation; `delta` is true and `unchanged` counts the elements that were
  // identical and therefore omitted (present in the persisted snapshot_file).
  // `removed` lists refs that were present last observe and are now gone
  // (usually empty). On a FULL compact emit `delta` is false and
  // `unchanged`/`removed` are absent; `el_table` is the resync set but may omit
  // collapsed chrome links that remain in snapshot_file. If persistence fails,
  // snapshot_file is absent and `el_table` is instead complete and uncollapsed.
  // A full snapshot is emitted on the first observe, a URL change, or high churn
  // (SPA re-render).
  delta?: boolean;
  unchanged?: number;
  removed?: string[];
  // Set on a DELTA emit when the (normalized, same-cap) page text is identical to
  // the previous observation's — the `text` field is then emitted EMPTY and the
  // host reuses the prior text (recoverable in full from snapshot_file).
  // Corpus-measured: 38% of re-observes have byte-identical text, and the text
  // blob is a large share of each observe.
  text_unchanged?: boolean;
  // FULL compact emit only: count of plain chrome-region <a> links collapsed out
  // of `el_table` (a site-dependent bonus). The collapsed links stay in
  // snapshot_file. Buttons/inputs/dismiss controls are never collapsed.
  chrome_links_collapsed?: number;
  // Every observe writes the COMPLETE current snapshot (all elements, WITH the
  // verbose `path` field) to this session-scoped file, so the host can re-expand
  // the full inventory after ITS own context compacts, or grep for an element the
  // delta didn't re-show. The delta's safety net — without it, delta is unsafe.
  snapshot_file?: string;
  // Phase 2 — set to "none" on the minimal ack returned by
  // operate_act{observe:"none"} (action ran; no perception emitted — call
  // operate_observe before the next ref-targeted act).
  observed?: ObserveDetail;
  // Change 5 — fail-closed identity hand-back: set ONLY when an operate task
  // required a live Google session that was absent. The task did NOT start; the
  // host asks the user to connect, then retries. No browser was driven.
  needs_user?: NeedsUserConnect;
  // PR3 signin-vault: the user's own email (the Google identity captured at
  // login), present on the start observation when known. The host fills THIS as
  // the signup email so the account is user-owned, and it is the same identity
  // whose inbox awaitVerification reads. Absent when no email was captured.
  user_email?: string;
}

export interface AccessibilitySnapshot {
  tree: string;
  refs: number;
  truncated: boolean;
  total_chars: number;
  source: "interactive_dom";
}

export type ProvisionAction =
  | { kind: "click"; target: string }
  // JS-dispatched click (el.click()) — use when a plain click on a custom
  // React card/widget didn't register its onClick (the stochastic radio-card
  // stall). Same target resolution; different dispatch.
  | { kind: "js_click"; target: string }
  | {
      kind: "type";
      target: string;
      text: string;
      provenance?: RecipeHole;
      replayRepair?: ReplayRepairBinding;
    }
  // Choose an option in a native <select> OR a custom listbox/combobox by its
  // visible text (fuzzy, case-insensitive substring). `type` cannot drive these
  // — page.fill throws on a <select> and humanized keystrokes break native
  // type-ahead — so a country/state/etc. dropdown needs this. Routes to
  // browser.selectOption, which already handles both the native and the
  // <li role=option> custom shapes. target = the select/combobox (or its label);
  // text = the option to match (e.g. "South Korea").
  | {
      kind: "select";
      target: string;
      text: string;
      provenance?: RecipeHole;
      replayRepair?: ReplayRepairBinding;
    }
  // Set the country on a phone-number field's dial-code picker. No ref/target
  // — the bot locates a phone-local native <select>, including
  // react-phone-number-input's opacity:0 select that inventory drops. Other
  // widget families are unsupported and throw.
  | {
      kind: "set_phone_country";
      country: string;
      provenance?: RecipeHole;
      replayRepair?: ReplayRepairBinding;
    }
  | { kind: "goto"; url: string }
  | { kind: "press"; key: string }
  // Route an OAuth-provider button through startOAuth so the popup is adopted
  // as the active page (the host then observes the account chooser/consent).
  | { kind: "oauth_click"; target: string }
  // Return to the product page after the OAuth handshake completes.
  | { kind: "oauth_settle" }
  // Operator surface — declare a host to cross into mid-session (multi-app
  // tasks: GCP Console → Firebase → the user's app). Pushed to the allow-set
  // with source "mid_session" and audited; the goto gate then permits it.
  | { kind: "allow_host"; host: string }
  // Sealed credential transfer — type a secret held in a session-local slot
  // into a field, WITHOUT the value ever crossing the MCP boundary to the
  // host. The host orchestrates by slot name; the bot types the real value.
  | { kind: "type_secret"; slot: string; target: string; provenance?: RecipeHole }
  // Reveal below-the-fold controls on a long SPA form, then re-observe to pick
  // up the newly-visible elements (heavy consoles render fields off-viewport).
  | { kind: "scroll"; direction?: "down" | "up" | "bottom" | "top" }
  // Attach a LOCAL file. target = the visible upload button/menu-item (or the
  // file <input>); path = an absolute local file path. The bot sets the file via
  // Playwright (filechooser/setInputFiles), so the OS dialog is never driven.
  // Not recorded in skill recipes — a machine-local path isn't portable.
  | { kind: "upload"; target: string; path: string };

export interface ReplayRepairBinding {
  stepIndex: number;
  hole: string;
}

// Where a host on the allow-set came from. start = declared at operate_start;
// mid_session = added via an allow_host action; auto_widen = an organic
// same-base-domain redirect we trust. Source-tracked so every widening is
// attributable, and so auto-widen only chains off START hosts (no scope creep
// off an agent-declared mid_session host) and credential egress can exclude
// mid_session task scope.
export type HostSource = "start" | "mid_session" | "auto_widen";

export interface AllowedHostEntry {
  host: string;
  source: HostSource;
}

interface ReplayExpectedField {
  stepIndex: number;
  hole: string;
  expected: string;
  target: RecipeTarget | null;
  kind: "type" | "select" | "set_phone_country";
}

interface ReplayState {
  recipeName: string;
  recipeHash: string;
  bindingsHash: string;
  boundPostcondition: Postcondition;
  moneyPath: boolean;
  nextIndex: number | null;
  expectedFields: Map<number, ReplayExpectedField>;
  verifiedFields: Set<number>;
  paymentGuard: "pending" | "verified" | "failed";
  failure?: { reason: "field_missing" | "field_value_mismatch"; field: string };
}

interface RecordedValueSource {
  traceIndex: number;
  hole?: string;
  literal: string;
}

interface Session {
  id: string;
  browser: BrowserController;
  allowedHosts: AllowedHostEntry[];
  generation: number;
  // Sealed credential slots: secret values extracted in-session and held ONLY
  // here so a later type_secret can enter them into another site's form. Never
  // returned to the host (the write-only-vault moat extended to transfers).
  secretSlots: Map<string, string>;
  // PR3 privacy — element target keys (screenPath/testId/ref) of fields a sealed
  // secret slot was typed into via type_secret. A subsequent observation masks
  // their DOM value so the cleartext can't surface to the host. Password-type
  // inputs are masked unconditionally; this covers the rest (OTP/token fields,
  // the email filled from the sealed login slot).
  sealedFieldKeys: Set<string>;
  // The last extracted elements, kept so resolveTarget can be unit-tested
  // against a snapshot, but act() always RE-extracts first (re-resolution).
  lastElements: InteractiveElement[];
  // Per-session observe delta baseline: the previous observation's stable-ref →
  // serialized-compact-element (payload form, so `path` is already EXCLUDED — a
  // layout-only shift must not read as a change). Each observe diffs the current
  // compact set against this and emits only what changed. Null until the first
  // observe. Reset on a URL change so a delta never crosses pages.
  prevObserve: ObserveDeltaState | null;
  observeSnapshotFile: string | null;
  // Phase A operator-recipe capture (docs/ARCHITECTURE.md): the
  // ordered, TEXT-targeted action trace of this session, so a successful run can
  // be `remember`ed as a replayable rail. Records visible text + non-secret
  // params only — sealed secret values stay in secretSlots, never the trace.
  actionTrace: TraceEntry[];
  recordedValues: RecordedValueSource[];
  committedSelectValues: Map<string, string>;
  // MEDIUM capture rounds for skill synthesis at verified success (docs/DESIGN-
  // operator-hints.md): inventory + action + url per step, no screenshots, raw
  // html only on the extract round. Accumulated live; written + promoted at
  // operate_finish_task on a verified success.
  captureRounds: OnboardingRoundCapture[];
  // Deliverable #1 measurement (docs/DESIGN-operator-hints.md): when the session
  // started and whether a registry hint was served this run, so finish emits the
  // hint-on vs hint-off lift signal (success rate + time, bucketed).
  startedAt: number;
  hintServed: boolean;
  // The session's START url (service_url at operate_start, or the resolved
  // entry on an operate_use replay). Persisted as the recipe's canonical
  // entry_url so a replay always opens at a STABLE page, never a mid-flow
  // single-use link inferred from the trace.
  startUrl: string;
  // PR2 — whether this session may read the inbox for email verification. From
  // the install-time consent flag; gates awaitVerification (fail-closed).
  consentInboxRead: boolean;
  // PR3 — the user's own email (Google identity captured at login), or null when
  // unknown. The authoritative signup email + the identity whose inbox is read.
  userEmail: string | null;
  // The MCP api-client (when the tool layer passed one through). Lets the captcha
  // gate spend a VAULTED 2Captcha key through the injecting proxy instead of a
  // raw env key. Undefined → the gate falls back to TWOCAPTCHA_API_KEY.
  api?: ApiClient;
  // Set when a step used the text=/css= locator click fallback. Such a click
  // resolves off-inventory, so it cannot be synthesized into a portable skill
  // step — this flag suppresses auto-promotion so no silently-incomplete skill
  // ships (captureAndPromoteSession).
  usedLocatorFallback: boolean;
  recipeRejectionReason: string | null;
  replayState: ReplayState | null;
}

// Plain host list for the pieces that only need the names (goto gate, audit,
// observed-hosts). The source metadata stays on the Session.
function hostStrings(session: Session): string[] {
  return session.allowedHosts.map((e) => e.host);
}

// Hosts that may seed credential EGRESS (where a stored key is later sent by
// the proxy): start + auto_widen, never mid_session task scope — a wide operate
// scope must not silently over-grant a key's egress allow-list (Codex). The
// vault unions these with the service-default + any agent-declared egress_hosts.
function egressSeedHosts(session: Session): string[] {
  return session.allowedHosts.filter((e) => e.source !== "mid_session").map((e) => e.host);
}

const sessions = new Map<string, Session>();

interface WarmBrowser {
  controller: BrowserController;
  createdAt: number;
  reuseCount: number;
}

function positiveEnvNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const WARM_BROWSER_IDLE_TTL_MS = positiveEnvNumber(
  "BOT_WARM_BROWSER_IDLE_TTL_MS",
  6 * 60 * 60 * 1_000,
);
const WARM_BROWSER_MAX_REUSES = positiveEnvNumber("BOT_WARM_BROWSER_MAX_REUSES", 50);
const WARM_BROWSER_MAX_AGE_MS = positiveEnvNumber(
  "BOT_WARM_BROWSER_MAX_AGE_MS",
  24 * 60 * 60 * 1_000,
);

let warmBrowser: WarmBrowser | null = null;
let warmBrowserIdleTimer: ReturnType<typeof setTimeout> | null = null;
// Sequential single-page model: one start may be booting OR one task may hold
// the browser. This is also the lifecycle/payment safety lease — every reaper
// checks it before closing shared Chrome.
let starting = false;
let inFlight = false;

function clearWarmBrowserIdleTimer(): void {
  if (warmBrowserIdleTimer === null) return;
  clearTimeout(warmBrowserIdleTimer);
  warmBrowserIdleTimer = null;
}

async function closeWarmBrowserIfIdle(reason: string): Promise<boolean> {
  if (warmBrowser === null) return false;
  if (starting || inFlight) {
    armWarmBrowserIdleTimer();
    return false;
  }
  const browser = warmBrowser.controller;
  warmBrowser = null;
  clearWarmBrowserIdleTimer();
  console.error(`[operator] recycling warm browser reason=${reason}`);
  await browser.close().catch(() => undefined);
  return true;
}

function armWarmBrowserIdleTimer(): void {
  clearWarmBrowserIdleTimer();
  if (warmBrowser === null) return;
  warmBrowserIdleTimer = setTimeout(() => {
    warmBrowserIdleTimer = null;
    void closeWarmBrowserIfIdle("idle_ttl");
  }, WARM_BROWSER_IDLE_TTL_MS);
  warmBrowserIdleTimer.unref();
}

// Every operate call reaches this module through start or a session lookup.
// Resetting the one unref'd timer here measures genuine operator quiet.
function touchWarmBrowser(): void {
  armWarmBrowserIdleTimer();
}

function warmBrowserExpired(slot: WarmBrowser): "max_reuses" | "max_age" | null {
  if (slot.reuseCount >= WARM_BROWSER_MAX_REUSES) return "max_reuses";
  if (Date.now() - slot.createdAt >= WARM_BROWSER_MAX_AGE_MS) return "max_age";
  return null;
}

async function acquireWarmBrowser(
  opts: StartOptions,
  sessionId: string,
): Promise<BrowserController> {
  const slot = warmBrowser;
  if (slot !== null) {
    const expired = warmBrowserExpired(slot);
    const eligible = slot.controller.matchesLaunchOptions(opts);
    const healthy = slot.controller.isConnected();
    if (expired !== null || !eligible || !healthy) {
      warmBrowser = null;
      clearWarmBrowserIdleTimer();
      await slot.controller.close().catch(() => undefined);
      audit(sessionId, "browser_recycle", {
        reason: expired ?? (!eligible ? "launch_config_mismatch" : "disconnected"),
      });
    } else {
      try {
        await slot.controller.resetPageForReuse();
        slot.reuseCount += 1;
        touchWarmBrowser();
        audit(sessionId, "browser_reuse", { reuse_count: slot.reuseCount });
        return slot.controller;
      } catch {
        warmBrowser = null;
        clearWarmBrowserIdleTimer();
        await slot.controller.close().catch(() => undefined);
        audit(sessionId, "browser_recycle", { reason: "page_reset_failed" });
      }
    }
  }

  const controller = new BrowserController({
    ...(opts.profileDir !== undefined ? { profileDir: opts.profileDir } : {}),
    ...(opts.proxyUrl !== undefined ? { proxyUrl: opts.proxyUrl } : {}),
  });
  await startBrowserBounded(controller, sessionId);
  warmBrowser = { controller, createdAt: Date.now(), reuseCount: 0 };
  touchWarmBrowser();
  return controller;
}

async function releaseWarmBrowserPage(browser: BrowserController): Promise<void> {
  if (warmBrowser?.controller !== browser) {
    await browser.close().catch(() => undefined);
    return;
  }
  try {
    await browser.resetPageForReuse();
  } catch {
    warmBrowser = null;
    clearWarmBrowserIdleTimer();
    await browser.close().catch(() => undefined);
  }
}

function sessionForCall(sessionId: string): Session | undefined {
  touchWarmBrowser();
  return sessions.get(sessionId);
}

const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Audit trail (security posture): every session action emits one structured
// stderr line the host's MCP log captures. The `provision-audit` marker makes
// the trail greppable. No credential VALUES are ever logged — only the action
// shape + url.
function audit(sessionId: string, event: string, detail: Record<string, unknown> = {}): void {
  process.stderr.write(
    `${JSON.stringify({ marker: "provision-audit", surface: "operate", session_id: sessionId, event, ...detail })}\n`,
  );
}

// operate_start's browser launch is the one UNBOUNDED step in the session
// bootstrap: on a fresh box the first launch downloads Chromium and spins up a
// virtual display (Xvfb), and a wedged profile lock or missing browser deps can
// otherwise hang it indefinitely — a real dogfood run sat on a silent ~30-min
// hang here with zero feedback (the worst first-run failure: the user assumes
// it's broken and never comes back). Cap it so a stuck launch fails LOUDLY with
// an actionable message. The default is generous (a cold Chromium download is
// legitimately multi-minute — better to wait than false-fail a slow-but-working
// launch); tune with BOT_START_TIMEOUT_MS. On timeout we close() the
// half-launched browser so a wedged Chrome can't keep the profile lock and brick
// the next attempt.
const START_TIMEOUT_MS = Number(process.env.BOT_START_TIMEOUT_MS) || 600_000;

async function startBrowserBounded(browser: BrowserController, sessionId: string): Promise<void> {
  audit(sessionId, "browser_launch", {
    note: "first launch may download Chromium + start Xvfb; slow but one-time",
    timeout_ms: START_TIMEOUT_MS,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("__browser_start_timeout__")), START_TIMEOUT_MS);
  });
  try {
    await Promise.race([browser.start(), timeout]);
  } catch (err) {
    if (err instanceof Error && err.message === "__browser_start_timeout__") {
      // Release the wedged Chrome/profile lock so the next operate_start isn't bricked.
      await browser.close().catch(() => undefined);
      throw new Error(
        `operate_start: browser did not launch within ${Math.round(START_TIMEOUT_MS / 1000)}s. ` +
          "On a fresh machine the first launch downloads Chromium and starts a virtual display " +
          "(Xvfb) — slow but one-time. A hang this long usually means the browser binaries or Xvfb " +
          "are missing on this box. Retry once (a partial download resumes and later launches reuse " +
          "the cache); if it recurs, run `npx @trusty-squire/mcp connect` here to install the browser " +
          "deps, or raise BOT_START_TIMEOUT_MS to wait longer.",
      );
    }
    throw err;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ── pure helpers (exported for unit tests) ──

const norm = (s: string | null | undefined): string =>
  (s ?? "").replace(/\s+/g, " ").trim().toLowerCase();

// Element ref = a STABLE-by-default handle: "@e:<identity>_<ordinal>". For a
// normal control `<identity>` is its generation-independent stableElementId, so
// the per-session observe delta can leave an unchanged element un-re-emitted and
// the ref the host already holds keeps resolving. The `@e:` sigil only
// disambiguates a ref from a free-text label target (a label may legitimately end
// in "_<digits>"). Staleness is guarded by IDENTITY, not a counter: a ref whose
// element is now gone finds no match in resolveTarget → returns null → the caller
// fails loudly ("no element matched") and the host re-observes.
//
// The exceptional identity form (issue #399) applies to same-base-identity
// siblings distinguished ONLY by positional selectors. Those "volatile" members
// get an identity prefixed with their sibling group's composition FINGERPRINT
// ("<fp>-<hash>", see volatilePositionalGroups + elementIdentity), so a ref is
// valid only while that fingerprint matches. A membership-count change re-mints
// the group and makes every old ref resolve to null, never to a survivor.
// Size-preserving changes among truly indistinguishable members are the bounded
// residual documented at volatilePositionalGroups. `<fp>-` stays within the id
// charset below, so no parsing changes are needed.
const PROVISION_REF_RE = /^@e:([a-z0-9_-]+)$/i;
const PROVISION_REF_ID_RE = /^(.+)_(\d+)$/;

// The label a host sees + targets by. Prefer the most human, stable signal.
export function elementRef(el: InteractiveElement): string {
  const cand =
    el.visibleText ??
    el.labelText ??
    el.ariaLabel ??
    el.iconLabel ??
    el.placeholder ??
    el.title ??
    el.name ??
    (typeof el.value === "string" && el.value.length > 0 ? el.value : null);
  const label = (cand ?? "").replace(/\s+/g, " ").trim();
  return label.length > 0 ? label.slice(0, 80) : `${el.tag}#${el.index}`;
}

function shortHash(s: string): string {
  return createHash("sha256").update(s).digest("base64url").slice(0, 12);
}

function baseIdentityFields(el: InteractiveElement): string[] {
  return [
    el.screenPath ?? "",
    el.testId ?? "",
    el.container ?? "",
    el.role ?? "",
    el.tag,
    elementRef(el),
    el.href ?? "",
    el.type ?? "",
  ];
}

export function stableElementId(el: InteractiveElement): string {
  return shortHash(
    [
      ...baseIdentityFields(el),
      // The element's own selector — a per-element discriminator so two controls
      // that are otherwise identical (same label/path/role, e.g. sibling "Remove"
      // buttons in a list) get DISTINCT identities. Without it, a stable ref is a
      // positional ordinal within a same-hash group: remove the first sibling and
      // the old `_1` silently retargets the survivor. With a STABLE selector
      // (id/data-attr) folded in, the removed element's identity is unique, so its
      // old ref finds no match and resolveTarget returns null (the host
      // re-observes) — no mis-click.
      //
      // Mutable state (`checked`, value length, topmost/occlusion) is deliberately
      // excluded so fills, toggles, and visibility changes keep the same ref.
      // A purely POSITIONAL selector (`:nth-of-type`/`:nth-child`/`>> nth=`)
      // recycles on sibling removal, so this hash alone would let a survivor
      // slide onto a departed node's identity. Closed one layer up (issue #399):
      // volatilePositionalGroups fingerprints such sibling groups and
      // elementIdentity prefixes their refs with that fingerprint, so a group
      // size change makes every old positional ref resolve to null.
      el.selector,
    ].join("\u001f"),
  );
}

// The base identity WITHOUT the selector — the grouping key for same-label
// sibling detection.
function baseElementKey(el: InteractiveElement): string {
  return baseIdentityFields(el).join("\u001f");
}

// A selector that pins an element only by its POSITION among siblings
// (`:nth-of-type`/`:nth-child`, or Playwright's `>> nth=` index). Such selectors
// RECYCLE: remove an earlier sibling and a later one slides into the vacated
// position, so the identical selector string then designates a DIFFERENT node.
// Stable anchors (#id, [data-testid], [name=…]) never recycle this way. Quoted
// attribute VALUES (incl. backslash-escaped quotes) are blanked first so a stable
// `[data-key="x:nth-child(1)"]` — the value merely CONTAINS the syntax — is not
// misread as a positional combinator; only real structural syntax counts.
const POSITIONAL_SELECTOR_RE = /:nth-of-type\(|:nth-child\(|>>\s*nth=/i;
const QUOTED_VALUE_RE = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g;
function isPositionalSelector(selector: string): boolean {
  return POSITIONAL_SELECTOR_RE.test(selector.replace(QUOTED_VALUE_RE, '""'));
}

// A "volatile positional group": the ≥2 POSITIONAL members of a same-base-identity
// group (any stable-anchored siblings in the same base group keep their plain,
// non-volatile refs). Removing one shifts a survivor's positional selector onto a
// departed node's identity, so a purely structural ref would silently retarget
// the survivor (issue #399). Returns each such member mapped to a GROUP
// FINGERPRINT — a hash of the positional members' stableElementIds in extraction
// order. elementIdentity prefixes the member's ref with that fingerprint, so the
// ref is valid ONLY while the positional membership matches.
//
// Guarantees (the #399 invariant): after a member is REMOVED (group size N→N-1),
// the fingerprint changes, so the departed member's old ref appears in `removed`
// (or a full resync) and resolves to null — never a survivor — including WITHIN a
// turn (the act path re-extracts, so a mid-turn removal changes the fingerprint
// and forces a re-observe rather than mis-targeting a shifted sibling). Because
// the identity is composition-derived (not an observe counter), a static group's
// refs stay stable across observes (no wasted churn) and a toggled checkbox /
// filled field keeps its ref (mutable state is excluded from stableElementId).
//
// Bounded residual: the fingerprint is built from the members' own
// position-derived hashes, so a SIZE-PRESERVING shuffle of TRULY INDISTINGUISHABLE
// members — delete-one-and-insert-one, or a pure reorder, where the members carry
// ZERO distinguishing signal (identical label/aria/testid/text/screenPath, only
// the nth differs) — leaves the fingerprint unchanged and is not detected. This
// is information-theoretically unavoidable for a string-derived identity: such an
// observation is byte-identical to "nothing changed," so no ref scheme can flag
// it. Real per-row controls carry a distinguishing signal (row text / aria-label
// / a data-id), which lands them in DISTINCT base groups (non-volatile) where the
// #398 stable-selector identity already guards them. Fully closing the residual
// needs an extractor-stamped per-node id that survives DOM mutation — deferred
// because stamping every interactive node with a persistent attribute is
// anti-bot-detectable (a worse regression than the residual it removes).
function volatilePositionalGroups(
  elements: readonly InteractiveElement[],
): Map<InteractiveElement, string> {
  const groups = new Map<string, InteractiveElement[]>();
  for (const el of elements) {
    const key = baseElementKey(el);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [el]);
    else group.push(el);
  }
  const fingerprintOf = new Map<InteractiveElement, string>();
  for (const group of groups.values()) {
    // ≥2 positional siblings sharing a base identity can recycle onto EACH
    // OTHER; a lone positional member (or any stable-anchored member) cannot.
    const positional = group.filter((el) => isPositionalSelector(el.selector));
    if (positional.length < 2) continue;
    // Extraction-order fingerprint: sensitive to membership-count and selector-
    // sequence changes, subject to the size-preserving residual above.
    const fp = shortHash(positional.map((el) => stableElementId(el)).join(""));
    for (const el of positional) fingerprintOf.set(el, fp);
  }
  return fingerprintOf;
}

// The ref identity of one element. A volatile positional-group member is
// prefixed with its group fingerprint (`<fp>-<hash>`) so its ref survives only
// while the group's composition is unchanged; everything else uses its plain,
// composition-independent stableElementId (byte-identical to the pre-#399 ref).
function elementIdentity(
  el: InteractiveElement,
  fingerprintOf: ReadonlyMap<InteractiveElement, string>,
): string {
  const base = stableElementId(el);
  const fp = fingerprintOf.get(el);
  return fp === undefined ? base : `${fp}-${base}`;
}

export function provisionElementRef(el: InteractiveElement, ordinal = 1): string {
  return `@e:${stableElementId(el)}_${ordinal}`;
}

function parseProvisionRef(target: string): { id: string; ordinal: number | null } | null {
  const m = target.trim().match(PROVISION_REF_RE);
  if (m === null) return null;
  const rawId = m[1] as string;
  const idMatch = rawId.match(PROVISION_REF_ID_RE);
  return {
    id: idMatch !== null ? (idMatch[1] as string) : rawId,
    ordinal: idMatch !== null ? Number.parseInt(idMatch[2] as string, 10) : null,
  };
}

// A locator-form target the host supplies when NO `@e:` ref exists for the
// control it needs to act on — a bare click-handler <div> the inventory never
// emitted (no role/label/testid, and past the card-scan cap). Two forms:
//   text="Add To Cart"  (quotes optional) — clickable element whose text matches
//   css=#some-id                          — a raw CSS selector
// Resolved directly against the live page by BrowserController.resolvePageTarget,
// NOT against the extracted-element inventory (which by definition lacks it).
export type LocatorTarget = { mode: "text" | "css"; value: string };

export function parseLocatorTarget(target: string): LocatorTarget | null {
  const m = /^\s*(text|css)\s*=\s*([\s\S]+)$/i.exec(target);
  if (m === null) return null;
  const mode = (m[1] as string).toLowerCase() === "css" ? "css" : "text";
  let value = (m[2] as string).trim();
  // Strip one matching pair of surrounding quotes so `text="Add To Cart"` and
  // `text=Add To Cart` are equivalent (the quotes only help the host delimit
  // trailing whitespace / punctuation).
  if (value.length >= 2) {
    const q = value[0];
    if ((q === '"' || q === "'") && value[value.length - 1] === q) {
      value = value.slice(1, -1);
    }
  }
  if (value.length === 0) return null;
  return { mode, value };
}

export function provisionElementRefs(
  elements: readonly InteractiveElement[],
): Map<InteractiveElement, string> {
  const fingerprintOf = volatilePositionalGroups(elements);
  const seen = new Map<string, number>();
  const refs = new Map<InteractiveElement, string>();
  for (const el of elements) {
    const id = elementIdentity(el, fingerprintOf);
    const ordinal = (seen.get(id) ?? 0) + 1;
    seen.set(id, ordinal);
    refs.set(el, `@e:${id}_${ordinal}`);
  }
  return refs;
}

export class AmbiguousProvisionTargetError extends Error {
  readonly code = "ambiguous_target";

  constructor(
    readonly target: string,
    readonly candidates: readonly string[],
  ) {
    super(
      `ambiguous_target: "${target}" matched ${candidates.length} elements. ` +
        `Retry with one exact ref/path: ${candidates.slice(0, 8).join(", ")}`,
    );
  }
}

function elementTargetKeys(el: InteractiveElement): string[] {
  return [el.screenPath ?? null, el.testId ?? null, elementRef(el)].flatMap((s) => {
    const v = (s ?? "").replace(/\s+/g, " ").trim();
    return v.length > 0 ? [v] : [];
  });
}

// Resolve a host-supplied target string to one live element. Matching is by
// structured path, test id, or label text, scored exact > startsWith > contains.
// Returns null when nothing matches — the caller surfaces that rather than
// guessing.
export function resolveTarget(
  elements: readonly InteractiveElement[],
  target: string,
): InteractiveElement | null {
  const parsedRef = parseProvisionRef(target);
  if (parsedRef !== null) {
    // Staleness guard: a ref whose identity is absent among the LIVE elements
    // returns null (the caller re-observes). Identity is recomputed here from the
    // live set, so a volatile positional-group ref carries the group's fingerprint
    // at mint time; if the live group has a different fingerprint, the stale ref
    // resolves to null instead of retargeting a survivor (issue #399). This holds
    // WITHIN a turn too: the act path re-extracts, so a membership-count change
    // between observe and act changes the fingerprint and forces a re-observe.
    //
    // Ordinal caveat (same-hash duplicates): the `_<ordinal>` suffix positionally
    // disambiguates elements that hash IDENTICALLY (same selector too — NOT the
    // positional-sibling case, which the fingerprint covers). Mutable state is
    // intentionally absent from that hash, so members need not have identical
    // checked/value/visibility state. If one is removed, an ordinal can resolve to
    // a survivor; the recycled ordinal is not invalidated by `removed`. An ordinal
    // past the current group size still returns null.
    const fingerprintOf = volatilePositionalGroups(elements);
    const matches = elements.filter((el) => elementIdentity(el, fingerprintOf) === parsedRef.id);
    if (parsedRef.ordinal !== null) {
      const match = matches[parsedRef.ordinal - 1];
      return match ?? null;
    }
    if (matches.length === 1) return matches[0] as InteractiveElement;
    if (matches.length > 1) {
      throw new AmbiguousProvisionTargetError(
        target,
        matches.map((el) => `${el.screenPath ?? elementRef(el)} (${elementRef(el)})`),
      );
    }
    return null;
  }

  const want = norm(target);
  if (want.length === 0) return null;
  let best: { el: InteractiveElement; score: number } | null = null;
  let tied: InteractiveElement[] = [];
  for (const el of elements) {
    for (const [i, raw] of elementTargetKeys(el).entries()) {
      const label = norm(raw);
      let score = 0;
      const exact = i === 0 ? 120 : i === 1 ? 110 : 100;
      if (label === want) score = exact;
      else if (label.startsWith(want)) score = 70;
      else if (label.includes(want)) score = 50;
      else if (want.includes(label) && label.length >= 2) score = 30;
      if (score === 0) continue;
      // Prefer shorter labels at equal score (a more specific match).
      const adjusted = score - label.length * 0.01;
      if (best === null || adjusted > best.score) {
        best = { el, score: adjusted };
        tied = [el];
      } else if (Math.abs(adjusted - best.score) < 0.000001) {
        if (!tied.includes(el)) tied.push(el);
      }
    }
  }
  if (best !== null && tied.length > 1) {
    throw new AmbiguousProvisionTargetError(
      target,
      tied.map((el) => `${el.screenPath ?? elementRef(el)} (${elementRef(el)})`),
    );
  }
  return best?.el ?? null;
}

// Squire's OWN control plane. The operator browser runs in the connect-seeded
// profile, so it is authenticated as the user (a live Google session). It must
// therefore NEVER be allowed to reach Squire's own web app / API: otherwise a
// prompt-injected signup page could drive it to the user's vault UI, sign in
// via that Google session, and read revealed secrets — defeating the
// write-only model (a confused-deputy exfiltration path, confirmed 2026-07-21).
// This denylist OVERRIDES the allow-set: no `goto` and no `allow_host` may
// reach these hosts, regardless of what the agent declares. (Self-hosted
// deployments on other domains should extend this list.)
const SQUIRE_CONTROL_PLANE_HOSTS: readonly string[] = [
  "trustysquire.ai",
  "trustysquire.com",
  "trusty-squire-api.fly.dev",
];

export function isSquireControlPlaneHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/\.$/, "");
  if (h.length === 0) return false;
  return SQUIRE_CONTROL_PLANE_HOSTS.some((d) => h === d || h.endsWith(`.${d}`));
}

// Domain-scope check for an agent-initiated goto. Allows the target host, any
// subdomain of it, the configured auth hosts, and *.firebaseapp.com /
// *.web.app auth handlers. Organic redirects are NOT routed through here.
export function hostAllowed(url: string, allowedHosts: readonly string[]): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  // Hard denylist first — Squire's own control plane is off-limits even if the
  // agent widened the allow-set to include it.
  if (isSquireControlPlaneHost(host)) return false;
  const ok = (allowed: string): boolean => host === allowed || host.endsWith(`.${allowed}`);
  if (allowedHosts.some(ok)) return true;
  if (DEFAULT_AUTH_HOSTS.some(ok)) return true;
  if (host.endsWith(".firebaseapp.com") || host.endsWith(".web.app")) return true;
  return false;
}

// A two-label public suffix we must never let a single allow_host widen to —
// adding "co.uk" would green-light every *.co.uk. Small curated set (the ones
// the operator surface realistically touches); not a full PSL.
const TWO_LABEL_PUBLIC_SUFFIXES: ReadonlySet<string> = new Set([
  "co.uk",
  "org.uk",
  "gov.uk",
  "ac.uk",
  "com.au",
  "net.au",
  "org.au",
  "co.jp",
  "co.nz",
  "co.in",
  "com.br",
  "co.za",
  "com.cn",
  "github.io",
  "web.app",
  "firebaseapp.com",
  "pages.dev",
  "workers.dev",
  "vercel.app",
  "netlify.app",
  "herokuapp.com",
]);

// Validate an agent-declared allow_host host. Returns the normalized bare
// hostname or an error string. Hardened (Codex): reject wildcards, ports,
// schemes/paths, IDNA/punycode + non-ASCII (lookalike-spoof defense), IPv4/IPv6
// literals, localhost/private hosts, bare TLDs, and two-label public suffixes.
// This matters more now that type_secret can enter a secret on these hosts.
export function validateAllowHost(raw: string): { host: string } | { error: string } {
  const v = raw.trim().toLowerCase();
  if (v.length === 0 || v.length > 253) return { error: "host empty or too long" };
  if (/[/:@?#*\s]/.test(v))
    return {
      error: "host must be a bare hostname (no scheme, port, path, wildcard, or whitespace)",
    };
  if (/[^a-z0-9.-]/.test(v))
    return {
      error: "host has non-ASCII or invalid characters (punycode/unicode spoofing rejected)",
    };
  if (v.includes("xn--")) return { error: "punycode (xn--) hosts rejected — homograph-spoof risk" };
  if (v.startsWith(".") || v.endsWith(".") || v.includes(".."))
    return { error: "malformed host (leading/trailing/double dot)" };
  if (v === "localhost" || v.endsWith(".localhost"))
    return { error: "localhost is not an allowable cross-host" };
  // IPv4 literal / dotted-quad — reject (egress + transfer must be by name).
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v))
    return { error: "IP-address hosts are not allowed (declare a hostname)" };
  // IPv6 would contain ':' — already rejected by the ':' check above.
  const labels = v.split(".");
  if (labels.length < 2) return { error: "bare TLD / single-label host not allowed" };
  if (labels.some((l) => l.length === 0 || l.length > 63))
    return { error: "invalid host label length" };
  if (TWO_LABEL_PUBLIC_SUFFIXES.has(v))
    return { error: `"${v}" is a public suffix — widening to it would allow every subdomain` };
  // Squire's own control plane is never a legitimate cross-host — refuse to
  // widen the operator browser into the vault UI / API (confused-deputy guard).
  if (isSquireControlPlaneHost(v))
    return {
      error:
        "Squire's own control plane (the vault UI / API) is off-limits to the operator browser",
    };
  return { host: v };
}

function visibleModeMarkers(pageText: string): string[] {
  const text = pageText.replace(/\s+/g, " ").trim();
  const markers: string[] = [];
  if (
    /\b(?:test|sandbox)\s+(?:mode|usage|environment|workspace)\b/i.test(text) ||
    /\b(?:mode|environment|workspace)\s*[:=-]?\s*(?:test|sandbox)\b/i.test(text)
  ) {
    markers.push("test/sandbox mode");
  }
  if (
    /\b(?:live|production)\s+mode\b/i.test(text) ||
    /\b(?:mode|environment|workspace)\s*[:=-]?\s*(?:live|production)\b/i.test(text)
  ) {
    markers.push("live/production mode");
  }
  return markers;
}

function appSurfaceMarkers(pageText: string): string[] {
  const text = pageText.replace(/\s+/g, " ").trim();
  const markers: string[] = [];
  const defs: Array<[string, RegExp]> = [
    ["dashboard", /\bdashboard\b/i],
    ["products", /\bproducts?\b/i],
    ["customers", /\bcustomers?\b/i],
    ["payments", /\bpayments?\b/i],
    ["developers", /\bdevelopers?\b/i],
    ["api keys", /\bapi\s+keys?\b/i],
    ["settings", /\bsettings\b/i],
    ["workspace", /\bworkspace\b/i],
    ["project", /\bproject\b/i],
    ["billing", /\bbilling\b/i],
    ["usage", /\busage\b/i],
    ["team", /\bteam\b/i],
  ];
  for (const [name, re] of defs) {
    if (re.test(text)) markers.push(name);
  }
  for (const mode of visibleModeMarkers(text)) markers.push(mode);
  return [...new Set(markers)].slice(0, 8);
}

// A login / OAuth-chooser page — an auth WALL, not the authenticated app surface.
// Marketing/nav words on a login page ("developers", "api", "docs") otherwise
// tripped authenticatedAppSurfaceMarkers into steering the agent to "prefer app
// navigation" on an auth-gated page. MEASURED 2026-07-01 (Groq /authenticate:
// "Create Account or Login … Continue with Google/GitHub/SSO/email").
export function looksLikeLoginChooser(pageText: string): boolean {
  const text = pageText.replace(/\s+/g, " ").trim();
  const continueWith = (
    text.match(/\bcontinue with (?:google|github|microsoft|sso|email|apple|gitlab)\b/gi) ?? []
  ).length;
  return (
    continueWith >= 2 ||
    /\bcreate account or (?:log|sign)\s?in\b/i.test(text) ||
    /\b(?:log|sign)\s?in to (?:your account|continue)\b/i.test(text)
  );
}

function authenticatedAppSurfaceMarkers(pageText: string): string[] {
  if (looksLikeLoginChooser(pageText)) return []; // auth wall, not the app surface
  const markers = appSurfaceMarkers(pageText);
  const modeMarkers = visibleModeMarkers(pageText);
  if (modeMarkers.length > 0) return markers;
  return markers.length >= 2 ? markers : [];
}

function hasAccountSetupOverlay(pageText: string): boolean {
  const text = pageText.replace(/\s+/g, " ").trim();
  return (
    /\b(?:finish|complete|set up|setup)\s+(?:creating\s+|setting\s+up\s+)?(?:your\s+)?(?:account|profile|organization|workspace|business)\b/i.test(
      text,
    ) ||
    /\bcreate\s+(?:your\s+)?account\b/i.test(text) ||
    /\btell us about (?:yourself|your business|your organization|your company)\b/i.test(text)
  );
}

// An onboarding / org-or-workspace creation form that GATES the keys page. These
// are NOT walls — the agent should fill the required fields with sensible
// inferred values and submit to proceed. Broader than hasAccountSetupOverlay
// (it also catches "create organization / you aren't part of an org yet").
export function isOnboardingOrOrgForm(pageText: string): boolean {
  const text = pageText.replace(/\s+/g, " ").trim();
  if (hasAccountSetupOverlay(text)) return true;
  return (
    /\byou\s+(?:aren'?t|are not|do not|don'?t)\s+(?:part of|belong to|have)\b.*\borgani[sz]ation\b/i.test(
      text,
    ) ||
    /\bcreate\s+(?:a\s+|your\s+|an\s+|new\s+)?(?:organi[sz]ation|org|workspace|team|project|company)\b/i.test(
      text,
    ) ||
    /\bname\s+(?:your\s+)?(?:organi[sz]ation|workspace|team|project|company)\b/i.test(text) ||
    /\b(?:what'?s|what is)\s+your\s+name\b/i.test(text) ||
    /\bget\s+started\b.*\b(?:name|organi[sz]ation|workspace|team)\b/i.test(text)
  );
}

// A "copy your key NOW — it won't be shown again" one-time reveal (Luma, many
// console secrets). The value is on screen but vanishes on dismiss/navigate, so
// the agent must extract it immediately (and name it with secret_label), not
// click away first.
export function hasOneTimeSecretModal(pageText: string): boolean {
  const text = pageText.replace(/\s+/g, " ").trim();
  return (
    /\b(?:won'?t|will not|can'?t|cannot|never)\b[\s\w]{0,30}?\b(?:shown|displayed|see|view|retriev\w*|access\w*)\b[\s\w]{0,20}?\bagain\b/i.test(
      text,
    ) ||
    /\b(?:only|last)\s+time\b.*\b(?:see|view|copy|shown)\b/i.test(text) ||
    /\b(?:copy|save|store)\s+(?:and\s+save\s+)?(?:your\s+|this\s+|the\s+)?(?:secret|api\s*key|key|token|credential)\b.*\b(?:now|securely|somewhere|before)\b/i.test(
      text,
    ) ||
    /\bmake\s+sure\s+to\s+(?:copy|save|store)\b/i.test(text)
  );
}

// The operator acts as the user's REAL identity (not a fresh disposable alias
// like the universal bot), so a service the user already has an account on
// rejects a fresh signup — the page flips to a login form / "already
// registered" / "invalid credentials". This is NOT a wall: the right move is to
// LOG IN with the existing identity and read the EXISTING key, not retry signup.
export function hasExistingAccountSignal(pageText: string): boolean {
  const text = pageText.replace(/\s+/g, " ").trim();
  return (
    /\binvalid\s+(?:credentials|password|email\s+or\s+password|login)\b/i.test(text) ||
    /\b(?:account|email|user(?:name)?)\s+(?:already\s+)?(?:exists|is\s+already\s+(?:registered|in\s+use|taken))\b/i.test(
      text,
    ) ||
    /\b(?:email|account)\s+is\s+already\s+(?:registered|in\s+use|associated|taken)\b/i.test(text) ||
    /\bthis\s+(?:email|account)\s+is\s+already\b/i.test(text) ||
    /\ban?\s+account\s+(?:with\s+this\s+email\s+)?already\s+exists\b/i.test(text)
  );
}

// An OAuth provider returned "account not found" — the user's Google/GitHub
// identity is not a LINKED account on this service (Clerk-style: the OAuth
// button is sign-IN only, signup is email-OTP). Retrying the OAuth button loops
// forever; the fix is to switch to the email/OTP signup path.
export function hasUnlinkedOAuthAccountSignal(pageText: string): boolean {
  const text = pageText.replace(/\s+/g, " ").trim();
  return (
    /\bexternal\s+account\s+(?:was\s+)?not\s+found\b/i.test(text) ||
    /\bno\s+(?:account|user)\s+(?:was\s+)?found\s+(?:for|with)\s+this\s+(?:google|github|oauth|external|account)\b/i.test(
      text,
    ) ||
    /\b(?:couldn'?t|could\s+not|unable\s+to)\s+find\s+(?:an?\s+)?(?:account|user)\b[\s\w]{0,30}?\b(?:google|github|oauth|external)\b/i.test(
      text,
    )
  );
}

// A stale/404 signup URL — the page is a "not found" shell, not a signup form.
// Retrying the same URL loops; the fix is to recover the real signup entry. Guard
// on length so a long app page that merely mentions "404" (an error-log widget, a
// metrics tile) doesn't trip it — a real 404 page is sparse.
export function hasNotFoundPageSignal(pageText: string): boolean {
  const text = pageText.replace(/\s+/g, " ").trim();
  if (text.length > 600) return false;
  return (
    /\b404\b/.test(text) ||
    /\bpage not found\b/i.test(text) ||
    /page (?:you(?:'re| are)? looking for )?(?:does\s?n'?t exist|not found|can'?t be found|could\s?n'?t be found)/i.test(
      text,
    )
  );
}

function isAccountSetupActionTarget(target: string): boolean {
  return /\b(?:create|finish|complete|set up|setup)\s+(?:your\s+)?(?:account|profile|organization|workspace|business)\b/i.test(
    target,
  );
}

function isBillingObjectActionTarget(target: string): boolean {
  return (
    /\b(create|save|add|finish)\b/i.test(target) &&
    /\b(product|price|pricing|subscription|billing|payment|invoice|checkout)\b/i.test(target)
  );
}

export function provisionPerceptionGuidance(pageText: string): string | undefined {
  const loginChooser = looksLikeLoginChooser(pageText);
  const appMarkers = authenticatedAppSurfaceMarkers(pageText);
  const modeMarkers = visibleModeMarkers(pageText);
  // "Create Account or Login" on a login page false-matches the setup-overlay
  // check; don't treat a login chooser as an authenticated setup surface.
  const setupOverlay = !loginChooser && hasAccountSetupOverlay(pageText);
  const parts: string[] = [];

  // Stale signup URL — the page 404'd. Recover the real entry instead of looping
  // on a dead URL (OpenRouter/Loops /signup both 404; the real forms are
  // /register etc.). First so it leads when the page is just a not-found shell.
  if (hasNotFoundPageSignal(pageText)) {
    parts.push(
      "Not-found page (404): this signup URL is stale — do NOT stop or report a wall. " +
        "Recover the real signup entry: try another path on this host (/register, " +
        "/sign-up, /join, /get-started), or navigate to the site's ROOT domain " +
        "(allow_host it if needed) and click the 'Sign up' / 'Get started' / 'Register' link.",
    );
  }

  // One-time secret reveal — extract NOW; it vanishes if you navigate away.
  if (hasOneTimeSecretModal(pageText)) {
    parts.push(
      "One-time secret: the key/secret is shown HERE and will NOT be shown again. " +
        "Extract it immediately with operate_extract (use secret_label to pick the " +
        "right field if several values are shown, and into_slot/store to capture it) " +
        "BEFORE clicking anything that could dismiss this modal or navigate away.",
    );
  }

  // Onboarding / org-creation form — fill it, don't treat it as a wall. NOT on a
  // login chooser: "Create Account or Login" (Groq) false-matched as a setup form.
  if (!loginChooser && isOnboardingOrOrgForm(pageText)) {
    parts.push(
      "Onboarding/setup form: this is NOT a wall and NOT a failure. It gates the " +
        "keys/dashboard behind a setup step. Fill the required fields with sensible " +
        "inferred values (your name; an organization/workspace/team name such as your " +
        "name or 'Personal'; pick the smallest/free plan) and submit to continue. Do " +
        "not stop or report a wall — drive through it to reach the keys page.",
    );
  }

  // Existing-account signal — you act as the user's REAL identity, which may
  // already be registered here. A fresh signup will keep failing.
  if (hasExistingAccountSignal(pageText)) {
    parts.push(
      "Existing account: you are acting as the user's REAL identity, which " +
        "already appears to have an account here (login form / 'already " +
        "registered' / 'invalid credentials'). Do NOT retry signup. Switch to " +
        "LOGGING IN — prefer the OAuth provider the user has a live session for, " +
        "or a password reset — then navigate to the EXISTING API key and extract it.",
    );
  }

  // Unlinked-OAuth signal — the OAuth identity isn't a linked account; the OAuth
  // button is sign-in only. Stop clicking it; use the email/OTP signup path.
  if (hasUnlinkedOAuthAccountSignal(pageText)) {
    parts.push(
      "Unlinked OAuth identity: the provider returned 'account not found' — your " +
        "Google/GitHub identity is not a linked account here, so the OAuth button " +
        "is sign-IN only. Do NOT keep clicking it. Switch to EMAIL signup/OTP " +
        "(submit the email field, then operate_await_verification for the code) to " +
        "create the account, then continue to the keys page.",
    );
  }

  if (modeMarkers.length > 0) {
    parts.push(`Mode marker visible: ${modeMarkers.join(", ")}.`);
  } else if (appMarkers.length > 0 || setupOverlay) {
    parts.push(
      "No test/sandbox/live mode marker is visible. For mode-sensitive tasks, do not create or save objects until the required mode is visible.",
    );
  }

  if (setupOverlay && appMarkers.length > 0) {
    parts.push(
      `Screen perception: account/setup overlay text is present while authenticated app markers are also visible (${appMarkers.join(", ")}). This often means a foreground onboarding modal is blocking an already-authenticated app, not that OAuth failed. Do not restart OAuth or navigate to login solely because the overlay says create/finish account; either satisfy the minimal required setup once, or use same-origin app navigation/direct dashboard URLs toward the user's goal.`,
    );
  } else if (appMarkers.length > 0) {
    parts.push(
      `Screen perception: authenticated app markers are visible (${appMarkers.join(", ")}). Prefer app navigation over restarting OAuth unless the current URL is clearly an identity-provider login page.`,
    );
  }

  return parts.length > 0 ? parts.join(" ") : undefined;
}

function unsafeProvisionBlockReason(
  pageText: string,
  safetySignals: PageTargetSafetySignals,
  target: string | null,
): string | null {
  const appMarkers = authenticatedAppSurfaceMarkers(pageText);
  if (appMarkers.length > 0 && safetySignals.accountSetup && hasAccountSetupOverlay(pageText)) {
    if (target === null) {
      return (
        "Perception guard: this control looks like an account/setup overlay action, " +
        "but authenticated app markers are already visible. Do not retry OAuth or " +
        "repeatedly press this overlay; use app navigation/direct same-origin URLs " +
        "or complete only the minimal required setup."
      );
    }
    return (
      `Perception guard: "${target}" looks like an account/setup overlay action, ` +
      `but authenticated app markers are already visible (${appMarkers.join(", ")}). ` +
      `Do not retry OAuth or repeatedly press this overlay; use app navigation/direct ` +
      `same-origin URLs or complete only the minimal required setup.`
    );
  }
  if (safetySignals.billingObject && /\b(?:live|production)\s+mode\b/i.test(pageText)) {
    if (target === null) {
      return (
        "Mode safety guard: this control can create or save billing objects, " +
        "but live/production mode is visible. Switch to the required test/sandbox mode before acting."
      );
    }
    return (
      `Mode safety guard: "${target}" can create or save billing objects, ` +
      `but live/production mode is visible. Switch to the required test/sandbox mode before acting.`
    );
  }
  return null;
}

export function shouldBlockUnsafeProvisionSignals(
  pageText: string,
  safetySignals: PageTargetSafetySignals,
): string | null {
  return unsafeProvisionBlockReason(pageText, safetySignals, null);
}

export function shouldBlockUnsafeProvisionAction(
  pageText: string,
  action: ProvisionAction,
  options: { redactTarget?: boolean } = {},
): string | null {
  if (!("target" in action)) return null;
  return unsafeProvisionBlockReason(
    pageText,
    {
      accountSetup: isAccountSetupActionTarget(action.target),
      billingObject: isBillingObjectActionTarget(action.target),
    },
    options.redactTarget === true ? null : action.target,
  );
}

export function buildScreenOutline(
  elements: readonly InteractiveElement[],
  pageText: string,
  sealedFieldKeys: ReadonlySet<string> = new Set<string>(),
): ScreenOutline | undefined {
  if (elements.length === 0) return undefined;
  const byRegion = new Map<string, ScreenRegion>();
  for (const el of elements) {
    const id = el.container ?? "body:root";
    const role = id.split(":")[0] ?? "region";
    const existing = byRegion.get(id);
    const region: ScreenRegion = existing ?? {
      id,
      role,
      topmost: false,
      occluded_by: null,
      children: [],
    };
    if (el.topmost === true) {
      region.topmost = true;
      region.occluded_by = null;
    } else if (
      region.occluded_by === null &&
      el.occludedBy !== null &&
      el.occludedBy !== undefined
    ) {
      region.occluded_by = el.occludedBy;
    }
    if (region.children.length < 10) {
      region.children.push({
        ref: el.screenPath ?? presentLabel(el, sealedFieldKeys),
        role: el.role,
        text: presentLabel(el, sealedFieldKeys),
        href: el.href ?? null,
        topmost: el.topmost ?? null,
        occluded_by: el.occludedBy ?? null,
      });
    }
    byRegion.set(id, region);
  }
  const regions = [...byRegion.values()].slice(0, 12);
  const foreground =
    regions.find((r) => r.topmost && r.role === "dialog")?.id ??
    regions.find((r) => r.topmost)?.id ??
    null;
  return {
    foreground,
    mode_markers: visibleModeMarkers(pageText),
    regions,
  };
}

function roleForAccessibility(el: InteractiveElement): string {
  if (el.role !== null && el.role.length > 0) return el.role;
  if (el.tag === "a") return "link";
  if (el.tag === "input") return el.type ?? "textbox";
  return el.tag;
}

// PR3 privacy — a host-facing observation reads field VALUES straight off the
// live DOM, so after a type_secret the cleartext password (or any sealed slot)
// would surface in the observation/accessibility tree the planner sees and logs.
// The whole point of prepare_login/extract is that the host only ever holds a
// MASKED handle. Mask the presented copy here; internal callers (form-fill,
// replay, postcondition length checks) read the raw InteractiveElement and are
// unaffected. A field is sealed if it's a password input or a target a secret
// slot was typed into (tracked per-session in sealedFieldKeys).
const SEALED_FIELD_PLACEHOLDER = "[sealed]";
function isSealedFieldValue(el: InteractiveElement, sealed: ReadonlySet<string>): boolean {
  if (el.sealed === true) return true;
  if ((el.type ?? "").toLowerCase() === "password") return true;
  return elementTargetKeys(el).some((k) => sealed.has(k));
}
function presentFieldValue(el: InteractiveElement, sealed: ReadonlySet<string>): string | null {
  const v = el.value ?? null;
  if (v === null || v.length === 0) return v;
  return isSealedFieldValue(el, sealed) ? SEALED_FIELD_PLACEHOLDER : v;
}
// The host-facing LABEL. elementRef falls back to a field's VALUE when it has no
// other label text — which would leak a sealed secret as the element's name. For
// a sealed field, re-derive the label with the value stripped so it lands on the
// next signal (placeholder/name) or `tag#index`, never the secret. Ref-keying
// and targeting still use the raw elementRef, so resolution is unaffected.
function presentLabel(el: InteractiveElement, sealed: ReadonlySet<string>): string {
  if (!isSealedFieldValue(el, sealed)) return elementRef(el);
  return elementRef({ ...el, value: null });
}

export function buildAccessibilitySnapshot(
  elements: readonly InteractiveElement[],
  limit = 12000,
  sealedFieldKeys: ReadonlySet<string> = new Set<string>(),
): AccessibilitySnapshot | undefined {
  if (elements.length === 0) return undefined;
  const refs = provisionElementRefs(elements);
  const byRegion = new Map<string, InteractiveElement[]>();
  for (const el of elements) {
    const region = el.container ?? "body:root";
    const group = byRegion.get(region) ?? [];
    group.push(el);
    byRegion.set(region, group);
  }

  const entries = [...byRegion.entries()];
  const structurallyTruncated =
    entries.length > 24 || entries.some(([, group]) => group.length > 16);
  const lines: string[] = ["RootWebArea"];
  for (const [region, group] of entries.slice(0, 24)) {
    lines.push(`  region "${region}"`);
    for (const el of group.slice(0, 16)) {
      const label = presentLabel(el, sealedFieldKeys).replace(/"/g, '\\"');
      const role = roleForAccessibility(el);
      const shownValue = presentFieldValue(el, sealedFieldKeys);
      const flags = [
        el.value !== undefined && el.value !== null
          ? `value="${(shownValue ?? "").slice(0, 60)}"`
          : null,
        el.checked !== undefined && el.checked !== null ? `checked=${el.checked}` : null,
        el.href !== undefined && el.href !== null ? `href="${el.href.slice(0, 120)}"` : null,
        el.topmost === false ? `occluded_by="${el.occludedBy ?? "unknown"}"` : null,
      ].filter((v): v is string => v !== null);
      lines.push(
        `    ${role} "${label}" ref=${refs.get(el) ?? provisionElementRef(el)}` +
          (flags.length > 0 ? ` ${flags.join(" ")}` : ""),
      );
    }
  }
  if (structurallyTruncated) {
    lines.push("  ... (truncated, more interactive elements omitted)");
  }

  const tree = lines.join("\n");
  if (tree.length <= limit) {
    return {
      tree,
      refs: elements.length,
      truncated: structurallyTruncated,
      total_chars: tree.length,
      source: "interactive_dom",
    };
  }
  const cut = tree.lastIndexOf("\n", limit);
  const text = tree.slice(0, cut > 0 ? cut : limit);
  return {
    tree: text,
    refs: elements.length,
    truncated: true,
    total_chars: tree.length,
    source: "interactive_dom",
  };
}

function registrableHost(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function baseDomain(host: string): string {
  const parts = host.toLowerCase().split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  return parts.slice(-2).join(".");
}

// Webmail hosts awaitVerification drives the browser INTO to read a code/link.
// They are never declared in a session's allowed_hosts (the goto gate blocks
// them); the browser only reaches them via awaitVerification's sanctioned
// internal navigation. Actions taken while parked here must NOT enter the
// replayable recipe: (a) replay re-fetches the code via awaitVerification, so a
// recorded inbox click is dead weight, and (b) the clicked row's visible text
// carries the email's subject/snippet — baking a user's inbox content into a
// shareable recipe. Identity-provider hosts (accounts.google.com, github.com)
// are NOT here — OAuth steps stay in the trace.
const INBOX_READ_HOSTS = new Set([
  "mail.google.com",
  "outlook.live.com",
  "outlook.office365.com",
  "mail.yahoo.com",
  "mail.proton.me",
]);
export function isInboxReadHost(url: string): boolean {
  const host = registrableHost(url);
  return host !== null && INBOX_READ_HOSTS.has(host);
}

function widenAllowedHostsFromCurrentUrl(session: Session): void {
  const host = registrableHost(session.browser.currentUrl());
  if (host === null || session.allowedHosts.some((e) => e.host === host)) return;
  const currentBase = baseDomain(host);
  // Chain ONLY off START-sourced hosts: an organic redirect that shares a base
  // domain with a host the user declared at start is trusted. We do NOT chain
  // off mid_session or prior auto_widen hosts — that would let a single
  // agent-declared host silently pull in a whole sibling tree (scope creep).
  if (
    session.allowedHosts.some((e) => e.source === "start" && baseDomain(e.host) === currentBase)
  ) {
    session.allowedHosts.push({ host, source: "auto_widen" });
    audit(session.id, "scope_widen", {
      host,
      source: "auto_widen",
      allowed_hosts: hostStrings(session),
    });
  }
}

// ── session lifecycle ──

export interface StartOptions {
  serviceUrl: string;
  // Persistent Chrome profile (the user's seeded session). Defaults to the
  // controller's CHROME_PROFILE_DIR.
  profileDir?: string;
  proxyUrl?: string;
  // Extra hosts to widen domain-scope (e.g. a known custom IdP/mail host).
  // Seeded with source "start" alongside the service host. A multi-app operate
  // task declares every app it spans here (GCP + Firebase + the user's app);
  // the single-service signup case passes none (the one degenerate host).
  extraAllowedHosts?: readonly string[];
  // Registry route guidance the tool layer resolved (renderSkillHint). Attached
  // to the start observation so the agent reads the map before driving.
  hint?: string;
  // Change 5 — operate tasks that act AS the user require a live Google session
  // in the bot profile before driving. When true and no live session exists,
  // start hands back (needs_user.connect) BEFORE touching the task.
  requireLiveIdentity?: boolean;
  // PR2 — may the operator read the inbox for email verification? Sourced from
  // the install-time `consent_operator_inbox_otp` flag. Default-OFF: when false,
  // awaitVerification refuses the inbox read and hands the code request back to
  // the user instead of silently reading mail. Operator/housekeeper deployments
  // set the flag true (they consent to polling their own OAuth-bound inbox).
  consentInboxRead?: boolean;
  // The MCP api-client, threaded from the operate_* tool layer. Enables the
  // captcha gate to spend a VAULTED 2Captcha key via the injecting proxy.
  api?: ApiClient;
}

// Fail-closed precondition GATE — NOT autonomous recovery. An operate task that
// acts as the user needs a LIVE Google session before it drives; absent /
// expired / 2FA-challenged → hand back BEFORE the task starts, so the
// human-in-the-loop dependency is explicit, never hidden (Codex). Pairs with the
// install-time gate (install/cli.ts) that already requires a Google session.
export interface NeedsUserConnect {
  wall: "google_session";
  message: string;
  resume: "connect";
}
export function googleSessionGate(
  liveProviders: readonly OAuthProviderId[],
): { ok: true } | { ok: false; needs_user: NeedsUserConnect } {
  if (liveProviders.includes("google")) return { ok: true };
  return {
    ok: false,
    needs_user: {
      wall: "google_session",
      message:
        "No live Google session in the bot profile, so the operator cannot act " +
        "as you yet. Refresh it with `npx @trusty-squire/mcp connect --force-relogin` " +
        "— plain `connect` may report 'already connected' from a cached marker and " +
        "skip the sign-in, so it will NOT fix a stale/expired session. Then retry " +
        "— the task has NOT started and nothing was changed.",
      resume: "connect",
    },
  };
}

async function ensureProvisionPrimaryProviderSession(
  opts: StartOptions,
  sessionId: string,
): Promise<OAuthProviderId[]> {
  const slot = warmBrowser;
  if (slot !== null) {
    const expired = warmBrowserExpired(slot);
    const eligible = slot.controller.matchesLaunchOptions(opts);
    const healthy = slot.controller.isConnected();
    if (expired === null && eligible && healthy) {
      const warmProviders = await slot.controller.detectSessionProviders();
      if (warmProviders.includes("google")) {
        touchWarmBrowser();
        return warmProviders;
      }
    }

    warmBrowser = null;
    clearWarmBrowserIdleTimer();
    await slot.controller.close().catch(() => undefined);
    audit(sessionId, "browser_recycle", {
      reason:
        expired ??
        (!eligible
          ? "launch_config_mismatch"
          : !healthy
            ? "disconnected"
            : "identity_probe_requires_cold_boot"),
    });
  }

  const initial = await detectActiveProviderSessions(opts.profileDir).catch(
    () => [] as OAuthProviderId[],
  );
  if (initial.includes("google")) return initial;

  const result = await ensureOAuthSession({
    provider: "google",
    ...(opts.profileDir !== undefined ? { profileDir: opts.profileDir } : {}),
  });
  if (result.status !== "already_valid" && result.status !== "logged_in") {
    return initial;
  }

  const after = await detectActiveProviderSessions(opts.profileDir).catch(
    () => [] as OAuthProviderId[],
  );
  return after.includes("google") ? after : ["google", ...after];
}

export async function startProvisionSession(opts: StartOptions): Promise<Observation> {
  const id = randomUUID();
  touchWarmBrowser();
  if (starting || inFlight) {
    throw new Error("operate_start refused: another operator session is already in flight");
  }
  starting = true;
  let browser: BrowserController;
  let liveProviders: OAuthProviderId[];
  try {
    liveProviders = await ensureProvisionPrimaryProviderSession(opts, id);
    // Change 5 — fail-closed identity gate BEFORE driving. If an operate task
    // needs to act as the user and there's no live Google session, hand back now;
    // do not start the browser or the task. No autonomous login is attempted.
    if (opts.requireLiveIdentity === true) {
      const gate = googleSessionGate(liveProviders);
      if (!gate.ok) {
        audit(id, "connect_gate", { ok: false, wall: "google_session" });
        return { session_id: id, url: "", text: "", elements: [], needs_user: gate.needs_user };
      }
    }
    browser = await acquireWarmBrowser(opts, id);
  } finally {
    starting = false;
  }
  const targetHost = registrableHost(opts.serviceUrl);
  const seedHosts = [
    ...(targetHost !== null ? [targetHost] : []),
    ...(opts.extraAllowedHosts ?? []),
  ];
  // All start-declared hosts are sourced "start" — auto-widen chains off these,
  // and credential egress may seed from these (but never from mid_session).
  const allowedHosts: AllowedHostEntry[] = [...new Set(seedHosts)].map((host) => ({
    host,
    source: "start" as const,
  }));
  const session: Session = {
    id,
    browser,
    allowedHosts,
    generation: 0,
    secretSlots: new Map(),
    sealedFieldKeys: new Set(),
    lastElements: [],
    prevObserve: null,
    observeSnapshotFile: null,
    actionTrace: [],
    recordedValues: [],
    committedSelectValues: new Map(),
    captureRounds: [],
    usedLocatorFallback: false,
    recipeRejectionReason: null,
    replayState: null,
    startedAt: Date.now(),
    hintServed: opts.hint !== undefined,
    startUrl: opts.serviceUrl,
    consentInboxRead: opts.consentInboxRead === true,
    userEmail: loggedInEmail("google", opts.profileDir),
    ...(opts.api !== undefined ? { api: opts.api } : {}),
  };
  sessions.set(id, session);
  inFlight = true;
  try {
    audit(id, "start", {
      service_url: opts.serviceUrl,
      allowed_hosts: hostStrings(session),
      has_hint: opts.hint !== undefined,
    });
    await browser.goto(opts.serviceUrl);
    // A cookie/consent overlay (Usercentrics/OneTrust/…) renders after load and its
    // backdrop occludes the ENTIRE form — the agent then sees every element
    // occluded_by a div and gives up, or falls back to the only thing that looks
    // clickable (e.g. a "Connect wallet" CTA on the Robinhood faucet). Dismiss it
    // BEFORE the first observation so the real actionable form is operable.
    // dismissConsentBanner() existed but had NO call sites (dead code); it only
    // clicks banner-specific CTAs (accept/reject all), so a false click is unlikely.
    // Best-effort + one retry, since the widget lazy-loads a beat after the goto.
    for (let attempt = 0; attempt < 2; attempt++) {
      const cta = await browser.dismissConsentBanner().catch(() => null);
      if (cta !== null) {
        audit(id, "consent_dismissed", { cta });
        break;
      }
      if (attempt === 0) await browser.waitForCaptchaChallengeToSettle(800, 0).catch(() => false);
    }
    const observation = await observeSession(session);
    // Tell the agent which provider the user actually has a live session for
    // (Google-preferred) — the bot knows from the profile cookies, so the agent
    // doesn't have to guess. Composed with the skill route hint (if any).
    const hintParts = [
      loginSessionGuidance(liveProviders),
      ...(opts.hint !== undefined ? [opts.hint] : []),
    ];
    return {
      ...observation,
      hint: hintParts.join("\n"),
      ...(session.userEmail !== null ? { user_email: session.userEmail } : {}),
    };
  } catch (err) {
    sessions.delete(id);
    await releaseWarmBrowserPage(browser);
    inFlight = false;
    touchWarmBrowser();
    throw err;
  }
}

export async function observe(
  sessionId: string,
  detail: "compact" | "full" = "compact",
): Promise<Observation> {
  const session = sessionForCall(sessionId);
  if (session === undefined) throw new Error(`unknown provision session ${sessionId}`);
  return await observeSession(session, detail);
}

// Hosts to seed credential EGRESS from when storing a key extracted in this
// session: start + auto_widen, NEVER mid_session task scope (a wide multi-app
// operate scope must not silently over-grant a key's egress allow-list).
export function observedHostsForSession(sessionId: string): string[] {
  const session = sessionForCall(sessionId);
  if (session === undefined) throw new Error(`unknown provision session ${sessionId}`);
  widenAllowedHostsFromCurrentUrl(session);
  return [...new Set(egressSeedHosts(session))];
}

// Mask a secret for a host-facing preview: keep a short prefix + last few
// chars, redact the middle. Never reveals enough to reconstruct the value.
export function maskSecretValue(value: string): string {
  const v = value.trim();
  if (v.length <= 8) return "••••";
  const head = v.slice(0, Math.min(6, v.length - 4));
  const tail = v.slice(-3);
  return `${head}••••${tail}`;
}

export interface SlotHandle {
  slot: string;
  preview: string;
  length: number;
}

// Stash a secret into a session-local slot and return ONLY a handle + masked
// preview. The raw value stays in the Session and is never returned to the
// host — a later type_secret enters it into another site's form. Extends the
// write-only-vault moat to in-session credential transfer.
export function stashSecretSlot(sessionId: string, slot: string, value: string): SlotHandle {
  const session = sessionForCall(sessionId);
  if (session === undefined) throw new Error(`unknown provision session ${sessionId}`);
  session.secretSlots.set(slot, value);
  // Record the SEAL in the recipe trace (the value never goes in — only that a
  // secret was sealed into this slot, so the replay rail says "reveal+seal here").
  session.actionTrace.push({ action: { kind: "extract", slot } });
  audit(sessionId, "secret_slot_set", { slot, length: value.length });
  return { slot, preview: maskSecretValue(value), length: value.length };
}

// Internal MCP tool bridge: read a sealed slot so the tool layer can persist a
// signup password to the vault after the service account is created. Never
// expose this value in a tool response or recipe trace.
export function readSecretSlotValue(sessionId: string, slot: string): string {
  const session = sessionForCall(sessionId);
  if (session === undefined) throw new Error(`unknown provision session ${sessionId}`);
  const value = session.secretSlots.get(slot);
  if (value === undefined) throw new Error(`no sealed slot named "${slot}"`);
  return value;
}

export function currentProvisionUrl(sessionId: string): string {
  const session = sessionForCall(sessionId);
  if (session === undefined) throw new Error(`unknown provision session ${sessionId}`);
  return session.browser.currentUrl();
}

// operate_pay has a deliberately small input contract with no session id: it
// acts on the one live operator checkout. Fail closed rather than guessing if
// zero or multiple browser sessions exist.
function activeProvisionSession(): Session {
  touchWarmBrowser();
  if (sessions.size !== 1) {
    throw new Error(
      sessions.size === 0
        ? "operate_pay requires one active operate_start browser session"
        : "operate_pay refused: multiple active browser sessions",
    );
  }
  const session = sessions.values().next().value!;
  if (session.replayState?.moneyPath === true && session.replayState.paymentGuard !== "verified") {
    throw new Error(
      "operate_pay refused: replay address/contact/quantity verification is not satisfied",
    );
  }
  return session;
}

export function activeProvisionBrowser(): BrowserController {
  return activeProvisionSession().browser;
}

export async function activeProvisionBrowserForPayment(): Promise<BrowserController> {
  const session = activeProvisionSession();
  const state = session.replayState;
  if (state?.moneyPath !== true) return session.browser;
  const fresh = await session.browser.extractInteractiveElements();
  session.lastElements = fresh;
  for (const expected of state.expectedFields.values()) {
    if (!state.verifiedFields.has(expected.stepIndex)) continue;
    if (!(await isReplayFieldMounted(session, expected, fresh))) {
      markReplayFailure(session, "field_missing", expected.hole);
      throw new Error(
        "operate_pay refused: replay address/contact/quantity verification is not satisfied",
      );
    }
    const guard = await verifyReplayFieldWithElements(session, expected, fresh);
    if (!guard.ok) {
      markReplayFailure(session, guard.reason, expected.hole);
      throw new Error(
        "operate_pay refused: replay address/contact/quantity verification is not satisfied",
      );
    }
  }
  return session.browser;
}

export function recordActivePaymentProvenance(cardRef: string): void {
  if (sessions.size !== 1) return;
  const session = sessions.values().next().value!;
  const last = session.actionTrace.at(-1)?.action;
  if (last?.kind === "operate_pay") return;
  const traceIndex = session.actionTrace.length;
  session.actionTrace.push({ action: { kind: "operate_pay", value: { hole: "card" } } });
  session.recordedValues.push({ traceIndex, hole: "card", literal: cardRef });
}

// PR3c — the user's own email captured at login (the authoritative signup
// address), or null when none was captured. The tool layer reads this to fill
// username/password signups so the account is user-owned.
export function getSessionUserEmail(sessionId: string): string | null {
  const session = sessionForCall(sessionId);
  if (session === undefined) throw new Error(`unknown provision session ${sessionId}`);
  return session.userEmail;
}

// PR3c — generate a strong signup password. Policy-compliant by construction
// (>=1 lower/upper/digit/symbol) so it satisfies common signup validators, then
// the remaining length is filled from the full set and the whole thing shuffled.
// Uses crypto.randomInt for unbiased selection. Length clamped to [16, 64].
const PW_LOWER = "abcdefghijkmnpqrstuvwxyz"; // no l/o
const PW_UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I/O
const PW_DIGIT = "23456789"; // no 0/1
const PW_SYMBOL = "!@#$%^&*-_=+";
const PW_ALL = PW_LOWER + PW_UPPER + PW_DIGIT + PW_SYMBOL;
export function generatePassword(length = 24): string {
  const n = Math.max(16, Math.min(64, Math.floor(length)));
  const pick = (set: string): string => set[randomInt(set.length)]!;
  const chars = [pick(PW_LOWER), pick(PW_UPPER), pick(PW_DIGIT), pick(PW_SYMBOL)];
  while (chars.length < n) chars.push(pick(PW_ALL));
  // Fisher-Yates shuffle so the guaranteed-class chars aren't always first.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join("");
}

// Observation verbosity — ONE ordered knob (docs/DESIGN-observe-compact.md), set
// per call via operate_observe{detail} / operate_act{detail}:
//   "none"    — bare ack, no perception (operate_act only; for chained fills).
//   "compact" — stable-ref element/text deltas + a complete snapshot pointer;
//               empty fields omitted, value→value_len, `path`/`container`
//               dropped from the wire, no screen/accessibility. The DEFAULT.
//   "full"    — the legacy payload: screen + accessibility + full element fields.
// The persisted compact snapshot preserves the complete inventory; see the
// design doc for reconstruction and measured savings. The planner escalates to
// "full" per call on a genuinely ambiguous step.
export type ObserveDetail = "none" | "compact" | "full";

// Type-elision (docs/DESIGN-observe-compact.md § Phase 4). `text` is always the
// default input type; `button`/`submit` are redundant only when the tag or role
// already identifies a button. Other types and unmarked input action controls
// are load-bearing and kept. Applied only to the wire form, never the persisted
// file.
const ELIDED_TYPES = new Set(["button", "submit", "text"]);

function shouldElideType(el: InteractiveElement): boolean {
  const type = (el.type ?? "").toLowerCase();
  if (!ELIDED_TYPES.has(type)) return false;
  if (type === "text") return true;
  return el.tag === "button" || (el.role ?? "").toLowerCase() === "button";
}

// One element, compacted: ref/label/tag always; every other field omitted when
// empty. `value`→`value_len` (never the raw value — keeps the sealed-field moat);
// `checked` kept for real checkables (true OR false), omitted when null;
// `topmost` only when false (the informative case); `container` dropped.
export function toCompactElement(
  el: InteractiveElement,
  ref: string,
  sealed: ReadonlySet<string>,
  // `path` is the single most verbose field and agents act by ref, not path — so
  // it is DROPPED from the default host payload (78% → 85% of the measured cut).
  // It is retained ONLY in the persisted snapshot file (includePath=true), which
  // the host can re-expand or grep. It is also excluded from the delta identity,
  // so a layout-only path shift never forces a re-emit.
  includePath = false,
  // Apply type-elision (Phase 4) to the WIRE form. The persisted file
  // form keeps full fidelity for re-expansion, so callers that write the file
  // pass false.
  elide = false,
): ObservedElement {
  const out: ObservedElement = { ref, label: presentLabel(el, sealed), tag: el.tag };
  if (el.role) out.role = el.role;
  if (el.type && !(elide && shouldElideType(el))) out.type = el.type;
  // value_len is a LENGTH signal, not the value — report the REAL character count.
  // presentFieldValue masks a sealed field to "[sealed]" (8 chars), so using its
  // length made a correctly-filled 19-char email read as value_len:8 and misled
  // the agent into thinking its fill truncated. The length isn't the secret (the
  // min_value_len postcondition already uses the real length for the same reason).
  const realLen = (el.value ?? "").length;
  if (realLen > 0) out.value_len = realLen;
  if (el.checked !== null && el.checked !== undefined) out.checked = el.checked;
  if (el.href) out.href = el.href;
  if (el.testId) out.testId = el.testId;
  if (includePath && el.screenPath) out.path = el.screenPath;
  if (el.topmost === false) out.topmost = false;
  if (el.occludedBy) out.occluded_by = el.occludedBy;
  return out;
}

// Columnar wire encoding (docs/DESIGN-observe-compact.md § Phase 4). The compact
// `elements` array repeated every field NAME on every element; a tab-delimited
// table names each column ONCE in a header line, then one terse row per element.
// Column order is CANONICAL (matches toCompactElement's field order) so a parsed
// row reconstructs byte-identically. `ref`/`label`/`tag` are always present;
// other columns appear only when at least one emitted element carries them.
const ELEMENT_TABLE_COLUMNS = [
  "ref",
  "label",
  "tag",
  "role",
  "type",
  "value_len",
  "checked",
  "href",
  "testId",
  "topmost",
  "occluded_by",
] as const;
type ElementColumn = (typeof ELEMENT_TABLE_COLUMNS)[number];

// The string cell for one column of one element, or undefined when absent.
// Booleans/numbers render as plain text; the parser coerces them back.
function elementCell(e: ObservedElement, col: ElementColumn): string | undefined {
  switch (col) {
    case "ref":
      return e.ref;
    case "label":
      return e.label;
    case "tag":
      return e.tag;
    case "role":
      return e.role ?? undefined;
    case "type":
      return e.type ?? undefined;
    case "value_len":
      return e.value_len !== undefined ? String(e.value_len) : undefined;
    case "checked":
      return e.checked === true ? "true" : e.checked === false ? "false" : undefined;
    case "href":
      return e.href ?? undefined;
    case "testId":
      return e.testId ?? undefined;
    case "topmost":
      return e.topmost === false ? "false" : undefined;
    case "occluded_by":
      return e.occluded_by ?? undefined;
  }
}

// Escape the only bytes that break the tab/newline framing. Backslash FIRST so
// the decoder's single pass is unambiguous.
function escapeCell(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\n/g, "\\n").replace(/\r/g, "\\r");
}
function unescapeCell(v: string): string {
  return v.replace(/\\(.)/g, (_m, c: string) =>
    c === "t" ? "\t" : c === "n" ? "\n" : c === "r" ? "\r" : c,
  );
}

// Encode a set of compact elements as the tab table. Returns "" for an empty set
// (the caller then omits `el_table` — an empty table costs a header for nothing).
export function encodeElementsTable(els: readonly ObservedElement[]): string {
  if (els.length === 0) return "";
  const columns = ELEMENT_TABLE_COLUMNS.filter(
    (c) =>
      c === "ref" ||
      c === "label" ||
      c === "tag" ||
      els.some((e) => elementCell(e, c) !== undefined),
  );
  const header = columns.join("\t");
  const rows = els.map((e) => columns.map((c) => escapeCell(elementCell(e, c) ?? "")).join("\t"));
  return [header, ...rows].join("\n");
}

// Inverse of encodeElementsTable — reconstruct the compact elements from the wire
// table. The delta stream's losslessness gate (INV-lossless-resync) round-trips
// through this, and it documents the EXACT parse the host performs. An empty
// cell (or a header column absent for a row) means the field is absent; only the
// three mandatory columns are always assigned.
export function parseElementsTable(table: string): ObservedElement[] {
  if (table.length === 0) return [];
  const lines = table.split("\n");
  const columns = (lines[0] ?? "").split("\t");
  const out: ObservedElement[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = (lines[i] ?? "").split("\t").map(unescapeCell);
    const e: ObservedElement = { ref: "", label: "", tag: "" };
    columns.forEach((col, idx) => {
      const raw = cells[idx] ?? "";
      if (col === "ref") e.ref = raw;
      else if (col === "label") e.label = raw;
      else if (col === "tag") e.tag = raw;
      else if (raw === "")
        return; // absent optional field
      else if (col === "role") e.role = raw;
      else if (col === "type") e.type = raw;
      else if (col === "value_len") e.value_len = Number(raw);
      else if (col === "checked") e.checked = raw === "true";
      else if (col === "href") e.href = raw;
      else if (col === "testId") e.testId = raw;
      else if (col === "topmost") e.topmost = false;
      else if (col === "occluded_by") e.occluded_by = raw;
    });
    out.push(e);
  }
  return out;
}

// The compact wire carries its element set as `el_table` (columnar); an empty set
// omits the field entirely. FULL mode keeps `elements` (JSON). One helper so both
// buildCompactObservation branches and the persist-fallback stay consistent.
function emitElements(
  els: readonly ObservedElement[],
  encode: "columnar" | "json",
): Pick<Observation, "elements" | "el_table"> {
  if (encode === "json") return { elements: [...els] };
  const table = encodeElementsTable(els);
  return table.length > 0 ? { el_table: table } : {};
}

// Session-scoped observe-snapshot persistence (docs/DESIGN-observe-compact.md).
// Reuses the best-effort writeFileSync pattern of the corpus dump-hook:
// a write failure must NEVER break an observe. Rolling one file per session (the
// latest COMPLETE inventory) — that's what the host wants when it re-expands
// after a context compaction or greps for an element the delta didn't re-show.
function observeSnapshotDir(sessionId: string): string {
  const override = (process.env.TRUSTY_SQUIRE_OBSERVE_DIR ?? "").trim();
  const parent = override.length > 0 ? override : join(tmpdir(), "trusty-squire-observe");
  return join(parent, sessionId);
}

function persistObserveSnapshot(
  session: Session,
  generation: number,
  url: string,
  text: string,
  textTruncated: boolean,
  elements: ObservedElement[],
): string | null {
  let temporaryFile: string | null = null;
  const dir = observeSnapshotDir(session.id);
  const file = join(dir, `observe-${session.id}.json`);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    temporaryFile = join(dir, `.observe-${session.id}-${generation}.tmp`);
    writeFileSync(
      temporaryFile,
      JSON.stringify(
        {
          session_id: session.id,
          generation,
          url,
          elements_total: elements.length,
          text,
          text_truncated: textTruncated,
          elements,
        },
        null,
        2,
      ),
      { encoding: "utf8", mode: 0o600 },
    );
    renameSync(temporaryFile, file);
    session.observeSnapshotFile = file;
    return file;
  } catch {
    if (temporaryFile !== null) {
      try {
        unlinkSync(temporaryFile);
      } catch {}
    }
    for (const staleFile of new Set([session.observeSnapshotFile, file])) {
      if (staleFile === null) continue;
      try {
        unlinkSync(staleFile);
      } catch {}
    }
    session.observeSnapshotFile = null;
    return null;
  }
}

// An actionable control the chrome-link collapse must NEVER drop: any
// button/input, or an element whose role is button/tab/checkbox/radio/menuitem,
// or a type=submit. Button-shaped dismiss/consent/gate controls survive by
// construction even in a chrome region; link-shaped variants are guarded
// separately by isPlainChromeLink.
export function isActionableControl(el: InteractiveElement): boolean {
  const role = (el.role ?? "").toLowerCase();
  if (
    role === "button" ||
    role === "tab" ||
    role === "checkbox" ||
    role === "radio" ||
    role === "menuitem"
  ) {
    return true;
  }
  if (el.tag === "button" || el.tag === "input") return true;
  if ((el.type ?? "").toLowerCase() === "submit") return true;
  return false;
}

// "Chrome region" per docs/DESIGN-observe-compact.md: the element's path
// root is a nav/footer/banner/aside-style landmark, OR a `section:` whose name is
// a known boilerplate block (newsletter/copyright/social/…). Site-dependent
// (measured 0% on flat DOMs, up to 57% on hoka) — a bonus, never the main win.
export function isChromeRegionPath(el: InteractiveElement): boolean {
  const path = el.screenPath ?? el.container ?? "";
  const root = (path.split(" > ")[0] ?? "").trim();
  const colon = root.indexOf(":");
  const role = (colon >= 0 ? root.slice(0, colon) : root).toLowerCase();
  const name = colon >= 0 ? root.slice(colon + 1).toLowerCase() : "";
  if (
    role === "navigation" ||
    role === "footer" ||
    role === "contentinfo" ||
    role === "banner" ||
    role === "complementary" ||
    role === "aside"
  ) {
    return true;
  }
  if (role === "section") {
    return /newsletter|copyright|trustpilot|accepted-payment|social|footer|shop-the-collection/.test(
      name,
    );
  }
  return false;
}

// A label that reads as a dismiss / consent / gate action — the collapse must
// keep these even when they are shipped as a chrome-region <a>, and even when the
// consent banner gives them a real fallback URL. Errs toward KEEPING (a false
// positive keeps a nav link, which is safe; a false negative would drop a
// dismiss control, which is not) — so it covers the accept/reject vocabulary AND
// its opposites (decline/agree/allow) and the "preferences/opt out/got it" verbs.
const DISMISS_CONSENT_LABEL_RE =
  /close|dismiss|skip|no thanks|accept|reject|decline|agree|allow|cookie|consent|preferences|opt.?out|not now|maybe later|got it/i;

// A PLAIN chrome-region NAVIGATION link — the ONLY thing the collapse removes.
// Buttons, inputs, and role-controls are never plain links (isActionableControl
// short-circuits), so they are always kept regardless of region. Beyond that, a
// link is treated as a NAVIGATION link (collapsible) ONLY when it clearly is one;
// anything that could be a dismiss/consent control is kept:
//   - no href, a `#`-fragment href, or a `javascript:` href → an action-link, not
//     navigation (a "Close banner"/"Manage cookies" anchor) → KEEP.
//   - inConsentWidget → part of a cookie/consent banner → KEEP.
//   - label matches a dismiss/consent pattern (close/dismiss/accept/reject/cookie/
//     …) → KEEP even with a real fallback URL (consent banners often provide one).
// This closes the "a dismiss control shipped as a bare/consent <a> gets dropped"
// gap: only true, non-consent navigation links are collapsible.
export function isPlainChromeLink(el: InteractiveElement): boolean {
  if (isActionableControl(el)) return false;
  const isLink = el.tag === "a" || (el.role ?? "").toLowerCase() === "link";
  if (!isLink) return false;
  if (!isChromeRegionPath(el)) return false;
  if (el.inConsentWidget === true) return false;
  const href = (el.href ?? "").trim();
  if (href.length === 0 || href.startsWith("#") || href.toLowerCase().startsWith("javascript:")) {
    return false;
  }
  if (DISMISS_CONSENT_LABEL_RE.test(elementRef(el))) return false;
  return true;
}

// Fraction of the previous element set that changed (added/changed + removed).
// Above this an observe emits a FULL snapshot instead of a delta — a big SPA
// re-render is clearer whole, and a delta that touches most of the page is barely
// smaller than the full set anyway.
const OBSERVE_CHURN_FULL_THRESHOLD = 0.6;

// The delta baseline carried between observes: the previous observation's URL,
// its stable-ref → serialized-compact-element map (payload form, `path`
// excluded), and its normalized page text (for the text delta).
export interface ObserveDeltaState {
  url: string;
  byRef: Map<string, string>;
  text: string;
}

export interface CompactObservationBuild {
  // The emitted payload. `snapshot_file` is added by the caller after it persists
  // the complete snapshot (so this pure core stays filesystem-free).
  observation: Observation;
  // The COMPLETE compact set (path EXCLUDED) keyed by ref — the reconstruction
  // ground truth: emitted wire records are a subset on a delta/collapse.
  fullByRef: Map<string, ObservedElement>;
  // The COMPLETE snapshot the caller persists to the session file (path INCLUDED).
  fileElements: ObservedElement[];
  // The baseline to hand the NEXT observe.
  nextState: ObserveDeltaState;
}

// Pure core of the compact/delta observe path — no browser, no filesystem — so
// the delta invariants (lossless resync, actionable-never-dropped, token budget)
// are unit-testable over synthetic element sequences. observeSession supplies the
// live elements/text/url; this decides delta-vs-full, applies the chrome-link
// collapse, and returns both the emit and the complete ground-truth set.
export function buildCompactObservation(args: {
  sessionId: string;
  url: string;
  text: string;
  textTruncated?: boolean;
  guidance?: string;
  elements: readonly InteractiveElement[];
  sealed?: ReadonlySet<string>;
  prev: ObserveDeltaState | null;
  // Wire encoding of the emitted element set. Default "columnar" (the tab table).
  // The eval harness passes "json" to measure the columnar transform's marginal
  // against the pre-columnar payload; production always uses the default.
  encode?: "columnar" | "json";
  // Apply Phase-4 type-elision to the wire element form. Default true; the eval
  // harness passes false to isolate the type-elision transform's marginal.
  elide?: boolean;
}): CompactObservationBuild {
  const { sessionId, url, text, elements, prev } = args;
  const sealed = args.sealed ?? new Set<string>();
  const encode = args.encode ?? "columnar";
  const elide = args.elide ?? true;
  const refs = provisionElementRefs(elements);
  const refOf = (el: InteractiveElement): string => refs.get(el) ?? provisionElementRef(el);

  const fullByRef = new Map<string, ObservedElement>();
  const serializedByRef = new Map<string, string>();
  const fileElements: ObservedElement[] = [];
  for (const el of elements) {
    const ref = refOf(el);
    fullByRef.set(ref, toCompactElement(el, ref, sealed, false, elide));
    serializedByRef.set(ref, JSON.stringify(fullByRef.get(ref)));
    // The persisted file keeps FULL fidelity (path included, no elision) so a
    // re-expansion after a host compaction loses nothing.
    fileElements.push(toCompactElement(el, ref, sealed, true, false));
  }
  const nextState: ObserveDeltaState = { url, byRef: serializedByRef, text };

  const base: Observation = {
    session_id: sessionId,
    url,
    text,
    ...(args.guidance !== undefined ? { guidance: args.guidance } : {}),
    elements_total: elements.length,
    ...(args.textTruncated === true ? { text_truncated: true } : {}),
  };

  // Delta path: same URL as last observe, and churn under the threshold.
  if (prev !== null && prev.url === url) {
    const changed: ObservedElement[] = [];
    let unchanged = 0;
    for (const [ref, ser] of serializedByRef) {
      if (prev.byRef.get(ref) === ser) unchanged += 1;
      else changed.push(fullByRef.get(ref) as ObservedElement);
    }
    const removed = [...prev.byRef.keys()].filter((ref) => !serializedByRef.has(ref));
    const churn = changed.length + removed.length;
    if (churn / Math.max(prev.byRef.size, 1) <= OBSERVE_CHURN_FULL_THRESHOLD) {
      // Text delta: emit the blob empty + a marker when it's byte-identical to
      // the previous observe (the host reuses the prior text; the full text is in
      // snapshot_file). Otherwise emit it in full.
      const textUnchanged = prev.text === text;
      return {
        observation: {
          ...base,
          ...(textUnchanged ? { text: "", text_unchanged: true } : {}),
          ...emitElements(changed, encode),
          delta: true,
          unchanged,
          ...(removed.length > 0 ? { removed } : {}),
        },
        fullByRef,
        fileElements,
        nextState,
      };
    }
  }

  // FULL compact snapshot — first observe / URL change / high churn. Only HERE do
  // we collapse plain chrome-region links (never a button/input/dismiss control);
  // the collapsed links stay in the persisted snapshot.
  const emitted: ObservedElement[] = [];
  let chromeLinksCollapsed = 0;
  for (const el of elements) {
    if (isPlainChromeLink(el)) {
      chromeLinksCollapsed += 1;
      continue;
    }
    emitted.push(fullByRef.get(refOf(el)) as ObservedElement);
  }
  return {
    observation: {
      ...base,
      ...emitElements(emitted, encode),
      delta: false,
      ...(chromeLinksCollapsed > 0 ? { chrome_links_collapsed: chromeLinksCollapsed } : {}),
    },
    fullByRef,
    fileElements,
    nextState,
  };
}

async function observeSession(
  session: Session,
  detail: "compact" | "full" = "compact",
): Promise<Observation> {
  session.browser.recoverActivePage();
  widenAllowedHostsFromCurrentUrl(session);
  session.generation += 1;
  const generation = session.generation;
  const elements = await session.browser.extractInteractiveElements();
  session.lastElements = elements;
  const text = await session.browser.extractVisibleText();
  const normalizedFull = text.replace(/\s+/g, " ").trim();
  const normalizedText = normalizedFull.slice(0, 4000);
  const guidance = provisionPerceptionGuidance(normalizedText);
  const url = session.browser.currentUrl();
  const refs = provisionElementRefs(elements);
  const refOf = (el: InteractiveElement): string => refs.get(el) ?? provisionElementRef(el);
  const textTruncated = normalizedFull.length > 4000;

  // Compact (default): the delta path, computed by the pure core.
  if (detail !== "full") {
    const built = buildCompactObservation({
      sessionId: session.id,
      url,
      text: normalizedText,
      textTruncated,
      ...(guidance !== undefined ? { guidance } : {}),
      elements,
      sealed: session.sealedFieldKeys,
      prev: session.prevObserve,
    });
    // Persist the COMPLETE snapshot (path INCLUDED) — the safety net that makes
    // delta safe: the host re-expands the full inventory from here.
    const snapshotFile = persistObserveSnapshot(
      session,
      generation,
      url,
      normalizedText,
      textTruncated,
      built.fileElements,
    );
    if (snapshotFile === null) {
      // Persistence FAILED, so no recovery file exists. A delta (which omits
      // unchanged elements) or a collapsed full snapshot (which omits chrome
      // links) would be UNRECOVERABLE — the host would have no way to re-expand.
      // Fall back to a FULL, UNCOLLAPSED response (every element inline). And
      // INVALIDATE the delta baseline (null, not "leave it at the last good
      // state"): the host's reconstruction is now THIS full set, so the next
      // observe must emit a fresh FULL snapshot too, never a delta computed
      // against the last-persisted baseline — that stale-baseline delta would
      // desync a host that has already moved to this full state (a
      // remove-then-restore-across-a-failed-persist sequence would silently drop
      // the restored element otherwise).
      session.prevObserve = null;
      return {
        session_id: session.id,
        url,
        text: normalizedText,
        ...(guidance !== undefined ? { guidance } : {}),
        // Still a COMPACT response — carry the (uncollapsed) set as the columnar
        // table so the host parses it the same way as any other compact observe.
        ...emitElements([...built.fullByRef.values()], "columnar"),
        delta: false,
        elements_total: elements.length,
        ...(textTruncated ? { text_truncated: true } : {}),
      };
    }
    session.prevObserve = built.nextState;
    return {
      ...built.observation,
      snapshot_file: snapshotFile,
    };
  }

  // Full (legacy rich) path — the explicit escape hatch. Byte-identical to the
  // pre-delta full payload: every element with every field, screen, and
  // accessibility, never a delta and never a chrome collapse.
  session.prevObserve = null;
  // Refresh the persisted snapshot as a SIDE EFFECT so a re-expansion after a
  // full-only observe can't restore stale state (the previous compact snapshot).
  // Deliberately NOT surfaced in the payload — the full escape hatch stays
  // byte-equivalent to the legacy shape (no snapshot_file field added).
  persistObserveSnapshot(
    session,
    generation,
    url,
    normalizedText,
    textTruncated,
    elements.map((el) => toCompactElement(el, refOf(el), session.sealedFieldKeys, true)),
  );
  const screen = buildScreenOutline(elements, normalizedText, session.sealedFieldKeys);
  const accessibility = buildAccessibilitySnapshot(elements, undefined, session.sealedFieldKeys);
  return {
    session_id: session.id,
    url,
    text: normalizedText,
    ...(guidance !== undefined ? { guidance } : {}),
    ...(screen !== undefined ? { screen } : {}),
    ...(accessibility !== undefined ? { accessibility } : {}),
    elements: elements.map((el) => ({
      ref: refOf(el),
      label: presentLabel(el, session.sealedFieldKeys),
      tag: el.tag,
      role: el.role,
      type: el.type,
      value: presentFieldValue(el, session.sealedFieldKeys),
      checked: el.checked ?? null,
      href: el.href ?? null,
      testId: el.testId ?? null,
      path: el.screenPath ?? null,
      container: el.container ?? null,
      topmost: el.topmost ?? null,
      occluded_by: el.occludedBy ?? null,
    })),
  };
}

export async function act(
  sessionId: string,
  action: ProvisionAction,
  detail: ObserveDetail = "compact",
): Promise<Observation> {
  const session = sessionForCall(sessionId);
  if (session === undefined) throw new Error(`unknown provision session ${sessionId}`);
  if (
    action.kind === "type_secret" &&
    action.provenance !== undefined &&
    action.provenance.hole !== `credential.${action.slot}`
  ) {
    throw new Error(
      `type_secret provenance must match the authoritative slot credential.${action.slot}`,
    );
  }
  const { browser } = session;
  let completedAction: ProvisionAction = action;
  let sensitiveSource: RecordedValueSource | undefined;
  const auditTarget =
    "target" in action && parseLocatorTarget(action.target) !== null
      ? "<mode>=<redacted>"
      : "target" in action
        ? action.target
        : undefined;
  audit(sessionId, "act", {
    kind: action.kind,
    ...(auditTarget !== undefined ? { target: auditTarget } : {}),
    ...("url" in action ? { url: action.url } : {}),
  });

  // The URL the action is taken ON — captured BEFORE the action navigates. The
  // capture round pairs this with the pre-action inventory + observed; using
  // currentUrl() after the action recorded the POST-navigation URL (an OAuth
  // click that redirected turned round 0's URL into the post-login dashboard,
  // corrupting the skill's entry_url and the login step).
  const urlBeforeAction = browser.currentUrl();

  // Defense-in-depth for the confused-deputy guard: if an ORGANIC redirect (not
  // gated by hostAllowed) has landed the operator browser on Squire's own
  // control plane, refuse to ACT on it — so the agent can't drive the vault
  // login/OAuth or click "reveal". `goto` is still permitted so the agent can
  // escape (and goto TO a control-plane host is already denied by hostAllowed).
  if (action.kind !== "goto") {
    let curHost: string | null = null;
    try {
      curHost = new URL(urlBeforeAction).hostname;
    } catch {
      curHost = null;
    }
    if (curHost !== null && isSquireControlPlaneHost(curHost)) {
      throw new Error(
        `action refused: the browser is on Squire's own control plane (${curHost}). ` +
          `The operator may not act on the Trusty Squire vault/app — navigate away with goto.`,
      );
    }
  }

  const recordingTransitionFields = await attestRecordedFieldsBeforeTransition(session, action);

  // Captured for the operator-recipe trace: the element a target action
  // resolved to, so we record the VISIBLE text it acted on (not the ref).
  let resolvedEl: InteractiveElement | null = null;
  switch (action.kind) {
    case "goto": {
      if (!hostAllowed(action.url, hostStrings(session))) {
        throw new Error(
          `goto blocked by domain-scope: ${action.url} is outside the allowed hosts ` +
            `[${hostStrings(session).join(", ")}] + auth providers. ` +
            `Declare it first with an allow_host action if this task spans it.`,
        );
      }
      await browser.goto(action.url);
      break;
    }
    case "allow_host": {
      const checked = validateAllowHost(action.host);
      if ("error" in checked) {
        throw new Error(`allow_host rejected "${action.host}": ${checked.error}`);
      }
      if (!session.allowedHosts.some((e) => e.host === checked.host)) {
        session.allowedHosts.push({ host: checked.host, source: "mid_session" });
        audit(sessionId, "allow_host", { host: checked.host, allowed_hosts: hostStrings(session) });
      }
      break;
    }
    case "press": {
      await browser.pressKey(action.key);
      break;
    }
    case "oauth_settle": {
      await browser.settleAfterOAuth();
      break;
    }
    case "scroll": {
      await browser.scrollViewport(action.direction ?? "down");
      break;
    }
    case "type_secret": {
      const value = session.secretSlots.get(action.slot);
      if (value === undefined) {
        throw new Error(
          `type_secret: no sealed slot named "${action.slot}". Capture it first with ` +
            `operate_extract { into_slot: "${action.slot}" }. Known slots: ` +
            `[${[...session.secretSlots.keys()].join(", ")}]`,
        );
      }
      sensitiveSource = {
        traceIndex: -1,
        hole: `credential.${action.slot}`,
        literal: value,
      };
      const fresh = await browser.extractInteractiveElements();
      session.lastElements = fresh;
      // resolveTarget recomputes identities (incl. volatile positional-group
      // fingerprints) from these FRESH elements, so a ref whose group fingerprint
      // changed since the last observe resolves to null, not a survivor (#399).
      const el = resolveTarget(fresh, action.target);
      if (el === null) {
        throw new Error(`type_secret: no element matched target "${action.target}".`);
      }
      resolvedEl = el;
      // Remember this field so the next observation masks its DOM value — the
      // host sealed this secret into a slot and must never read it back.
      for (const key of elementTargetKeys(el)) session.sealedFieldKeys.add(key);
      // Type the REAL value into the page. It crosses only browser↔page; the
      // value is never returned to the host and never logged.
      await browser.type(el.selector, value);
      audit(sessionId, "type_secret", {
        slot: action.slot,
        target: action.target,
        host: registrableHost(browser.currentUrl()),
      });
      break;
    }
    case "select": {
      // Re-resolve against FRESH elements — the target may be the <select> or
      // its <label>; browser.selectOption walks label→control and handles the
      // native vs custom-listbox split. text is the fuzzy option matcher.
      const fresh = await browser.extractInteractiveElements();
      session.lastElements = fresh;
      const el = resolveTarget(fresh, action.target);
      if (el === null) {
        throw new Error(
          `select: no element matched target "${action.target}". Visible: ` +
            fresh
              .map((e) => `"${e.screenPath ?? elementRef(e)}"`)
              .slice(0, 20)
              .join(", "),
        );
      }
      resolvedEl = el;
      const committedText = await browser.selectOption(el.selector, action.text);
      session.committedSelectValues.set(el.selector, committedText);
      completedAction = { ...action, text: committedText };
      await settleAfterStateChange(browser);
      break;
    }
    case "set_phone_country": {
      // No captured element — the bot finds the phone-local native <select>.
      // resolvedEl stays null; the step records without a captured-element
      // trace (the country is host-replannable, not a replay recipe).
      await browser.setPhoneCountry(action.country);
      await settleAfterStateChange(browser);
      break;
    }
    case "click":
    case "js_click":
    case "type":
    case "upload":
    case "oauth_click": {
      const pageText = await browser.extractVisibleText();
      const blockReason = shouldBlockUnsafeProvisionAction(pageText, action);
      if (blockReason !== null) throw new Error(blockReason);
      // Locator-form target (`text=…` / `css=…`): the host is pointing at a
      // control that has NO `@e:` ref because the inventory never emitted it (a
      // bare click-handler <div> with no role/label, e.g. a SPA "Add To Cart"
      // that falls past the card-scan cap). Resolve it directly against the live
      // page instead of the extracted-element list.
      const locator = parseLocatorTarget(action.target);
      if (locator !== null) {
        // text=/css= is a CLICK escape hatch only. `type` gates on click
        // affordance / non-editable text so it can't target a form input, and
        // upload/oauth_click have bespoke flows — reject them explicitly.
        if (action.kind !== "click" && action.kind !== "js_click") {
          throw new Error(
            `operate_act kind="${action.kind}" does not accept a text=/css= locator target; ` +
              `text=/css= is for clicking (click / js_click). Use an @e: ref from operate_observe.`,
          );
        }
        const resolved = await browser.resolvePageTarget(locator.mode, locator.value);
        if (!resolved.ok) {
          if (resolved.reason === "none") {
            throw new Error(
              `no element matched locator "${action.target}". If the control is visible, ` +
                `try a shorter/exact text= label or a css=<selector>.`,
            );
          }
          throw new AmbiguousProvisionTargetError(action.target, resolved.candidates);
        }
        // The unsafe-action guard above inspected the RAW target, so an opaque
        // `css=<selector>` (or any target whose string carries no verb/noun the
        // guard matches) could resolve to a destructive billing/setup control the
        // guard couldn't see through — clicking "Save product" in live mode via
        // css=#submit. Re-run it against compact safety signals computed from the
        // resolved control now that we know what the locator actually points at.
        // Mark the session non-promotable BEFORE the click: a locator click can't
        // be replayed from the inventory (the element was never in it), so a
        // skill synthesized from this run would silently omit the step. Setting
        // it up front means a click that lands but then throws still can't leave
        // the session promotable (see captureAndPromoteSession) (codex).
        try {
          const resolvedBlock = shouldBlockUnsafeProvisionSignals(pageText, resolved.safetySignals);
          if (resolvedBlock !== null) throw new Error(resolvedBlock);
          session.usedLocatorFallback = true;
          if (action.kind === "click") await browser.clickHandle(resolved.handle);
          else await browser.jsClickHandle(resolved.handle);
        } finally {
          await resolved.handle.dispose().catch(() => undefined);
        }
        audit(sessionId, action.kind, {
          locator_mode: locator.mode,
          host: registrableHost(browser.currentUrl()),
        });
        await settleAfterStateChange(browser);
        break;
      }
      // Re-resolve against FRESH elements every act — never trust a stale index.
      const fresh = await browser.extractInteractiveElements();
      session.lastElements = fresh;
      // resolveTarget recomputes identities (incl. volatile positional-group
      // fingerprints) from these FRESH elements, so a ref whose group fingerprint
      // changed since the last observe resolves to null, not a survivor (#399).
      const el = resolveTarget(fresh, action.target);
      if (el === null) {
        throw new Error(
          `no element matched target "${action.target}". Visible: ` +
            fresh
              .map((e) => `"${e.screenPath ?? elementRef(e)}"`)
              .slice(0, 20)
              .join(", "),
        );
      }
      resolvedEl = el;
      if (action.kind === "click") await browser.click(el.selector);
      else if (action.kind === "js_click") await browser.clickViaJs(el.selector);
      else if (action.kind === "type") {
        session.committedSelectValues.delete(el.selector);
        await browser.type(el.selector, action.text);
      } else if (action.kind === "upload") {
        await browser.uploadFile(el.selector, action.path);
        audit(sessionId, "upload", {
          target: action.target,
          path: action.path,
          host: registrableHost(browser.currentUrl()),
        });
      } else await browser.startOAuth(el.selector);
      if (action.kind !== "type") await settleAfterStateChange(browser);
      break;
    }
  }
  await verifyRecordedFieldsAfterTransition(session, action, recordingTransitionFields);
  await captureReplayRepairVerification(session, completedAction, resolvedEl);
  await refreshReplayVerificationAfterAction(session, completedAction, resolvedEl);
  // Don't fold inbox-provider steps into the replayable recipe (see
  // INBOX_READ_HOSTS): replay re-reads the code via awaitVerification, and a
  // recorded inbox click would bake the email's subject into a shared recipe.
  if (!isInboxReadHost(browser.currentUrl())) {
    recordTrace(session, completedAction, resolvedEl, sensitiveSource);
    recordCaptureRound(session, completedAction, resolvedEl, urlBeforeAction);
  }
  // `detail:"none"` returns a minimal ack (the action ran; no perception emitted)
  // so multi-field fills don't each echo the page. The host must call
  // operate_observe before its next ref-targeted act (refs aren't refreshed here).
  if (detail === "none") {
    return {
      session_id: session.id,
      url: browser.currentUrl(),
      text: "",
      elements: [],
      observed: "none",
    };
  }
  return await observeSession(session, detail);
}

// PR3 privacy: in the operator model the host fills the USER's real email into
// signup forms (no Squire alias anymore). The recipe trace must NOT persist that
// literal address — it would land in operator recipes and any skill synthesized
// from them. Templatize an email-shaped `type` value to the established email
// slot token so the trace stays a recipe, not a record of someone's address.
// Mirrors the synthesizer's looksLikeEmail check (promote-to-skill.ts). The token
// name keeps its legacy form for corpus compatibility (validateReplayGraph and
// published skills key off it); it now means "the email to fill", not a Squire alias.
const EMAIL_SLOT_TEMPLATE = "${EMAIL_ALIAS}";

type EmailEncodingOperation = "URI" | "CSS";

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function nestedPercentByte(byte: number): string {
  return `%(?:25)*${byte.toString(16).padStart(2, "0")}`;
}

function encodedCharacterPattern(char: string): string {
  const raw = regexEscape(char);
  const percent = [...Buffer.from(char)].map(nestedPercentByte).join("");
  const encoded = `(?:${raw}|${percent})`;
  const slash = `(?:\\\\|${nestedPercentByte(0x5c)})`;
  const cssSimple = /[a-zA-Z0-9_-]/.test(char) ? null : `${slash}${encoded}`;
  const cssHex = `${slash}${[...char.codePointAt(0)!.toString(16)]
    .map((digit) => `(?:${digit}|${nestedPercentByte(digit.charCodeAt(0))})`)
    .join("")}(?:(?:\\s|${nestedPercentByte(0x20)}))?`;
  return `(?:${[encoded, cssSimple, cssHex].filter(Boolean).join("|")})`;
}

function decodeUriLayer(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function decodeCssLayer(value: string): string {
  return value.replace(
    /\\([0-9a-f]{1,6})(?:\r\n|[\t\n\f\r ])?|\\([^\r\n\f])/gi,
    (_match, hex: string | undefined, escaped: string | undefined) =>
      hex === undefined ? (escaped ?? "") : String.fromCodePoint(Number.parseInt(hex, 16)),
  );
}

function applyEmailEncoding(value: string, operations: readonly EmailEncodingOperation[]): string {
  return operations.reduce(
    (encoded, operation) =>
      operation === "URI" ? encodeURIComponent(encoded) : cssEscapeRecipeValue(encoded),
    value,
  );
}

function emailTemplateForRepresentation(representation: string, email: string): string | null {
  const queue: Array<{ value: string; inverse: EmailEncodingOperation[] }> = [
    { value: representation, inverse: [] },
  ];
  const seen = new Set<string>();
  let fallback: EmailEncodingOperation[] | null = null;
  while (queue.length > 0 && seen.size <= 4096) {
    const current = queue.shift()!;
    const key = `${current.value}\0${current.inverse.join("_")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (current.value.toLowerCase() === email.toLowerCase()) {
      const operations = [...current.inverse].reverse();
      if (applyEmailEncoding(email, operations).toLowerCase() === representation.toLowerCase()) {
        return `\${EMAIL_ALIAS${operations.map((operation) => `_${operation}`).join("")}}`;
      }
      fallback ??= operations;
      continue;
    }
    const uriDecoded = decodeUriLayer(current.value);
    if (uriDecoded !== current.value) {
      queue.push({ value: uriDecoded, inverse: [...current.inverse, "URI"] });
    }
    const cssDecoded = decodeCssLayer(current.value);
    if (cssDecoded !== current.value) {
      queue.push({ value: cssDecoded, inverse: [...current.inverse, "CSS"] });
    }
  }
  return fallback === null
    ? null
    : `\${EMAIL_ALIAS${fallback.map((operation) => `_${operation}`).join("")}}`;
}
const REPLAY_VERIFIED_HOLE = /^(?:address|contact)(?:\.|$)|^quantity$/;
function looksLikeEmailValue(v: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.trim());
}
// Exported for unit tests.
export function redactEmailForTrace(value: string): string {
  return looksLikeEmailValue(value) ? EMAIL_SLOT_TEMPLATE : value;
}

// PR3d — exact-scrub the KNOWN user email wherever it appears in a trace string
// (not just a whole-value email field). In the operator path the host fills the
// user's real address, which can also surface in a targeted element's visible
// text (e.g. a "signed in as ada@x.com" chip the action hit). We know the exact
// address (session.userEmail), so replace every occurrence with the slot token
// before it's persisted to a recipe. (onboarding-capture observation frames are
// NOT a vector here — that path belonged to the retired autonomous bot and is
// not wired into operate_*.) Exported for unit tests.
export function scrubKnownEmail(s: string, userEmail: string | null): string {
  if (userEmail === null || userEmail.length === 0) return s;
  const pattern = [...userEmail].map(encodedCharacterPattern).join("");
  return s.replace(new RegExp(pattern, "gi"), (matched) => {
    const template = emailTemplateForRepresentation(matched, userEmail);
    if (template === null) {
      throw new Error("known email encoding could not be provenance-templated");
    }
    return template;
  });
}

function assertRecipeEmailScrubbed(recipe: OperatorRecipe, userEmail: string | null): void {
  const serialized = JSON.stringify(recipe);
  if (scrubKnownEmail(serialized, userEmail) !== serialized) {
    throw new Error("operate_remember refused: known email remains in serialized recipe data");
  }
}

// Append a stable-attribute-targeted entry to the session's operator-recipe
// trace. Stores no ref/coordinate; visible text remains a unique-only fallback.
// `extract` (the seal) is recorded separately in stashSecretSlot.
function traceTextFor(el: InteractiveElement | null): string | undefined {
  if (el === null) return undefined;
  const keys = elementTargetKeys(el);
  const first = keys[0];
  return typeof first === "string" && first.length > 0 ? first.slice(0, 120) : undefined;
}

// Stable attributes already present in the inventory and consumed by the
// skill synthesizer. Keep all of them; replay chooses in a fixed order.
export function recipeTargetFor(
  el: InteractiveElement | null,
  inventory: readonly InteractiveElement[] = [],
  userEmail: string | null = null,
): RecipeTarget | undefined {
  if (el === null) return undefined;
  const role =
    el.role ??
    (el.tag === "button"
      ? "button"
      : el.tag === "a"
        ? "link"
        : el.tag === "input" || el.tag === "textarea"
          ? "textbox"
          : undefined);
  const accessibleName =
    el.ariaLabel ??
    el.labelText ??
    el.visibleText ??
    el.iconLabel ??
    el.placeholder ??
    el.title ??
    el.name ??
    undefined;
  const siblings = inventory.filter((candidate) => {
    if (candidate === el || candidate.selector === el.selector) return false;
    const candidateName =
      candidate.ariaLabel ??
      candidate.labelText ??
      candidate.visibleText ??
      candidate.iconLabel ??
      candidate.placeholder ??
      candidate.title ??
      candidate.name ??
      undefined;
    return (
      (el.testId !== null && el.testId !== undefined && candidate.testId === el.testId) ||
      (el.id !== null && candidate.id === el.id) ||
      (el.name !== null && candidate.name === el.name) ||
      (accessibleName !== undefined && candidateName === accessibleName) ||
      (el.href !== null && el.href !== undefined && candidate.href === el.href)
    );
  });
  const nearText = siblings.length > 0 ? pickRowDisambiguator(el, siblings, inventory) : null;
  const domHint = pickStableDomHint(el);
  const hrefHint = pickHrefHint(el);
  const scrub = (value: string): string => scrubKnownEmail(value, userEmail);
  return {
    ...(domHint !== undefined
      ? {
          dom_hint: {
            ...(domHint.testid !== undefined ? { testid: scrub(domHint.testid) } : {}),
            ...(domHint.id !== undefined ? { id: scrub(domHint.id) } : {}),
            ...(domHint.name !== undefined ? { name: scrub(domHint.name) } : {}),
          },
        }
      : {}),
    ...(role !== undefined && role.length > 0 ? { role_hint: scrub(role) } : {}),
    ...(accessibleName !== undefined && accessibleName.length > 0
      ? { accessible_name: scrub(accessibleName) }
      : {}),
    ...(nearText !== null ? { near_text_hint: scrub(nearText) } : {}),
    ...(hrefHint !== null && !isSingleUseUrl(el.href ?? "") ? { href_hint: scrub(hrefHint) } : {}),
    ...(el.selector.length > 0 ? { css: scrub(el.selector) } : {}),
    ...(el.visibleText !== null && el.visibleText.length > 0
      ? { visible_text: scrub(el.visibleText) }
      : {}),
  };
}

function recordTrace(
  session: Session,
  action: ProvisionAction,
  el: InteractiveElement | null,
  sensitiveSource?: RecordedValueSource,
): void {
  // Never freeze a single-use link (email-verify / magic / reset token) into
  // the recipe — it's dead on the next replay. The host agent re-plans the
  // verification step live (operate_await_verification fetches a FRESH link)
  // when it reaches that state, per the "recipe is a MAP, not a script" model.
  if (action.kind === "goto" && isSingleUseUrl(action.url)) {
    // Log only the host — never the token-bearing URL.
    let host = "?";
    try {
      host = new URL(action.url).host;
    } catch {
      /* keep "?" */
    }
    audit(session.id, "trace_skip_single_use_goto", { url_host: host });
    return;
  }
  // An upload attaches a machine-local file — not portable, never part of a
  // shared recipe. Skip it here (the action is still in the audit trail).
  if (action.kind === "upload") return;
  const knownEmailHole =
    action.kind === "type" &&
    action.provenance === undefined &&
    session.userEmail !== null &&
    action.text === session.userEmail
      ? "contact.email"
      : undefined;
  const actionHole =
    action.kind === "type" || action.kind === "select" || action.kind === "set_phone_country"
      ? (action.provenance?.hole ?? knownEmailHole)
      : undefined;
  const rawText = traceTextFor(el);
  const text = rawText !== undefined ? scrubKnownEmail(rawText, session.userEmail) : undefined;
  const withText = text !== undefined ? { text_match: text } : {};
  const target = recipeTargetFor(el, session.lastElements, session.userEmail);
  const withTarget = target !== undefined ? { target } : {};
  let a: TraceAction;
  switch (action.kind) {
    case "goto":
      a = { kind: "goto", url_template: scrubKnownEmail(action.url, session.userEmail) };
      break;
    case "allow_host":
      a = { kind: "allow_host", host: action.host };
      break;
    case "press":
      a = { kind: "press", key: action.key };
      break;
    case "oauth_settle":
      a = { kind: "oauth_settle" };
      break;
    case "scroll":
      a = {
        kind: "scroll",
        ...(action.direction !== undefined ? { direction: action.direction } : {}),
      };
      break;
    case "type":
      a = {
        kind: "type",
        ...withText,
        ...withTarget,
        value: scrubKnownEmail(redactEmailForTrace(action.text), session.userEmail),
      };
      break;
    case "type_secret":
      a = {
        kind: "type_secret",
        slot: action.slot,
        value: { hole: `credential.${action.slot}` },
        ...withText,
        ...withTarget,
      };
      break;
    case "select":
      a = {
        kind: "select",
        value: action.text,
        ...withText,
        ...withTarget,
      };
      break;
    case "set_phone_country":
      a = {
        kind: "set_phone_country",
        value: action.country,
      };
      break;
    case "click":
      a = { kind: "click", ...withText, ...withTarget };
      break;
    case "js_click":
      a = { kind: "js_click", ...withText, ...withTarget };
      break;
    case "oauth_click":
      a = { kind: "oauth_click", ...withText, ...withTarget };
      break;
  }
  const traceIndex = session.actionTrace.length;
  session.actionTrace.push({ action: a });
  if (action.kind === "type" || action.kind === "select" || action.kind === "set_phone_country") {
    session.recordedValues.push({
      traceIndex,
      ...(actionHole !== undefined ? { hole: actionHole } : {}),
      literal: action.kind === "set_phone_country" ? action.country : action.text,
    });
  } else if (action.kind === "type_secret") {
    if (sensitiveSource === undefined) {
      throw new Error(`type_secret ${action.slot} lacks an action-time source attestation`);
    }
    session.recordedValues.push({ ...sensitiveSource, traceIndex });
  }
}

// ── Medium capture → skill (docs/DESIGN-operator-hints.md) ──────────────────

// The service SLUG for the capture. It MUST be produced the same way
// resolveRouteHint looks a hint up (serviceSlugFromUrl → canonicalizeServiceSlug)
// or the produced skill lands under a different key and the loop never closes;
// and it MUST be a valid SkillSchema slug (lowercase-with-dashes, NO dots) or
// parseSkill rejects the whole skill as schema_invalid. registrableHost
// ("resend.com") satisfied neither — the bug that made every real provision's
// auto-promote fail. Exported for the regression test.
export function captureServiceSlug(startUrl: string): string {
  try {
    return serviceSlugFromHost(new URL(startUrl).hostname);
  } catch {
    return "unknown";
  }
}

function captureService(session: Session): string {
  return captureServiceSlug(session.startUrl);
}

// Map a live operate action + the element it hit to the PostVerifyStep the
// synthesizer consumes. Only skill-synthesizable kinds map; the rest (press,
// scroll, oauth_settle, allow_host, type_secret) return null and are skipped —
// a type_secret must NEVER carry its sealed value into a shared skill.
export function captureObserved(
  action: ProvisionAction,
  el: InteractiveElement | null,
): PostVerifyStep | null {
  switch (action.kind) {
    case "click":
    case "js_click":
    case "oauth_click":
      return el === null
        ? null
        : { kind: "click", selector: el.selector, reason: traceTextFor(el) ?? action.kind };
    case "type":
      // Non-secret value; the synthesizer applies the email/token/identity PII
      // scrub. type_secret is a different kind and is skipped above.
      return el === null
        ? null
        : {
            kind: "fill",
            selector: el.selector,
            value: action.text,
            reason: traceTextFor(el) ?? "fill",
          };
    case "goto":
      return { kind: "navigate", url: action.url, reason: "navigate" };
    default:
      return null;
  }
}

// Accumulate one MEDIUM round: inventory + action + url, no html/screenshot.
function recordCaptureRound(
  session: Session,
  action: ProvisionAction,
  el: InteractiveElement | null,
  urlAtObservation: string,
): void {
  const observed = captureObserved(action, el);
  if (observed === null) return;
  session.captureRounds.push({
    service: captureService(session),
    round: session.captureRounds.length,
    oauth: action.kind === "oauth_click",
    // The URL the inventory + action belong to (pre-action), NOT the post-
    // navigation URL — see urlBeforeAction in act().
    state: { url: urlAtObservation, title: "", html: "", screenshot: "" },
    inventory: session.lastElements,
    observed,
  });
}

// The EXTRACT round is the one round that keeps raw html — the key-extraction
// step is synthesized from the page where the credential is shown.
async function recordExtractRound(session: Session): Promise<void> {
  let html = "";
  try {
    html = (await session.browser.getState()).html;
  } catch {
    /* best-effort — the copy-button/inventory extract path still works */
  }
  session.captureRounds.push({
    service: captureService(session),
    round: session.captureRounds.length,
    oauth: false,
    state: { url: session.browser.currentUrl(), title: "", html, screenshot: "" },
    inventory: session.lastElements,
    observed: { kind: "extract", reason: "extract the credential shown on the page" },
  });
}

// Record the extract round from the live page, then write the accumulated medium
// rounds through the real capture path (integrity chain) and synthesize a skill.
// Best-effort: any failure returns a skip and never disrupts the parent
// provision. The caller publishes the returned skill.
export async function captureAndPromoteSession(
  sessionId: string,
): Promise<PromoteResult | { kind: "skipped"; reason: string }> {
  const session = sessionForCall(sessionId);
  if (session === undefined) return { kind: "skipped", reason: "unknown_session" };
  // A run that used the text=/css= locator click fallback hit a control with no
  // inventory ref; the synthesizer can't represent that step, so promoting would
  // ship a skill missing a click. Skip rather than emit a silently-broken skill.
  if (session.usedLocatorFallback) {
    return { kind: "skipped", reason: "locator_fallback_unrepresentable" };
  }
  const dir = resolveCaptureDir();
  if (dir === null) return { kind: "skipped", reason: "capture_disabled" };
  if (!session.captureRounds.some((r) => r.observed.kind === "extract")) {
    await recordExtractRound(session);
  }
  const hasExtract = session.captureRounds.some((r) => r.observed.kind === "extract");
  if (!hasExtract || session.captureRounds.length < 2) {
    return { kind: "skipped", reason: "too_few_rounds" };
  }
  const service = captureService(session);
  try {
    resetCaptureChain(service);
    for (const r of session.captureRounds) captureOnboardingRound(r);
    const runId = currentRunId(service);
    if (runId === undefined) return { kind: "skipped", reason: "no_run_id" };
    return promoteToSkill({ dir, service, run_id: runId });
  } catch (err) {
    return {
      kind: "skipped",
      reason: `synthesis_error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ── Deliverable #1: hint-lift measurement ──────────────────────────────────

export interface ProvisionMeasurement {
  service: string;
  hint_present: boolean;
  outcome: "success" | "fail";
  duration_s: number;
  turns: number;
}

// Pure so the shape is unit-testable without a live session or a clock.
export function buildProvisionMeasurement(args: {
  service: string;
  hintServed: boolean;
  outcome: "success" | "fail";
  startedAt: number;
  now: number;
  turns: number;
}): ProvisionMeasurement {
  return {
    service: args.service,
    hint_present: args.hintServed,
    outcome: args.outcome,
    duration_s: Math.max(0, Math.round((args.now - args.startedAt) / 1000)),
    turns: args.turns,
  };
}

// Emit the hint-on vs hint-off lift signal for a finished provision — structured
// stderr JSON so it aggregates like the other provision-audit lines. This is the
// raw signal deliverable #1 buckets into success-rate + time by hint_present.
export function emitProvisionMeasurement(
  sessionId: string,
  outcome: "success" | "fail",
): ProvisionMeasurement | null {
  const session = sessionForCall(sessionId);
  if (session === undefined) return null;
  const m = buildProvisionMeasurement({
    service: captureService(session),
    hintServed: session.hintServed,
    outcome,
    startedAt: session.startedAt,
    now: Date.now(),
    turns: session.actionTrace.length,
  });
  process.stderr.write(`${JSON.stringify({ marker: "provision-measurement", ...m })}\n`);
  return m;
}

async function settleAfterStateChange(browser: BrowserController): Promise<void> {
  await settle(450);
  await browser.waitForInteractiveDom(1, 2_000).catch(() => undefined);
  for (let i = 0; i < 4; i += 1) {
    const text = await browser.extractVisibleText().catch(() => "");
    if (text.replace(/\s+/g, " ").trim().length > 0) return;
    await settle(300);
  }
}

// ── operator-recipe: remember a successful run, verify a postcondition ──

// Persist the session's action trace as a keyed, replayable operator-recipe.
// Sealed secrets become SLOT references (stored:false) — never values. The
// recipe's scope = start + auto_widen hosts (mid_session crossings replay via
// the trace's own allow_host steps).
function verifiedEmailSources(
  session: Session,
  inputs: KnownRecipeInputs,
): Array<RecordedValueSource & { hole: string }> {
  return session.recordedValues.filter(
    (source): source is RecordedValueSource & { hole: string } =>
      source.hole !== undefined &&
      session.userEmail !== null &&
      source.literal === session.userEmail &&
      looksLikeEmailValue(source.literal) &&
      knownRecipeInputValue(inputs, source.hole) === source.literal,
  );
}

function traceWithVerifiedProvenance(session: Session, inputs: KnownRecipeInputs): TraceEntry[] {
  const trace = session.actionTrace.map((entry) => ({
    ...entry,
    action: { ...entry.action },
  }));
  const recordedIndexes = new Set<number>();
  for (const source of session.recordedValues) {
    if (recordedIndexes.has(source.traceIndex)) {
      throw new Error(`duplicate value source for trace step ${source.traceIndex}`);
    }
    recordedIndexes.add(source.traceIndex);
    if (source.hole === undefined) {
      throw new Error(`value at trace step ${source.traceIndex} lacks explicit provenance`);
    }
    const authoritative = knownRecipeInputValue(inputs, source.hole);
    if (authoritative === undefined) {
      throw new Error(`provenance ${source.hole} has no authoritative operate_remember input`);
    }
    if (authoritative !== source.literal) {
      throw new Error(`provenance ${source.hole} does not match the injected value`);
    }
    const entry = trace[source.traceIndex];
    if (entry === undefined) {
      throw new Error(`provenance ${source.hole} is not bound to a recorded value action`);
    }
    if (
      (entry.action.kind === "type" ||
        entry.action.kind === "select" ||
        entry.action.kind === "set_phone_country") &&
      typeof entry.action.value === "string"
    ) {
      entry.action.value = { hole: source.hole };
      continue;
    }
    if (
      (entry.action.kind === "type_secret" || entry.action.kind === "operate_pay") &&
      typeof entry.action.value !== "string" &&
      entry.action.value?.hole === source.hole
    ) {
      continue;
    }
    throw new Error(`provenance ${source.hole} is not bound to a recorded value action`);
  }
  const emailSources = verifiedEmailSources(session, inputs);
  const emailHoles = new Set(emailSources.map((source) => source.hole));
  for (const [traceIndex, entry] of trace.entries()) {
    const targetText = JSON.stringify({
      text_match: entry.action.text_match,
      target: entry.action.target,
      url_template: entry.action.url_template,
    });
    if (!targetText.includes("${EMAIL_ALIAS")) continue;
    const directEmailHole = emailSources.find((source) => source.traceIndex === traceIndex)?.hole;
    if (directEmailHole === undefined && emailHoles.size !== 1) {
      throw new Error("known-email target lacks one unambiguous action-time source hole");
    }
    const emailHole = directEmailHole ?? [...emailHoles][0]!;
    entry.action.email_hole = emailHole;
  }
  for (const [traceIndex, entry] of trace.entries()) {
    const value = entry.action.value;
    if (value === undefined || typeof value === "string" || recordedIndexes.has(traceIndex)) {
      continue;
    }
    throw new Error(`provenance ${value.hole} lacks an action-time source attestation`);
  }
  return trace;
}

function scrubRecipePostcondition(
  session: Session,
  postcondition: Postcondition,
  inputs: KnownRecipeInputs,
): Postcondition {
  const probeUrl =
    postcondition.probe_url === undefined
      ? undefined
      : scrubKnownEmail(postcondition.probe_url, session.userEmail);
  const signal = postcondition.success_signal;
  const successSignal =
    "url_contains" in signal
      ? { url_contains: scrubKnownEmail(signal.url_contains, session.userEmail) }
      : signal;
  const hasTemplate =
    probeUrl?.includes("${EMAIL_ALIAS") === true ||
    ("url_contains" in successSignal && successSignal.url_contains.includes("${EMAIL_ALIAS"));
  const base = { kind: postcondition.kind, describe: postcondition.describe };
  if (!hasTemplate) {
    return {
      ...base,
      ...(probeUrl !== undefined ? { probe_url: probeUrl } : {}),
      success_signal: successSignal,
    };
  }
  const holes = [...new Set(verifiedEmailSources(session, inputs).map((source) => source.hole))];
  if (holes.length !== 1) {
    throw new Error("known-email postcondition lacks one unambiguous action-time source hole");
  }
  return {
    ...base,
    ...(probeUrl !== undefined ? { probe_url: probeUrl } : {}),
    success_signal: successSignal,
    email_hole: holes[0],
  };
}

export async function rememberRecipe(
  sessionId: string,
  opts: {
    name: string;
    goal: string;
    postcondition: Postcondition;
    verb?: OperatorVerb;
    inputs: KnownRecipeInputs;
  },
): Promise<{
  file: string;
  name: string;
  steps: number;
  secrets: string[];
  verified: PostconditionResult;
}> {
  const session = sessionForCall(sessionId);
  if (session === undefined) throw new Error(`unknown provision session ${sessionId}`);
  if (session.usedLocatorFallback) {
    throw new Error(
      "operate_remember refused: this session used a text=/css= locator fallback that operator recipes cannot represent",
    );
  }
  if (session.recipeRejectionReason !== null) {
    throw new Error(`operate_remember refused: ${session.recipeRejectionReason}`);
  }
  if (opts.inputs === undefined) {
    throw new Error("operate_remember refused: complete provenance inputs are required");
  }
  // Record only through the existing machine-checkable success gate. Previously
  // operate_remember wrote first and operate_finish_task verified later, leaving
  // an unverified recipe on disk when the postcondition failed.
  const verified = await verifyPostcondition(sessionId, opts.postcondition);
  if (!verified.confirmed) {
    throw new Error(`operate_remember refused: postcondition not confirmed (${verified.reason})`);
  }
  const secrets = [...session.secretSlots.keys()].map((slot) => ({ slot, stored: false as const }));
  const scrubbedStartUrl = scrubKnownEmail(session.startUrl, session.userEmail);
  const trace = traceWithVerifiedProvenance(session, opts.inputs);
  const postcondition = scrubRecipePostcondition(session, opts.postcondition, opts.inputs);
  const recipe: OperatorRecipe = {
    name: opts.name,
    schema_version: 1,
    goal: opts.goal,
    ...(opts.verb !== undefined
      ? { verb: opts.verb, domain: operatorRecipeDomain(session.startUrl) }
      : {}),
    // Canonical, stable replay entry — the page the session started at, never a
    // mid-flow single-use link inferred from the trace.
    ...(isSingleUseUrl(session.startUrl) || scrubbedStartUrl !== session.startUrl
      ? { entry_mode: "runtime_service_url" as const }
      : { entry_url: session.startUrl }),
    allowed_hosts: [...new Set(egressSeedHosts(session))],
    trace,
    secrets,
    postcondition,
  };
  assertRecipeEmailScrubbed(recipe, session.userEmail);
  const unprovenancedMoneyField = findUnprovenancedMoneyField(recipe);
  if (unprovenancedMoneyField !== null) {
    throw new Error(
      `operate_remember refused: money field lacks provenance (${unprovenancedMoneyField})`,
    );
  }
  const file = await writeRecipe(recipe);
  audit(sessionId, "remember_recipe", {
    name: opts.name,
    steps: recipe.trace.length,
    secrets: secrets.length,
    file,
  });
  return {
    file,
    name: opts.name,
    steps: recipe.trace.length,
    secrets: secrets.map((s) => s.slot),
    verified,
  };
}

// Read a single page snapshot for postcondition checking. Field VALUES are
// reduced to lengths here so a token/secret success-signal can't leak.
async function snapshotForPostcondition(session: Session): Promise<PostconditionSnapshot> {
  const obs = await observeSession(session);
  // Read lengths off the RAW elements (session.lastElements, set by
  // observeSession). The compact wire carries only value_len and never the raw
  // value; deriving from the live elements preserves the real length for a
  // min_value_len success-signal. Lengths never expose the value, so this stays
  // leak-free.
  const fields = session.lastElements
    .filter((e) => typeof e.value === "string" && e.value.length > 0)
    .map((e) => ({ label: elementRef(e), value_len: (e.value ?? "").length }));
  return { url: obs.url, text: session.prevObserve?.text ?? obs.text, fields };
}

// Verify a recipe's postcondition against the live session — the anti-false-
// green gate for replay. execute_capability checks the current end-state;
// observe_artifact navigates to the probe surface first (Phase B paces this).
export async function verifyPostcondition(
  sessionId: string,
  postcondition: Postcondition,
): Promise<PostconditionResult> {
  const session = sessionForCall(sessionId);
  if (session === undefined) throw new Error(`unknown provision session ${sessionId}`);
  if (postcondition.kind === "observe_artifact" && postcondition.probe_url !== undefined) {
    const host = registrableHost(postcondition.probe_url);
    if (host !== null && !session.allowedHosts.some((e) => e.host === host)) {
      session.allowedHosts.push({ host, source: "mid_session" });
    }
    await session.browser.goto(postcondition.probe_url);
    await settle(1500);
  }
  const snap = await snapshotForPostcondition(session);
  const result = checkSuccessSignal(postcondition.success_signal, snap);
  audit(sessionId, "verify_postcondition", {
    kind: postcondition.kind,
    confirmed: result.confirmed,
    reason: result.reason,
  });
  return result;
}

export async function verifySavedRecipePostcondition(
  sessionId: string,
  recipe: OperatorRecipe,
): Promise<PostconditionResult> {
  const session = sessions.get(sessionId);
  if (session === undefined) throw new Error(`unknown provision session ${sessionId}`);
  const state = session.replayState;
  if (state !== null && state.recipeHash === replayDigest(recipe)) {
    return await verifyPostcondition(sessionId, state.boundPostcondition);
  }
  let postcondition: Postcondition;
  try {
    postcondition = bindRecipePostcondition(recipe.postcondition, {});
  } catch {
    throw new Error("saved recipe postcondition requires bindings from its active replay");
  }
  return await verifyPostcondition(sessionId, postcondition);
}

export async function verifyActiveRecipePostcondition(
  sessionId: string,
  recipeName: string,
): Promise<PostconditionResult | null> {
  const session = sessions.get(sessionId);
  if (session === undefined) throw new Error(`unknown provision session ${sessionId}`);
  const state = session.replayState;
  if (state === null) return null;
  if (state.recipeName !== recipeName) {
    throw new Error(`verify_recipe ${recipeName} does not match active replay ${state.recipeName}`);
  }
  return await verifyPostcondition(sessionId, state.boundPostcondition);
}

const MONEY_REPLAY_VERBS = new Set<OperatorVerb>([
  "purchase",
  "subscribe",
  "checkout",
  "renew",
  "upgrade",
  "book",
  "reserve",
]);

export type OperatorReplayResult =
  | {
      status: "complete";
      observation: Observation;
      replayed_steps: number;
      field_values_verified: boolean;
    }
  | {
      status: "fallback_required";
      observation: Observation;
      step_index: number;
      next_index: number;
      step: TraceEntry;
      reason: string;
    }
  | {
      status: "human_required";
      observation: Observation;
      reason: "field_missing" | "field_value_mismatch";
      field: string;
    };

function replayTarget(action: TraceAction): RecipeTarget | null {
  return action.target !== undefined
    ? action.target
    : action.text_match !== undefined
      ? { visible_text: action.text_match }
      : null;
}

function boundReplayTarget(
  action: TraceAction,
  bindings: Readonly<Record<string, string>>,
): RecipeTarget | null {
  const target =
    action.target !== undefined
      ? action.target
      : action.text_match !== undefined
        ? { visible_text: action.text_match }
        : null;
  return target === null ? null : bindRecipeTarget(target, bindings, action.email_hole);
}

const MONEY_FIELD_TARGET =
  /(?:^|[\s._-])(?:address|street|line\s*[12]|city|state|province|postal|zip|country|e-?mail|phone|first\s*name|last\s*name|full\s*name|quantity|qty)(?:$|[\s._-])/i;

function moneyFieldName(action: TraceAction): string | null {
  if (action.kind === "set_phone_country") return "phone_country";
  if (action.kind !== "type" && action.kind !== "select") return null;
  const target = replayTarget(action);
  if (target === null) return null;
  const label = [
    target.dom_hint?.testid,
    target.dom_hint?.id,
    target.dom_hint?.name,
    target.accessible_name,
    target.visible_text,
  ]
    .filter((value): value is string => value !== undefined)
    .join(" ")
    .replace(/([a-z])([A-Z])/g, "$1 $2");
  return MONEY_FIELD_TARGET.test(label) ? label || "field" : null;
}

function findUnprovenancedMoneyField(recipe: OperatorRecipe): string | null {
  if (recipe.verb === undefined || !MONEY_REPLAY_VERBS.has(recipe.verb)) return null;
  for (const { action } of recipe.trace) {
    const field = moneyFieldName(action);
    if (field !== null && typeof action.value === "string") return field;
  }
  return null;
}

function replayDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function bindingDigest(bindings: Readonly<Record<string, string>>): string {
  return replayDigest(
    Object.entries(bindings)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, value]),
  );
}

function expectedReplayFields(
  recipe: OperatorRecipe,
  bindings: Readonly<Record<string, string>>,
): { fields: Map<number, ReplayExpectedField>; missing: string | null } {
  const fields = new Map<number, ReplayExpectedField>();
  for (let stepIndex = 0; stepIndex < recipe.trace.length; stepIndex += 1) {
    const action = recipe.trace[stepIndex]!.action;
    const unprovenanced = moneyFieldName(action);
    if (unprovenanced !== null && typeof action.value === "string") {
      return { fields, missing: unprovenanced };
    }
    if (
      (action.kind !== "type" && action.kind !== "select" && action.kind !== "set_phone_country") ||
      action.value === undefined ||
      typeof action.value === "string" ||
      !REPLAY_VERIFIED_HOLE.test(action.value.hole)
    ) {
      continue;
    }
    const expected = bindings[action.value.hole];
    if (expected === undefined) return { fields, missing: action.value.hole };
    let target: RecipeTarget | null;
    try {
      target = boundReplayTarget(action, bindings);
    } catch {
      return { fields, missing: action.email_hole ?? "email_target" };
    }
    fields.set(stepIndex, {
      stepIndex,
      hole: action.value.hole,
      expected,
      target,
      kind: action.kind,
    });
  }
  return { fields, missing: null };
}

function markReplayFailure(
  session: Session,
  reason: "field_missing" | "field_value_mismatch",
  field: string,
): void {
  rejectRecipeRecording(session, `replay transition failed (${field}: ${reason})`);
  if (session.replayState === null) return;
  session.replayState.paymentGuard = "failed";
  session.replayState.failure = { reason, field };
  audit(session.id, "replay_field_value_guard", { ok: false, reason, field });
}

function verifyReplayFieldInElements(
  session: Session,
  expected: ReplayExpectedField,
  elements: readonly InteractiveElement[],
  allowCommittedSelect = false,
): { ok: true } | { ok: false; reason: "field_missing" | "field_value_mismatch" } {
  if (expected.kind === "set_phone_country" || expected.target === null) {
    return { ok: false, reason: "field_missing" };
  }
  const resolution = resolveRecipeFieldTarget(elements, expected.target);
  if (resolution === null) return { ok: false, reason: "field_missing" };
  const guard = verifyFilledFieldValues(elements, [
    {
      target: expected.target,
      expected: expected.expected,
      hole: expected.hole,
      kind: expected.kind === "select" ? "select" : "type",
    },
  ]);
  if (guard.ok) {
    if (expected.kind === "select") {
      session.committedSelectValues.delete(resolution.element.selector);
    }
    return { ok: true };
  }
  if (
    allowCommittedSelect &&
    expected.kind === "select" &&
    session.committedSelectValues.get(resolution.element.selector) === expected.expected
  ) {
    session.committedSelectValues.delete(resolution.element.selector);
    return { ok: true };
  }
  if (expected.kind === "select") {
    session.committedSelectValues.delete(resolution.element.selector);
  }
  return { ok: false, reason: guard.reason };
}

async function verifyReplayField(
  session: Session,
  expected: ReplayExpectedField,
  allowCommittedSelect = false,
): Promise<{ ok: true } | { ok: false; reason: "field_missing" | "field_value_mismatch" }> {
  if (expected.kind === "set_phone_country") {
    return (await session.browser.verifyPhoneCountry(expected.expected))
      ? { ok: true }
      : { ok: false, reason: "field_value_mismatch" };
  }
  const target = expected.target;
  if (target === null) return { ok: false, reason: "field_missing" };
  const fresh = await session.browser.extractInteractiveElements();
  session.lastElements = fresh;
  return verifyReplayFieldInElements(session, expected, fresh, allowCommittedSelect);
}

async function verifyReplayFieldWithElements(
  session: Session,
  expected: ReplayExpectedField,
  elements: readonly InteractiveElement[],
  allowCommittedSelect = false,
): Promise<{ ok: true } | { ok: false; reason: "field_missing" | "field_value_mismatch" }> {
  if (expected.kind === "set_phone_country") {
    return (await session.browser.verifyPhoneCountry(expected.expected))
      ? { ok: true }
      : { ok: false, reason: "field_value_mismatch" };
  }
  return verifyReplayFieldInElements(session, expected, elements, allowCommittedSelect);
}

async function isReplayFieldMounted(
  session: Session,
  expected: ReplayExpectedField,
  elements: readonly InteractiveElement[],
): Promise<boolean> {
  if (expected.kind === "set_phone_country") {
    return await session.browser.hasPhoneCountryControl();
  }
  return expected.target !== null && hasRecipeTargetCandidate(elements, expected.target);
}

async function captureReplayRepairVerification(
  session: Session,
  action: ProvisionAction,
  resolvedEl: InteractiveElement | null,
): Promise<void> {
  const state = session.replayState;
  if (state === null || state.nextIndex === null || !state.moneyPath) return;
  const stepIndex = state.nextIndex - 1;
  const expected = state.expectedFields.get(stepIndex);
  if (expected === undefined) return;
  if (action.kind !== "type" && action.kind !== "select" && action.kind !== "set_phone_country") {
    return;
  }
  if (
    action.replayRepair === undefined ||
    action.replayRepair.stepIndex !== stepIndex ||
    action.replayRepair.hole !== expected.hole
  ) {
    throw new Error(`replay repair must bind to step ${stepIndex} and ${expected.hole}`);
  }
  const supplied =
    action.kind === "type" || action.kind === "select"
      ? action.text
      : action.kind === "set_phone_country"
        ? action.country
        : null;
  if (supplied === null) return;
  if (supplied !== expected.expected) {
    markReplayFailure(session, "field_value_mismatch", expected.hole);
    throw new Error(`replay repair value mismatch for ${expected.hole}`);
  }
  if (action.kind === "set_phone_country") {
    const guard = await verifyReplayField(session, expected);
    if (!guard.ok) {
      markReplayFailure(session, guard.reason, expected.hole);
      throw new Error(`replay repair verification failed for ${expected.hole}: ${guard.reason}`);
    }
    state.verifiedFields.add(stepIndex);
    return;
  }
  const recordedResolution =
    expected.target === null
      ? null
      : resolveRecipeFieldTarget(session.lastElements, expected.target);
  if (resolvedEl === null) {
    throw new Error(`replay repair target mismatch for ${expected.hole}`);
  }
  const recordedTargetMatches = recordedResolution?.element.selector === resolvedEl.selector;
  const semanticResolution =
    expected.target === null
      ? null
      : resolveRecipeRepairTarget(session.lastElements, expected.target);
  const replacementSemanticsMatch = semanticResolution?.selector === resolvedEl.selector;
  if (!recordedTargetMatches && !replacementSemanticsMatch) {
    throw new Error(`replay repair target mismatch for ${expected.hole}`);
  }
  const replacementTarget = recipeTargetFor(resolvedEl, session.lastElements, session.userEmail);
  if (replacementTarget === undefined) {
    throw new Error(`replay repair target could not be attested for ${expected.hole}`);
  }
  expected.target = replacementTarget;
  const guard = await verifyReplayField(session, expected, action.kind === "select");
  if (!guard.ok) {
    markReplayFailure(session, guard.reason, expected.hole);
    throw new Error(`replay repair verification failed for ${expected.hole}: ${guard.reason}`);
  }
  state.verifiedFields.add(stepIndex);
}

async function refreshReplayVerificationAfterAction(
  session: Session,
  action: ProvisionAction,
  resolvedEl: InteractiveElement | null,
): Promise<void> {
  const state = session.replayState;
  if (
    state === null ||
    !state.moneyPath ||
    state.nextIndex !== null ||
    state.paymentGuard !== "verified" ||
    (action.kind !== "type" && action.kind !== "select" && action.kind !== "set_phone_country")
  ) {
    return;
  }
  const affected = [...state.expectedFields.values()].filter((expected) => {
    if (action.kind === "set_phone_country") return expected.kind === "set_phone_country";
    if (expected.target === null || resolvedEl === null) return false;
    return (
      resolveRecipeFieldTarget(session.lastElements, expected.target)?.element.selector ===
      resolvedEl.selector
    );
  });
  for (const expected of affected) {
    state.verifiedFields.delete(expected.stepIndex);
    state.paymentGuard = "pending";
    const supplied = action.kind === "set_phone_country" ? action.country : action.text;
    if (supplied !== expected.expected) {
      markReplayFailure(session, "field_value_mismatch", expected.hole);
      throw new Error(`replay field value mismatch for ${expected.hole}`);
    }
    const guard = await verifyReplayField(session, expected, action.kind === "select");
    if (!guard.ok) {
      markReplayFailure(session, guard.reason, expected.hole);
      throw new Error(`replay field verification failed for ${expected.hole}: ${guard.reason}`);
    }
    state.verifiedFields.add(expected.stepIndex);
  }
  if (state.verifiedFields.size === state.expectedFields.size) state.paymentGuard = "verified";
}

function isReplayTransitionAction(action: ProvisionAction): boolean {
  return (
    action.kind !== "type" &&
    action.kind !== "select" &&
    action.kind !== "set_phone_country" &&
    action.kind !== "allow_host"
  );
}

function rejectRecipeRecording(session: Session, reason: string): void {
  session.recipeRejectionReason ??= reason;
}

function recordedMoneyFields(session: Session): ReplayExpectedField[] {
  const fields: ReplayExpectedField[] = [];
  for (const source of session.recordedValues) {
    if (source.hole === undefined || !REPLAY_VERIFIED_HOLE.test(source.hole)) continue;
    const action = session.actionTrace[source.traceIndex]?.action;
    if (
      action === undefined ||
      (action.kind !== "type" && action.kind !== "select" && action.kind !== "set_phone_country")
    ) {
      continue;
    }
    let target: RecipeTarget | null = null;
    if (action.kind !== "set_phone_country") {
      try {
        target = boundReplayTarget(
          { ...action, email_hole: source.hole },
          { [source.hole]: source.literal },
        );
      } catch {
        target = null;
      }
    }
    fields.push({
      stepIndex: source.traceIndex,
      hole: source.hole,
      expected: source.literal,
      target,
      kind: action.kind,
    });
  }
  return fields;
}

async function attestRecordedFieldsBeforeTransition(
  session: Session,
  action: ProvisionAction,
): Promise<ReplayExpectedField[]> {
  if (session.replayState !== null || !isReplayTransitionAction(action)) return [];
  const fields = recordedMoneyFields(session);
  if (fields.length === 0) return fields;
  const fresh = await session.browser.extractInteractiveElements();
  session.lastElements = fresh;
  for (const expected of fields) {
    const guard = await verifyReplayFieldWithElements(session, expected, fresh);
    if (!guard.ok) {
      rejectRecipeRecording(
        session,
        `checkout transition could not be attested (${expected.hole}: ${guard.reason})`,
      );
      return [];
    }
  }
  return fields;
}

async function verifyRecordedFieldsAfterTransition(
  session: Session,
  action: ProvisionAction,
  fields: readonly ReplayExpectedField[],
): Promise<void> {
  if (session.replayState !== null || !isReplayTransitionAction(action) || fields.length === 0) {
    return;
  }
  const fresh = await session.browser.extractInteractiveElements();
  session.lastElements = fresh;
  for (const expected of fields) {
    if (!(await isReplayFieldMounted(session, expected, fresh))) {
      rejectRecipeRecording(
        session,
        `checkout transition could not be attested (${expected.hole}: field_missing)`,
      );
      return;
    }
    const guard = await verifyReplayFieldWithElements(session, expected, fresh);
    if (!guard.ok) {
      rejectRecipeRecording(
        session,
        `checkout transition could not be attested (${expected.hole}: ${guard.reason})`,
      );
      return;
    }
  }
}

async function attestReplayFieldsBeforeTransition(
  session: Session,
  action: ProvisionAction,
): Promise<
  | { ok: true; fields: Set<number> }
  | { ok: false; reason: "field_missing" | "field_value_mismatch"; field: string }
> {
  const state = session.replayState;
  const fields = new Set<number>();
  if (state === null || !state.moneyPath || !isReplayTransitionAction(action)) {
    return { ok: true, fields };
  }
  const fresh = await session.browser.extractInteractiveElements();
  session.lastElements = fresh;
  for (const expected of state.expectedFields.values()) {
    if (
      !state.verifiedFields.has(expected.stepIndex) ||
      (expected.target === null && expected.kind !== "set_phone_country")
    ) {
      continue;
    }
    const guard = await verifyReplayFieldWithElements(session, expected, fresh);
    if (!guard.ok) {
      return { ok: false, reason: guard.reason, field: expected.hole };
    }
    fields.add(expected.stepIndex);
  }
  return { ok: true, fields };
}

async function verifyReplayFieldsAfterTransition(
  session: Session,
  action: ProvisionAction,
  attestedFields: ReadonlySet<number>,
): Promise<
  { ok: true } | { ok: false; reason: "field_missing" | "field_value_mismatch"; field: string }
> {
  const state = session.replayState;
  if (state === null || !state.moneyPath || !isReplayTransitionAction(action)) {
    return { ok: true };
  }
  const fresh = await session.browser.extractInteractiveElements();
  session.lastElements = fresh;
  for (const stepIndex of attestedFields) {
    const expected = state.expectedFields.get(stepIndex);
    if (expected === undefined) continue;
    if (!(await isReplayFieldMounted(session, expected, fresh))) {
      return { ok: false, reason: "field_missing", field: expected.hole };
    }
    const guard = await verifyReplayFieldWithElements(session, expected, fresh);
    if (!guard.ok) {
      return { ok: false, reason: guard.reason, field: expected.hole };
    }
  }
  return { ok: true };
}

/**
 * Execute deterministic recipe steps until completion or one local miss.
 * A miss is returned to the host with a continuation index; after the host
 * repairs that one step, calling again with `fromIndex=next_index` continues.
 */
export async function replayOperatorRecipe(
  sessionId: string,
  recipe: OperatorRecipe,
  bindings: Readonly<Record<string, string>>,
  fromIndex = 0,
): Promise<OperatorReplayResult> {
  const session = sessions.get(sessionId);
  if (session === undefined) throw new Error(`unknown provision session ${sessionId}`);
  const recipeHash = replayDigest(recipe);
  const bindingsHash = bindingDigest(bindings);
  const boundPostcondition = bindRecipePostcondition(recipe.postcondition, bindings);
  if (recipe.verb === undefined || recipe.domain === undefined) {
    throw new Error("legacy named recipes are hint-only and cannot replay deterministically");
  }
  const isMoneyPath = MONEY_REPLAY_VERBS.has(recipe.verb);
  let state: ReplayState;

  const humanRequired = async (
    reason: "field_missing" | "field_value_mismatch",
    field: string,
  ): Promise<OperatorReplayResult> => {
    markReplayFailure(session, reason, field);
    return { status: "human_required", observation: await observe(sessionId), reason, field };
  };

  if (fromIndex === 0) {
    if (session.replayState !== null) {
      throw new Error("replay already started in this session; use the issued continuation");
    }
    const expected = expectedReplayFields(recipe, bindings);
    state = {
      recipeName: recipe.name,
      recipeHash,
      bindingsHash,
      boundPostcondition,
      moneyPath: isMoneyPath,
      nextIndex: null,
      expectedFields: expected.fields,
      verifiedFields: new Set(),
      paymentGuard: isMoneyPath ? "pending" : "verified",
    };
    session.replayState = state;
    if (expected.missing !== null) return await humanRequired("field_missing", expected.missing);
  } else {
    state = session.replayState!;
    if (
      state === null ||
      state.recipeHash !== recipeHash ||
      state.bindingsHash !== bindingsHash ||
      state.nextIndex !== fromIndex
    ) {
      throw new Error("invalid replay continuation: resume_from was not issued for this session");
    }
    if (state.failure !== undefined) {
      return await humanRequired(state.failure.reason, state.failure.field);
    }
    const repairedField = state.expectedFields.get(fromIndex - 1);
    if (repairedField !== undefined && !state.verifiedFields.has(fromIndex - 1)) {
      const guard = await verifyReplayField(session, repairedField);
      if (!guard.ok) return await humanRequired(guard.reason, repairedField.hole);
      state.verifiedFields.add(fromIndex - 1);
    }
    state.nextIndex = null;
  }

  let replayed = 0;

  const fallback = async (
    step: TraceEntry,
    stepIndex: number,
    reason: string,
  ): Promise<OperatorReplayResult> => {
    state.nextIndex = stepIndex + 1;
    if (
      step.action.kind === "operate_pay" &&
      state.verifiedFields.size === state.expectedFields.size
    ) {
      state.paymentGuard = "verified";
    }
    return {
      status: "fallback_required",
      observation: await observe(sessionId),
      step_index: stepIndex,
      next_index: stepIndex + 1,
      step,
      reason,
    };
  };

  for (let i = fromIndex; i < recipe.trace.length; i += 1) {
    const step = recipe.trace[i] as TraceEntry;
    const recorded = step.action;
    let action: ProvisionAction;

    if (recorded.kind === "extract") {
      return await fallback(
        step,
        i,
        "credential extraction requires host planning on the live page",
      );
    }

    if (recorded.kind === "operate_pay") {
      return await fallback(step, i, "payment requires the existing operate_pay approval flow");
    }

    if (recorded.kind === "goto") {
      if (recorded.url_template === undefined) {
        return await fallback(step, i, "goto step has no URL");
      }
      let urlTemplate: string;
      try {
        urlTemplate = bindKnownEmailTemplate(recorded.url_template, bindings, recorded.email_hole);
      } catch (error) {
        return await fallback(step, i, error instanceof Error ? error.message : String(error));
      }
      const filled = fillTemplate(urlTemplate, bindings as Record<string, string>);
      if (filled.missing.length > 0) {
        return await fallback(step, i, `missing bindings: ${filled.missing.join(", ")}`);
      }
      action = { kind: "goto", url: filled.url };
    } else if (recorded.kind === "allow_host") {
      if (recorded.host === undefined) {
        return await fallback(step, i, "allow_host step has no host");
      }
      action = { kind: "allow_host", host: recorded.host };
    } else if (recorded.kind === "press") {
      if (recorded.key === undefined) {
        return await fallback(step, i, "press step has no key");
      }
      action = { kind: "press", key: recorded.key };
    } else if (recorded.kind === "oauth_settle") {
      action = { kind: "oauth_settle" };
    } else if (recorded.kind === "scroll") {
      action = {
        kind: "scroll",
        ...(recorded.direction !== undefined ? { direction: recorded.direction } : {}),
      };
    } else if (recorded.kind === "set_phone_country") {
      if (recorded.value === undefined) {
        return await fallback(step, i, "set_phone_country step has no value");
      }
      try {
        action = {
          kind: "set_phone_country",
          country: bindRecipeValue(recorded.value, bindings),
          ...(typeof recorded.value === "string" ? {} : { provenance: recorded.value }),
        };
      } catch (error) {
        return await fallback(step, i, error instanceof Error ? error.message : String(error));
      }
    } else {
      let target: RecipeTarget | null;
      try {
        target = boundReplayTarget(recorded, bindings);
      } catch (error) {
        return await fallback(step, i, error instanceof Error ? error.message : String(error));
      }
      if (target === null) {
        return await fallback(step, i, "step has no replay target");
      }
      // Structural pre-check: resolve against the live inventory before every
      // deterministic act. This is especially load-bearing on money paths.
      const fresh = await session.browser.extractInteractiveElements();
      session.lastElements = fresh;
      const expectedForStep = state.expectedFields.get(i);
      const resolution =
        expectedForStep === undefined
          ? resolveRecipeTarget(fresh, target)
          : resolveRecipeFieldTarget(fresh, target);
      if (resolution === null) {
        return await fallback(step, i, "ordered target resolver missed");
      }
      const ref = provisionElementRefs(fresh).get(resolution.element);
      if (ref === undefined) {
        return await fallback(step, i, "resolved target has no live ref");
      }
      if (recorded.kind === "type" || recorded.kind === "select") {
        if (recorded.value === undefined) {
          return await fallback(step, i, `${recorded.kind} step has no value`);
        }
        let text: string;
        try {
          text = bindRecipeValue(recorded.value, bindings);
        } catch (error) {
          return await fallback(step, i, error instanceof Error ? error.message : String(error));
        }
        action =
          recorded.kind === "type"
            ? {
                kind: "type",
                target: ref,
                text,
                ...(typeof recorded.value === "string" ? {} : { provenance: recorded.value }),
              }
            : {
                kind: "select",
                target: ref,
                text,
                ...(typeof recorded.value === "string" ? {} : { provenance: recorded.value }),
              };
      } else if (recorded.kind === "type_secret") {
        if (recorded.slot === undefined) {
          return await fallback(step, i, "type_secret step has no slot");
        }
        action = { kind: "type_secret", target: ref, slot: recorded.slot };
      } else if (recorded.kind === "click") {
        action = { kind: "click", target: ref };
      } else if (recorded.kind === "js_click") {
        action = { kind: "js_click", target: ref };
      } else {
        action = { kind: "oauth_click", target: ref };
      }
    }

    try {
      const transitionAttestation = await attestReplayFieldsBeforeTransition(session, action);
      if (!transitionAttestation.ok) {
        return await humanRequired(transitionAttestation.reason, transitionAttestation.field);
      }
      await act(sessionId, action, "none");
      replayed += 1;
      const expected = state.expectedFields.get(i);
      if (expected !== undefined) {
        const guard = await verifyReplayField(session, expected, expected.kind === "select");
        if (!guard.ok) return await humanRequired(guard.reason, expected.hole);
        state.verifiedFields.add(i);
      }
      const transitionGuard = await verifyReplayFieldsAfterTransition(
        session,
        action,
        transitionAttestation.fields,
      );
      if (!transitionGuard.ok) {
        return await humanRequired(transitionGuard.reason, transitionGuard.field);
      }
    } catch (error) {
      return await fallback(step, i, error instanceof Error ? error.message : String(error));
    }
  }

  if (isMoneyPath) {
    const unverified = [...state.expectedFields.values()].find(
      (expected) => !state.verifiedFields.has(expected.stepIndex),
    );
    if (unverified !== undefined) {
      return await humanRequired("field_missing", unverified.hole);
    }
    state.paymentGuard = "verified";
    audit(sessionId, "replay_field_value_guard", {
      ok: true,
      fields: state.expectedFields.size,
    });
  }

  return {
    status: "complete",
    observation: await observe(sessionId),
    replayed_steps: replayed,
    field_values_verified: isMoneyPath,
  };
}

// ── extraction (the `extract` thick tool) ──

export interface ExtractResult {
  session_id: string;
  url: string;
  // The deliverable: a primary `api_key` (or `api_key_truncated` when only a
  // masked display was reachable) plus any labeled/named credentials a
  // multi-cred service presents (e.g. cloud_name, api_secret).
  credentials: Record<string, string>;
  // How many labeled credential candidates the page presented — diagnostic so
  // the host can tell "found nothing" from "found masked values it couldn't read".
  candidate_count: number;
  // Set when extraction failed CLOSED: the page is a login wall / anti-bot
  // interstitial with no credential to give (Grok/X tombstone), so the extractor
  // refused to surface junk. The host should drive an interactive login or hand
  // back to the user rather than treat an empty result as "service issued none".
  blocked_reason?: string;
}

const normLabelKey = (label: string): string =>
  label
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/gi, "")
    .toLowerCase()
    .slice(0, 40);

// Credential-shape predicates (looksLikeCodeIdentifier, looksLikeCredentialValue,
// isCredentialNoise, findCredentialTokens, looksLikeCredentialToken) live in
// credential-shape.ts — imported above. detectExtractionBlock stays here: it's
// page-state detection (a login-wall interstitial), not value-shape.

// A credentials page that is actually a login wall / anti-bot interstitial has
// no key to give — every token on it (CSRF cookie, asset hash, guest id) is
// junk. Grok is the standing case: x.ai routes signup through X (Twitter) OAuth,
// and X serves headless Chromium its "JavaScript is not available" tombstone, so
// the extractor would otherwise scrape session tokens and hand one back as a
// false-green key. Detect that state and fail CLOSED — return no credential plus
// an explicit reason the host agent can act on (drive an interactive login),
// rather than surfacing a bogus value. The phrases below are the load-bearing
// markers of X's tombstone + the four anti-bot vendors waitForFormReady knows.
const LOGIN_WALL_MARKERS: readonly RegExp[] = [
  /javascript is not available/i,
  /enable javascript/i,
  /verifying you are human/i,
  /checking your browser/i,
  /just a moment/i,
  /review the security of your connection/i,
  /unusual (traffic|activity) (from|on)/i,
];
export function detectExtractionBlock(pageText: string): string | null {
  // Require a SHORT page — a real keys page that merely mentions "enable
  // JavaScript" in a footer is not a wall. A tombstone/interstitial is sparse.
  if (pageText.trim().length > 600) return null;
  for (const re of LOGIN_WALL_MARKERS) {
    if (re.test(pageText)) {
      return "login_wall: the page is an anti-bot/login interstitial (no credential present) — drive an interactive login or hand back to the user";
    }
  }
  return null;
}

function firstTokenMatching(haystack: string, re: RegExp): string | null {
  const match = haystack.match(re);
  return match?.[0] ?? null;
}

export function sanitizeExtractedCredentials(
  credentials: Record<string, string>,
  url: string,
  haystack = Object.values(credentials).join("\n"),
): Record<string, string> {
  const host = registrableHost(url) ?? "";
  const normalized: Record<string, string> = {};

  if (host === "cloud.langfuse.com") {
    const secret = firstTokenMatching(haystack, /\bsk-lf-[0-9a-f-]{20,}\b/i);
    const pub = firstTokenMatching(haystack, /\bpk-lf-[0-9a-f-]{20,}\b/i);
    if (secret !== null) {
      normalized.langfuse_secret_key = secret;
      normalized.api_key = secret;
    }
    if (pub !== null) normalized.langfuse_public_key = pub;
    return normalized;
  }

  if (host.endsWith(".neon.tech")) {
    const token = firstTokenMatching(haystack, /\bnapi_[A-Za-z0-9_-]{24,}\b/);
    if (token !== null) {
      normalized.api_token = token;
      normalized.api_key = token;
    }
    return normalized;
  }

  for (const [key, value] of Object.entries(credentials)) {
    const k = normLabelKey(key);
    if (k === "refcode" || k === "referral_code") continue;
    if (isCredentialNoise(value)) continue;
    if ((k === "key" || k === "api_key") && !looksLikeCredentialValue(value)) continue;
    if (host === "api.together.ai" && /^key_[A-Za-z0-9]{16,}$/i.test(value.trim())) continue;
    normalized[key] = value;
  }
  return normalized;
}

export function classifyVouchflowCredentials(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const tok of findCredentialTokens(text)) {
    if (/^vsk_sandbox_read_/i.test(tok) && out.sandbox_read_key === undefined) {
      out.sandbox_read_key = tok;
    } else if (/^vsk_sandbox_/i.test(tok) && out.sandbox_write_key === undefined) {
      out.sandbox_write_key = tok;
    } else if (/^vsk_live_read_/i.test(tok) && out.live_read_key === undefined) {
      out.live_read_key = tok;
    } else if (/^vsk_live_/i.test(tok) && out.live_write_key === undefined) {
      out.live_write_key = tok;
    }
  }
  return out;
}

// Reveal masked keys, then classify every on-page string source through the
// SAME exported regex policy the bot uses (extractApiKeyFromText +
// isTruncatedCapture + extraction.ts accumulation). Reuses the substrate —
// no new credential regexes.
export async function extractCredentials(sessionId: string): Promise<ExtractResult> {
  const session = sessionForCall(sessionId);
  if (session === undefined) throw new Error(`unknown provision session ${sessionId}`);
  const { browser } = session;

  // The masked-display trap: click reveal/show toggles before reading.
  await browser.revealMaskedCredentials();

  const labeled = await browser.extractLabeledCredentialCandidates();
  const inputs = await browser.extractAllInputValues();
  const nearCopy = await browser.extractCredentialsNearCopyButtons();
  const text = await browser.extractVisibleText();

  // Fail CLOSED on a login wall / anti-bot interstitial: scraping it yields only
  // session/CSRF/asset tokens, and handing one back is a false-green. Refuse,
  // and tell the host why so it can drive an interactive login instead.
  const blocked = detectExtractionBlock(text);
  if (blocked !== null) {
    audit(sessionId, "extract", { found: false, blocked_reason: blocked });
    return {
      session_id: sessionId,
      url: browser.currentUrl(),
      credentials: {},
      candidate_count: 0,
      blocked_reason: blocked,
    };
  }

  // Copy-only key surfaces (e.g. LangWatch's /settings/api-keys) never render
  // the value into the DOM — it goes to the clipboard on a "Copy" click. Read
  // it (clipboard-read is granted at context creation).
  const clip = await browser.readClipboard().catch(() => "");

  // Primary api_key: first FULL hit wins; a truncated/masked hit is the fallback.
  let state = initialExtractionState();
  const sources: string[] = [...labeled.map((c) => c.value), ...inputs, ...nearCopy, clip, text];
  const haystack = sources.join("\n");
  for (const src of sources) {
    if (hasFullHit(state)) break;
    const key = extractApiKeyFromText(src);
    if (key === null) continue;
    // Reject an env-var NAME mistaken for a key — a "LANGWATCH_API_KEY="
    // display (the SDK snippet shows `LANGWATCH_API_KEY=sk-lw-…`) would
    // otherwise win first-full and mask the real token. Skip it so scanning
    // reaches the actual secret further down the source list.
    if (/^[A-Z][A-Z0-9_]{2,}=?$/.test(key.trim())) continue;
    if (isCredentialNoise(key)) continue;
    // Reject too-short non-secrets (UI noise like "Ctrl+K"). Real API keys are
    // long; a sub-12-char "key" is a false positive, never a credential.
    if (key.trim().length < 12) continue;
    // Reject a code identifier scraped off a page (the X-tombstone false-green).
    if (looksLikeCodeIdentifier(key)) continue;
    const cls: CandidateClass = isTruncatedCapture(src, key)
      ? { kind: "truncated", value: key }
      : { kind: "full", value: key };
    state = accumulateCandidate(state, cls);
  }

  // Named credentials for multi-cred services (skip still-masked values and
  // env-var NAME displays — "LANGWATCH_API_KEY=" is the SDK-snippet prefix, not
  // a credential).
  const named: Record<string, string> = {};
  for (const c of labeled) {
    if (c.label === null || c.isMasked) continue;
    if (isCredentialNoise(c.value)) continue;
    if (looksLikeCodeIdentifier(c.value)) continue;
    const k = normLabelKey(c.label);
    if (k.length > 0 && !(k in named)) named[k] = c.value;
  }

  // resolveExtraction (the regex-found primary key) wins over a same-named
  // labeled candidate, so a "API Key" label carrying the env-var snippet can
  // never clobber the real `api_key`.
  const credentials: Record<string, string> = {
    ...named,
    ...classifyVouchflowCredentials(haystack),
    ...resolveExtraction(state),
  };

  // Relaxed near-copy fallback: a PREFIXLESS, SEPARATORLESS key (deepinfra's
  // `Hb1bT6VZJdM2cvxVKdm2WCL3kdg6VNNz`) that the strict scanners refuse from raw
  // text but which was harvested from beside a copy/reveal affordance — that
  // proximity is the disambiguator. Only when nothing better surfaced an api_key
  // (a labeled or prefixed key always wins), so this can't clobber a real match.
  if (!("api_key" in credentials)) {
    const relaxed = pickRelaxedNearCopyCredential(nearCopy);
    if (relaxed !== null && !Object.values(credentials).includes(relaxed)) {
      credentials.api_key = relaxed;
    }
  }

  // Multi-credential: a service may present several keys of the SAME family
  // (VouchFlow shows a vsk_ write AND a vsk_ read). Surface only tokens that
  // repeat a family already captured for THIS service — a cross-family token that
  // merely shares the page (a Resend dashboard's mcp-… widget beside the real re_
  // key) is page noise, not a second credential, and surfacing it pollutes the
  // credential + allow-lists an unrelated token to the service host (capture bug
  // 2026-07-09). A prefixless primary (deepinfra) yields no family, so no extras.
  const families = new Set(
    Object.values(credentials)
      .map((v) => (typeof v === "string" ? keyFamilyPrefix(v) : null))
      .filter((f): f is string => f !== null),
  );
  const have = new Set(Object.values(credentials));
  let n = 1;
  for (const tok of findCredentialTokens(haystack)) {
    if (have.has(tok)) continue;
    if (n >= 8) break; // cap extras so page noise can't flood the result
    const fam = keyFamilyPrefix(tok);
    if (fam === null || !families.has(fam)) continue;
    have.add(tok);
    n += 1;
    credentials[`api_key_${n}`] = tok;
  }
  const sanitized = sanitizeExtractedCredentials(credentials, browser.currentUrl(), haystack);
  const found = Object.keys(sanitized).length > 0;
  // Report-back so the agent keeps going instead of treating an empty result as
  // done: if the page HAD labeled candidates but none survived as a real
  // credential, they were page noise (a date/email/greeting) or a still-masked
  // display — i.e. this isn't the keys page or the key needs revealing. Tell the
  // agent that so it navigates/reveals and extracts again, rather than storing junk.
  const notLegit =
    !found && labeled.length > 0
      ? "no_legit_credential: the page had candidate values but none looked like a " +
        "real key (they were page text — a date/email/label — or a still-masked " +
        "display). You are likely NOT on the API-keys page, or the key is masked. " +
        "Navigate to the keys/settings page (or click reveal/show/copy), then extract again."
      : null;
  audit(sessionId, "extract", {
    found,
    candidate_count: labeled.length,
    not_legit: notLegit !== null,
  });
  return {
    session_id: sessionId,
    url: browser.currentUrl(),
    credentials: sanitized,
    candidate_count: labeled.length,
    ...(notLegit !== null ? { blocked_reason: notLegit } : {}),
  };
}

// ── captcha gate (thick tool) ──

// Fail-fast hand-back when a captcha can't be cleared in-session. Carries the
// SPECIFIC gate + the EXACT remedy so the host surfaces an actionable message
// and stops driving immediately, instead of churning toward a dead end.
export interface NeedsUserCaptcha {
  gate: "captcha_solver" | "captcha_wall";
  message: string;
  remedy: string;
}

export interface CaptchaGateResult {
  session_id: string;
  found: boolean;
  variant: string;
  // True when the page has a captcha response token and no challenge remains
  // rendered. False means the host should surface needs_user and hand back.
  settled: boolean;
  // Present only when settled=false: tells the host WHY and what to do.
  needs_user?: NeedsUserCaptcha;
}

// A TwoCaptchaVaultProxy backed by the MCP api-client: every 2Captcha call is
// routed through use_credential against the vaulted "2captcha" credential, so
// the raw key is injected server-side and never lives in this process. The
// ${SECRET} placeholder goes in the query (`key`) or JSON body (`clientKey`)
// per the request's keyInjection; the proxy substitutes it at the boundary.
export function makeTwoCaptchaVaultProxy(api: ApiClient): TwoCaptchaVaultProxy {
  return {
    async request(req) {
      const http: {
        method: string;
        url: string;
        headers?: Record<string, string>;
        body?: string;
        query?: Record<string, string>;
      } = { method: req.method, url: req.url };
      if (req.keyInjection.in === "query") {
        http.query = { ...(req.query ?? {}), [req.keyInjection.name]: "${SECRET}" };
      } else {
        http.headers = { "content-type": "application/json" };
        http.body = JSON.stringify({
          [req.keyInjection.name]: "${SECRET}",
          ...(req.jsonBody ?? {}),
        });
      }
      const { response } = await api.useCredential({ service: "2captcha", http });
      return {
        ok: response.status >= 200 && response.status < 300,
        status: response.status,
        json: async () => JSON.parse(response.body) as unknown,
      };
    },
  };
}

// Build the right-transport solver for a session: vault-proxy when the install
// vaulted a "2captcha" credential (key never in this process), else the env key
// (TWOCAPTCHA_API_KEY, back-compat). Listing creds is metadata-only — no secret.
async function buildTwoCaptchaSolver(session: Session): Promise<TwoCaptchaSolver> {
  if (session.api !== undefined) {
    try {
      const { credentials } = await session.api.listCredentials();
      const hasVaulted = credentials.some((c) => (c.service ?? "").toLowerCase() === "2captcha");
      if (hasVaulted) {
        return new TwoCaptchaSolver({ vaultProxy: makeTwoCaptchaVaultProxy(session.api) });
      }
    } catch {
      // Listing failed (offline / transient) — fall back to the env key.
    }
  }
  return new TwoCaptchaSolver();
}

async function solveCaptchaWithTokenSolver(
  solver: TwoCaptchaSolver,
  browser: BrowserController,
  variant: string,
): Promise<{ solved: boolean; outcome: string }> {
  if (!solver.isAvailable()) return { solved: false, outcome: "no_key" };

  if (variant === "recaptcha_v2" || variant === "recaptcha_v3") {
    const sitekey = await browser.extractRecaptchaSitekey();
    if (sitekey === null) return { solved: false, outcome: "missing_sitekey" };
    const res = await solver.solveRecaptchaV2({
      sitekey,
      pageUrl: browser.currentUrl(),
      ...(variant === "recaptcha_v3" ? { invisible: true } : {}),
    });
    if (res.kind !== "ok") return { solved: false, outcome: res.kind };
    const injected = await browser.injectRecaptchaToken(res.token);
    if (!injected) return { solved: false, outcome: "inject_failed" };
    return {
      solved: await browser.waitForCaptchaResponseToken(2_000),
      outcome: "ok",
    };
  }

  if (variant === "hcaptcha") {
    const sitekey = await browser.extractHcaptchaSitekey();
    if (sitekey === null) return { solved: false, outcome: "missing_sitekey" };
    const ctx = await browser.getHcaptchaSolveContext();
    const res = await solver.solveHcaptcha({
      sitekey,
      pageUrl: browser.currentUrl(),
      invisible: ctx.invisible,
      ...(ctx.userAgent !== null ? { userAgent: ctx.userAgent } : {}),
      ...(ctx.rqdata !== null ? { data: ctx.rqdata } : {}),
    });
    if (res.kind !== "ok") return { solved: false, outcome: res.kind };
    const injected = await browser.injectHcaptchaToken(res.token);
    if (!injected) return { solved: false, outcome: "inject_failed" };
    return {
      solved: await browser.waitForCaptchaResponseToken(2_000),
      outcome: "ok",
    };
  }

  if (variant === "turnstile") {
    const sitekey = await browser.extractTurnstileSitekey();
    if (sitekey === null) return { solved: false, outcome: "missing_sitekey" };
    const res = await solver.solveTurnstile({ sitekey, pageUrl: browser.currentUrl() });
    if (res.kind !== "ok") return { solved: false, outcome: res.kind };
    const injected = await browser.injectTurnstileToken(res.token);
    if (!injected) return { solved: false, outcome: "inject_failed" };
    return {
      solved: await browser.waitForCaptchaResponseToken(2_000),
      outcome: "ok",
    };
  }

  return { solved: false, outcome: "unsupported_variant" };
}

// Detect a captcha and drive the substrate's provider-specific gate. A hidden
// response token is the success signal; challenge disappearance alone is not
// enough because a reCAPTCHA v2 checkbox can be idle with an empty token.
export async function captchaGate(sessionId: string): Promise<CaptchaGateResult> {
  const session = sessionForCall(sessionId);
  if (session === undefined) throw new Error(`unknown provision session ${sessionId}`);
  const det = await session.browser.detectCaptchaVariant();
  const found = det.variant !== "unknown" || det.challengeRendered;
  if (!found) {
    audit(sessionId, "captcha_gate", { found: false });
    return { session_id: sessionId, found: false, variant: "none", settled: true };
  }

  let token = await session.browser.waitForCaptchaResponseToken(750);
  let solvedBySubstrate = false;
  let tokenSolverOutcome: string | null = null;

  if (!token && det.variant === "recaptcha_v3") {
    // Try the in-browser invisible execution first; if it mints no token AND a
    // 2Captcha key is configured, escalate to the token solver (best-effort —
    // #279). With NO solver configured, solveCaptchaWithTokenSolver returns
    // "no_key" and a v3 failure stays an IP/behavior scoring wall (needs_user →
    // captcha_wall below), NOT a "set up 2Captcha" prompt.
    solvedBySubstrate = await session.browser.triggerInvisibleRecaptcha(9_000);
    token = solvedBySubstrate || (await session.browser.waitForCaptchaResponseToken(2_000));
    if (!token) {
      const solver = await buildTwoCaptchaSolver(session);
      const tokenSolved = await solveCaptchaWithTokenSolver(solver, session.browser, det.variant);
      tokenSolverOutcome = tokenSolved.outcome;
      token = tokenSolved.solved;
    }
  } else if (
    !token &&
    (det.variant === "recaptcha_v2" || det.variant === "hcaptcha" || det.variant === "turnstile")
  ) {
    // #279: route a configured token solver FIRST for the checkbox-family
    // captchas; solveCaptchaWithTokenSolver returns outcome "no_key" when none
    // is configured, so we fall through to the visible-captcha click below.
    const solver = await buildTwoCaptchaSolver(session);
    const tokenSolved = await solveCaptchaWithTokenSolver(solver, session.browser, det.variant);
    tokenSolverOutcome = tokenSolved.outcome;
    token = tokenSolved.solved;
    if (!token) {
      const solved = await session.browser.solveVisibleCaptcha(30_000);
      solvedBySubstrate = solved.found && solved.solved;
      token = solvedBySubstrate || (await session.browser.waitForCaptchaResponseToken(2_000));
    }
  }

  const clear = await session.browser.waitForCaptchaChallengeToSettle(token ? 5_000 : 15_000);
  const settled =
    det.variant === "unknown" ? clear : token && (clear || tokenSolverOutcome === "ok");

  // Fail-fast: if we couldn't clear it, hand the host a specific, actionable
  // reason so it stops driving immediately. `no_key` means a 2Captcha solver
  // would have been tried but isn't configured → tell the user to set one up.
  // Anything else (incl. v3/Turnstile IP/behavior scoring 2Captcha can't help)
  // is a wall → suggest a residential proxy or a manual signup.
  let needs_user: NeedsUserCaptcha | undefined;
  if (!settled) {
    needs_user =
      // "set up 2Captcha" advice only fits the checkbox-family captchas a solver
      // can actually clear. An invisible/v3 failure with no key is a scoring wall
      // → captcha_wall (proxy / manual), even though the solver was attempted.
      tokenSolverOutcome === "no_key" && det.variant !== "recaptcha_v3"
        ? {
            gate: "captcha_solver",
            message:
              "This signup hit an image captcha the bot couldn't clear on its own, " +
              "and no 2Captcha solver is configured.",
            remedy:
              "Set up 2Captcha, then retry: `npx @trusty-squire/mcp settings` → " +
              "advanced options → enable 2Captcha (paste your 2Captcha API key, " +
              "stored encrypted in your vault).",
          }
        : {
            gate: "captcha_wall",
            message:
              `A ${det.variant} captcha could not be solved automatically ` +
              "(usually IP/behavior scoring, which a solver can't bypass).",
            remedy:
              "Route the bot through a residential proxy " +
              "(`npx @trusty-squire/mcp settings` → advanced → proxy URL), or " +
              "complete this one signup manually.",
          };
  }

  audit(sessionId, "captcha_gate", {
    found: true,
    variant: det.variant,
    settled,
    token,
    substrate: solvedBySubstrate,
    ...(tokenSolverOutcome !== null ? { token_solver: tokenSolverOutcome } : {}),
    ...(needs_user !== undefined ? { needs_gate: needs_user.gate } : {}),
  });
  return {
    session_id: sessionId,
    found: true,
    variant: det.variant,
    settled,
    ...(needs_user !== undefined ? { needs_user } : {}),
  };
}

// ── email verification (thick tool — user-inbox-via-browser) ──

// Flow A hand-back (wall-handoff design): the inbox poll found no code, but the
// thick session is STILL LIVE, so this is resumable, not a give-up. The host
// asks the user for the code (SMS / authenticator / not-yet-delivered email),
// then types it with operate_act and keeps driving. Session + vault moat
// preserved. See docs/ARCHITECTURE.md.
export interface NeedsUserCode {
  wall: "verification_code";
  message: string;
  resume: "code";
}

export interface VerificationResult {
  session_id: string;
  found: boolean;
  // A short numeric OTP if one appears in the matching mail, else null. NULL
  // when sealed (the code was stashed into a slot — use type_secret to enter it).
  code: string | null;
  // A verification/confirm link if present, else null. The host decides whether
  // to goto it (it is within the target's own domain → already domain-scoped).
  link: string | null;
  // Set when found=false: the code wasn't auto-retrievable from the inbox. The
  // session is alive — ASK THE USER for the code and type it, don't abandon.
  needs_user?: NeedsUserCode;
  // Set when into_slot was requested AND a code was found: the OTP was sealed
  // into a session slot (host gets only the masked handle) so it never round-
  // trips through the host. Enter it with operate_act type_secret{slot,target}.
  sealed?: boolean;
  slot?: SlotHandle;
  // The sender address the code/link was read from (e.g. "search-api@brave.com"),
  // best-effort from the opened mail header. Lets the caller VERIFY the code came
  // from the expected service before using it — a broad (no-sender) search can
  // surface an unrelated sender's OTP, so this makes a wrong-sender grab visible.
  source_from?: string;
}

export interface AwaitVerificationOptions {
  // Narrow the Gmail search to the sending service, e.g. "resend.com".
  sender?: string;
  // Seal a found OTP into this session slot instead of returning it, so the
  // code is typed via type_secret and never crosses the MCP boundary to the
  // host (also dodges host-side payload truncation — see T3).
  intoSlot?: string;
  // PR3b — JIT consent at the verification wall. The host sets this true ONLY
  // after the user agrees, in-context, to let the operator read their inbox.
  // Grants inbox-read for the rest of THIS session (the remembered cache, so we
  // don't re-prompt on every await); it does NOT change the standing install
  // flag. Headless/no-user → the host never sets it, so the gate still refuses.
  grantConsent?: boolean;
}

// Pure verification parser (exported for unit tests). Extracts a {code, link}
// from mail text + its links. A 4-8 digit code is PREFERRED when it sits near
// an OTP keyword ("code"/"verification"/"otp"/"passcode"), so a date or order
// number elsewhere in the mail doesn't win; falls back to the first standalone
// 4-8 digit run. The link uses the bot's pickVerificationLink heuristic.
const OTP_ANY_RE = /(?:^|[^0-9])(\d{4,8})(?:[^0-9]|$)/g;
const OTP_KEYWORD_RE =
  /(?:code|verification|verify|otp|passcode|one[- ]time)\D{0,40}?(\d{4,8})|(\d{4,8})\D{0,8}?(?:code|verification|verify|otp|passcode)/i;

export function parseVerification(
  text: string,
  links: readonly string[],
): { code: string | null; link: string | null } {
  const link = pickVerificationLink([...links]);
  const kw = OTP_KEYWORD_RE.exec(text);
  let code: string | null = null;
  if (kw !== null) {
    code = kw[1] ?? kw[2] ?? null;
  } else {
    const m = OTP_ANY_RE.exec(text);
    code = m !== null ? (m[1] ?? null) : null;
  }
  return { code, link };
}

// Best-effort sender address from an OPENED Gmail message: Gmail renders the
// header as "Name <addr@domain>". Returned as source_from so a caller can verify
// the code came from the expected service — a no-sender search can otherwise
// surface an unrelated sender's OTP (Brave signup 2026-07-04: a GO2bank code was
// grabbed instead of Brave's). Exported for unit tests.
export function extractSenderEmail(text: string): string | null {
  const m = /<([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})>/.exec(text);
  return m !== null ? m[1]!.toLowerCase() : null;
}

// Pure: assemble the verification result. When neither a code nor a link was
// found, the thick session is still live, so this is a RESUMABLE hand-back
// (Flow A) — the host asks the user for the code and types it — not a give-up.
// Exported for unit tests.
export function buildVerificationResult(
  sessionId: string,
  code: string | null,
  link: string | null,
  sourceFrom: string | null = null,
): VerificationResult {
  const found = code !== null || link !== null;
  const src = sourceFrom !== null ? { source_from: sourceFrom } : {};
  if (found) return { session_id: sessionId, found, code, link, ...src };
  const needs_user: NeedsUserCode = {
    wall: "verification_code",
    message:
      "No verification email found in the inbox YET. Most often it just hasn't " +
      "arrived (they commonly take 10–30s) — call operate_await_verification AGAIN " +
      "in a few seconds. If it still fails, the code may have gone by SMS/" +
      "authenticator: ask the user for it and type it with operate_act. The " +
      "session stays live either way.",
    resume: "code",
  };
  return { session_id: sessionId, found, code, link, needs_user, ...src };
}

// PR2 — consent refusal. The user has not consented to the operator reading
// their inbox, so we do NOT read it. The session stays live (resumable): the
// host asks the user for the code and types it, or the user grants inbox consent
// and retries. Distinct message from buildVerificationResult so the host can tell
// "consent withheld" apart from "code not found in an inbox we DID read".
// Exported for unit tests.
export function buildConsentRefusal(sessionId: string): VerificationResult {
  const needs_user: NeedsUserCode = {
    wall: "verification_code",
    message:
      "Inbox reading is not consented, so the operator did not read any mail. Ask " +
      "the user, in context: may the operator read your inbox to fetch the code for " +
      "this signup? If YES, retry operate_await_verification with " +
      "grant_inbox_consent:true (grants it for the rest of this session). If NO, " +
      "ask them for the code and type it with operate_act — the session is still " +
      "live either way. (To grant it permanently, re-run `connect` and allow inbox access.)",
    resume: "code",
  };
  return { session_id: sessionId, found: false, code: null, link: null, needs_user };
}

// The inbox search query. Covers verification/OTP AND passwordless sign-in /
// magic-link vocabulary — a passwordless "Login link" email (Loops: "Please
// login… Login") carries NONE of the OTP words, so the old keyword clause
// excluded the very email we needed and await returned found:false. MEASURED
// 2026-07-01 (Loops login magic link: body has "login", link is
// /api/auth/callback/email?token=…, which pickVerificationLink now extracts).
// Exported for unit tests.
export function buildVerificationSearchQuery(sender?: string): string {
  return [
    sender !== undefined && sender.length > 0 ? `from:${sender}` : "",
    "newer_than:1d",
    '(verify OR verification OR confirm OR confirmation OR code OR otp OR passcode OR password OR login OR "log in" OR "sign in" OR "sign-in" OR signin OR "magic link" OR activate OR activation OR welcome)',
  ]
    .filter((s) => s.length > 0)
    .join(" ");
}

export async function awaitVerification(
  sessionId: string,
  opts: AwaitVerificationOptions = {},
): Promise<VerificationResult> {
  const session = sessionForCall(sessionId);
  if (session === undefined) throw new Error(`unknown provision session ${sessionId}`);
  const { browser } = session;

  // PR3b — JIT consent grant: the host passes grantConsent ONLY after the user
  // agreed in-context. Grant inbox-read for the rest of this session (remembered
  // so we don't re-prompt each await); does not touch the standing install flag.
  if (opts.grantConsent === true && !session.consentInboxRead) {
    session.consentInboxRead = true;
    audit(sessionId, "inbox_consent_granted", { scope: "session" });
  }
  // PR2 fail-closed gate: without inbox-read consent, do NOT read the user's
  // mail. Hand the code request back to the user instead (resumable). The old
  // behavior read mail.google.com unconditionally, silently breaking the
  // default-off consent promise.
  if (!session.consentInboxRead) {
    audit(sessionId, "await_verification", { refused: "no_inbox_consent" });
    return buildConsentRefusal(sessionId);
  }

  const query = buildVerificationSearchQuery(opts.sender);
  const searchUrl = `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(query)}`;
  const hrefsOf = (els: readonly { href?: string | null }[]): string[] =>
    els.map((e) => e.href).filter((h): h is string => typeof h === "string" && h.length > 0);

  // A verification email commonly lands 10–30s AFTER the trigger, so a single
  // search misses it and hands back "not found" the agent has to re-issue. Re-run
  // the search up to 3× with a short wait between attempts within this one call.
  let code: string | null = null;
  let link: string | null = null;
  let sourceFrom: string | null = null;
  for (let attempt = 0; attempt < 3 && code === null && link === null; attempt++) {
    sourceFrom = null;
    if (attempt > 0) await browser.waitForCaptchaChallengeToSettle(4000, 0).catch(() => false);
    // Internal navigation (not an agent goto) — sanctioned read of the user's mail.
    await browser.goto(searchUrl);
    // Poll briefly for the result list to render.
    let listText = "";
    for (let i = 0; i < 6; i++) {
      listText = await browser.extractVisibleText();
      if (listText.length > 200) break;
      await browser.waitForCaptchaChallengeToSettle(1200, 0).catch(() => false);
    }
    const listLinks = hrefsOf(await browser.extractInteractiveElements());
    const opened = await browser.openFirstMailResult().catch(() => false);
    if (opened) {
      // Parse the OPENED email as the AUTHORITATIVE source. Merging the
      // results-list snippets let an UNRELATED sender's code (a bank OTP shown in
      // the list) override the target email's link — a real wrong-code grab
      // (Brave signup 2026-07-04: a GO2bank "verification code is 580210" beat
      // Brave's verify LINK). The list snippets stay a fallback only, for when the
      // mail won't open (an OTP-in-snippet still works then).
      const openedText = await browser.extractVisibleText();
      const openedLinks = hrefsOf(await browser.extractInteractiveElements());
      sourceFrom = extractSenderEmail(openedText);
      ({ code, link } = parseVerification(openedText, [...openedLinks, ...listLinks]));
    } else {
      ({ code, link } = parseVerification(listText, listLinks));
    }
  }
  const found = code !== null || link !== null;
  audit(sessionId, "await_verification", {
    sender: opts.sender ?? null,
    source_from: sourceFrom,
    has_code: code !== null,
    has_link: link !== null,
    sealed: opts.intoSlot !== undefined && code !== null,
    needs_user: !found,
  });
  // Seal the OTP into a slot when asked: the host gets a masked handle, not the
  // code, and enters it with type_secret. The link (not secret) is still returned.
  if (opts.intoSlot !== undefined && code !== null) {
    const handle = stashSecretSlot(sessionId, opts.intoSlot, code);
    return {
      session_id: sessionId,
      found: true,
      code: null,
      link,
      sealed: true,
      slot: handle,
      ...(sourceFrom !== null ? { source_from: sourceFrom } : {}),
    };
  }
  return buildVerificationResult(sessionId, code, link, sourceFrom);
}

export interface FinishResult {
  session_id: string;
  url: string;
  closed: true;
}

export async function finishProvisionSession(sessionId: string): Promise<FinishResult> {
  const session = sessionForCall(sessionId);
  if (session === undefined) throw new Error(`unknown provision session ${sessionId}`);
  const url = session.browser.currentUrl();
  audit(sessionId, "finish", { url });
  sessions.delete(sessionId);
  try {
    await releaseWarmBrowserPage(session.browser);
  } finally {
    inFlight = false;
  }
  const expired = warmBrowser !== null ? warmBrowserExpired(warmBrowser) : null;
  if (expired !== null) await closeWarmBrowserIfIdle(expired);
  else touchWarmBrowser();
  return { session_id: sessionId, url, closed: true };
}

// Test/teardown helper — close every live session (used by the dev shim on exit).
export async function closeAllProvisionSessions(): Promise<void> {
  for (const id of [...sessions.keys()]) {
    try {
      await finishProvisionSession(id);
    } catch {
      /* best-effort */
    }
  }
  await closeWarmBrowserIfIdle("shutdown");
}

export function activeSessionCount(): number {
  return sessions.size;
}
