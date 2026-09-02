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

import { createHash, createHmac, randomBytes, randomInt, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BrowserController,
  CHECKOUT_SUBMIT_LABEL_RE,
  clickDispatchStatusForError,
  parseCheckoutAmount,
  type ClickDispatchStatus,
  type CheckoutSummary,
  type FrameTarget,
  type InteractiveElement,
  type PageTargetSafetySignals,
  type ThreeDsResolution,
} from "./browser.js";
import type {
  CartCheckoutObservation,
  PendingApprovalWait,
  PendingCardFill,
  PendingThreeDsWait,
  TerminalPaymentApprovalStatus,
} from "./pay-operator.js";
import { TwoCaptchaSolver, type TwoCaptchaVaultProxy } from "./captcha-solver-2captcha.js";
import {
  buildSafeControlsV2,
  checkoutStageFromUrlV2,
  compactV2LegacyRefForHandle,
  compactV2PayloadWithinBudget,
  controlMatchesPrivateQueryV2,
  diffSafeControlsV2,
  equalSafePageSemanticsV2,
  encodeV2Delta,
  encodeV2Page,
  safeDescriptionV2,
  safeOriginV2,
  safePageSemanticsV2,
  sealRetainedInteractiveElementsV2,
  safeStageV2,
  type SafeControlV2,
  type ObservationSemanticSourceV2,
  type SafePageSemanticsV2,
  type SafeObservationBaselineV2,
  type SafeObservationIndexV2,
  type SafeStageV2,
} from "./compact-observation-v2.js";
import type { ApiClient } from "../api-client.js";
import { extractApiKeyFromText, isTruncatedCapture } from "./credential-text.js";
import { pickVerificationLink } from "./email-verification.js";
import {
  acquireProfileOperationGuard,
  CHROME_PROFILE_DIR,
  ProfileBusyError,
  type ProfileOperationLease,
  waitForProfileFree,
} from "./profile.js";
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
  isCheckoutShapeKey,
  isSameRecipeDomain,
  knownRecipeInputValue,
  localeStableFieldRole,
  operatorRecipeDomain,
  operatorRecipeKeyForDomain,
  canonicalVerb,
  extractActionPath,
  checkoutFieldSetSignature,
  checkoutShapeKey,
  readRecipe,
  resolveRecipeFieldTarget,
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
  findOtpCredential,
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
import {
  OperatorBrowserWatchdog,
  type OperatorBrowserWatchdogReason,
} from "./operator-browser-watchdog.js";

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
  // The origin of the <iframe> this element lives in (same- or cross-origin),
  // e.g. "https://checkout.merchant.com". Absent for an ordinary main-frame
  // element — every pre-existing observation shape is unchanged. Load-bearing
  // signal, not decoration: operate_act re-derives which frame to act in (and
  // which domain-lock guard applies) from this, never from the top page's URL.
  frame_origin?: string | null;
  // PCI controls are deliberately still observable, but they are never ordinary
  // planner inputs: only operate_pay may fill a vaulted card into them.
  payment_field?: PaymentField;
  interaction?: "vaulted_card_only";
  recommended_action?: { tool: "operate_pay"; phase: "fill_card" };
}

export type PaymentField =
  | "card_number"
  | "expiry"
  | "expiry_month"
  | "expiry_year"
  | "security_code"
  | "cardholder_name";

export interface CheckoutMoney {
  amount_cents: number;
  currency: string;
}

// A compact purchase-state overlay. This is intentionally separate from the
// raw accessibility inventory: a cart is a business state, not a pile of DOM
// controls, and small models must not infer it from repeated add buttons.
export interface CheckoutState {
  authority: "informational_only";
  completeness: "best_effort";
  authoritative_for_payment: false;
  stage: "product" | "cart" | "checkout";
  product_identity: string | null;
  options_hash: string | null;
  quantity: number | null;
  subtotal: CheckoutMoney | null;
  shipping: CheckoutMoney | null;
  payable_total: CheckoutMoney | null;
  cart_url: string | null;
  next_action:
    | { tool: "operate_act"; kind: "click"; intent: "proceed_to_checkout" }
    | { tool: "operate_pay"; phase: "fill_card" }
    | { tool: "operate_observe" };
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
  // V1 emits the full page location. Compact V2 emits only a screened origin;
  // its path/query remain inside the sealed page identity.
  url: string;
  // Registry route guidance, present ONLY on the first (start) observation when
  // a skill exists for the service. The host agent reads it before driving.
  hint?: string;
  // V1 layout-aware page prose (innerText), capped to keep tool payloads
  // bounded. Compact V2 deliberately emits an empty string.
  text: string;
  // Domain-aware steering for the host planner. This is not a script; it is
  // guardrail context for states the raw page text routinely misleads agents on.
  guidance?: string;
  // V1 full-mode relational view of interactive DOM regions. This is
  // intentionally smaller than raw DOM but preserves hierarchy/occlusion that
  // flat text loses.
  screen?: ScreenOutline;
  // V1 AXI-style planner scan surface. Additive in full mode: the rich
  // `elements` inventory remains the source of truth for actionability/state.
  accessibility?: AccessibilitySnapshot;
  // V1 FULL-mode element inventory (the legacy escape hatch): one JSON object
  // per element with every field. In V1 COMPACT mode `elements` is absent and
  // the element set rides on `el_table` instead (see below).
  elements?: ObservedElement[];
  // V1 COMPACT-mode element inventory as a tab-delimited table
  // (docs/DESIGN-observe-compact.md § Legacy V1 Phase 4). The first line is a
  // tab-joined HEADER naming the
  // columns present in this emit (a subset of ref,label,tag,role,type,value_len,
  // checked,href,testId,topmost,occluded_by,frame_origin, always starting
  // ref,label,tag);
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
  // V1 compact-mode bookkeeping so omission is never silent: the complete
  // current element count (including delta/collapsed omissions), and whether
  // page text was capped at 4000 characters. Absent in full mode.
  elements_total?: number;
  text_truncated?: boolean;
  // True when a dialog/modal region (role="dialog", <dialog>, aria-modal="true")
  // currently has at least one topmost (unoccluded) element — i.e. a modal is
  // open and interactable. Omitted (never `false`) when no modal is active, so
  // its presence alone is the signal.
  modal_active?: boolean;
  // V1 per-session observe delta (docs/DESIGN-observe-compact.md). On a DELTA
  // emit,
  // `el_table` carries ONLY the rows whose compact form changed vs the previous
  // observation; `delta` is true and `unchanged` counts the elements that were
  // identical and therefore omitted (present in the persisted snapshot_file).
  // `removed` lists refs that were present last observe and are now gone
  // (usually empty). On a FULL compact emit `delta` is false and
  // `unchanged`/`removed` are absent; `el_table` is the resync set but may omit
  // collapsed chrome links that remain in snapshot_file. If persistence fails,
  // snapshot_file is absent and `el_table` is instead complete and uncollapsed.
  // A full snapshot is emitted on the first observe, a URL change, or high churn
  // (SPA re-render). Compact V2 also uses `delta:true`, but only for its sealed
  // safe map; it never exposes the V1 snapshot or inventory recovery fields.
  delta?: boolean;
  unchanged?: number;
  removed?: string[];
  // V1-only: set on a DELTA emit when the (normalized, same-cap) page text is
  // identical to the previous observation's — the `text` field is then emitted
  // EMPTY and the host reuses the prior text (recoverable in full from
  // snapshot_file).
  // Corpus-measured: 38% of re-observes have byte-identical text, and the text
  // blob is a large share of each observe.
  text_unchanged?: boolean;
  // V1 FULL compact emit only: count of plain chrome-region <a> links collapsed
  // out of `el_table` (a site-dependent bonus). The collapsed links stay in
  // snapshot_file. Buttons/inputs/dismiss controls are never collapsed.
  chrome_links_collapsed?: number;
  // Every V1 observe writes the COMPLETE current snapshot (all elements, WITH
  // the verbose `path` field) to this session-scoped file, so the host can
  // re-expand the full inventory after ITS own context compacts, or grep for an
  // element the delta didn't re-show. Compact V2 never writes or emits this path.
  snapshot_file?: string;
  // Phase 2 — set to "none" on the minimal ack returned by
  // operate_act{observe:"none"} (action ran; no perception emitted — call
  // operate_observe before the next ref-targeted act).
  observed?: ObserveDetail;
  // A provider-owned OAuth popup closed while a legacy two-step OAuth action
  // was still settling. This is an expected browser lifecycle transition, not
  // a failed login or a reason to abandon the session. The host should simply
  // re-observe; the controller will retain or reattach the product page.
  oauth?: {
    state: "in_progress";
    provider_page: "closed_or_detached";
    next_action: "operate_observe";
  };
  // Change 5 — fail-closed identity hand-back: set ONLY when an operate task
  // required a live Google session that was absent. The task did NOT start; the
  // host asks the user to log in, then retries. No browser was driven.
  needs_user?: NeedsUserLogin;
  // PR3 signin-vault: the user's own email (the Google identity captured at
  // login), present on the start observation when known. The host fills THIS as
  // the signup email so the account is user-owned, and it is the same identity
  // whose inbox awaitVerification reads. Absent when no email was captured.
  user_email?: string;
  // Present whenever this observation is part of a cart/checkout flow (and
  // always after a cart mutation). It supplies one unambiguous next action.
  checkout_state?: CheckoutState;
  // The postcondition for a cart-add attempt. `unknown` is honest when the
  // merchant did not expose a count we can verify; callers still receive the
  // canonical cart URL and safe retry semantics from operate_act { kind: "cart_add" }.
  cart_delta?: "+1" | "0" | "unknown";
  selected_option?: string;
  // compact-v2's closed action map. It is intentionally value-free and does
  // not use the V1 snapshot-file recovery protocol.
  format?: "compact-v2";
  stage?: SafeStageV2;
  generation?: number;
  safe_table?: SafeControlV2[];
  semantic?: SafePageSemanticsV2;
  overflow?: { remaining: number; next_cursor: string };
  hint_overflow?: { remaining: number; next_cursor: string };
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
  // text = the option to match (e.g. "South Korea"). Frame execution routes
  // through BrowserController.selectInFrame, which owns its narrower contract.
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
  // Route every OAuth-provider action through the narrow auth lease. This
  // serializes only the provider login/capture moment; all other work remains
  // parallel.
  | { kind: "oauth_click"; target: string; provider?: OAuthProviderId }
  // Return to the product page after the OAuth handshake completes.
  | { kind: "oauth_settle" }
  // Atomic operator OAuth action. A recovery product tab and explicit provider
  // lifecycle tracking prevent a normal provider close from leaving the model
  // on a detached Playwright handle.
  | { kind: "oauth_login"; target: string; provider?: OAuthProviderId }
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
  failure?: { reason: "field_missing" | "field_value_mismatch"; field: string };
  // replay-per-leg-signature — index of this recipe's OWN first money field,
  // or null when none exists. > 0 means there's a genuine non-money prefix
  // (a catalog/storefront leg) ahead of it, which is what lets a field
  // failure degrade to leg_fallback_required instead of the terminal
  // human_required — see humanRequired in replayOperatorRecipe.
  legStartIndex: number | null;
}

interface RecordedValueSource {
  traceIndex: number;
  hole?: string;
  literal: string;
}

interface CartAddRecord {
  productIdentity: string;
  optionsHash: string;
  idempotencyKey: string;
  phase: "reserved" | "click_started" | "complete";
  promise: Promise<CartAddResult> | null;
  result: CartAddResult | null;
}

interface CartMutation {
  productIdentity: string | null;
  optionsHash: string | null;
  cartDelta: "+1" | "0" | "unknown";
  origin: string;
}

interface CartIdentityContext {
  productIdentity: string;
  optionsHash: string;
  onActionReady?: () => void;
}

interface SessionTerminalTeardownOwner {
  forced: boolean;
  forcePromise: Promise<unknown | undefined> | null;
  routinePromise: Promise<void> | null;
  requireProvenBrowserClose: boolean;
}

interface PaymentDispatchHandoff {
  state: PendingThreeDsWait;
  settled: Promise<void>;
  resolveSettled: () => void;
  terminalizing: boolean;
  terminalComplete: boolean;
  released: boolean;
  auditPromise: Promise<void> | null;
}

export interface Session {
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
  compactV2Secret: Buffer;
  compactV2Mode: "off" | "shadow" | "on";
  compactV2HintPages: string[];
  /** True once this session has emitted V2; target resolution stays sealed until finish. */
  compactV2Active: boolean;
  compactV2Refs: Map<string, string>;
  compactV2Index: SafeObservationIndexV2 | null;
  // Safe enum-only prior map. Repeat observes diff this representation, never
  // raw DOM output, so every delta remains inside the allowlist
  // seal even when a page mutates confidential values or live regions.
  compactV2Previous: SafeObservationBaselineV2 | null;
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
  // operate_finish on a verified success.
  captureRounds: OnboardingRoundCapture[];
  // Deliverable #1 measurement (docs/DESIGN-operator-hints.md): when the session
  // started and whether a registry hint was served this run, so finish emits the
  // hint-on vs hint-off lift signal (success rate + time, bucketed).
  startedAt: number;
  hintServed: boolean;
  // The session's START url (service_url at operate_start, or the resolved
  // entry on an operate_recipe_run replay). Persisted as the recipe's canonical
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
  // Set when a step used the text=/css= locator action fallback. Such an action
  // resolves off-inventory, so it cannot be synthesized into a portable skill
  // step — this flag suppresses auto-promotion so no silently-incomplete skill
  // ships (captureAndPromoteSession).
  usedLocatorFallback: boolean;
  recipeRejectionReason: string | null;
  replayState: ReplayState | null;
  // One session-wide payment lease is claimed before any await. The
  // pending -> confirming transition prevents duplicate confirmation, while
  // submitStarted forbids restoring retry state after a charge may have begun.
  // "sealed" survives unverified field cleanup and blocks later payments.
  // "awaiting_approval" is the rest state after one bounded operate_pay wait:
  // the human has not approved or denied yet. A later operate_pay call resumes
  // the same approval. Once denial or expiry is observed, terminal_approval
  // keeps that attempt in custody and its private operator key is scrubbed.
  activePayment:
    | { status: "operating"; lease: ActivePaymentLease }
    | { status: "awaiting_approval"; state: PendingApprovalWait }
    | {
        status: "terminal_approval";
        state: PendingApprovalWait;
        terminalStatus: TerminalPaymentApprovalStatus;
      }
    | { status: "pending"; pending: PendingCardFill }
    | { status: "confirming"; pending: PendingCardFill; submitStarted: boolean }
    | { status: "sealed" }
    | null;
  paymentFieldSealActive: boolean;
  // A completed operate_pay single-page submit whose post-submit outcome wait
  // exhausted its budget with no terminal signal. Deliberately NOT part of
  // activePayment: the card is already released and the charge already
  // submitted, so there is no lease to hold and no re-authorization risk —
  // this is resumable bookkeeping for operate_payment_status,
  // mirroring the "awaiting_approval" gap it closes for the pre-charge wait.
  // Set by setActivePendingThreeDs, read by getActivePendingThreeDs, cleared
  // by clearActivePendingThreeDsIfCurrent once resolved or its deadline passes.
  pendingThreeDs: PendingThreeDsWait | null;
  paymentDispatchHandoff: PaymentDispatchHandoff | null;
  // Snapshot of the single approval a filled card belongs to, captured at
  // fill time (setActivePendingCardFill / completeActivePaymentLeaseWithPendingFill)
  // so the place-order guard below still has what it needs after activePayment
  // itself has moved on to "confirming" or "sealed" (sealed drops `pending`).
  // Cleared only at session (re)init or after verified full field cleanup.
  placeOrderApproval: {
    approvalId: string;
    mandateId?: string;
    merchant: string;
    amountCents: number;
    currency: string;
    cardRef: string;
    last4: string;
  } | null;
  // True once a checkout-submit-labeled operate_act click has fired against
  // placeOrderApproval. A second one is refused — one human passkey approval
  // authorizes at most one place-order attempt (see enforcePlaceOrderGuard).
  placeOrderAttempted: boolean;
  // The most recent real checkout total this session actually observed on a
  // page (e.g. the cart step), scoped to that page's own origin. Split
  // checkouts (Rakuten-style) show no total on the card-entry page itself;
  // operate_pay {phase:"fill_card"} falls back to this ONLY when the live
  // card-entry page has no readable total of its own, and only when the
  // origin still matches. Replaced (never accumulated) on each successful
  // observe of a page with a parseable total; never a caller-supplied value.
  lastCartCheckout: CartCheckoutObservation | null;
  // Per-line idempotency records are local to the one active browser/cart. A
  // retry must inspect this before it ever reaches a merchant add button.
  cartAdds: Map<string, CartAddRecord>;
  cartAddsByIdempotencyKey: Map<string, CartAddRecord>;
  cartUrls: Map<string, string>;
  lastCartMutation: CartMutation | null;
  // A finish first flips this bit, then waits for outstanding call leases.  A
  // session-addressed operation always captures the Session object before it
  // awaits, so a later session can never be substituted into an old callback.
  closing: boolean;
  // The session is visible before operate_start's initial navigation and
  // observation finish. Idle cleanup must not cross that action boundary.
  initializing: boolean;
  // Tool activity is recorded at both entry and terminal completion. An idle
  // browser is eligible only when no action lease is held.
  lastActivityAt: number;
  callCount: number;
  callDrainWaiters: Set<() => void>;
  paymentCallCount: number;
  paymentCallDrainWaiters: Set<() => void>;
  paymentDispatchClosed: boolean;
  // Session ownership must be a resource boundary, not merely a convention for
  // cooperative hosts. The watchdog observes the browser but teardown may only
  // begin between complete action leases.
  watchdog: OperatorBrowserWatchdog | null;
  terminalTeardownOwner: SessionTerminalTeardownOwner | null;
}

// Plain host list for the pieces that only need the names (goto gate, audit,
// observed-hosts). The source metadata stays on the Session.
function hostStrings(session: Session): string[] {
  return session.allowedHosts.map((e) => e.host);
}

const SERVICE_LOGIN_ROUTE_HOSTS: Readonly<Record<string, readonly string[]>> = {
  "neon.com": ["console.neon.tech"],
};

function serviceLoginRouteHosts(allowedHosts: readonly string[]): string[] {
  return [
    ...new Set(
      allowedHosts.flatMap(
        (allowed) => SERVICE_LOGIN_ROUTE_HOSTS[allowed.trim().toLowerCase()] ?? [],
      ),
    ),
  ];
}

function requestScopeHostStrings(session: Session): string[] {
  const allowedHosts = hostStrings(session);
  return [...allowedHosts, ...serviceLoginRouteHosts(allowedHosts)];
}

// Hosts that may seed credential EGRESS (where a stored key is later sent by
// the proxy): start + auto_widen, never mid_session task scope — a wide operate
// scope must not silently over-grant a key's egress allow-list (Codex). The
// vault unions these with the service-default + any agent-declared egress_hosts.
function egressSeedHosts(session: Session): string[] {
  return session.allowedHosts.filter((e) => e.source !== "mid_session").map((e) => e.host);
}

function merchantSiblingSeedHosts(session: Session): string[] {
  return session.allowedHosts.filter((e) => e.source !== "mid_session").map((e) => e.host);
}

const sessions = new Map<string, Session>();
// A Google-gated start returns an ID so the caller can correlate its handoff,
// but it never creates a browser session. Its terminal acknowledgement is a
// no-op rather than an "unknown session" error.
const refusedStartSessionIds = new Set<string>();

interface LeasedBrowser {
  controller: BrowserController;
  profileDir: string;
  lease: ProfileOperationLease;
  shutdownGeneration: number;
  proxyUrl?: string;
}

interface AcquiredBrowser {
  controller: BrowserController;
  profileDir: string;
  shutdownGeneration: number;
}

interface StartingBrowser {
  controller: BrowserController | null;
  profileDir: string;
  launch: Promise<void>;
  cancelRequested: boolean;
  cleanupPromise: Promise<"closed" | "force_closed_unproven" | "unknown"> | null;
  quiescencePromise: Promise<"closed" | "force_closed_unproven" | "unknown"> | null;
  retainProfileUntilQuiescent: boolean;
}

const leasedBrowsers = new Map<BrowserController, LeasedBrowser>();
const startingBrowsers = new Set<StartingBrowser>();
let shutdownGeneration = 0;
let shutdownInProgress = 0;
let oauthActionLeaseTail: Promise<void> = Promise.resolve();

const DEFAULT_OAUTH_LOGIN_LEASE_COOLDOWN_MS = 3_000;
const DEFAULT_OAUTH_ACTION_TIMEOUT_MS = 30_000;

interface OAuthActionDeadline {
  expiresAt: number;
  timeoutMs: number;
  provider: OAuthProviderId | undefined;
  controller: AbortController;
  timedOut: boolean;
  inFlight: Set<Promise<unknown>>;
  cancellations: Set<() => Promise<unknown> | void>;
}

function oauthActionTimeoutMs(): number {
  const configured = Number(process.env.TRUSTY_SQUIRE_OAUTH_ACTION_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0
    ? Math.min(configured, DEFAULT_OAUTH_ACTION_TIMEOUT_MS)
    : DEFAULT_OAUTH_ACTION_TIMEOUT_MS;
}

function oauthActionDeadline(provider: OAuthProviderId | undefined): OAuthActionDeadline {
  const timeoutMs = oauthActionTimeoutMs();
  return {
    expiresAt: Date.now() + timeoutMs,
    timeoutMs,
    provider,
    controller: new AbortController(),
    timedOut: false,
    inFlight: new Set(),
    cancellations: new Set(),
  };
}

function oauthActionRemainingMs(deadline: OAuthActionDeadline): number {
  return Math.max(0, deadline.expiresAt - Date.now());
}

function oauthActionCanMutate(deadline: OAuthActionDeadline): boolean {
  return (
    !deadline.timedOut && !deadline.controller.signal.aborted && Date.now() < deadline.expiresAt
  );
}

function trackOAuthActionPromise<T>(
  deadline: OAuthActionDeadline,
  promise: Promise<T>,
): Promise<T> {
  deadline.inFlight.add(promise);
  void promise.then(
    () => deadline.inFlight.delete(promise),
    () => deadline.inFlight.delete(promise),
  );
  return promise;
}

function expireOAuthAction(deadline: OAuthActionDeadline): void {
  if (deadline.timedOut) return;
  deadline.timedOut = true;
  deadline.controller.abort();
  for (const cancel of deadline.cancellations) {
    try {
      const result = cancel();
      if (result instanceof Promise) void trackOAuthActionPromise(deadline, result);
    } catch {}
  }
}

function registerOAuthActionCancellation(
  deadline: OAuthActionDeadline,
  cancel: () => Promise<unknown> | void,
): () => void {
  deadline.cancellations.add(cancel);
  return () => deadline.cancellations.delete(cancel);
}

async function waitForOAuthActionQuiescence(deadline: OAuthActionDeadline): Promise<void> {
  for (;;) {
    const pending = [...deadline.inFlight];
    if (pending.length === 0) {
      await Promise.resolve();
      if (deadline.inFlight.size === 0) return;
      continue;
    }
    await Promise.allSettled(pending);
  }
}

function oauthActionDeadlineError(deadline: OAuthActionDeadline): Error {
  if (deadline.provider === undefined || deadline.provider === "google") {
    return Object.assign(
      new Error(
        `google_session: OAuth did not complete within ${Math.ceil(deadline.timeoutMs / 1000)} seconds; ` +
          "the saved session may have expired, so re-login before retrying",
      ),
      { code: "google_session" },
    );
  }
  return new Error(
    `OAuth action did not complete within ${Math.ceil(deadline.timeoutMs / 1000)} seconds`,
  );
}

async function withinOAuthActionDeadline<T>(
  promise: Promise<T>,
  deadline: OAuthActionDeadline,
): Promise<T> {
  const tracked = trackOAuthActionPromise(deadline, promise);
  const remainingMs = oauthActionRemainingMs(deadline);
  if (remainingMs <= 0 || deadline.timedOut) {
    expireOAuthAction(deadline);
    throw oauthActionDeadlineError(deadline);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      tracked,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          expireOAuthAction(deadline);
          reject(oauthActionDeadlineError(deadline));
        }, remainingMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function oauthLoginLeaseCooldownMs(): number {
  const configured = Number(process.env.TRUSTY_SQUIRE_OAUTH_LOGIN_COOLDOWN_MS);
  return Number.isFinite(configured) && configured >= 0
    ? Math.min(configured, 60_000)
    : DEFAULT_OAUTH_LOGIN_LEASE_COOLDOWN_MS;
}

async function waitForOAuthLeaseCooldown(cooldownMs: number): Promise<void> {
  if (cooldownMs <= 0) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, cooldownMs);
    timer.unref();
  });
}

async function withOAuthActionLease<T>(
  deadline: OAuthActionDeadline | undefined,
  run: () => Promise<T>,
  releaseCooldownMs = 0,
): Promise<T> {
  let release!: () => void;
  const previous = oauthActionLeaseTail;
  const turn = new Promise<void>((resolve) => {
    release = resolve;
  });
  oauthActionLeaseTail = previous.then(() => turn);
  let acquired = false;
  try {
    if (deadline === undefined) await previous;
    else await withinOAuthActionDeadline(previous, deadline);
    acquired = true;
    return await run();
  } finally {
    if (deadline === undefined) {
      release();
    } else if (!acquired) {
      void previous.then(release, release);
    } else {
      void waitForOAuthActionQuiescence(deadline)
        .then(() => waitForOAuthLeaseCooldown(releaseCooldownMs))
        .then(release, release);
    }
  }
}

async function withOAuthActionBoundary<T>(
  session: Session,
  provider: OAuthProviderId | undefined,
  run: (deadline: OAuthActionDeadline) => Promise<T>,
): Promise<T> {
  const deadline = oauthActionDeadline(provider);
  const releaseCooldownMs = oauthLoginLeaseCooldownMs();
  const unregisterCancellation = registerOAuthActionCancellation(deadline, () =>
    quiesceOAuthActionSession(session),
  );
  try {
    return await withOAuthActionLease(
      deadline,
      async () => {
        return await withinOAuthActionDeadline(run(deadline), deadline);
      },
      releaseCooldownMs,
    );
  } finally {
    unregisterCancellation();
  }
}

function provisionStartGeneration(): number {
  if (shutdownInProgress > 0) {
    throw new Error("operate_start cancelled: operator server is shutting down");
  }
  return shutdownGeneration;
}

function assertProvisionStartAdmitted(generation: number): void {
  if (shutdownInProgress > 0 || generation !== shutdownGeneration) {
    throw new Error("operate_start cancelled: operator server is shutting down");
  }
}

