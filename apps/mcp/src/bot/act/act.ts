// Phase 5 — the act executor moved out of provision-session.ts. This module
// owns the whole act path: actInternally/act (target resolution → dispatch →
// post-settle observation), actDriverTarget/resolveFreshActTarget/executeAct
// (the seven frozen driver verbs + observe hook), the OAuth action boundaries
// (withOAuthActionBoundary/runSerializedOAuthBoundary over the oauth-login
// lease), the compact-v2 failure-reason mapping, and the opened-tab adoption /
// post-state-change settle helpers. The target-resolution cluster it depends
// on lives in act/targets.ts. One-directional imports only: act must never
// runtime-import provision-session; `ProvisionAction`/`Observation` come back
// as type-only imports (the tool layer keeps importing `act` from
// provision-session, which re-exports it).
import type { Frame, Page } from "playwright";
import {
  BrowserClickDispatchError,
  DRIVE_DISPATCH_PACING,
  clickDispatchStatusForError,
  type BrowserController,
  type DispatchPacing,
  type InteractiveElement,
} from "../browser.js";
import {
  loginWithOAuth,
  oauthActionDeadline,
  oauthActionRemainingMs,
  oauthAutomatedActionTimeoutMs,
  oauthHumanHandoffTimeoutMs,
  oauthLoginLeaseCooldownMs,
  resetOAuthActionDeadline,
  settleAfterOAuth,
  withOAuthActionLease,
  withinOAuthActionDeadline,
  type OAuthActionDeadline,
  OAuthAwaitingHumanError,
  OAuthFailedError,
  OAuthOnboardingRequiredError,
} from "../oauth-login.js";
import type { ClickMethod, DriverTarget } from "../driver/types.js";
import { compactV2AuditUrl, safeStageV2 } from "../compact-observation-v2.js";
import { ProvenPreDispatchMutationError } from "../mutation-dispatch-evidence.js";
import type { OAuthProviderId } from "../oauth-providers.js";
import { registrableHost } from "../session/hosts.js";
import {
  clearCommittedSelectValue,
  compactV2CommittedSelectKey,
  compactV2CommittedSelectValue,
  retainSessionElements,
} from "../session/model.js";
import {
  compactV2EpochDoc,
  compactV2PublicObservation,
  invalidateCompactV2Snapshot,
  oauthCompletionSourcePage,
  observeSession,
  observedThreeDsChallenge,
  type ObserveDetail,
  operationPageForSession,
  rememberCompactV2SourcePage,
  rememberOAuthCompletionSourcePage,
  returnFromClosedPicker,
  terminalOAuthCompletionObservation,
} from "../observe/observe.js";
import { elementRef, provisionElementRefs } from "../observe/refs.js";
import { audit, googleSessionGateForSession, sessionForCall } from "../session/lifecycle.js";
import { substituteCardTokens } from "../card-secret-tokens.js";
import { clickScreenshot, ScreenshotClickError } from "../screenshot-click.js";
import {
  composeOperatorSignals,
  currentOperatorRequestSignal,
  operatorMutationDispatchPhase,
} from "../request-cancellation.js";
import {
  AmbiguousProvisionTargetError,
  compactV2AuthorizationForTarget,
  frameTargetFor,
  isRequiredShippingAddressLine1,
  parseLocatorTarget,
  preparedOAuthLoginTarget,
  resolveAuthorizedCompactV2Target,
  resolveTarget,
  staleTargetError,
  TargetStaleError,
  throwCompactV2StaleRef,
  CompactV2ActionFailureError,
  CompactV2StaleRefError,
  CompactV2UnresolvedLabelError,
  ProvisionTargetMissingError,
  ProvisionTargetNotAllowedError,
  type CompactV2TargetAuthorization,
} from "./targets.js";
// Type-only cycle back to the facade is fine; no runtime import.
import type { Observation, ProvisionAction } from "../provision-session.js";
import type { Session } from "../session/model.js";
import { resolveLiveControlIdentity } from "./identity.js";
import { overlayOptionLabels, waitForOverlayOptionsToChange } from "../drive-act.js";

// `detail:"none"` already owns "return no observation". These name the two
// things the drive loop does differently and asks for explicitly: it settles on
// its own schedule, and it types an overlay-opening control by writing into
// whatever the overlay focused. The tools' behaviour is the absent value.
export type ActExecutorOptions = {
  skipSettle?: boolean;
  pacing?: DispatchPacing;
  typeThroughOverlay?: boolean;
};

const DRIVE_DISPATCH: ActExecutorOptions = {
  skipSettle: true,
  pacing: DRIVE_DISPATCH_PACING,
  typeThroughOverlay: true,
};

