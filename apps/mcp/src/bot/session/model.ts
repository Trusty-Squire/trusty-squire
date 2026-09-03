// Phase 1 of the operator session-management restructure: the Session data
// model and the single factory that builds it.
//
// This module owns the SHAPE of a live operator session and nothing else. The
// registry, every mutation, and every operation over a Session stay in
// provision-session.ts, which re-exports `Session` (and the host-source types)
// so no caller import changes.
//
// The factory exists because operate_start and the harness start built the
// same ~60-field object twice, side by side, and a field added to one could
// silently miss the other. createSession is the one construction contract:
// empty Maps/Sets, null overlays, a fresh random 32-byte compact-v2 secret,
// `initializing: true`, and `api` ABSENT (never present-and-undefined) when
// the tool layer passed none.
import { randomBytes } from "node:crypto";
import type { Buffer } from "node:buffer";
import type { BrowserController, InteractiveElement } from "../browser.js";
import type {
  CartCheckoutObservation,
  PendingApprovalWait,
  PendingCardFill,
  PendingThreeDsWait,
  TerminalPaymentApprovalStatus,
} from "../pay-operator.js";
import type {
  SafeObservationBaselineV2,
  SafeObservationIndexV2,
} from "../compact-observation-v2.js";
import type { ApiClient } from "../../api-client.js";
import type { Postcondition, RecipeTarget, TraceEntry } from "../operator-recipe.js";
import type { OnboardingRoundCapture } from "../onboarding-capture.js";
import type { OperatorBrowserWatchdog } from "../operator-browser-watchdog.js";
// Type-only, so no runtime cycle exists: these three field types still live in
// the facade because they belong to regions later phases move (perception for
// ObserveDeltaState, actions for CartAddResult, the payment bridge for
// ActivePaymentLease). They follow this module when those phases land.
import type { ActivePaymentLease, CartAddResult, ObserveDeltaState } from "../provision-session.js";

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

export interface ReplayExpectedField {
  stepIndex: number;
  hole: string;
  expected: string;
  target: RecipeTarget | null;
  kind: "type" | "select" | "set_phone_country";
}

export interface ReplayState {
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

export interface RecordedValueSource {
  traceIndex: number;
  hole?: string;
  literal: string;
}

export interface CartAddRecord {
  productIdentity: string;
  optionsHash: string;
  idempotencyKey: string;
  phase: "reserved" | "click_started" | "complete";
  promise: Promise<CartAddResult> | null;
  result: CartAddResult | null;
}

export interface CartMutation {
  productIdentity: string | null;
  optionsHash: string | null;
  cartDelta: "+1" | "0" | "unknown";
  origin: string;
}

export interface CartIdentityContext {
  productIdentity: string;
  optionsHash: string;
  onActionReady?: () => void;
}

export interface SessionTerminalTeardownOwner {
  forced: boolean;
  forcePromise: Promise<unknown | undefined> | null;
  routinePromise: Promise<void> | null;
  requireProvenBrowserClose: boolean;
}

export interface PaymentDispatchHandoff {
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

/** Everything the two starts genuinely differ on. Everything else is fixed. */
export interface CreateSessionInput {
  id: string;
  browser: BrowserController;
  allowedHosts: AllowedHostEntry[];
  compactV2Mode: Session["compactV2Mode"];
  startUrl: string;
  hintServed: boolean;
  consentInboxRead: boolean;
  userEmail: string | null;
  api?: ApiClient;
}

/**
 * The single construction contract for a live operator session. Property
 * order, the two independent Date.now() reads, and the conditional `api` key
 * reproduce the initializers this replaced exactly — see
 * session-characterization.test.ts, which snapshots the result of both starts
 * field for field.
 */
export function createSession(input: CreateSessionInput): Session {
  return {
    id: input.id,
    browser: input.browser,
    allowedHosts: input.allowedHosts,
    generation: 0,
    secretSlots: new Map(),
    sealedFieldKeys: new Set(),
    lastElements: [],
    prevObserve: null,
    observeSnapshotFile: null,
    compactV2Secret: randomBytes(32),
    compactV2Mode: input.compactV2Mode,
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
    hintServed: input.hintServed,
    startUrl: input.startUrl,
    consentInboxRead: input.consentInboxRead,
    userEmail: input.userEmail,
    // ABSENT, not present-and-undefined, when the tool layer passed no client.
    ...(input.api !== undefined ? { api: input.api } : {}),
  };
}
