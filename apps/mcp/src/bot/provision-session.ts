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
import type { Page } from "playwright";
import type {
  BrowserController,
  CheckoutCard,
  InjectCardField,
  InjectCardFieldResult,
  InjectCardResolvedTarget,
} from "./browser.js";
import { completeOAuthTransitionRecovery, oauthTransitionStatus } from "./oauth-login.js";
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
import type { OAuthProviderId } from "./oauth-providers.js";

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
import { egressSeedHosts } from "./session/hosts.js";
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

// Phase 6 — the capture and verification thick tools moved to capture/:
// the extract/capture cluster in capture/capture.ts, email verification in
// capture/verification.ts. The session-facing entry points are imported back
// here; the tool layer's import surface stays on this module (re-exports
// below), as with the lifecycle, observe and act names.
export {
  extractCredentials,
  captureCredentialSource,
  probeCaptureSource,
  sanitizeExtractedCredentials,
  classifyVouchflowCredentials,
  type CaptureFoundCandidate,
  type CaptureSourceProbe,
  type ExtractResult,
} from "./capture/capture.js";
export {
  awaitVerification,
  isGmailTransientErrorText,
  isEmptyGmailResultText,
  gmailTransientBackoffMs,
  type AwaitVerificationOptions,
  type VerificationResult,
} from "./capture/verification.js";

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

