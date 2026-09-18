// Phase 1 of the operator session-management restructure: the Session data
// model and the single factory that builds it.
//
// This module owns the SHAPE of a live operator session plus the pure
// session-state helpers that only read and write a Session value: element
// retention and the sealed <select> bookkeeping. The registry and every
// operation that touches the browser or the page stay out — lifecycle.ts owns
// the registry transaction, registry.ts the host-scope state.
//
// The factory exists because operate_start and the harness start built the
// same ~60-field object twice, side by side, and a field added to one could
// silently miss the other. createSession is the one construction contract:
// empty Maps/Sets, null overlays, a fresh random 32-byte compact-v2 secret,
// `initializing: true`, and `api` ABSENT (never present-and-undefined) when
// the tool layer passed none.
import { createHmac, randomBytes } from "node:crypto";
import type { Buffer } from "node:buffer";
import type { BrowserController, CheckoutCard, InteractiveElement } from "../browser.js";
import type { PendingApprovalWait } from "../card-release-approval.js";
import {
  sealRetainedInteractiveElementsV2,
  type SafeObservationBaselineV2,
  type SafeObservationIndexV2,
} from "../compact-observation-v2.js";
import type { ApiClient } from "../../api-client.js";
import type { OperatorBrowserWatchdog } from "../operator-browser-watchdog.js";

// Credential-egress seed provenance: start is the service host, auto_widen
// is an observed same-base-domain redirect. mid_session is retained for legacy
// metadata and excluded from credential egress. None filters browser requests.
export type HostSource = "start" | "mid_session" | "auto_widen";

export interface AllowedHostEntry {
  host: string;
  source: HostSource;
}

export interface CartMutation {
  productIdentity: string | null;
  optionsHash: string | null;
  cartDelta: "+1" | "0" | "unknown";
  origin: string;
}

export interface SessionTerminalTeardownOwner {
  forced: boolean;
  forcePromise: Promise<unknown | undefined> | null;
  routinePromise: Promise<void> | null;
  requireProvenBrowserClose: boolean;
}

export interface Session {
  id: string;
  browser: BrowserController;
  allowedHosts: AllowedHostEntry[];
  generation: number;
  // Credential slots: secret values extracted in-session and held here so a
  // later type_secret can enter them into another site's form without the host
  // having to relay them. This is a transfer convenience, not a read seal —
  // observations show whatever the page renders, including a slotted value.
  secretSlots: Map<string, string>;
  // The last extracted elements, kept so resolveTarget can be unit-tested
  // against a snapshot, but act() always RE-extracts first (re-resolution).
  lastElements: InteractiveElement[];
  compactV2Secret: Buffer;
  compactV2HintPages: string[];
  /** True once this session has emitted V2; target resolution stays sealed until finish. */
  compactV2Active: boolean;
  compactV2Refs: Map<string, string>;
  compactV2Index: SafeObservationIndexV2 | null;
  // Safe enum-only prior map. Repeat observes diff this representation, never
  // raw DOM output, so every delta remains inside the allowlist
  // seal even when a page mutates confidential values or live regions.
  compactV2Previous: SafeObservationBaselineV2 | null;
  committedSelectValues: Map<string, string>;
  startedAt: number;
  // The session's START url (service_url at operate_start). Used as the
  // canonical entry_url metadata.
  startUrl: string;
  // PR2 — whether this session may read the inbox for email verification. From
  // the install-time consent flag; gates awaitVerification (fail-closed).
  consentInboxRead: boolean;
  // PR3 — the user's own email (Google identity captured at login), or null when
  // unknown. The authoritative signup email + the identity whose inbox is read.
  userEmail: string | null;
  // The MCP api-client (when the tool layer passed one through). Lets the
  // provision captcha gate and the operate drive's auto-solve spend a VAULTED
  // 2Captcha key through the injecting proxy instead of a raw env key.
  // Undefined → both fall back to TWOCAPTCHA_API_KEY.
  api?: ApiClient;
  // The human has not approved or denied yet. A later inject_card call resumes
  // the same approval. A terminal outcome clears this, so the next call mints
  // a fresh approval instead of replaying a dead one.
  activePayment: { status: "awaiting_approval"; state: PendingApprovalWait } | null;
  /** Internal card released by the existing purchase approval; never serialized. */
  releasedPaymentCard: {
    approvalId: string;
    approvalUrl: string;
    checkout: { merchant: string; checkout_origin: string; amount_cents: number; currency: string };
    cardRef: string;
    last4: string;
    deadline: number;
    card: CheckoutCard;
    /** True once the operator has nudged the cardholder about a 3-D Secure challenge. */
    threeDsNotified?: boolean;
  } | null;
  // Per-line idempotency records are local to the one active browser/cart. A
  // retry must inspect this before it ever reaches a merchant add button.
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
  // Session ownership must be a resource boundary, not merely a convention for
  // cooperative hosts. The watchdog observes the browser but teardown may only
  // begin between complete action leases.
  watchdog: OperatorBrowserWatchdog | null;
  terminalTeardownOwner: SessionTerminalTeardownOwner | null;
  // Jev-driven operate_drive loop. Null until the first drive call; finish
  // clears it. `running` is the busy lock so a second in-flight drive refuses
  // instead of interleaving.
  drive: SessionDriveState | null;
}

