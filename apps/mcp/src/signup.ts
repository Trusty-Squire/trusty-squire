// Embedded Signup-as-a-Service entry point (`@trusty-squire/mcp/signup`).
//
// Lets embedding applications (such as Grunt) run Trusty Squire's Google
// sign-in ceremony and automated website signup + API key capture against an
// app-owned Chrome profile directory (or explicit CDP endpoint) and an
// app-owned session store — without touching Squire's personal Chrome profile,
// personal session store, shared broker daemon, or hosted credential vault.

import { getDomain } from "tldts";
import {
  ApiClient,
  installInitiate,
  issueMachineToken,
  type InstallAsnPayload,
} from "./api-client.js";
import { detectAsn } from "./bot/asn.js";
import { BrowserController, type BrowserControllerOptions } from "./bot/browser.js";
import { pollInstallStatus, type InstallStatus } from "./bot/broker/ceremony.js";
import {
  captureCredentialSource,
  extractCredentials,
  probeCaptureSource,
  storableCredentials,
  type CaptureSourceProbe,
  type ExtractResult,
} from "./bot/capture/capture.js";
import { type CaptureSource } from "./bot/credential-capture.js";
import { drawsWindowsNatively, hasDisplay } from "./bot/display-env.js";
import {
  detectProviderSessionsFromProfile,
  exposeSharedBrokerCeremonyDisplay,
  type SharedCeremonyExposure,
} from "./bot/google-login.js";
import type { OAuthProviderId } from "./bot/oauth-providers.js";
import {
  runOperateDrive,
  type DriveArgs,
  type DriveDependencies,
  type DriveHandoff,
  type DriveStatus,
  type DriveStoredCredential,
  type InventedLogin,
} from "./bot/operate-drive.js";
import {
  currentProvisionUrl,
  finishProvisionSession,
  forceFinishProvisionSession,
  observedHostsForSession,
  startHarnessProvisionSession,
} from "./bot/provision-session.js";
import { namedTunnelConfig, type NamedLoginTunnel } from "./bot/remote-login-display.js";
import type { DriveTrajectoryStep } from "./bot/session/model.js";
import { PAIRING_TOKEN_TTL_MS } from "./pairing-ttl.js";
import {
  assertIsolatedProfileDir,
  assertIsolatedSessionPath,
  redactSecrets,
  redactUnknownSecrets,
  resolveSignupBrowserTarget,
  SignupConfigError,
  SignupProfileIsolationError,
  SignupSessionIsolationError,
  type ResolvedSignupBrowserTarget,
  type SignupConfigErrorCode,
} from "./signup/isolation.js";
import {
  clearSignupSession,
  DEFAULT_SIGNUP_API_BASE_URL,
  DEFAULT_SIGNUP_REGISTRY_BASE_URL,
  isCompleteSignupSession,
  readSignupSession,
  resolveDefaultSignupApiBaseUrl,
  writeSignupSession,
  type SessionStoreGuardOptions,
  type SignupSession,
} from "./signup/session-store.js";

export {
  assertIsolatedProfileDir,
  assertIsolatedSessionPath,
  clearSignupSession,
  DEFAULT_SIGNUP_API_BASE_URL,
  DEFAULT_SIGNUP_REGISTRY_BASE_URL,
  isCompleteSignupSession,
  readSignupSession,
  redactSecrets,
  redactUnknownSecrets,
  SignupConfigError,
  SignupProfileIsolationError,
  SignupSessionIsolationError,
  writeSignupSession,
};
export type {
  CaptureSource,
  DriveStatus,
  DriveTrajectoryStep,
  OAuthProviderId,
  SessionStoreGuardOptions,
  SignupConfigErrorCode,
  SignupSession,
};

const DEFAULT_AGENT_IDENTITY = "embedded-signup";
const DEFAULT_POLL_INTERVAL_MS = 1_500;
const GOOGLE_LOGOUT_URL = "https://accounts.google.com/Logout";
export const DEFAULT_MAX_SIGNUP_HANDOFFS = 10;

export type SignupBrowserLocation =
  | { kind: "none" }
  | { kind: "host_screen" }
  | { kind: "virtual"; url: string }
  | { kind: "remote_cdp"; endpoint: string }
  | { kind: "unreachable"; reason: string };

export interface SignupCeremonyOpenInfo {
  confirmUrl: string;
  setupCode: string;
  browserLocation: SignupBrowserLocation;
}

export interface ConnectSignupProfileOptions {
  /** Caller-owned Chrome profile directory. Required unless `cdpEndpoint` is provided. */
  profileDir?: string;
  /** Optional external Chrome CDP endpoint (alternative to `profileDir`). */
  cdpEndpoint?: string;
  /** Explicit escape hatch to permit Trusty Squire's default personal profile. Defaults to false. */
  allowDefaultProfile?: boolean;
  /** Optional file path where the resulting `SignupSession` is persisted with 0600 permissions. */
  sessionPath?: string;
  /** Explicit escape hatch to permit Squire's default session store path. Defaults to false. */
  allowDefaultSessionStore?: boolean;
  /** Optional callback invoked with the established `SignupSession`. */
  onSessionSaved?: (session: SignupSession) => Promise<void> | void;
  /** Trusty Squire API base URL. Defaults to `TRUSTY_SQUIRE_API_BASE` or production API. */
  apiBaseUrl?: string;
  /** Trusty Squire registry base URL. Defaults to production managed registry. */
  registryBaseUrl?: string;
  /** App identity passed to install initiation (e.g. `"grunt"`). Defaults to `"embedded-signup"`. */
  agentIdentity?: string;
  /** Optional per-launch HTTP/HTTPS/SOCKS5 proxy URL. */
  proxyUrl?: string;
  /** Sign out of Google before navigating to the confirm page so the user can choose an account. */
  forceRelogin?: boolean;
  /** Default inbox OTP reading consent for this session. Defaults to true. */
  consentOperatorInboxOtp?: boolean;
  /** Whether to wait for the user to click Finish after claiming the install. Defaults to true. */
  waitForFinish?: boolean;
  /** Maximum time to wait for sign-in completion. Defaults to 15 minutes (`PAIRING_TOKEN_TTL_MS`). */
  timeoutMs?: number;
  /** Status poll interval in milliseconds. Defaults to 1500ms. */
  pollIntervalMs?: number;
  /** Optional abort signal to cancel sign-in and tear down the browser immediately. */
  signal?: AbortSignal;
  /** Optional named tunnel config for headless Linux noVNC display exposure. */
  namedTunnel?: NamedLoginTunnel | null;
  /** Called as soon as the sign-in window is open and visible (or reachable via noVNC). */
  onSignInOpen?: (info: SignupCeremonyOpenInfo) => Promise<void> | void;
}

