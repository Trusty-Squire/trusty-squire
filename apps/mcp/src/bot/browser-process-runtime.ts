import { chromium as baseChromium } from "playwright";
import { createRequire } from "node:module";
import { Socket } from "node:net";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import {
  clearStaleSingletonLock,
  currentProfileHolderPid,
  processBirthIdentity,
  processBirthIdentityState,
  PROFILE_BUSY_MESSAGE,
  ProfileBusyError,
  profileProcessIdentity,
  profileProcessMatches,
  reapProfileHolderIfOwned,
  signalProfileProcess,
  type ProcessIdentityState,
  type ProfileCloseState,
  type ProfileProcessIdentity,
} from "./profile.js";
import {
  createOperatorBrowserMarker,
  OPERATOR_BROWSER_MARKER_ENV,
  operatorBrowserProcessMarker,
} from "./operator-browser-watchdog.js";
import {
  bindOwnerBrowserLaunch,
  markOwnerBrowserLaunchTerminal,
  reconcileOwnerBrowserLaunchAfterLeaderExit,
  terminateOwnerBrowserLaunch,
  trackOwnerBrowserLaunch,
  trackOwnerProcess,
  untrackOwnerBrowserLaunch,
  untrackOwnerProcess,
} from "./owner-process-reaper.js";

// Lazy registration: installing the plugin mutates the chromium singleton
// from playwright-extra so we only do it once per process. We require()
// the CJS modules lazily (the stealth toolchain only ships CJS) and treat
// stealth as best-effort — a missing dep should never crash the bot.
const require = createRequire(import.meta.url);

export type StealthProfile = "baseline" | "cdp_hardened";

// Operator signup runs are deliberately headed. Google, Stytch, and Cloudflare
// routinely reject a headless Chrome even when it is otherwise self-launched.
export const OPERATOR_BROWSER_HEADLESS = false;

export function registerLocalBrowserLaunch(
  profileDir: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
  marker = createOperatorBrowserMarker(),
): { marker: string; env: NodeJS.ProcessEnv } {
  trackOwnerBrowserLaunch(marker, profileDir);
  return {
    marker,
    env: { ...baseEnv, [OPERATOR_BROWSER_MARKER_ENV]: marker },
  };
}

// Shared graceful quit for plain login and locally owned operator Chrome.
//
// It MUST NOT be SIGTERM. Chrome routes SIGTERM to its "session ending" path,
// which exits abruptly on the assumption the OS is tearing the machine down —
// it does NOT flush the SQLite cookie store, and the store's own commit timer
// is ~30s away. `connect` kills this browser within a couple of seconds of the
// user finishing the Google OAuth dance, so a SIGTERM teardown discarded the
// very session the ceremony existed to establish: the claim landed, the session
// file was written, and the follow-up provider probe correctly reported "Google
// not connected". SIGINT takes Chrome's graceful shutdown path, which flushes.
// Measured on real Chrome 2026-09-04: cookie set 6s before the signal survives
// SIGINT/SIGHUP and is lost on SIGTERM, deterministically, for both a bare pid
// and a process-group signal.
export const BROWSER_QUIT_SIGNAL: NodeJS.Signals = "SIGINT";

// How long to let Chrome's graceful shutdown run before handing over to the
// owner-launch reaper, whose own escalation starts at SIGTERM and would undo
// the flush we just asked for.
const BROWSER_QUIT_DEADLINE_MS = 10_000;

// Quit the plain login browser and only THEN run the ownership-proving
// teardown. Exported for tests: the ordering here is the fix, not an
// implementation detail — `finalize` (the reaper) escalates SIGTERM →
// SIGKILL, so running it while Chrome is still flushing reintroduces the
// abrupt exit this signal choice exists to avoid.
export async function quitBrowserGracefully(opts: {
  signalQuit: (signal: NodeJS.Signals) => boolean;
  isRunning: () => boolean;
  finalize: () => Promise<void>;
  deadlineMs?: number;
  pollMs?: number;
  wait?: (ms: number) => Promise<void>;
}): Promise<void> {
  const pollMs = opts.pollMs ?? 25;
  const wait =
    opts.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  // An undelivered quit has nothing to wait for — hand straight over to the
  // reaper rather than burning the grace window on a process we cannot signal.
  if (opts.signalQuit(BROWSER_QUIT_SIGNAL)) {
    const deadline = Date.now() + (opts.deadlineMs ?? BROWSER_QUIT_DEADLINE_MS);
    while (opts.isRunning() && Date.now() < deadline) await wait(pollMs);
  }
  await opts.finalize();
}

