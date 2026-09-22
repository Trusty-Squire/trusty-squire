import {
  currentOperatorOperationId,
  persistOperatorTerminalReceipt,
  settleOperatorTerminalReceipt,
} from "../request-cancellation.js";
import type { OperationReceipt } from "../operation-receipt.js";
import { brokerBrowserCustody } from "../broker/custody.js";
import { brokerAdmissionAccount } from "../broker/admission-context.js";
// Phase 2 of the operator session-management restructure: the session
// lifecycle, moved out of provision-session.ts as ONE transaction.
//
// This module owns the live-session registry and everything whose ORDER is
// load-bearing around it: broker page acquisition and release,
// the ordinary and payment call leases and their drains, the idle/lifetime
// watchdog, the bounded close, the single terminal-teardown owner, the
// session artifact cleanup, and start/finish/shutdown themselves. It is one
// module because those are one transaction — a terminal transition drains
// leases, runs finish preparation, closes the owned tab family, clears artifacts,
// and only then deletes the EXACT
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
import type { BrowserController } from "../browser.js";
import { detectGoogleAccountEmail, detectSessionProviders } from "../oauth-login.js";
import { waitForCaptchaChallengeToSettle } from "../captcha.js";
import { compactV2AuditValue } from "../compact-observation-v2.js";
import type { ApiClient } from "../../api-client.js";
import { loginSessionGuidance } from "../skill-hint.js";
import type { OAuthProviderId } from "../oauth-providers.js";
import {
  OperatorBrowserWatchdog,
  type OperatorBrowserWatchdogReason,
} from "../operator-browser-watchdog.js";
import { createSession } from "./model.js";
import type { AllowedHostEntry, Session, SessionTerminalTeardownOwner } from "./model.js";
import { hostStrings, registrableHost } from "./hosts.js";
// Type-only, so no runtime cycle exists: the observation payload and the
// compact-v2 start metadata are perception's shapes, and perception stays in
// the facade until its own phase. The two start paths reach the live
// implementations through SessionStartPorts below.
import type { CompactV2StartMetadata } from "../observe/observe.js";
import type { Observation } from "../provision-session.js";

// The perception collaborators the two start paths need. The facade supplies
// the real implementations; nothing here may reach into perception directly.
export interface SessionStartPorts {
  observeSession: (
    session: Session,
    format: "compact" | "full",
    startMetadata?: CompactV2StartMetadata,
  ) => Promise<Observation>;
  compactV2StartMetadata: (
    registryHint: string | undefined,
    loginHint: string,
  ) => CompactV2StartMetadata;
}

const sessions = new Map<string, Session>();

interface AcquiredBrowser {
  controller: BrowserController;
  profileDir: string;
  shutdownGeneration: number;
}

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
  const sealedDetail = Object.fromEntries(
    Object.entries(detail).map(([key, value]) => [key, compactV2AuditValue(key, value)]),
  );
  process.stderr.write(
    `${JSON.stringify({ marker: "provision-audit", surface: "operate", session_id: sessionId, event, ...sealedDetail })}\n`,
  );
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

async function acquireWarmBrowser(opts: StartOptions): Promise<AcquiredBrowser> {
  const generation = provisionStartGeneration();
  const custody = brokerBrowserCustody();
  if (custody !== undefined) {
    const acquired = await custody.acquire(opts, brokerAdmissionAccount()?.accountId);
    try {
      assertProvisionStartAdmitted(generation);
    } catch (error) {
      await custody.release(acquired.browser);
      throw error;
    }
    return {
      controller: acquired.browser,
      profileDir: acquired.profileDir,
      shutdownGeneration: generation,
    };
  }
  throw new Error("operate_start requires broker browser custody");
}

async function releaseWarmBrowserPage(
  browser: BrowserController,
  _persistState: boolean,
  owner?: SessionTerminalTeardownOwner,
  beforeRelease?: () => Promise<void>,
): Promise<void> {
  const custody = brokerBrowserCustody();
  if (custody !== undefined) {
    await custody.release(browser, beforeRelease);
    return;
  }
  // Only explicit caller-owned harness sessions have no broker custody.
  if (owner?.forced) throw new Error("operator browser terminal teardown was forced");
  const closed = await browser.close();
  if (closed !== "closed") throw new Error("operator browser cleanup unproven");
  await beforeRelease?.();
}