export interface DriveTrajectoryStep {
  action: string;
  target: string;
  confidence: number;
  url: string;
  stage?: string;
  jev_ms?: number;
}

export interface DriveHandoffQuestion {
  question: string;
  options: Record<string, string>;
  probabilities?: Record<string, number>;
}

export interface SessionDriveState {
  running: boolean;
  goal: string;
  facts: Record<string, string>;
  trajectory: DriveTrajectoryStep[];
  history: string[];
  lastQuestion: DriveHandoffQuestion | null;
  lastActionKey: string | null;
  lastFingerprint: string | null;
  jevCalls: number;
}

// The last extracted elements are resealed on every retain so each retained
// element carries the session-secret correlation selector act() re-resolves
// against. Kept so resolveTarget can be unit-tested against a snapshot, but
// act() always RE-extracts first (re-resolution).
export function retainSessionElements(session: Session, elements: InteractiveElement[]): void {
  session.lastElements = sealRetainedInteractiveElementsV2(elements, (element) =>
    compactV2CorrelationSelector(session, element),
  );
}

// Sealed <select> bookkeeping: committed option values are stored keyed by an
// HMAC of the selector/value under the session's compact-v2 secret so raw
// page text never round-trips through the observation state.
export function compactV2CommittedSelectKey(session: Session, selector: string): string {
  return createHmac("sha256", session.compactV2Secret)
    .update(`select-key\0${selector}`)
    .digest("base64url");
}

export function compactV2CommittedSelectValue(session: Session, value: string): string {
  return createHmac("sha256", session.compactV2Secret)
    .update(`select-value\0${value}`)
    .digest("base64url");
}

export function clearCommittedSelectValue(session: Session, selector: string): void {
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

/** Everything the two starts genuinely differ on. Everything else is fixed. */
export interface CreateSessionInput {
  id: string;
  browser: BrowserController;
  allowedHosts: AllowedHostEntry[];
  startUrl: string;
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
    lastElements: [],
    compactV2Secret: randomBytes(32),
    compactV2HintPages: [],
    compactV2Active: false,
    compactV2Refs: new Map(),
    compactV2Index: null,
    compactV2Previous: null,
    committedSelectValues: new Map(),
    activePayment: null,
    releasedPaymentCard: null,
    cartUrls: new Map(),
    lastCartMutation: null,
    closing: false,
    initializing: true,
    lastActivityAt: Date.now(),
    callCount: 0,
    callDrainWaiters: new Set(),
    startedAt: Date.now(),
    watchdog: null,
    terminalTeardownOwner: null,
    drive: null,
    startUrl: input.startUrl,
    consentInboxRead: input.consentInboxRead,
    userEmail: input.userEmail,
    // ABSENT, not present-and-undefined, when the tool layer passed no client.
    ...(input.api !== undefined ? { api: input.api } : {}),
  };
}
