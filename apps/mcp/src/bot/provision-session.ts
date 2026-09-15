import {
  clickScreenshot,
  ScreenshotClickError,
  type ScreenshotBinding,
  type ScreenshotPoint,
} from "./screenshot-click.js";
import type { GoogleHumanChallenge } from "./google-auth-state.js";
import type { CaptureSource } from "./credential-capture.js";
import {
  operatorMutationDispatchPhase,
  currentOperatorRequestSignal,
  composeOperatorSignals,
} from "./request-cancellation.js";
import type { BrowserUseCapture } from "./browser-use-capture.js";
import { serializeBrowserUseDOM } from "./browser-use-serializer.js";
// Phase 1 — the session-holding "thick tools" surface a frontier host agent
// drives. MCP tool calls are stateless, but a provision run needs ONE live
// browser held across many calls; this module is that registry + the
// observe/act loop over the existing BrowserController substrate.
//
// Two findings from the 2026-06 spikes are load-bearing here:
//  - target elements by TEXT/ROLE with re-resolution every act, never by a
//    positional index (indices drift as the SPA re-renders).
//  - the OAuth popup is the fragile part; route OAuth clicks through the
//    substrate's loginWithOAuth/settleAfterOAuth, which already adopt the popup.
//
// Design notes:
//  - browser egress has no host scope.
//  - no credential is ever read back to the agent except via the explicit
//    `finish`/extract path; the vault stays write-only.

import { createHash, createHmac, randomInt } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { Buffer } from "node:buffer";
import type { ElementHandle, Page } from "playwright";
import {
  BrowserClickDispatchError,
  clickDispatchStatusForError,
  type BrowserController,
  type CheckoutCard,
  type FrameTarget,
  type InjectCardField,
  type InjectCardFieldResult,
  type InjectCardResolvedTarget,
  type InteractiveElement,
} from "./browser.js";
import {
  completeOAuthTransitionRecovery,
  loginWithOAuth,
  oauthActionDeadline,
  oauthActionRemainingMs,
  oauthAutomatedActionTimeoutMs,
  oauthHumanHandoffTimeoutMs,
  oauthLoginLeaseCooldownMs,
  oauthTransitionStatus,
  refreshOAuthHumanChallenge,
  resetOAuthActionDeadline,
  settleAfterOAuth,
  withOAuthActionLease,
  withinOAuthActionDeadline,
  type OAuthActionDeadline,
  type OAuthCompletionEvidence,
  OAuthAwaitingHumanError,
  OAuthFailedError,
  OAuthOnboardingRequiredError,
} from "./oauth-login.js";
import { TwoCaptchaSolver, type TwoCaptchaVaultProxy } from "./captcha-solver-2captcha.js";
import type { ClickMethod, DriverTarget } from "./driver/types.js";
import {
  buildSafeControlsV2,
  compactV2LegacyRefForHandle,
  compactV2DegradeMetadata,
  StableObservationRefs,
  isCompactV2Handle,
  isCompactV2Label,
  controlQueryMatchV2,
  encodeV2QueryPage,
  compactV2AuditUrl,
  safeDescriptionV2,
  safeBlockersV2,
  safePageSemanticsV2,
  sealRetainedInteractiveElementsV2,
  safeStageV2,
  type SafeControlV2,
  type ObservationEpochV2,
  type ObservationSemanticSourceV2,
  type SafePageSemanticsV2,
  type SafeObservationIndexV2,
  type SafeStageV2,
} from "./compact-observation-v2.js";
import type { ApiClient, HeightenedAuthNotificationResult } from "../api-client.js";
import { ProvenPreDispatchMutationError } from "./mutation-dispatch-evidence.js";
import { extractApiKeyFromText, isTruncatedCapture } from "./credential-text.js";
import { pickVerificationLink, type VerificationLinkCandidate } from "./email-verification.js";
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

