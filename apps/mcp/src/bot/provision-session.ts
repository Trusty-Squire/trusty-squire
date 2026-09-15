import type { ScreenshotBinding, ScreenshotPoint } from "./screenshot-click.js";
import type { GoogleHumanChallenge } from "./google-auth-state.js";
import type { CaptureSource } from "./credential-capture.js";
import type { BrowserUseCapture } from "./browser-use-capture.js";
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

import { randomInt } from "node:crypto";
import type { ElementHandle, Page } from "playwright";
import type {
  BrowserController,
  CheckoutCard,
  InjectCardField,
  InjectCardFieldResult,
  InjectCardResolvedTarget,
} from "./browser.js";
import {
  completeOAuthTransitionRecovery,
  oauthTransitionStatus,
  withOAuthActionLease,
} from "./oauth-login.js";
import { TwoCaptchaSolver, type TwoCaptchaVaultProxy } from "./captcha-solver-2captcha.js";
import {
  isCompactV2Handle,
  isCompactV2Label,
  safeDescriptionV2,
  type SafeControlV2,
  type SafePageSemanticsV2,
  type SafeStageV2,
} from "./compact-observation-v2.js";
import type { ApiClient, HeightenedAuthNotificationResult } from "../api-client.js";
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
import { egressSeedHosts, registrableHost } from "./session/hosts.js";
// Phase 3 — session state left the facade: the sealed <select> bookkeeping and
// element retention moved to session/model.ts, the secret slots to
// session/slots.ts, and the host-scope state to session/registry.ts. The
// slots and the user-email lookup stay re-exported below (the tool layer's
// import surface), as with the lifecycle names.
import { widenAllowedHostsFromUrl } from "./session/registry.js";
import { stashSecretSlot, type SlotHandle } from "./session/slots.js";

export { getSessionUserEmail } from "./session/registry.js";
export { readSecretSlotValue, stashSecretSlot, type SlotHandle } from "./session/slots.js";
// Phase 4 — the observe pipeline moved to observe/observe.ts (compact-V2
// snapshot shaping, paging cursors, source-page bookkeeping) with the pure
// ref-identity helpers in observe/refs.ts. The session-facing entry points are
// imported back here; `observeQuery` stays re-exported (the tool layer's
// import surface), as with the lifecycle names.
import {
  compactV2StartMetadata,
  invalidateCompactV2Snapshot,
  oauthCompletionSourcePage,
  observeSession,
  observedOAuthChallenge,
  observedThreeDsChallenge,
  type ObserveDetail,
  operationPageForSession,
} from "./observe/observe.js";

export { observeQuery } from "./observe/observe.js";
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
// Phase 5 — the act executor moved to act/act.ts (the target-resolution
// cluster it shares with this facade moved to act/targets.ts). The session-
// facing entry point and the helpers this facade still calls are imported
// back here; the tool layer's import surface stays on this module (re-exports
// below), as with the lifecycle and observe names.
import {
  actInternally,
  compactV2SelectionFailureReason,
  runSerializedGoogleIdentityOperation,
  settleAfterStateChange,
} from "./act/act.js";
import {
  compactV2AuthorizationForTarget,
  resolveTarget,
  TargetStaleError,
  type CompactV2TargetAuthorization,
  type TargetStaleResult,
} from "./act/targets.js";

export { act } from "./act/act.js";
export {
  AmbiguousProvisionTargetError,
  parseLocatorTarget,
  preparePublicOAuthLoginTarget,
  resolveTarget,
  TargetStaleError,
  withPreparedOAuthLoginTarget,
  type CompactV2TargetAuthorization,
  type LocatorTarget,
  type PreparedOAuthLoginTarget,
  type TargetStaleResult,
} from "./act/targets.js";

async function runDetachedGoogleIdentityOperation<T>(
  session: Session,
  operation: (browser: BrowserController) => Promise<T>,
): Promise<T> {
  return await withOAuthActionLease(
    undefined,
    async () => (await runSerializedGoogleIdentityOperation(session, operation)).result,
  );
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