async function acquireWarmBrowser(opts: StartOptions, sessionId: string): Promise<AcquiredBrowser> {
  const generation = provisionStartGeneration();
  if ((process.env.BOT_CDP_ENDPOINT ?? "").trim().length > 0) {
    throw new Error("operate_start does not support remote CDP with the local Chrome profile");
  }
  const profileDir = opts.profileDir ?? CHROME_PROFILE_DIR;
  // This lease is held for the complete operate session. Its on-disk owner
  // records host + pid + process birth time, so a crashed holder is reclaimed
  // while a live or indeterminate holder is never stolen.
  const lease = acquireProfileOperationGuard(profileDir);
  if (!(await waitForProfileFree(profileDir, { deadlineMs: 0 }))) {
    lease.release();
    throw new ProfileBusyError("another Trusty Squire session is already using the browser — close it first");
  }
  const pending: StartingBrowser = {
    controller: null,
    profileDir,
    launch: Promise.resolve(),
    cancelRequested: false,
    cleanupPromise: null,
    quiescencePromise: null,
    retainProfileUntilQuiescent: false,
  };
  startingBrowsers.add(pending);
  let controller: BrowserController | null = null;
  try {
    if (pending.cancelRequested) {
      throw new Error("operate_start cancelled: operator server is shutting down");
    }
    controller = new BrowserController({
      profileDir,
      ...(opts.proxyUrl !== undefined ? { proxyUrl: opts.proxyUrl } : {}),
    });
    pending.controller = controller;
    pending.launch = startBrowserBounded(controller, sessionId, async () => {
      await cancelStartingBrowser(pending);
    });
    await pending.launch;
    if (pending.cancelRequested) {
      throw new Error("operate_start cancelled: operator server is shutting down");
    }
    assertProvisionStartAdmitted(generation);
  } catch (err) {
    if (controller !== null) await controller.close().catch(() => undefined);
    lease.release();
    throw err;
  } finally {
    startingBrowsers.delete(pending);
  }
  if (controller === null) {
    throw new Error("operate_start cancelled before browser initialization");
  }
  leasedBrowsers.set(controller, {
    controller,
    profileDir,
    lease,
    shutdownGeneration: generation,
    ...(opts.proxyUrl === undefined ? {} : { proxyUrl: opts.proxyUrl }),
  });
  return {
    controller,
    profileDir,
    shutdownGeneration: generation,
  };
}

async function releaseWarmBrowserPage(
  browser: BrowserController,
  _persistState: boolean,
  owner?: SessionTerminalTeardownOwner,
): Promise<void> {
  const leased = leasedBrowsers.get(browser);
  try {
    if (owner?.forced) throw new Error("operator browser terminal teardown was forced");
    await browser.close();
  } finally {
    leasedBrowsers.delete(browser);
    leased?.lease.release();
  }
}

async function forceReleaseWarmBrowserPage(
  browser: BrowserController,
  owner?: SessionTerminalTeardownOwner,
): Promise<void> {
  const leased = leasedBrowsers.get(browser);
  await closeBrowserUntilProven(
    browser,
    false,
    "operator browser force-close timed out",
    () => owner?.requireProvenBrowserClose === true,
  );
  if (leased === undefined) return;
  leased.lease.release();
  leasedBrowsers.delete(browser);
}

async function quiesceOAuthActionSession(session: Session): Promise<void> {
  // The deadline makes this session terminal before the host can issue its
  // usual operate_finish. Record its one no-op acknowledgement before awaiting
  // browser teardown, which can itself be waiting on the cancelled OAuth call.
  refusedStartSessionIds.add(session.id);
  await forceTerminateProvisionSession(
    session,
    "oauth_action_terminalize",
    { reason: "action_deadline" },
    true,
    true,
  );
}

async function closeBrowserBounded(
  browser: BrowserController,
  cancelStart: boolean,
  timeoutMessage: string,
  maximumTimeoutMs?: number,
): Promise<"closed" | "force_closed_unproven" | "unknown"> {
  const forceClose = (
    browser as BrowserController & {
      forceCloseOwnedProcessTree?: () => Promise<"closed" | "force_closed_unproven" | "unknown">;
    }
  ).forceCloseOwnedProcessTree;
  const ordinaryClose = browser
    .close(cancelStart ? { cancelStart: true } : undefined)
    .catch(() => "unknown" as const);
  const forcedClose =
    forceClose === undefined
      ? ordinaryClose
      : forceClose.call(browser).catch(() => "unknown" as const);
  const closed = Promise.race([
    ordinaryClose.then((state) => (state === "closed" ? state : forcedClose)),
    forcedClose.then((state) => (state === "closed" ? state : ordinaryClose)),
  ]);
  const configuredTimeoutMs = positiveTimeout(
    "TRUSTY_SQUIRE_OPERATOR_FORCE_CLOSE_TIMEOUT_MS",
    DEFAULT_OPERATOR_FORCE_CLOSE_TIMEOUT_MS,
  );
  const timeoutMs =
    maximumTimeoutMs === undefined
      ? configuredTimeoutMs
      : Math.max(1, Math.min(configuredTimeoutMs, maximumTimeoutMs));
  return await withTerminalTimeout(closed, timeoutMs, timeoutMessage).catch(
    () => "unknown" as const,
  );
}

async function closeBrowserUntilProven(
  browser: BrowserController,
  cancelStart: boolean,
  timeoutMessage: string,
  requireProof: () => boolean,
): Promise<"closed" | "force_closed_unproven" | "unknown"> {
  let closeState = await closeBrowserBounded(browser, cancelStart, timeoutMessage);
  while (closeState !== "closed" && requireProof()) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 25);
    });
    closeState = await closeBrowserBounded(browser, true, timeoutMessage);
  }
  return closeState;
}

async function cancelStartingBrowser(
  pending: StartingBrowser,
  maximumTimeoutMs?: number,
): Promise<"closed" | "force_closed_unproven" | "unknown"> {
  pending.cancelRequested = true;
  if (pending.cleanupPromise !== null) return await pending.cleanupPromise;
  pending.cleanupPromise = (async () => {
    if (pending.controller === null) {
      return "closed" as const;
    }
    const closeState = await closeBrowserBounded(
      pending.controller,
      true,
      "operator browser startup cancellation timed out",
      maximumTimeoutMs,
    );
    return closeState;
  })();
  return await pending.cleanupPromise;
}

async function quiesceStartingBrowser(
  pending: StartingBrowser,
  requireProvenClose = false,
): Promise<"closed" | "force_closed_unproven" | "unknown"> {
  pending.retainProfileUntilQuiescent = true;
  if (pending.quiescencePromise === null) {
    pending.quiescencePromise = (async () => {
      let closeState = await cancelStartingBrowser(pending);
      if (pending.controller === null) return closeState;
      await pending.controller.waitForCancelledStartQuiescence();
      if (closeState !== "closed") {
        closeState = await closeBrowserBounded(
          pending.controller,
          true,
          "operator browser startup cancellation did not quiesce",
        );
      }
      return closeState;
    })();
    void pending.quiescencePromise.then(
      (closeState) => {
        if (closeState === "closed") startingBrowsers.delete(pending);
      },
      () => undefined,
    );
  }
  let closeState = await pending.quiescencePromise;
  while (closeState !== "closed" && requireProvenClose) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 25);
    });
    closeState = await closeBrowserBounded(
      pending.controller!,
      true,
      "operator browser startup cancellation did not quiesce",
    );
  }
  if (closeState === "closed") startingBrowsers.delete(pending);
  return closeState;
}

async function runSerializedGoogleIdentityOperation<T>(
  session: Session,
  operation: (browser: BrowserController) => Promise<T>,
  options: { deadline?: OAuthActionDeadline } = {},
): Promise<{ browser: BrowserController; result: T }> {
  const browser = session.browser;
  const result =
    options.deadline === undefined
      ? await operation(browser)
      : await withinOAuthActionDeadline(operation(browser), options.deadline);
  return { browser, result };
}

async function runDetachedGoogleIdentityOperation<T>(
  session: Session,
  operation: (browser: BrowserController) => Promise<T>,
): Promise<T> {
  return await withOAuthActionLease(
    undefined,
    async () => (await runSerializedGoogleIdentityOperation(session, operation)).result,
  );
}
async function runSerializedOAuthBoundary(
  session: Session,
  authorizedElement: InteractiveElement,
  authorizedElements: readonly InteractiveElement[],
  provider: OAuthProviderId | undefined,
  deadline: OAuthActionDeadline,
): Promise<BrowserController> {
  const authorizedRef = provisionElementRefs(authorizedElements).get(authorizedElement);
  if (authorizedRef === undefined) {
    throw new Error("OAuth action target was not present in the authorized action map");
  }
  const expectedGoogleAccountEmail = session.userEmail ?? undefined;
  const completed = await runSerializedGoogleIdentityOperation(
    session,
    async (browser) => {
      // The action was authorized against the session's isolated browser before
      // the canonical profile was opened. Re-extract inside the same serialized
      // operation and require the identical structural element identity before
      // clicking; this keeps stale-handle protection without letting a prepared
      // canonical browser escape the boundary on reobserve_required.
      const fresh = await browser.extractInteractiveElements();
      retainSessionElements(session, fresh);
      const resolved = resolveTarget(fresh, authorizedRef);
      if (resolved === null) {
        throw new Error(
          "OAuth action target changed during the identity handoff; re-observe before retrying",
        );
      }
      await browser.loginWithOAuth(
        resolved.selector,
        oauthActionRemainingMs(deadline),
        provider,
        provider === "github" ? undefined : expectedGoogleAccountEmail,
      );
      await settleAfterStateChange(browser);
    },
    { deadline },
  );
  return completed.browser;
}

function stopSessionWatchdog(session: Session): void {
  session.watchdog?.stop();
}

function disposeSessionWatchdog(session: Session): void {
  session.watchdog?.dispose();
  session.watchdog = null;
}

const DEFAULT_PENDING_THREE_DS_FINALIZE_TIMEOUT_MS = 3_000;
const DEFAULT_SESSION_TERMINAL_TRANSITION_TIMEOUT_MS = 30_000;
const DEFAULT_OPERATOR_FORCE_CLOSE_TIMEOUT_MS = 3_000;

function positiveTimeout(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

async function withTerminalTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function forceTerminateProvisionSession(
  session: Session,
  event: string,
  detail: Record<string, unknown>,
  auditPendingThreeDs = true,
  requireProvenBrowserClose = false,
): Promise<unknown | undefined> {
  session.paymentDispatchClosed = true;
  const owner =
    session.terminalTeardownOwner ??
    (session.terminalTeardownOwner = {
      forced: false,
      forcePromise: null,
      routinePromise: null,
      requireProvenBrowserClose: false,
    });
  if (requireProvenBrowserClose) owner.requireProvenBrowserClose = true;
  if (owner.forcePromise !== null) {
    const terminalError = await owner.forcePromise;
    if (owner.requireProvenBrowserClose && leasedBrowsers.has(session.browser)) {
      await forceReleaseWarmBrowserPage(session.browser, owner);
    }
    return terminalError;
  }
  owner.forced = true;
  owner.forcePromise = forceTerminateProvisionSessionOwned(
    session,
    event,
    detail,
    auditPendingThreeDs,
  );
  return await owner.forcePromise;
}

async function forceTerminateProvisionSessionOwned(
  session: Session,
  event: string,
  detail: Record<string, unknown>,
  auditPendingThreeDs: boolean,
): Promise<unknown | undefined> {
  session.closing = true;
  stopSessionWatchdog(session);
  audit(session.id, event, detail);
  const handoff = session.paymentDispatchHandoff;
  if (handoff !== null) {
    handoff.terminalizing = true;
    const timeoutMs = positiveTimeout(
      "TRUSTY_SQUIRE_OPERATOR_PENDING_3DS_FINALIZE_TIMEOUT_MS",
      DEFAULT_PENDING_THREE_DS_FINALIZE_TIMEOUT_MS,
    );
    await withTerminalTimeout(
      handoff.settled,
      timeoutMs,
      `payment dispatch handoff exceeded ${timeoutMs}ms`,
    ).catch(() => undefined);
  }
  deregisterProvisionSession(session);
  let terminalError: unknown;
  if (auditPendingThreeDs && session.pendingThreeDs !== null) {
    try {
      await auditPendingThreeDsForSessionCloseBounded(session);
    } catch (error) {
      terminalError = error;
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `[operator] terminal 3DS audit failed session=${session.id}: ${message}\n`,
      );
    }
  }
  if (handoff !== null) {
    handoff.terminalComplete = true;
    if (handoff.released && session.paymentDispatchHandoff === handoff) {
      session.paymentDispatchHandoff = null;
    }
  }
  session.activePayment = null;
  session.paymentFieldSealActive = false;
  session.pendingThreeDs = null;
  const terminalOwner = session.terminalTeardownOwner ?? undefined;
  const ephemeral = leasedBrowsers.get(session.browser);
  if (terminalOwner?.requireProvenBrowserClose === true && ephemeral !== undefined) {
    await Promise.all(
      [...startingBrowsers]
        .filter((pending) => pending.profileDir === ephemeral.profileDir)
        .map(async (pending) => await quiesceStartingBrowser(pending, true)),
    );
  }
  await forceReleaseWarmBrowserPage(session.browser, terminalOwner).catch((error: unknown) => {
    if (terminalError === undefined) terminalError = error;
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[operator] terminal browser close failed session=${session.id}: ${message}\n`,
    );
  });
  disposeSessionWatchdog(session);
  return terminalError;
}

async function terminateExpiredProvisionSession(
  session: Session,
  reason: OperatorBrowserWatchdogReason,
): Promise<boolean> {
  if (
    session.initializing ||
    session.closing ||
    session.callCount > 0 ||
    session.paymentCallCount > 0 ||
    sessions.get(session.id) !== session
  ) {
    return false;
  }
  const owner =
    session.terminalTeardownOwner ??
    (session.terminalTeardownOwner = {
      forced: false,
      forcePromise: null,
      routinePromise: null,
      requireProvenBrowserClose: false,
    });
  if (owner.forcePromise !== null) return false;
  if (owner.routinePromise !== null) {
    await owner.routinePromise;
    return true;
  }
  session.closing = true;
  stopSessionWatchdog(session);
  owner.routinePromise = (async () => {
    if (reason.kind !== "idle_timeout" && session.paymentCallCount > 0) {
      const timeoutMs = positiveTimeout(
        "TRUSTY_SQUIRE_OPERATOR_TERMINAL_TRANSITION_TIMEOUT_MS",
        DEFAULT_SESSION_TERMINAL_TRANSITION_TIMEOUT_MS,
      );
      await withTerminalTimeout(
        waitForPaymentCallsToDrain(session),
        timeoutMs,
        `payment call drain exceeded ${timeoutMs}ms`,
      ).catch(() => undefined);
    }
    if (owner.forcePromise !== null) {
      await owner.forcePromise;
      return;
    }
    await forceTerminateProvisionSession(session, "browser_watchdog_terminate", { ...reason });
  })();
  await owner.routinePromise;
  return true;
}

function startSessionWatchdog(session: Session): void {
  if (session.watchdog !== null) {
    session.watchdog.start();
    return;
  }
  const watchdog = new OperatorBrowserWatchdog({
    startedAt: session.startedAt,
    lastActivityAt: () => session.lastActivityAt,
    hasActiveCall: () =>
      session.initializing || session.callCount > 0 || session.paymentCallCount > 0,
    processMarker: () => session.browser.operatorBrowserMarker?.() ?? null,
    onTerminate: async (reason) => await terminateExpiredProvisionSession(session, reason),
  });
  session.watchdog = watchdog;
  watchdog.start();
}

function sessionForCall(sessionId: string): Session | undefined {
  return sessions.get(sessionId);
}

// Money rule (simplified 2026-08-16): the fence is the live human biometric
// approval per charge, not a software re-check of replay field values. The
// only surviving invariant — a card-charging trace step is never blind-
// replayed — is enforced unconditionally where operate_pay steps are
// encountered during replay (see replayOperatorRecipe), not here.
function assertPaymentSessionAllowed(session: Session): void {
  if (session.closing) {
    throw new Error(`provision session ${session.id} is closing`);
  }
}

// Resolve the compatibility omission once, at tool entry.  In particular, do
// not repeat this lookup in completion callbacks: after an await, a different
// session could otherwise become the sole process-local session.
export function paymentSession(sessionId?: string): Session {
  let session: Session | undefined;
  if (sessionId !== undefined) {
    session = sessionForCall(sessionId);
    if (session === undefined) throw new Error(`unknown provision session ${sessionId}`);
  } else {
    if (sessions.size !== 1) {
      throw new Error(
        sessions.size === 0
          ? "operate_pay requires one active operate_start browser session"
          : "operate_pay requires session_id when multiple operator sessions are active",
      );
    }
    session = sessions.values().next().value!;
  }
  assertPaymentSessionAllowed(session);
  return session;
}

function acquireSessionCallLease(session: Session): () => void {
  if (session.closing) throw new Error(`provision session ${session.id} is closing`);
  session.lastActivityAt = Date.now();
  session.callCount += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    session.callCount -= 1;
    session.lastActivityAt = Date.now();
    if (session.callCount === 0) {
      session.lastActivityAt = Date.now();
      for (const wake of session.callDrainWaiters) wake();
      session.callDrainWaiters.clear();
    }
  };
}

function acquirePaymentCallLease(session: Session): () => void {
  session.paymentCallCount += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    session.paymentCallCount -= 1;
    if (session.paymentCallCount === 0) {
      for (const wake of session.paymentCallDrainWaiters) wake();
      session.paymentCallDrainWaiters.clear();
    }
  };
}

async function waitForPaymentCallsToDrain(session: Session): Promise<void> {
  if (session.paymentCallCount === 0) return;
  await new Promise<void>((resolve) => {
    session.paymentCallDrainWaiters.add(resolve);
  });
}

async function waitForSessionCallsToDrain(session: Session): Promise<void> {
  if (session.callCount === 0) return;
  await new Promise<void>((resolve) => {
    session.callDrainWaiters.add(resolve);
  });
}

async function withSelectedProvisionSessionCall<T>(
  session: Session,
  fn: (session: Session) => Promise<T>,
): Promise<T> {
  const release = acquireSessionCallLease(session);
  try {
    return await fn(session);
  } finally {
    release();
  }
}

export async function withProvisionSessionCall<T>(
  sessionId: string,
  fn: (session: Session) => Promise<T>,
): Promise<T> {
  const session = sessionForCall(sessionId);
  if (session === undefined) throw new Error(`unknown provision session ${sessionId}`);
  return await withSelectedProvisionSessionCall(session, fn);
}

export async function withPaymentSessionCall<T>(
  sessionId: string | undefined,
  fn: (session: Session) => Promise<T>,
): Promise<T> {
  const session = paymentSession(sessionId);
  return await withSelectedProvisionSessionCall(session, async (selectedSession) => {
    const releasePaymentCall = acquirePaymentCallLease(selectedSession);
    try {
      return await fn(selectedSession);
    } finally {
      releasePaymentCall();
    }
  });
}

const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function compactV2AuditValue(key: string, value: unknown): unknown {
  if ((key === "url" || key === "service_url") && typeof value === "string") {
    return compactV2AuditUrl(value);
  }
  if (
    (key === "host" || key === "url_host" || key === "frame_origin" || key === "recipe_domain") &&
    typeof value === "string"
  ) {
    return compactV2AuditHost(value);
  }
  if (key === "allowed_hosts" && Array.isArray(value)) {
    return value.map((host) =>
      typeof host === "string" ? compactV2AuditHost(host) : "<sealed-host>",
    );
  }
  if (typeof value === "string") return safeDescriptionV2(value) ?? "<sealed>";
  if (Array.isArray(value)) return value.map((item) => compactV2AuditValue("", item));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([nestedKey, nestedValue]) => [
        nestedKey,
        compactV2AuditValue(nestedKey, nestedValue),
      ]),
    );
  }
  return value;
}

// Audit trail (security posture): every session action emits one structured
// stderr line the host's MCP log captures. The `provision-audit` marker makes
// the trail greppable. No credential VALUES are ever logged — only the action
// shape + url.
function audit(sessionId: string, event: string, detail: Record<string, unknown> = {}): void {
  const session = sessions.get(sessionId);
  const sealedDetail =
    session?.compactV2Mode === "on"
      ? Object.fromEntries(
          Object.entries(detail).map(([key, value]) => [key, compactV2AuditValue(key, value)]),
        )
      : detail;
  process.stderr.write(
    `${JSON.stringify({ marker: "provision-audit", surface: "operate", session_id: sessionId, event, ...sealedDetail })}\n`,
  );
}

// operate_start's browser launch is the one UNBOUNDED step in the session
// bootstrap: on a fresh box the first launch downloads Chromium, and a wedged
// profile lock or missing browser deps can
// otherwise hang it indefinitely — a real dogfood run sat on a silent ~30-min
// hang here with zero feedback (the worst first-run failure: the user assumes
// it's broken and never comes back). Cap it so a stuck launch fails LOUDLY with
// an actionable message. The default is generous (a cold Chromium download is
// legitimately multi-minute — better to wait than false-fail a slow-but-working
// launch); tune with BOT_START_TIMEOUT_MS. Timeout uses the independent bounded
// cancellation boundary: it releases or quarantines profile custody without
// awaiting the unresolved launch, and late settlement cleans up only this
// controller's marked process.
async function startBrowserBounded(
  browser: BrowserController,
  sessionId: string,
  cancel: () => Promise<void>,
  maximumTimeoutMs?: number,
): Promise<void> {
  const configuredTimeoutMs = Number(process.env.BOT_START_TIMEOUT_MS) || 600_000;
  const timeoutMs =
    maximumTimeoutMs === undefined
      ? configuredTimeoutMs
      : Math.max(1, Math.min(configuredTimeoutMs, maximumTimeoutMs));
  audit(sessionId, "browser_launch", {
    note: "first launch may download Chromium; slow but one-time",
    timeout_ms: timeoutMs,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("__browser_start_timeout__")), timeoutMs);
  });
  try {
    await Promise.race([browser.start(), timeout]);
  } catch (err) {
    if (err instanceof Error && err.message === "__browser_start_timeout__") {
      const cancellation = cancel().catch(() => undefined);
      if (maximumTimeoutMs === undefined) await cancellation;
      throw new Error(
        `operate_start: browser did not launch within ${Math.round(timeoutMs / 1000)}s. ` +
          "On a fresh machine the first launch downloads Chromium — slow but one-time. A hang this long " +
          "usually means browser binaries are missing on this box. Retry once (a partial download resumes and later launches reuse " +
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
// element is now gone finds no match in resolveTarget → returns null → the public
// tool returns structured target_stale guidance and the host re-observes.
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
    elementRef({ ...el, value: null }),
    el.href ?? "",
    el.type ?? "",
    // Frame origin — WITHOUT this, an element's `selector` (folded into
    // stableElementId below) is only unique within its own document, so a
    // same-shaped selector in two different frames (or a frame vs. the main
    // page) could hash to the SAME ref and let an act resolve to the wrong
    // frame's element. Load-bearing for the frame domain-lock: the ref
    // itself must be frame-scoped, not just the guard that later reads it.
    el.frameOrigin ?? "",
    el.framePath ?? "",
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
// control it needs to act on — for example, a bare click-handler <div> the
// inventory never emitted (no role/label/testid, and past the card-scan cap).
// Two forms:
//   text="Add To Cart"  (quotes optional) — matching clickable/typeable element
//   css=#some-id                          — a raw CSS selector
// Resolved directly across live ordinary page/frame documents by
// BrowserController.resolvePageTarget, NOT against the extracted-element
// inventory (which by definition lacks it).
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

// A `type` into an autocomplete field (Google-Places-style address picker,
// react-select/cmdk/Radix combobox) opened a suggestion popup, but the typed
// text didn't resolve to exactly one option — same "N candidates matched,
// stop and ask, never guess" shape as AmbiguousProvisionTargetError. Zero
// candidates and >1 candidates are both a stop, never a confident wrong
// commit (see matchAutocompleteSuggestions).
export class AutocompleteCommitRequiredError extends Error {
  readonly code = "autocomplete_commit_required";

  constructor(
    readonly typedText: string,
    readonly candidates: readonly string[],
  ) {
    super(
      candidates.length === 0
        ? `autocomplete_commit_required: typing "${typedText}" opened a suggestion list but no ` +
            `visible option started with the typed text. Retry with text that matches a suggestion, ` +
            `or issue an explicit select/click on the option you want.`
        : `autocomplete_commit_required: typing "${typedText}" matched ${candidates.length} ` +
            `suggestions, not one. Narrow the typed text or issue an explicit select/click: ` +
            `${candidates.slice(0, 8).join(", ")}`,
    );
  }
}

function normalizeAutocompleteText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

// Match-or-stop rule for 3.1 — pure and unit-testable without a browser. A
// suggestion is a candidate iff the typed text (normalized) is a prefix of
// the option's normalized text (e.g. "350 5th Ave" → "350 5th Ave, New York,
// NY 10118, USA"). Deliberately NOT a bare substring match anywhere in the
// string — too loose, invites the label-swap-class wrong-fill the field-role
// guard (PR #447) exists to prevent. Returns the indices of matching options;
// the caller commits only when there is exactly one.
export function matchAutocompleteSuggestions(
  typedText: string,
  optionTexts: readonly string[],
): number[] {
  const typed = normalizeAutocompleteText(typedText);
  if (typed.length === 0) return [];
  const indices: number[] = [];
  optionTexts.forEach((text, index) => {
    if (normalizeAutocompleteText(text).startsWith(typed)) indices.push(index);
  });
  return indices;
}

export interface TargetStaleResult {
  status: "target_stale";
  target: string;
  // The latest completed observation. The next observe increments this value
  // and supplies the authoritative replacement inventory.
  after_generation: number;
  reobserve_required: true;
  // Best-effort semantic hints only. A label can legitimately map to more than
  // one live ref, so callers must still choose from the next observation.
  replacement_candidates: Record<string, string[]>;
  retry_policy: "do_not_retry_old_ref";
}

// An @e: ref is an observation-scoped handle, not a locator. Preserve that
// distinction in the error so an agent does not retry a stale handle or guess a
// text locator after a SPA rerender.
export class TargetStaleError extends Error {
  readonly code = "target_stale";

  constructor(readonly result: TargetStaleResult) {
    super(`target_stale: re-observe before selecting a replacement for "${result.target}"`);
  }
}

class CompactV2ReobserveRequiredError extends Error {}
class ProvisionTargetNotAllowedError extends Error {}
class ProvisionTargetMissingError extends Error {}
class CompactV2ActionFailureError extends Error {}

function replacementCandidates(elements: readonly InteractiveElement[]): Record<string, string[]> {
  const refs = provisionElementRefs(elements);
  const candidates: Record<string, string[]> = {};
  for (const el of elements) {
    const label = [
      el.labelText,
      el.ariaLabel,
      el.visibleText,
      el.placeholder,
      el.testId,
      el.name,
      el.screenPath,
    ].find(
      (value): value is string => value !== null && value !== undefined && value.trim().length > 0,
    );
    const ref = refs.get(el);
    if (label === undefined || ref === undefined) continue;
    const key = label.replace(/\s+/g, " ").trim();
    if (candidates[key] === undefined) {
      if (Object.keys(candidates).length >= 20) continue;
      candidates[key] = [];
    }
    if (candidates[key]!.length < 4) candidates[key]!.push(ref);
  }
  return candidates;
}

function staleTargetError(
  session: Session,
  target: string,
  fresh: readonly InteractiveElement[],
): TargetStaleError | null {
  if (parseProvisionRef(target) === null) return null;
  return new TargetStaleError({
    status: "target_stale",
    target,
    after_generation: session.generation,
    reobserve_required: true,
    replacement_candidates: replacementCandidates(fresh),
    retry_policy: "do_not_retry_old_ref",
  });
}

function elementTargetKeys(el: InteractiveElement): string[] {
  return [el.screenPath ?? null, el.testId ?? null, elementRef(el)].flatMap((s) => {
    const v = (s ?? "").replace(/\s+/g, " ").trim();
    return v.length > 0 ? [v] : [];
  });
}

const PENDING_CARD_AUTOCOMPLETE_FIELDS = new Set([
  "cc-number",
  "cc-exp",
  "cc-exp-month",
  "cc-exp-year",
  "cc-csc",
  "cc-name",
]);

function isPendingCardFilledField(el: InteractiveElement): boolean {
  const autocomplete = (el.autocomplete ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 0);
  if (autocomplete.some((token) => PENDING_CARD_AUTOCOMPLETE_FIELDS.has(token))) return true;
  if (
    autocomplete.includes("billing") &&
    autocomplete.some((token) =>
      [
        "address-line1",
        "address-line2",
        "address-level1",
        "address-level2",
        "postal-code",
        "country",
      ].includes(token),
    )
  ) {
    return true;
  }

  const name = (el.name ?? "").toLowerCase();
  const id = (el.id ?? "").toLowerCase();
  const ariaLabel = (el.ariaLabel ?? "").toLowerCase();
  const placeholder = (el.placeholder ?? "").toLowerCase();
  return (
    name.includes("cardnumber") ||
    id.includes("card-number") ||
    id.includes("cardnumber") ||
    name.includes("cardholder") ||
    name.includes("card-name") ||
    id.includes("cardholder") ||
    name.includes("cvv") ||
    name.includes("cvc") ||
    name.includes("security-code") ||
    id.includes("cvv") ||
    id.includes("cvc") ||
    ((name.includes("exp") || id.includes("exp")) &&
      (name.includes("month") ||
        name.includes("year") ||
        name.includes("date") ||
        name.includes("expir") ||
        id.includes("month") ||
        id.includes("year") ||
        id.includes("date") ||
        id.includes("expir") ||
        name === "exp" ||
        id === "exp")) ||
    placeholder.replace(/\s+/g, "") === "mm/yy" ||
    ariaLabel.replace(/\s+/g, "") === "mm/yy" ||
    ((name.includes("billing") || id.includes("billing")) &&
      /address|line1|line2|city|locality|state|region|postal|zip|country/.test(`${name} ${id}`))
  );
}

function pendingCardSecretKind(el: InteractiveElement): "pan" | "cvv" | null {
  const autocomplete = (el.autocomplete ?? "").toLowerCase().split(/\s+/);
  const signal = `${el.name ?? ""} ${el.id ?? ""}`.toLowerCase();
  if (
    autocomplete.includes("cc-number") ||
    signal.includes("cardnumber") ||
    signal.includes("card-number")
  ) {
    return "pan";
  }
  if (
    autocomplete.includes("cc-csc") ||
    signal.includes("cvv") ||
    signal.includes("cvc") ||
    signal.includes("security-code")
  ) {
    return "cvv";
  }
  return null;
}

function redactPaymentObservationText(
  text: string,
  elements: readonly InteractiveElement[],
  active: boolean,
): string {
  if (!active) return text;
  let redacted = text;
  for (const element of elements) {
    const kind = pendingCardSecretKind(element);
    const value = element.value?.trim() ?? "";
    if (kind === null || value.length === 0) continue;
    if (kind === "pan") {
      redacted = redactExactDigitSequence(redacted, value.replace(/\D/g, ""));
    }
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    redacted = redacted.replace(
      kind === "cvv" ? new RegExp(`\\b${escaped}\\b`, "g") : new RegExp(escaped, "g"),
      "[sealed payment]",
    );
  }
  redacted = redactLuhnPanSpans(redacted);
  return redacted.replace(
    /\b(cvv|cvc|security\s+code)\s*[:#-]?\s*\d{3,4}\b/gi,
    "$1 [sealed payment]",
  );
}

function presentPaymentSafeString(value: string, paymentSealActive: boolean): string {
  return paymentSealActive ? redactPaymentObservationText(value, [], true) : value;
}

const PAYMENT_PAN_MAX_SPAN_CHARS = 96;

function redactExactDigitSequence(text: string, expectedDigits: string): string {
  if (expectedDigits.length < 13) return text;
  const digitMatches = Array.from(text.matchAll(/\d/g));
  const replacements: Array<{ start: number; end: number }> = [];
  for (let start = 0; start + expectedDigits.length <= digitMatches.length; start += 1) {
    const matches = digitMatches.slice(start, start + expectedDigits.length);
    if (matches.map((match) => match[0]).join("") !== expectedDigits) continue;
    if (matches[matches.length - 1]!.index - matches[0]!.index + 1 > PAYMENT_PAN_MAX_SPAN_CHARS) {
      continue;
    }
    replacements.push({
      start: matches[0]!.index,
      end: matches[matches.length - 1]!.index + 1,
    });
    start += expectedDigits.length - 1;
  }
  if (replacements.length === 0) return text;
  let cursor = 0;
  let result = "";
  for (const replacement of replacements) {
    result += `${text.slice(cursor, replacement.start)}[sealed payment]`;
    cursor = replacement.end;
  }
  return result + text.slice(cursor);
}

function redactLuhnPanSpans(text: string): string {
  const digitPositions = Array.from(text.matchAll(/\d/g), (match) => match.index);
  const replacements: Array<{ start: number; end: number }> = [];
  let startDigit = 0;
  while (startDigit + 13 <= digitPositions.length) {
    let matchedDigits = 0;
    const maxDigits = Math.min(19, digitPositions.length - startDigit);
    for (let length = maxDigits; length >= 13; length -= 1) {
      const positions = digitPositions.slice(startDigit, startDigit + length);
      if (positions[positions.length - 1]! - positions[0]! + 1 > PAYMENT_PAN_MAX_SPAN_CHARS) {
        continue;
      }
      const digits = positions.map((position) => text[position]).join("");
      if (passesLuhn(digits)) {
        matchedDigits = length;
        replacements.push({
          start: positions[0]!,
          end: positions[positions.length - 1]! + 1,
        });
        break;
      }
    }
    startDigit += matchedDigits || 1;
  }
  if (replacements.length === 0) return text;
  let cursor = 0;
  let result = "";
  for (const replacement of replacements) {
    result += `${text.slice(cursor, replacement.start)}[sealed payment]`;
    cursor = replacement.end;
  }
  return result + text.slice(cursor);
}

function observationSealedFieldKeys(
  session: Session,
  elements: readonly InteractiveElement[],
): ReadonlySet<string> {
  if (!session.paymentFieldSealActive) return session.sealedFieldKeys;
  const sealed = new Set(session.sealedFieldKeys);
  for (const el of elements) {
    if (!isPendingCardFilledField(el)) continue;
    for (const key of elementTargetKeys(el)) sealed.add(key);
  }
  return sealed;
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

function invalidateCompactV2Snapshot(
  session: Pick<Session, "compactV2Refs" | "compactV2Index" | "compactV2Previous">,
): void {
  session.compactV2Refs = new Map();
  session.compactV2Index = null;
  session.compactV2Previous = null;
}

function throwCompactV2ReobserveRequired(): never {
  // Deliberately opaque: stale V2 errors must not construct V1 replacement
  // candidates or reveal raw labels/legacy identities outside the safe view.
  throw new CompactV2ReobserveRequiredError("reobserve_required");
}

interface CompactV2TargetAuthorization {
  legacyRef: string;
  row: SafeControlV2;
}

function sameCompactV2Control(left: SafeControlV2, right: SafeControlV2): boolean {
  return (
    left.role === right.role &&
    left.state === right.state &&
    left.visibility === right.visibility &&
    left.action === right.action &&
    left.field === right.field &&
    left.name === right.name &&
    left.choice === right.choice &&
    left.frame === right.frame
  );
}

function compactV2AuthorizationForHandle(
  session: Session,
  target: string,
): CompactV2TargetAuthorization {
  const index = session.compactV2Index;
  if (index === null) throwCompactV2ReobserveRequired();
  if (index.expiresAt < Date.now() || index.pageKey !== compactV2PageKey(session)) {
    invalidateCompactV2Snapshot(session);
    throwCompactV2ReobserveRequired();
  }
  const legacy = compactV2LegacyRefForHandle(session.compactV2Refs, index.generation, target);
  if (legacy === null) throwCompactV2ReobserveRequired();
  const row = index.rows.find((candidate) => candidate.ref === target);
  if (row === undefined) throwCompactV2ReobserveRequired();
  return { legacyRef: legacy, row };
}

function resolveAuthorizedCompactV2Target(
  session: Session,
  elements: readonly InteractiveElement[],
  authorization: CompactV2TargetAuthorization,
): InteractiveElement {
  let pageOrigin = "";
  try {
    pageOrigin = new URL(session.browser.currentUrl()).origin;
  } catch {}
  const safe = buildSafeControlsV2({
    elements,
    legacyRefs: provisionElementRefs(elements),
    generation: session.compactV2Index?.generation ?? 0,
    pageOrigin,
    pageUrl: session.browser.currentUrl(),
  });
  const index = session.compactV2Index;
  if (
    index === null ||
    safe.rows.length !== index.rows.length ||
    safe.byRef.size !== session.compactV2Refs.size ||
    safe.rows.some((row, rowIndex) => !sameCompactV2Control(row, index.rows[rowIndex]!)) ||
    [...safe.byRef].some(([ref, legacy]) => session.compactV2Refs.get(ref) !== legacy)
  ) {
    invalidateCompactV2Snapshot(session);
    throwCompactV2ReobserveRequired();
  }
  let liveRow: SafeControlV2 | undefined;
  for (const [ref, legacyRef] of safe.byRef) {
    if (legacyRef === authorization.legacyRef) {
      liveRow = safe.rows.find((candidate) => candidate.ref === ref);
      break;
    }
  }
  const resolved = resolveTarget(elements, authorization.legacyRef);
  if (
    liveRow === undefined ||
    !sameCompactV2Control(authorization.row, liveRow) ||
    resolved === null
  ) {
    invalidateCompactV2Snapshot(session);
    throwCompactV2ReobserveRequired();
  }
  return resolved;
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
// subdomain of it, exact service-specific login routes, the configured auth
// hosts, and *.firebaseapp.com / *.web.app auth handlers. Organic redirects
// are NOT routed through here.
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
  if (serviceLoginRouteHosts(allowedHosts).includes(host)) return true;
  if (DEFAULT_AUTH_HOSTS.some(ok)) return true;
  if (host.endsWith(".firebaseapp.com") || host.endsWith(".web.app")) return true;
  return false;
}

// Frame domain-lock (operator-frame-support) — the ONE non-negotiable of frame
// support: an action on an element inside a child <iframe> must be checked
// against THAT frame's own origin, never the top page's, or a rogue/payment
// iframe embedded on an otherwise in-scope page could be acted on (or typed
// into) unchecked just because the outer page already passed hostAllowed.
// `el.frameUrl` is undefined/null for an ordinary main-frame element, so this
// is a no-op for every pre-existing target. A frame on the page's own
// registrable domain (the merchant's own checkout iframe — the case this
// feature exists for) is freely reachable, exactly like main-frame content;
// anything else goes through the SAME domain-scope check goto/allow_host
// already use (hostAllowed) — reusing the existing guard, not inventing a
// new trust classifier.
type FrameScopedTarget = Pick<
  InteractiveElement,
  "frameOrigin" | "frameUrl" | "framePath" | "frameOpaque"
>;

function frameTargetFor(el: FrameScopedTarget): FrameTarget | null {
  if (el.framePath === undefined || el.framePath === null) return null;
  if (el.frameOrigin === undefined || el.frameOrigin === null) {
    throw new ProvisionTargetNotAllowedError("frame target lacks an origin");
  }
  return {
    framePath: el.framePath,
    frameOrigin: el.frameOrigin,
    frameUrl: el.frameUrl ?? "",
    ...(el.frameOpaque === true ? { frameOpaque: true } : {}),
  };
}

function frameTargetAllowed(session: Session, el: FrameScopedTarget): boolean {
  const target = frameTargetFor(el);
  if (target === null) return true;
  if (target.frameOpaque === true) return false;
  const pageUrl = session.browser.currentUrl();
  if (isSameRecipeDomain(target.frameOrigin, pageUrl)) return true;
  return hostAllowed(target.frameOrigin, hostStrings(session));
}

function assertFrameTargetAllowed(session: Session, el: FrameScopedTarget, kind: string): void {
  if (frameTargetAllowed(session, el)) return;
  // An opaque (null-origin) frame gets its own TERMINAL refusal: the generic
  // message below suggests allow_host, which can never succeed for a null
  // origin — a remedy the model would loop on forever.
  if (el.frameOpaque === true || el.frameOrigin === "null") {
    throw new ProvisionTargetNotAllowedError(
      `${kind} refused: the target lives in an opaque (null-origin) frame — a sandboxed ` +
        `iframe without allow-same-origin, or an unconfirmed about:blank/srcdoc document. ` +
        `No host declaration can ever permit a null origin; this control is not reachable ` +
        `through operate_act. Drive the page's own controls instead.`,
    );
  }
  throw new ProvisionTargetNotAllowedError(
    `${kind} blocked by domain-scope: the target lives in a cross-domain frame ` +
      `(${el.frameOrigin ?? el.frameUrl}) outside the allowed hosts ` +
      `[${hostStrings(session).join(", ")}] + auth providers. ` +
      `Declare it first with an allow_host action if this task spans it.`,
  );
}