export interface Observation {
  session_id: string;
  // The live page location. Compact V2 can shorten fixed metadata only when
  // necessary to fit its wire budget.
  url: string;
  // Registry route guidance, present ONLY on the first (start) observation when
  // a skill exists for the service. The host agent reads it before driving.
  hint?: string;
  // Domain-aware steering for the host planner. This is not a script; it is
  // guardrail context for states the raw page text routinely misleads agents on.
  guidance?: string;
  // Set on a same-document return: `safe_table` (compact) carries only the rows
  // whose compact form changed; `dom` (full) is a replacement tree and
  // `removed` lists refs that left the rendered view.
  delta?: boolean;
  removed?: string[];
  // True only on act/act-style returns when the browser's main document
  // changed between the action's dispatch and the post-settle capture (a real
  // navigation happened while the action was settling). The observation's
  // `url` already names the new location; the host must not assume refs from
  // before the action still resolve (docs/observation-model.md §4.1).
  navigated?: true;
  // Phase 2 — set to "none" on the minimal ack returned by
  // operate_act{observe:"none"} (action ran; no perception emitted — call
  // operate_observe before the next ref-targeted act).
  observed?: ObserveDetail;
  terminal?: {
    state: "oauth_completed";
    refs: "unavailable";
    next_action: "operate_observe";
  };
  // A rendered 3-D Secure challenge on the checkout after a card release. The
  // operator notified the cardholder once through the API notify path (when
  // that call succeeded); the challenge itself is never blocked, waited on, or
  // taken into custody. The human completes it in their bank app and the agent
  // keeps observing the live checkout.
  three_ds?: {
    state: "challenge_detected";
    url: string;
    notified?: boolean;
  };
  // A provider-owned OAuth popup closed while a legacy two-step OAuth action
  // was still settling. This is an expected browser lifecycle transition, not
  // a failed login or a reason to abandon the session. The host should simply
  // re-observe; the controller will retain or reattach the product page.
  oauth?:
    | {
        state: "in_progress";
        provider_page: "closed_or_detached";
        next_action: "operate_observe";
      }
    | {
        state: "in_progress";
        completion: "unknown";
        next_action: "operate_observe";
      }
    // Fix C: an OAuth action timed out without a confirmed origin-return. This
    // is honest uncertainty, not a failure — a consent screen or 2FA/
    // verification challenge is commonly still showing. `reason` names only
    // what was actually observed (never a guessed cause like "session
    // expired"). The host should re-observe/retry rather than abandon the
    // flow.
    | {
        state: "awaiting_human";
        reason: string;
        challenge?: GoogleHumanChallenge;
        notification?: HeightenedAuthNotificationResult;
        next_action: "operate_observe";
      }
    | {
        state: "onboarding_required";
        reason: string;
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
  selected_option?: string;
  format?: "browser-use-dom" | "browser-use-control-query";
  stage?: SafeStageV2;
  generation?: number;
  safe_table?: SafeControlV2[];
  dom?: string;
  /** The current rendered DOM equals the retained same-document view. */
  dom_unchanged?: true;
  more_above?: boolean;
  more_below?: boolean;
  semantic?: SafePageSemanticsV2;
  overflow?: { remaining: number; next_cursor: string };
  hint_overflow?: { remaining: number; next_cursor: string };
}

export type ProvisionAction =
  | { kind: "click"; target: string; screenshot?: ScreenshotPoint }
  // JS-dispatched click (el.click()) — use when a plain click on a custom
  // React card/widget didn't register its onClick (the stochastic radio-card
  // stall). Same target resolution; different dispatch.
  | { kind: "js_click"; target: string }
  | {
      kind: "type";
      target: string;
      text: string;
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
    }
  // Set the country on a phone-number field's dial-code picker. No ref/target
  // — the bot locates a phone-local native <select>, including
  // react-phone-number-input's opacity:0 select that inventory drops. Other
  // widget families are unsupported and throw.
  | {
      kind: "set_phone_country";
      country: string;
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
  // Sealed credential transfer — type a secret held in a session-local slot
  // into a field, WITHOUT the value ever crossing the MCP boundary to the
  // host. The host orchestrates by slot name; the bot types the real value.
  | { kind: "type_secret"; slot: string; target: string }
  // Reveal below-the-fold controls on a long SPA form, then re-observe to pick
  // up the newly-visible elements (heavy consoles render fields off-viewport).
  | { kind: "scroll"; direction?: "down" | "up" | "bottom" | "top" }
  // Attach a LOCAL file. target = the visible upload button/menu-item (or the
  // file <input>); path = an absolute local file path. The bot sets the file via
  // Playwright (filechooser/setInputFiles), so the OS dialog is never driven.
  // Not recorded in skill recipes — a machine-local path isn't portable.
  | { kind: "upload"; target: string; path: string };

export type { AllowedHostEntry, HostSource, Session } from "./session/model.js";
import type { Session } from "./session/model.js";
import { egressSeedHosts, hostStrings, registrableHost } from "./session/hosts.js";
// Phase 3 — session state left the facade: the sealed <select> bookkeeping and
// element retention moved to session/model.ts, the secret slots to
// session/slots.ts, and the host-scope state to session/registry.ts. The
// slots and the user-email lookup stay re-exported below (the tool layer's
// import surface), as with the lifecycle names.
import {
  clearCommittedSelectValue,
  compactV2CommittedSelectKey,
  compactV2CommittedSelectValue,
  retainSessionElements,
} from "./session/model.js";
import { widenAllowedHostsFromUrl } from "./session/registry.js";
import { stashSecretSlot, type SlotHandle } from "./session/slots.js";

export { getSessionUserEmail } from "./session/registry.js";
export { readSecretSlotValue, stashSecretSlot, type SlotHandle } from "./session/slots.js";
// Phase 2 — the lifecycle registry transaction moved to session/lifecycle.ts as
// one unit (registry, real-profile lease, call leases and drains, watchdog,
// bounded close, terminal owner, artifact cleanup, start/finish/shutdown).
// Everything it owns is re-exported below, so no caller import changed.
import {
  activeSessionCount,
  audit,
  closeAllProvisionSessions,
  forceFinishProvisionSession,
  finishProvisionSession,
  finishProvisionSessionWithPreparation,
  googleSessionGate,
  paymentSession,
  sessionForCall,
  startProvisionSession as startProvisionSessionInternal,
  startHarnessProvisionSession as startHarnessProvisionSessionInternal,
  UnknownProvisionSessionError,
  withPaymentSessionCall,
  withProvisionSessionCall,
  type HarnessStartOptions,
  type NeedsUserLogin,
  type SessionStartPorts,
  type StartOptions,
} from "./session/lifecycle.js";

export {
  activeSessionCount,
  closeAllProvisionSessions,
  forceFinishProvisionSession,
  finishProvisionSession,
  finishProvisionSessionWithPreparation,
  googleSessionGate,
  paymentSession,
  UnknownProvisionSessionError,
  withPaymentSessionCall,
  withProvisionSessionCall,
};
export type { HarnessStartOptions, NeedsUserLogin, StartOptions };
export type { FinishResult, PreparedFinishResult } from "./session/lifecycle.js";

async function withOAuthActionBoundary(
  session: Session,
  provider: OAuthProviderId | undefined,
  run: (deadline: OAuthActionDeadline) => Promise<InternalActResult>,
): Promise<InternalActResult> {
  const deadline = oauthActionDeadline(provider);
  const releaseCooldownMs = oauthLoginLeaseCooldownMs();
  // A deadline expiry must NOT terminalize the session: the in-flight OAuth
  // operation is budget-bounded (loginWithOAuth races its own completion
  // window), so unwinding needs no teardown. Force-closing here used to
  // deregister a healthy session mid-handoff, leaving the pending
  // chooser/consent screen unreachable — observe/screenshot/oauth_settle all
  // returned "unknown provision session" and the only recovery was a fresh
  // session that lost all progress. The timeout surfaces as a recoverable
  // error while the session, browser, and page stay valid for inspection and
  // a settle/retry. Serialization custody is unchanged: the lease below still
  // drains the in-flight work (plus the cooldown) before the next OAuth
  // action acquires it, and a genuinely dead browser still surfaces as
  // unavailable through its own close paths.
  return await withOAuthActionLease(
    deadline,
    async () => {
      try {
        return await withinOAuthActionDeadline(run(deadline), deadline);
      } catch (error) {
        const uncertain = oauthErrorAfterDispatchAttempt(session, error);
        if (
          uncertain !== null ||
          (error instanceof OAuthAwaitingHumanError && error.phase !== "not_attempted")
        ) {
          // Browser timeout/navigation errors need the same evidence check as
          // request cancellation. A failed read cannot erase dispatched uncertainty.
          const completion = await deadline.completionCheck?.().catch(() => null);
          if (completion !== undefined && completion !== null) {
            return {
              observation: completion.terminal
                ? terminalOAuthCompletionObservation(session, completion.url!)
                : await observeSession(session, "compact", undefined, completion.page).catch(() => {
                    if (uncertain !== null) return uncertain;
                    throw error;
                  }),
              outcome: {},
            };
          }
        }
        if (uncertain !== null) return { observation: uncertain, outcome: {} };
        throw error;
      }
    },
    releaseCooldownMs,
  );
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
  compactAuthorization?: CompactV2TargetAuthorization,
  bindPreparedTargetAtDispatch = false,
): Promise<BrowserController> {
  const authorizedRef = provisionElementRefs(authorizedElements).get(authorizedElement);
  if (authorizedRef === undefined) {
    throw new Error("OAuth action target was not present in the authorized action map");
  }
  const expectedGoogleAccountEmail = session.userEmail ?? undefined;
  const completed = await runSerializedGoogleIdentityOperation(
    session,
    async (browser) => {
      const humanHandoffTimeoutMs = oauthHumanHandoffTimeoutMs();
      await loginWithOAuth(
        browser,
        authorizedElement.selector,
        oauthActionRemainingMs(deadline),
        provider,
        provider === "github" ? undefined : expectedGoogleAccountEmail,
        (check) => {
          deadline.completionCheck = check;
        },
        () => {
          // Browser setup and the authorized click completed inside the short
          // machine phase. Only the chooser/2FA/consent wait gets the longer
          // human budget; signalling re-arms every enclosing deadline race.
          resetOAuthActionDeadline(deadline, humanHandoffTimeoutMs);
          return deadline.expiresAt;
        },
        bindPreparedTargetAtDispatch && compactAuthorization !== undefined
          ? async (dispatch) => {
              let dispatchAttempted = false;
              let handle: Awaited<ReturnType<BrowserController["bindOAuthClickTarget"]>> = null;
              try {
                const resolveCurrentTarget = async (): Promise<InteractiveElement> => {
                  const fresh = (await browser.extractBrowserUseObservation()).elements;
                  retainSessionElements(session, fresh);
                  return resolveAuthorizedCompactV2Target(session, fresh, compactAuthorization);
                };
                const resolved = await resolveCurrentTarget();
                handle = await browser.bindOAuthClickTarget(resolved.selector, async () => {
                  return (await resolveCurrentTarget()).selector;
                });
                if (handle === null) {
                  throw new Error(
                    "OAuth action target changed during the identity handoff; re-observe before retrying",
                  );
                }
                dispatchAttempted = true;
                await dispatch(handle, async () => {
                  const current = await resolveCurrentTarget();
                  if (await browser.matchesOAuthClickTarget(handle!, current.selector)) return;
                  throw new Error(
                    "OAuth action target changed during the identity handoff; re-observe before retrying",
                  );
                });
              } catch (error) {
                if (!dispatchAttempted || clickDispatchStatusForError(error) === "not_dispatched") {
                  throw new ProvenPreDispatchMutationError("stale_ref", { cause: error });
                }
                throw error;
              } finally {
                await handle?.dispose().catch(() => undefined);
              }
            }
          : undefined,
        async (challenge, signal) => {
          const composed = composeOperatorSignals([
            signal,
            ...(currentOperatorRequestSignal() ? [currentOperatorRequestSignal()!] : []),
          ]);
          try {
            if (session.api === null || session.api === undefined)
              throw new Error("notification_unavailable");
            return await session.api.notifyHeightenedAuth(
              {
                service: new URL(session.startUrl).hostname.slice(0, 120),
                attempt_id: challenge.attempt_id,
                challenge_revision: challenge.challenge_revision,
                digit: challenge.number,
                observed_at: challenge.observed_at,
                expires_at: challenge.expires_at,
                window_seconds: Math.max(
                  1,
                  Math.min(600, Math.ceil(humanHandoffTimeoutMs / 1_000)),
                ),
              },
              composed.signal,
            );
          } finally {
            composed.dispose();
          }
        },
      );
      // Human completion returns custody to bounded machine work. Give DOM
      // readiness its own short window instead of spending the human budget.
      resetOAuthActionDeadline(deadline, oauthAutomatedActionTimeoutMs());
      await settleAfterStateChange(browser);
    },
    { deadline },
  );
  return completed.browser;
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
    // Frame origin + full frame URL — WITHOUT these, an element's `selector`
    // (folded into stableElementId below) is only unique within its own
    // document, so a same-shaped selector in two different frames (or a frame
    // vs. the main page) could hash to the SAME ref and let an act resolve to
    // the wrong frame's element. Load-bearing for frame identity: the ref
    // itself must be frame-scoped, not just the guard that later reads it.
    //
    // The frame's URL, NOT its positional framePath, is the durable frame
    // component: hosted-field providers (Braintree, PayPal, Stripe Elements)
    // remount their <iframe> after the first input, and Playwright then
    // APPENDS the replacement to the parent's childFrames() list, shifting
    // every positional path. A framePath-keyed identity would re-mint every
    // framed ref on that remount and turn later inject_card fields into
    // not_found; the remount keeps the iframe's src, so the URL survives.
    el.frameOrigin ?? "",
    el.frameUrl ?? "",
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

class CompactV2StaleRefError extends Error {}
class CompactV2UnresolvedLabelError extends Error {}
class ProvisionTargetNotAllowedError extends Error {}
class ProvisionTargetMissingError extends Error {}
class CompactV2ActionFailureError extends Error {}
/**
 * A `@label` that names more than one observed control. Extends the
 * already-sealed failure channel so its message survives V2's opaque error
 * mapping: it carries ONLY refs the agent already holds, never page text.
 */
class CompactV2AmbiguousLabelError extends CompactV2ActionFailureError {}

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

// Shopify defers address geocoding (and therefore delivery-rate loading) until
// its required shipping street field is committed. Keep this deliberately
// narrow: ordinary text fields and even other autocomplete controls retain
// their existing type-only behavior.
function isRequiredShippingAddressLine1(el: InteractiveElement): boolean {
  if (!el.required) return false;
  const autocomplete = (el.autocomplete ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 0);
  return autocomplete.includes("shipping") && autocomplete.includes("address-line1");
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

const compactV2SourcePages = new WeakMap<object, OAuthCompletionEvidence["page"]>();
const oauthCompletionSourcePages = new WeakMap<object, OAuthCompletionEvidence["page"]>();

function compactV2SourcePage(session: object): OAuthCompletionEvidence["page"] | undefined {
  const page = compactV2SourcePages.get(session);
  if (page?.isClosed()) {
    compactV2SourcePages.delete(session);
    return undefined;
  }
  return page;
}

function rememberCompactV2SourcePage(
  session: object,
  page: OAuthCompletionEvidence["page"] | undefined,
): void {
  if (page === undefined) compactV2SourcePages.delete(session);
  else compactV2SourcePages.set(session, page);
}

function oauthCompletionSourcePage(session: object): OAuthCompletionEvidence["page"] | undefined {
  return oauthCompletionSourcePages.get(session);
}

function operationPageForSession(session: Session): Page | undefined {
  const page =
    oauthCompletionSourcePage(session) ??
    (session.compactV2Active ? compactV2SourcePage(session) : undefined) ??
    session.browser.activePage() ??
    undefined;
  return returnFromClosedPicker(session, page);
}

function returnFromClosedPicker(session: Session, page: Page | undefined): Page | undefined {
  if (page === undefined || !page.isClosed()) return page;
  const opener = session.browser.returnFromClosedPopup(page);
  if (opener === null) return page;
  // Only post-click perception follows the opener. The dispatched target and
  // any field verification stay bound to the original popup document.
  if (oauthCompletionSourcePage(session) !== undefined) {
    rememberOAuthCompletionSourcePage(session, opener);
  } else if (session.compactV2Active) {
    rememberCompactV2SourcePage(session, opener);
  }
  invalidateCompactV2Snapshot(session);
  return opener;
}

function rememberOAuthCompletionSourcePage(
  session: object,
  page: OAuthCompletionEvidence["page"] | undefined,
): void {
  if (page === undefined) oauthCompletionSourcePages.delete(session);
  else oauthCompletionSourcePages.set(session, page);
}

function invalidateCompactV2Snapshot(
  session: Pick<Session, "compactV2Refs" | "compactV2Index" | "compactV2Previous">,
): void {
  session.compactV2Refs = new Map();
  session.compactV2Index = null;
  session.compactV2Previous = null;
  compactV2SourcePages.delete(session);
}

function throwCompactV2StaleRef(): never {
  // Deliberately opaque: stale V2 errors must not construct V1 replacement
  // candidates or reveal raw labels/legacy identities outside the safe view.
  throw new CompactV2StaleRefError("stale_ref");
}

export interface CompactV2TargetAuthorization {
  legacyRef: string;
  row: SafeControlV2;
}

export interface PreparedOAuthLoginTarget {
  sessionId: string;
  target: string;
  authorization: CompactV2TargetAuthorization;
}

const preparedOAuthLoginTarget = new AsyncLocalStorage<PreparedOAuthLoginTarget>();

export function preparePublicOAuthLoginTarget(
  sessionId: string,
  target: string,
): PreparedOAuthLoginTarget | undefined {
  const session = sessionForCall(sessionId);
  if (session?.compactV2Active !== true) return undefined;
  try {
    return {
      sessionId,
      target,
      authorization: compactV2AuthorizationForTarget(session, target),
    };
  } catch (error) {
    if (error instanceof CompactV2StaleRefError) {
      throw new ProvenPreDispatchMutationError("stale_ref", { cause: error });
    }
    throw error;
  }
}

export function withPreparedOAuthLoginTarget<T>(
  prepared: PreparedOAuthLoginTarget,
  operation: () => Promise<T>,
): Promise<T> {
  return preparedOAuthLoginTarget.run(prepared, operation);
}

/** Wire-visible equality for the action response's changed-control delta. */
function sameCompactV2Control(left: SafeControlV2, right: SafeControlV2): boolean {
  return (
    left.ref === right.ref &&
    left.role === right.role &&
    left.state === right.state &&
    left.visibility === right.visibility &&
    left.action === right.action &&
    left.field === right.field &&
    left.label === right.label &&
    left.choice === right.choice &&
    left.frame === right.frame &&
    left.match === right.match
  );
}

/**
 * Authorize an agent-supplied target against the observed skeleton. Two forms:
 * a `@e:` handle (the physical node anchor) or a `@label` alias, which resolves
 * to exactly one observed handle or fails — never a guess. Only the epoch's
 * `doc` gates here; a benign re-render since the observation is expected and is
 * settled at act time against live elements.
 */
function compactV2AuthorizationForTarget(
  session: Session,
  target: string,
  distinguishUnresolvedLabel = false,
): CompactV2TargetAuthorization {
  const index = session.compactV2Index;
  if (index === null) throwCompactV2StaleRef();
  if (index.expiresAt < Date.now() || index.epoch.doc !== compactV2EpochDoc(session)) {
    invalidateCompactV2Snapshot(session);
    throwCompactV2StaleRef();
  }
  const row = isCompactV2Label(target)
    ? resolveCompactV2Label(index.rows, target)
    : index.rows.find((candidate) => candidate.ref === target);
  if (row === undefined) {
    if (
      distinguishUnresolvedLabel &&
      isCompactV2Label(target) &&
      !compactV2RefAllocator(session).hasLabel(target)
    )
      throw new CompactV2UnresolvedLabelError("target_unresolved");
    throwCompactV2StaleRef();
  }
  const legacy = compactV2LegacyRefForHandle(session.compactV2Refs, row.ref);
  if (legacy === null) throwCompactV2StaleRef();
  return { legacyRef: legacy, row };
}

/** A label acts only when it names exactly one observed control. */
function resolveCompactV2Label(
  rows: readonly SafeControlV2[],
  label: string,
): SafeControlV2 | undefined {
  const matches = rows.filter((row) => row.label === label);
  if (matches.length > 1) {
    throw new CompactV2AmbiguousLabelError(
      `ambiguous_target: "${label}" names ${matches.length} controls. ` +
        `Retry with one exact ref: ${matches.map((row) => row.ref).join(", ")}`,
    );
  }
  return matches[0];
}

/**
 * Re-resolve an authorized ref against LIVE elements. The handle is minted from
 * the element's physical node identity under the document epoch, so a ref
 * resolves across a benign re-render (the whole point of the identity model)
 * and fails closed only when that element is genuinely gone or its document
 * epoch changed. Matching is by the durable handle alone — never by the row's
 * role/label/field, which a legitimate re-render may change (and which would
 * otherwise re-run the redundant intent gate this replaced).
 */
function resolveAuthorizedCompactV2Target(
  session: Session,
  elements: readonly InteractiveElement[],
  authorization: CompactV2TargetAuthorization,
): InteractiveElement {
  const index = session.compactV2Index;
  if (index === null || index.epoch.doc !== compactV2EpochDoc(session)) {
    invalidateCompactV2Snapshot(session);
    throwCompactV2StaleRef();
  }
  const live = compactV2LiveControls(session, elements);
  const matches = live.rows.filter((row) => row.ref === authorization.row.ref);
  // Physical identities are unique within an inventory by construction, so >1
  // means a broken invariant rather than an addressable ambiguity: refuse either way.
  if (matches.length !== 1) throwCompactV2StaleRef();
  const liveRow = matches[0]!;
  const legacy = live.byRef.get(liveRow.ref);
  const resolved = legacy === undefined ? null : resolveTarget(elements, legacy);
  if (resolved === null) throwCompactV2StaleRef();
  return resolved;
}

type FrameScopedTarget = Pick<InteractiveElement, "frameOrigin" | "frameUrl" | "framePath">;

function frameTargetFor(el: FrameScopedTarget): FrameTarget | null {
  if (el.framePath === undefined || el.framePath === null) return null;
  if (el.frameOrigin === undefined || el.frameOrigin === null) {
    throw new ProvisionTargetNotAllowedError("frame target lacks an origin");
  }
  return {
    framePath: el.framePath,
    frameOrigin: el.frameOrigin,
    frameUrl: el.frameUrl ?? "",
  };
}

// ── session lifecycle ──
//
// The transaction itself lives in session/lifecycle.ts. These two wrappers are
// the facade: they bind the perception collaborators the start paths need, so
// the lifecycle module keeps a one-way dependency on this file (types only).
const sessionStartPorts: SessionStartPorts = {
  observeSession: async (session, format, startMetadata) =>
    await observeSession(session, format, startMetadata, undefined, false, format),
  compactV2StartMetadata: (registryHint, loginHint, userEmail) =>
    compactV2StartMetadata(registryHint, loginHint, userEmail),
};

export async function startProvisionSession(opts: StartOptions): Promise<Observation> {
  return await startProvisionSessionInternal(opts, sessionStartPorts);
}

/** Start a normal guarded session on a caller-owned harness page. */
export async function startHarnessProvisionSession(
  opts: HarnessStartOptions,
): Promise<Observation> {
  return await startHarnessProvisionSessionInternal(opts, sessionStartPorts);
}

async function observedOAuthChallenge(
  sessionId: string,
): Promise<Observation["oauth"] | undefined> {
  const session = sessionForCall(sessionId);
  const error = await (session?.browser ? refreshOAuthHumanChallenge(session.browser) : undefined);
  if (error == null || error.challenge === undefined) return undefined;
  return {
    state: "awaiting_human",
    reason: error.message,
    next_action: "operate_observe",
    challenge: error.challenge,
    ...(error.notification === undefined ? {} : { notification: error.notification }),
  };
}

async function observedThreeDsChallenge(
  sessionId: string,
): Promise<Observation["three_ds"] | undefined> {
  const session = sessionForCall(sessionId);
  if (session === undefined) return undefined;
  const released = session.releasedPaymentCard;
  if (released === null) return undefined;
  const challenge = await session.browser.detectThreeDsChallenge().catch(() => null);
  if (challenge === null) return undefined;
  let notified: boolean | undefined;
  if (released.threeDsNotified !== true) {
    released.threeDsNotified = true;
    try {
      notified = (await session.api?.notifyThreeDs(released.approvalId, "detected_challenge"))
        ?.sent;
    } catch {
      notified = false;
    }
  }
  return {
    state: "challenge_detected",
    url: challenge.url,
    ...(notified === undefined ? {} : { notified }),
  };
}

export async function observe(
  sessionId: string,
  format?: "compact" | "full",
): Promise<Observation> {
  const result = await observeOwned(sessionId, format);
  const oauth = await observedOAuthChallenge(sessionId);
  const threeDs = await observedThreeDsChallenge(sessionId);
  return {
    ...result,
    ...(oauth === undefined ? {} : { oauth }),
    ...(threeDs === undefined ? {} : { three_ds: threeDs }),
  };
}

async function observeOwned(sessionId: string, format?: "compact" | "full"): Promise<Observation> {
  const session = sessionForCall(sessionId);
  if (session === undefined) throw new Error(`unknown provision session ${sessionId}`);
  const requestedFormat = format ?? "full";
  const completionSource = oauthCompletionSourcePage(session);
  if (completionSource?.isClosed() === true) {
    completeOAuthTransitionRecovery(session.browser);
  }
  const transition = oauthTransitionStatus(session.browser);
  const sourcePage =
    transition?.providerPageClosed === true &&
    transition.productPageViable &&
    transition.browserConnected
      ? undefined
      : operationPageForSession(session);
  return await observeSession(
    session,
    requestedFormat,
    undefined,
    sourcePage?.isClosed() === true ? undefined : sourcePage,
    false,
    requestedFormat,
    false,
    true,
    format === "full",
  );
}

export interface ScreenshotCapture {
  session_id: string;
  url: string;
  frame_url: string | null;
  frame_count: number;
  click_binding?: ScreenshotBinding;
  image: { mime_type: string; data_base64: string };
}

// operate_screenshot's session-level entry point. Once a card has been released,
// the controller composites over PAN/CVV value pixels before this output seam.
export async function captureScreenshot(
  sessionId: string,
  opts: { frameIndex?: number; frameUrlContains?: string; fullPage?: boolean } = {},
): Promise<ScreenshotCapture> {
  const session = sessionForCall(sessionId);
  if (session === undefined) throw new Error(`unknown provision session ${sessionId}`);
  const page = operationPageForSession(session);
  const captured = await session.browser.captureOperatorScreenshot(opts, page);
  return {
    session_id: sessionId,
    url: page?.url() ?? session.browser.currentUrl(),
    frame_url: captured.frameUrl,
    frame_count: captured.frameCount,
    ...(captured.clickBinding ? { click_binding: captured.clickBinding } : {}),
    image: { mime_type: captured.mimeType ?? "image/jpeg", data_base64: captured.base64 },
  };
}

export function readOperatorEvidence(
  sessionId: string,
  since = 0,
  requestId?: string,
): ReturnType<BrowserController["readOperatorEvidence"]> {
  const session = sessionForCall(sessionId);
  if (session === undefined) throw new Error(`unknown provision session ${sessionId}`);
  return session.browser.readOperatorEvidence(since, requestId);
}

export function maskOperatorSessionOutput<T>(sessionId: string, value: T): T {
  const session = sessionForCall(sessionId);
  if (session === undefined) return value;
  const mask = session.browser.maskOperatorOutput;
  return typeof mask === "function" ? (mask.call(session.browser, value) as T) : value;
}

export async function injectCardIntoSessionTargets(
  sessionId: string,
  card: CheckoutCard,
  targets: Partial<
    Record<InjectCardField, { ref: string; format?: string | undefined } | undefined>
  >,
): Promise<Record<InjectCardField, InjectCardFieldResult>> {
  const session = sessionForCall(sessionId);
  if (session === undefined) throw new Error(`unknown provision session ${sessionId}`);
  const page = operationPageForSession(session);
  const fresh = await session.browser.extractInteractiveElements(page);
  const resolved: Partial<Record<InjectCardField, InjectCardResolvedTarget>> = {};
  for (const field of ["pan", "cvv", "exp_month", "exp_year", "exp", "name"] as const) {
    const target = targets[field];
    if (target === undefined) continue;
    const legacy = session.compactV2Active ? session.compactV2Refs.get(target.ref) : target.ref;
    if (legacy === undefined) {
      resolved[field] = { missing: "not_found", format: target.format };
      continue;
    }
    const previouslyPresent = resolveTarget(session.lastElements, legacy) !== null;
    const element = resolveTarget(fresh, legacy);
    resolved[field] =
      element === null
        ? { missing: previouslyPresent ? "detached" : "not_found", format: target.format }
        : { element, format: target.format };
  }
  return await session.browser.injectCardIntoTargets(card, resolved, page);
}

export async function observeSubtree(
  sessionId: string,
  target: string,
  rawAttributes = false,
): Promise<Record<string, unknown>> {
  const session = sessionForCall(sessionId);
  if (session === undefined) throw new Error(`unknown provision session ${sessionId}`);
  const page = operationPageForSession(session);
  const capture = await session.browser.extractBrowserUseObservation(page);
  const legacy = session.compactV2Active ? session.compactV2Refs.get(target) : target;
  if (legacy === undefined) throw new Error("stale_ref");
  const element = resolveTarget(capture.elements, legacy);
  if (element === null) throw new Error("stale_ref");
  const entry = [...capture.nodeElements].find(
    ([, candidate]) => candidate.observationIdentity === element.observationIdentity,
  );
  if (entry === undefined) throw new Error("observation_subtree_unavailable");
  const findNode = (
    root: BrowserUseCapture["root"],
    id: string,
  ): BrowserUseCapture["root"] | null => {
    if (root.id === id) return root;
    for (const child of root.children) {
      const found = findNode(child, id);
      if (found !== null) return found;
    }
    return root.contentDocument === null ? null : findNode(root.contentDocument, id);
  };
  const root = findNode(capture.root, entry[0]);
  if (root === null) throw new Error("observation_subtree_unavailable");
  let remaining = 1_000;
  const project = (node: BrowserUseCapture["root"]): Record<string, unknown> => {
    remaining -= 1;
    const children = remaining <= 0 ? [] : node.children.map(project);
    const contentDocument =
      remaining <= 0 || node.contentDocument === null ? null : project(node.contentDocument);
    return {
      node_id: node.id,
      node_type: node.nodeType,
      tag: node.nodeName.toLowerCase(),
      value: node.value,
      ...(rawAttributes ? { attributes: node.attributes } : {}),
      visible: node.visible,
      rendered: node.rendered ?? null,
      bounds: node.bounds,
      ax_role: node.axRole,
      ax_properties: node.axProperties,
      shadow_type: node.shadowType,
      children,
      content_document: contentDocument,
      ...(remaining <= 0 ? { capture_truncated: true } : {}),
    };
  };
  return {
    format: "browser-use-subtree",
    session_id: session.id,
    url: page?.url() ?? session.browser.currentUrl(),
    target,
    subtree: project(root),
    ...(capture.omissions.length === 0 ? {} : { capture_omissions: capture.omissions }),
  };
}

// Hosts to seed credential EGRESS from when storing a key extracted in this
// session: start + auto_widen, NEVER mid_session task scope (a wide multi-app
// operate scope must not silently over-grant a key's egress allow-list).
export function observedHostsForSession(sessionId: string): string[] {
  const session = sessionForCall(sessionId);
  if (session === undefined) throw new Error(`unknown provision session ${sessionId}`);
  widenAllowedHostsFromUrl(
    session,
    operationPageForSession(session)?.url() ?? session.browser.currentUrl(),
  );
  return [...new Set(egressSeedHosts(session))];
}

export function currentProvisionUrl(sessionId: string): string {
  const session = sessionForCall(sessionId);
  if (session === undefined) throw new Error(`unknown provision session ${sessionId}`);
  return operationPageForSession(session)?.url() ?? session.browser.currentUrl();
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

// Observation verbosity, set per call via operate_observe{format} /
// operate_act{detail}:
//   "none"    — bare ack, no perception (operate_act only; for chained fills).
//   "compact" — the paged browser-use control map. The DEFAULT.
//   "full"    — the browser-use DOM tree.
export type ObserveDetail = "none" | "compact" | "full";

export interface CompactV2StartMetadata {
  hintPages?: string[];
  userEmail?: string;
}

/**
 * Last index in `page` at which a split leaves complete whitespace-delimited
 * tokens on both sides (the position right after the final whitespace run), or
 * -1 when the page holds no interior token boundary.
 */
function lastUtf8TokenBoundary(page: string): number {
  const match = /\s(?=\S*$)/.exec(page);
  return match === null ? -1 : match.index + 1;
}

/**
 * Split `value` into byte-bounded pages LOSSLESSLY (concatenating the pages
 * reproduces the input) and at TOKEN boundaries: an overflow never cuts a word
 * or URL mid-token when an interior boundary exists — the ipinfo dogfood read
 * "- entry: https://ipin" off page 0 and had to spend an extra paging call to
 * reassemble trusted routing metadata. Only a single token longer than a whole
 * page falls back to the old character split.
 */
function splitUtf8Pages(value: string, maxBytes: number): string[] {
  if (value.length === 0) return [];
  const pages: string[] = [];
  let page = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes && page.length > 0) {
      const boundary = lastUtf8TokenBoundary(page);
      if (boundary > 0) {
        const rest = page.slice(boundary);
        pages.push(page.slice(0, boundary));
        page = rest;
        bytes = Buffer.byteLength(rest, "utf8");
      } else {
        pages.push(page);
        page = "";
        bytes = 0;
      }
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

/**
 * Scope for the default map's overflow paging cursors. Deliberately NOT bound
 * to a query/role: the map ordering is canonical and any filter rides on top
 * of paging. Binding the scope to the exact query/role (the old behavior)
 * made the model's natural "page the overflow, looking for X" call — a map
 * cursor plus a search term — fail with invalid_cursor on every attempt (the
 * live Xata failure).
 */
function compactV2ControlCursorScope(session: Session): string {
  return createHmac("sha256", session.compactV2Secret)
    .update("control-map-paging")
    .digest("base64url")
    .slice(0, 10);
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

interface CompactV2PagingSnapshot {
  id: string;
  scope: string;
  epoch: ObservationEpochV2;
  stage: SafeStageV2;
  semantics: SafePageSemanticsV2;
  pageUrl: string;
  rows: readonly SafeControlV2[];
  hintPages: readonly string[];
  expiresAt: number;
}

const compactV2PagingSnapshots = new WeakMap<
  Session,
  { sequence: number; snapshots: Map<string, CompactV2PagingSnapshot> }
>();
const COMPACT_V2_MAX_PAGING_SNAPSHOTS = 12;

function retainCompactV2PagingSnapshot(
  session: Session,
  index: SafeObservationIndexV2,
  scope: string,
  pageUrl: string,
  rows: readonly SafeControlV2[],
  hintPages: readonly string[] = [],
): CompactV2PagingSnapshot {
  let state = compactV2PagingSnapshots.get(session);
  if (state === undefined) {
    state = { sequence: 0, snapshots: new Map() };
    compactV2PagingSnapshots.set(session, state);
  }
  const now = Date.now();
  for (const [id, snapshot] of state.snapshots) {
    if (snapshot.expiresAt < now) state.snapshots.delete(id);
  }
  const snapshot: CompactV2PagingSnapshot = {
    id: (++state.sequence).toString(36),
    scope,
    epoch: { ...index.epoch },
    stage: index.stage,
    semantics: { ...index.semantics },
    pageUrl,
    rows: rows.map((row) => ({ ...row })),
    hintPages: [...hintPages],
    expiresAt: Math.min(index.expiresAt, now + 5 * 60_000),
  };
  state.snapshots.set(snapshot.id, snapshot);
  while (state.snapshots.size > COMPACT_V2_MAX_PAGING_SNAPSHOTS) {
    const oldest = state.snapshots.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    state.snapshots.delete(oldest);
  }
  return snapshot;
}

function compactV2Cursor(
  session: Session,
  snapshot: CompactV2PagingSnapshot,
  offset: number,
): string {
  // The cursor identifies an immutable, bounded paging snapshot. Fresh reads
  // may replace the live action map without changing what an older cursor
  // means; action-time resolution still revalidates every returned ref.
  const body = `${snapshot.id}:${snapshot.epoch.rev.toString(36)}:${offset.toString(36)}:${snapshot.scope}`;
  const signature = createHmac("sha256", session.compactV2Secret)
    .update(body)
    .digest("base64url")
    .slice(0, 12);
  return `${body}.${signature}`;
}

// A live checkout mints a per-checkout token INTO ITS PATH and re-writes it as
// the checkout SPA re-renders a step. The token names the checkout, never the
// document, so folding it into `doc` retires every ref between two fills of one
// address block. This is the path-side twin of the query/fragment exclusion
// PR #624 landed; it is deliberately a CLOSED list of known checkout shapes —
// every other path keeps its full identity, so an SPA route change to a
// different logical page still retires refs.
const VOLATILE_CHECKOUT_PATH_RULES: readonly RegExp[] = [
  // Shopify hosted checkout, current (`…/checkouts/cn/<token>[/<step>]`) and
  // legacy (`…/checkouts/c|co/<token>[/<step>]`), under any locale/shop prefix.
  // The marker must be a whole segment, so a token that merely starts with "c"
  // cannot be split across the capture.
  /^(.*\/checkouts\/c[no]?)\/([^/]+)(?:\/.*)?$/i,
  // Older Shopify: `/<shop-id>/checkouts/<token>[/<step>]`.
  /^(.*\/checkouts)\/([^/]+)(?:\/.*)?$/i,
];

/**
 * Generated, not authored. An authored path slug under `/checkouts/` (a docs
 * page, a marketing route) must keep its own identity, so the token has to look
 * minted: long, in the URL-safe token alphabet, and carrying a digit.
 */
function looksLikeVolatileCheckoutToken(segment: string): boolean {
  return segment.length >= 16 && /^[A-Za-z0-9_-]+$/.test(segment) && /\d/.test(segment);
}

/**
 * Collapse a known-volatile checkout path onto one logical-page key. The step
 * suffix collapses with the token: inside a single checkout the steps are
 * same-document SPA routing, and a move to a DIFFERENT checkout replaces the
 * document, which the primary document-identity signal catches.
 */
function normalizeVolatileCheckoutPath(pathname: string): string {
  for (const rule of VOLATILE_CHECKOUT_PATH_RULES) {
    const match = rule.exec(pathname);
    if (match !== null && looksLikeVolatileCheckoutToken(match[2]!)) {
      return `${match[1]}/:checkout`;
    }
  }
  return pathname;
}

// The `doc` half of the observation epoch (docs/observation-model.md §4.1):
// the browser's stable main-document identity, not the URL. The full URL is too
// volatile to key on — live checkouts (e.g. Shopify) rotate a token in the
// query string AND in the path on every step re-render, which would invalidate
// every ref between two acts. A NORMALIZED origin+pathname is folded in as a
// fail-closed backstop for a host whose document identity does not move on a
// logical page change; query-string, fragment, and known-volatile checkout
// token churn on the same logical page must not invalidate.
function compactV2EpochDoc(
  session: Session,
  page: OAuthCompletionEvidence["page"] | undefined = operationPageForSession(session),
): string {
  let location = page?.url() ?? session.browser.currentUrl();
  try {
    const parsed = new URL(location);
    if (parsed.origin !== "null" && parsed.origin !== "")
      location = `${parsed.origin}${normalizeVolatileCheckoutPath(parsed.pathname)}`;
  } catch {}
  return createHmac("sha256", session.compactV2Secret)
    .update(`${session.browser.mainDocumentIdentity(page)}\u0000${location}`)
    .digest("base64url");
}

// Weak ownership keeps allocator lifetime bound to the session without retaining
// closed sessions. One namespace/counter serves both action and display refs.
const observationRefs = new WeakMap<Session, StableObservationRefs>();
function compactV2RefAllocator(session: Session): StableObservationRefs {
  let refs = observationRefs.get(session);
  if (!refs) {
    refs = new StableObservationRefs(session.compactV2Secret);
    observationRefs.set(session, refs);
  }
  return refs;
}
function compactV2StableRef(session: Session, doc: string, identity: string): string {
  return compactV2RefAllocator(session).get(doc, identity);
}

/** Reconcile physical anchors once for the shared DOM/action inventory. */
function compactV2Handles(
  session: Session,
  elements: readonly InteractiveElement[],
  page: OAuthCompletionEvidence["page"] | undefined = compactV2SourcePage(session),
): Map<InteractiveElement, string> {
  const doc = compactV2EpochDoc(session, page);
  return compactV2RefAllocator(session).actions(doc, elements);
}

/** The live skeleton for an element inventory, under the session's epoch. */
function compactV2LiveControls(
  session: Session,
  elements: readonly InteractiveElement[],
  page: OAuthCompletionEvidence["page"] | undefined = compactV2SourcePage(session),
  handles: ReadonlyMap<InteractiveElement, string> = compactV2Handles(session, elements, page),
): { rows: SafeControlV2[]; byRef: Map<string, string> } {
  let pageOrigin = "";
  try {
    pageOrigin = new URL(page?.url() ?? session.browser.currentUrl()).origin;
  } catch {}
  const pageUrl = page?.url() ?? session.browser.currentUrl();
  return buildSafeControlsV2({
    elements,
    legacyRefs: provisionElementRefs(elements),
    handles,
    pageOrigin,
    pageUrl,
    canonical: true,
    anchorLabel: (ref, label) => compactV2RefAllocator(session).label(ref, label),
  });
}

function parseCompactV2Cursor(
  session: Session,
  cursor: string,
  expectedScope: string,
): { snapshot: CompactV2PagingSnapshot; offset: number } {
  const [body, signature, extra] = cursor.split(".");
  if (body === undefined || signature === undefined || extra !== undefined)
    throw new Error("invalid_cursor");
  const expected = createHmac("sha256", session.compactV2Secret)
    .update(body)
    .digest("base64url")
    .slice(0, 12);
  if (signature !== expected) throw new Error("invalid_cursor");
  const [id, revRaw, offsetRaw, scope, extraPart] = body.split(":");
  if (
    id === undefined ||
    revRaw === undefined ||
    offsetRaw === undefined ||
    scope === undefined ||
    extraPart !== undefined ||
    scope !== expectedScope
  ) {
    throw new Error("invalid_cursor");
  }
  const rev = Number.parseInt(revRaw, 36);
  const offset = Number.parseInt(offsetRaw, 36);
  if (
    !Number.isSafeInteger(rev) ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    rev.toString(36) !== revRaw ||
    offset.toString(36) !== offsetRaw
  ) {
    throw new Error("stale_cursor");
  }
  const snapshot = compactV2PagingSnapshots.get(session)?.snapshots.get(id);
  if (
    snapshot === undefined ||
    snapshot.scope !== expectedScope ||
    snapshot.epoch.rev !== rev ||
    snapshot.expiresAt < Date.now()
  ) {
    throw new Error("stale_cursor");
  }
  return { snapshot, offset };
}

function compactV2HintPage(
  session: Session,
  snapshot: CompactV2PagingSnapshot,
  offset: number,
): Record<string, unknown> {
  const hint = snapshot.hintPages[offset];
  if (hint === undefined) throw new Error("invalid_cursor");
  const nextOffset = offset + 1;
  const remaining = snapshot.hintPages.length - nextOffset;
  const payload = {
    format: "browser-use-control-query",
    url: "",
    session_id: session.id,
    stage: snapshot.stage,
    hint,
    ...(remaining > 0
      ? {
          hint_overflow: {
            remaining,
            next_cursor: compactV2Cursor(session, snapshot, nextOffset),
          },
        }
      : {}),
  };
  // Start hints are routing metadata; degrade rather than fail the page.
  const degraded = compactV2DegradeMetadata(payload);
  if (degraded === null) throw new Error("compact-v2 budget metadata exceeded");
  return degraded;
}

function compactV2PublicObservation(
  session: Session,
  fields: {
    stage: SafeStageV2;
    guidance?: string;
    oauth?: Observation["oauth"];
    observed?: ObserveDetail;
    terminal?: Observation["terminal"];
    url?: string;
  },
  outputFormat: "compact" | "full" = "full",
): Observation {
  session.compactV2Active = true;
  const payload = {
    format:
      outputFormat === "compact"
        ? ("browser-use-control-query" as const)
        : ("browser-use-dom" as const),
    session_id: session.id,
    url: fields.url ?? session.browser.currentUrl(),
    stage: fields.stage,
    ...(outputFormat === "compact" ? { safe_table: [] } : {}),
    ...(fields.guidance === undefined ? {} : { guidance: fields.guidance }),
    ...(fields.oauth === undefined ? {} : { oauth: fields.oauth }),
    ...(fields.observed === undefined ? {} : { observed: fields.observed }),
    ...(fields.terminal === undefined ? {} : { terminal: fields.terminal }),
  };
  // Fixed metadata (long OAuth-shaped URLs) degrades before observation ever
  // fails; the throw is unreachable from real pages.
  const degraded = compactV2DegradeMetadata(payload as unknown as Record<string, unknown>);
  if (degraded === null) throw new Error("compact-v2 budget metadata exceeded");
  return degraded as unknown as Observation;
}

function compactV2Observation(
  session: Session,
  generation: number,
  capture: BrowserUseCapture,
  semanticSource: ObservationSemanticSourceV2,
  startMetadata?: CompactV2StartMetadata,
  sourcePage?: OAuthCompletionEvidence["page"],
  outputFormat: "compact" | "full" = "full",
  compactActionDelta = false,
  compactMapEmitted = true,
  forceFullDOM = false,
): Observation {
  rememberCompactV2SourcePage(session, sourcePage);
  const elements = capture.elements;
  if (startMetadata?.hintPages !== undefined)
    session.compactV2HintPages = [...startMetadata.hintPages];
  const pageUrl = sourcePage?.url() ?? session.browser.currentUrl();
  const stage = safeStageV2(pageUrl, elements);
  const epochDoc = compactV2EpochDoc(session, sourcePage);
  const previous = session.compactV2Previous;
  const sameDocument = previous !== null && previous.epoch.doc === epochDoc;
  const sameFullDocument = sameDocument && previous.dom !== undefined;
  const handles = compactV2Handles(session, elements, sourcePage);
  const safe = compactV2LiveControls(session, elements, sourcePage, handles);
  const targetableRefs = new Set(safe.rows.map((row) => row.ref));
  const blockers = safeBlockersV2(capture.root, (node) => {
    const element = capture.nodeElements.get(node.id);
    const ref = element === undefined ? undefined : handles.get(element);
    return ref !== undefined && targetableRefs.has(ref) ? ref : undefined;
  });
  const semantics = {
    ...safePageSemanticsV2(semanticSource),
    ...(blockers.length === 0 ? {} : { blockers, blocked: true as const }),
  };
  const rendered = serializeBrowserUseDOM(capture.root, {
    ref: (node) => {
      const element = capture.nodeElements.get(node.id);
      const ref = element === undefined ? undefined : handles.get(element);
      if (ref !== undefined) return ref;
      // Display-only identities share the allocator but not the action namespace.
      return {
        ref: compactV2StableRef(session, epochDoc, `unbound\u001f${node.id}`),
        targetable: false,
      };
    },
    ...(sameFullDocument ? { previous: new Set(previous.renderedRefs ?? []) } : {}),
  });
  // Emit canonical names and text verbatim, preserving whitespace, line order
  // and indentation; no prose extraction or byte-budget pruning.
  const dom = rendered.dom;
  // A changed URL, frame set, or closed-shadow/iframe structure is a real
  // change even when the rendered text is byte-identical: the observation the
  // host already holds describes a page that no longer exists.
  const structurallyChanged =
    previous !== null && (previous.dynamics !== capture.dynamics || previous.url !== pageUrl);
  const changed = !sameFullDocument || previous.dom !== dom || structurallyChanged;
  const epoch = { doc: epochDoc, rev: changed ? generation : previous.epoch.rev };
  session.compactV2Active = true;
  session.compactV2Index = {
    epoch,
    stage,
    semantics,
    rows: safe.rows,
    byRef: safe.byRef,
    expiresAt: Date.now() + 5 * 60_000,
  };
  const canCompactActionDelta =
    outputFormat === "compact" &&
    compactActionDelta &&
    sameDocument &&
    previous.compactMapEmitted === true;
  const currentRefs = new Set(safe.rows.map((row) => row.ref));
  const compactRows = canCompactActionDelta
    ? safe.rows.filter((row) => {
        const prior = previous.byRef.get(row.ref);
        return prior === undefined || !sameCompactV2Control(prior, row);
      })
    : safe.rows;
  const compactRemoved = canCompactActionDelta
    ? [...previous.byRef.keys()].filter((ref) => !currentRefs.has(ref))
    : [];
  let controlSnapshot = retainCompactV2PagingSnapshot(
    session,
    session.compactV2Index,
    compactV2ControlCursorScope(session),
    pageUrl,
    compactRows,
  );
  const hintSnapshot =
    session.compactV2HintPages.length > 1
      ? retainCompactV2PagingSnapshot(
          session,
          session.compactV2Index,
          compactV2HintCursorScope(session),
          pageUrl,
          [],
          session.compactV2HintPages,
        )
      : undefined;
  session.compactV2Refs = safe.byRef;
  session.compactV2Previous = {
    epoch,
    stage,
    semantics,
    byRef: new Map(safe.rows.map((row) => [row.ref, row])),
    ...(outputFormat === "full"
      ? { dom, renderedRefs: rendered.refs, url: pageUrl, dynamics: capture.dynamics }
      : sameFullDocument
        ? {
            dom: previous.dom,
            renderedRefs: previous.renderedRefs,
            url: previous.url,
            dynamics: previous.dynamics,
          }
        : {}),
  };
  if (outputFormat === "compact") {
    const encodePage = (delta: boolean) =>
      encodeV2QueryPage({
        sessionId: session.id,
        stage,
        pageUrl,
        semantics,
        rows: delta ? compactRows : safe.rows,
        ...(delta ? { delta: true as const, removed: compactRemoved } : {}),
        cursorFor: (next) => compactV2Cursor(session, controlSnapshot, next),
        ...(startMetadata === undefined
          ? {}
          : {
              startMetadata: {
                ...(startMetadata.hintPages?.[0] === undefined
                  ? {}
                  : { hint: startMetadata.hintPages[0] }),
                ...(startMetadata.userEmail === undefined
                  ? {}
                  : { userEmail: startMetadata.userEmail }),
                ...(session.compactV2HintPages.length <= 1
                  ? {}
                  : {
                      hintOverflow: {
                        remaining: session.compactV2HintPages.length - 1,
                        next_cursor: compactV2Cursor(session, hintSnapshot!, 1),
                      },
                    }),
              },
            }),
      });
    let page;
    try {
      page = encodePage(canCompactActionDelta);
    } catch (error) {
      if (
        !canCompactActionDelta ||
        !(error instanceof Error) ||
        error.message !== "compact-v2 budget metadata exceeded"
      )
        throw error;
      controlSnapshot = retainCompactV2PagingSnapshot(
        session,
        session.compactV2Index,
        compactV2ControlCursorScope(session),
        pageUrl,
        safe.rows,
      );
      page = encodePage(false);
    }
    if (compactMapEmitted && page.payload.overflow === undefined)
      session.compactV2Previous.compactMapEmitted = true;
    return {
      ...page.payload,
      ...(capture.omissions.length === 0 ? {} : { capture_omissions: capture.omissions }),
    } as unknown as Observation;
  }
  const removed = sameDocument
    ? (previous.renderedRefs ?? []).filter((ref) => !rendered.refs.includes(ref))
    : [];
  return {
    format: "browser-use-dom",
    session_id: session.id,
    url: pageUrl,
    stage,
    ...(sameFullDocument ? { delta: true } : {}),
    ...(changed || forceFullDOM ? { dom } : { dom_unchanged: true as const }),
    ...(removed.length ? { removed } : {}),
    more_above: capture.moreAbove,
    more_below: capture.moreBelow,
    ...(capture.omissions.length === 0 ? {} : { capture_omissions: capture.omissions }),
    ...(startMetadata?.hintPages?.[0] ? { hint: startMetadata.hintPages[0] } : {}),
    ...(startMetadata?.userEmail ? { user_email: startMetadata.userEmail } : {}),
    ...(session.compactV2HintPages.length > 1 && startMetadata
      ? {
          hint_overflow: {
            remaining: session.compactV2HintPages.length - 1,
            next_cursor: compactV2Cursor(session, hintSnapshot!, 1),
          },
        }
      : {}),
  } as unknown as Observation;
}

export async function observeQuery(
  sessionId: string,
  query: string,
  role?: SafeControlV2["role"],
  cursor?: string,
): Promise<Record<string, unknown>> {
  const result = await observeQueryOwned(sessionId, query, role, cursor);
  const oauth = await observedOAuthChallenge(sessionId);
  const threeDs = await observedThreeDsChallenge(sessionId);
  return {
    ...result,
    ...(oauth === undefined ? {} : { oauth }),
    ...(threeDs === undefined ? {} : { three_ds: threeDs }),
  };
}

async function observeQueryOwned(
  sessionId: string,
  query: string,
  role?: SafeControlV2["role"],
  cursor?: string,
): Promise<Record<string, unknown>> {
  const session = sessionForCall(sessionId);
  if (session === undefined) throw new Error(`unknown provision session ${sessionId}`);
  const sourcePage = operationPageForSession(session);
  const needle = norm(query);
  const unfiltered = needle.length === 0 && role === undefined;
  const cursorScope = unfiltered
    ? compactV2ControlCursorScope(session)
    : compactV2QueryCursorScope(session, needle, role);
  if (cursor !== undefined) {
    if (unfiltered) {
      try {
        const parsed = parseCompactV2Cursor(session, cursor, compactV2HintCursorScope(session));
        if (parsed.snapshot.epoch.doc !== compactV2EpochDoc(session, sourcePage))
          throw new Error("stale_cursor");
        return compactV2HintPage(session, parsed.snapshot, parsed.offset);
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "invalid_cursor") throw error;
      }
    }
    const parsed = parseCompactV2Cursor(session, cursor, cursorScope);
    const snapshot = parsed.snapshot;
    if (snapshot.epoch.doc !== compactV2EpochDoc(session, sourcePage)) {
      throw new Error("stale_cursor");
    }
    const page = encodeV2QueryPage({
      sessionId: session.id,
      stage: snapshot.stage,
      pageUrl: snapshot.pageUrl,
      semantics: snapshot.semantics,
      rows: snapshot.rows,
      offset: parsed.offset,
      cursorFor: (next) => compactV2Cursor(session, snapshot, next),
    });
    return page.payload;
  }

  // A cursorless query/role is always a fresh observation. Capture action rows
  // and semantic page hints once, together, before filtering.
  session.generation += 1;
  const capture = await session.browser.extractBrowserUseObservation(sourcePage, true);
  let semanticSource: ObservationSemanticSourceV2 = { title: "", headings: [] };
  try {
    semanticSource = await session.browser.extractObservationSemantics(sourcePage);
  } catch {
    // Semantics are optional; action membership comes from the canonical capture.
  }
  compactV2Observation(
    session,
    session.generation,
    capture,
    semanticSource,
    undefined,
    sourcePage,
    "compact",
    false,
    false,
  );
  const index = session.compactV2Index;
  if (index === null) throw new Error("stale_cursor");
  const liveElements = capture.elements;
  const liveByLegacy = new Map<string, InteractiveElement>();
  for (const [element, legacy] of provisionElementRefs(liveElements)) {
    liveByLegacy.set(legacy, element);
  }
  const ranked = index.rows.flatMap((row, position) => {
    if (role !== undefined && row.role !== role) return [];
    if (needle.length === 0) return [{ row, position, rank: 0 }];
    const legacy = index.byRef.get(row.ref);
    const element = legacy === undefined ? undefined : liveByLegacy.get(legacy);
    const match = element === undefined ? null : controlQueryMatchV2(element, query);
    const semanticMatch = [row.role, row.action, row.field].some(
      (value) => value !== undefined && norm(value) === needle,
    );
    if (match === null && !semanticMatch) return [];
    return [
      {
        row: { ...row, match: match?.provenance ?? ("text" as const) },
        position,
        rank: match?.rank ?? 2,
      },
    ];
  });
  ranked.sort((left, right) => left.rank - right.rank || left.position - right.position);
  const rows = ranked.map(({ row }) => row);
  const pageUrl = sourcePage?.url() ?? session.browser.currentUrl();
  const snapshot = retainCompactV2PagingSnapshot(session, index, cursorScope, pageUrl, rows);
  const page = encodeV2QueryPage({
    sessionId: session.id,
    stage: snapshot.stage,
    pageUrl: snapshot.pageUrl,
    semantics: index.semantics,
    rows,
    cursorFor: (next) => compactV2Cursor(session, snapshot, next),
  });
  return page.payload;
}

function terminalOAuthCompletionObservation(session: Session, url: string): Observation {
  const terminal: NonNullable<Observation["terminal"]> = {
    state: "oauth_completed",
    refs: "unavailable",
    next_action: "operate_observe",
  };
  rememberOAuthCompletionSourcePage(session, undefined);
  rememberCompactV2SourcePage(session, undefined);
  invalidateCompactV2Snapshot(session);
  retainSessionElements(session, []);
  const guidance =
    "OAuth completed in a popup that closed before its controls could be observed. " +
    "Call operate_observe to inspect the active product page.";
  return compactV2PublicObservation(session, {
    stage: safeStageV2(url, []),
    guidance,
    terminal,
    url,
  });
}

async function observeSession(
  session: Session,
  _detail: "compact" | "full" = "compact",
  startMetadata?: CompactV2StartMetadata,
  sourcePage?: OAuthCompletionEvidence["page"],
  preserveSourceBinding = false,
  outputFormat: "compact" | "full" = "full",
  compactActionDelta = false,
  compactMapEmitted = true,
  forceFullDOM = false,
): Promise<Observation> {
  if (sourcePage === undefined) {
    const hadOAuthCompletionSource =
      oauthCompletionSourcePage(session) !== undefined ||
      compactV2SourcePage(session) !== undefined;
    session.browser.takeOAuthTerminalCompletionUrl();
    rememberOAuthCompletionSourcePage(session, undefined);
    rememberCompactV2SourcePage(session, undefined);
    if (hadOAuthCompletionSource) invalidateCompactV2Snapshot(session);
  }
  if (!preserveSourceBinding) rememberOAuthCompletionSourcePage(session, sourcePage);
  const oauthInProgress = (): Observation => {
    invalidateCompactV2Snapshot(session);
    const oauth = oauthTransitionStatus(session.browser);
    const guidance =
      "OAuth in progress: the provider detached or closed its page as expected. " +
      "Do not switch login methods or close the session; call operate_observe again to read the retained product page.";
    const state: NonNullable<Observation["oauth"]> = {
      state: "in_progress",
      provider_page: "closed_or_detached",
      next_action: "operate_observe",
    };
    completeOAuthTransitionRecovery(session.browser);
    return compactV2PublicObservation(
      session,
      {
        stage: "auth",
        guidance,
        oauth: state,
        url: oauth?.productUrl ?? session.startUrl,
      },
      outputFormat,
    );
  };
  try {
    if (sourcePage === undefined) {
      session.browser.recoverActivePage();
      const transition = oauthTransitionStatus(session.browser);
      if (
        transition?.providerPageClosed === true &&
        transition.productPageViable &&
        transition.browserConnected
      ) {
        return oauthInProgress();
      }
    }
    if (sourcePage === undefined) {
      widenAllowedHostsFromUrl(session, session.browser.currentUrl());
    }
    session.generation += 1;
    const generation = session.generation;
    const capture = await session.browser.extractBrowserUseObservation(sourcePage, true);
    retainSessionElements(session, capture.elements);
    let semanticSource: ObservationSemanticSourceV2 = { title: "", headings: [] };
    try {
      semanticSource = await session.browser.extractObservationSemantics(sourcePage);
    } catch {
      // Semantic context is optional availability-wise; it is independently
      // sealed below and never changes action-map safety.
    }
    return compactV2Observation(
      session,
      generation,
      capture,
      semanticSource,
      startMetadata,
      sourcePage,
      outputFormat,
      compactActionDelta,
      compactMapEmitted,
      forceFullDOM,
    );
  } catch (err) {
    const oauth = session.browser ? oauthTransitionStatus(session.browser) : undefined;
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

interface InternalActResult {
  observation: Observation;
  operationPage?: Page;
  outcome: {
    selectedOption?: string;
  };
}

// Fix C: the honest, non-throwing "still waiting on a human" outcome for an
// oauth_login/oauth_click action. `reason` is OAuthAwaitingHumanError's own
// message — always something actually observed (no origin-return within
// budget), never a guessed cause. Mirrors observeSession's oauthInProgress()
// shape so both compact-v2 and legacy hosts get the same treatment: a normal
// (non-error) observation the host re-observes/retries against.
function oauthAwaitingHumanObservation(
  session: Session,
  error: OAuthAwaitingHumanError,
): Observation {
  invalidateCompactV2Snapshot(session);
  const url = session.browser.currentUrl();
  const reason = error.message;
  const guidance =
    error.phase === "not_attempted"
      ? "Not a failure: nothing was clicked, so no challenge is pending. Retry oauth_login."
      : "Not a failure: call operate_observe to check whether the pending challenge has resolved.";
  const oauth: NonNullable<Observation["oauth"]> = {
    state: "awaiting_human",
    reason,
    ...(error.challenge === undefined ? {} : { challenge: error.challenge }),
    ...(error.notification === undefined ? {} : { notification: error.notification }),
    next_action: "operate_observe",
  };
  return compactV2PublicObservation(session, { stage: "auth", guidance, oauth, url });
}

function oauthErrorAfterDispatchAttempt(session: Session, error: unknown): Observation | null {
  if (
    operatorMutationDispatchPhase() !== "dispatch_attempted" ||
    error instanceof ProvenPreDispatchMutationError ||
    clickDispatchStatusForError(error) === "not_dispatched" ||
    error instanceof OAuthFailedError ||
    error instanceof OAuthAwaitingHumanError ||
    error instanceof OAuthOnboardingRequiredError
  ) {
    return null;
  }
  invalidateCompactV2Snapshot(session);
  const url = session.browser.currentUrl();
  const guidance =
    "OAuth progress is unconfirmed because an error interrupted the action after dispatch was attempted. " +
    "Call operate_observe before deciding the next action; do not repeat the OAuth action.";
  const oauth: NonNullable<Observation["oauth"]> = {
    state: "in_progress",
    completion: "unknown",
    next_action: "operate_observe",
  };
  return compactV2PublicObservation(session, { stage: "auth", guidance, oauth, url });
}

function oauthOnboardingRequiredObservation(
  session: Session,
  error: OAuthOnboardingRequiredError,
): Observation {
  invalidateCompactV2Snapshot(session);
  const url = session.browser.currentUrl();
  const guidance =
    "OAuth provider consent is complete. The relying party requires user-supplied onboarding information; inspect the current form and do not click OAuth consent again.";
  const oauth: NonNullable<Observation["oauth"]> = {
    state: "onboarding_required",
    reason: error.message,
    next_action: "operate_observe",
  };
  return compactV2PublicObservation(session, { stage: "form", guidance, oauth, url });
}

async function actInternally(
  sessionId: string,
  action: ProvisionAction,
  detail: ObserveDetail = "compact",
  compactV2Authorization?: CompactV2TargetAuthorization,
  operationPage?: Page,
): Promise<InternalActResult> {
  const session = sessionForCall(sessionId);
  const capturedOperationPage =
    operationPage ?? (session === undefined ? undefined : operationPageForSession(session));
  const oauthProvider =
    action.kind === "oauth_login" || action.kind === "oauth_click" ? action.provider : undefined;
  try {
    const execute = async (deadline?: OAuthActionDeadline): Promise<InternalActResult> => {
      const run = async (): Promise<InternalActResult> =>
        await executeAct(
          sessionId,
          action,
          detail,
          true,
          compactV2Authorization,
          deadline,
          capturedOperationPage,
          false,
        );
      return (action.kind === "click" ||
        action.kind === "js_click" ||
        action.kind === "oauth_login" ||
        action.kind === "oauth_click") &&
        session !== undefined
        ? await withOpenedTabAdoptionLease(session.browser, run)
        : await run();
    };
    return session !== undefined && (action.kind === "oauth_login" || action.kind === "oauth_click")
      ? await withOAuthActionBoundary(session, oauthProvider, execute)
      : await execute(undefined);
  } catch (error) {
    if (session !== undefined && (action.kind === "oauth_login" || action.kind === "oauth_click")) {
      const progress = oauthErrorAfterDispatchAttempt(session, error);
      if (progress !== null) return { observation: progress, outcome: {} };
    }
    // Fix C: an OAuth wait timing out is honest uncertainty, not a failure —
    // return it as a normal (non-throwing) observation instead of an error.
    if (error instanceof OAuthAwaitingHumanError && session !== undefined) {
      return { observation: oauthAwaitingHumanObservation(session, error), outcome: {} };
    }
    if (error instanceof OAuthOnboardingRequiredError && session !== undefined) {
      return { observation: oauthOnboardingRequiredObservation(session, error), outcome: {} };
    }
    if (session?.compactV2Active === true && !(error instanceof ProvisionTargetMissingError)) {
      throw new CompactV2ActionFailureError(compactV2ActionFailureReason(error, action.kind));
    }
    throw error;
  }
}

export async function act(
  sessionId: string,
  action: ProvisionAction,
  detail: ObserveDetail = "compact",
  outputFormat: "compact" | "full" = "full",
  compactMapEmitted = true,
): Promise<Observation> {
  const session = sessionForCall(sessionId);
  const capturedOperationPage =
    session === undefined ? undefined : operationPageForSession(session);
  let screenshotDispatched = false;
  const oauthProvider =
    action.kind === "oauth_login" || action.kind === "oauth_click" ? action.provider : undefined;
  try {
    let queuedOAuthAuthorization: CompactV2TargetAuthorization | undefined;
    let preparedOAuthDispatch = false;
    const prepared = preparedOAuthLoginTarget.getStore();
    if (
      action.kind === "oauth_login" &&
      prepared?.sessionId === sessionId &&
      prepared.target === action.target
    ) {
      queuedOAuthAuthorization = prepared.authorization;
      preparedOAuthDispatch = true;
    } else if (session?.compactV2Active === true && action.kind === "oauth_login") {
      try {
        queuedOAuthAuthorization = compactV2AuthorizationForTarget(session, action.target);
      } catch (error) {
        audit(sessionId, "act", { kind: action.kind, target: "<rejected-v2-target>" });
        throw error;
      }
    }
    const execute = async (deadline?: OAuthActionDeadline): Promise<InternalActResult> => {
      const run = async (): Promise<InternalActResult> =>
        await executeAct(
          sessionId,
          action,
          detail,
          false,
          queuedOAuthAuthorization,
          deadline,
          capturedOperationPage,
          preparedOAuthDispatch,
          () => {
            screenshotDispatched = true;
          },
          outputFormat,
          compactMapEmitted,
        );
      return (action.kind === "click" ||
        action.kind === "js_click" ||
        action.kind === "oauth_login" ||
        action.kind === "oauth_click") &&
        session !== undefined
        ? await withOpenedTabAdoptionLease(session.browser, run)
        : await run();
    };
    const result =
      session !== undefined && (action.kind === "oauth_login" || action.kind === "oauth_click")
        ? await withOAuthActionBoundary(session, oauthProvider, execute)
        : await execute(undefined);
    const threeDs = await observedThreeDsChallenge(sessionId);
    return threeDs === undefined
      ? result.observation
      : { ...result.observation, three_ds: threeDs };
  } catch (error) {
    if (action.kind === "click" && action.screenshot) {
      if (error instanceof ScreenshotClickError) throw error;
      if (screenshotDispatched)
        throw new ScreenshotClickError("screenshot_click_uncertain", "dispatched");
    }
    if (session !== undefined && (action.kind === "oauth_login" || action.kind === "oauth_click")) {
      const progress = oauthErrorAfterDispatchAttempt(session, error);
      if (progress !== null) return progress;
    }
    // Fix C: an OAuth wait timing out is honest uncertainty, not a failure —
    // return it as a normal (non-throwing) observation instead of an error.
    if (error instanceof OAuthAwaitingHumanError && session !== undefined) {
      return oauthAwaitingHumanObservation(session, error);
    }
    if (error instanceof OAuthOnboardingRequiredError && session !== undefined) {
      return oauthOnboardingRequiredObservation(session, error);
    }
    if (
      ["oauth_login", "click", "js_click", "type", "type_secret", "select"].includes(action.kind) &&
      operatorMutationDispatchPhase() !== "dispatch_attempted"
    ) {
      if (error instanceof ProvenPreDispatchMutationError) throw error;
      if (error instanceof CompactV2StaleRefError) {
        throw new ProvenPreDispatchMutationError("stale_ref", { cause: error });
      }
    }
    if (session?.compactV2Active === true) {
      // Preserve only the retry evidence consumed by operate_click. Raw browser
      // diagnostics and every other action failure keep the existing mapping.
      if (
        action.kind === "click" &&
        clickDispatchStatusForError(error) === "not_dispatched" &&
        error instanceof Error &&
        /intercepts pointer events/.test(error.message)
      ) {
        throw new BrowserClickDispatchError(
          "not_dispatched",
          new Error("click failed: intercepts pointer events"),
        );
      }
      throw new Error(compactV2ActionFailureReason(error, action.kind));
    }
    throw error;
  }
}

// ── Contract C act targets ──
// The driver (BrowserController's Contract C verbs) owns frame-vs-page
// dispatch; executeAct only resolves a fresh observation element to a
// DriverTarget and picks the verb.

function actDriverTarget(el: InteractiveElement): DriverTarget {
  const frame = frameTargetFor(el);
  if (frame !== null) return { kind: "frame", frame, selector: el.selector };
  return { kind: "selector", selector: el.selector };
}

// Re-resolve against FRESH elements — never trust a stale index. Shared by the
// type_secret / select / click-group ref paths; `internalLabel`/`noMatchPrefix`
// keep each caller's error wording, `withVisibleCandidates` its candidate list.
async function resolveFreshActTarget(
  session: Session,
  browser: BrowserController,
  compactV2ActionPage: Page | undefined,
  compactV2Authorization: CompactV2TargetAuthorization | undefined,
  resolutionTarget: string,
  internalAccess: boolean,
  internalLabel: string,
  noMatchPrefix: string,
  actionTarget: string,
  withVisibleCandidates: boolean,
): Promise<{ el: InteractiveElement; fresh: InteractiveElement[] }> {
  const fresh = (await browser.extractBrowserUseObservation(compactV2ActionPage)).elements;
  retainSessionElements(session, fresh);
  // resolveTarget recomputes identities (incl. volatile positional-group
  // fingerprints) from these FRESH elements, so a ref whose group fingerprint
  // changed since the last observe resolves to null, not a survivor (#399).
  const el =
    compactV2Authorization === undefined
      ? resolveTarget(fresh, resolutionTarget)
      : resolveAuthorizedCompactV2Target(session, fresh, compactV2Authorization);
  if (el !== null) return { el, fresh };
  if (session.compactV2Active) {
    if (!internalAccess) throwCompactV2StaleRef();
    throw new Error(`${internalLabel}: internal live target changed`);
  }
  const stale = staleTargetError(session, actionTarget, fresh);
  if (stale !== null) throw stale;
  const prefix = noMatchPrefix === "" ? "" : `${noMatchPrefix}: `;
  const visible = withVisibleCandidates
    ? " Visible: " +
      fresh
        .map((e) => `"${e.screenPath ?? elementRef(e)}"`)
        .slice(0, 20)
        .join(", ")
    : "";
  throw new Error(`${prefix}no element matched target "${actionTarget}".${visible}`);
}

async function executeAct(
  sessionId: string,
  action: ProvisionAction,
  detail: ObserveDetail,
  internalAccess: boolean,
  internalAuthorization?: CompactV2TargetAuthorization,
  oauthDeadline?: OAuthActionDeadline,
  operationPage?: Page,
  preparedOAuthDispatch = false,
  onScreenshotDispatched?: () => void,
  outputFormat: "compact" | "full" = "full",
  compactMapEmitted = true,
): Promise<InternalActResult> {
  const session = sessionForCall(sessionId);
  if (session === undefined) throw new Error(`unknown provision session ${sessionId}`);
  let browser = session.browser;
  const compactV2ActionPage = operationPage ?? operationPageForSession(session);
  let actionPageAfter = compactV2ActionPage;
  let completedAction: ProvisionAction = action;
  let resolutionTarget: string | undefined;
  let auditTarget: string | undefined;
  let compactV2Authorization = internalAuthorization;
  if ("target" in action && !(action.kind === "click" && action.screenshot)) {
    if (session.compactV2Active && !internalAccess) {
      try {
        compactV2Authorization ??= compactV2AuthorizationForTarget(
          session,
          action.target,
          action.kind === "click",
        );
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
  if (compactV2ActionPage?.isClosed()) {
    if (action.kind === "click" && action.screenshot)
      throw new ScreenshotClickError("stale_screenshot", "not_dispatched");
    if (!("target" in action)) throw new Error("action source page is closed");
    if (session.compactV2Active) throwCompactV2StaleRef();
    throw new TargetStaleError({
      status: "target_stale",
      target: action.target,
      after_generation: session.generation,
      reobserve_required: true,
      replacement_candidates: {} as Record<string, string[]>,
      retry_policy: "do_not_retry_old_ref",
    });
  }
  audit(sessionId, "act", {
    kind: action.kind,
    ...(auditTarget !== undefined ? { target: auditTarget } : {}),
    ...("url" in action
      ? { url: session.compactV2Active ? compactV2AuditUrl(action.url) : action.url }
      : {}),
  });

  // The URL the action is taken ON — captured BEFORE the action navigates.
  const urlBeforeAction = compactV2ActionPage?.url() ?? browser.currentUrl();
  // Document identity BEFORE the action dispatches, so the return can report
  // honestly whether the document changed while the action was settling.
  let docBeforeAction: string | undefined;
  try {
    docBeforeAction = browser.mainDocumentIdentity(compactV2ActionPage);
  } catch {
    docBeforeAction = undefined;
  }

  // Contract C dispatch: every browser action below goes through exactly one
  // driver-verb call site per verb; the driver owns frame-vs-page dispatch.
  // An action page that is NOT the active page is dispatched untracked
  // (pre-existing semantics); the active page keeps dispatch tracking for
  // ordinary clicks and js_click never tracks.
  const actType = async (target: DriverTarget, text: string, sealed: boolean): Promise<void> => {
    await browser.type(target, text, sealed, compactV2ActionPage);
  };
  const actClick = async (target: DriverTarget & { method: ClickMethod }): Promise<void> => {
    const dispatchPage =
      compactV2ActionPage !== undefined && !browser.isActivePage(compactV2ActionPage)
        ? compactV2ActionPage
        : undefined;
    await browser.click(target, dispatchPage);
  };

  try {
    switch (action.kind) {
      case "goto": {
        await browser.navigate(action.url, compactV2ActionPage);
        break;
      }
      case "press": {
        await browser.press(action.key, compactV2ActionPage);
        break;
      }
      case "oauth_settle": {
        actionPageAfter = await settleAfterOAuth(browser, compactV2ActionPage);
        rememberOAuthCompletionSourcePage(session, actionPageAfter);
        break;
      }
      case "scroll": {
        await browser.scroll(action.direction ?? "down", compactV2ActionPage);
        break;
      }
      case "type_secret": {
        const value = session.secretSlots.get(action.slot);
        if (value === undefined) {
          throw new CompactV2ActionFailureError(
            "missing_secret_slot: no sealed slot is loaded. For a saved login, call " +
              "operate_fill_credential with session_id, reference (or service), and fields. " +
              "Use list_credentials to read the credential's field_names; pass those exact names " +
              '(for example fields:["username","password"], or ["login","password"]). ' +
              "Then call operate_type with ref and the returned slot name for each field. " +
              "For a page value instead, use operate_extract with into_slot first.",
          );
        }
        const locator = parseLocatorTarget(resolutionTarget!);
        if (locator !== null) {
          const resolved = await browser.resolvePageTarget(
            locator.mode,
            locator.value,
            "type",
            compactV2ActionPage,
          );
          if (!resolved.ok) {
            if (resolved.reason === "none") {
              throw new Error(`type_secret: no element matched locator "${action.target}".`);
            }
            throw new AmbiguousProvisionTargetError(action.target, resolved.candidates);
          }
          try {
            await browser.typeHandle(resolved.handle, value, true);
          } finally {
            await resolved.handle.dispose().catch(() => undefined);
          }
          audit(sessionId, "type_secret", {
            slot: action.slot,
            locator_mode: locator.mode,
            host: registrableHost(urlBeforeAction),
          });
          break;
        }
        const el = (
          await resolveFreshActTarget(
            session,
            browser,
            compactV2ActionPage,
            compactV2Authorization,
            resolutionTarget!,
            internalAccess,
            "type_secret",
            "type_secret",
            action.target,
            false,
          )
        ).el;
        // Type the REAL value into the page. It crosses only browser↔page; the
        // value is never returned to the host and never logged.
        await actType(actDriverTarget(el), value, true);
        audit(sessionId, "type_secret", {
          slot: action.slot,
          target: auditTarget,
          host: registrableHost(urlBeforeAction),
        });
        break;
      }
      case "select": {
        const el = (
          await resolveFreshActTarget(
            session,
            browser,
            compactV2ActionPage,
            compactV2Authorization,
            resolutionTarget!,
            internalAccess,
            "select",
            "select",
            action.target,
            true,
          )
        ).el;
        const committedText = await browser.select(
          actDriverTarget(el),
          action.text,
          compactV2ActionPage,
        );
        session.committedSelectValues.set(
          compactV2CommittedSelectKey(session, el.selector),
          compactV2CommittedSelectValue(session, committedText),
        );
        completedAction = { ...action, text: committedText };
        await settleAfterStateChange(browser, compactV2ActionPage);
        break;
      }
      case "set_phone_country": {
        // No captured element — the bot finds the phone-local native <select>.
        await browser.setPhoneCountry(action.country, compactV2ActionPage);
        await settleAfterStateChange(browser, compactV2ActionPage);
        break;
      }
      case "click":
      case "js_click":
      case "type":
      case "upload":
      case "oauth_click": {
        if (action.kind === "click" && action.screenshot) {
          if (!compactV2ActionPage)
            throw new ScreenshotClickError("stale_screenshot", "not_dispatched");
          actionPageAfter =
            (await adoptTabOpenedByClick(session, browser, async () => {
              await clickScreenshot(compactV2ActionPage, action.screenshot!, () => undefined);
              onScreenshotDispatched?.();
            })) ?? actionPageAfter;
          await settleAfterStateChange(browser, compactV2ActionPage);
          if (browser.isActivePage(compactV2ActionPage)) {
            actionPageAfter = (await adoptOpenedTab(session, browser, 0)) ?? actionPageAfter;
          }
          break;
        }
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
            compactV2ActionPage,
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
          // Mark the session non-promotable BEFORE the action: a locator action can't
          // be replayed from the inventory (the element was never in it), so a
          // skill synthesized from this run would silently omit the step. Setting
          // it up front means an action that lands but then throws still can't leave
          // the session promotable (see captureAndPromoteSession) (codex).
          try {
            if (action.kind === "click" || action.kind === "js_click") {
              actionPageAfter =
                (await adoptTabOpenedByClick(session, browser, async () => {
                  await actClick({
                    kind: "handle",
                    handle: resolved.handle,
                    method: action.kind,
                  });
                })) ?? actionPageAfter;
            } else await actType({ kind: "handle", handle: resolved.handle }, action.text, false);
          } finally {
            await resolved.handle.dispose().catch(() => undefined);
          }
          audit(sessionId, action.kind, {
            locator_mode: locator.mode,
            host: registrableHost(urlBeforeAction),
          });
          if (action.kind !== "type") {
            await settleAfterStateChange(browser, compactV2ActionPage);
            // A tab opened by JS a tick after the click lands during the
            // settle above, not inside the click's own grace window. Drain it
            // here — the queue is already populated, so this costs nothing.
            if (compactV2ActionPage === undefined || browser.isActivePage(compactV2ActionPage)) {
              actionPageAfter = (await adoptOpenedTab(session, browser, 0)) ?? actionPageAfter;
            }
          }
          break;
        }
        // Re-resolve against FRESH elements every act — never trust a stale index.
        const { el, fresh } = await resolveFreshActTarget(
          session,
          browser,
          compactV2ActionPage,
          compactV2Authorization,
          resolutionTarget!,
          internalAccess,
          action.kind,
          "",
          action.target,
          true,
        );
        // Preserve frame identity (origin + path) for the frame-scoped fill.
        if (action.kind === "click" || action.kind === "js_click") {
          actionPageAfter =
            (await adoptTabOpenedByClick(session, browser, async () => {
              await actClick({ ...actDriverTarget(el), method: action.kind });
            })) ?? actionPageAfter;
        } else if (action.kind === "type") {
          clearCommittedSelectValue(session, el.selector);
          const actTarget = actDriverTarget(el);
          await actType(actTarget, action.text, false);
          // #635 fix (not a gate on typing): Shopify only enables delivery-rate
          // selection after the required address line is committed by
          // blur/change, not merely after the raw keystrokes land.
          if (actTarget.kind === "selector" && isRequiredShippingAddressLine1(el)) {
            await browser.commitRequiredShippingAddressLine1(el.selector, compactV2ActionPage);
          }
        } else if (action.kind === "upload") {
          if (compactV2ActionPage !== undefined) {
            await browser.uploadFileOnPage(compactV2ActionPage, el.selector, action.path);
          } else {
            await browser.uploadFile(el.selector, action.path);
          }
          audit(sessionId, "upload", {
            target: auditTarget,
            path: session.compactV2Active ? "<local-file>" : action.path,
            host: registrableHost(urlBeforeAction),
          });
        } else {
          if (compactV2ActionPage !== undefined && !browser.isActivePage(compactV2ActionPage)) {
            throwCompactV2StaleRef();
          }
          if (oauthDeadline === undefined) {
            throw new Error("OAuth action deadline was not established");
          }
          browser = await runSerializedOAuthBoundary(
            session,
            el,
            fresh,
            action.provider,
            oauthDeadline,
            compactV2Authorization,
          );
          const completedPage = browser.completedOAuthPage() ?? undefined;
          rememberOAuthCompletionSourcePage(session, completedPage);
          actionPageAfter = completedPage ?? actionPageAfter;
        }
        if (action.kind !== "type") {
          await settleAfterStateChange(browser, compactV2ActionPage);
        }
        // Only a plain click follows a tab it opened. oauth_click owns its own
        // provider-page lifecycle and upload never opens one.
        if (
          (action.kind === "click" || action.kind === "js_click") &&
          (compactV2ActionPage === undefined || browser.isActivePage(compactV2ActionPage))
        ) {
          actionPageAfter = (await adoptOpenedTab(session, browser, 0)) ?? actionPageAfter;
        }
        break;
      }
      case "oauth_login": {
        if (compactV2ActionPage !== undefined && !browser.isActivePage(compactV2ActionPage)) {
          throwCompactV2StaleRef();
        }
        // Atomic OAuth deliberately accepts only the observed stable ref. A raw
        // locator would lose the same stale-reference guarantees as every other
        // action before the provider transition begins.
        const fresh = (await browser.extractBrowserUseObservation(compactV2ActionPage)).elements;
        retainSessionElements(session, fresh);
        const el =
          compactV2Authorization === undefined
            ? resolveTarget(fresh, resolutionTarget!)
            : resolveAuthorizedCompactV2Target(session, fresh, compactV2Authorization);
        if (el === null) {
          if (session.compactV2Active) {
            if (!internalAccess) throwCompactV2StaleRef();
            throw new Error("oauth_login: internal live target changed");
          }
          throw new Error(
            `oauth_login: no element matched target "${action.target}". Re-observe and use the OAuth button ref.`,
          );
        }
        if (oauthDeadline === undefined) {
          throw new Error("OAuth action deadline was not established");
        }
        browser = await runSerializedOAuthBoundary(
          session,
          el,
          fresh,
          action.provider,
          oauthDeadline,
          compactV2Authorization,
          preparedOAuthDispatch,
        );
        const completedPage = browser.completedOAuthPage() ?? undefined;
        rememberOAuthCompletionSourcePage(session, completedPage);
        actionPageAfter = completedPage ?? actionPageAfter;
        break;
      }
    }
  } finally {
    // An act no longer retires the action map. Refs are node-bound and
    // re-resolved live against the observed epoch on every act, so the agent can
    // fill a whole form from one observation. Only LEAVING the observed document
    // retires them — the same condition the authorization check enforces — so
    // drop the snapshot exactly then, and fail closed if the epoch is unreadable.
    if (session.compactV2Index !== null) {
      let stillObservedDocument = false;
      try {
        stillObservedDocument = session.compactV2Index.epoch.doc === compactV2EpochDoc(session);
      } catch {}
      if (!stillObservedDocument) invalidateCompactV2Snapshot(session);
    }
  }
  if (action.kind === "click" || action.kind === "js_click") {
    actionPageAfter = returnFromClosedPicker(session, actionPageAfter);
  }
  // `detail:"none"` returns a minimal ack (the action ran; no perception emitted)
  // so multi-field fills don't each echo the page. The host must call
  // operate_observe before its next ref-targeted act (refs aren't refreshed here).
  const terminalOAuthCompletionUrl = browser.takeOAuthTerminalCompletionUrl();
  const actionObservationPage = actionPageAfter;
  const observation =
    terminalOAuthCompletionUrl !== null
      ? terminalOAuthCompletionObservation(session, terminalOAuthCompletionUrl)
      : detail === "none" && action.kind !== "oauth_login"
        ? compactV2PublicObservation(session, {
            stage: safeStageV2(
              actionObservationPage?.url() ?? browser.currentUrl(),
              session.lastElements,
            ),
            observed: "none",
            url: actionObservationPage?.url() ?? browser.currentUrl(),
          })
        : await observeSession(
            session,
            detail === "none" ? "compact" : detail,
            undefined,
            actionObservationPage,
            true,
            outputFormat,
            outputFormat === "compact",
            compactMapEmitted,
          );
  const actionDocAfter = (() => {
    try {
      return browser.mainDocumentIdentity(actionObservationPage);
    } catch {
      return undefined;
    }
  })();
  const navigatedDuringSettle =
    docBeforeAction !== undefined &&
    actionDocAfter !== undefined &&
    docBeforeAction !== actionDocAfter;
  const observationWithNavigation = navigatedDuringSettle
    ? ({ ...observation, navigated: true } as typeof observation)
    : observation;
  return {
    ...(actionPageAfter === undefined ? {} : { operationPage: actionPageAfter }),
    observation:
      completedAction.kind === "select" && observationWithNavigation.format !== "browser-use-dom"
        ? { ...observationWithNavigation, selected_option: completedAction.text }
        : observationWithNavigation,
    outcome: {
      ...(completedAction.kind === "select" ? { selectedOption: completedAction.text } : {}),
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
  outputFormat: "compact" | "full" = "full",
): Promise<{ session_id: string; fields: FormSelectManyFieldResult[]; observation: Observation }> {
  const fields: FormSelectManyFieldResult[] = [];
  const session = sessionForCall(sessionId);
  if (session === undefined) throw new Error(`unknown provision session ${sessionId}`);
  const operationPage = operationPageForSession(session);
  const selectionEntries = Object.entries(selections);

  for (let index = 0; index < selectionEntries.length; index += 1) {
    const [label, option] = selectionEntries[index]!;
    const publicLabel =
      session.compactV2Active && !isCompactV2Handle(label) && !isCompactV2Label(label)
        ? "<rejected-v2-target>"
        : label;
    const publicSelection = session.compactV2Active
      ? { label: publicLabel }
      : { label: publicLabel, option };
    let authorization: CompactV2TargetAuthorization | undefined;
    if (session.compactV2Active) {
      try {
        authorization = compactV2AuthorizationForTarget(session, label);
      } catch (error) {
        audit(sessionId, "act", { kind: "select_many", target: "<rejected-v2-target>" });
        if (index === 0) throw error;
        fields.push({
          ...publicSelection,
          status: "failed",
          reason: compactV2SelectionFailureReason(error),
        });
        if (index + 1 < selectionEntries.length) {
          await observeSession(session, "compact", undefined, operationPage);
        }
        continue;
      }
    }
    try {
      const target = authorization?.legacyRef ?? label;
      const actionResult = await actInternally(
        sessionId,
        { kind: "select", target, text: option },
        "none",
        authorization,
        operationPage,
      );
      const selectedOption = actionResult.outcome.selectedOption;
      if (selectedOption === undefined) {
        throw new Error("select: successful action omitted the selected option");
      }
      // `detail:none` is intentionally a minimal ack. The explicit observe here
      // refreshes the DOM generation between every potentially mutating select.
      await observeSession(session, "compact", undefined, operationPage);
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
        await observeSession(session, "compact", undefined, operationPage);
      }
    }
  }

  return {
    session_id: sessionId,
    fields,
    observation: await observeSession(
      session,
      "compact",
      undefined,
      operationPage,
      false,
      outputFormat,
      outputFormat === "compact",
    ),
  };
}

function compactV2SelectionFailureReason(error: unknown): string {
  return compactV2ActionFailureReason(error, "select");
}

function compactV2ActionFailureReason(error: unknown, kind: ProvisionAction["kind"]): string {
  if (error instanceof CompactV2ActionFailureError) return error.message;
  // Fix C: report the honest, observed outcome — never the removed
  // unverified-cause string ("the saved session may have expired"). A
  // pending `awaiting_human` normally returns as a non-throwing observation
  // (see act()/actInternally() below); this branch is a defensive fallback
  // for any caller of this reason-mapper that doesn't go through that path.
  if (error instanceof OAuthAwaitingHumanError) return "awaiting_human";
  if (error instanceof OAuthFailedError) return error.message;
  if (error instanceof CompactV2UnresolvedLabelError) return "target_unresolved";
  if (error instanceof ScreenshotClickError) return error.code;
  if (error instanceof CompactV2StaleRefError) return "stale_ref";
  if (error instanceof TargetStaleError) return "reobserve_required";
  if (error instanceof ProvisionTargetNotAllowedError) {
    // 2026-09-06 dogfood: a bare `target_not_allowed` gave the agent no host,
    // no allowlist, and no remedy — a recoverable step died as a dead end.
    // Preserve the refusal detail and stable leading token callers
    // match on and append that detail. Machine-readable-first: everything
    // before the first colon is unchanged.
    return `target_not_allowed: ${error.message}`;
  }
  // select failures route through Playwright's own error text, which embeds
  // selector/option strings that can be private page content — keep that
  // path a bare, scrubbed "selection_failed" (see the private-selection
  // tests in operate-session-flow.test.ts). Any other action kind gets the
  // same target_not_allowed treatment: a blocking failure on a legitimate
  // action must carry its reason, never collapse to an opaque dead end.
  if (kind === "select") return "selection_failed";
  return error instanceof Error && error.message.length > 0
    ? `action_failed: ${error.message}`
    : "action_failed";
}

// PR3 privacy: in the operator model the host fills the USER's real email into
// signup forms (no Squire alias anymore). The recipe trace must NOT persist that
// literal address — it would land in operator recipes and any skill synthesized
// from them. Templatize an email-shaped `type` value to the established email
// slot token so the trace stays a recipe, not a record of someone's address.
// Mirrors the synthesizer's looksLikeEmail check (promote-to-skill.ts). The token
// name keeps its legacy form for corpus compatibility (validateReplayGraph and
// published skills key off it); it now means "the email to fill", not a Squire alias.
const OPENED_TAB_GRACE_MS = 300;

const openedTabAdoptionTails = new WeakMap<BrowserController, Promise<void>>();

async function withOpenedTabAdoptionLease<T>(
  browser: BrowserController,
  run: () => Promise<T>,
): Promise<T> {
  const previous = openedTabAdoptionTails.get(browser) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>((resolve) => {
    release = resolve;
  });
  openedTabAdoptionTails.set(
    browser,
    previous.then(
      () => turn,
      () => turn,
    ),
  );
  await previous.catch(() => undefined);
  try {
    return await run();
  } finally {
    release();
  }
}

async function adoptOpenedTab(
  session: Session,
  browser: BrowserController,
  graceMs: number,
): Promise<Page | undefined> {
  const url = await browser.adoptOpenedTab(graceMs).catch(() => null);
  if (url === null) return undefined;
  const page = browser.activePage();
  if (page !== null && oauthCompletionSourcePage(session) !== undefined) {
    rememberOAuthCompletionSourcePage(session, page);
  } else if (page !== null && session.compactV2Active) {
    rememberCompactV2SourcePage(session, page);
  }
  audit(session.id, "new_tab_adopted", { host: registrableHost(url) });
  return page ?? undefined;
}

async function adoptTabOpenedByClick(
  session: Session,
  browser: BrowserController,
  click: () => Promise<void>,
): Promise<Page | undefined> {
  browser.armOpenedTabAdoption();
  let adopted: Page | undefined;
  try {
    await click();
  } finally {
    adopted = await adoptOpenedTab(session, browser, OPENED_TAB_GRACE_MS);
  }
  return adopted;
}

async function settleAfterStateChange(browser: BrowserController, page?: Page): Promise<void> {
  // A fixed dwell here used to consume the OAuth action's completion window
  // after the provider had already returned. Wait for the page's actual
  // interactive state instead; it resolves immediately when the redirect has
  // rendered and remains bounded for slow SPAs.
  await browser.waitForInteractiveDom(1, 2_000, page).catch(() => undefined);
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
}

const normLabelKey = (label: string): string =>
  label
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/gi, "")
    .toLowerCase()
    .slice(0, 40);

function firstTokenMatching(haystack: string, re: RegExp): string | null {
  const match = haystack.match(re);
  return match?.[0] ?? null;
}

export function sanitizeExtractedCredentials(
  credentials: Record<string, string>,
  url: string,
  haystack = Object.values(credentials).join("\n"),
  acceptedNearCopyCredential: string | null = null,
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
    if (
      (k === "key" || k === "api_key") &&
      value !== acceptedNearCopyCredential &&
      !looksLikeCredentialValue(value)
    )
      continue;
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
/** What a zero-match capture DID find, so the caller can pick a better source
 * on the next try: computed roles and accessible names only — never values. */
export interface CaptureFoundCandidate {
  role: string;
  name: string | null;
}

async function shadowPiercingCapture(
  page: Page,
  source: CaptureSource,
  handles: ElementHandle<Node>[],
  containerHandles: ElementHandle<Node>[],
): Promise<{ candidate_count: number; value?: string; found?: CaptureFoundCandidate[] }> {
  return await page.evaluate(
    ({ source: spec, nodes: sourceNodes, scopeNodes: containerNodes }) => {
      const captureElement = (node: Node): Element => {
        if (!(node instanceof Element) || !node.isConnected || node.ownerDocument !== document)
          throw new Error("capture source changed");
        return node;
      };
      // Playwright's role engine maps password inputs to textbox; ARIA gives
      // them no role, so they never satisfy a textbox request.
      const nodes = sourceNodes
        .map(captureElement)
        .filter(
          (el) =>
            !(
              "role" in spec &&
              spec.role === "textbox" &&
              el instanceof HTMLInputElement &&
              el.type === "password"
            ),
        );
      const scopeNodes = containerNodes.map(captureElement);
      const nativeShadowGet = Object.getOwnPropertyDescriptor(Element.prototype, "shadowRoot")?.get;
      const shadowRootOf = (el: Element): ShadowRoot | null => {
        try {
          return nativeShadowGet?.call(el) ?? null;
        } catch {
          return null;
        }
      };

      const isVisible = (el: Element): boolean => {
        const r = el.getBoundingClientRect?.();
        if (!r || r.width <= 0 || r.height <= 0) return false;
        const s = window.getComputedStyle(el);
        return (
          s.display !== "none" && s.visibility !== "hidden" && parseFloat(s.opacity || "1") > 0.01
        );
      };

      // Walk the light DOM and every OPEN shadow root. Defensive against
      // detached/closed custom elements whose shadowRoot reads undefined at
      // runtime (the #59 redis-cloud crash pattern): skip such nodes.
      const elements: Element[] = [];
      const walk = (root: Document | ShadowRoot | null | undefined): void => {
        if (root == null || typeof root.querySelectorAll !== "function") return;
        for (const el of Array.from(root.querySelectorAll("*"))) {
          elements.push(el);
          walk(shadowRootOf(el));
        }
      };
      walk(document);

      const accessibleName = (el: Element): string => {
        const root = el.getRootNode() as Document | ShadowRoot;
        const labelledby = el.getAttribute("aria-labelledby");
        if (labelledby) {
          const text = labelledby
            .split(/\s+/)
            .map((id) => root.getElementById(id)?.textContent ?? "")
            .join(" ")
            .trim();
          if (text) return text;
        }
        const label = (el.getAttribute("aria-label") ?? "").trim();
        if (label) return label;
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          const text = Array.from(el.labels ?? [])
            .map((label) => label.textContent ?? "")
            .join(" ")
            .trim();
          if (text) return text;
        }
        const title = (el.getAttribute("title") ?? "").trim();
        if (title) return title;
        return "";
      };

      const ariaRole = (el: Element): string => {
        const explicit = el.getAttribute("role");
        if (explicit) return explicit;
        if (el instanceof HTMLInputElement) {
          const t = (el.getAttribute("type") ?? "text").toLowerCase();
          if (["text", "search", "tel", "url", "email"].includes(t) && el.list !== null)
            return "combobox";
          if (t === "search") return "searchbox";
          if (t === "text" || t === "tel" || t === "url" || t === "email") return "textbox";
          if (t === "number") return "spinbutton";
          if (t === "checkbox") return "checkbox";
          if (t === "radio") return "radio";
          if (t === "range") return "slider";
          return ""; // password/button/file/hidden/... carry no textbox role
        }
        if (el instanceof HTMLTextAreaElement) return "textbox";
        if (el instanceof HTMLSelectElement) return "combobox";
        if (el instanceof HTMLDialogElement && el.open) return "dialog";
        if (el.tagName === "CODE") return "code";
        const name = accessibleName(el);
        if (el.tagName === "SECTION" && name) return "region";
        if (el.tagName === "FORM" && name) return "form";
        return "";
      };

      // Shadow-inclusive containment: parentElement stops at the shadow
      // boundary, so climb from each node through its root's host.
      const within = (node: Element, scopeEl: Element | null): boolean => {
        if (scopeEl === null) return true;
        let cur: Element | null = node;
        while (cur !== null) {
          if (cur === scopeEl) return true;
          const root = cur.getRootNode();
          cur = cur.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
        }
        return false;
      };

      const isAriaIncluded = (el: Element): boolean => {
        for (let current: Element | null = el; current; ) {
          if (current.getAttribute("aria-hidden") === "true") return false;
          const root = current.getRootNode();
          current =
            current.assignedSlot ??
            current.parentElement ??
            (root instanceof ShadowRoot ? root.host : null);
        }
        return true;
      };

      const readValue = (node: Element): string => {
        const value =
          node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement
            ? node.value
            : node instanceof HTMLElement
              ? node.innerText
              : "";
        return value.length <= 8192 ? value.trim() : "";
      };

      const containerSpec = spec.container ?? null;
      const containers =
        scopeNodes.length > 0
          ? scopeNodes
          : containerSpec
            ? elements.filter(
                (el) =>
                  isVisible(el) &&
                  isAriaIncluded(el) &&
                  ariaRole(el) === containerSpec.role &&
                  (containerSpec.name === undefined || accessibleName(el) === containerSpec.name),
              )
            : [];
      const inScope = (el: Element): boolean =>
        containerSpec === null || containers.some((container) => within(el, container));

      const foundReport = (): CaptureFoundCandidate[] => {
        const out: CaptureFoundCandidate[] = [];
        for (const el of elements) {
          if (out.length >= 12) break;
          if (!isVisible(el)) continue;
          const role = ariaRole(el);
          const tag = el.tagName;
          const named =
            el.getAttribute("aria-label") !== null || el.getAttribute("aria-labelledby") !== null;
          if (role === "" && !named && tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "CODE")
            continue;
          out.push({ role: role || tag.toLowerCase(), name: accessibleName(el) || null });
        }
        return out;
      };
      // A demanded container that never rendered scopes nothing: refuse rather
      // than let the walk resolve a match outside the requested container.
      if (containerSpec && containers.length === 0 && nodes.length === 0)
        return { candidate_count: 0, found: foundReport() };

      const resolve = (matches: Element[]) => {
        const candidates = Array.from(new Set([...nodes, ...matches]));
        if (candidates.length === 0) return { candidate_count: 0, found: foundReport() };
        if (candidates.length > 1) return { candidate_count: candidates.length };
        const value = readValue(candidates[0]!);
        return { candidate_count: 1, ...(value.length > 0 ? { value } : {}) };
      };

      if ("selector" in spec) {
        const parentOf = (el: Element): Element | null => {
          const root = el.getRootNode();
          return el.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
        };
        const compound =
          /(?:[a-zA-Z_][\w-]*|\*|[.#][\w-]+|\[[\w-]+(?:[~|^$*]?=(?:"[^"\\]*"|'[^'\\]*'|[\w-]+))?\])+/y;
        const selector = spec.selector.trim();
        const parts: string[] = [];
        let offset = 0;
        while (offset < selector.length) {
          compound.lastIndex = offset;
          const part = compound.exec(selector);
          if (part === null) return resolve([]);
          parts.push(part[0]);
          offset = compound.lastIndex;
          if (offset === selector.length) break;
          const space = selector.slice(offset).match(/^\s+/);
          if (space === null) return resolve([]);
          offset += space[0].length;
        }
        if (parts.length === 0) return resolve([]);
        const anchors =
          parts.length > 1
            ? (containerSpec === null ? elements : containers).filter((el) => el.matches(parts[0]!))
            : [];
        const matchesSelector = (el: Element): boolean => {
          if (!el.matches(parts[parts.length - 1]!)) return false;
          if (parts.length === 1) return el.getRootNode() instanceof ShadowRoot;
          return anchors.some((anchor) => {
            if (el === anchor || !within(el, anchor)) return false;
            let current: Element | null = el;
            let remaining = parts.length - 2;
            let crossedShadow = false;
            while (current !== null && current !== anchor) {
              if (current.parentElement === null && current.getRootNode() instanceof ShadowRoot)
                crossedShadow = true;
              current = parentOf(current);
              if (current === anchor) return crossedShadow && remaining === 0;
              if (current !== null && remaining > 0 && current.matches(parts[remaining]!))
                remaining--;
            }
            return false;
          });
        };
        let visible: Element[] = [];
        try {
          document.querySelector(spec.selector);
          visible = elements.filter((el) => isVisible(el) && inScope(el) && matchesSelector(el));
        } catch {
          return resolve([]);
        }
        return resolve(visible);
      }

      const role = spec.role;
      let candidates = elements.filter(
        (el) => isVisible(el) && isAriaIncluded(el) && inScope(el) && ariaRole(el) === role,
      );
      if (spec.name !== undefined)
        candidates = candidates.filter((el) => accessibleName(el) === spec.name);
      return resolve(candidates);
    },
    { source, nodes: handles, scopeNodes: containerHandles },
  );
}
function captureSourceContainer(page: Page, source: CaptureSource) {
  return source.container === undefined
    ? undefined
    : page.getByRole(source.container.role, {
        ...(source.container.name !== undefined
          ? { name: source.container.name, exact: true }
          : {}),
      });
}

function captureSourceTargets(page: Page, source: CaptureSource) {
  const container = source.container === undefined ? page : captureSourceContainer(page, source)!;
  return "selector" in source
    ? container.locator(`css=${source.selector}`).filter({ visible: true })
    : container.getByRole(source.role, {
        ...(source.name !== undefined ? { name: source.name, exact: true } : {}),
      });
}

interface CaptureSourceResolution {
  candidate_count: number;
  value?: string;
  resolved_source?: { tag: string; role?: string; name?: string; selector?: string };
  resolved_from?: "post_action" | "pre_action_only";
  found?: CaptureFoundCandidate[];
}

async function readCaptureElement(handle: ElementHandle<Node>) {
  return await handle.evaluate((node) => {
    if (!node.isConnected || node.ownerDocument !== document)
      throw new Error("capture source changed");
    const value =
      node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement
        ? node.value
        : node instanceof HTMLElement
          ? node.innerText
          : "";
    let resolved_source: CaptureSourceResolution["resolved_source"];
    if (node instanceof Element) {
      const tag = node.localName;
      const role =
        node.getAttribute("role") ||
        (node instanceof HTMLTextAreaElement ||
        (node instanceof HTMLInputElement && ["text", "email", "url", "tel"].includes(node.type))
          ? "textbox"
          : tag === "code"
            ? "code"
            : undefined);
      const root = node.getRootNode();
      const labelledBy = (node.getAttribute("aria-labelledby") ?? "")
        .split(/\s+/)
        .map((id) =>
          root instanceof Document || root instanceof ShadowRoot
            ? (root.getElementById(id)?.textContent ?? "")
            : "",
        )
        .join(" ")
        .trim();
      const labels =
        node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement
          ? Array.from(node.labels ?? [])
              .map((label) => label.textContent ?? "")
              .join(" ")
              .trim()
          : "";
      const name =
        labelledBy ||
        node.getAttribute("aria-label")?.trim() ||
        labels ||
        node.getAttribute("title")?.trim();
      resolved_source = {
        tag,
        ...(role ? { role } : {}),
        ...(name ? { name } : { selector: node.id ? `${tag}#${CSS.escape(node.id)}` : tag }),
      };
    }
    return { value: value.length <= 8192 ? value.trim() : "", resolved_source };
  });
}

/** Resolve a capture source once against the live document, disposing the
 * pinned handles. A new document must not satisfy the same locator while
 * capture is in flight. */
async function resolveCaptureSourceOnce(
  page: Page,
  source: CaptureSource,
): Promise<CaptureSourceResolution> {
  // A locator-engine failure is a zero-match, not a mystery: the explicit
  // shadow-piercing walk below still gets its chance to resolve the source.
  const handles = await captureSourceTargets(page, source)
    .elementHandles()
    .catch(() => []);
  const containerHandles =
    (await captureSourceContainer(page, source)
      ?.elementHandles()
      .catch(() => [])) ?? [];
  try {
    // The reviewed resolver is walk-authoritative: engines can miss
    // shadow-hosted candidates or pin a stale light-DOM node. Union every
    // engine result with the explicit walk before requiring exactly one.
    const rejudged = await shadowPiercingCapture(page, source, handles, containerHandles);
    if (rejudged.candidate_count !== 1) return { ...rejudged };
    if (handles.length === 1) {
      const { value, resolved_source } = await readCaptureElement(handles[0]!);
      return {
        candidate_count: 1,
        ...(value.length > 0 ? { value } : {}),
        ...(resolved_source ? { resolved_source } : {}),
      };
    }
    return { ...rejudged };
  } finally {
    await Promise.all(
      [...handles, ...containerHandles].map((handle) => handle.dispose().catch(() => undefined)),
    );
  }
}

/** Live pre-action probe of a click capture's source. The single candidate's
 * handle stays alive so the post-action resolution can prove it is not merely
 * the pre-click element re-read; the caller must dispose it. */
export interface CaptureSourceProbe {
  candidate_count: number;
  value?: string;
  handle?: ElementHandle<Node>;
}

export async function probeCaptureSource(
  sessionId: string,
  source: CaptureSource,
): Promise<CaptureSourceProbe> {
  const session = sessionForCall(sessionId);
  if (session === undefined) throw new Error("unknown provision session");
  const page = operationPageForSession(session);
  if (page === undefined) throw new Error("capture page unavailable");
  const handles = await captureSourceTargets(page, source)
    .elementHandles()
    .catch(() => []);
  const containerHandles =
    (await captureSourceContainer(page, source)
      ?.elementHandles()
      .catch(() => [])) ?? [];
  const rejudged = await shadowPiercingCapture(page, source, handles, containerHandles);
  await Promise.all(containerHandles.map((handle) => handle.dispose().catch(() => undefined)));
  if (rejudged.candidate_count !== 1 || handles.length !== 1) {
    if (handles.length > 0)
      await Promise.all(handles.map((handle) => handle.dispose().catch(() => undefined)));
    // A shadow-only source has no engine-pinned handle; post-action comparison
    // therefore falls back to the walk's value identity.
    return { ...rejudged };
  }
  const [handle] = handles;
  try {
    const { value } = await readCaptureElement(handle!);
    return { candidate_count: 1, handle: handle!, ...(value.length > 0 ? { value } : {}) };
  } catch (error) {
    await handle!.dispose().catch(() => undefined);
    throw error;
  }
}

async function sameDomElement(
  handle: ElementHandle<Node>,
  preHandle: ElementHandle<Node> | undefined,
): Promise<boolean> {
  if (preHandle === undefined) return false;
  try {
    return await handle.evaluate((node, other) => node === other, preHandle);
  } catch {
    return false; // stale pre-action handle — a different document's element
  }
}

// A click capture that re-reads the SAME element with the SAME value the
// pre-action probe saw proves only the pre-click document — the click's
// mutation has not rendered yet (the Groq key-dialog failure: the display-name
// textbox was the only pre-click textbox, and the capture vaulted its value as
// the key). Poll a bounded window for the mutation to render a changed
// resolution; if the source still resolves only as it did before the click,
// report pre_action_only so the caller treats storage as unresolved.
const CAPTURE_MUTATION_RENDER_BUDGET_MS = 2_000;
const CAPTURE_MUTATION_RENDER_POLL_MS = 250;

async function resolveChangedPostActionSource(
  page: Page,
  source: CaptureSource,
  pre: CaptureSourceProbe,
): Promise<CaptureSourceResolution | null> {
  const handles = await captureSourceTargets(page, source)
    .elementHandles()
    .catch(() => []);
  const containerHandles =
    (await captureSourceContainer(page, source)
      ?.elementHandles()
      .catch(() => [])) ?? [];
  try {
    const walked = await shadowPiercingCapture(page, source, handles, containerHandles);
    if (walked.candidate_count === 1) {
      const pinned = handles.length === 1 ? await readCaptureElement(handles[0]!) : undefined;
      const value = pinned?.value ?? walked.value ?? "";
      const unchanged =
        pre.candidate_count === 1 &&
        // A shadow-walked pre-probe has no live handle: value identity is the
        // only proof available, and an equal value still proves nothing new.
        (handles.length === 0 ||
          pre.handle === undefined ||
          (handles.length === 1 && (await sameDomElement(handles[0]!, pre.handle)))) &&
        (pre.value ?? "") === value;
      if (unchanged) return null;
      return {
        candidate_count: 1,
        ...(value.length > 0 ? { value } : {}),
        ...(pinned?.resolved_source ? { resolved_source: pinned.resolved_source } : {}),
      };
    }
    // Same non-unique (or still-empty) resolution as before the click — keep
    // waiting; the mutation may still be rendering.
    if (walked.candidate_count === pre.candidate_count) return null;
    return { ...walked };
  } finally {
    await Promise.all(
      [...handles, ...containerHandles].map((handle) => handle.dispose().catch(() => undefined)),
    );
  }
}

async function resolvePostActionCaptureSource(
  page: Page,
  source: CaptureSource,
  pre: CaptureSourceProbe,
): Promise<CaptureSourceResolution> {
  const deadline = Date.now() + CAPTURE_MUTATION_RENDER_BUDGET_MS;
  for (;;) {
    const changed = await resolveChangedPostActionSource(page, source, pre);
    if (changed !== null) return { ...changed, resolved_from: "post_action" };
    if (Date.now() >= deadline)
      return { candidate_count: pre.candidate_count, resolved_from: "pre_action_only" };
    await new Promise((resolve) => setTimeout(resolve, CAPTURE_MUTATION_RENDER_POLL_MS));
  }
}

/** Explicit capture reads one named source without revealing other controls or
 * scanning unrelated page text. Normal extract/observe remain unchanged.
 * With `afterAction`, the source is judged against the POST-action document:
 * the click's own settle runs first, and a resolution indistinguishable from
 * the pre-action probe is reported as `pre_action_only` instead of stored. */
export async function captureCredentialSource(
  sessionId: string,
  source: CaptureSource,
  afterAction?: { pre?: CaptureSourceProbe | undefined },
): Promise<CaptureSourceResolution> {
  const session = sessionForCall(sessionId);
  if (session === undefined) throw new Error("unknown provision session");
  const page = operationPageForSession(session);
  if (page === undefined) throw new Error("capture page unavailable");
  if (afterAction !== undefined) {
    // Same settle the click itself waits on — judge the source only after the
    // click's mutation has had its render window.
    await settleAfterStateChange(session.browser, page);
    return afterAction.pre === undefined
      ? { candidate_count: 0, resolved_from: "pre_action_only" }
      : await resolvePostActionCaptureSource(page, source, afterAction.pre);
  }
  return await resolveCaptureSourceOnce(page, source);
}

export async function extractCredentials(sessionId: string): Promise<ExtractResult> {
  const session = sessionForCall(sessionId);
  if (session === undefined) throw new Error(`unknown provision session ${sessionId}`);
  const { browser } = session;
  const page = operationPageForSession(session);
  invalidateCompactV2Snapshot(session);

  // The masked-display trap: click reveal/show toggles before reading.
  await browser.revealMaskedCredentials(page);

  const labeled = await browser.extractLabeledCredentialCandidates(page);
  const inputs = await browser.extractAllInputValues(page);
  const nearCopy = await browser.extractCredentialsNearCopyButtons(page);
  const text = await browser.extractVisibleText(page);

  // Copy-only key surfaces (e.g. LangWatch's /settings/api-keys) never render
  // the value into the DOM — it goes to the clipboard on a "Copy" click. Read
  // it (clipboard-read is granted at context creation).
  const clip = await browser.readClipboard(page).catch(() => "");

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

  const relaxed = pickRelaxedNearCopyCredential(nearCopy);
  const acceptedNearCopyCredential =
    relaxed !== null &&
    !Object.entries(credentials).some(([key, value]) => key !== "api_key" && value === relaxed)
      ? relaxed
      : null;
  if (!("api_key" in credentials) && acceptedNearCopyCredential !== null) {
    credentials.api_key = acceptedNearCopyCredential;
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
  const sanitized = sanitizeExtractedCredentials(
    credentials,
    page?.url() ?? browser.currentUrl(),
    haystack,
    acceptedNearCopyCredential,
  );
  const found = Object.keys(sanitized).length > 0;
  audit(sessionId, "extract", { found, candidate_count: labeled.length });
  return {
    session_id: sessionId,
    url: page?.url() ?? browser.currentUrl(),
    credentials: sanitized,
    candidate_count: labeled.length,
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
  page?: Page,
): Promise<{ solved: boolean; outcome: string }> {
  if (!solver.isAvailable()) return { solved: false, outcome: "no_key" };

  if (variant === "recaptcha_v2" || variant === "recaptcha_v3") {
    const sitekey = await browser.extractRecaptchaSitekey(page);
    if (sitekey === null) return { solved: false, outcome: "missing_sitekey" };
    const res = await solver.solveRecaptchaV2({
      sitekey,
      pageUrl: page?.url() ?? browser.currentUrl(),
      ...(variant === "recaptcha_v3" ? { invisible: true } : {}),
    });
    if (res.kind !== "ok") return { solved: false, outcome: res.kind };
    const injected = await browser.injectRecaptchaToken(res.token, page);
    if (!injected) return { solved: false, outcome: "inject_failed" };
    return {
      solved: await browser.waitForCaptchaResponseToken(2_000, page),
      outcome: "ok",
    };
  }

  if (variant === "hcaptcha") {
    const sitekey = await browser.extractHcaptchaSitekey(page);
    if (sitekey === null) return { solved: false, outcome: "missing_sitekey" };
    const ctx = await browser.getHcaptchaSolveContext(page);
    const res = await solver.solveHcaptcha({
      sitekey,
      pageUrl: page?.url() ?? browser.currentUrl(),
      invisible: ctx.invisible,
      ...(ctx.userAgent !== null ? { userAgent: ctx.userAgent } : {}),
      ...(ctx.rqdata !== null ? { data: ctx.rqdata } : {}),
    });
    if (res.kind !== "ok") return { solved: false, outcome: res.kind };
    const injected = await browser.injectHcaptchaToken(res.token, page);
    if (!injected) return { solved: false, outcome: "inject_failed" };
    return {
      solved: await browser.waitForCaptchaResponseToken(2_000, page),
      outcome: "ok",
    };
  }

  if (variant === "turnstile") {
    const sitekey = await browser.extractTurnstileSitekey(page);
    if (sitekey === null) return { solved: false, outcome: "missing_sitekey" };
    const res = await solver.solveTurnstile({
      sitekey,
      pageUrl: page?.url() ?? browser.currentUrl(),
    });
    if (res.kind !== "ok") return { solved: false, outcome: res.kind };
    const injected = await browser.injectTurnstileToken(res.token, page);
    if (!injected) return { solved: false, outcome: "inject_failed" };
    return {
      solved: await browser.waitForCaptchaResponseToken(2_000, page),
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
  const page = operationPageForSession(session);
  invalidateCompactV2Snapshot(session);
  const det = await session.browser.detectCaptchaVariant(page);
  const found = det.variant !== "unknown" || det.challengeRendered;
  if (!found) {
    audit(sessionId, "captcha_gate", { found: false });
    return { session_id: sessionId, found: false, variant: "none", settled: true };
  }

  let token = await session.browser.waitForCaptchaResponseToken(750, page);
  let solvedBySubstrate = false;
  let tokenSolverOutcome: string | null = null;

  if (!token && det.variant === "recaptcha_v3") {
    // Try the in-browser invisible execution first; if it mints no token AND a
    // 2Captcha key is configured, escalate to the token solver (best-effort —
    // #279). With NO solver configured, solveCaptchaWithTokenSolver returns
    // "no_key" and a v3 failure stays an IP/behavior scoring wall (needs_user →
    // captcha_wall below), NOT a "set up 2Captcha" prompt.
    solvedBySubstrate = await session.browser.triggerInvisibleRecaptcha(9_000, page);
    token = solvedBySubstrate || (await session.browser.waitForCaptchaResponseToken(2_000, page));
    if (!token) {
      const solver = await buildTwoCaptchaSolver(session);
      const tokenSolved = await solveCaptchaWithTokenSolver(
        solver,
        session.browser,
        det.variant,
        page,
      );
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
    const tokenSolved = await solveCaptchaWithTokenSolver(
      solver,
      session.browser,
      det.variant,
      page,
    );
    tokenSolverOutcome = tokenSolved.outcome;
    token = tokenSolved.solved;
    if (!token) {
      const solved = await session.browser.solveVisibleCaptcha(30_000, page);
      solvedBySubstrate = solved.found && solved.solved;
      token = solvedBySubstrate || (await session.browser.waitForCaptchaResponseToken(2_000, page));
    }
  }

  const clear = await session.browser.waitForCaptchaChallengeToSettle(
    token ? 5_000 : 15_000,
    2_500,
    page,
  );
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
  // to navigate to it.
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
  // Overrides inbox reading for this session only. true grants (or restores)
  // access and false opts out without changing the saved advanced preference.
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
  links: readonly (string | VerificationLinkCandidate)[],
  expectedDomains?: readonly string[],
): { code: string | null; link: string | null } {
  const link = pickVerificationLink([...links], expectedDomains);
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

// Derives the domain(s) pickVerificationLink should prefer: the caller's
// `sender` search hint (an email address or a bare domain) and the sender
// address read off the opened message, deduped and lowercased. Exported for
// unit tests.
export function expectedVerificationDomains(
  sender: string | undefined,
  sourceFrom: string | null,
): string[] {
  const domainOf = (s: string): string => (s.includes("@") ? s.split("@").pop()! : s).toLowerCase();
  const domains = [sender, sourceFrom ?? undefined]
    .filter((s): s is string => s !== undefined && s.length > 0)
    .map(domainOf);
  return [...new Set(domains)];
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

// Inbox-read opt-out refusal. The session stays live (resumable): the host asks
// the user for the code and types it, or restores inbox access and retries.
// Distinct from buildVerificationResult so the host can tell "access disabled"
// apart from "code not found in an inbox we DID read".
// Exported for unit tests.
export function buildConsentRefusal(sessionId: string): VerificationResult {
  const needs_user: NeedsUserCode = {
    wall: "verification_code",
    message:
      "Inbox reading is disabled, so the operator did not read any mail. Ask " +
      "the user for the code and type it with operate_act, or retry " +
      'operate_act { kind: "await_verification" } with grant_inbox_consent:true ' +
      "to restore inbox reading for this session. The session stays live either way. " +
      "To change the default permanently, re-run `connect` and update advanced settings.",
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
    '(verify OR verification OR confirm OR confirmation OR code OR otp OR passcode OR password OR login OR "log in" OR "sign in" OR "sign-in" OR signin OR "magic link" OR activate OR activation OR welcome OR "link account" OR "link your" OR continue)',
  ]
    .filter((s) => s.length > 0)
    .join(" ");
}

// Gmail's own search backend intermittently throws a transient error —
// "Oops... the system encountered a problem (#2014) - Retrying in Ns" —
// and while that banner is up a search like `from:xata.io` can spuriously
// render "No messages matched your search" even though the message is
// really there. Exported for unit tests.
export function isGmailTransientErrorText(text: string): boolean {
  return /#2014|encountered a problem|retrying in\s*\d+/i.test(text);
}

// Exported for unit tests.
export function isEmptyGmailResultText(text: string): boolean {
  return /no messages matched your search/i.test(text);
}

// Backoff schedule for the transient-error retry, in ms: 800, 1600, 3200,
// capped at 4000. Exported for unit tests.
export function gmailTransientBackoffMs(retryIndex: number): number {
  return Math.min(800 * 2 ** retryIndex, 4000);
}

// Bounded — a genuinely empty inbox must still resolve to not-found in
// finite time, not hang retrying forever.
const GMAIL_TRANSIENT_MAX_RETRIES = 3;

// Reads the Gmail search results list, retrying through Gmail's own transient
// backend error with backoff before accepting a result as final. Detects
// EITHER the error banner itself, or an empty-looking "No messages matched"
// render with no result links (the shape the banner's spurious empty state
// takes) — and only gives up on the bounded retries running out, never on
// the first read. Exported for unit tests via the pure detectors above; this
// wrapper needs a live browser so it isn't itself unit tested directly.
async function readGmailSearchResultsResilient(
  browser: BrowserController,
  searchUrl: string,
  page: Page,
  linkCandidatesOf: (
    els: readonly {
      href?: string | null;
      visibleText?: string | null;
      labelText?: string | null;
      ariaLabel?: string | null;
    }[],
  ) => VerificationLinkCandidate[],
): Promise<{ text: string; links: VerificationLinkCandidate[] }> {
  let text = "";
  let links: VerificationLinkCandidate[] = [];
  for (let retry = 0; retry <= GMAIL_TRANSIENT_MAX_RETRIES; retry++) {
    if (retry > 0) {
      await browser
        .waitForCaptchaChallengeToSettle(gmailTransientBackoffMs(retry - 1), 0, page)
        .catch(() => false);
      await browser.goto(searchUrl, page);
    }
    for (let i = 0; i < 6; i++) {
      text = await browser.extractVisibleText(page);
      if (text.length > 200) break;
      await browser.waitForCaptchaChallengeToSettle(1200, 0, page).catch(() => false);
    }
    links = linkCandidatesOf(await browser.extractInteractiveElements(page));
    const transientOrEmpty =
      isGmailTransientErrorText(text) || (isEmptyGmailResultText(text) && links.length === 0);
    if (!transientOrEmpty || retry === GMAIL_TRANSIENT_MAX_RETRIES) break;
  }
  return { text, links };
}

export async function awaitVerification(
  sessionId: string,
  opts: AwaitVerificationOptions = {},
): Promise<VerificationResult> {
  const session = sessionForCall(sessionId);
  if (session === undefined) throw new Error(`unknown provision session ${sessionId}`);

  // A caller can override the default for this session without changing the
  // saved advanced preference. In particular, false must win over default-on.
  if (opts.grantConsent !== undefined && opts.grantConsent !== session.consentInboxRead) {
    session.consentInboxRead = opts.grantConsent;
    audit(sessionId, opts.grantConsent ? "inbox_consent_granted" : "inbox_consent_revoked", {
      scope: "session",
    });
  }
  // Explicit opt-out gate: do NOT read mail while disabled. Hand the code
  // request back to the user instead (resumable).
  if (!session.consentInboxRead) {
    audit(sessionId, "await_verification", { refused: "no_inbox_consent" });
    return buildConsentRefusal(sessionId);
  }

  invalidateCompactV2Snapshot(session);
  const inboxPage = operationPageForSession(session);
  if (inboxPage === undefined || inboxPage.isClosed()) {
    throw new Error("inbox page is unavailable");
  }

  const verification = await runDetachedGoogleIdentityOperation(session, async (browser) => {
    const query = buildVerificationSearchQuery(opts.sender);
    const searchUrl = `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(query)}`;
    const linkCandidatesOf = (
      els: readonly {
        href?: string | null;
        visibleText?: string | null;
        labelText?: string | null;
        ariaLabel?: string | null;
      }[],
    ): VerificationLinkCandidate[] =>
      els
        .filter(
          (e): e is typeof e & { href: string } => typeof e.href === "string" && e.href.length > 0,
        )
        .map((e) => ({ url: e.href, text: e.visibleText ?? e.labelText ?? e.ariaLabel ?? null }));
    let code: string | null = null;
    let link: string | null = null;
    let sourceFrom: string | null = null;
    for (let attempt = 0; attempt < 3 && code === null && link === null; attempt++) {
      sourceFrom = null;
      if (attempt > 0)
        await browser.waitForCaptchaChallengeToSettle(4000, 0, inboxPage).catch(() => false);
      await browser.goto(searchUrl, inboxPage);
      const { text: listText, links: listLinks } = await readGmailSearchResultsResilient(
        browser,
        searchUrl,
        inboxPage,
        linkCandidatesOf,
      );
      const opened = await browser.openFirstMailResult(inboxPage).catch(() => false);
      if (opened) {
        const openedText = await browser.extractVisibleText(inboxPage);
        const openedLinks = linkCandidatesOf(await browser.extractInteractiveElements(inboxPage));
        sourceFrom = extractSenderEmail(openedText);
        const expectedDomains = expectedVerificationDomains(opts.sender, sourceFrom);
        ({ code, link } = parseVerification(
          openedText,
          [...openedLinks, ...listLinks],
          expectedDomains,
        ));
      } else {
        ({ code, link } = parseVerification(
          listText,
          listLinks,
          expectedVerificationDomains(opts.sender, null),
        ));
      }
    }
    return { code, link, sourceFrom };
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