export interface EnsureSignupSessionOptions extends ConnectSignupProfileOptions {
  /** Optional already-loaded session to validate before starting a sign-in ceremony. */
  existingSession?: SignupSession | null;
}

export type SignupConnectResult =
  | {
      status: "connected" | "already_connected";
      session: SignupSession;
      providers: OAuthProviderId[];
      browserLocation: SignupBrowserLocation;
      /** Set only if saving the claimed session to sessionPath/onSessionSaved still failed after retries. The claimed session is still returned so the one-time token is never lost. */
      sessionSaveError?: string;
    }
  | {
      status: "expired" | "timed_out" | "cancelled";
      confirmUrl: string;
      browserLocation: SignupBrowserLocation;
      reason: string;
    }
  | {
      status: "unshowable";
      confirmUrl: string;
      browserLocation: { kind: "unreachable"; reason: string };
      reason: string;
    };

/**
 * Internal/testable browser surface for embedded signup operations.
 * `BrowserController` satisfies this interface directly.
 */
export interface EmbeddedBrowserLike {
  start(): Promise<void>;
  goto(url: string, page?: unknown, waitUntil?: "load" | "document-ready"): Promise<void>;
  close(options?: { cancelStart?: boolean }): Promise<unknown>;
  showPhoneCeremonyWindow?: () => Promise<{
    left: number;
    top: number;
    width: number;
    height: number;
  }>;
  restoreCeremonyWindow?: () => Promise<void>;
  currentUrl?: () => string;
}