// type_secret is stricter still: a secret may be typed only into the main
// frame or a frame on the page's OWN registrable domain — never into a
// cross-domain (e.g. third-party payment) iframe, even one otherwise allowed
// for navigation/click via hostAllowed's auth-provider carve-outs. A weak
// model must never be able to type a credential into a rogue or payment
// iframe just because that host happens to be allow-listed for OAuth.
function assertSecretFrameTargetAllowed(session: Session, el: FrameScopedTarget): void {
  const target = frameTargetFor(el);
  if (target === null) return;
  if (target.frameOpaque === true) {
    throw new ProvisionTargetNotAllowedError(
      "type_secret refused: the target lives in an opaque frame. Secrets may only be " +
        "typed into the main frame or a frame on the page's own domain.",
    );
  }
  const pageUrl = session.browser.currentUrl();
  if (isSameRecipeDomain(target.frameOrigin, pageUrl)) return;
  throw new ProvisionTargetNotAllowedError(
    `type_secret refused: the target lives in a cross-domain frame ` +
      `(${target.frameOrigin}), not the page's own domain. Secrets may only be ` +
      `typed into the main frame or a frame on the page's own domain.`,
  );
}

// upload/oauth_click have no frame-scoped browser primitive yet (see
// BrowserController.clickInFrame/typeInFrame/selectInFrame —
// click/type/type_secret/select only). Resolving one of these against a
// frame element's `selector` on the MAIN page could silently act on an
// unrelated element that happens to share the same structural selector (a
// real risk for positional/nth-of-type selectors) rather than the intended
// frame element — a correctness and domain-lock hazard, not just a missing
// feature. Refuse explicitly instead.
function assertNoFrameTarget(el: InteractiveElement, kind: string): void {
  if (el.framePath === undefined || el.framePath === null) return;
  throw new ProvisionTargetNotAllowedError(
    `operate_act kind="${kind}" does not yet support a target inside an <iframe> ` +
      `(frame ${el.frameOrigin ?? "unknown"}). Use click/js_click/type/type_secret/select ` +
      `for frame targets.`,
  );
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
        'Extract it immediately with operate_act { kind: "extract" } (use secret_label to pick the ' +
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
        '(submit the email field, then operate_act { kind: "await_verification" } for the code) to ' +
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

// Manual card-entry guard — a model must never be the thing that types a
// payment card number into a page. When operate_pay fails, the recovery is
// surfacing that failure, not routing around the vault by typing the PAN via
// an ordinary `type`. "Card-number-shaped" = a 13–19 digit run (spaces/hyphens
// allowed as grouping) that passes the Luhn checksum — requiring Luhn keeps
// order numbers, tracking numbers, and other long digit strings from
// false-positiving. Scoped to MODEL-SUPPLIED `type` text only: operate_pay's
// vaulted-card fill methods and type_secret's
// sealed-slot transfer never pass through this check.
function passesLuhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

class ManualCardEntryBlockedError extends Error {}

export function manualCardEntryBlockReason(text: string): string | null {
  for (const match of text.matchAll(/\d(?:[\d\s-]*\d)?/g)) {
    const digits = match[0].replace(/[\s-]/g, "");
    if (digits.length >= 13 && digits.length <= 19 && passesLuhn(digits)) {
      return (
        "type refused: the value is card-number-shaped (a 13–19 digit Luhn-valid " +
        "sequence). Manual payment-card entry is not permitted through operate_act — " +
        "the model must never hold or type a card number. Card payment goes through " +
        "operate_pay, which fills the user's vaulted card server-side. If operate_pay " +
        "failed, report that failure to the user instead of entering a card by hand."
      );
    }
  }
  return null;
}

export function buildScreenOutline(
  elements: readonly InteractiveElement[],
  pageText: string,
  sealedFieldKeys: ReadonlySet<string> = new Set<string>(),
  paymentSealActive = false,
): ScreenOutline | undefined {
  if (elements.length === 0) return undefined;
  const byRegion = new Map<string, ScreenRegion>();
  for (const el of elements) {
    const id = el.container ?? "body:root";
    const role = id.split(":")[0] ?? "region";
    const existing = byRegion.get(id);
    const region: ScreenRegion = existing ?? {
      id: presentPaymentSafeString(id, paymentSealActive),
      role: presentPaymentSafeString(role, paymentSealActive),
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
      region.occluded_by = presentPaymentSafeString(el.occludedBy, paymentSealActive);
    }
    if (region.children.length < 10) {
      region.children.push({
        ref:
          el.screenPath !== null && el.screenPath !== undefined
            ? presentPaymentSafeString(el.screenPath, paymentSealActive)
            : presentLabel(el, sealedFieldKeys, paymentSealActive),
        role: el.role === null ? null : presentPaymentSafeString(el.role, paymentSealActive),
        text: presentLabel(el, sealedFieldKeys, paymentSealActive),
        href:
          el.href === null || el.href === undefined
            ? null
            : presentPaymentSafeString(el.href, paymentSealActive),
        topmost: el.topmost ?? null,
        occluded_by:
          el.occludedBy === null || el.occludedBy === undefined
            ? null
            : presentPaymentSafeString(el.occludedBy, paymentSealActive),
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
  if ((el.sealedIdentityKeys ?? []).some((key) => sealed.has(key))) return true;
  return elementTargetKeys(el).some((k) => sealed.has(k));
}
function presentFieldValue(
  el: InteractiveElement,
  sealed: ReadonlySet<string>,
  paymentSealActive = false,
): string | null {
  const v = el.value ?? null;
  if (v === null || v.length === 0) return v;
  return isSealedFieldValue(el, sealed)
    ? SEALED_FIELD_PLACEHOLDER
    : presentPaymentSafeString(v, paymentSealActive);
}
// The host-facing LABEL. elementRef falls back to a field's VALUE when it has no
// other label text — which would leak a sealed secret as the element's name. For
// a sealed field, re-derive the label with the value stripped so it lands on the
// next signal (placeholder/name) or `tag#index`, never the secret. Ref-keying
// and targeting still use the raw elementRef, so resolution is unaffected.
function presentLabel(
  el: InteractiveElement,
  sealed: ReadonlySet<string>,
  paymentSealActive = false,
): string {
  const label = isSealedFieldValue(el, sealed)
    ? elementRef({ ...el, value: null })
    : elementRef(el);
  return presentPaymentSafeString(label, paymentSealActive);
}

export function buildAccessibilitySnapshot(
  elements: readonly InteractiveElement[],
  limit = 12000,
  sealedFieldKeys: ReadonlySet<string> = new Set<string>(),
  paymentSealActive = false,
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
    lines.push(`  region "${presentPaymentSafeString(region, paymentSealActive)}"`);
    for (const el of group.slice(0, 16)) {
      const label = presentLabel(el, sealedFieldKeys, paymentSealActive).replace(/"/g, '\\"');
      const role = presentPaymentSafeString(roleForAccessibility(el), paymentSealActive);
      const shownValue = presentFieldValue(el, sealedFieldKeys, paymentSealActive);
      const flags = [
        el.value !== undefined && el.value !== null
          ? `value="${(shownValue ?? "").slice(0, 60)}"`
          : null,
        el.checked !== undefined && el.checked !== null ? `checked=${el.checked}` : null,
        el.href !== undefined && el.href !== null
          ? `href="${presentPaymentSafeString(el.href, paymentSealActive).slice(0, 120)}"`
          : null,
        el.topmost === false
          ? `occluded_by="${presentPaymentSafeString(el.occludedBy ?? "unknown", paymentSealActive)}"`
          : null,
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
  // The user's real Chrome profile. Operate opens this directory directly.
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

export interface HarnessStartOptions extends Omit<StartOptions, "profileDir" | "proxyUrl"> {
  browser: BrowserController;
  observationFormat?: "v1" | "compact-v2";
}

// Fail-closed precondition GATE — NOT autonomous recovery. An operate task that
// acts as the user needs a usable Google session before it drives; absent /
// expired / 2FA-challenged → hand back BEFORE the task starts, so the
// human-in-the-loop dependency is explicit, never hidden (Codex). Pairs with the
// install-time gate (install/cli.ts) that already requires a Google session.
export interface NeedsUserLogin {
  wall: "google_session";
  message: string;
  resume: "login";
}
export function googleSessionGate(
  liveProviders: readonly OAuthProviderId[],
): { ok: true } | { ok: false; needs_user: NeedsUserLogin } {
  if (liveProviders.includes("google")) return { ok: true };
  return {
    ok: false,
    needs_user: {
      wall: "google_session",
      message:
        "No live Google session in your Chrome profile, so the operator cannot act " +
        "as you yet. Log in with `npx @trusty-squire/mcp login --provider=google --force-relogin` " +
        "and retry " +
        "— the task has NOT started and nothing was changed.",
      resume: "login",
    },
  };
}

async function ensureProvisionPrimaryProviderSession(
  browser: BrowserController,
): Promise<OAuthProviderId[]> {
  // Chrome materializes the real profile's provider jar after the account
  // surface is opened in this same context. Match the proven live-identity
  // path before reading the markers. The account lookup warms the context; it
  // is not itself the admission signal.
  if (typeof browser.detectGoogleAccountEmail === "function") {
    await browser.detectGoogleAccountEmail().catch(() => null);
  }
  if (typeof browser.detectSessionProviders !== "function") return [];
  return await browser.detectSessionProviders().catch(() => [] as OAuthProviderId[]);
}

export async function startProvisionSession(opts: StartOptions): Promise<Observation> {
  const id = randomUUID();
  const compactV2Mode = configuredCompactV2Mode();
  let browser: BrowserController;
  let liveProviders: OAuthProviderId[];
  let workerEmail: string | null = null;
  const acquired = await acquireWarmBrowser(opts, id);
  browser = acquired.controller;
  try {
    liveProviders = await ensureProvisionPrimaryProviderSession(browser);
    assertProvisionStartAdmitted(acquired.shutdownGeneration);
    const gate = googleSessionGate(liveProviders);
    if (!gate.ok) {
      audit(id, "connect_gate", { ok: false, wall: "google_session" });
      await releaseWarmBrowserPage(browser, false);
      refusedStartSessionIds.add(id);
      return compactV2Mode === "on"
        ? {
            session_id: id,
            format: "compact-v2",
            stage: "auth",
            url: "",
            text: "",
            needs_user: gate.needs_user,
          }
        : { session_id: id, url: "", text: "", elements: [], needs_user: gate.needs_user };
    }
    workerEmail =
      typeof browser.detectGoogleAccountEmail === "function"
        ? await browser.detectGoogleAccountEmail().catch(() => null)
        : null;
  } catch (error) {
    await releaseWarmBrowserPage(browser, false);
    throw error;
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
    compactV2Secret: randomBytes(32),
    compactV2Mode,
    compactV2HintPages: [],
    compactV2Active: false,
    compactV2Refs: new Map(),
    compactV2Index: null,
    compactV2Previous: null,
    actionTrace: [],
    recordedValues: [],
    committedSelectValues: new Map(),
    captureRounds: [],
    usedLocatorFallback: false,
    recipeRejectionReason: null,
    replayState: null,
    activePayment: null,
    paymentFieldSealActive: false,
    pendingThreeDs: null,
    paymentDispatchHandoff: null,
    placeOrderApproval: null,
    placeOrderAttempted: false,
    lastCartCheckout: null,
    cartAdds: new Map(),
    cartAddsByIdempotencyKey: new Map(),
    cartUrls: new Map(),
    lastCartMutation: null,
    closing: false,
    initializing: true,
    lastActivityAt: Date.now(),
    callCount: 0,
    callDrainWaiters: new Set(),
    paymentCallCount: 0,
    paymentCallDrainWaiters: new Set(),
    paymentDispatchClosed: false,
    startedAt: Date.now(),
    watchdog: null,
    terminalTeardownOwner: null,
    hintServed: opts.hint !== undefined,
    startUrl: opts.serviceUrl,
    consentInboxRead: opts.consentInboxRead === true,
    userEmail: workerEmail,
    ...(opts.api !== undefined ? { api: opts.api } : {}),
  };
  sessions.set(id, session);
  startSessionWatchdog(session);
  try {
    if (typeof browser.setHostScopeAllowedHosts === "function") {
      await browser.setHostScopeAllowedHosts(
        () => requestScopeHostStrings(session),
        () => merchantSiblingSeedHosts(session),
      );
    }
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
    // Tell the agent which provider the user actually has a live session for
    // (Google-preferred) — the bot knows from the profile cookies, so the agent
    // doesn't have to guess. Composed with the skill route hint (if any).
    const loginHint = loginSessionGuidance(liveProviders);
    const hintParts = [loginHint, ...(opts.hint !== undefined ? [opts.hint] : [])];
    const observation = await observeSession(
      session,
      "compact",
      compactV2StartMetadata(opts.hint, loginHint, session.userEmail),
    );
    session.initializing = false;
    session.lastActivityAt = Date.now();
    if (observation.format === "compact-v2") return observation;
    return {
      ...observation,
      hint: hintParts.join("\n"),
      ...(session.userEmail !== null ? { user_email: session.userEmail } : {}),
    };
  } catch (err) {
    deregisterProvisionSession(session);
    disposeSessionWatchdog(session);
    await releaseWarmBrowserPage(browser, false);
    throw err;
  }
}

/** Start a normal guarded session on a caller-owned harness page. */
export async function startHarnessProvisionSession(
  opts: HarnessStartOptions,
): Promise<Observation> {
  const id = randomUUID();
  const targetHost = registrableHost(opts.serviceUrl);
  const allowedHosts: AllowedHostEntry[] = [
    ...(targetHost === null ? [] : [targetHost]),
    ...(opts.extraAllowedHosts ?? []),
  ]
    .filter((host, index, hosts) => hosts.indexOf(host) === index)
    .map((host) => ({
      host,
      source: "start" as const,
    }));
  const session: Session = {
    id,
    browser: opts.browser,
    allowedHosts,
    generation: 0,
    secretSlots: new Map(),
    sealedFieldKeys: new Set(),
    lastElements: [],
    prevObserve: null,
    observeSnapshotFile: null,
    compactV2Secret: randomBytes(32),
    compactV2Mode: opts.observationFormat === "compact-v2" ? "on" : "off",
    compactV2HintPages: [],
    compactV2Active: false,
    compactV2Refs: new Map(),
    compactV2Index: null,
    compactV2Previous: null,
    actionTrace: [],
    recordedValues: [],
    committedSelectValues: new Map(),
    captureRounds: [],
    usedLocatorFallback: false,
    recipeRejectionReason: null,
    replayState: null,
    activePayment: null,
    paymentFieldSealActive: false,
    pendingThreeDs: null,
    paymentDispatchHandoff: null,
    placeOrderApproval: null,
    placeOrderAttempted: false,
    lastCartCheckout: null,
    cartAdds: new Map(),
    cartAddsByIdempotencyKey: new Map(),
    cartUrls: new Map(),
    lastCartMutation: null,
    closing: false,
    initializing: true,
    lastActivityAt: Date.now(),
    callCount: 0,
    callDrainWaiters: new Set(),
    paymentCallCount: 0,
    paymentCallDrainWaiters: new Set(),
    paymentDispatchClosed: false,
    startedAt: Date.now(),
    watchdog: null,
    terminalTeardownOwner: null,
    hintServed: opts.hint !== undefined,
    startUrl: opts.serviceUrl,
    consentInboxRead: false,
    userEmail: null,
    ...(opts.api === undefined ? {} : { api: opts.api }),
  };
  sessions.set(id, session);
  startSessionWatchdog(session);
  try {
    audit(id, "start_harness", {
      service_url: opts.serviceUrl,
      allowed_hosts: hostStrings(session),
    });
    await opts.browser.goto(opts.serviceUrl);
    const observation = await observeSession(
      session,
      "compact",
      compactV2StartMetadata(opts.hint, "", null),
    );
    session.initializing = false;
    session.lastActivityAt = Date.now();
    if (observation.format === "compact-v2") return observation;
    return { ...observation, hint: opts.hint ?? "" };
  } catch (error) {
    deregisterProvisionSession(session);
    disposeSessionWatchdog(session);
    await opts.browser.close().catch(() => undefined);
    throw error;
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

export interface ScreenshotCapture {
  session_id: string;
  url: string;
  frame_url: string | null;
  frame_count: number;
  redacted_count: number;
  image: { mime_type: string; data_base64: string };
}

// operate_screenshot's session-level entry point: refuses an active card-fill
// lease, then delegates the capture-scoped sealed-value checks and pixel
// redaction to BrowserController.captureOperatorScreenshot (browser.ts).
export async function captureScreenshot(
  sessionId: string,
  opts: { frameIndex?: number; frameUrlContains?: string; fullPage?: boolean } = {},
): Promise<ScreenshotCapture> {
  const session = sessionForCall(sessionId);
  if (session === undefined) throw new Error(`unknown provision session ${sessionId}`);
  // A live card fill is never safe to inspect, even when the caller selects a
  // child frame. Historical seals are different: sealedFieldKeys is cumulative,
  // so the browser must inspect only the frames this capture would include.
  if (session.paymentFieldSealActive || session.activePayment?.status === "operating") {
    throw new Error("screenshot_unavailable_sealed_context");
  }
  const captured = await session.browser.captureOperatorScreenshot(opts, [
    ...session.sealedFieldKeys,
  ]);
  return {
    session_id: sessionId,
    url: session.browser.currentUrl(),
    frame_url: captured.frameUrl,
    frame_count: captured.frameCount,
    redacted_count: captured.redactedCount,
    image: { mime_type: "image/jpeg", data_base64: captured.base64 },
  };
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

export function isCompactV2ProvisionSession(sessionId: string): boolean {
  return sessionForCall(sessionId)?.compactV2Mode === "on";
}

function activeProvisionSession(): Session {
  return paymentSession();
}

export function activeProvisionBrowser(): BrowserController {
  const session = activeProvisionSession();
  invalidateCompactV2Snapshot(session);
  return session.browser;
}

export async function activeProvisionBrowserForPayment(
  selectedSession?: Session,
): Promise<BrowserController> {
  const session = selectedSession ?? activeProvisionSession();
  invalidateCompactV2Snapshot(session);
  return session.browser;
}

function placeOrderApprovalFromPendingFill(
  pending: PendingCardFill,
): NonNullable<Session["placeOrderApproval"]> {
  return {
    approvalId: pending.approval_id,
    ...(pending.mandate_id !== undefined ? { mandateId: pending.mandate_id } : {}),
    merchant: pending.checkout.merchant,
    amountCents: pending.checkout.amount_cents,
    currency: pending.checkout.currency,
    cardRef: pending.card_ref,
    last4: pending.last4,
  };
}

export function setActivePendingCardFill(
  pending: PendingCardFill,
  selectedSession?: Session,
): void {
  const session = selectedSession ?? activeProvisionSession();
  session.activePayment = { status: "pending", pending };
  session.paymentFieldSealActive = true;
  session.placeOrderApproval = placeOrderApprovalFromPendingFill(pending);
  session.placeOrderAttempted = false;
}

export function retainActivePaymentFieldSeal(selectedSession?: Session): void {
  const session = selectedSession ?? activeProvisionSession();
  if (session.activePayment?.status !== "operating") {
    session.activePayment = { status: "sealed" };
  }
  session.paymentFieldSealActive = true;
}

export function getActivePendingCardFill(selectedSession?: Session): PendingCardFill | null {
  const state = (selectedSession ?? activeProvisionSession()).activePayment;
  return state?.status === "pending" ? state.pending : null;
}

// The outstanding approval a prior bounded operate_pay call left waiting on
// the human, if any. A status read may transition this exact state to terminal
// denial/expiry and scrub its private operator key.
export function getActivePendingApproval(selectedSession?: Session): PendingApprovalWait | null {
  const state = (selectedSession ?? activeProvisionSession()).activePayment;
  return state?.status === "awaiting_approval" ? state.state : null;
}

export function getTerminalPaymentApproval(
  selectedSession?: Session,
): { state: PendingApprovalWait; terminalStatus: TerminalPaymentApprovalStatus } | null {
  const activePayment = (selectedSession ?? activeProvisionSession()).activePayment;
  return activePayment?.status === "terminal_approval"
    ? { state: activePayment.state, terminalStatus: activePayment.terminalStatus }
    : null;
}

export function completeActivePendingApprovalWithTerminalStatus(
  state: PendingApprovalWait,
  terminalStatus: "denied" | "expired",
  selectedSession?: Session,
): boolean {
  const session = selectedSession ?? activeProvisionSession();
  const activePayment = session.activePayment;
  if (activePayment?.status !== "awaiting_approval" || activePayment.state !== state) return false;
  state.keypair.privateKey = "";
  session.activePayment = { status: "terminal_approval", state, terminalStatus };
  return true;
}

export function completeActivePaymentLeaseWithTerminalApproval(
  lease: ActivePaymentLease,
  state: PendingApprovalWait,
  terminalStatus: TerminalPaymentApprovalStatus,
  selectedSession?: Session,
): void {
  const session = selectedSession ?? activeProvisionSession();
  const activePayment = session.activePayment;
  if (activePayment?.status !== "operating" || activePayment.lease !== lease) {
    throw new Error(
      "operate_pay terminal approval completed without ownership of the active payment lease",
    );
  }
  state.keypair.privateKey = "";
  session.activePayment = { status: "terminal_approval", state, terminalStatus };
}

export function getActivePendingThreeDs(selectedSession?: Session): PendingThreeDsWait | null {
  return (selectedSession ?? activeProvisionSession()).pendingThreeDs ?? null;
}

export function armPaymentDispatchHandoff(
  state: PendingThreeDsWait,
  selectedSession?: Session,
): void {
  const session = selectedSession ?? activeProvisionSession();
  if (session.paymentDispatchClosed || (session.closing && session.paymentCallCount === 0)) {
    throw new Error(`provision session ${session.id} closed before payment dispatch`);
  }
  let resolveSettled = (): void => undefined;
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });
  session.paymentDispatchHandoff = {
    state,
    settled,
    resolveSettled,
    terminalizing: false,
    terminalComplete: false,
    released: false,
    auditPromise: null,
  };
}

export function finishPaymentDispatchHandoff(
  state: PendingThreeDsWait,
  selectedSession?: Session,
): void {
  const session = selectedSession ?? activeProvisionSession();
  const handoff = session.paymentDispatchHandoff;
  if (handoff?.state !== state) return;
  handoff.released = true;
  handoff.resolveSettled();
  if (!handoff.terminalizing || handoff.terminalComplete) {
    session.paymentDispatchHandoff = null;
  }
}

export async function coordinatePaymentDispatchAudit(
  state: PendingThreeDsWait,
  recordAudit: () => Promise<void>,
  selectedSession?: Session,
): Promise<void> {
  const session = selectedSession ?? activeProvisionSession();
  const handoff = session.paymentDispatchHandoff;
  if (handoff?.state === state) {
    handoff.auditPromise ??= recordAudit();
    await handoff.auditPromise;
    return;
  }
  await recordAudit();
}

export function setActivePendingThreeDs(
  state: PendingThreeDsWait,
  selectedSession?: Session,
): void {
  const session = selectedSession ?? activeProvisionSession();
  const handoff = session.paymentDispatchHandoff;
  if (session.closing && handoff?.state !== state) return;
  session.pendingThreeDs = state;
  if (handoff?.state === state) handoff.resolveSettled();
}

export function clearActivePendingThreeDsIfCurrent(
  state: PendingThreeDsWait,
  selectedSession?: Session,
): boolean {
  const session = selectedSession ?? activeProvisionSession();
  if (session.pendingThreeDs !== state) return false;
  session.pendingThreeDs = null;
  return true;
}

export interface ActivePaymentLease {
  phase: "fill_card" | "single";
}

export type ActivePaymentClaim =
  | { kind: "lease"; lease: ActivePaymentLease; resumeApproval?: PendingApprovalWait }
  | { kind: "confirm"; pending: PendingCardFill }
  | {
      kind: "terminal";
      state: PendingApprovalWait;
      terminalStatus: TerminalPaymentApprovalStatus;
    }
  | { kind: "missing_confirm" };

export function claimActivePaymentForOperatePay(
  phase: "fill_card" | "confirm" | undefined,
  selectedSession?: Session,
): ActivePaymentClaim {
  const session = selectedSession ?? activeProvisionSession();
  if (getActivePendingThreeDs(session) !== null) {
    throw new Error(
      "operate_pay refused: a prior charge has unresolved 3-D Secure state; call " +
        "operate_payment_status first",
    );
  }
  const state = session.activePayment;
  if (state?.status === "operating") {
    throw new Error("operate_pay refused: another payment operation is already in progress");
  }
  if (state?.status === "confirming") {
    throw new Error("operate_pay refused: another payment confirmation is already in progress");
  }
  if (state?.status === "sealed") {
    throw new Error("operate_pay refused: payment field cleanup remains unverified");
  }
  if (state?.status === "terminal_approval") {
    return {
      kind: "terminal",
      state: state.state,
      terminalStatus: state.terminalStatus,
    };
  }
  if (state?.status === "pending") {
    if (phase !== "confirm") {
      throw new Error(
        'operate_pay refused: a vaulted card fill is pending; phase="confirm" is required next',
      );
    }
    session.activePayment = {
      status: "confirming",
      pending: state.pending,
      submitStarted: false,
    };
    return { kind: "confirm", pending: state.pending };
  }
  if (phase === "confirm") return { kind: "missing_confirm" };
  // [P0] Resuming an outstanding approval (status "awaiting_approval" — the
  // human hasn't tapped approve yet) takes the SAME "operating" lease as a
  // fresh call, carrying the prior approval/keypair through so the operator can
  // validate the resource before either reusing it or minting a replacement.
  const resumeApproval = state?.status === "awaiting_approval" ? state.state : undefined;
  const lease: ActivePaymentLease = { phase: phase === "fill_card" ? "fill_card" : "single" };
  session.activePayment = { status: "operating", lease };
  if (lease.phase === "fill_card") session.paymentFieldSealActive = true;
  return resumeApproval !== undefined
    ? { kind: "lease", lease, resumeApproval }
    : { kind: "lease", lease };
}

export function completeActivePaymentLeaseWithPendingFill(
  lease: ActivePaymentLease,
  pending: PendingCardFill,
  selectedSession?: Session,
): void {
  const session = selectedSession ?? activeProvisionSession();
  const state = session.activePayment;
  if (state?.status !== "operating" || state.lease !== lease || lease.phase !== "fill_card") {
    throw new Error(
      "operate_pay fill_card completed without ownership of the active payment lease",
    );
  }
  session.activePayment = { status: "pending", pending };
  session.paymentFieldSealActive = true;
  session.placeOrderApproval = placeOrderApprovalFromPendingFill(pending);
  session.placeOrderAttempted = false;
}

// [P0] Mirrors completeActivePaymentLeaseWithPendingFill for the
// still-pending-approval outcome: the human hasn't responded yet, so this
// call ends with no card filled — just a resumable wait, picked up by the
// NEXT operate_pay call for live-resource validation or read by
// operate_payment_status.
export function completeActivePaymentLeaseWithPendingApproval(
  lease: ActivePaymentLease,
  state: PendingApprovalWait,
  selectedSession?: Session,
): void {
  const session = selectedSession ?? activeProvisionSession();
  const current = session.activePayment;
  if (current?.status !== "operating" || current.lease !== lease) {
    throw new Error(
      "operate_pay approval_pending completed without ownership of the active payment lease",
    );
  }
  session.activePayment = { status: "awaiting_approval", state };
}

export function releaseActivePaymentLease(
  lease: ActivePaymentLease,
  paymentFieldsCleared = true,
  selectedSession?: Session,
): boolean {
  const session = selectedSession ?? activeProvisionSession();
  const state = session.activePayment;
  if (state?.status !== "operating" || state.lease !== lease) return false;
  session.activePayment = paymentFieldsCleared ? null : { status: "sealed" };
  if (lease.phase === "fill_card") session.paymentFieldSealActive = !paymentFieldsCleared;
  return true;
}

export function markActivePendingCardFillSubmitStarted(selectedSession?: Session): void {
  const state = (selectedSession ?? activeProvisionSession()).activePayment;
  if (state?.status === "confirming") state.submitStarted = true;
}

export function restoreActivePendingCardFillAfterConfirmThrow(
  pending: PendingCardFill,
  selectedSession?: Session,
): boolean {
  const session = selectedSession ?? activeProvisionSession();
  const state = session.activePayment;
  if (state?.status !== "confirming" || state.submitStarted) return false;
  session.activePayment = { status: "pending", pending };
  return true;
}

export function clearActivePendingCardFill(
  paymentFieldsCleared = true,
  selectedSession?: Session,
): void {
  const session = selectedSession ?? activeProvisionSession();
  session.activePayment = paymentFieldsCleared ? null : { status: "sealed" };
  session.paymentFieldSealActive = !paymentFieldsCleared;
  // A verified full clear (paymentFieldsCleared=true) is a clean slate — no
  // approval is pending a place-order attempt anymore. The real confirm call
  // site always passes false (moving to "sealed"), which deliberately leaves
  // placeOrderApproval/placeOrderAttempted untouched: the guard must keep
  // binding to the SAME approval across the pending -> sealed transition.
  if (paymentFieldsCleared) {
    session.placeOrderApproval = null;
    session.placeOrderAttempted = false;
  }
}

export function recordActivePaymentProvenance(cardRef: string, selectedSession?: Session): void {
  const session = selectedSession ?? activeProvisionSession();
  const last = session.actionTrace.at(-1)?.action;
  if (last?.kind === "operate_pay") return;
  const traceIndex = session.actionTrace.length;
  session.actionTrace.push({ action: { kind: "operate_pay", value: { hole: "card" } } });
  session.recordedValues.push({ traceIndex, hole: "card", literal: cardRef });
}

// operate_pay {phase:"fill_card"} fallback source (see Session.lastCartCheckout):
// the most recent real total this SAME session actually read off a page,
// returned only when it still matches the given (current, live) origin.
export function activeCartCheckoutForOrigin(
  origin: string,
  selectedSession?: Session,
): CartCheckoutObservation | null {
  const cached = (selectedSession ?? activeProvisionSession()).lastCartCheckout;
  return cached !== null && cached.checkout.checkout_origin === origin ? cached : null;
}

export interface CartAddResult {
  status: "added" | "already_in_cart";
  cart_delta: "+1" | "0" | "unknown";
  cart_url: string | null;
  checkout_state: CheckoutState;
  postcondition: { product_identity: string; options_hash: string; quantity: number | null };
}

function canonicalCartIdentity(value: string): string {
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    url.hash = "";
    return url.toString();
  } catch {
    return trimmed;
  }
}

function cartLineMatches(
  line: { product_identities: string[]; option_signatures: string[] },
  productIdentity: string,
  optionsHash: string,
): boolean {
  const product = canonicalCartIdentity(productIdentity);
  const options = canonicalCartIdentity(optionsHash);
  return (
    line.product_identities.some((candidate) => canonicalCartIdentity(candidate) === product) &&
    line.option_signatures.some((candidate) => canonicalCartIdentity(candidate) === options)
  );
}

async function cartLineQuantity(
  session: Session,
  productIdentity: string,
  optionsHash: string,
): Promise<number | null> {
  const lines = await session.browser.readCheckoutReviewLineItems(true);
  const matching = lines.filter((line) => cartLineMatches(line, productIdentity, optionsHash));
  if (matching.length !== 1) return null;
  return matching[0]!.quantity;
}

function alreadyInCartResult(result: CartAddResult): CartAddResult {
  return {
    ...result,
    status: "already_in_cart",
    cart_delta: "0",
    checkout_state: { ...result.checkout_state },
  };
}

async function capturePrivateCheckoutState(session: Session): Promise<CheckoutState | undefined> {
  const elements = await session.browser.extractInteractiveElements();
  retainSessionElements(session, elements);
  const url = session.browser.currentUrl();
  const text = redactPaymentObservationText(
    await session.browser.extractVisibleText(),
    elements,
    session.paymentFieldSealActive,
  );
  const liveCheckout = await captureCartCheckoutForFillCardFallback(session, url);
  return checkoutStateForObservation(session, url, text.slice(0, 12_000), elements, liveCheckout);
}

async function reconcileReservedCartAdd(
  session: Session,
  record: CartAddRecord,
): Promise<CartAddResult> {
  if (record.result !== null) return alreadyInCartResult(record.result);
  if (record.promise !== null) {
    try {
      return alreadyInCartResult(await record.promise);
    } catch (error) {
      if (record.phase === "reserved")
        return await cartAdd(
          session.id,
          record.productIdentity,
          record.optionsHash,
          record.idempotencyKey,
        );
      const quantity = await cartLineQuantity(session, record.productIdentity, record.optionsHash);
      if (quantity === null) throw error;
      session.lastCartMutation = {
        productIdentity: record.productIdentity,
        optionsHash: record.optionsHash,
        cartDelta: "0",
        origin: originForUrl(session.browser.currentUrl()) ?? "",
      };
      const checkoutState = await capturePrivateCheckoutState(session);
      if (checkoutState === undefined) throw error;
      const result: CartAddResult = {
        status: "already_in_cart",
        cart_delta: "0",
        cart_url: checkoutState.cart_url,
        checkout_state: { ...checkoutState, quantity },
        postcondition: {
          product_identity: record.productIdentity,
          options_hash: record.optionsHash,
          quantity,
        },
      };
      record.phase = "complete";
      record.result = result;
      return result;
    }
  }
  throw new Error("cart add reservation has no operation");
}

async function performCartAdd(session: Session, record: CartAddRecord): Promise<CartAddResult> {
  const beforeQuantity = await cartLineQuantity(
    session,
    record.productIdentity,
    record.optionsHash,
  );
  if (beforeQuantity !== null && beforeQuantity > 0) {
    session.lastCartMutation = {
      productIdentity: record.productIdentity,
      optionsHash: record.optionsHash,
      cartDelta: "0",
      origin: originForUrl(session.browser.currentUrl()) ?? "",
    };
    const checkoutState = await capturePrivateCheckoutState(session);
    if (checkoutState === undefined) throw new Error("cart state was not observable");
    return {
      status: "already_in_cart",
      cart_delta: "0",
      cart_url: checkoutState.cart_url,
      checkout_state: { ...checkoutState, quantity: beforeQuantity },
      postcondition: {
        product_identity: record.productIdentity,
        options_hash: record.optionsHash,
        quantity: beforeQuantity,
      },
    };
  }

  const addTargets = [
    'text="Add to Cart"',
    'text="Add to Bag"',
    'text="かごに追加"',
    'text="カートに追加"',
  ];
  let addError: unknown;
  let actionResult: InternalActResult | null = null;
  for (const target of addTargets) {
    try {
      actionResult = await actInternally(
        session.id,
        { kind: "click", target },
        "compact",
        {
          productIdentity: record.productIdentity,
          optionsHash: record.optionsHash,
          onActionReady: () => {
            record.phase = "click_started";
          },
        },
        true,
      );
      addError = undefined;
      break;
    } catch (error) {
      addError = error;
      if (!(error instanceof ProvisionTargetMissingError)) {
        throw error;
      }
    }
  }
  if (addError !== undefined || actionResult === null) throw addError;
  const afterQuantity = await cartLineQuantity(session, record.productIdentity, record.optionsHash);
  if (afterQuantity === null || afterQuantity <= 0) {
    throw new Error("requested product/variant line was not observable after add");
  }
  const checkoutState = actionResult.outcome.checkoutState;
  if (checkoutState === undefined) throw new Error("cart state was not observable after add");
  const cartDelta =
    beforeQuantity === null
      ? afterQuantity === 1
        ? "+1"
        : "unknown"
      : afterQuantity === beforeQuantity + 1
        ? "+1"
        : "unknown";
  session.lastCartMutation = {
    productIdentity: record.productIdentity,
    optionsHash: record.optionsHash,
    cartDelta,
    origin: originForUrl(session.browser.currentUrl()) ?? "",
  };
  return {
    status: "added",
    cart_delta: cartDelta,
    cart_url: checkoutState.cart_url,
    checkout_state: { ...checkoutState, quantity: afterQuantity },
    postcondition: {
      product_identity: record.productIdentity,
      options_hash: record.optionsHash,
      quantity: afterQuantity,
    },
  };
}

export async function cartAdd(
  sessionId: string,
  productIdentity: string,
  optionsHash: string,
  idempotencyKey: string,
): Promise<CartAddResult> {
  const session = sessionForCall(sessionId);
  if (session === undefined) throw new Error(`unknown provision session ${sessionId}`);
  const lineKey = `${productIdentity}\u0000${optionsHash}`;
  const byIdempotencyKey = session.cartAddsByIdempotencyKey.get(idempotencyKey);
  if (
    byIdempotencyKey !== undefined &&
    (byIdempotencyKey.productIdentity !== productIdentity ||
      byIdempotencyKey.optionsHash !== optionsHash)
  ) {
    throw new Error("idempotency_key is already bound to a different product/variant");
  }
  const existing = byIdempotencyKey ?? session.cartAdds.get(lineKey);
  if (existing !== undefined) {
    session.cartAddsByIdempotencyKey.set(idempotencyKey, existing);
    return await reconcileReservedCartAdd(session, existing);
  }

  const record: CartAddRecord = {
    productIdentity,
    optionsHash,
    idempotencyKey,
    phase: "reserved",
    promise: null,
    result: null,
  };
  session.cartAdds.set(lineKey, record);
  session.cartAddsByIdempotencyKey.set(idempotencyKey, record);
  record.promise = performCartAdd(session, record)
    .then((result) => {
      record.phase = "complete";
      record.result = result;
      return result;
    })
    .catch((error: unknown) => {
      if (record.phase === "reserved") {
        session.cartAdds.delete(lineKey);
        session.cartAddsByIdempotencyKey.delete(idempotencyKey);
      }
      throw error;
    });
  return await record.promise;
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

// Keep this detection narrow and structural. It only annotates fields that are
// recognizably part of collecting card data; address fields remain normal
// checkout fields. The affordance is advisory metadata, never a relaxation of
// the frame or PAN guards below.
export function paymentFieldForObservation(el: InteractiveElement): PaymentField | null {
  const autocomplete = (el.autocomplete ?? "").toLowerCase().split(/\s+/);
  const signal = [el.name, el.id, el.ariaLabel, el.labelText, el.placeholder]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  if (autocomplete.includes("cc-number") || /card[\s_-]*number|cardnumber|\bpan\b/.test(signal)) {
    return "card_number";
  }
  if (autocomplete.includes("cc-csc") || /\b(?:cvv|cvc)\b|security[\s_-]*code/.test(signal)) {
    return "security_code";
  }
  if (autocomplete.includes("cc-exp-month") || /exp(?:iry|iration)?[\s_-]*month/.test(signal)) {
    return "expiry_month";
  }
  if (autocomplete.includes("cc-exp-year") || /exp(?:iry|iration)?[\s_-]*year/.test(signal)) {
    return "expiry_year";
  }
  if (
    autocomplete.includes("cc-exp") ||
    /\bmm\s*\/\s*yy\b|exp(?:iry|iration)?[\s_-]*(?:date)?\b/.test(signal)
  ) {
    return "expiry";
  }
  if (autocomplete.includes("cc-name") || /cardholder|card[\s_-]*name/.test(signal)) {
    return "cardholder_name";
  }
  return null;
}

function annotatePaymentControl(out: ObservedElement, el: InteractiveElement): void {
  const paymentField = paymentFieldForObservation(el);
  if (paymentField === null) return;
  out.payment_field = paymentField;
  out.interaction = "vaulted_card_only";
  out.recommended_action = { tool: "operate_pay", phase: "fill_card" };
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
  paymentSealActive = false,
): ObservedElement {
  const out: ObservedElement = {
    ref,
    label: presentLabel(el, sealed, paymentSealActive),
    tag: presentPaymentSafeString(el.tag, paymentSealActive),
  };
  if (el.role) out.role = presentPaymentSafeString(el.role, paymentSealActive);
  if (el.type && !(elide && shouldElideType(el))) {
    out.type = presentPaymentSafeString(el.type, paymentSealActive);
  }
  // value_len is a LENGTH signal, not the value — report the REAL character count.
  // presentFieldValue masks a sealed field to "[sealed]" (8 chars), so using its
  // length made a correctly-filled 19-char email read as value_len:8 and misled
  // the agent into thinking its fill truncated. The length isn't the secret (the
  // min_value_len postcondition already uses the real length for the same reason).
  const realLen = (el.value ?? "").length;
  if (realLen > 0) out.value_len = realLen;
  if (el.checked !== null && el.checked !== undefined) out.checked = el.checked;
  if (el.href) out.href = presentPaymentSafeString(el.href, paymentSealActive);
  if (el.testId) out.testId = presentPaymentSafeString(el.testId, paymentSealActive);
  if (includePath && el.screenPath) {
    out.path = presentPaymentSafeString(el.screenPath, paymentSealActive);
  }
  if (el.topmost === false) out.topmost = false;
  if (el.occludedBy) {
    out.occluded_by = presentPaymentSafeString(el.occludedBy, paymentSealActive);
  }
  if (el.frameOrigin) {
    out.frame_origin = presentPaymentSafeString(el.frameOrigin, paymentSealActive);
  }
  annotatePaymentControl(out, el);
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
  "frame_origin",
  "payment_field",
  "interaction",
  "recommended_action",
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
    case "frame_origin":
      return e.frame_origin ?? undefined;
    case "payment_field":
      return e.payment_field;
    case "interaction":
      return e.interaction;
    case "recommended_action":
      return e.recommended_action === undefined ? undefined : JSON.stringify(e.recommended_action);
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
      else if (col === "frame_origin") e.frame_origin = raw;
      else if (
        col === "payment_field" &&
        [
          "card_number",
          "expiry",
          "expiry_month",
          "expiry_year",
          "security_code",
          "cardholder_name",
        ].includes(raw)
      )
        e.payment_field = raw as PaymentField;
      else if (col === "interaction" && raw === "vaulted_card_only") e.interaction = raw;
      else if (col === "recommended_action") {
        try {
          const action = JSON.parse(raw) as { tool?: string; phase?: string };
          if (action.tool === "operate_pay" && action.phase === "fill_card") {
            e.recommended_action = { tool: "operate_pay", phase: "fill_card" };
          }
        } catch {
          // A malformed optional advisory column is ignored, never allowed to
          // break reconstruction of the actual actionable inventory.
        }
      }
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
  paymentSealActive?: boolean;
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
  const paymentSealActive = args.paymentSealActive ?? false;
  const refs = provisionElementRefs(elements);
  const refOf = (el: InteractiveElement): string => refs.get(el) ?? provisionElementRef(el);

  const fullByRef = new Map<string, ObservedElement>();
  const serializedByRef = new Map<string, string>();
  const fileElements: ObservedElement[] = [];
  for (const el of elements) {
    const ref = refOf(el);
    fullByRef.set(ref, toCompactElement(el, ref, sealed, false, elide, paymentSealActive));
    serializedByRef.set(ref, JSON.stringify(fullByRef.get(ref)));
    // The persisted file keeps FULL fidelity (path included, no elision) so a
    // re-expansion after a host compaction loses nothing.
    fileElements.push(toCompactElement(el, ref, sealed, true, false, paymentSealActive));
  }
  const nextState: ObserveDeltaState = { url, byRef: serializedByRef, text };

  // A dialog/modal region with at least one topmost (unoccluded) element is
  // "active" — the host planner should treat it as the current interaction
  // surface rather than the page behind it. Uses each element's dedicated
  // dialog-membership flag, independent of container grouping, and the FULL
  // element set so it stays accurate on every emit, delta or full.
  const modalActive = elements.some((el) => el.inDialog === true && el.topmost !== false);

  const base: Observation = {
    session_id: sessionId,
    url,
    text,
    ...(args.guidance !== undefined ? { guidance: args.guidance } : {}),
    elements_total: elements.length,
    ...(args.textTruncated === true ? { text_truncated: true } : {}),
    ...(modalActive ? { modal_active: true } : {}),
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

// Best-effort: on every observation, try to read a real checkout total off
// the CURRENT live page and cache it as the fill_card fallback (see
// Session.lastCartCheckout). Most pages have no parseable total — that's the
// overwhelmingly common, expected outcome, not an error, so a throw here
// simply leaves the existing cache untouched rather than clearing it. Scoped
// to the observed page's own origin so a later cross-origin fallback read
// (checked again at use time) can never happen even if this cache were stale.
async function captureCartCheckoutForFillCardFallback(
  session: Session,
  url: string,
): Promise<CheckoutSummary | null> {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return null;
  }
  try {
    const checkout = await session.browser.readCheckoutSummary();
    if (checkout.checkout_origin === origin) {
      session.lastCartCheckout = { checkout, url, observedAt: Date.now() };
      return checkout;
    }
  } catch {
    // No readable total on this page — leave any previously cached total alone.
  }
  return null;
}

function checkoutStageFromUrl(url: string): CheckoutState["stage"] | null {
  return checkoutStageFromUrlV2(url);
}

function checkoutStage(
  url: string,
  elements: readonly InteractiveElement[],
): CheckoutState["stage"] | null {
  const routeStage = checkoutStageFromUrl(url);
  if (routeStage !== null) return routeStage;
  if (elements.some((element) => paymentFieldForObservation(element) !== null)) return "checkout";
  const contexts = elements
    .flatMap((element) => [element.container, element.screenPath])
    .filter((value): value is string => typeof value === "string");
  if (
    contexts.some((context) =>
      /(?:^|[ >:/_-])(?:checkout|payment|order[-_ ]?review|お支払い|注文確認)(?:$|[ >:/_-])/i.test(
        context,
      ),
    )
  ) {
    return "checkout";
  }
  if (
    contexts.some((context) =>
      /(?:^|[ >:/_-])(?:cart|basket|bag|カート|かご)(?:$|[ >:/_-])/i.test(context),
    )
  ) {
    return "cart";
  }
  return null;
}

function observedCartQuantity(
  elements: readonly InteractiveElement[],
  text: string,
): number | null {
  for (const el of elements) {
    const label = `${el.name ?? ""} ${el.id ?? ""} ${el.ariaLabel ?? ""} ${el.labelText ?? ""}`;
    if (!/\b(?:quantity|qty)\b|(?:数量|個数)/i.test(label)) continue;
    const value = el.value?.trim() ?? "";
    if (/^\d+$/.test(value)) return Number(value);
  }
  const match = text.match(/(?:quantity|qty|数量|個数)\s*[:：x×]?\s*(\d+)/i);
  return match?.[1] === undefined ? null : Number(match[1]);
}

const checkoutComponentBoundary = String.raw`(?:subtotal|merchandise\s+subtotal|shipping|delivery|tax|grand\s+total|order\s+total|total\s+due|amount\s+due|total|商品合計|小計|送料|配送料|税|合計)`;

function labeledCheckoutMoney(
  text: string,
  label: string,
  fallbackCurrency?: string,
): CheckoutMoney | null {
  const match = text.match(
    new RegExp(
      `(?:${label})\\s*[:：]?\\s*([\\s\\S]*?)(?=${checkoutComponentBoundary}\\s*[:：]?|$)`,
      "iu",
    ),
  );
  const value = match?.[1]?.trim();
  if (value === undefined || value.length === 0) return null;
  const parsed = parseCheckoutAmount([`Total ${value}`], fallbackCurrency);
  return parsed !== null && fallbackCurrency !== undefined && parsed.currency !== fallbackCurrency
    ? null
    : parsed;
}

function shippingMoney(text: string, fallbackCurrency?: string): CheckoutMoney | null {
  const pattern = new RegExp(
    `(?:shipping|delivery|送料|配送料)\\s*[:：]?\\s*([\\s\\S]*?)(?=${checkoutComponentBoundary}\\s*[:：]?|$)`,
    "giu",
  );
  const candidates: CheckoutMoney[] = [];
  for (const match of text.matchAll(pattern)) {
    const value = match[1]?.trim();
    if (value === undefined || value.length === 0) continue;
    if (
      /\b(?:on|for)\s+(?:all\s+)?orders?\b|\borders?\s+(?:over|above|of)\b|\b(?:minimum|qualifying)\s+(?:order|spend|purchase)\b/iu.test(
        value,
      )
    ) {
      continue;
    }
    if (/^(?:free|complimentary|0|無料)(?:\s|$)/iu.test(value)) {
      if (fallbackCurrency !== undefined) {
        candidates.push({ amount_cents: 0, currency: fallbackCurrency });
      }
      continue;
    }
    if (!/^(?:(?:[A-Z]{3}\p{Sc}?|\p{Sc})\s*)?\d/iu.test(value)) continue;
    const parsed = parseCheckoutAmount([`Total ${value}`], fallbackCurrency);
    if (parsed === null) continue;
    if (fallbackCurrency !== undefined && parsed.currency !== fallbackCurrency) continue;
    candidates.push(parsed);
  }
  return candidates.at(-1) ?? null;
}

function originForUrl(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function cartMutationForUrl(session: Session, url: string): CartMutation | null {
  const origin = originForUrl(url);
  return origin !== null && session.lastCartMutation?.origin === origin
    ? session.lastCartMutation
    : null;
}

function cartUrlForState(
  session: Session,
  url: string,
  elements: readonly InteractiveElement[],
): string | null {
  const origin = originForUrl(url);
  if (origin === null) return null;
  if (checkoutStageFromUrl(url) === "cart") {
    session.cartUrls.set(origin, url);
    return url;
  }
  const cartLink = elements.find((el) => {
    const label = `${el.visibleText ?? ""} ${el.ariaLabel ?? ""} ${el.labelText ?? ""}`;
    return (
      el.href !== null &&
      el.href !== undefined &&
      /\b(?:cart|basket|bag)\b|(?:かご|カート)/i.test(label)
    );
  });
  if (cartLink?.href !== undefined && cartLink.href !== null) {
    try {
      const resolved = new URL(cartLink.href, url);
      if (resolved.origin === origin && checkoutStage(resolved.toString(), []) === "cart") {
        session.cartUrls.set(origin, resolved.toString());
        return resolved.toString();
      }
    } catch {
      // A malformed href is not a canonical cart URL; fall through to the
      // previously observed cart page rather than fabricating one.
    }
  }
  return session.cartUrls.get(origin) ?? null;
}

function checkoutStateForObservation(
  session: Session,
  url: string,
  text: string,
  elements: readonly InteractiveElement[],
  liveCheckout: CheckoutSummary | null,
): CheckoutState | undefined {
  const stage = checkoutStage(url, elements);
  const mutation = cartMutationForUrl(session, url);
  const origin = originForUrl(url);
  const checkout =
    origin !== null && liveCheckout?.checkout_origin === origin ? liveCheckout : undefined;
  // Do not burden unrelated provision flows with an empty cart-shaped object.
  if (stage === null && mutation === null) return undefined;
  const payableTotal =
    checkout === undefined
      ? null
      : { amount_cents: checkout.amount_cents, currency: checkout.currency };
  const fallbackCurrency = checkout?.currency;
  const resolvedStage = stage ?? "product";
  return {
    authority: "informational_only",
    completeness: "best_effort",
    authoritative_for_payment: false,
    stage: resolvedStage,
    product_identity: mutation?.productIdentity ?? null,
    options_hash: mutation?.optionsHash ?? null,
    quantity: observedCartQuantity(elements, text),
    subtotal: labeledCheckoutMoney(
      text,
      String.raw`subtotal|merchandise\s+subtotal|商品合計|小計`,
      fallbackCurrency,
    ),
    shipping: shippingMoney(text, fallbackCurrency),
    payable_total: payableTotal,
    cart_url: cartUrlForState(session, url, elements),
    next_action:
      resolvedStage === "checkout"
        ? { tool: "operate_pay", phase: "fill_card" }
        : resolvedStage === "cart"
          ? { tool: "operate_act", kind: "click", intent: "proceed_to_checkout" }
          : { tool: "operate_observe" },
  };
}

function withCheckoutState(
  observation: Observation,
  state: CheckoutState | undefined,
  mutation: CartMutation | null,
): Observation {
  return {
    ...observation,
    ...(state === undefined ? {} : { checkout_state: state }),
    ...(mutation === null ? {} : { cart_delta: mutation.cartDelta }),
  };
}

function isCartAffectingAction(
  action: ProvisionAction,
  el: InteractiveElement | null,
  extraLabels: readonly string[] = [],
): boolean {
  const parts = [
    "target" in action ? action.target : "",
    el?.visibleText ?? "",
    el?.ariaLabel ?? "",
    el?.labelText ?? "",
    el?.name ?? "",
    el?.id ?? "",
    el?.container ?? "",
    el?.screenPath ?? "",
    ...extraLabels,
  ];
  const target = parts.join(" ");
  if (action.kind === "click" || action.kind === "js_click") {
    if (
      /(?:add\s+to\s+(?:cart|bag|basket)|remove\s+from\s+(?:cart|bag|basket)|update\s+(?:cart|bag|basket)|increase\s+quantity|decrease\s+quantity|かごに追加|カートに追加|カートから削除|数量を増やす|数量を減らす)/i.test(
        target,
      )
    ) {
      return true;
    }
    const hasQuantityContext =
      /(?:\b(?:quantity|qty|cart|basket|bag)\b|数量|個数|カート|かご)/i.test(target);
    if (hasQuantityContext && parts.some((part) => /^\s*(?:\+|[-−])\s*$/.test(part))) {
      return true;
    }
    const rowContext = `${el?.container ?? ""} ${el?.screenPath ?? ""}`;
    const actionLabels = [
      "target" in action ? action.target : "",
      el?.visibleText ?? "",
      el?.ariaLabel ?? "",
      el?.labelText ?? "",
      el?.name ?? "",
      el?.id ?? "",
      ...extraLabels,
    ];
    return (
      /(?:\b(?:cart|basket|bag)(?:\s+item|\s+line)?\b|カート|かご)/i.test(rowContext) &&
      actionLabels.some((label) => /^\s*(?:(?:remove|delete|update)\b|削除|更新)/i.test(label))
    );
  }
  return (
    (action.kind === "type" || action.kind === "select") &&
    /(?:\b(?:quantity|qty)\b|数量|個数)/i.test(target)
  );
}

function configuredCompactV2Mode(): "off" | "shadow" | "on" {
  const configured = (process.env.TRUSTY_SQUIRE_OBSERVE_V2 ?? "on").toLowerCase();
  if (configured === "off" || configured === "0") return "off";
  return configured === "shadow" ? "shadow" : "on";
}

function retainSessionElements(session: Session, elements: InteractiveElement[]): void {
  session.lastElements =
    session.compactV2Mode === "on"
      ? sealRetainedInteractiveElementsV2(elements, (element) =>
          compactV2CorrelationSelector(session, element),
        )
      : elements;
}

function compactV2CommittedSelectKey(session: Session, selector: string): string {
  if (session.compactV2Mode !== "on") return selector;
  return createHmac("sha256", session.compactV2Secret)
    .update(`select-key\0${selector}`)
    .digest("base64url");
}

function compactV2CommittedSelectValue(session: Session, value: string): string {
  if (session.compactV2Mode !== "on") return value;
  return createHmac("sha256", session.compactV2Secret)
    .update(`select-value\0${value}`)
    .digest("base64url");
}

function clearCommittedSelectValue(session: Session, selector: string): void {
  session.committedSelectValues.delete(compactV2CommittedSelectKey(session, selector));
}

function compactV2CorrelationSelector(session: Session, element: InteractiveElement): string {
  const binding = JSON.stringify([
    element.frameOrigin ?? null,
    element.framePath ?? null,
    element.selector,
  ]);
  return `@c:${createHmac("sha256", session.compactV2Secret)
    .update(binding)
    .digest("base64url")
    .slice(0, 22)}`;
}

function replaySafeElementForSession(
  session: Session,
  element: InteractiveElement | null,
): InteractiveElement | null {
  if (element === null || session.compactV2Mode !== "on") return element;
  if (element.frameOrigin !== null && element.frameOrigin !== undefined) {
    if (safeOriginV2(element.frameOrigin) === null) {
      rejectRecipeRecording(session, "compact_v2_unrepresentable_frame_origin");
      return null;
    }
  }
  return (
    sealRetainedInteractiveElementsV2([element], (candidate) =>
      compactV2CorrelationSelector(session, candidate),
    )[0] ?? null
  );
}

interface CompactV2StartMetadata {
  hintPages?: string[];
  userEmail?: string;
}

function splitUtf8Pages(value: string, maxBytes: number): string[] {
  if (value.length === 0) return [];
  const pages: string[] = [];
  let page = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes && page.length > 0) {
      pages.push(page);
      page = "";
      bytes = 0;
    }
    page += character;
    bytes += characterBytes;
  }
  if (page.length > 0) pages.push(page);
  return pages;
}

function compactV2StartMetadata(
  registryHint: string | undefined,
  loginHint: string,
  userEmail: string | null,
): CompactV2StartMetadata {
  const hint = [loginHint, registryHint]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join("\n");
  const validEmail =
    userEmail !== null &&
    Buffer.byteLength(userEmail, "utf8") <= 254 &&
    /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(userEmail)
      ? userEmail
      : undefined;
  return {
    ...(hint.length === 0 ? {} : { hintPages: splitUtf8Pages(hint, 384) }),
    ...(validEmail === undefined ? {} : { userEmail: validEmail }),
  };
}

function compactV2QueryCursorScope(
  session: Session,
  query: string,
  role: SafeControlV2["role"] | undefined,
): string {
  return createHmac("sha256", session.compactV2Secret)
    .update(JSON.stringify([query, role ?? null]))
    .digest("base64url")
    .slice(0, 10);
}

function compactV2HintCursorScope(session: Session): string {
  return createHmac("sha256", session.compactV2Secret)
    .update("start-metadata")
    .digest("base64url")
    .slice(0, 10);
}

function compactV2Cursor(
  session: Session,
  generation: number,
  offset: number,
  scope: string,
): string {
  // The session-held index owns the five-minute expiry, so the cursor need not
  // repeat a UUID/timestamp on every dense-page observation. A session-secret
  // HMAC makes this compact in-MCP token unforgeable across sessions.
  const body = `${generation.toString(36)}:${offset.toString(36)}:${scope}`;
  const signature = createHmac("sha256", session.compactV2Secret)
    .update(body)
    .digest("base64url")
    .slice(0, 12);
  return `${body}.${signature}`;
}

// Deltas are valid only for the same document location. The URL itself stays
// on the private side of V2; the session keeps this HMAC solely to decide
// whether a subsequent observe may reuse the preceding safe action map.
function compactV2PageKey(session: Session): string {
  return createHmac("sha256", session.compactV2Secret)
    .update(`${session.browser.mainDocumentIdentity()}\u0000${session.browser.currentUrl()}`)
    .digest("base64url");
}

function parseCompactV2Cursor(
  session: Session,
  cursor: string,
  expectedScope: string,
): { generation: number; offset: number } {
  const [body, signature, extra] = cursor.split(".");
  if (body === undefined || signature === undefined || extra !== undefined)
    throw new Error("invalid_cursor");
  const expected = createHmac("sha256", session.compactV2Secret)
    .update(body)
    .digest("base64url")
    .slice(0, 12);
  if (signature !== expected) throw new Error("invalid_cursor");
  const [generationRaw, offsetRaw, scope, extraPart] = body.split(":");
  if (
    generationRaw === undefined ||
    offsetRaw === undefined ||
    scope === undefined ||
    extraPart !== undefined ||
    scope !== expectedScope
  ) {
    throw new Error("invalid_cursor");
  }
  const generation = Number.parseInt(generationRaw, 36);
  const offset = Number.parseInt(offsetRaw, 36);
  if (
    !Number.isSafeInteger(generation) ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    generation.toString(36) !== generationRaw ||
    offset.toString(36) !== offsetRaw
  ) {
    throw new Error("stale_cursor");
  }
  return { generation, offset };
}

function compactV2HintPage(
  session: Session,
  index: SafeObservationIndexV2,
  offset: number,
): Record<string, unknown> {
  const hint = session.compactV2HintPages[offset];
  if (hint === undefined) throw new Error("invalid_cursor");
  const nextOffset = offset + 1;
  const remaining = session.compactV2HintPages.length - nextOffset;
  const payload = {
    format: "compact-v2",
    url: "",
    text: "",
    session_id: session.id,
    stage: index.stage,
    hint,
    ...(remaining > 0
      ? {
          hint_overflow: {
            remaining,
            next_cursor: compactV2Cursor(
              session,
              index.generation,
              nextOffset,
              compactV2HintCursorScope(session),
            ),
          },
        }
      : {}),
  };
  if (!compactV2PayloadWithinBudget(payload)) {
    throw new Error("compact-v2 budget metadata exceeded");
  }
  return payload;
}

function compactV2PublicObservation(
  session: Session,
  legacy: () => Observation,
  fields: {
    stage: SafeStageV2;
    guidance?: string;
    oauth?: Observation["oauth"];
    observed?: ObserveDetail;
  },
): Observation {
  if (session.compactV2Mode !== "on") return legacy();
  session.compactV2Active = true;
  const payload: Observation = {
    format: "compact-v2",
    session_id: session.id,
    // Keep the path/query private, but expose the screened origin so a
    // successful navigation is distinguishable from an empty/about:blank view.
    url: safeOriginV2(session.browser.currentUrl()) ?? "",
    text: "",
    stage: fields.stage,
    ...(fields.guidance === undefined ? {} : { guidance: fields.guidance }),
    ...(fields.oauth === undefined ? {} : { oauth: fields.oauth }),
    ...(fields.observed === undefined ? {} : { observed: fields.observed }),
  };
  if (!compactV2PayloadWithinBudget(payload)) {
    throw new Error("compact-v2 budget metadata exceeded");
  }
  return payload;
}

function compactV2Observation(
  session: Session,
  generation: number,
  elements: readonly InteractiveElement[],
  semanticSource: ObservationSemanticSourceV2,
  startMetadata?: CompactV2StartMetadata,
): Observation {
  if (startMetadata?.hintPages !== undefined) {
    session.compactV2HintPages = [...startMetadata.hintPages];
  }
  const legacyRefs = provisionElementRefs(elements);
  let pageOrigin = "";
  try {
    pageOrigin = new URL(session.browser.currentUrl()).origin;
  } catch {}
  const stage = safeStageV2(session.browser.currentUrl(), elements);
  const semantics = safePageSemanticsV2(semanticSource);
  const pageKey = compactV2PageKey(session);
  const previous = session.compactV2Previous;
  const samePage = previous !== null && previous.pageKey === pageKey;
  let snapshotGeneration = samePage ? previous.snapshotGeneration : generation;
  let safe = buildSafeControlsV2({
    elements,
    legacyRefs,
    generation: snapshotGeneration,
    pageOrigin,
    pageUrl: session.browser.currentUrl(),
  });
  let delta = samePage ? diffSafeControlsV2(previous, stage, safe.rows) : null;
  const privateBindingsChanged =
    samePage &&
    (session.compactV2Refs.size !== safe.byRef.size ||
      [...safe.byRef].some(([ref, legacy]) => session.compactV2Refs.get(ref) !== legacy));
  // An index belongs to exactly one action-map snapshot. If structural state
  // changed, publish a complete fresh map with a new generation rather than
  // letting a prior short index drift onto a new control.
  const requiresResync =
    !samePage ||
    delta === null ||
    delta.stageChanged ||
    privateBindingsChanged ||
    delta.added.length > 0 ||
    delta.changed.length > 0 ||
    delta.removed.length > 0;
  if (requiresResync && snapshotGeneration !== generation) {
    snapshotGeneration = generation;
    safe = buildSafeControlsV2({
      elements,
      legacyRefs,
      generation: snapshotGeneration,
      pageOrigin,
      pageUrl: session.browser.currentUrl(),
    });
    delta = null;
  }
  const index: SafeObservationIndexV2 = {
    generation: snapshotGeneration,
    pageKey,
    stage,
    semantics,
    rows: safe.rows,
    byRef: safe.byRef,
    expiresAt: Date.now() + 5 * 60_000,
  };
  // Raw DOM values fall out of scope here.
  // Only this enum-only index survives to delta/query/action resolution.
  session.compactV2Active = true;
  session.compactV2Index = index;
  session.compactV2Refs = safe.byRef;
  session.compactV2Previous = {
    pageKey,
    snapshotGeneration,
    stage,
    semantics,
    byRef: new Map(safe.rows.map((row) => [row.ref, row])),
  };
  session.prevObserve = null;
  if (previous !== null && !requiresResync && delta !== null) {
    const encodedDelta = encodeV2Delta({
      sessionId: session.id,
      stage,
      pageUrl: session.browser.currentUrl(),
      // The first V2 page establishes semantic essentials. On a delta they
      // are sticky, so resend only a sealed semantic change rather than the
      // same title/heading on every harmless re-observe.
      semantics: equalSafePageSemanticsV2(previous.semantics, semantics) ? undefined : semantics,
      delta,
    });
    // A high-churn delta is less useful than a fresh paged map.  This also
    // guarantees any overflow remains in the MCP cursor protocol.
    if (encodedDelta !== null) return encodedDelta as unknown as Observation;
  }
  const page = encodeV2Page({
    sessionId: session.id,
    stage: index.stage,
    pageUrl: session.browser.currentUrl(),
    semantics,
    rows: index.rows,
    cursorFor: (offset) =>
      compactV2Cursor(
        session,
        snapshotGeneration,
        offset,
        compactV2QueryCursorScope(session, "", undefined),
      ),
    ...(startMetadata === undefined
      ? {}
      : {
          startMetadata: {
            ...(session.compactV2HintPages[0] === undefined
              ? {}
              : { hint: session.compactV2HintPages[0] }),
            ...(startMetadata.userEmail === undefined
              ? {}
              : { userEmail: startMetadata.userEmail }),
            ...(session.compactV2HintPages.length <= 1
              ? {}
              : {
                  hintOverflow: {
                    remaining: session.compactV2HintPages.length - 1,
                    next_cursor: compactV2Cursor(
                      session,
                      snapshotGeneration,
                      1,
                      compactV2HintCursorScope(session),
                    ),
                  },
                }),
          },
        }),
  });
  return page.payload as unknown as Observation;
}

function exerciseCompactV2Shadow(
  session: Session,
  generation: number,
  elements: readonly InteractiveElement[],
  semanticSource: ObservationSemanticSourceV2,
): void {
  const saved = {
    compactV2Active: session.compactV2Active,
    compactV2Index: session.compactV2Index,
    compactV2Refs: session.compactV2Refs,
    compactV2Previous: session.compactV2Previous,
    prevObserve: session.prevObserve,
  };
  try {
    compactV2Observation(session, generation, elements, semanticSource);
  } catch {
  } finally {
    session.compactV2Active = saved.compactV2Active;
    session.compactV2Index = saved.compactV2Index;
    session.compactV2Refs = saved.compactV2Refs;
    session.compactV2Previous = saved.compactV2Previous;
    session.prevObserve = saved.prevObserve;
  }
}

export async function observeQuery(
  sessionId: string,
  query: string,
  role?: SafeControlV2["role"],
  cursor?: string,
): Promise<Record<string, unknown>> {
  const session = sessionForCall(sessionId);
  if (session === undefined) throw new Error(`unknown provision session ${sessionId}`);
  const index = session.compactV2Index;
  if (index === null || index.expiresAt < Date.now()) throw new Error("stale_cursor");
  // Query/paging is part of the same sealed action-map protocol: never return
  // rows from a page whose private binding no longer matches the live page.
  if (index.pageKey !== compactV2PageKey(session)) {
    invalidateCompactV2Snapshot(session);
    throw new Error("stale_cursor");
  }
  const needle = norm(query);
  const cursorScope = compactV2QueryCursorScope(session, needle, role);
  let offset = 0;
  if (cursor !== undefined) {
    if (needle.length === 0 && role === undefined && session.compactV2HintPages.length > 0) {
      try {
        const parsed = parseCompactV2Cursor(session, cursor, compactV2HintCursorScope(session));
        if (parsed.generation !== index.generation) throw new Error("stale_cursor");
        return compactV2HintPage(session, index, parsed.offset);
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "invalid_cursor") throw error;
      }
    }
    const parsed = parseCompactV2Cursor(session, cursor, cursorScope);
    if (parsed.generation !== index.generation) throw new Error("stale_cursor");
    offset = parsed.offset;
  }
  const liveElements = await session.browser.extractInteractiveElements();
  let pageOrigin = "";
  try {
    pageOrigin = new URL(session.browser.currentUrl()).origin;
  } catch {}
  const liveRefs = provisionElementRefs(liveElements);
  const liveSafe = buildSafeControlsV2({
    elements: liveElements,
    legacyRefs: liveRefs,
    generation: index.generation,
    pageOrigin,
    pageUrl: session.browser.currentUrl(),
  });
  if (
    liveSafe.rows.length !== index.rows.length ||
    liveSafe.byRef.size !== session.compactV2Refs.size ||
    liveSafe.rows.some((row, rowIndex) => !sameCompactV2Control(row, index.rows[rowIndex]!)) ||
    [...liveSafe.byRef].some(([ref, legacy]) => session.compactV2Refs.get(ref) !== legacy)
  ) {
    invalidateCompactV2Snapshot(session);
    throw new Error("stale_cursor");
  }
  const liveByLegacy = new Map<string, InteractiveElement>();
  for (const [element, legacy] of liveRefs) liveByLegacy.set(legacy, element);
  const privateMatches = new Set<string>();
  if (needle.length > 0) {
    for (const [ref, legacy] of session.compactV2Refs) {
      const element = liveByLegacy.get(legacy);
      if (element !== undefined && controlMatchesPrivateQueryV2(element, query)) {
        privateMatches.add(ref);
      }
    }
  }
  const rows = index.rows.filter((row) => {
    const searchable = [
      row.name,
      row.role,
      row.state,
      row.visibility,
      row.action,
      row.field,
      row.choice,
      row.frame,
    ]
      .filter((value): value is string => value !== undefined)
      .map(norm);
    return (
      (needle.length === 0 ||
        searchable.some((value) => value.includes(needle)) ||
        privateMatches.has(row.ref)) &&
      (role === undefined || row.role === role)
    );
  });
  const page = encodeV2Page({
    sessionId: session.id,
    stage: index.stage,
    pageUrl: session.browser.currentUrl(),
    semantics: index.semantics,
    rows,
    offset,
    cursorFor: (next) => compactV2Cursor(session, index.generation, next, cursorScope),
  });
  return page.payload;
}

async function observeSession(
  session: Session,
  detail: "compact" | "full" = "compact",
  startMetadata?: CompactV2StartMetadata,
): Promise<Observation> {
  const oauthInProgress = (): Observation => {
    session.prevObserve = null;
    invalidateCompactV2Snapshot(session);
    const oauth = session.browser.oauthTransitionStatus?.();
    const guidance =
      "OAuth in progress: the provider detached or closed its page as expected. " +
      "Do not switch login methods or close the session; call operate_observe again to read the retained product page.";
    const state: NonNullable<Observation["oauth"]> = {
      state: "in_progress",
      provider_page: "closed_or_detached",
      next_action: "operate_observe",
    };
    session.browser.completeOAuthTransitionRecovery();
    return compactV2PublicObservation(
      session,
      () => ({
        session_id: session.id,
        url: oauth?.productUrl ?? session.startUrl,
        text: "",
        guidance,
        elements: [],
        oauth: state,
      }),
      { stage: "auth", guidance, oauth: state },
    );
  };
  try {
    session.browser.recoverActivePage();
    const transition = session.browser.oauthTransitionStatus?.();
    if (
      transition?.providerPageClosed === true &&
      transition.productPageViable &&
      transition.browserConnected
    ) {
      return oauthInProgress();
    }
    widenAllowedHostsFromCurrentUrl(session);
    session.generation += 1;
    const generation = session.generation;
    const elements = await session.browser.extractInteractiveElements();
    retainSessionElements(session, elements);
    let semanticSource: ObservationSemanticSourceV2 = { title: "", headings: [] };
    try {
      semanticSource = await session.browser.extractObservationSemantics();
    } catch {
      // Semantic context is optional availability-wise; it is independently
      // sealed below and never changes action-map safety.
    }
    // Native TypeScript compact serializer over TS's own CDP-derived DOM
    // inventory. Its allowlist seal runs before any retained/emitted view; no
    // Python subprocess or externally provisioned runtime participates.
    const v2Mode = session.compactV2Mode;
    if (v2Mode === "on") {
      return compactV2Observation(session, generation, elements, semanticSource, startMetadata);
    }
    if (v2Mode === "shadow") exerciseCompactV2Shadow(session, generation, elements, semanticSource);
    session.compactV2Active = false;
    invalidateCompactV2Snapshot(session);
    const sealedFieldKeys = observationSealedFieldKeys(session, elements);
    const text = redactPaymentObservationText(
      await session.browser.extractVisibleText(),
      elements,
      session.paymentFieldSealActive,
    );
    const normalizedFull = text.replace(/\s+/g, " ").trim();
    const normalizedText = normalizedFull.slice(0, 4000);
    const guidance = provisionPerceptionGuidance(normalizedText);
    const url = session.browser.currentUrl();
    const liveCheckout = await captureCartCheckoutForFillCardFallback(session, url);
    const checkoutState = checkoutStateForObservation(
      session,
      url,
      text.slice(0, 12_000),
      elements,
      liveCheckout,
    );
    const currentCartMutation = cartMutationForUrl(session, url);
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
        sealed: sealedFieldKeys,
        paymentSealActive: session.paymentFieldSealActive,
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
        return withCheckoutState(
          {
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
            ...(built.observation.modal_active === true ? { modal_active: true } : {}),
          },
          checkoutState,
          currentCartMutation,
        );
      }
      session.prevObserve = built.nextState;
      return withCheckoutState(
        {
          ...built.observation,
          snapshot_file: snapshotFile,
        },
        checkoutState,
        currentCartMutation,
      );
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
      elements.map((el) =>
        toCompactElement(
          el,
          refOf(el),
          sealedFieldKeys,
          true,
          false,
          session.paymentFieldSealActive,
        ),
      ),
    );
    const screen = buildScreenOutline(
      elements,
      normalizedText,
      sealedFieldKeys,
      session.paymentFieldSealActive,
    );
    const accessibility = buildAccessibilitySnapshot(
      elements,
      undefined,
      sealedFieldKeys,
      session.paymentFieldSealActive,
    );
    return withCheckoutState(
      {
        session_id: session.id,
        url,
        text: normalizedText,
        ...(guidance !== undefined ? { guidance } : {}),
        ...(screen !== undefined ? { screen } : {}),
        ...(accessibility !== undefined ? { accessibility } : {}),
        elements: elements.map((el) => {
          const observed: ObservedElement = {
            ref: refOf(el),
            label: presentLabel(el, sealedFieldKeys, session.paymentFieldSealActive),
            tag: presentPaymentSafeString(el.tag, session.paymentFieldSealActive),
            role:
              el.role === null
                ? null
                : presentPaymentSafeString(el.role, session.paymentFieldSealActive),
            type:
              el.type === null
                ? null
                : presentPaymentSafeString(el.type, session.paymentFieldSealActive),
            value: presentFieldValue(el, sealedFieldKeys, session.paymentFieldSealActive),
            checked: el.checked ?? null,
            href:
              el.href === null || el.href === undefined
                ? null
                : presentPaymentSafeString(el.href, session.paymentFieldSealActive),
            testId:
              el.testId === null || el.testId === undefined
                ? null
                : presentPaymentSafeString(el.testId, session.paymentFieldSealActive),
            path:
              el.screenPath === null || el.screenPath === undefined
                ? null
                : presentPaymentSafeString(el.screenPath, session.paymentFieldSealActive),
            container:
              el.container === null || el.container === undefined
                ? null
                : presentPaymentSafeString(el.container, session.paymentFieldSealActive),
            topmost: el.topmost ?? null,
            occluded_by:
              el.occludedBy === null || el.occludedBy === undefined
                ? null
                : presentPaymentSafeString(el.occludedBy, session.paymentFieldSealActive),
            frame_origin:
              el.frameOrigin === null || el.frameOrigin === undefined
                ? null
                : presentPaymentSafeString(el.frameOrigin, session.paymentFieldSealActive),
          };
          annotatePaymentControl(observed, el);
          return observed;
        }),
      },
      checkoutState,
      currentCartMutation,
    );
  } catch (err) {
    const oauth = session.browser.oauthTransitionStatus?.();
    if (oauth?.providerPageClosed === true && oauth.productPageViable && oauth.browserConnected) {
      // A read racing an expected provider-page close must not leak the raw
      // Playwright "Target page, context or browser has been closed" exception
      // into the model's plan. Discard the delta baseline because the next
      // successful product-page read is a new authoritative snapshot.
      return oauthInProgress();
    }
    throw err;
  }
}

function isCheckoutSubmitLabeled(labels: readonly (string | null | undefined)[]): boolean {
  return labels.some(
    (label) => label !== null && label !== undefined && CHECKOUT_SUBMIT_LABEL_RE.test(label.trim()),
  );
}

function isPlaceOrderClickCandidate(el: InteractiveElement): boolean {
  return isCheckoutSubmitLabeled([
    el.ariaLabel,
    el.value,
    el.visibleText,
    el.labelText,
    el.iconLabel,
    el.title,
  ]);
}

// D2 — one human passkey approval authorizes at most one place-order attempt.
// operate_act is otherwise fully generic (no merchant hostname/selector
// knowledge); this reuses the SAME label heuristic (CHECKOUT_SUBMIT_LABEL_RE)
// Squire's own retired single-phase submit used to find the pay/place-order
// control, so a click/js_click only counts as a place-order attempt when it
// targets a control that reads like one. Returns the approval snapshot when
// THIS action is the first attempt; throws before the click executes on a
// repeat. A fresh attempt requires a fresh operate_pay approval — since a
// filled card can never be refilled in the same session (Pillar 2), that
// means a new session.
function enforcePlaceOrderGuard(
  session: Session,
  labels: readonly (string | null | undefined)[],
): Session["placeOrderApproval"] {
  if (!isCheckoutSubmitLabeled(labels)) return null;
  if (getActivePendingThreeDs(session) !== null) {
    throw new Error(
      "operate_act refused: a prior charge has unresolved 3-D Secure state; call " +
        "operate_payment_status first",
    );
  }
  if (session.placeOrderApproval === null) return null;
  if (session.placeOrderAttempted) {
    throw new Error(
      "operate_act refused: a place-order attempt already fired for this approval " +
        `(approval_id=${session.placeOrderApproval.approvalId}). One human passkey approval ` +
        "authorizes at most one place-order attempt — a fresh operate_pay approval is required " +
        "before placing the order again.",
    );
  }
  const approval = session.placeOrderApproval;
  session.placeOrderAttempted = true;
  return approval;
}

// D1 — best-effort server-side record that a caller-placed charge was
// attempted. Deliberately attempt semantics, not execution: Squire cannot
// verify what the merchant did after the caller's click (it never re-reads
// the total or the order-confirmation page here), only that the approval was
// consumed and the place-order control was pressed. Never blocks the click —
// mirrors the audit_recorded best-effort handling in pay-operator.ts.
async function recordPlaceOrderAttemptAudit(
  session: Session,
  approval: NonNullable<Session["placeOrderApproval"]>,
): Promise<void> {
  if (session.api === undefined) return;
  try {
    await session.api.auditPayment({
      merchant: approval.merchant,
      amount_cents: approval.amountCents,
      currency: approval.currency,
      last4: approval.last4,
      card_ref: approval.cardRef,
      approval_id: approval.approvalId,
      status: "payment_place_order_attempted",
      ...(approval.mandateId !== undefined ? { mandate_id: approval.mandateId } : {}),
    });
  } catch {
    // Best-effort — an audit write failure must never fail the caller's
    // place-order action.
  }
}

async function runClickWithPlaceOrderGuard(
  session: Session,
  click: (shouldTrack: (labels: readonly string[]) => boolean) => Promise<ClickDispatchStatus>,
): Promise<void> {
  let approval: Session["placeOrderApproval"] = null;
  try {
    const dispatchStatus = await click((labels) => {
      approval = enforcePlaceOrderGuard(session, labels);
      return approval !== null;
    });
    if (approval === null) return;
    if (dispatchStatus === "not_dispatched") {
      if (session.placeOrderApproval === approval) session.placeOrderAttempted = false;
      return;
    }
  } catch (error) {
    if (approval === null) throw error;
    if (clickDispatchStatusForError(error) === "not_dispatched") {
      if (session.placeOrderApproval === approval) session.placeOrderAttempted = false;
    } else {
      await recordPlaceOrderAttemptAudit(session, approval);
    }
    throw error;
  }
  await recordPlaceOrderAttemptAudit(session, approval);
}

interface InternalActResult {
  observation: Observation;
  outcome: {
    selectedOption?: string;
    checkoutState?: CheckoutState;
  };
}

async function actInternally(
  sessionId: string,
  action: ProvisionAction,
  detail: ObserveDetail = "compact",
  cartIdentity?: CartIdentityContext,
  collectCheckoutState = false,
  compactV2Authorization?: CompactV2TargetAuthorization,
): Promise<InternalActResult> {
  const session = sessionForCall(sessionId);
  const oauthProvider =
    action.kind === "oauth_login" || action.kind === "oauth_click" ? action.provider : undefined;
  try {
    const execute = async (deadline?: OAuthActionDeadline): Promise<InternalActResult> =>
      await executeAct(
        sessionId,
        action,
        detail,
        cartIdentity,
        true,
        collectCheckoutState,
        compactV2Authorization,
        deadline,
      );
    return session !== undefined && (action.kind === "oauth_login" || action.kind === "oauth_click")
      ? await withOAuthActionBoundary(session, oauthProvider, execute)
      : await execute(undefined);
  } catch (error) {
    if (
      session?.compactV2Active === true &&
      !(error instanceof ManualCardEntryBlockedError) &&
      !(error instanceof ProvisionTargetMissingError)
    ) {
      throw new CompactV2ActionFailureError(compactV2ActionFailureReason(error, action.kind));
    }
    throw error;
  }
}

export async function act(
  sessionId: string,
  action: ProvisionAction,
  detail: ObserveDetail = "compact",
  cartIdentity?: CartIdentityContext,
): Promise<Observation> {
  const session = sessionForCall(sessionId);
  const oauthProvider =
    action.kind === "oauth_login" || action.kind === "oauth_click" ? action.provider : undefined;
  try {
    const execute = async (deadline?: OAuthActionDeadline): Promise<InternalActResult> =>
      await executeAct(sessionId, action, detail, cartIdentity, false, false, undefined, deadline);
    const result =
      session !== undefined && (action.kind === "oauth_login" || action.kind === "oauth_click")
        ? await withOAuthActionBoundary(session, oauthProvider, execute)
        : await execute(undefined);
    return result.observation;
  } catch (error) {
    if (session?.compactV2Active === true) {
      throw new Error(compactV2ActionFailureReason(error, action.kind));
    }
    throw error;
  }
}

async function executeAct(
  sessionId: string,
  action: ProvisionAction,
  detail: ObserveDetail,
  cartIdentity: CartIdentityContext | undefined,
  internalAccess: boolean,
  collectCheckoutState: boolean,
  internalAuthorization?: CompactV2TargetAuthorization,
  oauthDeadline?: OAuthActionDeadline,
): Promise<InternalActResult> {
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
  // Gate here — ahead of BOTH the locator and element `type` branches, and of
  // replay's act() calls — so no model-supplied text path can reach a PAN fill.
  if (action.kind === "type") {
    const cardBlock = manualCardEntryBlockReason(action.text);
    if (cardBlock !== null) throw new ManualCardEntryBlockedError(cardBlock);
  }
  let browser = session.browser;
  let completedAction: ProvisionAction = action;
  let sensitiveSource: RecordedValueSource | undefined;
  let cartAffecting = false;
  const bindCartIdentity = (affecting: boolean): void => {
    // Generic operate_act cart controls stay usable without identity. Identity
    // is a best-effort observation hint here; exact product/variant binding and
    // retry suppression belong to operate_act { kind: "cart_add" }'s dedicated contract.
    if (!affecting || cartIdentity === undefined) return;
    cartAffecting = true;
    cartIdentity.onActionReady?.();
  };
  let resolutionTarget: string | undefined;
  let auditTarget: string | undefined;
  let compactV2Authorization = internalAuthorization;
  if ("target" in action) {
    if (session.compactV2Active && !internalAccess) {
      try {
        compactV2Authorization = compactV2AuthorizationForHandle(session, action.target);
        resolutionTarget = compactV2Authorization.legacyRef;
        auditTarget = action.target;
      } catch (error) {
        audit(sessionId, "act", { kind: action.kind, target: "<rejected-v2-target>" });
        throw error;
      }
    } else {
      resolutionTarget = action.target;
      auditTarget =
        session.compactV2Active && internalAccess
          ? "<internal-target>"
          : parseLocatorTarget(action.target) !== null
            ? "<mode>=<redacted>"
            : action.target;
    }
  }
  audit(sessionId, "act", {
    kind: action.kind,
    ...(auditTarget !== undefined ? { target: auditTarget } : {}),
    ...("url" in action
      ? { url: session.compactV2Active ? compactV2AuditUrl(action.url) : action.url }
      : {}),
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
      throw new ProvisionTargetNotAllowedError(
        `action refused: the browser is on Squire's own control plane (${curHost}). ` +
          `The operator may not act on the Trusty Squire vault/app — navigate away with goto.`,
      );
    }
  }

  const recordingTransitionFields = await attestRecordedFieldsBeforeTransition(session, action);

  // Captured for the operator-recipe trace: the element a target action
  // resolved to, so we record the VISIBLE text it acted on (not the ref).
  let resolvedEl: InteractiveElement | null = null;
  try {
    switch (action.kind) {
      case "goto": {
        if (!hostAllowed(action.url, hostStrings(session))) {
          throw new ProvisionTargetNotAllowedError(
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
          throw new ProvisionTargetNotAllowedError(
            `allow_host rejected "${action.host}": ${checked.error}`,
          );
        }
        if (!session.allowedHosts.some((e) => e.host === checked.host)) {
          session.allowedHosts.push({ host: checked.host, source: "mid_session" });
          audit(sessionId, "allow_host", {
            host: checked.host,
            allowed_hosts: hostStrings(session),
          });
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
              `operate_act { kind: "extract", into_slot: "${action.slot}" }. Known slots: ` +
              `[${[...session.secretSlots.keys()].join(", ")}]`,
          );
        }
        sensitiveSource = {
          traceIndex: -1,
          hole: `credential.${action.slot}`,
          literal: value,
        };
        const locator = parseLocatorTarget(resolutionTarget!);
        if (locator !== null) {
          const resolved = await browser.resolvePageTarget(locator.mode, locator.value, "type");
          if (!resolved.ok) {
            if (resolved.reason === "none") {
              throw new Error(`type_secret: no element matched locator "${action.target}".`);
            }
            throw new AmbiguousProvisionTargetError(action.target, resolved.candidates);
          }
          try {
            if (resolved.frameTarget !== null) {
              assertSecretFrameTargetAllowed(session, resolved.frameTarget);
            }
            session.usedLocatorFallback = true;
            const sealedFieldKeys = await browser.typeHandle(resolved.handle, value, true);
            for (const key of sealedFieldKeys) session.sealedFieldKeys.add(key);
          } finally {
            await resolved.handle.dispose().catch(() => undefined);
          }
          audit(sessionId, "type_secret", {
            slot: action.slot,
            locator_mode: locator.mode,
            host: registrableHost(browser.currentUrl()),
          });
          break;
        }
        const fresh = await browser.extractInteractiveElements();
        retainSessionElements(session, fresh);
        // resolveTarget recomputes identities (incl. volatile positional-group
        // fingerprints) from these FRESH elements, so a ref whose group fingerprint
        // changed since the last observe resolves to null, not a survivor (#399).
        const el =
          compactV2Authorization === undefined
            ? resolveTarget(fresh, resolutionTarget!)
            : resolveAuthorizedCompactV2Target(session, fresh, compactV2Authorization);
        if (el === null) {
          if (session.compactV2Active) {
            if (!internalAccess) throwCompactV2ReobserveRequired();
            throw new Error("type_secret: internal live target changed");
          }
          const stale = staleTargetError(session, action.target, fresh);
          if (stale !== null) throw stale;
          throw new Error(`type_secret: no element matched target "${action.target}".`);
        }
        resolvedEl = el;
        // Frame domain-lock (operator-frame-support) — never let a secret cross
        // into a rogue/third-party (e.g. payment) iframe. See
        // assertSecretFrameTargetAllowed; a main-frame or same-domain-frame
        // target is unaffected.
        assertSecretFrameTargetAllowed(session, el);
        // Remember this field so the next observation masks its DOM value — the
        // host sealed this secret into a slot and must never read it back.
        for (const key of elementTargetKeys(el)) session.sealedFieldKeys.add(key);
        // Type the REAL value into the page. It crosses only browser↔page; the
        // value is never returned to the host and never logged.
        const target = frameTargetFor(el);
        const sealedFieldKeys =
          target !== null
            ? await browser.typeInFrame(target, el.selector, value, true)
            : await browser.type(el.selector, value, true);
        for (const key of sealedFieldKeys) session.sealedFieldKeys.add(key);
        audit(sessionId, "type_secret", {
          slot: action.slot,
          target: auditTarget,
          host: registrableHost(browser.currentUrl()),
        });
        break;
      }
      case "select": {
        // Re-resolve against FRESH elements — the target may be the <select> or
        // its <label>. Main-frame execution uses selectOption; frame execution
        // uses selectInFrame. text is the fuzzy option matcher in both paths.
        const fresh = await browser.extractInteractiveElements();
        retainSessionElements(session, fresh);
        const el =
          compactV2Authorization === undefined
            ? resolveTarget(fresh, resolutionTarget!)
            : resolveAuthorizedCompactV2Target(session, fresh, compactV2Authorization);
        if (el === null) {
          if (session.compactV2Active) {
            if (!internalAccess) throwCompactV2ReobserveRequired();
            throw new Error("select: internal live target changed");
          }
          const stale = staleTargetError(session, action.target, fresh);
          if (stale !== null) throw stale;
          throw new Error(
            `select: no element matched target "${action.target}". Visible: ` +
              fresh
                .map((e) => `"${e.screenPath ?? elementRef(e)}"`)
                .slice(0, 20)
                .join(", "),
          );
        }
        resolvedEl = el;
        // Frame domain-lock (operator-frame-support) — the SAME gate a frame
        // click/type passes; see frameTargetAllowed. A native <select> is not a
        // secret field, so the stricter type_secret cross-origin rule does not
        // apply, but the ordinary domain lock does.
        assertFrameTargetAllowed(session, el, "select");
        bindCartIdentity(isCartAffectingAction(action, el));
        const selectFrame = frameTargetFor(el);
        const committedText =
          selectFrame !== null
            ? await browser.selectInFrame(selectFrame, el.selector, action.text)
            : await browser.selectOption(el.selector, action.text);
        session.committedSelectValues.set(
          compactV2CommittedSelectKey(session, el.selector),
          compactV2CommittedSelectValue(session, committedText),
        );
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
        const locator = parseLocatorTarget(resolutionTarget!);
        if (locator !== null) {
          if (action.kind !== "click" && action.kind !== "js_click" && action.kind !== "type") {
            throw new Error(
              `operate_act kind="${action.kind}" does not accept a text=/css= locator target; ` +
                `use an @e: ref from operate_observe.`,
            );
          }
          const resolved = await browser.resolvePageTarget(
            locator.mode,
            locator.value,
            action.kind === "type" ? "type" : "click",
          );
          if (!resolved.ok) {
            if (resolved.reason === "none") {
              throw new ProvisionTargetMissingError(
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
          // Mark the session non-promotable BEFORE the action: a locator action can't
          // be replayed from the inventory (the element was never in it), so a
          // skill synthesized from this run would silently omit the step. Setting
          // it up front means an action that lands but then throws still can't leave
          // the session promotable (see captureAndPromoteSession) (codex).
          try {
            const resolvedBlock = shouldBlockUnsafeProvisionSignals(
              pageText,
              resolved.safetySignals,
            );
            if (resolvedBlock !== null) throw new Error(resolvedBlock);
            if (resolved.frameTarget !== null) {
              assertFrameTargetAllowed(session, resolved.frameTarget, action.kind);
            }
            bindCartIdentity(isCartAffectingAction(action, null, resolved.labels));
            session.usedLocatorFallback = true;
            const isPlaceOrderCandidate = isCheckoutSubmitLabeled([
              resolved.text,
              ...resolved.labels,
            ]);
            if (
              (session.placeOrderApproval !== null || getActivePendingThreeDs(session) !== null) &&
              isPlaceOrderCandidate &&
              (action.kind === "click" || action.kind === "js_click")
            ) {
              await runClickWithPlaceOrderGuard(session, (shouldTrack) =>
                browser.clickWithDispatchTracking(
                  {
                    kind: "handle",
                    handle: resolved.handle,
                    method: action.kind,
                  },
                  shouldTrack,
                ),
              );
            } else if (action.kind === "click") await browser.clickHandle(resolved.handle);
            else if (action.kind === "js_click") await browser.jsClickHandle(resolved.handle);
            else await browser.typeHandle(resolved.handle, action.text);
          } finally {
            await resolved.handle.dispose().catch(() => undefined);
          }
          audit(sessionId, action.kind, {
            locator_mode: locator.mode,
            host: registrableHost(browser.currentUrl()),
          });
          if (action.kind !== "type") await settleAfterStateChange(browser);
          break;
        }
        // Re-resolve against FRESH elements every act — never trust a stale index.
        const fresh = await browser.extractInteractiveElements();
        retainSessionElements(session, fresh);
        // resolveTarget recomputes identities (incl. volatile positional-group
        // fingerprints) from these FRESH elements, so a ref whose group fingerprint
        // changed since the last observe resolves to null, not a survivor (#399).
        const el =
          compactV2Authorization === undefined
            ? resolveTarget(fresh, resolutionTarget!)
            : resolveAuthorizedCompactV2Target(session, fresh, compactV2Authorization);
        if (el === null) {
          if (session.compactV2Active) {
            if (!internalAccess) throwCompactV2ReobserveRequired();
            throw new Error(`${action.kind}: internal live target changed`);
          }
          const stale = staleTargetError(session, action.target, fresh);
          if (stale !== null) throw stale;
          throw new Error(
            `no element matched target "${action.target}". Visible: ` +
              fresh
                .map((e) => `"${e.screenPath ?? elementRef(e)}"`)
                .slice(0, 20)
                .join(", "),
          );
        }
        resolvedEl = el;
        // Frame domain-lock (operator-frame-support) — see frameTargetAllowed.
        // A main-frame or same-domain-frame target is unaffected.
        assertFrameTargetAllowed(session, el, action.kind);
        bindCartIdentity(isCartAffectingAction(action, el));
        if (action.kind === "click" || action.kind === "js_click") {
          const target = frameTargetFor(el);
          if (
            (session.placeOrderApproval !== null || getActivePendingThreeDs(session) !== null) &&
            isPlaceOrderClickCandidate(el)
          ) {
            await runClickWithPlaceOrderGuard(session, (shouldTrack) =>
              browser.clickWithDispatchTracking(
                target !== null
                  ? { kind: "frame", frame: target, selector: el.selector, method: action.kind }
                  : { kind: "selector", selector: el.selector, method: action.kind },
                shouldTrack,
              ),
            );
          } else if (action.kind === "click") {
            if (target !== null) await browser.clickInFrame(target, el.selector);
            else await browser.click(el.selector);
          } else {
            if (target !== null) await browser.clickViaJsInFrame(target, el.selector);
            else await browser.clickViaJs(el.selector);
          }
        } else if (action.kind === "type" && frameTargetFor(el) !== null) {
          // Frame targets skip the autocomplete-popup-commit machinery below —
          // it operates on the main page's DOM only (markPreexistingType
          // SuggestionPopups / detectTypeSuggestionPopup / commitTypeSuggestion
          // are page-scoped). Out of scope for the checkout-option case frame
          // support exists for; a plain frame-scoped fill covers it.
          clearCommittedSelectValue(session, el.selector);
          await browser.typeInFrame(frameTargetFor(el)!, el.selector, action.text);
        } else if (action.kind === "type") {
          clearCommittedSelectValue(session, el.selector);
          if (!isAutocompleteScopedTypeField(action.provenance, el)) {
            // Free text only — e.g. a site-search/catalog-search box, which
            // can legitimately open its own suggestion listbox too. 3.1 only
            // applies to a form/recipe field where a committed value is
            // actually required; forcing every incidental popup into
            // commit-or-stop would break ordinary search typing.
            await browser.type(el.selector, action.text);
          } else {
            // 3.1 — a Google-Places-style address field or a react-select/cmdk/
            // Radix combobox can open a suggestion popup as a side effect of
            // typing, not just of an explicit `select`. Snapshot pre-existing
            // popups BEFORE typing (it can open mid-keystroke), then detect what
            // opened afterward.
            await browser.markPreexistingTypeSuggestionPopups();
            await browser.type(el.selector, action.text);
            // Cleanup (clear our tracking markers, and dismiss with Escape
            // ONLY when a detected popup is plausibly still open) must run no
            // matter how this resolves — no popup, an ambiguous stop, a
            // failed commit, or success — mirroring selectFromCombobox's own
            // try/finally. Scoping the try to only the
            // suggestionTexts.length > 0 branch left the "preexisting"
            // markers set by markPreexistingTypeSuggestionPopups uncleared on
            // the no-popup path; markComboboxPreexistingElements only ADDS
            // markers, so a stale one could exclude a genuine popup from
            // detection on a LATER type/select into the same element. Escape
            // fires on the ambiguous-stop and failed-commit paths (popup
            // never interacted with / click may not have registered — still
            // open either way) but NEVER after a confirmed commit: the widget
            // already closed its popup on selection, so Escape would land on
            // nothing and bubble to close an enclosing modal/dialog instead.
            let dismissPopupWithEscape = false;
            try {
              const suggestionTexts = await browser.detectTypeSuggestionPopup(el.selector);
              if (suggestionTexts.length > 0) {
                dismissPopupWithEscape = true;
                const candidates = matchAutocompleteSuggestions(action.text, suggestionTexts);
                if (candidates.length !== 1) {
                  // Pass the MATCHED subset, not the full popup — passing every
                  // suggestion made candidates.length effectively the popup
                  // size (always > 0 here), so the constructor's zero-match
                  // branch was dead code and the multi-match message reported
                  // the wrong count.
                  throw new AutocompleteCommitRequiredError(
                    action.text,
                    candidates.map((i) => suggestionTexts[i]!),
                  );
                }
                const pickedText = suggestionTexts[candidates[0]!]!;
                await browser.commitTypeSuggestion(candidates[0]!);
                // Never trust that a click "looked right" — POSITIVELY confirm
                // the commit took (same hard constraint as the field-role
                // guard, PR #447: a miss is a stop, never a silent
                // pass-through). Checking only the typed-into selector's own
                // `.value` false-fails on react-select/cmdk-style widgets,
                // which clear their search input on selection and render the
                // committed choice in a nearby element instead —
                // confirmAutocompleteCommitted checks that too, bounded to the
                // field's own neighborhood, and returns false (never a guess)
                // when nothing confirms it.
                const committed = await browser.confirmAutocompleteCommitted(
                  el.selector,
                  pickedText,
                );
                if (!committed) {
                  throw new Error(
                    `autocomplete commit for "${action.text}" did not take — nothing on the page ` +
                      `confirms the field now holds "${pickedText}" after selecting it.`,
                  );
                }
                dismissPopupWithEscape = false;
                // Rewrite the completed action to the field's LIVE post-commit
                // value (not the raw typed draft) before it reaches
                // recordTrace/recordedValues, so the recorded trace reflects
                // what actually ended up on the page. Recording pickedText
                // would diverge from the live value exactly when the commit
                // was confirmed via a NEARBY element (react-select/cmdk clear
                // their search input on selection), and the cold-path
                // transition attestation (attestRecordedFieldsBeforeTransition
                // → verifyFilledFieldValues) re-reads the live value — a
                // pickedText literal would flag every such commit as a
                // mismatch and disqualify recipe recording. Reading the same
                // live value here is attestation-consistent by construction.
                // Known limitation: after a nearby-signal-only commit the
                // field itself can be empty, so the recorded literal is "" —
                // that field won't cleanly template into a saved recipe, but
                // the live run is unaffected.
                const refreshed = await browser.extractInteractiveElements();
                retainSessionElements(session, refreshed);
                const liveField = refreshed.find((field) => field.selector === el.selector);
                const liveValue =
                  typeof liveField?.value === "string" ? liveField.value : pickedText;
                completedAction = { ...action, text: liveValue };
              }
            } finally {
              await browser.discardTypeSuggestionPopup(dismissPopupWithEscape);
            }
          }
        } else if (action.kind === "upload") {
          assertNoFrameTarget(el, "upload");
          await browser.uploadFile(el.selector, action.path);
          audit(sessionId, "upload", {
            target: auditTarget,
            path: session.compactV2Active ? "<local-file>" : action.path,
            host: registrableHost(browser.currentUrl()),
          });
        } else {
          assertNoFrameTarget(el, "oauth_click");
          if (oauthDeadline === undefined) {
            throw new Error("OAuth action deadline was not established");
          }
          browser = await runSerializedOAuthBoundary(
            session,
            el,
            fresh,
            action.provider,
            oauthDeadline,
          );
        }
        if (action.kind !== "type") await settleAfterStateChange(browser);
        break;
      }
      case "oauth_login": {
        const pageText = await browser.extractVisibleText();
        const blockReason = shouldBlockUnsafeProvisionAction(pageText, action);
        if (blockReason !== null) throw new Error(blockReason);
        // Atomic OAuth deliberately accepts only the observed stable ref. A raw
        // locator would lose the same stale-reference guarantees as every other
        // action before the provider transition begins.
        const fresh = await browser.extractInteractiveElements();
        retainSessionElements(session, fresh);
        const el =
          compactV2Authorization === undefined
            ? resolveTarget(fresh, resolutionTarget!)
            : resolveAuthorizedCompactV2Target(session, fresh, compactV2Authorization);
        if (el === null) {
          if (session.compactV2Active) {
            if (!internalAccess) throwCompactV2ReobserveRequired();
            throw new Error("oauth_login: internal live target changed");
          }
          throw new Error(
            `oauth_login: no element matched target "${action.target}". Re-observe and use the OAuth button ref.`,
          );
        }
        resolvedEl = el;
        assertNoFrameTarget(el, "oauth_login");
        if (oauthDeadline === undefined) {
          throw new Error("OAuth action deadline was not established");
        }
        browser = await runSerializedOAuthBoundary(
          session,
          el,
          fresh,
          action.provider,
          oauthDeadline,
        );
        break;
      }
    }
  } finally {
    if (action.kind !== "allow_host") invalidateCompactV2Snapshot(session);
  }
  await verifyRecordedFieldsAfterTransition(session, action, recordingTransitionFields);
  // Don't fold inbox-provider steps into the replayable recipe (see
  // INBOX_READ_HOSTS): replay re-reads the code via awaitVerification, and a
  // recorded inbox click would bake the email's subject into a shared recipe.
  if (!isInboxReadHost(browser.currentUrl())) {
    const replayElement = replaySafeElementForSession(session, resolvedEl);
    recordTrace(session, completedAction, replayElement, sensitiveSource);
    recordCaptureRound(session, completedAction, replayElement, urlBeforeAction);
  }
  if (cartAffecting) {
    session.lastCartMutation = {
      productIdentity: cartIdentity!.productIdentity,
      optionsHash: cartIdentity!.optionsHash,
      cartDelta: "unknown",
      origin: originForUrl(browser.currentUrl()) ?? "",
    };
  }
  // `detail:"none"` returns a minimal ack (the action ran; no perception emitted)
  // so multi-field fills don't each echo the page. The host must call
  // operate_observe before its next ref-targeted act (refs aren't refreshed here).
  const checkoutState =
    internalAccess && collectCheckoutState ? await capturePrivateCheckoutState(session) : undefined;
  const observation =
    detail === "none" && !cartAffecting && action.kind !== "oauth_login"
      ? compactV2PublicObservation(
          session,
          () => ({
            session_id: session.id,
            url: browser.currentUrl(),
            text: "",
            elements: [],
            observed: "none" as const,
          }),
          {
            stage: safeStageV2(browser.currentUrl(), session.lastElements),
            observed: "none",
          },
        )
      : await observeSession(session, detail === "none" ? "compact" : detail);
  return {
    observation:
      completedAction.kind === "select" && observation.format !== "compact-v2"
        ? { ...observation, selected_option: completedAction.text }
        : observation,
    outcome: {
      ...(completedAction.kind === "select" ? { selectedOption: completedAction.text } : {}),
      ...(checkoutState === undefined ? {} : { checkoutState }),
    },
  };
}

export interface FormSelectManyFieldResult {
  label: string;
  option?: string;
  status: "selected" | "failed";
  selected_option?: string;
  reason?: string;
  repair?: TargetStaleResult;
}

export async function formSelectMany(
  sessionId: string,
  selections: Record<string, string>,
): Promise<{ session_id: string; fields: FormSelectManyFieldResult[]; observation: Observation }> {
  const fields: FormSelectManyFieldResult[] = [];
  const session = sessionForCall(sessionId);
  if (session === undefined) throw new Error(`unknown provision session ${sessionId}`);
  const selectionEntries = Object.entries(selections);

  for (let index = 0; index < selectionEntries.length; index += 1) {
    const [label, option] = selectionEntries[index]!;
    const publicLabel =
      session.compactV2Active && !/^@e:[0-9a-z]+\.[0-9a-z]+$/.test(label)
        ? "<rejected-v2-target>"
        : label;
    const publicSelection = session.compactV2Active
      ? { label: publicLabel }
      : { label: publicLabel, option };
    let authorization: CompactV2TargetAuthorization | undefined;
    if (session.compactV2Active) {
      try {
        authorization = compactV2AuthorizationForHandle(session, label);
      } catch (error) {
        audit(sessionId, "act", { kind: "select_many", target: "<rejected-v2-target>" });
        if (index === 0) throw error;
        fields.push({
          ...publicSelection,
          status: "failed",
          reason: compactV2SelectionFailureReason(error),
        });
        if (index + 1 < selectionEntries.length) await observe(sessionId, "compact");
        continue;
      }
    }
    try {
      const target = authorization?.legacyRef ?? label;
      const actionResult = await actInternally(
        sessionId,
        { kind: "select", target, text: option },
        "none",
        undefined,
        false,
        authorization,
      );
      const selectedOption = actionResult.outcome.selectedOption;
      if (selectedOption === undefined) {
        throw new Error("select: successful action omitted the selected option");
      }
      // `detail:none` is intentionally a minimal ack. The explicit observe here
      // refreshes the DOM generation between every potentially mutating select.
      await observe(sessionId, "compact");
      const publicSelectedOption = session.compactV2Active
        ? safeDescriptionV2(selectedOption)
        : selectedOption;
      fields.push({
        ...publicSelection,
        status: "selected",
        ...(publicSelectedOption === undefined ? {} : { selected_option: publicSelectedOption }),
      });
    } catch (err) {
      if (session.compactV2Active) {
        fields.push({
          ...publicSelection,
          status: "failed",
          reason: compactV2SelectionFailureReason(err),
        });
      } else if (err instanceof TargetStaleError) {
        fields.push({
          ...publicSelection,
          status: "failed",
          reason: err.message,
          repair: err.result,
        });
      } else {
        fields.push({
          ...publicSelection,
          status: "failed",
          reason: err instanceof Error ? err.message : String(err),
        });
      }
      if (session.compactV2Active && index + 1 < selectionEntries.length) {
        await observe(sessionId, "compact");
      }
    }
  }

  return {
    session_id: sessionId,
    fields,
    observation: await observe(sessionId, "compact"),
  };
}

function compactV2SelectionFailureReason(error: unknown): string {
  return compactV2ActionFailureReason(error, "select");
}

function compactV2ActionFailureReason(error: unknown, kind: ProvisionAction["kind"]): string {
  if (error instanceof CompactV2ActionFailureError) return error.message;
  if (error instanceof Error && (error as Error & { code?: unknown }).code === "google_session") {
    return error.message;
  }
  if (error instanceof TargetStaleError || error instanceof CompactV2ReobserveRequiredError) {
    return "reobserve_required";
  }
  if (error instanceof ProvisionTargetNotAllowedError) {
    return "target_not_allowed";
  }
  return kind === "select" ? "selection_failed" : "action_failed";
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

function compactV2AuditUrl(rawUrl: string): string {
  return safeOriginV2(rawUrl) ?? "<sealed-origin>";
}

function compactV2AuditHost(rawHost: string): string {
  const origin = safeOriginV2(rawHost.includes("://") ? rawHost : `https://${rawHost}`);
  if (origin === null) return "<sealed-host>";
  return new URL(origin).host;
}

const COMPACT_V2_REPLAY_ROUTE_SEGMENTS = new Set([
  "account",
  "accounts",
  "api",
  "app",
  "apps",
  "auth",
  "basket",
  "billing",
  "callback",
  "cart",
  "checkout",
  "complete",
  "console",
  "create",
  "credential",
  "credentials",
  "dashboard",
  "developer",
  "developers",
  "key",
  "keys",
  "login",
  "new",
  "oauth",
  "payment",
  "profile",
  "project",
  "projects",
  "register",
  "security",
  "settings",
  "sign-in",
  "sign-up",
  "signin",
  "signup",
  "success",
  "token",
  "tokens",
  "verification",
  "verify",
  "workspace",
  "workspaces",
]);

function compactV2ReplaySafeUrl(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    if (safeOriginV2(parsed.origin) === null) return null;
    if (
      parsed.username.length > 0 ||
      parsed.password.length > 0 ||
      parsed.search.length > 0 ||
      parsed.hash.length > 0 ||
      isSingleUseUrl(rawUrl)
    ) {
      return null;
    }
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (
      segments.some(
        (segment) =>
          segment !== segment.toLowerCase() || !COMPACT_V2_REPLAY_ROUTE_SEGMENTS.has(segment),
      )
    ) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function compactV2RecordedAction(
  session: Session,
  action: ProvisionAction,
): ProvisionAction | null {
  if (session.compactV2Mode !== "on") return action;
  if (action.kind === "goto") {
    const url = compactV2ReplaySafeUrl(action.url);
    if (url !== null) return { ...action, url };
    rejectRecipeRecording(session, "compact_v2_unrepresentable_goto");
    return null;
  }
  if (action.kind === "allow_host") {
    const origin = safeOriginV2(`https://${action.host}`);
    if (origin !== null) return { ...action, host: new URL(origin).hostname };
    rejectRecipeRecording(session, "compact_v2_unrepresentable_host");
    return null;
  }
  if (action.kind === "type") {
    if (looksLikeEmailValue(action.text)) return { ...action, text: EMAIL_SLOT_TEMPLATE };
    rejectRecipeRecording(session, "compact_v2_unrepresentable_value_action");
    return null;
  }
  if (action.kind === "select") {
    const text = safeDescriptionV2(action.text);
    if (text !== undefined) return { ...action, text };
    rejectRecipeRecording(session, "compact_v2_unrepresentable_value_action");
    return null;
  }
  if (action.kind === "set_phone_country") {
    if (/^[a-z]{2}$/i.test(action.country)) {
      return { ...action, country: action.country.toUpperCase() };
    }
    rejectRecipeRecording(session, "compact_v2_unrepresentable_value_action");
    return null;
  }
  return action;
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
    throw new Error("operate_recipe_save refused: known email remains in serialized recipe data");
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
  const scopedInventory = inventory.filter(
    (candidate) =>
      (candidate.frameOrigin ?? null) === (el.frameOrigin ?? null) &&
      (candidate.framePath ?? null) === (el.framePath ?? null),
  );
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
  const siblings = scopedInventory.filter((candidate) => {
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
  const nearText = siblings.length > 0 ? pickRowDisambiguator(el, siblings, scopedInventory) : null;
  const domHint = pickStableDomHint(el);
  const hrefHint = pickHrefHint(el);
  const scrub = (value: string): string => scrubKnownEmail(value, userEmail);
  // Locale-stable role for money-path fill safety (autocomplete > data-role >
  // distinguishing input type). Never label text — labels flip under i18n.
  const fieldRole = localeStableFieldRole(el);
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
    ...(el.selector.length > 0 && !el.selector.startsWith("@c:")
      ? { css: scrub(el.selector) }
      : {}),
    ...(el.visibleText !== null && el.visibleText.length > 0
      ? { visible_text: scrub(el.visibleText) }
      : {}),
    ...(fieldRole !== null ? { field_role: fieldRole } : {}),
    ...(el.frameOrigin !== undefined && el.frameOrigin !== null
      ? { frame_origin: el.frameOrigin }
      : {}),
    ...(el.framePath !== undefined && el.framePath !== null ? { frame_path: el.framePath } : {}),
  };
}

function recordTrace(
  session: Session,
  action: ProvisionAction,
  el: InteractiveElement | null,
  sensitiveSource?: RecordedValueSource,
): void {
  const recordedAction = compactV2RecordedAction(session, action);
  if (recordedAction === null) return;
  action = recordedAction;
  // Never freeze a single-use link (email-verify / magic / reset token) into
  // the recipe — it's dead on the next replay. The host agent re-plans the
  // verification step live (operate_act { kind: "await_verification" } fetches a FRESH link)
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
    case "oauth_login":
      session.actionTrace.push({ action: { kind: "oauth_click", ...withText, ...withTarget } });
      session.actionTrace.push({ action: { kind: "oauth_settle" } });
      return;
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
  const frameScope =
    el?.frameOrigin !== undefined &&
    el.frameOrigin !== null &&
    el.framePath !== undefined &&
    el.framePath !== null
      ? { frame_origin: el.frameOrigin, frame_path: el.framePath }
      : {};
  switch (action.kind) {
    case "click":
    case "js_click":
    case "oauth_click":
    case "oauth_login":
      return el === null
        ? null
        : {
            kind: "click",
            selector: el.selector,
            reason: traceTextFor(el) ?? action.kind,
            ...frameScope,
          };
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
            ...frameScope,
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
  const recordedAction = compactV2RecordedAction(session, action);
  if (recordedAction === null) return;
  const observed = captureObserved(recordedAction, el);
  if (observed === null) return;
  const stateUrl =
    session.compactV2Mode === "on" ? compactV2ReplaySafeUrl(urlAtObservation) : urlAtObservation;
  if (stateUrl === null) {
    rejectRecipeRecording(session, "compact_v2_unrepresentable_page_url");
    return;
  }
  session.captureRounds.push({
    service: captureService(session),
    round: session.captureRounds.length,
    oauth: recordedAction.kind === "oauth_click" || recordedAction.kind === "oauth_login",
    // The URL the inventory + action belong to (pre-action), NOT the post-
    // navigation URL — see urlBeforeAction in act().
    state: {
      url: stateUrl,
      title: "",
      html: "",
      screenshot: "",
    },
    inventory: session.lastElements,
    observed,
  });
}

// The EXTRACT round is the one round that keeps raw html — the key-extraction
// step is synthesized from the page where the credential is shown.
async function recordExtractRound(session: Session): Promise<boolean> {
  let html = "";
  if (session.compactV2Mode !== "on") {
    try {
      html = (await session.browser.getState()).html;
    } catch {
      /* best-effort — the copy-button/inventory extract path still works */
    }
  }
  const stateUrl =
    session.compactV2Mode === "on"
      ? compactV2ReplaySafeUrl(session.browser.currentUrl())
      : session.browser.currentUrl();
  if (stateUrl === null) {
    rejectRecipeRecording(session, "compact_v2_unrepresentable_page_url");
    return false;
  }
  session.captureRounds.push({
    service: captureService(session),
    round: session.captureRounds.length,
    oauth: false,
    state: {
      url: stateUrl,
      title: "",
      html,
      screenshot: "",
    },
    inventory: session.lastElements,
    observed: { kind: "extract", reason: "extract the credential shown on the page" },
  });
  return true;
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
  // A run that used the text=/css= locator action fallback hit a control with no
  // inventory ref; the synthesizer can't represent that step, so promoting would
  // ship a skill missing an action. Skip rather than emit a silently-broken skill.
  if (session.usedLocatorFallback) {
    return { kind: "skipped", reason: "locator_fallback_unrepresentable" };
  }
  if (session.recipeRejectionReason !== null) {
    return { kind: "skipped", reason: session.recipeRejectionReason };
  }
  const dir = resolveCaptureDir();
  if (dir === null) return { kind: "skipped", reason: "capture_disabled" };
  if (!session.captureRounds.some((r) => r.observed.kind === "extract")) {
    await recordExtractRound(session);
  }
  if (session.recipeRejectionReason !== null) {
    return { kind: "skipped", reason: session.recipeRejectionReason };
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
  const emitted =
    session.compactV2Mode === "on"
      ? { ...m, service: compactV2AuditValue("service", m.service) }
      : m;
  process.stderr.write(`${JSON.stringify({ marker: "provision-measurement", ...emitted })}\n`);
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
      throw new Error(`provenance ${source.hole} has no authoritative operate_recipe_save input`);
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
    /**
     * Opt into the already-supported runtime entry form when the caller has a
     * fresh same-domain service URL for each replay.  The stored key/domain
     * and all action/value provenance stay unchanged; recipeEntryUrl still
     * rejects a cross-domain runtime URL.
     */
    entry_mode?: "runtime_service_url";
  },
): Promise<{
  file: string;
  name: string;
  steps: number;
  secrets: string[];
  verified: PostconditionResult;
  // replay-per-leg-signature — present only when this session's trace has a
  // money field (a checkout-shaped leg exists to extract). A SECOND recipe,
  // scoped to just that leg and keyed by the live checkout page's own
  // field-name-set signature instead of domain — so it can be published and
  // replayed on a completely different, unrelated store's checkout leg.
  checkout_leg_file?: string;
}> {
  const session = sessionForCall(sessionId);
  if (session === undefined) throw new Error(`unknown provision session ${sessionId}`);
  if (session.usedLocatorFallback) {
    throw new Error(
      "operate_recipe_save refused: this session used a text=/css= locator fallback that operator recipes cannot represent",
    );
  }
  if (session.recipeRejectionReason !== null) {
    throw new Error(`operate_recipe_save refused: ${session.recipeRejectionReason}`);
  }
  if (opts.inputs === undefined) {
    throw new Error("operate_recipe_save refused: complete provenance inputs are required");
  }
  // Record only through the existing machine-checkable success gate. Previously
  // operate_recipe_save wrote first and operate_finish verified later, leaving
  // an unverified recipe on disk when the postcondition failed.
  const verified = await verifyPostcondition(sessionId, opts.postcondition);
  if (!verified.confirmed) {
    throw new Error(
      `operate_recipe_save refused: postcondition not confirmed (${verified.reason})`,
    );
  }
  const secrets = [...session.secretSlots.keys()].map((slot) => ({ slot, stored: false as const }));
  const scrubbedStartUrl = scrubKnownEmail(session.startUrl, session.userEmail);
  const trace = traceWithVerifiedProvenance(session, opts.inputs);
  const postcondition = scrubRecipePostcondition(session, opts.postcondition, opts.inputs);
  if (opts.entry_mode !== undefined && opts.verb === undefined) {
    throw new Error("runtime recipe entry requires a keyed verb");
  }
  const verb = opts.verb !== undefined ? canonicalVerb(opts.verb) : undefined;
  const actionPath = verb !== undefined ? extractActionPath(session.startUrl) : "";
  const recipe: OperatorRecipe = {
    name: opts.name,
    schema_version: 1,
    goal: opts.goal,
    ...(verb !== undefined
      ? {
          verb,
          domain: operatorRecipeDomain(session.startUrl),
          ...(actionPath.length > 0 ? { action_path: actionPath } : {}),
        }
      : {}),
    // Canonical, stable replay entry — the page the session started at, never a
    // mid-flow single-use link inferred from the trace.
    ...(opts.entry_mode === "runtime_service_url" ||
    isSingleUseUrl(session.startUrl) ||
    scrubbedStartUrl !== session.startUrl
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
      `operate_recipe_save refused: money field lacks provenance (${unprovenancedMoneyField})`,
    );
  }
  const file = await writeRecipe(recipe);
  // No-regression guarantee (recipe-key-redesign): a recording that lands at
  // the specific (verb, domain, action_path) file must also keep the
  // crude-but-reliable degenerate (verb, domain) catch-all alive, so a later
  // replay on an unrecognized path doesn't go cold where today it hits.
  if (actionPath.length > 0) {
    await refreshDegenerateCatchAll(recipe);
  }
  audit(sessionId, "remember_recipe", {
    name: opts.name,
    steps: recipe.trace.length,
    secrets: secrets.length,
    file,
  });
  const checkoutLegFile = await rememberCheckoutLeg(session, verb, trace).catch(() => null);
  return {
    file,
    name: opts.name,
    steps: recipe.trace.length,
    secrets: secrets.map((s) => s.slot),
    verified,
    ...(checkoutLegFile !== null ? { checkout_leg_file: checkoutLegFile } : {}),
  };
}

// recipe-key-redesign — no-regression guarantee: on every recording that
// lands at a specific (verb, domain, action_path) file, also refresh the
// degenerate (verb, domain) catch-all whenever that slot is absent or
// itself empty-path (i.e. it's already the crude catch-all, not some other
// specific recording). Without this, a future recording that extracts a
// path would quietly stop refreshing the catch-all a later unrecognized-path
// replay still relies on.
async function refreshDegenerateCatchAll(recipe: OperatorRecipe): Promise<void> {
  if (recipe.verb === undefined || recipe.domain === undefined) return;
  let shouldRefresh: boolean;
  try {
    const existing = await readRecipe(operatorRecipeKeyForDomain(recipe.verb, recipe.domain));
    shouldRefresh = existing.action_path === undefined || existing.action_path.length === 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    shouldRefresh = true;
  }
  if (!shouldRefresh) return;
  const degenerateRecipe: OperatorRecipe = { ...recipe, action_path: undefined };
  await writeRecipe(degenerateRecipe);
}

// recipe-key-redesign — replaces the deleted MONEY_REPLAY_VERBS for the two
// SAVE-TIME classifiers below (checkout-leg carving, unprovenanced-money-
// field refusal). Distinct from the money REPLAY gate (which is now a pure
// trace-content check, unconditional on verb) — these two are scope filters
// unrelated to the payment fence, so they keep the verb-set shape MONEY_
// REPLAY_VERBS had, just canonicalized (post-merge, 7 legacy verbs collapse
// to 4 canonical ones).
const MONEY_SHAPED_VERBS = new Set<OperatorVerb>(["purchase", "subscribe", "checkout", "book"]);

// replay-per-leg-signature — split off and save the checkout portion of a
// just-recorded money-path trace as its OWN recipe, keyed by the checkout
// page's live field-name-set signature instead of domain. Best-effort and
// silent on any reason it can't produce one (non-money verb, no money field
// captured, empty live field set) — the whole-task recipe above is already
// saved and stands on its own either way; this only ever ADDS a second,
// narrower, cross-domain-reusable recipe alongside it.
async function rememberCheckoutLeg(
  session: Session,
  verb: OperatorVerb | undefined,
  trace: readonly TraceEntry[],
): Promise<string | null> {
  if (verb === undefined || !MONEY_SHAPED_VERBS.has(verb)) return null;
  const legStart = checkoutLegStartIndex(trace);
  if (legStart === null) return null;
  const legTrace = trace.slice(legStart);
  const fieldNames = await session.browser.extractCheckoutFieldNames();
  const signature = checkoutFieldSetSignature(fieldNames);
  if (signature === null) return null;
  const legSlots = new Set(
    legTrace
      .filter((entry) => entry.action.kind === "type_secret")
      .map((entry) => entry.action.slot)
      .filter((slot): slot is string => slot !== undefined),
  );
  const checkoutRecipe: OperatorRecipe = {
    name: `checkout-leg--${signature.slice(0, 12)}`,
    schema_version: 1,
    goal: "Fill the checkout leg's fields",
    verb,
    domain: checkoutShapeKey(signature),
    allowed_hosts: [],
    trace: legTrace,
    secrets: [...legSlots].map((slot) => ({ slot, stored: false as const })),
    postcondition: checkoutLegPostcondition(legTrace),
  };
  return await writeRecipe(checkoutRecipe);
}

// Read a single page snapshot for postcondition checking. Field VALUES are
// reduced to lengths here so a token/secret success-signal can't leak.
async function snapshotForPostcondition(session: Session): Promise<PostconditionSnapshot> {
  const privateFields =
    session.compactV2Mode === "on"
      ? (await session.browser.extractInteractiveElements())
          .filter((element) => typeof element.value === "string" && element.value.length > 0)
          .map((element) => {
            const sealed = sealRetainedInteractiveElementsV2([element])[0]!;
            const description = safeDescriptionV2(
              sealed.labelText ??
                sealed.ariaLabel ??
                sealed.placeholder ??
                sealed.title ??
                sealed.name ??
                sealed.id,
            );
            const fieldRole = localeStableFieldRole(sealed);
            return {
              label: [description, fieldRole]
                .filter((value): value is string => value !== undefined && value !== null)
                .join(" "),
              value_len: element.value!.length,
            };
          })
          .filter((field) => field.label.length > 0)
      : null;
  const obs = await observeSession(session);
  const fields =
    privateFields ??
    session.lastElements
      .filter((element) => typeof element.value === "string" && element.value.length > 0)
      .map((element) => ({
        label: elementRef(element),
        value_len: element.value!.length,
      }));
  return {
    url: obs.format === "compact-v2" ? session.browser.currentUrl() : obs.url,
    text:
      obs.format === "compact-v2"
        ? await session.browser.extractVisibleText()
        : (session.prevObserve?.text ?? obs.text),
    fields,
  };
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
    invalidateCompactV2Snapshot(session);
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

// replay-per-leg-signature — the checkout leg's registry/local-store key,
// computed from the CURRENT live page. Callers use this to resolve (and,
// on a hit, replay via replayOperatorRecipe) a checkout-leg recipe
// independently of whatever (or whether any) whole-task recipe applies to
// this session's domain — the mechanism that lets a checkout plan recorded
// on one store resolve on a different, unrelated store of the same
// checkout platform. Returns null when the live page has no field-name-set
// to key by (nothing to resolve yet).
export async function checkoutShapeSignatureForSession(sessionId: string): Promise<string | null> {
  const session = sessionForCall(sessionId);
  if (session === undefined) throw new Error(`unknown provision session ${sessionId}`);
  const fieldNames = await session.browser.extractCheckoutFieldNames();
  return checkoutFieldSetSignature(fieldNames);
}

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
    }
  | {
      // replay-per-leg-signature — a replay field failure that occurred
      // AFTER a genuine catalog/storefront prefix (legStartIndex > 0): the
      // catalog/storefront leg already replayed fine, only the checkout leg
      // needs cold driving. Distinct from human_required, which stays the
      // terminal "stop, nothing narrower to fall back to" response for a
      // single-leg (or leg-less) recipe. It is not resumable via resume_from,
      // and recipe recording remains refused because recipeRejectionReason is
      // set. The host may drive the checkout leg cold from from_step_index;
      // any charge still goes through a fresh, human-approved operate_pay.
      status: "leg_fallback_required";
      observation: Observation;
      leg: "checkout";
      from_step_index: number;
      reason: string;
    }
  | {
      // replay-serve-live-domainlock — a goto/allow_host step's resolved
      // target does not resolve to the recipe's own eTLD+1. Distinct from
      // fallback_required: this is
      // NEVER resumable — the host must abandon this recipe's replay and
      // drive the remainder cold. Prevents a tampered/malicious shared recipe
      // from steering the browser to an attacker origin.
      status: "domain_lock_violation";
      observation: Observation;
      step_index: number;
      host: string;
      recipe_domain: string;
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

// 3.1 must only engage for a form/recipe field where a committed value is
// actually required (a checkout form field, or one the host tagged with a
// recipe hole) — not arbitrary typing. The popup-shape detection
// (role=listbox/menu/dialog, etc.) also matches an incidental suggestion
// popup on an ordinary site-search/catalog-search box; without this scope,
// typing a search query either auto-clicks a suggestion (navigating as a
// side effect of "type") or throws, with no way to keep free text. Reuses
// the existing MONEY_FIELD_TARGET shape check (moneyFieldName's sibling,
// just read off the live element instead of a recorded TraceAction) rather
// than inventing a new heuristic.
function isAutocompleteScopedTypeField(
  provenance: { hole: string } | undefined,
  el: InteractiveElement,
): boolean {
  if (provenance !== undefined) return true;
  const label = [el.testId, el.id, el.name, el.ariaLabel, el.labelText, el.placeholder]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ")
    .replace(/([a-z])([A-Z])/g, "$1 $2");
  return MONEY_FIELD_TARGET.test(label);
}

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

// replay-per-leg-signature — the checkout leg is whatever portion of a
// money-path trace touches money fields (address/contact/card-adjacent —
// the exact same classifier moneyFieldName already uses for the fill
// guard). Reusing it here means the leg boundary needs no new heuristic
// (no URL/path pattern-matching, no platform name): the first step the
// existing guard already treats as a money field IS where checkout starts.
// Returns null when the trace has no money field at all (verb classified
// money-path but nothing was actually captured, or a non-money recipe).
function checkoutLegStartIndex(trace: readonly TraceEntry[]): number | null {
  const index = trace.findIndex((entry) => moneyFieldName(entry.action) !== null);
  return index === -1 ? null : index;
}

// A checkout-leg-only recipe still needs a postcondition (the schema
// requires one), but it isn't the whole task's "order placed" signal — it
// only covers the leg it replays. Anchor it to the LAST money field in the
// leg holding a non-empty value, mirroring the field_text/min_value_len
// pattern already used elsewhere (e.g. the OAuth Playground token check):
// checks a length, never a value, so it can't leak what it proves.
// legTrace is guaranteed non-empty and to start on a money field by
// construction (checkoutLegStartIndex found it), so a label always exists.
function checkoutLegPostcondition(legTrace: readonly TraceEntry[]): Postcondition {
  const lastLabel = [...legTrace]
    .reverse()
    .map((entry) => moneyFieldName(entry.action))
    .find((label): label is string => label !== null)!;
  return {
    kind: "execute_capability",
    describe: "checkout leg fields filled and re-verified",
    success_signal: { field_text: lastLabel, min_value_len: 1 },
  };
}

function findUnprovenancedMoneyField(recipe: OperatorRecipe): string | null {
  if (recipe.verb === undefined || !MONEY_SHAPED_VERBS.has(recipe.verb)) return null;
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
  session.replayState.failure = { reason, field };
  audit(session.id, "replay_field_value_guard", { ok: false, reason, field });
}

// replay-serve-live-domainlock — checks a replay-bound goto/allow_host
// target against the recipe's own eTLD+1. Unlike the ordinary session goto
// gate, recipe replay has no auth-host exceptions. Checkout-shape recipes
// cannot execute goto/allow_host actions because they have no site domain.
function replayTargetWithinRecipeDomain(url: string, recipeDomain: string): boolean {
  return isSameRecipeDomain(url, recipeDomain);
}

function markReplayDomainLockViolation(session: Session, host: string, recipeDomain: string): void {
  rejectRecipeRecording(session, "replay_domain_lock_violation");
  audit(session.id, "replay_domain_lock_violation", { host, recipe_domain: recipeDomain });
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
      clearCommittedSelectValue(session, resolution.element.selector);
    }
    return { ok: true };
  }
  if (
    allowCommittedSelect &&
    expected.kind === "select" &&
    session.committedSelectValues.get(
      compactV2CommittedSelectKey(session, resolution.element.selector),
    ) === compactV2CommittedSelectValue(session, expected.expected)
  ) {
    clearCommittedSelectValue(session, resolution.element.selector);
    return { ok: true };
  }
  if (expected.kind === "select") {
    clearCommittedSelectValue(session, resolution.element.selector);
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
  retainSessionElements(session, fresh);
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
  retainSessionElements(session, fresh);
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
  retainSessionElements(session, fresh);
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
  options: {
    beforeStep?: (input: { step_index: number; action: TraceAction }) => Promise<void> | void;
    beforeAction?: (input: { step_index: number; action: ProvisionAction }) => Promise<void> | void;
  } = {},
): Promise<OperatorReplayResult> {
  const session = sessions.get(sessionId);
  if (session === undefined) throw new Error(`unknown provision session ${sessionId}`);
  const recipeHash = replayDigest(recipe);
  const bindingsHash = bindingDigest(bindings);
  const boundPostcondition = bindRecipePostcondition(recipe.postcondition, bindings);
  if (recipe.verb === undefined || recipe.domain === undefined) {
    throw new Error("legacy named recipes are hint-only and cannot replay deterministically");
  }
  // recipe-key-redesign money rule: the only surviving invariant is that a
  // card-charging step is never blind-replayed — enforced unconditionally
  // below where recorded.kind === "operate_pay" always forces a fallback to
  // the fresh, human-approved operate_pay path. isMoneyPath here only feeds
  // the leg-fallback narrowing (where to resume cold-driving), not a
  // software field-verification gate.
  const isMoneyPath = recipe.trace.some((entry) => entry.action.kind === "operate_pay");
  let state: ReplayState;

  const humanRequired = async (
    reason: "field_missing" | "field_value_mismatch",
    field: string,
  ): Promise<OperatorReplayResult> => {
    // replay-per-leg-signature — a genuine catalog/storefront prefix exists
    // ahead of the checkout leg (legStartIndex > 0): degrade to a leg-scoped
    // fallback instead of aborting the whole replay. A recipe with no such
    // prefix (legStartIndex is 0 or null — a simple/single-leg money-path
    // recipe) has nothing narrower to fall back to, so it keeps today's
    // behavior exactly: hard-stop at human_required.
    if (state.moneyPath && state.legStartIndex !== null && state.legStartIndex > 0) {
      const fromStepIndex = state.legStartIndex;
      // Deliberately does NOT null out session.replayState — a resumed
      // fallback should not silently reopen a failed replay.
      // nextIndex is left unset (not stepIndex+1), so a resume_from
      // attempt still hits "invalid replay continuation" below — this is
      // not a resumable fallback the way fallback_required is.
      markReplayFailure(session, reason, field);
      audit(sessionId, "replay_leg_fallback", { reason, field, from_step_index: fromStepIndex });
      return {
        status: "leg_fallback_required",
        observation: await observe(sessionId),
        leg: "checkout",
        from_step_index: fromStepIndex,
        reason: `${reason}: ${field}`,
      };
    }
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
      legStartIndex: isMoneyPath ? checkoutLegStartIndex(recipe.trace) : null,
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
    return {
      status: "fallback_required",
      observation: await observe(sessionId),
      step_index: stepIndex,
      next_index: stepIndex + 1,
      step,
      reason,
    };
  };

  const recipeDomain = recipe.domain;
  const domainLockViolation = async (
    stepIndex: number,
    host: string,
  ): Promise<OperatorReplayResult> => {
    markReplayDomainLockViolation(session, host, recipeDomain);
    const publicHost = session.compactV2Active ? compactV2AuditHost(host) : host;
    const publicRecipeDomain = session.compactV2Active
      ? compactV2AuditHost(recipeDomain)
      : recipeDomain;
    return {
      status: "domain_lock_violation",
      observation: await observe(sessionId),
      step_index: stepIndex,
      host: publicHost,
      recipe_domain: publicRecipeDomain,
    };
  };

  for (let i = fromIndex; i < recipe.trace.length; i += 1) {
    const step = recipe.trace[i] as TraceEntry;
    const recorded = step.action;
    await options.beforeStep?.({ step_index: i, action: recorded });
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
      // This lock covers explicit goto/allow_host steps only. Organic redirects
      // and OAuth popups remain governed by the existing session navigation model.
      if (isCheckoutShapeKey(recipeDomain)) {
        return await domainLockViolation(i, recorded.url_template ?? "<goto>");
      }
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
      if (!replayTargetWithinRecipeDomain(filled.url, recipeDomain)) {
        let host: string;
        try {
          host = new URL(filled.url).hostname;
        } catch {
          host = filled.url;
        }
        return await domainLockViolation(i, host);
      }
      action = { kind: "goto", url: filled.url };
    } else if (recorded.kind === "allow_host") {
      if (isCheckoutShapeKey(recipeDomain)) {
        return await domainLockViolation(i, recorded.host ?? "<allow_host>");
      }
      if (recorded.host === undefined) {
        return await fallback(step, i, "allow_host step has no host");
      }
      if (!replayTargetWithinRecipeDomain(`https://${recorded.host}`, recipeDomain)) {
        return await domainLockViolation(i, recorded.host);
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
      retainSessionElements(session, fresh);
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
        const recipeProvider = (recipe as { oauth_provider?: unknown }).oauth_provider;
        action = {
          kind: "oauth_click",
          target: ref,
          ...(recipeProvider === "google" || recipeProvider === "github"
            ? { provider: recipeProvider }
            : {}),
        };
      }
    }

    try {
      await options.beforeAction?.({ step_index: i, action });
      await actInternally(sessionId, action, "none");
      replayed += 1;
      const expected = state.expectedFields.get(i);
      if (expected !== undefined) {
        const guard = await verifyReplayField(session, expected, expected.kind === "select");
        if (!guard.ok) return await humanRequired(guard.reason, expected.hole);
        state.verifiedFields.add(i);
      }
    } catch (error) {
      if (error instanceof ManualCardEntryBlockedError) throw error;
      return await fallback(
        step,
        i,
        session.compactV2Active
          ? compactV2ActionFailureReason(error, action.kind)
          : error instanceof Error
            ? error.message
            : String(error),
      );
    }
  }

  return {
    status: "complete",
    observation: await observe(sessionId),
    replayed_steps: replayed,
    field_values_verified: true,
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
  invalidateCompactV2Snapshot(session);

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
  invalidateCompactV2Snapshot(session);
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
              "Retry operate_start with its proxy argument set to a residential proxy, or " +
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

export function parseVerification(
  text: string,
  links: readonly string[],
): { code: string | null; link: string | null } {
  const link = pickVerificationLink([...links]);
  let code = findOtpCredential(text);
  if (code === null) {
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
      'arrived (they commonly take 10–30s) — call operate_act { kind: "await_verification" } AGAIN ' +
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
      'this signup? If YES, retry operate_act { kind: "await_verification" } with ' +
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

  invalidateCompactV2Snapshot(session);

  const verification = await runDetachedGoogleIdentityOperation(session, async (browser) => {
    return await browser.withTemporaryHostScopeAllowedHosts(["mail.google.com"], async () => {
      const query = buildVerificationSearchQuery(opts.sender);
      const searchUrl = `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(query)}`;
      const hrefsOf = (els: readonly { href?: string | null }[]): string[] =>
        els.map((e) => e.href).filter((h): h is string => typeof h === "string" && h.length > 0);
      let code: string | null = null;
      let link: string | null = null;
      let sourceFrom: string | null = null;
      for (let attempt = 0; attempt < 3 && code === null && link === null; attempt++) {
        sourceFrom = null;
        if (attempt > 0) await browser.waitForCaptchaChallengeToSettle(4000, 0).catch(() => false);
        await browser.goto(searchUrl);
        let listText = "";
        for (let i = 0; i < 6; i++) {
          listText = await browser.extractVisibleText();
          if (listText.length > 200) break;
          await browser.waitForCaptchaChallengeToSettle(1200, 0).catch(() => false);
        }
        const listLinks = hrefsOf(await browser.extractInteractiveElements());
        const opened = await browser.openFirstMailResult().catch(() => false);
        if (opened) {
          const openedText = await browser.extractVisibleText();
          const openedLinks = hrefsOf(await browser.extractInteractiveElements());
          sourceFrom = extractSenderEmail(openedText);
          ({ code, link } = parseVerification(openedText, [...openedLinks, ...listLinks]));
        } else {
          ({ code, link } = parseVerification(listText, listLinks));
        }
      }
      return { code, link, sourceFrom };
    });
  });
  const { code, link, sourceFrom } = verification;
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

export interface PreparedFinishResult<T> {
  finish: FinishResult;
  prepared: T;
}

function profileRequiresDestroy(session: Session): boolean {
  return (
    session.activePayment !== null ||
    session.paymentFieldSealActive ||
    session.pendingThreeDs !== null
  );
}

const OBSERVE_SNAPSHOT_CLEANUP_RETRY_MS = 250;
const OBSERVE_SNAPSHOT_SHUTDOWN_DRAIN_MS = 500;
const pendingObserveSnapshotCleanup = new Set<string>();
let observeSnapshotCleanupTimer: ReturnType<typeof setTimeout> | null = null;

function observeSnapshotPathState(path: string): "present" | "missing" | "unknown" {
  try {
    lstatSync(path);
    return "present";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unknown";
  }
}

function scheduleObserveSnapshotCleanup(): void {
  if (observeSnapshotCleanupTimer !== null || pendingObserveSnapshotCleanup.size === 0) return;
  observeSnapshotCleanupTimer = setTimeout(() => {
    observeSnapshotCleanupTimer = null;
    retryPendingObserveSnapshotCleanup();
    scheduleObserveSnapshotCleanup();
  }, OBSERVE_SNAPSHOT_CLEANUP_RETRY_MS);
  observeSnapshotCleanupTimer.unref();
}

function retryPendingObserveSnapshotCleanup(): void {
  for (const path of pendingObserveSnapshotCleanup) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {}
    if (observeSnapshotPathState(path) === "missing") {
      pendingObserveSnapshotCleanup.delete(path);
    }
  }
}

async function drainPendingObserveSnapshotCleanup(): Promise<void> {
  if (observeSnapshotCleanupTimer !== null) {
    clearTimeout(observeSnapshotCleanupTimer);
    observeSnapshotCleanupTimer = null;
  }
  const deadline = Date.now() + OBSERVE_SNAPSHOT_SHUTDOWN_DRAIN_MS;
  do {
    retryPendingObserveSnapshotCleanup();
    if (pendingObserveSnapshotCleanup.size === 0) return;
    await new Promise<void>((resolveWait) => {
      setTimeout(resolveWait, Math.min(25, Math.max(1, deadline - Date.now())));
    });
  } while (Date.now() < deadline);
  retryPendingObserveSnapshotCleanup();
  scheduleObserveSnapshotCleanup();
}

function removeObserveSnapshotDirectory(path: string): unknown | undefined {
  let failure: unknown;
  try {
    rmSync(path, { recursive: true, force: true });
  } catch (error) {
    failure = error;
  }
  if (observeSnapshotPathState(path) === "missing") {
    pendingObserveSnapshotCleanup.delete(path);
  } else {
    pendingObserveSnapshotCleanup.add(path);
    scheduleObserveSnapshotCleanup();
  }
  return failure;
}

function clearSessionArtifacts(session: Session): void {
  session.prevObserve = null;
  session.observeSnapshotFile = null;
  session.secretSlots.clear();
  session.sealedFieldKeys.clear();
  const error = removeObserveSnapshotDirectory(observeSnapshotDir(session.id));
  if (error !== undefined) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[operator] session artifact cleanup failed session=${session.id}: ${message}\n`,
    );
  }
}

function deregisterProvisionSession(session: Session): void {
  clearSessionArtifacts(session);
  if (sessions.get(session.id) === session) sessions.delete(session.id);
}

function pendingThreeDsAuditStatus(
  resolution: ThreeDsResolution,
  pending: PendingThreeDsWait,
): string {
  if (resolution === "succeeded") return "payment_submitted";
  if (resolution === "failed") return "payment_declined";
  if (resolution === "challenge_pending") pending.outcome = "three_ds";
  return pending.outcome === "three_ds" ? "payment_3ds_unresolved" : "payment_outcome_unknown";
}

async function auditPendingThreeDsForSessionClose(session: Session): Promise<void> {
  const pending = session.pendingThreeDs;
  if (pending === null) return;
  if (session.api === undefined) {
    throw new Error(
      "operate_finish refused: pending 3-D Secure outcome cannot be audited without an active API session",
    );
  }
  const resolution = await session.browser.waitForThreeDsResolution(0);
  const recordAudit = async (): Promise<void> => {
    await session.api!.auditPayment({
      ...pending.checkout,
      last4: pending.last4,
      status: pendingThreeDsAuditStatus(resolution, pending),
      approval_id: pending.approval_id,
      ...(pending.mandate_id !== undefined ? { mandate_id: pending.mandate_id } : {}),
    });
  };
  const handoff = session.paymentDispatchHandoff;
  if (handoff?.state === pending) {
    handoff.auditPromise ??= recordAudit();
    await handoff.auditPromise;
    return;
  }
  await recordAudit();
}

async function auditPendingThreeDsForSessionCloseBounded(session: Session): Promise<void> {
  const timeoutMs = positiveTimeout(
    "TRUSTY_SQUIRE_OPERATOR_PENDING_3DS_FINALIZE_TIMEOUT_MS",
    DEFAULT_PENDING_THREE_DS_FINALIZE_TIMEOUT_MS,
  );
  await withTerminalTimeout(
    auditPendingThreeDsForSessionClose(session),
    timeoutMs,
    `pending 3-D Secure finalization exceeded ${timeoutMs}ms`,
  );
}

async function closeFinishingProvisionSession(
  session: Session,
  persistState: boolean,
): Promise<FinishResult> {
  const sessionId = session.id;
  await auditPendingThreeDsForSessionCloseBounded(session);
  const url = session.browser.currentUrl();
  audit(sessionId, "finish", { url });
  session.activePayment = null;
  session.paymentFieldSealActive = false;
  session.pendingThreeDs = null;
  stopSessionWatchdog(session);
  await releaseWarmBrowserPage(
    session.browser,
    persistState,
    session.terminalTeardownOwner ?? undefined,
  );
  deregisterProvisionSession(session);
  disposeSessionWatchdog(session);
  return { session_id: sessionId, url, closed: true };
}

export async function finishProvisionSessionWithPreparation<T>(
  sessionId: string,
  prepare: () => Promise<T>,
  successfulOutcome: () => boolean = () => false,
): Promise<PreparedFinishResult<T>> {
  const session = sessionForCall(sessionId);
  if (session === undefined) throw new Error(`unknown provision session ${sessionId}`);
  if (session.closing) throw new Error(`provision session ${sessionId} is already closing`);
  const owner: SessionTerminalTeardownOwner = {
    forced: false,
    forcePromise: null,
    routinePromise: null,
    requireProvenBrowserClose: false,
  };
  session.terminalTeardownOwner = owner;
  session.closing = true;
  stopSessionWatchdog(session);
  const transition = (async (): Promise<PreparedFinishResult<T>> => {
    await waitForSessionCallsToDrain(session);
    const prepared = await prepare();
    if (owner.forced || sessions.get(sessionId) !== session) {
      throw new Error(`provision session ${sessionId} terminal transition was forced`);
    }
    const persistState = successfulOutcome() && !profileRequiresDestroy(session);
    try {
      const finish = await closeFinishingProvisionSession(session, persistState);
      return { finish, prepared };
    } catch (error) {
      await forceTerminateProvisionSession(
        session,
        "finish_forced_terminate",
        { reason: "terminal_close_failed" },
        false,
      );
      throw error;
    }
  })();
  try {
    return await transition;
  } catch (error) {
    if (!owner.forced && sessions.get(sessionId) === session) {
      session.closing = false;
      session.terminalTeardownOwner = null;
      startSessionWatchdog(session);
    }
    throw error;
  }
}

export async function finishProvisionSession(sessionId: string): Promise<FinishResult> {
  if (refusedStartSessionIds.delete(sessionId)) {
    return { session_id: sessionId, url: "", closed: true };
  }
  return (await finishProvisionSessionWithPreparation(sessionId, async () => undefined)).finish;
}

// Test/teardown helper — close every live session (used by the dev shim on exit).
export async function closeAllProvisionSessions(): Promise<void> {
  shutdownGeneration += 1;
  shutdownInProgress += 1;
  try {
    await (async () => {
      await Promise.all(
        [...startingBrowsers].map(async (pending) => {
          await cancelStartingBrowser(pending).catch(() => undefined);
        }),
      );
      const closingSessions = [...sessions.values()];
      for (const session of closingSessions) {
        session.closing = true;
        stopSessionWatchdog(session);
      }
      const closeErrors = await Promise.all(
        closingSessions.map(async (session) => {
          await waitForSessionCallsToDrain(session);
          return await forceTerminateProvisionSession(session, "shutdown_terminate", {
            reason: "transport_disconnect",
          });
        }),
      );
      await Promise.all(
        [...leasedBrowsers.values()].map(async (ephemeral) => {
          await forceReleaseWarmBrowserPage(ephemeral.controller).catch(() => undefined);
        }),
      );
      const closeError = closeErrors.find((error) => error !== undefined);
      if (closeError !== undefined) throw closeError;
    })();
  } finally {
    refusedStartSessionIds.clear();
    await drainPendingObserveSnapshotCleanup();
    shutdownInProgress -= 1;
  }
}

export function activeSessionCount(): number {
  return sessions.size;
}