async function forceReleaseWarmBrowserPage(
  browser: BrowserController,
  owner?: SessionTerminalTeardownOwner,
): Promise<void> {
  const custody = brokerBrowserCustody();
  if (custody !== undefined) {
    await custody.release(browser);
    return;
  }
  await closeBrowserUntilProven(
    browser,
    false,
    "operator browser force-close timed out",
    () => owner?.requireProvenBrowserClose === true,
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

function stopSessionWatchdog(session: Session): void {
  session.watchdog?.stop();
}

function disposeSessionWatchdog(session: Session): void {
  session.watchdog?.dispose();
  session.watchdog = null;
}

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
  requireProvenBrowserClose = false,
): Promise<unknown | undefined> {
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
    if (owner.requireProvenBrowserClose && sessions.has(session.id)) {
      await forceReleaseWarmBrowserPage(session.browser, owner);
    }
    return terminalError;
  }
  owner.forced = true;
  owner.forcePromise = forceTerminateProvisionSessionOwned(session, event, detail);
  return await owner.forcePromise;
}

async function forceTerminateProvisionSessionOwned(
  session: Session,
  event: string,
  detail: Record<string, unknown>,
): Promise<unknown | undefined> {
  session.closing = true;
  stopSessionWatchdog(session);
  audit(session.id, event, detail);
  deregisterProvisionSession(session);
  let terminalError: unknown;
  session.activePayment = null;
  session.releasedPaymentCard = null;
  const terminalOwner = session.terminalTeardownOwner ?? undefined;
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
      brokerBrowserCustody() !== undefined || session.initializing || session.callCount > 0,
    processMarker: () => session.browser.operatorBrowserMarker?.() ?? null,
    onTerminate: async (reason) => await terminateExpiredProvisionSession(session, reason),
  });
  session.watchdog = watchdog;
  watchdog.start();
}

/** Thrown when a session-addressed call names a session this process does not own. */
export class UnknownProvisionSessionError extends Error {
  constructor(sessionId: string) {
    super(`unknown provision session ${sessionId}`);
    this.name = "UnknownProvisionSessionError";
  }
}

export function sessionForCall(sessionId: string): Session | undefined {
  return sessions.get(sessionId);
}

// Card release uses the existing live human purchase approval. This lifecycle
// helper only resolves and leases the owning browser session.
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
    if (session === undefined) throw new UnknownProvisionSessionError(sessionId);
  } else {
    if (sessions.size !== 1) {
      throw new Error(
        sessions.size === 0
          ? "inject_card requires one active operate_start browser session"
          : "inject_card requires session_id when multiple operator sessions are active",
      );
    }
    session = sessions.values().next().value!;
  }
  assertPaymentSessionAllowed(session);
  return session;
}

const cancelledCallLeases = new WeakMap<Session, Set<AbortSignal>>();

function acquireSessionCallLease(session: Session): () => void {
  if ((cancelledCallLeases.get(session)?.size ?? 0) > 0)
    throw new Error("operator_session_busy: cancelled execution still owns this session");
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
  signal?: AbortSignal,
): Promise<T> {
  const session = sessionForCall(sessionId);
  if (session === undefined) throw new UnknownProvisionSessionError(sessionId);
  if (signal?.aborted) throw signal.reason ?? new Error("operator_request_cancelled");
  const cancelled = (): void => {
    const leases = cancelledCallLeases.get(session) ?? new Set<AbortSignal>();
    leases.add(signal!);
    cancelledCallLeases.set(session, leases);
  };
  signal?.addEventListener("abort", cancelled, { once: true });
  try {
    return await withSelectedProvisionSessionCall(session, fn);
  } finally {
    signal?.removeEventListener("abort", cancelled);
    if (signal !== undefined) cancelledCallLeases.get(session)?.delete(signal);
  }
}

export async function withPaymentSessionCall<T>(
  sessionId: string | undefined,
  fn: (session: Session) => Promise<T>,
): Promise<T> {
  const session = paymentSession(sessionId);
  return await withSelectedProvisionSessionCall(session, fn);
}

// ── start ──

export interface StartOptions {
  serviceUrl: string;
  /** Observation shape returned by this start. Compact is the public default. */
  format?: "compact" | "full";
  /** Internal drive callers take their first perception through the much
   * smaller drive snapshot instead of paying for the general observation. */
  initialObservation?: "standard" | "drive";
  // The user's real Chrome profile. Operate opens this directory directly.
  profileDir?: string;
  proxyUrl?: string;
  // Deprecated compatibility input; ignored.
  extraAllowedHosts?: readonly string[];
  // May the operator read the inbox for email verification? Sourced from the
  // install-time `consent_operator_inbox_otp` preference. It defaults on; an
  // explicit false makes awaitVerification hand the code request back instead.
  consentInboxRead?: boolean;
  // The MCP api-client, threaded from the operate_* tool layer. Enables the
  // provision captcha gate and the operate drive's auto-solve to spend a
  // VAULTED 2Captcha key via the injecting proxy.
  api?: ApiClient;
}