export interface SignupConnectRuntime {
  fetchImpl?: typeof fetch;
  detectAsn?: () => Promise<InstallAsnPayload | null>;
  issueMachineToken?: typeof issueMachineToken;
  installInitiate?: typeof installInitiate;
  pollInstallStatus?: typeof pollInstallStatus;
  createBrowser?: (options: BrowserControllerOptions) => EmbeddedBrowserLike;
  detectProviders?: (profileDir: string) => Promise<OAuthProviderId[]>;
  hasDisplay?: () => boolean;
  drawsWindowsNatively?: () => boolean;
  exposeDisplay?: typeof exposeSharedBrokerCeremonyDisplay;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

export interface CapturedCredential {
  kind: "api_key" | "login";
  service: string;
  url: string;
  fields: Record<string, string>;
  fieldNames: string[];
  source: "extract" | "capture_source" | "invented_login";
  resolvedSource?: { tag: string; role?: string; name?: string; selector?: string };
  observedHosts: string[];
  capturedAt: string;
}

export interface CapturedCredentialMetadata {
  kind: "api_key" | "login";
  service: string;
  url: string;
  captured: true;
  fieldNames: string[];
  source: "extract" | "capture_source" | "invented_login";
  resolvedSource?: { tag: string; role?: string; name?: string; selector?: string };
  observedHosts: string[];
}

export type SignupStatus =
  | "completed"
  | "needs_human"
  | "low_confidence"
  | "needs_input"
  | "stuck"
  | "budget_exceeded"
  | "cancelled"
  | "failed";

export type SignupHandoffStatus = "needs_input" | "low_confidence" | "needs_human";

export interface SignupHandoffEvent {
  status: SignupHandoffStatus;
  driveStatus: DriveStatus;
  url: string;
  attempt: number;
  question?: string;
  options?: Record<string, string>;
  probabilities?: Record<string, number>;
  field?: string;
  needsUser?: DriveHandoff["needs_user"];
  oauth?: DriveHandoff["oauth"];
  message?: string;
  remaining?: string;
  reason?: string;
}

export interface SignupHandoffResponse {
  answer?: string | undefined;
  facts?: Record<string, string> | undefined;
  resume?: boolean | undefined;
}

export type SignupHandoffCallback = (
  handoff: SignupHandoffEvent,
) => Promise<SignupHandoffResponse | null | undefined> | SignupHandoffResponse | null | undefined;

export interface SignupResult {
  status: SignupStatus;
  service: string;
  url: string;
  captured: boolean;
  credentials: CapturedCredentialMetadata[];
  steps: number;
  seconds: number;
  jevCalls: number;
  driveStatus?: DriveStatus;
  done?: string;
  remaining?: string;
  reason?: string;
  message?: string;
  question?: string;
  options?: Record<string, string>;
  probabilities?: Record<string, number>;
  field?: string;
  needsUser?: DriveHandoff["needs_user"];
  oauth?: DriveHandoff["oauth"];
  trajectory: DriveTrajectoryStep[];
}

export interface RunSignupOptions {
  /** Target website signup or dashboard URL. */
  url: string;
  /** Natural-language goal for `runOperateDrive` (e.g. "Sign up with Google and create an API key"). */
  goal: string;
  /** Logical service name for metadata (defaults to registrable domain of `url`). */
  service?: string;
  /** Facts bag supplied to Jev for form filling (e.g. `{ email, company, name }`). */
  facts?: Record<string, string>;
  /** Caller-owned Chrome profile directory. Required unless `cdpEndpoint` is provided. */
  profileDir?: string;
  /** Optional external Chrome CDP endpoint (alternative to `profileDir`). */
  cdpEndpoint?: string;
  /** Explicit escape hatch to permit Trusty Squire's default personal profile. Defaults to false. */
  allowDefaultProfile?: boolean;
  /** Authenticated `SignupSession` (from `connectSignupProfile` / `ensureSignupSession`). */
  session?: SignupSession;
  /** Alternative to `session`: explicit app-owned session file path to load from. */
  sessionPath?: string;
  /** Explicit escape hatch to permit Squire's default session store path. Defaults to false. */
  allowDefaultSessionStore?: boolean;
  /** In-process callback that receives raw captured credentials. Required. */
  onCredentialCaptured: (credential: CapturedCredential) => Promise<void> | void;
  /** Optional dedicated callback for invented username/password signups. Defaults to `onCredentialCaptured`. */
  onLoginCreated?: (credential: CapturedCredential) => Promise<void> | void;
  /** Optional explicit DOM/CSS/role/clipboard capture source(s) to read once the drive finishes. */
  captureSource?: CaptureSource | readonly CaptureSource[];
  /** Optional progress/notification callback (always redacted of captured secrets). */
  onProgress?: (message: string, data?: Record<string, unknown>) => Promise<void> | void;
  /**
   * Optional pause/handoff callback invoked when `runOperateDrive` pauses for
   * input (`needs_value`), an ambiguous/OAuth choice (`low_confidence`), or a
   * human action (`needs_human`). Returning `{ answer }`, `{ facts }`, or
   * `{ resume: true }` keeps the browser session open and resumes
   * `runOperateDrive` on the same `session_id`.
   */
  onHandoff?: SignupHandoffCallback;
  /** Maximum number of handoff-resume cycles allowed per `runSignup` call. Defaults to 10. */
  maxHandoffs?: number;
  /** App identity header sent on API requests. Defaults to `"embedded-signup"`. */
  agentIdentity?: string;
  /** Optional per-launch HTTP/HTTPS/SOCKS5 proxy URL. */
  proxyUrl?: string;
  /** Whether to humanize browser interactions. Defaults to true. */
  humanize?: boolean;
  /** Whether OTP inbox reading is permitted during this run. Defaults to session setting or true. */
  consentInboxRead?: boolean;
  /** Maximum drive steps. */
  maxSteps?: number;
  /** Maximum drive duration in seconds. */
  maxSeconds?: number;
  /** Optional overall wall-clock timeout in milliseconds (cancels browser + drive cleanly). */
  timeoutMs?: number;
  /** Optional abort signal to cancel the run and tear down the browser cleanly. */
  signal?: AbortSignal;
}

export interface SignupRunRuntime {
  fetchImpl?: typeof fetch;
  createBrowser?: (options: BrowserControllerOptions) => BrowserController;
  createApiClient?: (session: SignupSession, fetchImpl?: typeof fetch) => ApiClient;
  startHarnessSession?: typeof startHarnessProvisionSession;
  finishSession?: typeof finishProvisionSession;
  forceFinishSession?: typeof forceFinishProvisionSession;
  runDrive?: typeof runOperateDrive;
  driveDependencies?: Partial<DriveDependencies>;
  extractCredentials?: typeof extractCredentials;
  captureCredentialSource?: typeof captureCredentialSource;
  probeCaptureSource?: typeof probeCaptureSource;
  observedHostsForSession?: typeof observedHostsForSession;
  currentProvisionUrl?: typeof currentProvisionUrl;
  now?: () => number;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? new Error("signup_cancelled"));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal === undefined) return;
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("signup_cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function isSignupTokenValid(
  apiBaseUrl: string,
  agentSessionToken: string,
  fetchImpl: typeof fetch,
): Promise<boolean> {
  try {
    const res = await fetchImpl(`${apiBaseUrl}/v1/vault/credentials`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${agentSessionToken}`,
        Accept: "application/json",
      },
    });
    return res.status !== 401 && res.status !== 403;
  } catch {
    // Treat transient network errors like connect's preflight: do not force a
    // full interactive re-login on a transient blip.
    return true;
  }
}

function inferServiceName(url: string, explicit?: string): string {
  const trimmed = explicit?.trim();
  if (trimmed !== undefined && trimmed.length > 0) return trimmed;
  try {
    const domain = getDomain(url, { allowPrivateDomains: true });
    if (domain !== null && domain.length > 0) return domain;
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "") || "unknown";
  } catch {
    return "unknown";
  }
}

function buildBrowserControllerOptions(
  target: ResolvedSignupBrowserTarget,
  extra: { proxyUrl?: string | undefined; humanize?: boolean | undefined } = {},
): BrowserControllerOptions {
  return {
    ...(target.profileDir !== undefined ? { profileDir: target.profileDir } : {}),
    ...(target.cdpEndpoint !== undefined ? { cdpEndpoint: target.cdpEndpoint } : {}),
    ...(extra.proxyUrl !== undefined ? { proxyUrl: extra.proxyUrl } : {}),
    ...(extra.humanize !== undefined ? { humanize: extra.humanize } : {}),
  };
}

function createNoVaultApiClient(
  session: SignupSession,
  agentIdentity: string,
  runtime?: Pick<SignupRunRuntime, "createApiClient" | "fetchImpl">,
): ApiClient {
  const client =
    runtime?.createApiClient !== undefined
      ? runtime.createApiClient(session, runtime.fetchImpl)
      : new ApiClient({
          apiBaseUrl: session.apiBaseUrl,
          agentSessionToken: session.agentSessionToken,
          agentIdentity,
          registryBaseUrl: session.registryBaseUrl ?? DEFAULT_SIGNUP_REGISTRY_BASE_URL,
          accountId: session.accountId,
          ...(runtime?.fetchImpl !== undefined ? { fetch: runtime.fetchImpl } : {}),
        });
  if (typeof client.setRequestingAgent === "function") {
    client.setRequestingAgent(agentIdentity);
  }
  // Defense-in-depth: embedded signup runs must NEVER store captured
  // credentials in Squire's hosted cloud vault.
  Object.defineProperty(client, "storeCredential", {
    configurable: true,
    writable: true,
    value: async (): Promise<never> => {
      throw new Error(
        "embedded signup forbids writing credentials to the hosted Trusty Squire vault",
      );
    },
  });
  return client;
}

/**
 * Ensures an isolated `SignupSession` and live Google profile session exist.
 *
 * When a complete session is already available (via `existingSession` or
 * `sessionPath`), its `agentSessionToken` is still accepted by the API, and
 * `profileDir` already holds persisted Google session cookies (or the caller
 * targets an explicit `cdpEndpoint` without a local `profileDir`), this returns
 * `{ status: "already_connected", ... }` immediately without opening a browser.
 * Otherwise it runs `connectSignupProfile`.
 */
export async function ensureSignupSession(
  options: EnsureSignupSessionOptions,
  runtime: SignupConnectRuntime = {},
): Promise<SignupConnectResult> {
  const target = resolveSignupBrowserTarget(options);
  if (options.sessionPath !== undefined) {
    assertIsolatedSessionPath(options.sessionPath, {
      ...(options.allowDefaultSessionStore !== undefined
        ? { allowDefaultSessionStore: options.allowDefaultSessionStore }
        : {}),
    });
  }

  if (options.forceRelogin !== true) {
    const existing =
      options.existingSession !== undefined
        ? options.existingSession
        : options.sessionPath !== undefined
          ? await readSignupSession(options.sessionPath, {
              ...(options.allowDefaultSessionStore !== undefined
                ? { allowDefaultSessionStore: options.allowDefaultSessionStore }
                : {}),
            })
          : null;

    if (isCompleteSignupSession(existing)) {
      const fetchImpl = runtime.fetchImpl ?? globalThis.fetch;
      const tokenValid = await isSignupTokenValid(
        existing.apiBaseUrl,
        existing.agentSessionToken,
        fetchImpl,
      );
      if (tokenValid) {
        if (target.cdpEndpoint === undefined && target.profileDir !== undefined) {
          const detectProviders = runtime.detectProviders ?? detectProviderSessionsFromProfile;
          const providers = await detectProviders(target.profileDir).catch(
            (): OAuthProviderId[] => [],
          );
          if (providers.includes("google")) {
            return {
              status: "already_connected",
              session: existing,
              providers,
              browserLocation: { kind: "none" },
            };
          }
        } else {
          return {
            status: "already_connected",
            session: existing,
            providers: [],
            browserLocation: { kind: "none" },
          };
        }
      }
    }
  }

  return await connectSignupProfile(options, runtime);
}

/**
 * Runs Trusty Squire's one-time Google sign-in and install-claim ceremony
 * directly inside the caller's isolated `profileDir` (or `cdpEndpoint`) without
 * starting or touching Squire's shared broker daemon or personal session store.
 */
export async function connectSignupProfile(
  options: ConnectSignupProfileOptions,
  runtime: SignupConnectRuntime = {},
): Promise<SignupConnectResult> {
  const target = resolveSignupBrowserTarget(options);
  const safeSessionPath =
    options.sessionPath !== undefined
      ? assertIsolatedSessionPath(options.sessionPath, {
          ...(options.allowDefaultSessionStore !== undefined
            ? { allowDefaultSessionStore: options.allowDefaultSessionStore }
            : {}),
        })
      : undefined;

  const fetchImpl = runtime.fetchImpl ?? globalThis.fetch;
  const now = runtime.now ?? Date.now;
  const sleep = runtime.sleep ?? defaultSleep;
  const apiBaseUrl = (options.apiBaseUrl?.trim() || resolveDefaultSignupApiBaseUrl()).replace(
    /\/+$/,
    "",
  );
  const registryBaseUrl = (
    options.registryBaseUrl?.trim() || DEFAULT_SIGNUP_REGISTRY_BASE_URL
  ).replace(/\/+$/, "");
  const agentIdentity = options.agentIdentity?.trim() || DEFAULT_AGENT_IDENTITY;
  const pollIntervalMs = Math.max(50, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  const timeoutMs = Math.max(1, options.timeoutMs ?? PAIRING_TOKEN_TTL_MS);
  const waitForFinish = options.waitForFinish !== false;

  if (options.signal?.aborted) {
    return {
      status: "cancelled",
      confirmUrl: "",
      browserLocation: { kind: "none" },
      reason: "Sign-in ceremony cancelled before launch.",
    };
  }

  const asn = await (runtime.detectAsn ?? detectAsn)().catch(() => null);
  const machine = await (runtime.issueMachineToken ?? issueMachineToken)(
    apiBaseUrl,
    fetchImpl,
    asn ?? undefined,
  );
  const initiate = await (runtime.installInitiate ?? installInitiate)(
    apiBaseUrl,
    agentIdentity,
    machine.machine_token,
    fetchImpl,
  );

  const browser = (runtime.createBrowser ?? ((opts) => new BrowserController(opts)))(
    buildBrowserControllerOptions(target, { proxyUrl: options.proxyUrl }),
  );
  let stopExposure: (() => Promise<void>) | null = null;
  let browserLocation: SignupBrowserLocation = { kind: "none" };

  const onAbort = () => {
    void browser.close({ cancelStart: true }).catch(() => undefined);
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    if (options.signal?.aborted) {
      return {
        status: "cancelled",
        confirmUrl: initiate.confirm_url,
        browserLocation,
        reason: "Sign-in ceremony cancelled.",
      };
    }

    await browser.start();
    if (options.forceRelogin === true) {
      await browser.goto(GOOGLE_LOGOUT_URL, undefined, "document-ready").catch(() => undefined);
    }
    await browser.goto(initiate.confirm_url, undefined, "document-ready");

    // Determine how the user sees the ceremony browser window.
    // BrowserProcessOwner attaches over CDP whenever cdpEndpoint is set, so
    // cdpEndpoint alone decides whether the window runs in a remote browser.
    if (target.cdpEndpoint !== undefined) {
      browserLocation = { kind: "remote_cdp", endpoint: target.cdpEndpoint };
    } else {
      const nativeWindows = (runtime.drawsWindowsNatively ?? drawsWindowsNatively)();
      const callerHasDisplay = (runtime.hasDisplay ?? hasDisplay)();
      if (nativeWindows || callerHasDisplay) {
        browserLocation = { kind: "host_screen" };
      } else if (target.profileDir !== undefined) {
        const expose = runtime.exposeDisplay ?? exposeSharedBrokerCeremonyDisplay;
        const windowControl =
          browser.showPhoneCeremonyWindow !== undefined &&
          browser.restoreCeremonyWindow !== undefined
            ? {
                showPhone: () => browser.showPhoneCeremonyWindow!(),
                restore: () => browser.restoreCeremonyWindow!(),
              }
            : undefined;
        const exposure: SharedCeremonyExposure = await expose(
          target.profileDir,
          undefined,
          windowControl,
          callerHasDisplay,
          options.namedTunnel !== undefined ? options.namedTunnel : namedTunnelConfig(),
        );
        if (exposure.kind === "unshowable") {
          return {
            status: "unshowable",
            confirmUrl: initiate.confirm_url,
            browserLocation: { kind: "unreachable", reason: exposure.reason },
            reason: exposure.reason,
          };
        }
        if (exposure.kind === "exposed") {
          stopExposure = exposure.stop;
          browserLocation = { kind: "virtual", url: exposure.url };
        } else {
          browserLocation = { kind: "host_screen" };
        }
      }
    }

    await options.onSignInOpen?.({
      confirmUrl: initiate.confirm_url,
      setupCode: initiate.setup_code,
      browserLocation,
    });

    const deadline = now() + timeoutMs;
    const poll = runtime.pollInstallStatus ?? pollInstallStatus;
    let claimedSession: SignupSession | null = null;
    let filePersisted = safeSessionPath === undefined;
    let callbackPersisted = options.onSessionSaved === undefined;
    let lastSaveError: string | null = null;

    // The server delivers the agent session token only once. Never let a
    // persistence error discard a claimed session: retry on every poll and
    // still return the claimed session to the caller even if saving fails.
    const persistClaim = async (session: SignupSession): Promise<void> => {
      if (filePersisted && callbackPersisted) return;
      const secrets = [session.agentSessionToken, session.machineToken];
      const errors: string[] = [];
      if (!filePersisted && safeSessionPath !== undefined) {
        try {
          await writeSignupSession(safeSessionPath, session, {
            ...(options.allowDefaultSessionStore !== undefined
              ? { allowDefaultSessionStore: options.allowDefaultSessionStore }
              : {}),
          });
          filePersisted = true;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          errors.push(`session file write failed: ${redactSecrets(message, secrets)}`);
        }
      }
      if (!callbackPersisted && options.onSessionSaved !== undefined) {
        try {
          await options.onSessionSaved(session);
          callbackPersisted = true;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          errors.push(`onSessionSaved callback failed: ${redactSecrets(message, secrets)}`);
        }
      }
      lastSaveError = errors.length > 0 ? errors.join("; ") : null;
    };

    while (now() < deadline) {
      if (options.signal?.aborted) {
        if (claimedSession !== null) break;
        return {
          status: "cancelled",
          confirmUrl: initiate.confirm_url,
          browserLocation,
          reason: "Sign-in ceremony cancelled.",
        };
      }

      let status: InstallStatus | null = null;
      try {
        status = await poll(apiBaseUrl, initiate.setup_code, fetchImpl);
      } catch {
        status = null;
      }

      if (status?.status === "claimed") {
        const consentOtp =
          options.consentOperatorInboxOtp !== undefined
            ? options.consentOperatorInboxOtp
            : status.install_preferences?.consent_operator_inbox_otp !== false;
        claimedSession = {
          apiBaseUrl,
          registryBaseUrl,
          accountId: status.account_id,
          agentSessionToken: status.agent_session_token,
          machineToken: machine.machine_token,
          savedAt: new Date(now()).toISOString(),
          consentOperatorInboxOtp: consentOtp,
        };
      }

      if (claimedSession !== null && (!filePersisted || !callbackPersisted)) {
        await persistClaim(claimedSession);
      }

      if (status?.status === "claimed") {
        if (!waitForFinish || status.finished) {
          break;
        }
      } else if (status?.status === "delivered") {
        if (claimedSession !== null && (!waitForFinish || status.finished)) {
          break;
        }
      } else if (status?.status === "expired") {
        if (claimedSession !== null) break;
        return {
          status: "expired",
          confirmUrl: initiate.confirm_url,
          browserLocation,
          reason: "The sign-in pairing window expired before completion.",
        };
      }

      const remaining = deadline - now();
      if (remaining <= 0) break;
      try {
        await sleep(Math.min(pollIntervalMs, remaining), options.signal);
      } catch {
        if (options.signal?.aborted) {
          if (claimedSession !== null) break;
          return {
            status: "cancelled",
            confirmUrl: initiate.confirm_url,
            browserLocation,
            reason: "Sign-in ceremony cancelled.",
          };
        }
        throw new Error("Sign-in ceremony poll interrupted");
      }
    }

    if (claimedSession === null) {
      return {
        status: "timed_out",
        confirmUrl: initiate.confirm_url,
        browserLocation,
        reason: "Timed out waiting for the user to complete Google sign-in.",
      };
    }

    if (!filePersisted || !callbackPersisted) {
      await persistClaim(claimedSession);
    }

    // Close the browser before probing disk cookies so Chrome flushes SQLite.
    await stopExposure?.().catch(() => undefined);
    stopExposure = null;
    await browser.close().catch(() => undefined);

    const providers =
      target.cdpEndpoint === undefined && target.profileDir !== undefined
        ? await (runtime.detectProviders ?? detectProviderSessionsFromProfile)(
            target.profileDir,
          ).catch((): OAuthProviderId[] => [])
        : [];

    return {
      status: "connected",
      session: claimedSession,
      providers,
      browserLocation,
      ...(lastSaveError !== null ? { sessionSaveError: lastSaveError } : {}),
    };
  } catch (err) {
    if (options.signal?.aborted) {
      return {
        status: "cancelled",
        confirmUrl: initiate.confirm_url,
        browserLocation,
        reason: "Sign-in ceremony cancelled.",
      };
    }
    throw err;
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    await stopExposure?.().catch(() => undefined);
    await browser.close({ cancelStart: true }).catch(() => undefined);
  }
}

function mapDriveStatus(handoff: DriveHandoff): SignupStatus {
  switch (handoff.status) {
    case "complete":
      return "completed";
    case "awaiting_human":
    case "pending_approval":
    case "approval_expired":
    case "card_incomplete":
      return "needs_human";
    case "low_confidence":
      return "low_confidence";
    case "needs_value":
      return handoff.needs_user !== undefined ? "needs_human" : "needs_input";
    case "stuck":
    case "no_progress":
    case "invalid_answer":
      return "stuck";
    case "budget":
      return "budget_exceeded";
    case "jev_unavailable":
    case "evaluate_timeout":
    case "busy":
      return "failed";
  }
}

function isResumableHandoffStatus(status: SignupStatus): status is SignupHandoffStatus {
  return status === "needs_input" || status === "low_confidence" || status === "needs_human";
}

function hasHandoffContinuation(
  response: SignupHandoffResponse | null | undefined,
): response is SignupHandoffResponse {
  if (response === null || response === undefined) return false;
  if (response.resume === false) return false;
  const hasAnswer = typeof response.answer === "string" && response.answer.trim().length > 0;
  const hasFacts = response.facts !== undefined && Object.keys(response.facts).length > 0;
  return response.resume === true || hasAnswer || hasFacts;
}

async function awaitWithSignal<T>(
  operation: () => Promise<T> | T,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (signal?.aborted) {
    throw signal.reason ?? new Error("signup_cancelled");
  }
  const promise = Promise.resolve().then(operation);
  if (signal === undefined) {
    return await promise;
  }
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(signal.reason ?? new Error("signup_cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

function composeRunSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): { signal: AbortSignal | undefined; dispose: () => void } {
  if (timeoutMs === undefined) {
    return { signal, dispose: () => undefined };
  }
  const controller = new AbortController();
  const timer = setTimeout(
    () => {
      controller.abort(new Error(`Embedded signup timed out after ${timeoutMs}ms`));
    },
    Math.max(1, timeoutMs),
  );
  const onParentAbort = () => {
    controller.abort(signal?.reason ?? new Error("signup_cancelled"));
  };
  if (signal?.aborted) {
    clearTimeout(timer);
    controller.abort(signal.reason ?? new Error("signup_cancelled"));
  } else {
    signal?.addEventListener("abort", onParentAbort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onParentAbort);
    },
  };
}

/**
 * Runs an automated website signup and API key capture against an app-owned
 * Chrome profile (or explicit `cdpEndpoint`).
 *
 * Captured credentials are delivered strictly in-process to
 * `onCredentialCaptured` (never written to Trusty Squire's hosted vault, never
 * logged, and never included in the returned `SignupResult`).
 */
export async function runSignup(
  options: RunSignupOptions,
  runtime: SignupRunRuntime = {},
): Promise<SignupResult> {
  if (typeof options.onCredentialCaptured !== "function") {
    throw new SignupConfigError(
      "callback_required",
      "runSignup requires an onCredentialCaptured callback to receive captured credentials in-process.",
    );
  }
  const goal = options.goal?.trim() ?? "";
  if (goal.length === 0) {
    throw new SignupConfigError("goal_required", "runSignup requires a non-empty goal.");
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(options.url);
  } catch {
    throw new SignupConfigError("invalid_url", "runSignup requires a valid http(s) url.");
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new SignupConfigError("invalid_url", "runSignup url must use http: or https:.");
  }

  const target = resolveSignupBrowserTarget(options);
  let session: SignupSession | null = options.session ?? null;
  if (session === null && options.sessionPath !== undefined) {
    session = await readSignupSession(options.sessionPath, {
      ...(options.allowDefaultSessionStore !== undefined
        ? { allowDefaultSessionStore: options.allowDefaultSessionStore }
        : {}),
    });
  }
  if (!isCompleteSignupSession(session)) {
    throw new SignupConfigError(
      "session_required",
      "runSignup requires a complete SignupSession (pass `session` or an app-owned `sessionPath` populated by `connectSignupProfile`).",
    );
  }

  const now = runtime.now ?? Date.now;
  const startedAt = now();
  const service = inferServiceName(options.url, options.service);
  const agentIdentity = options.agentIdentity?.trim() || DEFAULT_AGENT_IDENTITY;
  const api = createNoVaultApiClient(session, agentIdentity, runtime);
  const browser = (runtime.createBrowser ?? ((opts) => new BrowserController(opts)))(
    buildBrowserControllerOptions(target, {
      proxyUrl: options.proxyUrl,
      humanize: options.humanize,
    }),
  );

  const capturedSecrets = new Set<string>();
  const deliveredSignatures = new Set<string>();
  const capturedMetadata: CapturedCredentialMetadata[] = [];
  let callbackFailure: string | null = null;
  let sessionId: string | undefined;
  let preClipboardProbe: CaptureSourceProbe | undefined;

  const captureSources: readonly CaptureSource[] =
    options.captureSource === undefined
      ? []
      : Array.isArray(options.captureSource)
        ? options.captureSource
        : [options.captureSource];
  const needsClipboardPreProbe = captureSources.some((src) => "clipboard" in src);

  const deliverCredential = async (input: {
    kind: "api_key" | "login";
    url: string;
    fields: Record<string, string>;
    source: "extract" | "capture_source" | "invented_login";
    resolvedSource?: { tag: string; role?: string; name?: string; selector?: string };
    useLoginCallback?: boolean;
  }): Promise<boolean> => {
    for (const value of Object.values(input.fields)) {
      if (value.trim().length > 0) capturedSecrets.add(value);
    }
    const fieldNames = Object.keys(input.fields);
    if (fieldNames.length === 0) return false;
    const signature = JSON.stringify([
      input.kind,
      fieldNames
        .slice()
        .sort()
        .map((key) => [key, input.fields[key]]),
    ]);
    if (deliveredSignatures.has(signature)) return true;

    const observedHosts = (() => {
      const domain = getDomain(input.url, { allowPrivateDomains: true });
      const sessionHosts =
        sessionId !== undefined
          ? (() => {
              try {
                return (runtime.observedHostsForSession ?? observedHostsForSession)(sessionId);
              } catch {
                return [];
              }
            })()
          : [];
      return [...new Set([...sessionHosts, ...(domain !== null ? [`*.${domain}`] : [])])];
    })();

    const credential: CapturedCredential = {
      kind: input.kind,
      service,
      url: input.url,
      fields: { ...input.fields },
      fieldNames,
      source: input.source,
      ...(input.resolvedSource !== undefined ? { resolvedSource: input.resolvedSource } : {}),
      observedHosts,
      capturedAt: new Date(now()).toISOString(),
    };

    const callback =
      input.useLoginCallback === true && options.onLoginCreated !== undefined
        ? options.onLoginCreated
        : options.onCredentialCaptured;
    try {
      await callback(credential);
      callbackFailure = null;
    } catch (err) {
      const rawMessage = err instanceof Error ? err.message : String(err);
      callbackFailure = redactSecrets(rawMessage, capturedSecrets);
      return false;
    }

    deliveredSignatures.add(signature);
    capturedMetadata.push({
      kind: input.kind,
      service,
      url: input.url,
      captured: true,
      fieldNames,
      source: input.source,
      ...(input.resolvedSource !== undefined ? { resolvedSource: input.resolvedSource } : {}),
      observedHosts,
    });
    return true;
  };

  const composed = composeRunSignal(options.signal, options.timeoutMs);
  const effectiveSignal = composed.signal;
  const onAbort = () => {
    void browser.close({ cancelStart: true }).catch(() => undefined);
  };
  effectiveSignal?.addEventListener("abort", onAbort, { once: true });

  const startHarness = runtime.startHarnessSession ?? startHarnessProvisionSession;
  const finishSession = runtime.finishSession ?? finishProvisionSession;
  const forceFinishSession = runtime.forceFinishSession ?? forceFinishProvisionSession;
  const runDrive = runtime.runDrive ?? runOperateDrive;
  const runExtract = runtime.extractCredentials ?? extractCredentials;
  const runCaptureSource = runtime.captureCredentialSource ?? captureCredentialSource;
  const runProbeSource = runtime.probeCaptureSource ?? probeCaptureSource;
  const readCurrentUrl = runtime.currentProvisionUrl ?? currentProvisionUrl;

  let totalSteps = 0;
  let totalDriveSeconds = 0;
  let lastJevCalls = 0;
  let lastTrajectory: DriveTrajectoryStep[] = [];
  let lastKnownUrl = options.url;

  const resolveCurrentUrl = (fallbackUrl: string): string => {
    if (sessionId !== undefined) {
      try {
        return readCurrentUrl(sessionId);
      } catch {
        // fall through
      }
    }
    return fallbackUrl;
  };

  try {
    if (effectiveSignal?.aborted) {
      return {
        status: "cancelled",
        service,
        url: options.url,
        captured: false,
        credentials: [],
        steps: 0,
        seconds: (now() - startedAt) / 1000,
        jevCalls: 0,
        reason: redactSecrets(
          effectiveSignal.reason instanceof Error
            ? effectiveSignal.reason.message
            : "Embedded signup cancelled before browser launch.",
          capturedSecrets,
        ),
        trajectory: [],
      };
    }

    await browser.start();
    if (effectiveSignal?.aborted) {
      throw effectiveSignal.reason ?? new Error("signup_cancelled");
    }

    const localStartSession: DriveDependencies["startSession"] = async (startOpts) => {
      const obs = await startHarness({
        browser,
        serviceUrl: startOpts.serviceUrl,
        ...(startOpts.format !== undefined ? { format: startOpts.format } : {}),
        ...(startOpts.initialObservation !== undefined
          ? { initialObservation: startOpts.initialObservation }
          : {}),
        ...(startOpts.consentInboxRead !== undefined
          ? { consentInboxRead: startOpts.consentInboxRead }
          : {}),
        ...(startOpts.api !== undefined ? { api: startOpts.api } : {}),
      });
      sessionId = obs.session_id;
      if (needsClipboardPreProbe) {
        preClipboardProbe = await runProbeSource(sessionId, { clipboard: true }).catch(
          () => undefined,
        );
      }
      return obs;
    };

    const maxSeconds =
      options.maxSeconds !== undefined
        ? options.maxSeconds
        : options.timeoutMs !== undefined
          ? Math.max(1, Math.ceil(options.timeoutMs / 1000))
          : undefined;
    const maxHandoffs =
      options.maxHandoffs !== undefined
        ? Math.max(0, Math.floor(options.maxHandoffs))
        : DEFAULT_MAX_SIGNUP_HANDOFFS;

    const driveContext = {
      ...(effectiveSignal !== undefined ? { signal: effectiveSignal } : {}),
      consentInboxRead: options.consentInboxRead ?? session.consentOperatorInboxOtp ?? true,
      ...(options.onProgress !== undefined
        ? {
            notifyUser: async (message: string, data?: Record<string, unknown>) => {
              await options.onProgress!(
                redactSecrets(message, capturedSecrets),
                data === undefined ? undefined : redactUnknownSecrets(data, capturedSecrets),
              );
            },
          }
        : {}),
      persistCredentials: async (
        extracted: ExtractResult,
      ): Promise<DriveStoredCredential | null> => {
        const storable = storableCredentials(extracted.credentials);
        if (storable === null) return null;
        const ok = await deliverCredential({
          kind: "api_key",
          url: extracted.url,
          fields: storable,
          source: "extract",
        });
        if (!ok) return null;
        return {
          reference: "embedded:callback",
          service,
          label: undefined,
        };
      },
      persistLogin: async (invented: InventedLogin): Promise<boolean> => {
        return await deliverCredential({
          kind: "login",
          url: invented.url,
          fields: { login: invented.login, password: invented.password },
          source: "invented_login",
          useLoginCallback: true,
        });
      },
    };

    const driveDeps = (
      runtime.driveDependencies !== undefined
        ? {
            ...runtime.driveDependencies,
            startSession: localStartSession,
          }
        : {
            // Only override startSession while keeping operate-drive's defaults
            // for askJev, act, observe, awaitVerification, and injectCard.
            ...(await defaultDriveDepsWithLocalStart(localStartSession)),
          }
    ) as DriveDependencies;

    let currentFacts: Record<string, string> | undefined =
      options.facts !== undefined ? { ...options.facts } : undefined;
    const driveStartedAt = now();
    let handoffResumes = 0;
    let budgetExceededReason: string | null = null;
    let driveArgs: DriveArgs = {
      url: options.url,
      goal,
      ...(currentFacts !== undefined ? { facts: currentFacts } : {}),
      ...(options.maxSteps !== undefined ? { max_steps: options.maxSteps } : {}),
      ...(maxSeconds !== undefined ? { max_seconds: maxSeconds } : {}),
    };

    let handoff: DriveHandoff;
    while (true) {
      handoff = await runDrive(driveArgs, api, driveContext, driveDeps);

      if (sessionId === undefined && handoff.session_id !== undefined) {
        sessionId = handoff.session_id;
      }

      totalSteps += handoff.steps;
      totalDriveSeconds += handoff.seconds;
      lastJevCalls = Math.max(lastJevCalls, handoff.jev_calls);
      lastTrajectory = handoff.trajectory;
      lastKnownUrl = resolveCurrentUrl(handoff.observation?.url ?? lastKnownUrl);

      const mappedPauseStatus = mapDriveStatus(handoff);
      if (
        options.onHandoff === undefined ||
        callbackFailure !== null ||
        !isResumableHandoffStatus(mappedPauseStatus) ||
        sessionId === undefined
      ) {
        break;
      }

      if (effectiveSignal?.aborted) {
        throw effectiveSignal.reason ?? new Error("signup_cancelled");
      }

      if (handoffResumes >= maxHandoffs) {
        budgetExceededReason = `Exceeded maximum handoff resume limit (${maxHandoffs}) without completing signup.`;
        break;
      }

      const remainingSteps =
        options.maxSteps !== undefined ? options.maxSteps - totalSteps : undefined;
      if (remainingSteps !== undefined && remainingSteps <= 0) {
        budgetExceededReason = `Exceeded maxSteps budget (${options.maxSteps}) across signup handoff resumes.`;
        break;
      }

      const spentSecondsBeforeHandoff = Math.max(
        (now() - driveStartedAt) / 1000,
        totalDriveSeconds,
      );
      if (maxSeconds !== undefined && maxSeconds - spentSecondsBeforeHandoff <= 0) {
        budgetExceededReason = `Exceeded maxSeconds budget (${maxSeconds}s) across signup handoff resumes.`;
        break;
      }

      const handoffEvent: SignupHandoffEvent = redactUnknownSecrets(
        {
          status: mappedPauseStatus,
          driveStatus: handoff.status,
          url: lastKnownUrl,
          attempt: handoffResumes + 1,
          ...(handoff.question !== undefined ? { question: handoff.question } : {}),
          ...(handoff.options !== undefined ? { options: handoff.options } : {}),
          ...(handoff.probabilities !== undefined ? { probabilities: handoff.probabilities } : {}),
          ...(handoff.field !== undefined ? { field: handoff.field } : {}),
          ...(handoff.needs_user !== undefined ? { needsUser: handoff.needs_user } : {}),
          ...(handoff.oauth !== undefined ? { oauth: handoff.oauth } : {}),
          ...(handoff.message !== undefined ? { message: handoff.message } : {}),
          ...(handoff.remaining !== undefined ? { remaining: handoff.remaining } : {}),
          ...(handoff.reason !== undefined ? { reason: handoff.reason } : {}),
        },
        capturedSecrets,
      );

      let continuation: SignupHandoffResponse | null | undefined;
      try {
        continuation = await awaitWithSignal(
          () => options.onHandoff!(handoffEvent),
          effectiveSignal,
        );
      } catch (err) {
        if (effectiveSignal?.aborted) {
          throw err;
        }
        const rawMessage = err instanceof Error ? err.message : String(err);
        throw new Error(`onHandoff callback failed: ${rawMessage}`);
      }

      if (!hasHandoffContinuation(continuation)) {
        break;
      }

      if (effectiveSignal?.aborted) {
        throw effectiveSignal.reason ?? new Error("signup_cancelled");
      }

      const spentSecondsAfterHandoff = Math.max((now() - driveStartedAt) / 1000, totalDriveSeconds);
      const remainingSeconds =
        maxSeconds !== undefined ? maxSeconds - spentSecondsAfterHandoff : undefined;
      if (remainingSeconds !== undefined && remainingSeconds <= 0) {
        budgetExceededReason = `Exceeded maxSeconds budget (${maxSeconds}s) across signup handoff resumes.`;
        break;
      }

      handoffResumes += 1;
      if (continuation.facts !== undefined) {
        currentFacts =
          currentFacts === undefined
            ? { ...continuation.facts }
            : { ...currentFacts, ...continuation.facts };
      }
      const nextAnswer =
        typeof continuation.answer === "string" && continuation.answer.trim().length > 0
          ? continuation.answer
          : undefined;

      driveArgs = {
        session_id: sessionId,
        goal,
        ...(currentFacts !== undefined ? { facts: currentFacts } : {}),
        ...(nextAnswer !== undefined ? { answer: nextAnswer } : {}),
        ...(remainingSteps !== undefined ? { max_steps: remainingSteps } : {}),
        ...(remainingSeconds !== undefined ? { max_seconds: remainingSeconds } : {}),
      };
    }

    const activeSessionId = sessionId;
    const currentUrl = resolveCurrentUrl(handoff.observation?.url ?? options.url);
    lastKnownUrl = currentUrl;

    // Post-drive capture: explicit captureSource(s) or a final extract fallback.
    if (
      handoff.status === "complete" &&
      budgetExceededReason === null &&
      activeSessionId !== undefined
    ) {
      if (captureSources.length > 0) {
        for (const source of captureSources) {
          const captured = await runCaptureSource(
            activeSessionId,
            source,
            "clipboard" in source ? { pre: preClipboardProbe } : undefined,
          ).catch(() => null);
          if (captured !== null && captured.candidate_count === 1 && captured.value !== undefined) {
            const storable = storableCredentials({ api_key: captured.value });
            if (storable !== null) {
              await deliverCredential({
                kind: "api_key",
                url: currentUrl,
                fields: storable,
                source: "capture_source",
                ...(captured.resolved_source !== undefined
                  ? { resolvedSource: captured.resolved_source }
                  : {}),
              });
            }
          }
        }
      } else if (!capturedMetadata.some((item) => item.kind === "api_key")) {
        const extracted = await runExtract(activeSessionId).catch(() => null);
        const storable = extracted !== null ? storableCredentials(extracted.credentials) : null;
        if (extracted !== null && storable !== null) {
          await deliverCredential({
            kind: "api_key",
            url: extracted.url,
            fields: storable,
            source: "extract",
          });
        }
      }
    }

    const mappedStatus: SignupStatus =
      callbackFailure !== null
        ? "failed"
        : budgetExceededReason !== null
          ? "budget_exceeded"
          : mapDriveStatus(handoff);

    const rawResult: SignupResult = {
      status: mappedStatus,
      service,
      url: currentUrl,
      captured: capturedMetadata.length > 0,
      credentials: capturedMetadata,
      steps: totalSteps,
      seconds: totalDriveSeconds,
      jevCalls: lastJevCalls,
      driveStatus: handoff.status,
      ...(handoff.done !== undefined ? { done: handoff.done } : {}),
      ...(handoff.remaining !== undefined ? { remaining: handoff.remaining } : {}),
      ...(callbackFailure !== null
        ? { reason: `onCredentialCaptured callback failed: ${callbackFailure}` }
        : budgetExceededReason !== null
          ? { reason: budgetExceededReason }
          : handoff.reason !== undefined
            ? { reason: handoff.reason }
            : {}),
      ...(handoff.message !== undefined ? { message: handoff.message } : {}),
      ...(handoff.question !== undefined ? { question: handoff.question } : {}),
      ...(handoff.options !== undefined ? { options: handoff.options } : {}),
      ...(handoff.probabilities !== undefined ? { probabilities: handoff.probabilities } : {}),
      ...(handoff.field !== undefined ? { field: handoff.field } : {}),
      ...(handoff.needs_user !== undefined ? { needsUser: handoff.needs_user } : {}),
      ...(handoff.oauth !== undefined ? { oauth: handoff.oauth } : {}),
      trajectory: lastTrajectory,
    };

    return redactUnknownSecrets(rawResult, capturedSecrets);
  } catch (err) {
    const elapsedSeconds = (now() - startedAt) / 1000;
    const rawReason = err instanceof Error ? err.message : String(err);
    const reason = redactSecrets(rawReason, capturedSecrets);
    const aborted = effectiveSignal?.aborted === true;
    return redactUnknownSecrets(
      {
        status: aborted ? "cancelled" : "failed",
        service,
        url: lastKnownUrl,
        captured: capturedMetadata.length > 0,
        credentials: capturedMetadata,
        steps: totalSteps,
        seconds: elapsedSeconds,
        jevCalls: lastJevCalls,
        reason,
        trajectory: lastTrajectory,
      },
      capturedSecrets,
    );
  } finally {
    effectiveSignal?.removeEventListener("abort", onAbort);
    composed.dispose();
    if (sessionId !== undefined) {
      const finished = await finishSession(sessionId).catch(() => null);
      if (finished === null || finished.closed !== true) {
        await forceFinishSession(sessionId).catch(() => undefined);
      }
    }
    await browser.close({ cancelStart: true }).catch(() => undefined);
  }
}

async function defaultDriveDepsWithLocalStart(
  startSession: DriveDependencies["startSession"],
): Promise<DriveDependencies> {
  const [{ askJev }, { act, observe, awaitVerification }, { injectCardOnSession }] =
    await Promise.all([
      import("./bot/jev-client.js"),
      import("./bot/provision-session.js"),
      import("./tools/inject-card.js"),
    ]);
  return {
    askJev,
    act,
    observe,
    startSession,
    awaitVerification,
    injectCard: async (session, args, api, options) =>
      await injectCardOnSession(session, args, api, options),
  };
}
