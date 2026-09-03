// Phase 2 of the operator session-management restructure: the session
// lifecycle, moved out of provision-session.ts as ONE transaction.
//
// This module owns the live-session registry and everything whose ORDER is
// load-bearing around it: the real-profile lease and its browser acquisition,
// the ordinary and payment call leases and their drains, the idle/lifetime
// watchdog, the bounded close, the single terminal-teardown owner, the
// session artifact cleanup, and start/finish/shutdown themselves. It is one
// module because those are one transaction — a terminal transition drains
// leases, runs finish preparation, audits a pending 3-D Secure outcome,
// closes the browser, clears artifacts, and only then deletes the EXACT
// session object from the map. Splitting that ordering across modules is how
// it silently regresses.
//
// provision-session.ts re-exports every public name here, so no caller import
// changed. Payment state transitions deliberately did NOT move: they still
// live in the facade, and this module only observes their fields at teardown.
//
// The one collaborator this module does not own is perception: the two start
// paths take their first observation through `SessionStartPorts`, supplied by
// the facade. That keeps the dependency one-way (facade → lifecycle) with no
// runtime import cycle, exactly as session/model.ts does with its type-only
// back-reference.
import { randomUUID } from "node:crypto";
import { lstatSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserController, type ThreeDsResolution } from "../browser.js";
import type { PendingThreeDsWait } from "../pay-operator.js";
import { compactV2AuditValue } from "../compact-observation-v2.js";
import type { ApiClient } from "../../api-client.js";
import {
  acquireProfileOperationGuard,
  CHROME_PROFILE_DIR,
  ProfileBusyError,
  type ProfileOperationLease,
  waitForProfileFree,
} from "../profile.js";
import { loginSessionGuidance } from "../skill-hint.js";
import type { OAuthProviderId } from "../oauth-providers.js";
import {
  OperatorBrowserWatchdog,
  type OperatorBrowserWatchdogReason,
} from "../operator-browser-watchdog.js";
import { createSession } from "./model.js";
import type { AllowedHostEntry, Session, SessionTerminalTeardownOwner } from "./model.js";
import {
  hostStrings,
  merchantSiblingSeedHosts,
  registrableHost,
  requestScopeHostStrings,
} from "./hosts.js";
// Type-only, so no runtime cycle exists: the observation payload and the
// compact-v2 start metadata are perception's shapes, and perception stays in
// the facade until its own phase. The two start paths reach the live
// implementations through SessionStartPorts below.
import type { CompactV2StartMetadata, Observation } from "../provision-session.js";

// The perception collaborators the two start paths need. The facade supplies
// the real implementations; nothing here may reach into perception directly.
export interface SessionStartPorts {
  observeSession: (
    session: Session,
    detail: "compact" | "full",
    startMetadata?: CompactV2StartMetadata,
  ) => Promise<Observation>;
  compactV2StartMetadata: (
    registryHint: string | undefined,
    loginHint: string,
    userEmail: string | null,
  ) => CompactV2StartMetadata;
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

// Audit trail (security posture): every session action emits one structured
// stderr line the host's MCP log captures. The `provision-audit` marker makes
// the trail greppable. No credential VALUES are ever logged — only the action
// shape + url.
export function audit(
  sessionId: string,
  event: string,
  detail: Record<string, unknown> = {},
): void {
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
    throw new ProfileBusyError(
      "another Trusty Squire session is already using the browser — close it first",
    );
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

export async function quiesceOAuthActionSession(session: Session): Promise<void> {
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

export function sessionForCall(sessionId: string): Session | undefined {
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

// Where a session's rolling observe snapshot lives. Owned here because the
// terminal artifact cleanup must remove exactly this directory; perception
// writes into it through the same helper.
export function observeSnapshotDir(sessionId: string): string {
  const override = (process.env.TRUSTY_SQUIRE_OBSERVE_DIR ?? "").trim();
  const parent = override.length > 0 ? override : join(tmpdir(), "trusty-squire-observe");
  return join(parent, sessionId);
}

function configuredCompactV2Mode(): "off" | "shadow" | "on" {
  const configured = (process.env.TRUSTY_SQUIRE_OBSERVE_V2 ?? "on").toLowerCase();
  if (configured === "off" || configured === "0") return "off";
  return configured === "shadow" ? "shadow" : "on";
}

// ── start ──

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
  // May the operator read the inbox for email verification? Sourced from the
  // install-time `consent_operator_inbox_otp` preference. It defaults on; an
  // explicit false makes awaitVerification hand the code request back instead.
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

export async function startProvisionSession(
  opts: StartOptions,
  ports: SessionStartPorts,
): Promise<Observation> {
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
  const session = createSession({
    id,
    browser,
    allowedHosts,
    compactV2Mode,
    startUrl: opts.serviceUrl,
    hintServed: opts.hint !== undefined,
    consentInboxRead: opts.consentInboxRead !== false,
    userEmail: workerEmail,
    ...(opts.api !== undefined ? { api: opts.api } : {}),
  });
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
    const observation = await ports.observeSession(
      session,
      "compact",
      ports.compactV2StartMetadata(opts.hint, loginHint, session.userEmail),
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
  ports: SessionStartPorts,
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
  const session = createSession({
    id,
    browser: opts.browser,
    allowedHosts,
    compactV2Mode: opts.observationFormat === "compact-v2" ? "on" : "off",
    startUrl: opts.serviceUrl,
    hintServed: opts.hint !== undefined,
    consentInboxRead: opts.consentInboxRead !== false,
    userEmail: null,
    ...(opts.api === undefined ? {} : { api: opts.api }),
  });
  sessions.set(id, session);
  startSessionWatchdog(session);
  try {
    audit(id, "start_harness", {
      service_url: opts.serviceUrl,
      allowed_hosts: hostStrings(session),
    });
    await opts.browser.goto(opts.serviceUrl);
    const observation = await ports.observeSession(
      session,
      "compact",
      ports.compactV2StartMetadata(opts.hint, "", null),
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