export async function closeBrowserContextWithin(
  context: { close(): Promise<unknown> },
  timeoutMs = 2_000,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const outcome = await Promise.race([
    Promise.resolve()
      .then(() => context.close())
      .then(
        () => true,
        () => false,
      ),
    new Promise<false>((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout(false), timeoutMs);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  return outcome;
}

export function spawnLocalBrowser(
  binary: string,
  args: readonly string[],
  profileDir: string,
  options: {
    env: NodeJS.ProcessEnv;
    stdio: ["ignore", "ignore", "pipe"];
    detached: boolean;
    marker?: string;
  },
): ChildProcess {
  const ownership = registerLocalBrowserLaunch(profileDir, options.env, options.marker);
  try {
    const child = spawn(binary, [...args], {
      env: ownership.env,
      stdio: options.stdio,
      detached: options.detached,
    });
    localBrowserLaunchMarkers.set(child, ownership.marker);
    child.once("exit", () => {
      setTimeout(() => {
        reconcileOwnerBrowserLaunchAfterLeaderExit(ownership.marker, profileDir);
      }, 0).unref();
    });
    return child;
  } catch (error) {
    untrackOwnerBrowserLaunch(ownership.marker);
    throw error;
  }
}

const localBrowserLaunchMarkers = new WeakMap<ChildProcess, string>();

export function markLocalBrowserLaunchTerminal(child: ChildProcess | null): void {
  if (child === null) return;
  const marker = localBrowserLaunchMarkers.get(child);
  if (marker !== undefined) markOwnerBrowserLaunchTerminal(marker);
}

export async function closeLocalBrowserLaunch(
  marker: string | undefined,
  profileDir: string,
  runtime: {
    markTerminal?: typeof markOwnerBrowserLaunchTerminal;
    terminate?: typeof terminateOwnerBrowserLaunch;
    untrack?: typeof untrackOwnerBrowserLaunch;
  } = {},
): Promise<void> {
  if (marker === undefined) return;
  (runtime.markTerminal ?? markOwnerBrowserLaunchTerminal)(marker);
  if (!(await (runtime.terminate ?? terminateOwnerBrowserLaunch)(marker, profileDir))) {
    throw new Error("local login browser closure unproven");
  }
  (runtime.untrack ?? untrackOwnerBrowserLaunch)(marker);
}

// Whether to use the CDP-hardened launcher (patchright, which runs
// evaluations in an isolated world and removes the automation tells —
// mainWorldExecution, navigator.webdriver, viewport — that Turnstile /
// reCAPTCHA-v3 / Google's consent SPA score on). See
// docs/ARCHITECTURE.md.
//
// 2026-06-08 — DEFAULT FLIPPED ON. The baseline (playwright-extra +
// stealth) self-inflicts a detectable navigator.webdriver via its manual
// defineProperty patch, so it is strictly WORSE on the fingerprint. The
// hardened launcher is all-green on the rebrowser bot-detector and was
// live-A/B'd: meilisearch's Google consent-SPA block became a (handleable)
// FedCM path, and render still signed up + extracted a key cleanly — no
// crash on either (the old crash was the retired rebrowser fork, not
// patchright). Default to hardened; opt out with BOT_CDP_HARDENED=0 for
// the baseline. If patchright isn't installed, getChromium() falls back to
// baseline gracefully.
function cdpHardeningRequested(): boolean {
  const v = process.env.BOT_CDP_HARDENED;
  if (v === "0" || v === "false" || v === "off") return false;
  return true;
}

let cachedChromium: typeof baseChromium | null = null;

// The stealth profile the cached launcher actually represents. Set the
// first time getChromium() resolves a launcher and read back via
// BrowserController.stealthProfile for the CaptchaEvent A/B tag. A
// patchright load failure degrades it to "baseline" truthfully rather
// than over-claiming "cdp_hardened" on a run that never got the patch.
let activeStealthProfile: StealthProfile = "baseline";

export function activeStealthProfileValue(): StealthProfile {
  return activeStealthProfile;
}

export function getChromium(): typeof baseChromium {
  if (cachedChromium !== null) return cachedChromium;
  const hardened = cdpHardeningRequested();
  try {
    if (hardened) {
      // patchright — a maintained Playwright fork that runs every
      // evaluation in an ISOLATED world (so the bot's DOM probing is
      // invisible to a page that traps DOM methods → closes the
      // `mainWorldExecution` tell) and handles `navigator.webdriver`
      // natively + correctly. Verified ALL-GREEN against the maintained
      // rebrowser bot-detector (mainWorldExecution, navigatorWebdriver,
      // viewport, runtimeEnableLeak all clean). It drives real Chrome
      // (channel) directly — the earlier rebrowser fork couldn't, which is
      // why the old hardened arm was forced onto bundled chromium and then
      // crashed the OAuth flow. NO playwright-extra/stealth wrap here: the
      // stealth plugin's manual `navigator.webdriver` defineProperty
      // RE-ADDS a detectable property (proven counterproductive) — patchright
      // does it right. See docs/ARCHITECTURE.md.
      const patchright = require("patchright") as { chromium: typeof baseChromium };
      cachedChromium = patchright.chromium;
      activeStealthProfile = "cdp_hardened";
      return cachedChromium;
    }
    // Baseline: playwright-extra + stealth (unchanged). addExtra(baseChromium)
    // is exactly what playwright-extra's default `chromium` export already is.
    const { addExtra } = require("playwright-extra") as {
      addExtra: (launcher: unknown) => { use: (plugin: unknown) => unknown };
    };
    const stealth = require("puppeteer-extra-plugin-stealth") as () => unknown;
    activeStealthProfile = "baseline";
    const extra = addExtra(baseChromium);
    extra.use(stealth());
    cachedChromium = extra as unknown as typeof baseChromium;
  } catch (err) {
    // Fall back to vanilla playwright if stealth (or the rebrowser fork)
    // isn't installed. The bot still works, it's just easier to
    // fingerprint as a bot — and the A/B tag stays truthfully "baseline".
    console.warn(
      `[operator] hardened launcher unavailable, falling back to vanilla chromium: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    cachedChromium = baseChromium;
    activeStealthProfile = "baseline";
  }
  return cachedChromium;
}

// Real-Chromium-family browser channels we'll prefer over the bundled
// Chromium binary when available. Chromium ships without Widevine,
// without proprietary codecs, with an empty navigator.plugins array,
// and with a chrome.runtime API surface that bot-detection scripts
// know to look for. Using a *real* installation papers over ~6 of
// those fingerprint bits at zero engineering cost.
//
// Order matters: pick the channel most likely to be present *and*
// hardest to fingerprint as automation. Stable Chrome > Edge >
// Beta/Canary > Brave. Brave isn't a Playwright channel but its
// binary path is well-known; we resolve it explicitly below.
const PREFERRED_CHANNELS: readonly string[] = ["chrome", "msedge", "chrome-beta", "chrome-canary"];

// Per-channel binary search paths. Playwright's `executablePath()` is
// argumentless (returns the bundled Chromium path), so we can't ask it
// "is Chrome installed?" — we have to look ourselves. These are the
// canonical install locations on each platform; the first hit wins.
//
// Limitation: this misses sideloaded installs (Chrome installed via
// the user's package manager to a non-default path, dev-builds in
// home directories, etc.). For those, the user can set
// UNIVERSAL_BOT_CHANNEL=chrome to force Playwright to find it
// through its own resolution. We accept the false-negative because
// the alternative (asking Playwright to launch and seeing if it
// succeeds) costs ~1s of process startup per probe.
const CHANNEL_PATHS: Record<string, readonly string[]> = {
  chrome: [
    // macOS
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    // Linux
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/opt/google/chrome/chrome",
    // Windows — Playwright resolves these via channel anyway, but list
    // for completeness on cross-platform Node runs.
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ],
  msedge: [
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/microsoft-edge",
    "/usr/bin/microsoft-edge-stable",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ],
  "chrome-beta": [
    "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
    "/usr/bin/google-chrome-beta",
  ],
  "chrome-canary": [
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/usr/bin/google-chrome-unstable",
  ],
};

// Detect a real-Chromium-family browser channel without launching it.
// Returns the channel name (passable as `channel:` to .launch) or null
// to mean "use bundled Chromium." Logs the selection to stderr so the
// telemetry path can see which browser the run ended up on without
// having to thread it through the agent state machine.
export async function detectChromiumChannel(): Promise<string | null> {
  // Skip detection in tests / when explicitly opting out. The unit tests
  // launch hundreds of browsers and shouldn't probe the filesystem each
  // time; they also can't rely on real Chrome being present.
  if (process.env.UNIVERSAL_BOT_CHANNEL === "bundled") return null;
  if (process.env.UNIVERSAL_BOT_CHANNEL !== undefined) {
    // Explicit override — caller knows what they want.
    return process.env.UNIVERSAL_BOT_CHANNEL;
  }

  const fsMod = await import("node:fs");
  for (const channel of PREFERRED_CHANNELS) {
    const candidatePaths = CHANNEL_PATHS[channel] ?? [];
    for (const candidate of candidatePaths) {
      try {
        if (fsMod.existsSync(candidate)) return channel;
      } catch {
        // permission errors etc. — skip this candidate, try the next
      }
    }
  }
  return null;
}

// Resolve the on-disk Chrome binary for a detected channel, for the
// self-launch path (see launchSelfManagedContext). Playwright launches a
// channel by name; we have to spawn the binary ourselves, so we need the
// path. Returns null when the channel is unknown / not found on disk
// (caller falls back to launchPersistentContext).
export function resolveChannelBinary(channel: string | null): string | null {
  if (channel === null) return null; // bundled Chromium — no self-launch
  const explicit = process.env.UNIVERSAL_BOT_CHROME_BINARY;
  if (explicit !== undefined && explicit.length > 0) {
    return existsSync(explicit) ? explicit : null;
  }
  const candidates = CHANNEL_PATHS[channel] ?? [];
  for (const c of candidates) {
    try {
      if (existsSync(c)) return c;
    } catch {
      // skip unreadable candidate
    }
  }
  return null;
}

// Whether to launch Chrome ourselves and attach over CDP, instead of
// Playwright's launchPersistentContext.
//
// WHY THIS EXISTS — the single decisive finding (2026-06-12, fully
// reproduced + falsifiable; see STATE.md "Cloudflare-Turnstile wall").
// Cloudflare Turnstile's interactive challenge FAILS a Playwright/patchright
// launchPersistentContext-driven Chrome and PASSES a Chrome the operator
// launches itself and then attaches to over CDP — every other variable held
// constant (same box, same datacenter IP, same headed display, same Chrome 148
// binary, same software-WebGL, same humanized click). The discriminator
// matrix:
//   launchPersistentContext + CDP click   → "Verification failed"
//   launchPersistentContext + OS click     → "Verification failed"
//   plain google-chrome      + OS click     → "Success!"
//   plain google-chrome + connectOverCDP + page.mouse → token issued (len816)
// So the tell is NEITHER the live CDP attachment NOR the click mechanism —
// it is specifically the launch flags/instrumentation Playwright injects at
// launchPersistentContext time. Self-launching the binary (no
// --enable-automation et al.) and attaching with connectOverCDP avoids it.
// Default-ON; opt out with BOT_SELF_LAUNCH=0 for the persistent-context path. Exported for tests.
export function selfLaunchEnabled(): boolean {
  const v = process.env.BOT_SELF_LAUNCH;
  return v !== "0" && v !== "false" && v !== "off";
}

const PERSISTENT_CONTEXT_LAUNCH_TIMEOUT_MS = 30_000;

export const PERSISTENT_CONTEXT_CANCELLATION_SETTLE_MS = 2_000;

const PERSISTENT_CONTEXT_CANCELLATION_POLL_MS = 25;

export const PROFILE_IDENTITY_PROOF_TIMEOUT_MS = 2_000;

export const PROFILE_IDENTITY_POLL_MS = 25;

const PROFILE_HOLDER_ABSENCE_GRACE_MS = 100;

export type PersistentFallbackIdentityProof =
  | { state: "owned"; identity: ProfileProcessIdentity }
  | { state: "absent" }
  | { state: "unknown" };

export async function resolvePersistentFallbackIdentity(opts: {
  profileDir: string;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  pollMs?: number;
  absenceGraceMs?: number;
  currentHolderPid?: (profileDir: string) => number | null;
  readIdentity?: (pid: number, profileDir: string) => ProfileProcessIdentity | null;
  clearStaleLock?: (profileDir: string) => boolean;
}): Promise<PersistentFallbackIdentityProof> {
  if ((opts.platform ?? process.platform) !== "linux") return { state: "unknown" };
  const timeoutMs = opts.timeoutMs ?? PROFILE_IDENTITY_PROOF_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? PROFILE_IDENTITY_POLL_MS;
  const absenceGraceMs = opts.absenceGraceMs ?? PROFILE_HOLDER_ABSENCE_GRACE_MS;
  const readHolder = opts.currentHolderPid ?? currentProfileHolderPid;
  const readIdentity = opts.readIdentity ?? profileProcessIdentity;
  const clearStaleLock = opts.clearStaleLock ?? clearStaleSingletonLock;
  const deadline = Date.now() + timeoutMs;
  let absentSince: number | null = null;
  for (;;) {
    const holderPid = readHolder(opts.profileDir);
    if (holderPid === null) {
      absentSince ??= Date.now();
      if (Date.now() - absentSince >= absenceGraceMs) return { state: "absent" };
    } else {
      absentSince = null;
      const identity = readIdentity(holderPid, opts.profileDir);
      if (identity !== null) return { state: "owned", identity };
      if (clearStaleLock(opts.profileDir)) return { state: "absent" };
    }
    if (Date.now() >= deadline) return { state: "unknown" };
    await new Promise<void>((resolveWait) => {
      const timer = setTimeout(resolveWait, Math.min(pollMs, Math.max(1, deadline - Date.now())));
      timer.unref();
    });
  }
}

export async function launchCancellablePersistentContext<T, O extends object>(opts: {
  launch: (options: O & { timeout: number }) => Promise<T>;
  options: O;
  cancellation: Promise<void>;
  cleanupCancelled: (value: T) => Promise<ProfileCloseState>;
  cleanupRejected: () => Promise<ProfileCloseState>;
  launchTimeoutMs?: number;
  cancellationSettleMs?: number;
  cancellationPollMs?: number;
}): Promise<
  { status: "launched"; value: T } | { status: "cancelled"; closeState: ProfileCloseState }
> {
  const launchTimeoutMs = opts.launchTimeoutMs ?? PERSISTENT_CONTEXT_LAUNCH_TIMEOUT_MS;
  const launchDeadline = Date.now() + launchTimeoutMs;
  const launch = Promise.resolve().then(() =>
    opts.launch({ ...opts.options, timeout: launchTimeoutMs }),
  );
  const outcome = await Promise.race([
    launch.then((value) => ({ status: "launched" as const, value })),
    opts.cancellation.then(() => ({ status: "cancelled" as const })),
  ]);
  if (outcome.status === "launched") return outcome;
  let rejectedCleanup: Promise<ProfileCloseState> | null = null;
  const cleanupRejected = (): Promise<ProfileCloseState> => {
    if (rejectedCleanup !== null) return rejectedCleanup;
    const cleanup = Promise.resolve()
      .then(opts.cleanupRejected)
      .catch(() => "unknown" as const)
      .finally(() => {
        if (rejectedCleanup === cleanup) rejectedCleanup = null;
      });
    rejectedCleanup = cleanup;
    return cleanup;
  };
  const lateCleanup = launch
    .then(opts.cleanupCancelled, cleanupRejected)
    .catch(() => "unknown" as const);
  const settleMs = opts.cancellationSettleMs ?? PERSISTENT_CONTEXT_CANCELLATION_SETTLE_MS;
  const pollMs = opts.cancellationPollMs ?? PERSISTENT_CONTEXT_CANCELLATION_POLL_MS;
  const cancellationDeadline = Math.max(Date.now(), launchDeadline) + settleMs;
  let settledCloseState: ProfileCloseState | null = null;
  void lateCleanup.then((closeState) => {
    settledCloseState = closeState;
  });
  while (settledCloseState === null && Date.now() < cancellationDeadline) {
    await cleanupRejected();
    if (settledCloseState !== null) break;
    const remaining = cancellationDeadline - Date.now();
    if (remaining <= 0) break;
    await Promise.race([
      lateCleanup,
      new Promise<void>((resolveWait) => {
        const timer = setTimeout(resolveWait, Math.min(pollMs, remaining));
        timer.unref();
      }),
    ]);
  }
  if (settledCloseState !== null) {
    return { status: "cancelled", closeState: settledCloseState };
  }
  await cleanupRejected();
  void lateCleanup;
  return { status: "cancelled", closeState: "unknown" };
}

export const DEVTOOLS_ACTIVE_PORT_FILE = "DevToolsActivePort";

export async function waitForOwnedDevtoolsEndpoint(
  profileDir: string,
  deadlineMs: number,
  child: ChildProcess,
): Promise<string> {
  const activePortPath = join(profileDir, DEVTOOLS_ACTIVE_PORT_FILE);
  const deadline = Date.now() + deadlineMs;
  let lastErr = "";
  while (Date.now() < deadline) {
    if (!childProcessIsRunning(child)) {
      throw new Error("Chrome exited before its owned DevTools endpoint became available");
    }
    try {
      const [portText, browserPath] = (await readFile(activePortPath, "utf8")).split(/\r?\n/);
      const port = Number(portText);
      if (
        !Number.isInteger(port) ||
        port < 1 ||
        port > 65_535 ||
        browserPath === undefined ||
        !/^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(browserPath)
      ) {
        throw new Error("invalid DevToolsActivePort contents");
      }
      return `ws://127.0.0.1:${port}${browserPath}`;
    } catch (error) {
      lastErr = error instanceof Error ? error.message : String(error);
    }
    await new Promise<void>((resolveWait) => {
      const timer = setTimeout(resolveWait, 200);
      timer.unref();
    });
  }
  throw new Error(`Owned Chrome DevTools endpoint was not published (${lastErr})`);
}

export async function withChromeStartupLock<T>(
  fn: () => Promise<T>,
  opts: { deadlineMs?: number; lockDir?: string } = {},
): Promise<T> {
  const lockDir = opts.lockDir ?? "/tmp/trusty-squire-chrome-start.lock";
  const deadlineMs = opts.deadlineMs ?? 60_000;
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    try {
      mkdirSync(lockDir);
      break;
    } catch (err) {
      try {
        const ageMs = Date.now() - statSync(lockDir).mtimeMs;
        if (ageMs > 120_000) {
          rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        rmSync(lockDir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        if (deadlineMs === 0) throw new ProfileBusyError(PROFILE_BUSY_MESSAGE);
        throw new Error(
          `Timed out waiting for Chrome startup lock at ${lockDir}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

interface SelfManagedChrome {
  identity: ProfileProcessIdentity;
  // A detached POSIX child becomes the leader of a dedicated process group.
  // Chrome's renderer/GPU descendants stay in that group, so a verified group
  // signal tears down the entire browser rather than only its profile root.
  processGroup: boolean;
  proof: OwnedChromeProcessTreeProof;
}

export interface OwnedChromeProcessTreeProof {
  identity: ProfileProcessIdentity;
  processGroup: boolean;
  members: Array<Pick<ProfileProcessIdentity, "pid" | "start_time">>;
}

export const selfManagedChromes = new Map<number, SelfManagedChrome>();

const ownedChromeProcessTrees = new Set<OwnedChromeProcessTreeProof>();

let selfManagedCleanupInstalled = false;

let selfManagedTerminationSignalExitEnabled = true;

function cleanupSelfManagedChromes(): void {
  for (const proof of ownedChromeProcessTrees) {
    signalOwnedChromeProcessTree(proof.identity, proof.processGroup, "SIGKILL", { proof });
    untrackOwnerProcess(proof.identity);
  }
  selfManagedChromes.clear();
}

const exitForSelfManagedSignal = (code: number): void => {
  cleanupSelfManagedChromes();
  process.exit(128 + code);
};

const onSelfManagedSigint = (): void => exitForSelfManagedSignal(2);

const onSelfManagedSigterm = (): void => exitForSelfManagedSignal(15);

const onSelfManagedSighup = (): void => exitForSelfManagedSignal(1);

const selfManagedTerminationSignalHandlers = [
  ["SIGHUP", onSelfManagedSighup],
  ["SIGINT", onSelfManagedSigint],
  ["SIGTERM", onSelfManagedSigterm],
] as const;

type SelfManagedSignalRuntime = Pick<NodeJS.Process, "once" | "removeListener">;

export function synchronizeSelfManagedChromeTerminationSignalHandlers(
  enabled: boolean,
  runtime: SelfManagedSignalRuntime = process,
): void {
  for (const [signal, handler] of selfManagedTerminationSignalHandlers) {
    if (enabled) runtime.once(signal, handler);
    else runtime.removeListener(signal, handler);
  }
}

// Whether the self-managed termination-signal handlers may exit the process.
// False means another shutdown owner (the MCP server's disconnect coordinator,
// or an in-flight interactive login) holds process-exit responsibility.
export function isSelfManagedChromeTerminationSignalExitEnabled(): boolean {
  return selfManagedTerminationSignalExitEnabled;
}

export function setSelfManagedChromeTerminationSignalExitEnabled(enabled: boolean): void {
  if (selfManagedTerminationSignalExitEnabled === enabled) return;
  selfManagedTerminationSignalExitEnabled = enabled;
  if (!selfManagedCleanupInstalled) return;
  synchronizeSelfManagedChromeTerminationSignalHandlers(enabled);
}

function installSelfManagedChromeCleanup(): void {
  if (selfManagedCleanupInstalled) return;
  selfManagedCleanupInstalled = true;
  process.once("exit", cleanupSelfManagedChromes);
  if (selfManagedTerminationSignalExitEnabled) {
    synchronizeSelfManagedChromeTerminationSignalHandlers(true);
  }
}

export function registerSelfManagedChrome(
  child: ChildProcess,
  profileDir: string,
  processGroup = false,
): ProfileProcessIdentity | null {
  installSelfManagedChromeCleanup();
  const identity = child.pid === undefined ? null : profileProcessIdentity(child.pid, profileDir);
  if (identity !== null) {
    const proof = trackOwnedChromeProcessTree(identity, processGroup);
    if (proof !== null) {
      const marker = proof.identity.process_marker;
      if (marker !== undefined && !bindOwnerBrowserLaunch(marker, proof.identity)) {
        releaseOwnedChromeProcessTree(proof);
        throw new Error("local browser launch identity could not be bound to owner custody");
      }
      selfManagedChromes.set(identity.pid, { identity, processGroup, proof });
    }
  }
  child.once("exit", () => {
    if (child.pid === undefined) return;
    const tracked = selfManagedChromes.get(child.pid);
    if (tracked === undefined) return;
    if (ownedChromeProcessTreeState(tracked.proof) === "stale") {
      releaseOwnedChromeProcessTree(tracked.proof);
      selfManagedChromes.delete(child.pid);
    }
  });
  return identity;
}

async function waitForTrackedProfileChildIdentity(
  child: ChildProcess,
  profileDir: string,
  readIdentity: (pid: number, profileDir: string) => ProfileProcessIdentity | null,
  timeoutMs: number,
  pollMs: number,
  processGroup = false,
): Promise<ProfileProcessIdentity | null> {
  const deadline = Date.now() + timeoutMs;
  while (childProcessIsRunning(child)) {
    const identity = child.pid === undefined ? null : readIdentity(child.pid, profileDir);
    if (identity !== null) {
      const existing = selfManagedChromes.get(identity.pid);
      const proof =
        existing?.identity.start_time === identity.start_time
          ? existing.proof
          : trackOwnedChromeProcessTree(identity, processGroup);
      if (proof !== null) selfManagedChromes.set(identity.pid, { identity, processGroup, proof });
      return identity;
    }
    if (Date.now() >= deadline) return null;
    await new Promise<void>((resolveWait) => {
      const timer = setTimeout(resolveWait, Math.min(pollMs, Math.max(1, deadline - Date.now())));
      timer.unref();
    });
  }
  return null;
}

export async function resolveAttachedProfileChildIdentity(
  child: ChildProcess,
  profileDir: string,
  identity: ProfileProcessIdentity | null,
  options: {
    platform?: NodeJS.Platform;
    readIdentity?: (pid: number, profileDir: string) => ProfileProcessIdentity | null;
    identityTimeoutMs?: number;
    identityPollMs?: number;
    processGroup?: boolean;
  } = {},
): Promise<ProfileProcessIdentity | null> {
  if (identity !== null || (options.platform ?? process.platform) !== "linux") return identity;
  return await waitForTrackedProfileChildIdentity(
    child,
    profileDir,
    options.readIdentity ?? profileProcessIdentity,
    options.identityTimeoutMs ?? PROFILE_IDENTITY_PROOF_TIMEOUT_MS,
    options.identityPollMs ?? PROFILE_IDENTITY_POLL_MS,
    options.processGroup ?? false,
  );
}

// Call this ONLY for a Chrome child spawned with detached:true. The identity
// check protects against PID reuse, then POSIX negative-PID signalling reaches
// Chrome's renderer/GPU/helper tree in one operation. A normal profile-root
// signal remains the portable fallback for launchPersistentContext and Windows.
export function signalOwnedChromeProcessTree(
  identity: ProfileProcessIdentity,
  processGroup: boolean,
  signal: NodeJS.Signals,
  options: {
    platform?: NodeJS.Platform;
    profileMatches?: (identity: ProfileProcessIdentity, profileDir: string) => boolean;
    kill?: (pid: number, signal: NodeJS.Signals) => unknown;
    processTreePids?: (rootPid: number) => number[];
    readBirthIdentity?: typeof processBirthIdentity;
    memberState?: typeof processBirthIdentityState;
    processGroupId?: (pid: number) => number | null;
    proof?: OwnedChromeProcessTreeProof;
  } = {},
): boolean {
  const profileMatches = options.profileMatches ?? profileProcessMatches;
  const kill = options.kill ?? process.kill;
  const proof =
    options.proof ??
    captureOwnedChromeProcessTreeProof(identity, processGroup, {
      profileMatches,
      ...(options.platform === undefined ? {} : { platform: options.platform }),
      ...(options.processTreePids === undefined
        ? {}
        : { processTreePids: options.processTreePids }),
      ...(options.readBirthIdentity === undefined
        ? {}
        : { readBirthIdentity: options.readBirthIdentity }),
    });
  if (proof === null) return false;
  const platform = options.platform ?? process.platform;
  const memberState = options.memberState ?? processBirthIdentityState;
  const matchingMembers = proof.members.filter((member) => memberState(member) === "matching");
  const matchingGroupMember =
    proof.processGroup && platform !== "win32"
      ? matchingMembers.some(
          (member) =>
            platform !== "linux" ||
            (options.processGroupId ?? linuxProcessGroupId)(member.pid) === proof.identity.pid,
        )
      : false;
  if (matchingGroupMember) {
    try {
      kill(-proof.identity.pid, signal);
      return true;
    } catch {
      // A process may exit between the proof and the signal. Fall through to
      // the root PID only while it is still identity-proven.
    }
  }
  let signalled = false;
  // Signal leaves first. This covers the Playwright persistent-context fallback
  // (including chrome-headless-shell), whose child is not a detached process
  // group leader but whose renderer tree is still rooted at the identity-proven
  // browser PID.
  for (const member of [...proof.members].reverse()) {
    if (memberState(member) !== "matching") continue;
    try {
      kill(member.pid, signal);
      signalled = true;
    } catch {
      // A child can naturally exit while the tree is being walked.
    }
  }
  return signalled;
}

export function captureOwnedChromeProcessTreeProof(
  identity: ProfileProcessIdentity,
  processGroup: boolean,
  options: {
    platform?: NodeJS.Platform;
    profileMatches?: (identity: ProfileProcessIdentity, profileDir: string) => boolean;
    processTreePids?: (rootPid: number) => number[];
    readBirthIdentity?: typeof processBirthIdentity;
  } = {},
): OwnedChromeProcessTreeProof | null {
  const profileMatches = options.profileMatches ?? profileProcessMatches;
  if (!profileMatches(identity, identity.user_data_dir)) return null;
  const platform = options.platform ?? process.platform;
  const pids =
    platform === "linux"
      ? (options.processTreePids ?? linuxProcessTreePids)(identity.pid)
      : [identity.pid];
  const readBirthIdentity = options.readBirthIdentity ?? processBirthIdentity;
  const members = pids.flatMap((pid) => {
    if (pid === identity.pid) return [{ pid, start_time: identity.start_time }];
    const member = readBirthIdentity(pid);
    return member === null ? [] : [member];
  });
  if (!members.some((member) => member.pid === identity.pid)) {
    members.unshift({ pid: identity.pid, start_time: identity.start_time });
  }
  return { identity, processGroup, members };
}

export function trackOwnedChromeProcessTree(
  identity: ProfileProcessIdentity,
  processGroup: boolean,
): OwnedChromeProcessTreeProof | null {
  installSelfManagedChromeCleanup();
  const marker = operatorBrowserProcessMarker(identity.pid);
  const trackedIdentity = marker === null ? identity : { ...identity, process_marker: marker };
  const proof = captureOwnedChromeProcessTreeProof(trackedIdentity, processGroup);
  if (proof === null) return null;
  ownedChromeProcessTrees.add(proof);
  trackOwnerProcess(proof.identity);
  return proof;
}

export function releaseOwnedChromeProcessTree(proof: OwnedChromeProcessTreeProof | null): void {
  if (proof === null) return;
  ownedChromeProcessTrees.delete(proof);
  untrackOwnerProcess(proof.identity);
}

export function ownedChromeProcessTreeState(
  proof: OwnedChromeProcessTreeProof,
  options: {
    platform?: NodeJS.Platform;
    profileMatches?: (identity: ProfileProcessIdentity, profileDir: string) => boolean;
    memberState?: typeof processBirthIdentityState;
  } = {},
): ProcessIdentityState {
  const memberState = options.memberState ?? processBirthIdentityState;
  let sawUnknown = false;
  for (const member of proof.members) {
    const state = memberState(member);
    if (state === "matching") return "matching";
    if (state === "unknown") sawUnknown = true;
  }
  return sawUnknown ? "unknown" : "stale";
}

function linuxProcessGroupId(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const closeParen = stat.lastIndexOf(")");
    if (closeParen < 0) return null;
    const processGroupId = Number(
      stat
        .slice(closeParen + 2)
        .trim()
        .split(/\s+/)[2],
    );
    return Number.isSafeInteger(processGroupId) ? processGroupId : null;
  } catch {
    return null;
  }
}

function linuxProcessTreePids(rootPid: number): number[] {
  try {
    const childrenByParent = new Map<number, number[]>();
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number(entry);
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        const closeParen = stat.lastIndexOf(")");
        if (closeParen < 0) continue;
        const parentPid = Number(
          stat
            .slice(closeParen + 2)
            .trim()
            .split(/\s+/)[1],
        );
        if (!Number.isSafeInteger(parentPid)) continue;
        const children = childrenByParent.get(parentPid) ?? [];
        children.push(pid);
        childrenByParent.set(parentPid, children);
      } catch {
        // Processes leave /proc constantly; a partial tree is still safer than
        // abandoning the profile-root browser after a failed close.
      }
    }
    const pids: number[] = [];
    const pending = [rootPid];
    const seen = new Set<number>();
    while (pending.length > 0) {
      const pid = pending.pop()!;
      if (seen.has(pid)) continue;
      seen.add(pid);
      pids.push(pid);
      for (const child of childrenByParent.get(pid) ?? []) pending.push(child);
    }
    return pids;
  } catch {
    return [rootPid];
  }
}

export async function terminateTrackedProfileChild(
  child: ChildProcess,
  profileDir: string,
  options: {
    identity?: ProfileProcessIdentity | null;
    platform?: NodeJS.Platform;
    readIdentity?: (pid: number, profileDir: string) => ProfileProcessIdentity | null;
    terminate?: (identity: ProfileProcessIdentity, profileDir: string) => boolean;
    identityTimeoutMs?: number;
    identityPollMs?: number;
    processGroup?: boolean;
  } = {},
): Promise<ProfileProcessIdentity | null> {
  const readIdentity = options.readIdentity ?? profileProcessIdentity;
  const terminate =
    options.terminate ??
    ((ownedIdentity: ProfileProcessIdentity, ownedProfileDir: string): boolean => {
      const signalled = signalProfileProcess(ownedIdentity, ownedProfileDir, "SIGKILL");
      reapProfileHolderIfOwned(ownedProfileDir, ownedIdentity);
      return signalled;
    });
  let identity = options.identity ?? null;
  if (identity === null && (options.platform ?? process.platform) !== "linux") return null;
  while (childProcessIsRunning(child)) {
    identity ??= await waitForTrackedProfileChildIdentity(
      child,
      profileDir,
      readIdentity,
      options.identityTimeoutMs ?? PROFILE_IDENTITY_PROOF_TIMEOUT_MS,
      options.identityPollMs ?? PROFILE_IDENTITY_POLL_MS,
      options.processGroup ?? false,
    );
    if (identity === null) break;
    const existing = selfManagedChromes.get(identity.pid);
    const proof =
      existing?.identity.start_time === identity.start_time
        ? existing.proof
        : trackOwnedChromeProcessTree(identity, options.processGroup ?? false);
    if (proof !== null) {
      selfManagedChromes.set(identity.pid, {
        identity,
        processGroup: options.processGroup ?? false,
        proof,
      });
    }
    const terminated = terminate(identity, profileDir);
    if (!terminated) {
      identity = null;
      continue;
    }
    while (childProcessIsRunning(child)) {
      await new Promise<void>((resolveWait) => {
        const timer = setTimeout(resolveWait, 25);
        timer.unref();
      });
    }
  }
  return identity;
}

export function childProcessIsRunning(child: ChildProcess | null): boolean {
  return child !== null && child.exitCode === null && child.signalCode === null;
}

export function profileCollisionFromStderr(stderr: string): ProfileBusyError | null {
  return /ProcessSingleton|SingletonLock|profile.*in use/i.test(stderr)
    ? new ProfileBusyError(PROFILE_BUSY_MESSAGE)
    : null;
}

// ───────────── residential proxy (S1) ─────────────

// Playwright proxy settings, narrowed to the fields we set. Structurally
// assignable to Playwright's launch `proxy` option (which also has an
// optional `bypass`).
export interface ProxySettings {
  server: string;
  username?: string;
  password?: string;
}

export function proxyHasCredentials(proxy: ProxySettings | null): boolean {
  return (
    proxy !== null &&
    ((typeof proxy.username === "string" && proxy.username.length > 0) ||
      (typeof proxy.password === "string" && proxy.password.length > 0))
  );
}

// Parse a per-session proxy URL — e.g. "http://user:pass@host:8080" or
// "socks5://host:1080" — into Playwright's proxy option shape. Playwright
// wants credentials separate from `server`, so we split them out and
// percent-decode them (residential providers embed session IDs with
// reserved characters in the username, which arrive %-encoded).
//
// Throws on a URL the WHATWG parser rejects, or one with no host (a bare
// "host:port" parses as a scheme with an empty host).
//
// Exported for unit testing — URL parsing is the error-prone bit.
// Cheap TCP liveness probe for a proxy `server` string ("socks5://host:port").
// A SOCKS5 proxy listens on TCP; if a connect succeeds within the timeout the
// proxy is up. Resolves false on connect error / timeout / a malformed server.
// Pure (no class state) so resolveProxy can call it before launching Chrome.
export async function isProxyReachable(server: string, timeoutMs = 4000): Promise<boolean> {
  let host: string;
  let port: number;
  try {
    const u = new URL(server);
    host = u.hostname;
    port = Number(u.port) || proxyDefaultPort(u.protocol);
  } catch {
    return false;
  }
  if (host.length === 0 || !Number.isFinite(port)) return false;
  return await new Promise<boolean>((resolve) => {
    const sock = new Socket();
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      try {
        sock.destroy();
      } catch {
        // already closed
      }
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => finish(true));
    sock.once("timeout", () => finish(false));
    sock.once("error", () => finish(false));
    sock.connect(port, host);
  });
}

export function proxyDefaultPort(protocol: string): number {
  if (protocol === "http:") return 80;
  if (protocol === "https:") return 443;
  if (protocol.startsWith("socks")) return 1080;
  return 8080;
}

export function parseProxyUrl(raw: string): ProxySettings {
  const u = new URL(raw.trim());
  if (u.hostname.length === 0) {
    throw new Error("proxy URL has no host");
  }
  // `host` includes the port; `protocol` keeps its trailing ":".
  const settings: ProxySettings = { server: `${u.protocol}//${u.host}` };
  if (u.username.length > 0) settings.username = decodeURIComponent(u.username);
  if (u.password.length > 0) settings.password = decodeURIComponent(u.password);
  return settings;
}

/** Resolve an explicit session proxy, refusing an unsafe direct fallback. */
export async function resolveExplicitProxy(
  raw: string,
  probe: (server: string) => Promise<boolean> = isProxyReachable,
): Promise<ProxySettings> {
  let proxy: ProxySettings;
  try {
    proxy = parseProxyUrl(raw);
  } catch (err) {
    throw new Error(
      `explicit session proxy is malformed; refusing direct egress: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (!(await probe(proxy.server))) {
    throw new Error(
      `explicit session proxy ${proxy.server} is unreachable; refusing direct egress`,
    );
  }
  return proxy;
}

/** Self-launched Chrome cannot authenticate an HTTP/SOCKS proxy. */
export function canSelfLaunchWithProxy(proxy: ProxySettings | null): boolean {
  return !proxyHasCredentials(proxy);
}

/** Options passed to launchPersistentContext, including proxy credentials. */
export function persistentProxyOptions(proxy: ProxySettings | null): { proxy?: ProxySettings } {
  return proxy === null ? {} : { proxy };
}

// ───────────── egress geo match (T3.1) ─────────────

// Browser-context geo derived from the run's actual egress IP. Set on
// newContext() so the browser's declared timezone matches where its
// traffic exits — a US-timezone browser on a foreign proxy IP is
// itself a signal anti-bot scorers check for.
export interface EgressGeo {
  timezoneId: string;
  geolocation?: { latitude: number; longitude: number };
}

// Parse an ipinfo.io/json response body into EgressGeo. Returns null
// when the timezone is absent or not a plausible IANA zone — the
// caller then keeps a default rather than handing Playwright a bad
// timezoneId (which would throw inside newContext()).
//
// geolocation is optional: a valid `loc` ("lat,long") sets it; a
// missing or malformed one leaves a timezone-only result. Exported
// for unit testing — JSON-shape handling is the error-prone bit.
export function parseEgressGeo(text: string): EgressGeo | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (data === null || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;

  const tz = typeof d.timezone === "string" ? d.timezone : null;
  // IANA zones look like "Asia/Seoul" or "America/Argentina/Buenos_Aires".
  // Reject anything else so a garbage value never reaches newContext().
  if (tz === null || !/^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+$/.test(tz)) return null;

  const geo: EgressGeo = { timezoneId: tz };
  if (typeof d.loc === "string") {
    const parts = d.loc.split(",");
    if (parts.length === 2) {
      const latitude = Number(parts[0]);
      const longitude = Number(parts[1]);
      if (
        Number.isFinite(latitude) &&
        Number.isFinite(longitude) &&
        Math.abs(latitude) <= 90 &&
        Math.abs(longitude) <= 180
      ) {
        geo.geolocation = { latitude, longitude };
      }
    }
  }
  return geo;
}