export type DriveActResult =
  | { kind: "ok"; combobox: boolean }
  | { kind: "stale"; reason: string }
  | { kind: "unsupported" };

async function withOAuthActionBoundary(
  session: Session,
  provider: OAuthProviderId | undefined,
  run: (deadline: OAuthActionDeadline) => Promise<InternalActResult>,
  outputFormat: "compact" | "full",
): Promise<InternalActResult> {
  if (provider === "google") {
    const gate = await googleSessionGateForSession(session.id);
    if (!gate.ok) {
      const observation = await observeSession(
        session,
        outputFormat,
        undefined,
        undefined,
        false,
        outputFormat,
        false,
        true,
        true,
      );
      return {
        observation: { ...observation, needs_user: gate.needs_user },
        outcome: {},
      };
    }
  }
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

export async function runSerializedGoogleIdentityOperation<T>(
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

export interface InternalActResult {
  observation: Observation;
  operationPage?: Page;
  outcome: {
    selectedOption?: string;
  };
  combobox?: boolean;
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

export async function actInternally(
  sessionId: string,
  action: ProvisionAction,
  detail: ObserveDetail = "compact",
  compactV2Authorization?: CompactV2TargetAuthorization,
  operationPage?: Page,
  options?: ActExecutorOptions,
): Promise<InternalActResult> {
  const session = sessionForCall(sessionId);
  const capturedOperationPage =
    operationPage ?? (session === undefined ? undefined : operationPageForSession(session));
  const oauthProvider =
    action.kind === "oauth_login" || action.kind === "oauth_click" ? action.provider : undefined;
  try {
    const execute = async (deadline?: OAuthActionDeadline): Promise<InternalActResult> => {
      const run = async (): Promise<InternalActResult> => {
        const act = async (): Promise<InternalActResult> =>
          await executeAct(
            sessionId,
            action,
            detail,
            true,
            compactV2Authorization,
            deadline,
            capturedOperationPage,
            false,
            undefined,
            "full",
            true,
            options,
          );
        const pacing = options?.pacing;
        return session === undefined || pacing === undefined
          ? await act()
          : await session.browser.withDispatchPacing(pacing, act);
      };
      return (action.kind === "click" ||
        action.kind === "js_click" ||
        action.kind === "oauth_login" ||
        action.kind === "oauth_click") &&
        session !== undefined
        ? await withOpenedTabAdoptionLease(session.browser, run)
        : await run();
    };
    return session !== undefined && (action.kind === "oauth_login" || action.kind === "oauth_click")
      ? await withOAuthActionBoundary(session, oauthProvider, execute, "compact")
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
        ? await withOAuthActionBoundary(session, oauthProvider, execute, outputFormat)
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

function actsThroughOverlay(el: InteractiveElement): boolean {
  const role = (el.role ?? "").toLowerCase();
  const type = (el.type ?? "").toLowerCase();
  return (
    role === "combobox" ||
    role === "searchbox" ||
    type === "search" ||
    type === "date" ||
    type === "datetime-local" ||
    type === "month"
  );
}

function submitsOnEnter(el: InteractiveElement): boolean {
  const role = (el.role ?? "").toLowerCase();
  const type = (el.type ?? "").toLowerCase();
  const hay = `${el.ariaLabel ?? ""} ${el.placeholder ?? ""} ${el.name ?? ""}`;
  return role === "searchbox" || type === "search" || el.name === "q" || /search/i.test(hay);
}

function scopeForElement(page: Page, el: InteractiveElement): Page | Frame {
  if (el.framePath === undefined || el.framePath === null || el.framePath.length === 0) return page;
  let frame: Frame = page.mainFrame();
  for (const part of el.framePath.split("/")) {
    const child = frame.childFrames()[Number(part)];
    if (child === undefined) return page;
    frame = child;
  }
  return frame;
}

// The occlusion guard the drive used to carry in its own dispatch: a cookie
// banner or sticky footer over the target swallows the click while the page
// still reports a dispatch, so the caller records a step that never landed.
// Absent a box (still loading) it says nothing and the actionability waits rule.
async function clickTargetOccluded(scope: Page | Frame, selector: string): Promise<boolean> {
  return await scope
    .evaluate((sel: string) => {
      const element = document.querySelector(sel);
      if (element === null) return false;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      const x = rect.x + rect.width / 2;
      const y = rect.y + rect.height / 2;
      if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return false;
      const hit = document.elementFromPoint(x, y);
      return hit !== null && hit !== element && !element.contains(hit) && !hit.contains(element);
    }, selector)
    .catch(() => false);
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
  const driveIdentity = session.drive?.identities?.get(resolutionTarget);
  const livePage = compactV2ActionPage ?? browser.page;
  if (driveIdentity !== undefined && livePage !== null) {
    const live = await resolveLiveControlIdentity(livePage, resolutionTarget, driveIdentity);
    if (live !== null) return { el: live, fresh: session.lastElements };
    if (session.compactV2Active) {
      if (!internalAccess) throwCompactV2StaleRef();
      throw new CompactV2StaleRefError("stale_ref");
    }
    const stale = staleTargetError(session, actionTarget, session.lastElements);
    if (stale !== null) throw stale;
    throw new CompactV2StaleRefError("stale_ref");
  }
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
  options?: ActExecutorOptions,
): Promise<InternalActResult> {
  const session = sessionForCall(sessionId);
  if (session === undefined) throw new Error(`unknown provision session ${sessionId}`);
  let browser = session.browser;
  const compactV2ActionPage = operationPage ?? operationPageForSession(session);
  const driveSettle =
    session.drive !== null && action.kind !== "oauth_login" && action.kind !== "oauth_click";
  const skipToolSettle = options?.skipSettle === true;
  let settleMs = 0;
  const settle = async (combobox = false) => {
    if (skipToolSettle) return;
    const started = Date.now();
    await settleAfterStateChange(browser, compactV2ActionPage, {
      drive: driveSettle,
      combobox: driveSettle && combobox,
    });
    settleMs += Date.now() - started;
  };
  const actStarted = Date.now();
  let actedCombobox = false;
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
        await settle();
        break;
      }
      case "set_phone_country": {
        // No captured element — the bot finds the phone-local native <select>.
        await browser.setPhoneCountry(action.country, compactV2ActionPage);
        await settle();
        break;
      }
      case "click":
      case "js_click":
      case "type":
      case "upload":
      case "oauth_click": {
        // Masked-secret boundary: a released card's PAN/CVV reach this path
        // only as opaque per-digit tokens ({{pan}}, {{pan:5}}, {{cvv}}, …).
        // Substitute the real digits HERE — after target resolution begins,
        // immediately before the keystroke write — so the agent's text never
        // carries them and the substituted value is never echoed (type
        // results carry no typed text). A session without a released card
        // leaves the text byte-identical.
        const typedText =
          action.kind !== "type"
            ? undefined
            : session.releasedPaymentCard === null
              ? action.text
              : substituteCardTokens(session.releasedPaymentCard.card, action.text);
        if (action.kind === "click" && action.screenshot) {
          if (!compactV2ActionPage)
            throw new ScreenshotClickError("stale_screenshot", "not_dispatched");
          actionPageAfter =
            (await adoptTabOpenedByClick(session, browser, async () => {
              await clickScreenshot(compactV2ActionPage, action.screenshot!, () => undefined);
              onScreenshotDispatched?.();
            })) ?? actionPageAfter;
          await settle();
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
            action.kind,
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
            } else await actType({ kind: "handle", handle: resolved.handle }, typedText!, false);
          } finally {
            await resolved.handle.dispose().catch(() => undefined);
          }
          audit(sessionId, action.kind, {
            locator_mode: locator.mode,
            host: registrableHost(urlBeforeAction),
          });
          if (action.kind !== "type") {
            await settle();
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
        actedCombobox = actsThroughOverlay(el);
        // Preserve frame identity (origin + path) for the frame-scoped fill.
        if (action.kind === "click" || action.kind === "js_click") {
          const clickPage = compactV2ActionPage ?? browser.page;
          if (
            action.kind === "click" &&
            clickPage !== null &&
            clickPage !== undefined &&
            (await clickTargetOccluded(scopeForElement(clickPage, el), el.selector))
          ) {
            throw new BrowserClickDispatchError(
              "not_dispatched",
              "click target is occluded by an overlay",
            );
          }
          actionPageAfter =
            (await adoptTabOpenedByClick(session, browser, async () => {
              await actClick({ ...actDriverTarget(el), method: action.kind });
            })) ?? actionPageAfter;
        } else if (action.kind === "type") {
          clearCommittedSelectValue(session, el.selector);
          const actTarget = actDriverTarget(el);
          if (
            options?.typeThroughOverlay === true &&
            actedCombobox &&
            compactV2ActionPage !== undefined
          ) {
            // The click may remount the field into an overlay that takes focus,
            // so the text goes to whatever is focused — after an explicit
            // select-all, because insertText alone APPENDS to a committed value.
            // The suggestion baseline is read AFTER the overlay opens; reading
            // it before would make the refresh wait return on the stale rows.
            await actClick({ ...actTarget, method: "click" });
            await settleAfterDriveAction(compactV2ActionPage, true);
            const overlayBefore = await overlayOptionLabels(compactV2ActionPage);
            await compactV2ActionPage.keyboard.press("ControlOrMeta+a");
            await compactV2ActionPage.keyboard.insertText(typedText ?? "");
            if (submitsOnEnter(el)) {
              await compactV2ActionPage.keyboard.press("Enter").catch(() => undefined);
            }
            await waitForOverlayOptionsToChange(compactV2ActionPage, overlayBefore);
          } else {
            await actType(actTarget, typedText!, false);
            if (options?.typeThroughOverlay === true && submitsOnEnter(el)) {
              await (compactV2ActionPage ?? browser.page)?.keyboard
                .press("Enter")
                .catch(() => undefined);
            }
          }
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
        if (action.kind !== "type" || driveSettle) {
          await settle(action.kind === "type" && (el.role ?? "").toLowerCase() === "combobox");
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
            `oauth_login: no element matched target "${action.target}". Re-observe and use the OAuth control ref.`,
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
  const observeStarted = Date.now();
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
            undefined,
            // E4: echo the acted control's current row (w=acted) in the delta
            // so a write is confirmable from its own result.
            compactV2Authorization?.row?.ref,
          );
  if (session.drive !== null) {
    const observeMs = Date.now() - observeStarted;
    session.drive.lastActProfile = {
      act_ms: Math.max(0, Date.now() - actStarted - settleMs - observeMs),
      settle_ms: settleMs,
      observe_ms: observeMs,
    };
  }
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
    combobox: actedCombobox,
  };
}

export async function dispatchDriveAct(
  sessionId: string,
  action: ProvisionAction,
): Promise<DriveActResult> {
  // "unsupported" means the shared executor has no drive verb for this action
  // and the caller should fall back to the tools path. A DISPATCH failure is a
  // different thing — the act did not land on the control, which is stale.
  if (
    action.kind !== "click" &&
    action.kind !== "type" &&
    action.kind !== "select" &&
    action.kind !== "scroll"
  ) {
    return { kind: "unsupported" };
  }
  try {
    const result = await actInternally(
      sessionId,
      action,
      "none",
      undefined,
      undefined,
      DRIVE_DISPATCH,
    );
    return { kind: "ok", combobox: result.combobox === true };
  } catch (error) {
    if (error instanceof CompactV2StaleRefError) return { kind: "stale", reason: "stale_ref" };
    if (error instanceof TargetStaleError) return { kind: "stale", reason: "stale" };
    const message = error instanceof Error ? error.message : String(error);
    return {
      kind: "stale",
      reason: /occluded|intercepts pointer/i.test(message) ? "occluded" : "stale_ref",
    };
  }
}

export function compactV2SelectionFailureReason(error: unknown): string {
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

export async function settleAfterDriveAction(page?: Page, combobox = false): Promise<void> {
  if (!page) return;
  const capMs = combobox ? 200 : 50;
  await page
    .evaluate(
      ({ cap, waitOptions }: { cap: number; waitOptions: boolean }) =>
        new Promise<void>((resolve) => {
          let frames = 0;
          let stopped = false;
          const finish = () => {
            if (stopped) return;
            stopped = true;
            resolve();
          };
          setTimeout(finish, cap);
          const tick = () => {
            if (stopped) return;
            frames += 1;
            if (waitOptions) {
              const visible = Array.from(document.querySelectorAll('[role="option"]')).some(
                (node) => {
                  const box = (node as HTMLElement).getBoundingClientRect();
                  return box.width > 0 && box.height > 0;
                },
              );
              if (visible) {
                finish();
                return;
              }
            } else if (frames >= 2) {
              finish();
              return;
            }
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }),
      { cap: capMs, waitOptions: combobox },
    )
    .catch(() => undefined);
}

export async function settleAfterStateChange(
  browser: BrowserController,
  page?: Page,
  options?: { drive?: boolean; combobox?: boolean },
): Promise<void> {
  if (options?.drive === true) {
    await settleAfterDriveAction(page, options.combobox === true);
    return;
  }
  // A fixed dwell here used to consume the OAuth action's completion window
  // after the provider had already returned. Wait for the page's actual
  // interactive state instead; it resolves immediately when the redirect has
  // rendered and remains bounded for slow SPAs.
  await browser.waitForInteractiveDom(1, 2_000, page).catch(() => undefined);
}