export interface HarnessStartOptions extends Omit<StartOptions, "profileDir" | "proxyUrl"> {
  browser: BrowserController;
}

// Fail-closed Google identity hand-back — NOT autonomous recovery. Apply this
// only when an operation actually needs the user's live Google identity (Google
// OAuth, Google-backed signup preparation, or Gmail verification), never as a
// blanket precondition on starting an unrelated browsing or checkout task.
export interface NeedsUserLogin {
  wall: "google_session";
  message: string;
  // The remedy names the ONE onboarding/re-auth pathway. It was `"login"`,
  // after a CLI subcommand that no longer exists — and because this string
  // reaches the host agent verbatim, agents kept recommending that dead
  // command to users. Keep it pointing at `connect`.
  resume: "connect";
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
        "as you yet. Reconnect with `npx @trusty-squire/mcp connect --force-relogin=google` " +
        "and retry " +
        "— the task has NOT started and nothing was changed.",
      resume: "connect",
    },
  };
}

async function detectProvisionPrimaryProviderSession(
  browser: BrowserController,
): Promise<{ providers: OAuthProviderId[]; userEmail: string | null }> {
  // Chrome materializes the real profile's provider jar after the account
  // surface is opened in this same context. Match the proven live-identity
  // path before reading the markers. The account lookup warms the context; it
  // is not itself the admission signal.
  const userEmail = await detectGoogleAccountEmail(browser).catch(() => null);
  // Fail closed, but never SILENTLY: an empty list refuses the start with the
  // same `google_session` wall as a genuinely signed-out profile, so a throwing
  // probe used to be indistinguishable from "not signed in". Say which it was.
  const providers = await detectSessionProviders(browser).catch((err: unknown) => {
    console.error(
      `[operate] provider-session detection failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [] as OAuthProviderId[];
  });
  return { providers, userEmail };
}

/** A LIVE Google identity, held for the life of the session and shared by every
 * Google-dependent operation: the probe costs a navigation, and re-running it
 * per operation gave a mid-flight task several independent chances to be
 * refused by one transient read. Only a detection that found Google is kept — a
 * negative or failed one is exactly the answer that must not go stale, since
 * the wall's own remedy is to run `connect` and retry on this same session.
 */
const sessionGoogleIdentity = new WeakMap<
  Session,
  { providers: OAuthProviderId[]; userEmail: string | null }
>();

/** Check the live Google identity at the operation that needs it.
 * Successful detection supplies the session email for signup and inbox work;
 * a missing provider returns the long-standing google_session hand-back.
 */
export async function googleSessionGateForSession(
  sessionId: string,
): Promise<{ ok: true } | { ok: false; needs_user: NeedsUserLogin }> {
  const session = sessions.get(sessionId);
  if (session === undefined) throw new UnknownProvisionSessionError(sessionId);
  const identity =
    sessionGoogleIdentity.get(session) ??
    (await detectProvisionPrimaryProviderSession(session.browser));
  const gate = googleSessionGate(identity.providers);
  if (gate.ok) {
    sessionGoogleIdentity.set(session, identity);
    session.userEmail = identity.userEmail;
  } else {
    audit(sessionId, "connect_gate", { ok: false, wall: "google_session" });
  }
  return gate;
}

export async function startProvisionSession(
  opts: StartOptions,
  ports: SessionStartPorts,
): Promise<Observation> {
  const id = randomUUID();
  const requestedFormat = opts.format ?? "full";
  let browser: BrowserController;
  const acquired = await acquireWarmBrowser(opts);
  browser = acquired.controller;
  try {
    assertProvisionStartAdmitted(acquired.shutdownGeneration);
  } catch (error) {
    await releaseWarmBrowserPage(browser, false);
    throw error;
  }
  const targetHost = registrableHost(opts.serviceUrl);
  const seedHosts = [...(targetHost !== null ? [targetHost] : [])];
  // The service host seeds credential egress; legacy extra hosts are ignored.
  const allowedHosts: AllowedHostEntry[] = [...new Set(seedHosts)].map((host) => ({
    host,
    source: "start" as const,
  }));
  const session = createSession({
    id,
    browser,
    allowedHosts,
    startUrl: opts.serviceUrl,
    consentInboxRead: opts.consentInboxRead !== false,
    userEmail: null,
    ...(opts.api !== undefined ? { api: opts.api } : {}),
  });
  sessions.set(id, session);
  startSessionWatchdog(session);
  try {
    audit(id, "start", {
      service_url: opts.serviceUrl,
      allowed_hosts: hostStrings(session),
    });
    await browser.goto(opts.serviceUrl, undefined, "document-ready");
    // A cookie/consent overlay (Usercentrics/OneTrust/…) renders after load and its
    // backdrop occludes the ENTIRE form — the agent then sees every element
    // occluded_by a div and gives up, or falls back to the only thing that looks
    // clickable (e.g. a "Connect wallet" CTA on the Robinhood faucet). Dismiss it
    // BEFORE a general first observation so the real actionable form is operable.
    // dismissConsentBanner() existed but had NO call sites (dead code); it only
    // clicks banner-specific CTAs (accept/reject all), so a false click is unlikely.
    // Best-effort + one retry, since the widget lazy-loads a beat after the goto.
    // A drive-owned start snapshots the overlay as an ordinary actionable state
    // instead of spending this general-observation settling budget up front.
    if (opts.initialObservation !== "drive") {
      for (let attempt = 0; attempt < 2; attempt++) {
        const cta = await browser.dismissConsentBanner().catch(() => null);
        if (cta !== null) {
          audit(id, "consent_dismissed", { cta });
          break;
        }
        if (attempt === 0)
          await waitForCaptchaChallengeToSettle(browser, 800, 0).catch(() => false);
      }
    }
    // Provider detection is intentionally lazy: ordinary starts pay no Google
    // identity probe and receive provider-neutral login guidance.
    const loginHint = loginSessionGuidance();
    if (opts.initialObservation === "drive") {
      session.initializing = false;
      session.lastActivityAt = Date.now();
      return {
        session_id: session.id,
        url: session.browser.currentUrl(),
        hint: loginHint,
      };
    }
    const observation = await ports.observeSession(
      session,
      requestedFormat,
      ports.compactV2StartMetadata(undefined, loginHint),
    );
    session.initializing = false;
    session.lastActivityAt = Date.now();
    if (
      observation.format === "browser-use-dom" ||
      observation.format === "browser-use-control-query"
    )
      return observation;
    return {
      ...observation,
      hint: loginHint,
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
  const requestedFormat = opts.format ?? "compact";
  const targetHost = registrableHost(opts.serviceUrl);
  const allowedHosts: AllowedHostEntry[] = [...(targetHost === null ? [] : [targetHost])]
    .filter((host, index, hosts) => hosts.indexOf(host) === index)
    .map((host) => ({
      host,
      source: "start" as const,
    }));
  const session = createSession({
    id,
    browser: opts.browser,
    allowedHosts,
    startUrl: opts.serviceUrl,
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
    await opts.browser.goto(opts.serviceUrl, undefined, "document-ready");
    if (opts.initialObservation === "drive") {
      session.initializing = false;
      session.lastActivityAt = Date.now();
      return { session_id: session.id, url: session.browser.currentUrl(), hint: "" };
    }
    const observation = await ports.observeSession(
      session,
      requestedFormat,
      ports.compactV2StartMetadata(undefined, ""),
    );
    session.initializing = false;
    session.lastActivityAt = Date.now();
    if (
      observation.format === "browser-use-dom" ||
      observation.format === "browser-use-control-query"
    )
      return observation;
    return { ...observation, hint: "" };
  } catch (error) {
    deregisterProvisionSession(session);
    disposeSessionWatchdog(session);
    await opts.browser.close().catch(() => undefined);
    throw error;
  }
}

export interface FinishResult extends OperationReceipt {
  url: string;
}

const FINISH_RESPONSE_TIMEOUT_MS = 4_000;

function finishReceipt(sessionId: string, url: string, closed: boolean): FinishResult {
  return {
    session_id: sessionId,
    operation_id: currentOperatorOperationId() ?? randomUUID(),
    execution: closed ? "completed" : "pending",
    mutation: "not_dispatched",
    cleanup: closed ? "closed" : "closing",
    closed,
    url,
  };
}

export interface PreparedFinishResult<T> {
  finish: FinishResult;
  prepared: T | undefined;
}

function clearSessionArtifacts(session: Session): void {
  session.secretSlots.clear();
  session.drive = null;
}

function deregisterProvisionSession(session: Session): void {
  clearSessionArtifacts(session);
  if (sessions.get(session.id) === session) sessions.delete(session.id);
}

async function closeFinishingProvisionSession(
  session: Session,
  persistState: boolean,
): Promise<FinishResult> {
  const sessionId = session.id;
  const url = session.browser.currentUrl();
  audit(sessionId, "finish", { url });
  session.activePayment = null;
  session.releasedPaymentCard = null;
  stopSessionWatchdog(session);
  const finish = finishReceipt(sessionId, url, true);
  const receipt: OperationReceipt = {
    session_id: finish.session_id,
    operation_id: finish.operation_id,
    execution: finish.execution,
    mutation: finish.mutation,
    cleanup: finish.cleanup,
    closed: finish.closed,
  };
  await releaseWarmBrowserPage(
    session.browser,
    persistState,
    session.terminalTeardownOwner ?? undefined,
    async () => {
      clearSessionArtifacts(session);
      await persistOperatorTerminalReceipt(receipt);
    },
  );
  deregisterProvisionSession(session);
  disposeSessionWatchdog(session);
  settleOperatorTerminalReceipt();
  return finish;
}

// A failed close/persistence attempt may be retried without replaying finish
// preparation (which can store a credential).
const finishCleanupRetries = new WeakMap<Session, () => Promise<FinishResult>>();

export async function finishProvisionSessionWithPreparation<T>(
  sessionId: string,
  prepare: () => Promise<T>,
  successfulOutcome: () => boolean = () => false,
): Promise<PreparedFinishResult<T>> {
  const session = sessionForCall(sessionId);
  if (session === undefined) throw new Error(`unknown provision session ${sessionId}`);
  if (session.closing) {
    const retry = finishCleanupRetries.get(session);
    if (retry !== undefined) {
      finishCleanupRetries.delete(session);
      const retrying = retry().catch((error: unknown) => {
        finishCleanupRetries.set(session, retry);
        throw error;
      });
      try {
        const finish = await withTerminalTimeout(
          retrying,
          FINISH_RESPONSE_TIMEOUT_MS,
          "operator cleanup remains pending",
        );
        return { finish, prepared: undefined };
      } catch {
        return {
          finish: finishReceipt(sessionId, session.browser.currentUrl(), false),
          prepared: undefined,
        };
      }
    }
    return {
      finish: finishReceipt(sessionId, session.browser.currentUrl(), false),
      prepared: undefined,
    };
  }
  const owner: SessionTerminalTeardownOwner = {
    forced: false,
    forcePromise: null,
    routinePromise: null,
    requireProvenBrowserClose: false,
  };
  session.terminalTeardownOwner = owner;
  session.closing = true;
  stopSessionWatchdog(session);
  let closingStarted = false;
  const transition = (async (): Promise<PreparedFinishResult<T>> => {
    await waitForSessionCallsToDrain(session);
    const prepared = await prepare();
    if (owner.forced || sessions.get(sessionId) !== session) {
      throw new Error(`provision session ${sessionId} terminal transition was forced`);
    }
    const persistState = successfulOutcome();
    closingStarted = true;
    const retryCleanup = () => closeFinishingProvisionSession(session, persistState);
    try {
      const finish = await retryCleanup();
      return { finish, prepared };
    } catch (error) {
      finishCleanupRetries.set(session, retryCleanup);
      throw error;
    }
  })().catch((error: unknown) => {
    if (!closingStarted && !owner.forced && sessions.get(sessionId) === session) {
      session.closing = false;
      session.terminalTeardownOwner = null;
      startSessionWatchdog(session);
    }
    throw error;
  });
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        transition,
        new Promise<PreparedFinishResult<T>>((resolve) => {
          timer = setTimeout(
            () =>
              resolve({
                finish: finishReceipt(sessionId, session.browser.currentUrl(), false),
                prepared: undefined,
              }),
            FINISH_RESPONSE_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  } catch (error) {
    if (!closingStarted && !owner.forced && sessions.get(sessionId) === session) {
      session.closing = false;
      session.terminalTeardownOwner = null;
      startSessionWatchdog(session);
    }
    throw error;
  }
}

export async function finishProvisionSession(sessionId: string): Promise<FinishResult> {
  return (await finishProvisionSessionWithPreparation(sessionId, async () => undefined)).finish;
}

export async function forceFinishProvisionSession(sessionId: string): Promise<boolean> {
  const session = sessionForCall(sessionId);
  if (session === undefined) return true;
  const terminalError = await forceTerminateProvisionSession(session, "broker_detached_expiry", {
    reason: "stuck_dispatched_operation",
  });
  return terminalError === undefined && sessionForCall(sessionId) === undefined;
}

// Test/teardown helper — close every live session (used by the dev shim on exit).
export async function closeAllProvisionSessions(): Promise<void> {
  shutdownGeneration += 1;
  shutdownInProgress += 1;
  try {
    await (async () => {
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
      const closeError = closeErrors.find((error) => error !== undefined);
      if (closeError !== undefined) throw closeError;
    })();
  } finally {
    shutdownInProgress -= 1;
  }
}

export function activeSessionCount(): number {
  return sessions.size;
}
