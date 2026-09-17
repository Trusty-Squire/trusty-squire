import type { CheckoutCard } from "./checkout.js";
import { isCaptchaFrameUrl } from "./captcha.js";
import { captureBoundScreenshot, type ScreenshotBinding } from "./screenshot-click.js";
import {
  captureBrowserUseDOM,
  frameOriginOf,
  type BrowserUseCapture,
} from "./browser-use-capture.js";
import type { BrowserDriver, ClickMethod, DriverTarget, FrameTarget } from "./driver/types.js";
import {
  CardValueOutputMask,
  compositePngCardMasks,
  type CardMaskKind,
  type CardMaskRegistration,
  type PixelMaskRect,
} from "./card-value-output-mask.js";
import { OperatorEvidenceCollector } from "./operator-evidence.js";
// Browser automation wrapper for universal signup bot
// Provides simple interface for AI agent to control browser.
//
// Two layers of bot-resistance:
//
// 1. Stealth fingerprinting (playwright-extra + puppeteer-extra-plugin-
//    stealth). Patches ~17 client-side tells: navigator.webdriver,
//    navigator.plugins, missing chrome runtime, WebGL vendor/renderer,
//    permissions.query for notifications, etc. This handles the
//    *fingerprint* side of bot detection.
//
// 2. Human-like behavior (this file, when humanize=true). Adds bezier
//    mouse paths to clicks, variable typing delays with thinking pauses,
//    dwell time after page loads, hover-then-click hesitations. This
//    handles the *behavior* side — the bit that fingerprint spoofing
//    alone won't get past, because modern Cloudflare/reCAPTCHA scoring
//    correlates mouse-path entropy and inter-keystroke timing.
//
// Together with the user's residential IP (the bot runs on user
// machines, not on Fly), these are sufficient for invisible-mode
// Turnstile/reCAPTCHA-v3 scoring on most SaaS signups. Visible-mode
// captchas still need the click-and-wait pattern (the Tier 2 captcha
// gate).

import {
  childProcessIsRunning,
  closeLocalBrowserLaunch,
  markLocalBrowserLaunchTerminal,
  profileCollisionFromStderr,
  quitBrowserGracefully as quitPlainLoginBrowser,
  registerLocalBrowserLaunch,
  registerSelfManagedChrome,
  resolveAttachedProfileChildIdentity,
  selfManagedChromes,
  signalOwnedChromeProcessTree,
  spawnLocalBrowser,
  trackOwnedChromeProcessTree,
  withChromeStartupLock,
  type StealthProfile,
} from "./browser-process-runtime.js";

import { type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import type {
  BrowserContext,
  CDPSession,
  ElementHandle,
  FileChooser,
  Frame,
  Locator,
  Page,
  Request,
} from "playwright";
import {
  currentOperatorRequestSignal,
  markOperatorMutationDispatchAttempted,
  throwIfOperatorRequestCancelled,
} from "./request-cancellation.js";
import { BrowserProcessOwner } from "./browser-process-owner.js";
import {
  classifyGoogleAuthState,
  extractGoogleHumanChallenge,
  extractGoogleNumberMatch,
  type GoogleHumanChallenge,
} from "./google-auth-state.js";
import type { HeightenedAuthNotificationResult } from "../api-client.js";
import { bindOwnerBrowserLaunch, untrackOwnerBrowserLaunch } from "./owner-process-reaper.js";
import { PageDriver } from "./page-driver.js";
import type { ActiveOAuthAttempt, OAuthChallengeReporter } from "./oauth-login.js";
import {
  clearStaleSingletonLock,
  profileProcessIdentity,
  reapProfileHolderIfOwned,
  signalProfileProcess,
  type ProfileCloseState,
  type ProfileProcessIdentity,
} from "./profile.js";

export type ContextInitScriptId = "evaluate-name-shim" | "navigator-webdriver" | "webgl-spoof";

export function contextInitScriptsFor(options: {
  hardened: boolean;
  remoteMode: boolean;
}): ContextInitScriptId[] {
  if (options.hardened) return [];
  return [
    "evaluate-name-shim",
    "navigator-webdriver",
    ...(options.remoteMode ? [] : (["webgl-spoof"] as const)),
  ];
}

export type { FrameTarget };

export type InjectCardField = "pan" | "cvv";
export type InjectCardFieldResult =
  | { status: "filled" }
  | { status: "not_found" | "detached" }
  // Written, then cleared again by the page before the call ended — the pass
  // verified inside the live frame and could not keep the value present.
  | { status: "cleared"; error: string }
  | { status: "native_error"; error: string };

export interface InjectCardResolvedTarget {
  element?: InteractiveElement;
  missing?: "not_found" | "detached";
  format?: string | undefined;
}

// inject_card resolves each hosted card field at its OWN write step, never once
// up front from one shared snapshot. A hosted-field provider (Braintree) serves
// each box from its own cross-origin iframe and remounts those frames on its
// own schedule, so a snapshot walk is not atomic across the siblings — a frame
// mid-remount contributes nothing and its field silently drops out, which
// fields make it in is a race. A field that does not resolve is re-resolved on
// this bounded window (a remount settles in well under a second) before it is
// reported; `not_found` means "still absent after we waited", not "absent on
// first glance". Internal constant — never a tool parameter or config knob.
const CARD_FIELD_RESOLVE_WINDOW_MS = 1_500;
const CARD_FIELD_RESOLVE_RETRY_MS = 100;
// Bounded actionability wait for the hosted-field card WRITE itself. The
// write's failure falls through to the bounded refill (which re-resolves the
// live frame at its own write step), so per AGENTS.md rule 9 it must never
// rely on Playwright's 30s default: a frame remounted mid-write leaves the
// old frame's locator permanently unactionable and the default would burn
// 30s per attempt — starving the refill budget — instead of failing in 3s
// into the retry. Internal constant — never a tool parameter or config knob.
const CARD_FIELD_WRITE_TIMEOUT_MS = 3_000;

export type ResolvedPageTarget =
  | {
      ok: true;
      handle: ElementHandle<Element>;
      text: string;
      labels: string[];
      frameTarget: FrameTarget | null;
    }
  | { ok: false; reason: "none" | "ambiguous"; candidates: string[] };

export interface BrowserAction {
  type: "goto" | "click" | "type" | "screenshot" | "extract" | "wait";
  selector?: string;
  text?: string;
  url?: string;
}

export interface BrowserState {
  url: string;
  title: string;
  html: string;
  screenshot: string; // base64
}

// Checkout data types moved to checkout.ts (design PR 5, where the caller-less
// checkout parsing/reads were deleted); re-exported so the existing
// browser-side CheckoutCard importers are unchanged in this PR.
export type { CheckoutCard, CheckoutSummary } from "./checkout.js";

import {
  BrowserClickDispatchError,
  clickDispatchStatusForError,
  type ClickDispatchStatus,
} from "./click-dispatch.js";

export { BrowserClickDispatchError, clickDispatchStatusForError } from "./click-dispatch.js";
export type { ClickDispatchStatus } from "./click-dispatch.js";

export type TrackedClickTarget =
  | { kind: "selector"; selector: string; method: "click" | "js_click" }
  | { kind: "handle"; handle: ElementHandle<Element>; method: "click" | "js_click" }
  | {
      kind: "frame";
      frame: FrameTarget;
      selector: string;
      method: "click" | "js_click";
    };

function extractObservationVisibleText(): string {
  const body = document.body;
  if (!body) return "";
  const hidden: Array<{ el: HTMLElement | SVGElement; style: string | null }> = [];
  let text = "";
  try {
    for (const el of Array.from(body.querySelectorAll("*"))) {
      if (!(el instanceof HTMLElement || el instanceof SVGElement)) continue;
      if (window.getComputedStyle(el).opacity === "0") {
        hidden.push({ el, style: el.getAttribute("style") });
        el.style.setProperty("display", "none", "important");
      }
    }
    text = body.innerText ?? "";
  } finally {
    for (const { el, style } of hidden) {
      if (style === null) {
        el.style.removeProperty("display");
        if (el.getAttribute("style") === "") el.removeAttribute("style");
      } else {
        el.setAttribute("style", style);
      }
    }
  }
  return text;
}

export interface BrowserControllerOptions {
  // Adds human-like timing to clicks, typing, and page loads. Defaults
  // to true in production (we want to pass Cloudflare/reCAPTCHA scoring)
  // and should be disabled in unit tests so they run fast and
  // deterministically.
  humanize?: boolean;
  // Per-session persistent Chrome profile directory. Required by start().
  profileDir?: string;
  // Per-launch egress override. A session may supply its own proxy without
  // affecting any other browser session. It is honored regardless of the host
  // ASN; malformed or unreachable values fail startup rather than using direct
  // egress. Unset means direct egress.
  proxyUrl?: string;
}

// Classify an anti-bot interstitial page from its (title + body) text.
// `onInterstitial` matches the static Cloudflare/Turnstile challenge copy.
// `verificationPassed` is the signal the challenge SUCCEEDED — but
// Cloudflare leaves the static "Just a moment / Performing security
// verification" copy ON THE PAGE even after it appends "Verification
// successful. Waiting for…", so `onInterstitial` alone wrongly reads as
// "still blocked" and the bot bails as anti_bot_blocked — exactly what
// stranded codesandbox/lambda-labs once patchright started PASSING the
// challenge. When the challenge passed, the redirect is just racing/
// stuck; the caller should be patient + reload, not give up. Exported
// for unit tests.
export function classifyInterstitialText(text: string): {
  onInterstitial: boolean;
  verificationPassed: boolean;
} {
  const onInterstitial =
    /just a moment|performing security verification|verifying you are human|checking your browser|attention required/i.test(
      text,
    );
  const verificationPassed =
    /verification successful|you are (now )?verified|success!|challenge[- ]?(passed|complete)/i.test(
      text,
    );
  return { onInterstitial, verificationPassed };
}

// URL/ACS markers for a rendered 3-D Secure challenge, across processors.
// Module-level so unit tests can pin the paths it has to keep matching — both
// the legacy CardinalCommerce `cruise/stepup` path and the modern
// `.../ThreeDSecure/V2_x/CReq` one (the latter through the `threeDSecure` word
// alternative, not a Cardinal-specific branch). Exported.
export const threeDsChallengeUrlPattern =
  /(?:https?:\/\/(?:[^/]+\.)*cardinalcommerce\.com\/(?:v\d+\/)?cruise\/stepup(?:[/?#]|$)|https?:\/\/hooks\.stripe\.com\/3d_secure|https?:\/\/(?:[^/]+\.)*emvtds(?:[-.][^/]*)?(?:\/|$)|3d[-_ ]?secure|three[-_ ]?d[-_ ]?secure|\/(?:emvtds|emv-?3ds)(?:[-_/]|$)|\/3ds(?:2)?\/|\/acs\/|\/credit3d2\/Fep(?:ChargePaymentInfo|BridgeAuthority)[^/?#]*\.do(?:[?#]|$))/i;

// How long a captured 3-D Secure SDK-error marker stays reportable. The state
// tells the agent a resubmit is expected to launch the challenge, so it has to
// stop long before a later order confirmation could be read as "resubmit" —
// that would be a double-purchase hazard. The report only has to survive from
// the error to the agent's next observe, which is seconds.
export const THREE_DS_SDK_ERROR_EVIDENCE_WINDOW_MS = 90_000;

// Pure freshness predicate over the evidence collector's capture-time latch.
// Exported for unit tests.
export function threeDsSdkErrorEvidenceIsFresh(seenAt: number | null, now: number): boolean {
  return seenAt !== null && now - seenAt <= THREE_DS_SDK_ERROR_EVIDENCE_WINDOW_MS;
}

// After a Cloudflare managed challenge PASSES, the cf_clearance cookie is
// set but the URL still carries Cloudflare's single-use challenge token
// (`__cf_chl_rt_tk`, `__cf_chl_tk`, `__cf_chl_f_tk`, …). Cloudflare's own
// client-side redirect to the cleared page can stall — especially over a
// high-latency residential tunnel, where the meta-refresh/JS hop never
// fires inside our wait budget. Re-navigating to the SAME url with those
// one-shot tokens stripped serves the real page directly (the clearance
// cookie now satisfies the edge), instead of waiting on the stuck redirect.
// Returns the cleaned URL, or null when there's no challenge token to strip
// (nothing this can do better than a plain reload). Exported for unit tests.
export function stripCloudflareChallengeParams(rawUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  let changed = false;
  for (const key of [...u.searchParams.keys()]) {
    if (key.toLowerCase().startsWith("__cf_chl")) {
      u.searchParams.delete(key);
      changed = true;
    }
  }
  return changed ? u.toString() : null;
}

export interface PlainLoginBrowser {
  // Idempotent: kills the spawned Chrome child and reaps the profile lock.
  teardown: () => Promise<void>;
  forceTeardown: () => void;
  // Plain login intentionally has no CDP attachment, so expose child liveness
  // for the polling loop to fail loudly if the visible browser disappears.
  isRunning: () => boolean;
  identity: ProfileProcessIdentity | null;
  marker: string;
}

// Preserve the plain-login API; both owners use the same bounded graceful quit.
export {
  BROWSER_QUIT_SIGNAL as PLAIN_LOGIN_BROWSER_QUIT_SIGNAL,
  quitBrowserGracefully as quitPlainLoginBrowser,
} from "./browser-process-runtime.js";

// Launch a TRULY PLAIN Chrome for the interactive connect claim — NO
// `--remote-debugging-port`, NO `connectOverCDP`, NO Playwright attach at all.
//
// WHY (2026-07-20, fully bisected on chad; see STATE.md "connect Google-login").
// Google's OAUTH authorization flow (Trusty Squire's "Sign in with Google",
// Gmail restricted scope) runs a "secure browser" integrity check that a plain
// `google-chrome` PASSES but a CDP-attached Chrome FAILS with
// `/v3/signin/rejected` — even a self-launched one, even with patchright, even
// though the same CDP browser passes a DIRECT accounts.google.com sign-in. The
// tell is the CDP attachment itself (NOT the launcher, NOT the flags, NOT
// `navigator.webdriver` — all separately ruled out). The connect claim doesn't
// need to drive the browser: the USER signs in interactively, completion comes
// from the API (`installPoll`) plus its explicit Finish callback. So we spawn
// Chrome and only ever kill it — never attach.
//
// Persistent profile is preserved (--user-data-dir=profileDir) so the Google/
// GitHub session still lands in the bot's profile for later signups.
export async function launchPlainLoginBrowser(params: {
  binary: string;
  profileDir: string;
  // App mode (--app=URL) opens a chromeless window so the install page fills the
  // interactive browser window.
  url: string;
  window: { width: number; height: number };
  env: NodeJS.ProcessEnv;
  proxyServer: string | null;
  extraArgs?: readonly string[];
}): Promise<PlainLoginBrowser> {
  let child: ChildProcess | null = null;
  let childIdentity: ProfileProcessIdentity | null = null;
  // Login's plain browser is the no-CDP path used for Google sign-in. Reserve
  // its marker before launch so the rc.15 fail-closed reaper bind is legitimate.
  const ownership = registerLocalBrowserLaunch(params.profileDir, params.env);
  const launchMarker = ownership.marker;
  let spawned = false;
  try {
    await withChromeStartupLock(
      async () => {
        clearStaleSingletonLock(params.profileDir);
        const argv = [
          `--user-data-dir=${params.profileDir}`,
          "--no-first-run",
          "--no-default-browser-check",
          "--password-store=basic",
          "--window-position=0,0",
          `--window-size=${params.window.width},${params.window.height}`,
          "--lang=en-US",
          ...(params.extraArgs ?? []),
          ...(params.proxyServer !== null ? [`--proxy-server=${params.proxyServer}`] : []),
          `--app=${params.url}`,
        ];
        const launched = spawnLocalBrowser(params.binary, argv, params.profileDir, {
          detached: process.platform !== "win32",
          env: ownership.env,
          stdio: ["ignore", "ignore", "pipe"],
          marker: launchMarker,
        });
        child = launched;
        spawned = true;
        let chromeStderr = "";
        launched.stderr?.on("data", (chunk: Buffer) => {
          chromeStderr = (chromeStderr + chunk.toString("utf8")).slice(-4_000);
        });
        // Give Chrome a moment to actually come up (or die). Unlike the CDP path
        // there is no devtools endpoint to poll — but a crash-on-launch (bad
        // profile, missing lib) should surface here, not 15min later as a blank
        // browser. If the process is already dead, throw with its stderr.
        await new Promise((r) => setTimeout(r, 1_200));
        childIdentity ??=
          launched.pid === undefined
            ? null
            : profileProcessIdentity(launched.pid, params.profileDir);
        childIdentity = await resolveAttachedProfileChildIdentity(
          launched,
          params.profileDir,
          childIdentity,
        );
        childIdentity = registerSelfManagedChrome(launched, params.profileDir) ?? childIdentity;
        if (childIdentity !== null) {
          const existing = selfManagedChromes.get(childIdentity.pid);
          const proof =
            existing?.identity.start_time === childIdentity.start_time
              ? existing.proof
              : trackOwnedChromeProcessTree(childIdentity, false);
          if (proof !== null) {
            selfManagedChromes.set(childIdentity.pid, {
              identity: childIdentity,
              processGroup: false,
              proof,
            });
          }
          // Bind the owner-launch anchor to the profile-proven child identity.
          // registerSelfManagedChrome only binds when it can read the marker back
          // from the process, but Chrome erases the marker from its own environ
          // when it rewrites process titles, so that bind is skipped here. Use
          // the marker we generated for THIS launch, keyed to the tracked launch
          // record, so teardown can trust this anchor and reap the marker-only
          // wrapper processes (the google-chrome launcher's stdout/stderr `cat`
          // relays and crashpad) instead of reporting closure unproven.
          bindOwnerBrowserLaunch(launchMarker, childIdentity);
        }
        if (!childProcessIsRunning(launched)) {
          reapProfileHolderIfOwned(params.profileDir, childIdentity);
          const detail = chromeStderr.trim();
          const collision = profileCollisionFromStderr(detail);
          if (collision !== null) throw collision;
          const termination =
            launched.exitCode !== null
              ? `code ${launched.exitCode}`
              : `signal ${launched.signalCode ?? "unknown"}`;
          throw new Error(
            `plain login Chrome exited immediately (${termination})` +
              `${detail.length > 0 ? `; Chrome stderr: ${detail}` : ""}`,
          );
        }
        if (process.platform === "linux" && childIdentity === null) {
          throw new Error("plain login Chrome identity could not be proven");
        }
      },
      { deadlineMs: 0 },
    );
  } catch (error) {
    if (!spawned) untrackOwnerBrowserLaunch(launchMarker);
    throw error;
  }

  let teardownPromise: Promise<void> | undefined;
  const forceTeardown = (): void => {
    markLocalBrowserLaunchTerminal(child);
    if (childIdentity !== null) {
      const tracked = selfManagedChromes.get(childIdentity.pid);
      signalOwnedChromeProcessTree(childIdentity, false, "SIGKILL", {
        ...(tracked === undefined ? {} : { proof: tracked.proof }),
      });
    } else if (childProcessIsRunning(child)) {
      child?.kill("SIGKILL");
    }
    reapProfileHolderIfOwned(params.profileDir, childIdentity);
  };
  const teardown = (): Promise<void> => {
    teardownPromise ??= (async () => {
      markLocalBrowserLaunchTerminal(child);
      await quitPlainLoginBrowser({
        signalQuit: (signal) => {
          if (child !== null && childIdentity !== null) {
            return signalProfileProcess(childIdentity, params.profileDir, signal);
          }
          if (childProcessIsRunning(child)) {
            child?.kill(signal);
            return true;
          }
          return false;
        },
        isRunning: () => childProcessIsRunning(child),
        finalize: async () => await closeLocalBrowserLaunch(launchMarker, params.profileDir),
      });
    })();
    return teardownPromise;
  };
  return {
    teardown,
    forceTeardown,
    isRunning: () => childProcessIsRunning(child),
    identity: childIdentity,
    marker: launchMarker,
  };
}

// Dev-runtime guard: when the bot is run through `tsx`, esbuild may inject
// calls to its `__name(fn, "name")` helper into functions passed to
// page.evaluate/addInitScript. Those functions execute in the browser page,
// where Node's helper does not exist, causing an immediate
// `ReferenceError: __name is not defined` before the real signup even
// starts. Define the same no-op helper in every document. Built `dist`
// should not emit these calls, but the helper is harmless there too.
const EVALUATE_NAME_SHIM_SCRIPT =
  'Object.defineProperty(globalThis, "__name", { value: (fn) => fn, configurable: true });';

// rc.33 / 2026-06-04 — spoof the WebGL UNMASKED vendor+renderer toward a
// stock Intel GPU, so the software Mesa/llvmpipe string (--enable-unsafe-
// swiftshader gives us a context, but llvmpipe is itself a VM/headless
// tell) doesn't read through. Applied TWO ways because patchright
// (hardened) isolates document-start scripts from the page's main world:
//   • addInitScript — document-start; the effective path in the stealth
//     BASELINE (non-patchright).
//   • re-applied via page.evaluate on every navigation — the ONLY path that
//     reaches the MAIN world under patchright. MEASURED 2026-06-04:
//     addInitScript AND raw CDP Page.addScriptToEvaluateOnNewDocument both
//     land in patchright's isolated world (renderer stayed llvmpipe);
//     page.evaluate does not (renderer became Intel), and the v3 score held
//     at 1.0. Idempotent via a marker so the per-nav re-apply is cheap, and
//     getParameter.toString() is masked to the original native source so
//     the patch itself isn't a tell. Only strings change, not rendering.
const INSTALL_WEBGL_SPOOF_SCRIPT = String.raw`(() => {
      const VENDOR_WEBGL = 0x9245; // UNMASKED_VENDOR_WEBGL
      const RENDERER_WEBGL = 0x9246; // UNMASKED_RENDERER_WEBGL
      const spoof = (proto) => {
        // The marker lives on the prototype so re-application is a no-op; the
        // cast is the one typed-alternative-exhausted spot (adding an ad-hoc
        // brand to a DOM prototype).
        if (proto.__tsWebglPatched === true) return;
        const orig = proto.getParameter;
        const native = orig.toString();
        proto.getParameter = function (p) {
          if (p === VENDOR_WEBGL) return "Google Inc. (Intel)";
          if (p === RENDERER_WEBGL) {
            return "ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL 4.6)";
          }
          return orig.call(this, p);
        };
        Object.defineProperty(proto.getParameter, "toString", {
          value: () => native,
          configurable: true,
          writable: true,
        });
        proto.__tsWebglPatched = true;
      };
      if (typeof WebGLRenderingContext !== "undefined") {
        spoof(WebGLRenderingContext.prototype);
      }
      if (typeof WebGL2RenderingContext !== "undefined") {
        spoof(WebGL2RenderingContext.prototype);
      }
      // Device-tell normalization. The headless harvester box reports 20
      // logical cores (navigator.hardwareConcurrency) — a consumer residential
      // device is 4-16. A 20-core Linux machine behind a "residential" IP is
      // an internal inconsistency Cloudflare Turnstile scores against
      // (MEASURED 2026-06-11: exa/cartesia Turnstile won't issue a token on a
      // clean-fingerprint click; hwConcurrency=20 + Linux is the standout
      // anomaly). Normalize to a common consumer profile. Same per-nav main-
      // world application as the WebGL spoof — patchright denies init-world
      // reach, and Turnstile reads these after the challenge script loads
      // (seconds in), so the framenavigated re-apply wins the race. Defined on
      // Navigator.prototype (where the native getters live) so there's no own-
      // property tell on the instance.
      const navProto = Navigator.prototype;
      if (navProto.__tsDevicePatched !== true) {
        try {
          Object.defineProperty(Navigator.prototype, "hardwareConcurrency", {
            get: () => 8,
            configurable: true,
          });
          Object.defineProperty(Navigator.prototype, "deviceMemory", {
            get: () => 8,
            configurable: true,
          });
          // Screen availHeight tell: a virtual screen reports
          // availHeight == height (no OS taskbar), whereas a real Windows
          // desktop reserves ~40px for the taskbar (availHeight = height-40,
          // availWidth = width). Reinstate that gap so the screen reads like
          // an ordinary desktop, not a bare framebuffer. Guarded so it only
          // applies when the two are currently equal (i.e. headless).
          try {
            if (screen.availHeight === screen.height) {
              Object.defineProperty(Screen.prototype, "availHeight", {
                get: () => screen.height - 40,
                configurable: true,
              });
            }
          } catch {
            // leave it
          }
          navProto.__tsDevicePatched = true;
        } catch {
          // descriptor already locked by something else — leave it.
        }
      }
    })();`;

export class BrowserController implements BrowserDriver {
  get context(): BrowserContext | null {
    return this.processOwner.context;
  }
  private set context(value: BrowserContext | null) {
    this.processOwner.context = value;
  }

  get page(): Page | null {
    return this.pageDriver.page;
  }
  set page(value: Page | null) {
    this.pageDriver.page = value;
  }

  get primaryPage(): Page | null {
    return this.pageDriver.primaryPage;
  }
  set primaryPage(value: Page | null) {
    this.pageDriver.primaryPage = value;
  }

  get oauthProductPage(): Page | null {
    return this.pageDriver.oauthProductPage;
  }
  set oauthProductPage(value: Page | null) {
    this.pageDriver.oauthProductPage = value;
  }

  get oauthProviderPage(): Page | null {
    return this.pageDriver.oauthProviderPage;
  }
  set oauthProviderPage(value: Page | null) {
    this.pageDriver.oauthProviderPage = value;
  }

  get oauthProviderPageClosed(): boolean {
    return this.pageDriver.oauthProviderPageClosed;
  }
  set oauthProviderPageClosed(value: boolean) {
    this.pageDriver.oauthProviderPageClosed = value;
  }

  get oauthCompletionPage(): Page | null {
    return this.pageDriver.oauthCompletionPage;
  }
  set oauthCompletionPage(value: Page | null) {
    this.pageDriver.oauthCompletionPage = value;
  }

  get oauthTerminalCompletionUrl(): string | null {
    return this.pageDriver.oauthTerminalCompletionUrl;
  }
  set oauthTerminalCompletionUrl(value: string | null) {
    this.pageDriver.oauthTerminalCompletionUrl = value;
  }

  private get harnessAttachedPage(): boolean {
    return this.pageDriver.harnessAttachedPage;
  }
  private set harnessAttachedPage(value: boolean) {
    this.pageDriver.harnessAttachedPage = value;
  }

  get ownedPages() {
    return this.pageDriver.ownedPages;
  }

  private readonly cardValueOutputMask = new CardValueOutputMask();
  private readonly operatorEvidence = new OperatorEvidenceCollector(this.cardValueOutputMask);
  private clickDispatchSequence = 0;
  readonly oauthConsentAttemptedPhases = new Set<string>();
  activeOAuthAttempt: ActiveOAuthAttempt | null = null;
  readonly humanize: boolean;
  // Tracks the simulated mouse position so successive clicks can move
  // along a continuous path (humans don't teleport between clicks).
  mouseX = 100;
  mouseY = 100;

  /** Install the session-lifetime output mask before the first secret write. */
  registerCardValueOutputMask(card: CardMaskRegistration): void {
    this.cardValueOutputMask.register(card);
  }

  maskOperatorOutput<T>(value: T): T {
    return this.cardValueOutputMask.maskValue(value);
  }

  logOperatorDiagnostic(message: string): void {
    console.error(this.cardValueOutputMask.maskText(message));
  }

  readOperatorEvidence(since = 0, requestId?: string) {
    return this.operatorEvidence.read(since, requestId);
  }

  /** Diagnostic-only boolean: did the processor's 3-D Secure SDK recently fail
   * to launch its challenge (Braintree's THREEDS_CARDINAL_SDK_ERROR in the
   * page's own telemetry)? Returns a classification and never exposes evidence
   * values. */
  hasThreeDsSdkErrorEvidence(): boolean {
    return threeDsSdkErrorEvidenceIsFresh(
      this.operatorEvidence.threeDsSdkErrorSeenAt(),
      Date.now(),
    );
  }

  async brokerTargetId(): Promise<string> {
    if (this.context === null || this.page === null) throw new Error("Browser not started");
    const cdp = await this.context.newCDPSession(this.page);
    try {
      return (await cdp.send("Target.getTargetInfo")).targetInfo.targetId;
    } finally {
      await cdp.detach();
    }
  }

  get launchMode(): "headed" | "headless" | "remote" | "unknown" {
    return this.processOwner.launchMode;
  }
  private readonly processOwner: BrowserProcessOwner;
  private readonly pageDriver: PageDriver;
  // Session controllers share the broker's process owner and close only their pages.
  private readonly isSatelliteAttachment: boolean;

  constructor(opts: BrowserControllerOptions = {}, sharedFrom?: BrowserController) {
    this.humanize = opts.humanize ?? true;
    this.pageDriver = new PageDriver(() => this.processOwner.context, this.humanize);
    this.processOwner =
      sharedFrom !== undefined
        ? sharedFrom.processOwner
        : new BrowserProcessOwner(opts, this.pageDriver, (context, hardened, remoteMode) =>
            this.initializePages(context, hardened, remoteMode),
          );
    this.isSatelliteAttachment = sharedFrom !== undefined;
  }

  /** Broker page port: shares only the process owner, with fresh page state. */
  static async attachSessionPage(
    owner: BrowserController,
    opts: BrowserControllerOptions = {},
  ): Promise<BrowserController> {
    const session = new BrowserController(opts, owner);
    await session.attachOwnPage();
    return session;
  }

  // Opens and registers this controller's OWN page in the shared context.
  // Mirrors what initializePages() does for the primary's first page — the
  // same per-page normalization via installPageNormalization — minus the
  // context-level setup (init scripts, resource-blocking routes), which is
  // CONTEXT-scoped and already installed once by whichever controller
  // launched the shared browser.
  private async attachOwnPage(): Promise<void> {
    const ctx = this.processOwner.context;
    if (ctx === null) {
      throw new Error(
        "BrowserController.attachSessionPage: shared browser has no live context to attach a page to",
      );
    }
    const page = await ctx.newPage();
    this.page = page;
    this.primaryPage = page;
    this.trackOpenedTabs(page);
    await this.installPageNormalization(page, this.processOwner.launchMode === "remote");
  }

  /**
   * Opens a short-lived UTILITY tab in the SAME browser context — same cookie
   * jar, same identity runtime, same Google session — for reads that must not
   * disturb the session's live operation page. The canonical case is the
   * await_verification mailbox read: navigating the operation page to Gmail
   * RESETS the very signup form / verification dialog that is waiting for the
   * emailed value (Proton signup, gauntlet 2026-09-16 — the code arrived but
   * could never be entered because the dialog was gone on return). Reads that
   * use this tab keep the waiting page live with its state intact.
   *
   * The caller closes the returned page when its read finishes. The tab is
   * tracked like every other owned page (-OwnedPages + evidence attach +
   * normalization), but it is never the session's active page and the
   * observation pipeline never adopts it as one.
   */
  async openUtilityTab(): Promise<Page> {
    const ctx = this.processOwner.context;
    if (ctx === null) {
      throw new Error("BrowserController.openUtilityTab: browser has no live context");
    }
    const page = await ctx.newPage();
    this.trackOpenedTabs(page);
    await this.installPageNormalization(page, this.processOwner.launchMode === "remote");
    return page;
  }

  // Closes ONLY this controller's own page(s) — never the shared Chrome
  // process/context. Used for every session sharing an experimental
  // multisession identity except whichever one's finish empties the group
  // (which still runs the real close()); see session/lifecycle.ts.
  async closeOwnPagesOnly(): Promise<ProfileCloseState> {
    // Snapshot the whole tab family — the OAuth recovery tab and any adopted
    // popups live in OwnedPages, not just in `page` — BEFORE
    // disposeRegistrations() drops the only map that can enumerate them.
    const family = new Set<Page>(this.ownedPages.live());
    for (const page of [
      this.pageDriver.page,
      this.pageDriver.primaryPage,
      this.pageDriver.oauthProductPage,
      this.pageDriver.oauthProviderPage,
    ]) {
      if (page !== null && !page.isClosed()) family.add(page);
    }
    await Promise.all(
      [...family].map(async (page) => {
        await page.close().catch(() => undefined);
      }),
    );
    if ([...family].some((page) => !page.isClosed())) return "unknown";
    this.pageDriver.disposeRegistrations();
    this.pageDriver.page = null;
    this.pageDriver.primaryPage = null;
    this.pageDriver.oauthProductPage = null;
    this.pageDriver.oauthProviderPage = null;
    this.pageDriver.oauthProviderPageClosed = false;
    return "closed";
  }

  private async initializePages(
    context: BrowserContext,
    hardened: boolean,
    remoteMode: boolean,
  ): Promise<void> {
    // Speed: optionally abort heavy/irrelevant requests before any navigation.
    await this.installResourceBlocking();
    const contextInitScripts = contextInitScriptsFor({ hardened, remoteMode });
    // Never register context init scripts under patchright. Its injection path
    // rewrites text/html after decoding the response as UTF-8, corrupting
    // server-rendered EUC-JP and Shift_JIS before Chrome parses it. The scripts
    // also land outside the main world under patchright, so the per-navigation
    // page.evaluate path below is the effective hardened-mode installation.
    // Baseline playwright-extra does not rewrite responses and keeps these
    // document-start installs. Regression guard: observe-jp-mojibake.test.ts.
    if (contextInitScripts.includes("evaluate-name-shim")) {
      await context.addInitScript({ content: EVALUATE_NAME_SHIM_SCRIPT });
    }
    // Patch navigator.webdriver — BASELINE ONLY. Measured against the
    // rebrowser bot-detector, this manual `defineProperty` is
    // COUNTERPRODUCTIVE under patchright: it re-adds `webdriver` as an own
    // property the detector then flags, whereas patchright removes it
    // correctly at the source. So in hardened mode we leave it to
    // patchright; only the stealth baseline gets the manual patch.
    if (contextInitScripts.includes("navigator-webdriver")) {
      await context.addInitScript(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      });
    }

    // Skip under patchright (hardened) — see the mojibake note above: any
    // context.addInitScript triggers patchright's charset-lossy text/html
    // rewrite. This spoof is already re-applied per navigation via
    // reapplyWebglSpoof (framenavigated/load), which the comment above notes is
    // the ONLY path that reaches the main world under patchright anyway, so the
    // context init copy is dead weight there.
    if (contextInitScripts.includes("webgl-spoof")) {
      await context.addInitScript({ content: INSTALL_WEBGL_SPOOF_SCRIPT });
    }
    this.page = context.pages()[0] ?? (await context.newPage());
    this.trackOpenedTabs(this.page);
    this.primaryPage = this.page;
    await this.installPageNormalization(this.page, remoteMode);
  }

  // Every per-page install the primary's first page gets — the evaluate-name
  // shim, the per-navigation main-world spoof re-apply, the captcha-iframe
  // in-frame spoof, and the optional captcha trace. Under patchright the
  // context init scripts are skipped, so this per-navigation path is the ONLY
  // fingerprint normalization a page gets; a satellite's page
  // (attachOwnPage) must therefore go through it too.
  private async installPageNormalization(page: Page, remoteMode: boolean): Promise<void> {
    await this.operatorEvidence.attach(page);
    // In baseline mode addInitScript covers document-start page JS, but
    // Playwright's page.evaluate utility execution can run in a separate realm.
    // Install the same no-op helper there with a STRING evaluate (tsx cannot
    // wrap strings with __name). This prevents dev-runtime source runs from
    // crashing before replay reaches the service page.
    await page.evaluate(EVALUATE_NAME_SHIM_SCRIPT).catch(() => undefined);
    // Re-apply on every navigation — the main-world reach patchright's isolated
    // init world denies us. framenavigated fires at navigation-commit (before
    // most page JS), so a late WebGL query (reCAPTCHA scores seconds in) sees
    // the spoofed strings; a document-start fingerprinter could still race it.
    const reapplyWebglSpoof = (): void => {
      if (remoteMode) return; // real-GPU remote host: spoof nothing
      const pg = this.page;
      if (pg === null) return;
      void (async () => {
        await pg.evaluate(EVALUATE_NAME_SHIM_SCRIPT).catch(() => undefined);
        await pg.evaluate(INSTALL_WEBGL_SPOOF_SCRIPT).catch(() => {
          // mid-navigation / closed page — the next navigation re-applies.
        });
      })();
    };
    // A CROSS-ORIGIN captcha iframe (hCaptcha / Turnstile / reCAPTCHA) is its own
    // realm: the main-frame page.evaluate above never reaches it, so the captcha's
    // OWN fingerprint read sees the real software-WebGL renderer (llvmpipe /
    // SwiftShader) + 20-core / high-memory / no-taskbar Linux profile — a
    // headless/VM tell. MEASURED 2026-06-23: Stripe's invisible hCaptcha
    // Enterprise flags the session before any token, identically on a datacenter
    // AND a residential exit IP (IP falsified) — the discriminator is this
    // unspoofed in-iframe fingerprint. Patch the iframe's own main world too.
    // frame.evaluate reaches a cross-origin frame's main world at the driver
    // level (same path that wins the main-frame race), re-applied at
    // navigation-commit before the captcha's scoring JS queries WebGL.
    // String probe (no compiled-fn __name shim needed): the UNMASKED renderer
    // a captcha would read. Logged only under CAPTCHA_TRACE to prove the fix.
    const RENDERER_PROBE = String.raw`(() => { try { const c = document.createElement("canvas"); const gl = c.getContext("webgl") || c.getContext("webgl2"); if (!gl) return "no-gl"; const e = gl.getExtension("WEBGL_debug_renderer_info"); return e ? String(gl.getParameter(e.UNMASKED_RENDERER_WEBGL)) : "no-ext"; } catch (err) { return "err:" + (err && err.message); } })()`;
    const trace = process.env.UNIVERSAL_BOT_CAPTCHA_TRACE === "1";
    page.on("framenavigated", (frame) => {
      if (remoteMode) return; // real-GPU remote host: no in-iframe spoof
      if (this.page === null) return;
      if (frame === this.page.mainFrame()) {
        reapplyWebglSpoof();
        return;
      }
      if (!isCaptchaFrameUrl(frame.url())) return;
      const cfHost = (() => {
        try {
          return new URL(frame.url()).host;
        } catch {
          return "captcha-frame";
        }
      })();
      void (async () => {
        if (trace) {
          const before = await frame.evaluate(RENDERER_PROBE).catch(() => "eval-fail");
          this.logOperatorDiagnostic(`[captcha-fp] ${cfHost} renderer BEFORE spoof: ${before}`);
        }
        // Retry until the spoof STICKS. The first framenavigated commonly
        // eval-fails (frame mid-commit, or a throwaway about:blank hCaptcha
        // replaces), and hCaptcha reads the fingerprint during its widget
        // lifecycle — a single best-effort apply loses the race. Re-apply on a
        // ~3s budget until the iframe's renderer reads Intel, so the spoof is in
        // place before the scoring read.
        let landed = false;
        for (let i = 0; i < 20 && !landed; i++) {
          await frame.evaluate(INSTALL_WEBGL_SPOOF_SCRIPT).catch(() => undefined);
          const r = await frame.evaluate(RENDERER_PROBE).catch(() => "eval-fail");
          if (typeof r === "string" && r.includes("Intel")) landed = true;
          else await new Promise((res) => setTimeout(res, 150));
        }
        if (trace) {
          this.logOperatorDiagnostic(
            `[captcha-fp] ${cfHost} renderer AFTER spoof:  ${landed ? "Intel (landed)" : "FAILED to land in budget"}`,
          );
        }
      })();
    });
    page.on("load", reapplyWebglSpoof);

    // rc.33 — captcha tracing. When UNIVERSAL_BOT_CAPTCHA_TRACE=1 is
    // set, log every response from Cloudflare/Google's challenge
    // endpoints plus any console message that mentions captcha-y
    // keywords. Gives us visibility into *why* a Tier-2 click times
    // out ("sat idle" vs "score-too-low" vs "follow-up issued") —
    // the parent page can't read the iframe's DOM (cross-origin) but
    // it CAN observe its network. Off by default; opt in for
    // diagnostic runs only since the bodies can be large.
    if (process.env.UNIVERSAL_BOT_CAPTCHA_TRACE === "1") {
      page.on("response", async (resp) => {
        const url = resp.url();
        if (
          !/challenges\.cloudflare\.com|google\.com\/recaptcha|hcaptcha\.com|newassets\.hcaptcha\.com/.test(
            url,
          )
        ) {
          return;
        }
        const status = resp.status();
        const ct = resp.headers()["content-type"] ?? "";
        let bodyPreview = "";
        if (
          /json|javascript|html|plain/.test(ct) ||
          /api\.hcaptcha\.com\/(?:checksiteconfig|getcaptcha|checkcaptcha)/.test(url)
        ) {
          try {
            const body = await resp.text();
            bodyPreview = body.length > 400 ? body.slice(0, 400) + "…" : body;
          } catch {
            // body may be evicted; ignore
          }
        }
        this.logOperatorDiagnostic(
          `[captcha-trace] ${status} ${url}${
            bodyPreview ? "\n  body: " + bodyPreview.replace(/\n/g, "\\n") : ""
          }`,
        );
      });
      page.on("console", (msg) => {
        const text = msg.text();
        if (!/turnstile|cloudflare|challenge|recaptcha/i.test(text)) return;
        this.logOperatorDiagnostic(`[captcha-trace] console.${msg.type()}: ${text}`);
      });
    }
  }

  private trackMainDocument(page: Page): void {
    return this.pageDriver.trackMainDocument(page);
  }
  mainDocumentIdentity(page: Page | null = this.page): string {
    return this.pageDriver.mainDocumentIdentity(page);
  }

  isActivePage(page: Page): boolean {
    return this.page === page;
  }

  completedOAuthPage(): Page | null {
    const page = this.oauthCompletionPage;
    return page === null || page.isClosed() ? null : page;
  }

  takeOAuthTerminalCompletionUrl(): string | null {
    const url = this.oauthTerminalCompletionUrl;
    this.oauthTerminalCompletionUrl = null;
    return url;
  }

  /** Attach normal controller behavior to a harness-owned Playwright page. */
  static fromHarnessPage(page: Page): BrowserController {
    const controller = new BrowserController({ humanize: false });
    controller.processOwner.context = page.context();
    controller.page = page;
    controller.primaryPage = page;
    controller.trackOpenedTabs(page);
    controller.harnessAttachedPage = true;
    controller.processOwner.launchedMode = "headless";
    return controller;
  }
  trackOpenedTabs(page: Page): void {
    this.pageDriver.trackOpenedTabs(page);
    void this.operatorEvidence.attach(page).catch(() => undefined);
  }
  operatorBrowserMarker(): string {
    return this.processOwner.operatorBrowserMarker();
  }
  isConnected(): boolean {
    return this.processOwner.isConnected();
  }
  get channel(): string | null {
    return this.processOwner.channel;
  }
  get proxied(): string | null {
    return this.processOwner.proxied;
  }
  get stealthProfile(): StealthProfile {
    return this.processOwner.stealthProfile;
  }

  // Resource blocking for speed (BOT_BLOCK_RESOURCES, default OFF). Aborts
  // image/media/font requests to cut page-load wall-clock. Exempt captcha/challenge + payment
  // scripts (blocking those breaks the Turnstile/hCaptcha token poll and the
  // signup form). CSS + first-party JS are never blocked (not in BLOCK_TYPES) —
  // the SPA form renders from them and the vision planner reads the styled
  // render. DUAL RISK, hence default-OFF + an OF#2 A/B before flipping on:
  //   (1) a browser that loads ZERO images is itself an anti-bot fingerprint;
  //   (2) the screenshot the vision planner reads loses detail — mitigated
  //       because the DOM inventory is the authoritative action space, but
  //       still a regression risk on image-only affordances.
  // Registered on the CONTEXT so it covers OAuth popups + iframes.
  private async installResourceBlocking(): Promise<void> {
    const ctx = this.context;
    if (ctx === null) return;
    if (!/^(1|true|on)$/i.test(process.env.BOT_BLOCK_RESOURCES ?? "")) return;
    const BLOCK_TYPES = new Set(["image", "media", "font"]);
    // NEVER block — these break signup (captcha/challenge widgets + payment SDK).
    const ALWAYS_ALLOW = [
      "challenges.cloudflare.com",
      "turnstile",
      "hcaptcha.com",
      "newassets.hcaptcha.com",
      "recaptcha",
      "gstatic.com/recaptcha",
      "js.stripe.com",
    ];
    await ctx.route("**/*", async (route) => {
      try {
        const url = route.request().url();
        if (ALWAYS_ALLOW.some((h) => url.includes(h))) {
          await route.continue();
          return;
        }
        const type = route.request().resourceType();
        if (BLOCK_TYPES.has(type)) {
          await route.abort();
          return;
        }
        await route.continue();
      } catch {
        // Routing race / already-handled — never let a decision crash nav.
      }
    });
    this.logOperatorDiagnostic(
      "[operator] resource blocking ON (image/media/font aborted; captcha/CSS/JS allowed)",
    );
  }
  async start(): Promise<void> {
    // A satellite's page is already attached by attachSessionPage() — there is
    // no process for it to start.
    if (this.isSatelliteAttachment) return;
    return await this.processOwner.start();
  }

  // ---- Contract C driver surface (PR 3) ----------------------------------
  // The frozen browser-driver interface (`driver/types.ts`): seven verbs plus
  // one observe hook. `click`, `type` and `screenshot` already carry the
  // contract names and signatures; the five below are one-line delegations to
  // today's implementations so `implements BrowserDriver` holds with zero
  // behaviour change and no caller changes.
  async navigate(url: string, page?: Page): Promise<void> {
    return await this.goto(url, page);
  }

  async press(key: string, page?: Page | null): Promise<void> {
    const target = page === undefined ? this.page : page;
    if (!target) return;
    await markOperatorMutationDispatchAttempted();
    await target.keyboard.press(key).catch(() => {});
  }

  async scroll(direction: "up" | "down" | "top" | "bottom", page?: Page | null): Promise<void> {
    const target = page === undefined ? this.page : page;
    if (!target) throw new Error("Browser not started");
    await target.evaluate((dir: string) => {
      const step = Math.round(window.innerHeight * 0.8);
      if (dir === "bottom") window.scrollTo(0, document.body.scrollHeight);
      else if (dir === "top") window.scrollTo(0, 0);
      else if (dir === "up") window.scrollBy(0, -step);
      else window.scrollBy(0, step);
    }, direction);
    await target.waitForTimeout(350);
  }

  async observe(page?: Page | null, settlePage?: boolean): Promise<BrowserUseCapture> {
    return await this.extractBrowserUseObservation(page, settlePage);
  }

  async reload(): Promise<void> {
    return await this.pageDriver.reload();
  }

  // Open the first conversation in a Gmail search-results list so the email
  // BODY renders. The results LIST only carries snippets + Gmail chrome links —
  // a magic/verification LINK lives in the body and is absent until the mail is
  // opened, so await_verification could never read it from the list. Best-effort:
  // returns true if a conversation opened (URL hash gained a message id).
  // MEASURED 2026-07-01 (Loops "Login link": list view had no /api/auth/callback
  // href; opening the mail revealed it).
  async openFirstMailResult(page: Page | null = this.page): Promise<boolean> {
    if (page === null) return false;
    const before = page.url();
    // Find the conversation ROW the same way the observation layer does — a
    // role=link element with a substantial subject label (Gmail chrome
    // affordances like "Gmail"/"Compose"/"Inbox" are short or not role=link) —
    // and open it with this.click(), the SAME positional click that works
    // interactively. The prior CSS-selector + synthetic .click() missed: Gmail
    // rows are div[role=link] whose delegated jsaction handler a plain click may
    // not fire. MEASURED 2026-07-01 (Loops "Login link": the results list has no
    // /api/auth/callback href; opening the row reveals it).
    const els = await this.extractInteractiveElements(page);
    const row = els.find(
      (e) =>
        e.role === "link" && (e.visibleText ?? e.ariaLabel ?? e.labelText ?? "").trim().length > 25,
    );
    if (row === undefined) return false;
    await this.clickOnPage(page, row.selector).catch(() => {});
    for (let i = 0; i < 10; i++) {
      const now = page.url();
      // An opened conversation appends a message id to the #search/#inbox hash.
      if (now !== before && /\/[A-Za-z0-9_-]{12,}$/.test(now)) return true;
      await page.waitForTimeout(300).catch(() => {});
    }
    return false;
  }
  async goto(url: string, page?: Page): Promise<void> {
    await markOperatorMutationDispatchAttempted();
    return await this.pageDriver.goto(url, page);
  }

  // Contract C `type` verb: the driver owns the handle/frame/page dispatch.
  async type(
    target: DriverTarget,
    text: string,
    sealed = false,
    page?: Page | null,
  ): Promise<void> {
    const p = page ?? undefined;
    if (target.kind === "handle") {
      await this.typeHandle(target.handle, text, sealed);
      return;
    }
    if (target.kind === "frame") {
      await this.typeInFrame(target.frame, target.selector, text, sealed, p);
      return;
    }
    const active = p ?? this.page;
    if (!active) throw new Error("Browser not started");
    await this.typeOnPage(active, target.selector, text, sealed);
  }

  private async typeOnPage(
    page: Page,
    selector: string,
    text: string,
    sealed = false,
  ): Promise<void> {
    await this.withModalInertNeutralized(
      selector,
      () => this.typeInner(page, selector, text, sealed),
      page,
    );
  }

  /**
   * Commit Shopify's required shipping street field after type/autocomplete.
   * Shopify Places only begins geocoding on this field's change/blur boundary;
   * dispatching change and moving focus away mirrors the user's Tab action.
   * This is intentionally not a generic post-type event mechanism.
   */
  async commitRequiredShippingAddressLine1(
    selector: string,
    page: Page | null = this.page,
  ): Promise<void> {
    if (page === null) throw new Error("Browser not started");
    await page
      .locator(selector)
      .first()
      .evaluate((field) => {
        field.dispatchEvent(new Event("change", { bubbles: true }));
        if (field instanceof HTMLElement) field.blur();
      });
    // Allow Shopify's bounded Places/geocoding request to begin before the
    // caller observes the delivery-method section.
    await this.sleep(500);
  }

  private async typeInner(
    page: Page,
    selector: string,
    text: string,
    sealed = false,
  ): Promise<void> {
    // Wait for element to be visible and enabled before typing.
    await page.waitForSelector(selector, { state: "visible", timeout: 10000 });
    await markOperatorMutationDispatchAttempted();
    const locator = page.locator(selector);
    // Internal secret writers may retain this provenance marker. It is not a
    // generic read seal and never refuses an observation or browser action.
    if (sealed) {
      await locator.evaluate((el) => el.setAttribute("data-ts-sealed-payment", "1"));
    }

    if (!this.humanize) {
      // Fast path for tests / non-humanized runs.
      await page.fill(selector, text);
      return;
    }

    // Humanized typing:
    //   - Click into the field first (moves mouse, generates focus event)
    //   - pressSequentially focuses ONCE and types each char with a
    //     per-key delay. Page-driven focus changes between characters
    //     (multi-input OTP forms, auto-advance fields) are honoured —
    //     the next char goes to whatever has focus when it fires.
    //
    // page.fill() bypasses keydown/keypress/input events entirely — it
    // sets value via JS. That's a giant red flag to behavior scoring.
    // pressSequentially emits real key events so the page sees a normal
    // typing pattern.
    //
    // rc.29 — the prior implementation looped `locator.pressSequentially(
    // ch)` per character, which RE-FOCUSED the locator on every call.
    // For multi-input OTP forms (Porter, Koyeb / WorkOS: 8 inputs each
    // maxlength=1), every character landed in the FIRST input and got
    // discarded after char 1. Switching to a single pressSequentially
    // call lets the browser's auto-advance handler move focus naturally.
    if (page === this.page) await this.humanClick(selector);
    else await locator.click({ timeout: 8000 }).catch(() => undefined);
    // Clear any prefilled value before typing. Only meaningful for
    // single-input fields; multi-input OTP forms ignore this since
    // each box is its own input. The clear + single pressSequentially is
    // the shared humanized typing core (see typeWithRealKeys).
    await this.typeWithRealKeys(locator, text);
  }

  // Clear the field and type `text` with ONE pressSequentially call at a
  // randomised per-key delay — the ordinary humanized typing core, shared by
  // typeInner, typeInFrame, and the card-field writer. page.fill()/
  // handle.fill() set the value with NO keydown/keypress events, and a
  // hosted-field client (or any page watching real typing) can treat that as
  // invalid even though the DOM value looks right; pressSequentially emits
  // the real key events. Never a per-character loop (rc.29): a loop
  // re-focused the locator on every call and stranded every character after
  // the first. opts.timeoutMs bounds the actionability waits for callers
  // whose miss falls through to another attempt (the hosted-field card
  // writer's bounded refill): a frame remounted mid-write leaves the old
  // frame's locator permanently unactionable, and the 30s default would
  // starve the refill budget instead of failing fast into the retry.
  private async typeWithRealKeys(
    locator: Locator,
    text: string,
    opts: { timeoutMs?: number } = {},
  ): Promise<void> {
    const timeout = opts.timeoutMs === undefined ? undefined : { timeout: opts.timeoutMs };
    await locator.fill("", timeout).catch(() => undefined);
    await locator.pressSequentially(text, { delay: rand(40, 110), ...timeout });
  }

  // Best-effort scan for the SPECIFIC unfilled required field(s) blocking a
  // disabled submit. Returns a " Unfilled required field(s) — …" suffix for the
  // disabled-click error so the planner fills the right field instead of
  // re-clicking the dead button. Pure observation — never throws, never mutates.
  private async unfilledRequiredHint(): Promise<string> {
    if (!this.page) return "";
    try {
      const fields = await this.page.evaluate(() => {
        const out: string[] = [];
        const vis = (el: Element): boolean => {
          const r = (el as HTMLElement).getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        const label = (el: Element): string => {
          const al = el.getAttribute("aria-label");
          if (al && al.trim()) return al.trim().slice(0, 40);
          const id = (el as HTMLElement).id;
          if (id) {
            const esc = window.CSS && CSS.escape ? CSS.escape(id) : id;
            const lab = document.querySelector(`label[for="${esc}"]`);
            if (lab && lab.textContent && lab.textContent.trim())
              return lab.textContent.trim().slice(0, 40);
          }
          const ph = el.getAttribute("placeholder");
          if (ph && ph.trim()) return ph.trim().slice(0, 40);
          return (el.getAttribute("name") ?? el.tagName.toLowerCase()).slice(0, 40);
        };
        for (const el of Array.from(
          document.querySelectorAll(
            "input[required],textarea[required],input[aria-required='true'],textarea[aria-required='true']",
          ),
        )) {
          if (!vis(el)) continue;
          const inp = el as HTMLInputElement;
          if (inp.type === "checkbox" || inp.type === "radio") {
            if (!inp.checked) out.push(`unchecked: ${label(el)}`);
          } else if (!inp.value || !inp.value.trim()) {
            out.push(`empty: ${label(el)}`);
          }
        }
        for (const el of Array.from(document.querySelectorAll("select"))) {
          if (vis(el) && !(el as HTMLSelectElement).value) out.push(`unselected: ${label(el)}`);
        }
        for (const el of Array.from(
          document.querySelectorAll("[role='combobox'],[role='listbox']"),
        )) {
          if (!vis(el)) continue;
          const txt = (el.textContent ?? "").trim();
          if (txt.length === 0 || /^(select|choose|please|pick)\b/i.test(txt))
            out.push(`unselected: ${label(el)}`);
        }
        for (const grp of Array.from(document.querySelectorAll("[role='radiogroup']"))) {
          if (!vis(grp)) continue;
          const chosen = grp.querySelector(
            "[role='radio'][aria-checked='true'],input[type='radio']:checked",
          );
          if (!chosen) out.push(`nothing chosen: ${label(grp)}`);
        }
        return Array.from(new Set(out)).slice(0, 5);
      });
      return fields.length > 0
        ? ` Unfilled required field(s) — fill/select these first: ${fields.join("; ")}.`
        : "";
    } catch {
      return "";
    }
  }

  // Read any visible transient toast / alert / notification text. Validation
  // errors, rate-limits, and "operation failed" messages frequently appear as a
  // toast that auto-dismisses BEFORE the next round's capture — so a failed
  // submit looks like a SILENT no-op to the planner. Surfacing it turns the
  // no-op into a diagnosable reason. MEASURED 2026-06-11 (deepseek Sign-up
  // no-ops; the error is a ds-toast the round-start capture never sees).
  // `settleMs` lets the caller reuse a wait it was already going to do.
  async captureTransientAlert(settleMs = 600): Promise<string> {
    if (!this.page) return "";
    if (settleMs > 0) await this.sleep(settleMs);
    try {
      return await this.page.evaluate(() => {
        const sels = [
          "[role='alert']",
          "[aria-live='assertive']",
          ".ds-toast-container",
          ".ds-notification-container",
          ".Toastify__toast",
          ".ant-message-notice",
          ".ant-notification-notice",
          ".sonner-toast",
          "[data-sonner-toast]",
          ".toast",
          ".Toaster",
        ];
        const vis = (el: Element): boolean => {
          const r = (el as HTMLElement).getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        for (const sel of sels) {
          for (const el of Array.from(document.querySelectorAll(sel))) {
            if (!vis(el)) continue;
            const t = (el.textContent ?? "").replace(/\s+/g, " ").trim();
            if (t.length >= 2 && t.length <= 240) return t;
          }
        }
        // Second pass: INLINE field-validation errors (not a transient
        // toast). Many SPAs render "Please enter the verification code" /
        // "Invalid code" as a small element with an error-ish class or an
        // aria-invalid node rather than a toast — so the first pass misses
        // them and a failed submit reads as a silent no-op.
        // MEASURED 2026-06-11 (deepseek post-OTP submit).
        const errSels = [
          "[class*='error' i]",
          "[class*='invalid' i]",
          "[class*='danger' i]",
          "[class*='explain' i]", // antd/ds-form-item-explain
          "[aria-invalid='true']",
        ];
        for (const sel of errSels) {
          for (const el of Array.from(document.querySelectorAll(sel))) {
            if (!vis(el)) continue;
            // Leaf-ish only — skip containers that wrap the whole form.
            if (el.querySelector("input, button, form")) continue;
            const t = (el.textContent ?? "").replace(/\s+/g, " ").trim();
            if (t.length >= 3 && t.length <= 160) return t;
          }
        }
        return "";
      });
    } catch {
      return "";
    }
  }

  // Attach a LOCAL file without driving the OS file dialog. If `selector`
  // resolves to an <input type=file>, set the file on it directly — this works
  // even when the input is visually hidden, which most upload widgets are.
  // Otherwise treat `selector` as the visible trigger (button / menu item /
  // styled label): clicking it opens a file chooser, which Playwright intercepts
  // so the native dialog is never touched. This is how the operator uploads
  // (Drive, S3 consoles, any web form) through the session the user is already
  // signed into — no API credential, no password.
  async uploadFile(selector: string, filePath: string): Promise<void> {
    if (!this.page) throw new Error("Browser not started");
    await this.uploadFileOnPage(this.page, selector, filePath);
  }

  async uploadFileOnPage(page: Page, selector: string, filePath: string): Promise<void> {
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      throw new Error(`upload: local file not found or not a regular file: ${filePath}`);
    }
    const locator = page.locator(selector).first();
    const isFileInput = await locator
      .evaluate((el) => el instanceof HTMLInputElement && el.type === "file")
      .catch(() => false);
    if (isFileInput) {
      await locator.setInputFiles(filePath);
      return;
    }
    // Register the chooser waiter BEFORE the click so the event can't be missed.
    // The catch must attach at creation, not after the click resolves: the click
    // actionability-waits up to 30s (e.g. an occluded button), so the waiter's
    // 15s timeout can reject while the click is still pending — a bare rejection
    // here is an unhandledRejection that kills the whole MCP server process.
    const chooserPromise: Promise<FileChooser | null> = page
      .waitForEvent("filechooser", { timeout: 15_000 })
      .then((c): FileChooser | null => c)
      .catch((): null => null);
    await locator.click();
    const chooser = await chooserPromise;
    if (chooser === null) {
      throw new Error(
        `upload: clicking "${selector}" did not open a file picker within 15s. ` +
          `Target the upload button (or the file <input>) and retry.`,
      );
    }
    await chooser.setFiles(filePath);
  }

  // Ancestors marked `inert` for a "hide the background while a modal is
  // open" trick are meant to sit OUTSIDE a truly-portaled dialog (Angular
  // CDK/Material's overlay container is a sibling of the app root, and only
  // the app root gets marked inert — unaffected by this). A dialog that
  // isn't portaled to <body> — it only escapes its container VISUALLY via
  // position:fixed — remains a structural DESCENDANT of the inert ancestor,
  // and Chromium's real hit-testing (which Playwright's actionability check
  // relies on) skips an inert subtree entirely: a normal click() on such a
  // control hangs waiting for actionability that never arrives (see the
  // matching neutralizeInertForHitTest in extractElementsFromContext, which
  // covers el_table's topmost/occludedBy reporting for the same case).
  // Scoped tight — only neutralized when the target itself resolves inside a
  // detected dialog/modal region — so a genuine background control outside
  // any modal keeps its inert protection (money-fence boundary untouched).
  // Ancestors are tagged with a marker attribute (not held as live handles)
  // so the restore step re-finds exactly what THIS call neutralized even
  // across the intervening await.
  //
  // 2026-09-15: an audit removal of this mutation was attempted and WITHDRAWN
  // on live-repro evidence. It is the only guard for the #564 shape — without
  // it, clicks inside such a modal fail until timeout (recovering only via
  // operate_click's "intercepts pointer events" -> js_click fallback, a full
  // actionability timeout later) and typing has NO mechanical recovery at all
  // (fill() cannot focus an inert-nested control: the fast path silently
  // no-ops, humanized typing errors). #771's semantic-blocker path covers only
  // the PORTALED shape (proven live on Shop Pay), where the blocker's dismiss
  // ref sits outside the inert subtree; here that ref is inert-nested itself.
  async withModalInertNeutralized<T>(
    selector: string,
    fn: (modalActive: boolean) => Promise<T>,
    page: Page | null = this.page,
  ): Promise<T> {
    if (page === null) throw new Error("Browser not started");
    const handle = await page.$(selector).catch(() => null);
    if (handle === null) return await fn(false);
    try {
      return await this.neutralizeModalInert(handle, page, fn);
    } finally {
      await handle.dispose().catch(() => undefined);
    }
  }

  // Single Page|Frame implementation shared by withModalInertNeutralized
  // (main frame, by selector) and clickInFrame (a handle inside an iframe).
  // The target is always an ElementHandle; the restore sweep always runs
  // against the document the handle actually lives in.
  private async neutralizeModalInert<T>(
    handle: ElementHandle<Element>,
    scope: Page | Frame,
    fn: (modalActive: boolean) => Promise<T>,
  ): Promise<T> {
    const marker = "data-ts-inert-neutralized";
    const anchorMarker = "data-ts-inert-region-anchor";
    const modalActive = await handle
      .evaluate(
        (el, markers) => {
          const { marker, anchorMarker } = markers;
          const composedParent = (node: Node): Element | null => {
            const parent = node.parentNode;
            if (parent === null) return null;
            if (parent instanceof ShadowRoot) return parent.host;
            return parent instanceof Element ? parent : null;
          };
          const isDialogElement = (element: Element): boolean =>
            element.getAttribute("role") === "dialog" ||
            element.tagName.toLowerCase() === "dialog" ||
            element.getAttribute("aria-modal") === "true";
          const nearestModalRegion = (element: Element): Element | null => {
            let cur: Element | null = element;
            while (cur !== null) {
              if (isDialogElement(cur)) return cur;
              cur = composedParent(cur);
            }
            return null;
          };
          const region = nearestModalRegion(el);
          if (region === null) return false;
          region.setAttribute(anchorMarker, "1");
          let cur: Element | null = el;
          while (cur !== null) {
            if (cur.hasAttribute("inert")) {
              cur.removeAttribute("inert");
              cur.setAttribute(marker, "1");
            }
            cur = composedParent(cur);
          }
          return true;
        },
        { marker, anchorMarker },
      )
      .catch(() => false);
    try {
      return await fn(modalActive);
    } finally {
      await scope
        .evaluate(
          (markers) => {
            const { marker, anchorMarker } = markers;
            const isDialogElement = (element: Element): boolean =>
              element.getAttribute("role") === "dialog" ||
              element.tagName.toLowerCase() === "dialog" ||
              element.getAttribute("aria-modal") === "true";
            // Only a currently open/rendered dialog counts as still active:
            // HTMLDialogElement.close() leaves the <dialog> connected without
            // `open`, and frameworks keep hidden role="dialog" nodes mounted
            // after closing — a stale remnant must not keep the background
            // locked once the modal genuinely closed.
            const isRenderedDialog = (element: Element): boolean => {
              if (!isDialogElement(element)) return false;
              if (element instanceof HTMLDialogElement) return element.open;
              if (typeof element.checkVisibility === "function")
                return element.checkVisibility({ visibilityProperty: true });
              if (element.hasAttribute("hidden")) return false;
              const style = window.getComputedStyle(element);
              return style.display !== "none" && style.visibility !== "hidden";
            };
            const subtreeHasDialog = (root: Element | ShadowRoot): boolean => {
              if (root instanceof Element) {
                if (isRenderedDialog(root)) return true;
                if (root.shadowRoot !== null && subtreeHasDialog(root.shadowRoot)) return true;
              }
              for (const el of Array.from(root.querySelectorAll("*"))) {
                if (isRenderedDialog(el)) return true;
                if (el.shadowRoot !== null && subtreeHasDialog(el.shadowRoot)) return true;
              }
              return false;
            };
            const cleanupAndRestore = (root: Document | ShadowRoot): void => {
              root
                .querySelectorAll(`[${anchorMarker}]`)
                .forEach((el) => el.removeAttribute(anchorMarker));
              root.querySelectorAll(`[${marker}]`).forEach((el) => {
                el.removeAttribute(marker);
                if (subtreeHasDialog(el)) el.setAttribute("inert", "");
              });
              root.querySelectorAll("*").forEach((el) => {
                if (el.shadowRoot !== null) cleanupAndRestore(el.shadowRoot);
              });
            };
            cleanupAndRestore(document);
          },
          { marker, anchorMarker },
        )
        .catch(() => undefined);
    }
  }

  // Contract C `click` verb: the driver owns the handle/frame/page dispatch
  // and the tracked-vs-plain choice. Ordinary clicks on the active page run
  // through dispatch tracking; js_click never does; an action page that is
  // not the active page is dispatched untracked (pre-existing semantics).
  async click(target: DriverTarget & { method: ClickMethod }, page?: Page | null): Promise<void> {
    const p = page ?? undefined;
    const tracked = target.method === "click" && (p === undefined || this.isActivePage(p));
    if (target.kind === "handle") {
      if (tracked) {
        await this.clickWithDispatchTracking({
          kind: "handle",
          handle: target.handle,
          method: "click",
        });
      } else if (target.method === "click") {
        await this.clickHandle(target.handle);
      } else {
        await this.jsClickHandle(target.handle);
      }
      return;
    }
    if (tracked) {
      await this.clickWithDispatchTracking(
        target.kind === "frame"
          ? { kind: "frame", frame: target.frame, selector: target.selector, method: "click" }
          : { kind: "selector", selector: target.selector, method: "click" },
        undefined,
        async () => {
          if (target.kind === "frame") await this.clickInFrame(target.frame, target.selector, p);
          else if (p !== undefined) await this.clickOnPage(p, target.selector);
          else await this.clickActivePageSelector(target.selector);
        },
      );
      return;
    }
    if (target.kind === "frame") {
      if (target.method === "click") {
        await this.clickInFrame(target.frame, target.selector, p);
      } else {
        await this.clickViaJsInFrame(target.frame, target.selector, 0, p);
      }
      return;
    }
    if (target.method === "click") {
      if (p !== undefined) {
        await this.clickOnPage(p, target.selector);
      } else {
        await this.clickActivePageSelector(target.selector);
      }
      return;
    }
    if (p !== undefined) {
      await p.locator(target.selector).evaluate((element) => (element as HTMLElement).click());
    } else {
      await this.clickViaJs(target.selector);
    }
  }

  // The positional main-page click with modal-inert neutralization: the
  // tracked-click fallback and the OAuth dispatch path land here.
  private async clickActivePageSelector(selector: string): Promise<void> {
    if (!this.page) throw new Error("Browser not started");
    await this.withModalInertNeutralized(selector, () => this.clickInner(selector));
  }

  async bindOAuthClickTarget(
    selector: string,
    confirmSelector: () => Promise<string>,
  ): Promise<ElementHandle<Element> | null> {
    if (!this.page) throw new Error("Browser not started");
    const expected = await this.page
      .locator(selector)
      .first()
      .elementHandle()
      .catch(() => null);
    if (expected === null) return null;
    let current: ElementHandle<Element> | null = null;
    try {
      current = await this.page
        .locator(await confirmSelector())
        .first()
        .elementHandle()
        .catch(() => null);
      if (
        current === null ||
        !(await current.evaluate((element, target) => element === target, expected))
      ) {
        await expected.dispose().catch(() => undefined);
        return null;
      }
      return expected;
    } catch {
      await expected.dispose().catch(() => undefined);
      return null;
    } finally {
      await current?.dispose().catch(() => undefined);
    }
  }

  async matchesOAuthClickTarget(
    expected: ElementHandle<Element>,
    selector: string,
  ): Promise<boolean> {
    if (!this.page) return false;
    const current = await this.page
      .locator(selector)
      .first()
      .elementHandle()
      .catch(() => null);
    if (current === null) return false;
    try {
      return await current.evaluate((element, target) => element === target, expected);
    } catch {
      return false;
    } finally {
      await current.dispose().catch(() => undefined);
    }
  }

  private async clickInner(selector: string): Promise<void> {
    if (!this.page) throw new Error("Browser not started");
    // ARIA toggle that ignores synthetic clicks: a <button role="switch"> whose
    // handler binds to keydown only (Firebase's Google-provider "Enable"
    // switch). A plain click() returns success but aria-checked never moves —
    // a silent no-op the planner then loops on. MEASURED 2026-06-27 (Firebase
    // auth capstone) and re-measured 2026-09-15 (ts-wave2 removal study): the
    // keyboard activation (focus + Space) is the ARIA-correct fix and flips it.
    // Click first (cheap); if aria-checked didn't move, focus and press Space.
    // Scoped narrowly to role=switch (compliant widgets are unaffected: their
    // click flips aria-checked and the read-back returns immediately).
    try {
      const node = this.page.locator(selector).first();
      if ((await node.getAttribute("role").catch(() => null)) === "switch") {
        const readChecked = (): Promise<string | null> =>
          node.getAttribute("aria-checked").catch(() => null);
        const before = await readChecked();
        await node.click({ timeout: 8000 }).catch(() => undefined);
        // Only when aria-checked EXISTS can we observe the toggle; without it a
        // Space press would blind-fire on top of a click that already worked.
        if (before !== null && (await readChecked()) === before) {
          await node.focus().catch(() => undefined);
          await this.page.keyboard.press("Space").catch(() => undefined);
        }
        return;
      }
    } catch {
      // selector didn't resolve / element vanished — fall through to a click
    }
    if (!this.humanize) {
      await this.page.click(selector);
      return;
    }
    await this.humanClick(selector);
  }

  // Resolve a locator-form operate_act target (`text=…` / `css=…`) DIRECTLY
  // against a live page/frame document, bypassing the extracted-inventory list.
  // This is the escape hatch for a control the inventory never emitted: a bare
  // click-handler <div> with no role/label/testid that the SELECTOR walk skips,
  // or a typeable control missing from the inventory. The card scan can also
  // drop a control once its MAX_CARDS budget is spent on earlier cursor:pointer
  // divs (Casetify's Add-To-Cart is element #45 of the eligible cards; the cap is
  // 16). With no ref, `text=`/`css=` is the only host-addressable target.
  //
  // Resolution rules (kept deliberately strict so the action can't land on the
  // wrong element):
  //   • text mode — matches an element whose rendered text (innerText, so hidden
  //     descendants don't leak) equals (or, if nothing equals, contains) the
  //     query AND that carries a real click affordance (button/a/label/select
  //     tag, an interactive ARIA role, an onclick / action-type attribute, or
  //     cursor:pointer). Plain prose that merely contains the words is excluded.
  //     Open shadow roots are pierced.
  //   • css mode — the author's selector, restricted to VISIBLE matches.
  //   • A weak (cursor-only) descendant inside a strong control collapses away;
  //     weak ancestors and two GENUINE nested controls stay ambiguous rather
  //     than being silently merged.
  //   • 0 matches → {ok:false, reason:"none"}; >1 → {ok:false, reason:"ambiguous"}
  //     with the candidate texts so the host can disambiguate. Exactly 1 returns
  //     a live ElementHandle to the winner. The caller acts through the handle
  //     (never a DOM-visible marker), so a page MutationObserver cannot re-aim
  //     the action at a decoy between resolution and dispatch, and disposes it
  //     after.
  private async resolveTargetInContext(
    ctx: Page | Frame,
    mode: "text" | "css",
    value: string,
    intent: "click" | "type",
  ): Promise<
    | {
        ok: true;
        handle: ElementHandle<Element>;
        text: string;
        labels: string[];
        documentOrigin: string;
      }
    | { ok: false; reason: "none" | "ambiguous"; candidates: string[] }
  > {
    if (!this.page) throw new Error("Browser not started");
    const resultHandle = await ctx.evaluateHandle(
      ({ mode, value, intent }) => {
        const norm = (s: string | null): string =>
          (s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
        // Rendered text, NOT textContent: innerText reflects what the user
        // actually sees, excluding display:none / visibility:hidden descendants.
        // Matching on textContent let a visible "Cancel" button that hides a
        // "Delete account" span be selected by text="Delete account" (codex).
        // Display form: whitespace-collapsed but ORIGINAL case (for the trace /
        // audit / candidate list). `rendered` lowercases it for matching only.
        const renderedRaw = (el: Element): string => {
          const it = (el as HTMLElement).innerText;
          return (typeof it === "string" ? it : (el.textContent ?? "")).replace(/\s+/g, " ").trim();
        };
        const rendered = (el: Element): string => renderedRaw(el).toLowerCase();
        // Visibility walks the ANCESTOR chain (crossing shadow-host boundaries):
        // opacity does not inherit, so a button under an opacity:0 wrapper keeps
        // its own computed opacity 1 and a self-only check would wrongly treat it
        // as visible and click an invisible control (codex).
        const isVisible = (el: Element): boolean => {
          const r = el.getBoundingClientRect();
          if (r.width < 2 || r.height < 2) return false;
          let node: Element | null = el;
          while (node !== null) {
            const s = window.getComputedStyle(node);
            if (s.display === "none" || s.visibility === "hidden" || s.opacity === "0")
              return false;
            const parentEl: Element | null = node.parentElement;
            if (parentEl !== null) {
              node = parentEl;
            } else {
              const root = node.getRootNode();
              node = root instanceof ShadowRoot ? root.host : null;
            }
          }
          return true;
        };
        // "Strong" = real interactive semantics (a genuine control), as opposed
        // to an element that merely inherits cursor:pointer from a clickable
        // ancestor (a decorative wrapper / inner label span).
        const isStrong = (el: Element): boolean => {
          const tag = el.tagName.toLowerCase();
          const role = el.getAttribute("role");
          if (
            tag === "button" ||
            tag === "a" ||
            tag === "label" ||
            tag === "select" ||
            tag === "summary"
          )
            return true;
          if (
            role === "button" ||
            role === "link" ||
            role === "radio" ||
            role === "checkbox" ||
            role === "menuitem" ||
            role === "menuitemradio" ||
            role === "option" ||
            role === "tab" ||
            role === "switch"
          )
            return true;
          return el.hasAttribute("onclick") || el.hasAttribute("action-type");
        };
        const hasClickAffordance = (el: Element): boolean =>
          isStrong(el) || window.getComputedStyle(el).cursor === "pointer";
        const hasTypeAffordance = (el: Element): boolean =>
          (el instanceof HTMLInputElement && el.type !== "hidden" && !el.disabled) ||
          (el instanceof HTMLTextAreaElement && !el.disabled) ||
          (el instanceof HTMLElement && el.isContentEditable);
        const typeLabel = (el: Element): string => {
          const labels =
            el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
              ? Array.from(el.labels ?? []).map((label) => renderedRaw(label))
              : [];
          return [
            ...labels,
            el.getAttribute("aria-label") ?? "",
            el.getAttribute("placeholder") ?? "",
            el.getAttribute("name") ?? "",
            el.getAttribute("id") ?? "",
            renderedRaw(el),
          ]
            .filter((part) => part.length > 0)
            .join(" ");
        };
        const effectiveLabels = (el: Element): string[] =>
          Array.from(
            new Set(
              [
                el.getAttribute("aria-label") ?? "",
                el instanceof HTMLInputElement ? el.value : "",
                renderedRaw(el),
              ]
                .map((part) => part.replace(/\s+/g, " ").trim())
                .filter((part) => part.length > 0),
            ),
          );

        // Gather candidates across the light DOM and every OPEN shadow root.
        const all: Element[] = [];
        const collect = (root: Document | ShadowRoot): void => {
          if (root == null || typeof root.querySelectorAll !== "function") return;
          let nodes: Element[] = [];
          if (mode === "css") {
            try {
              nodes = Array.from(root.querySelectorAll(value));
            } catch {
              nodes = [];
            }
          } else {
            nodes = Array.from(root.querySelectorAll("*"));
          }
          for (const n of nodes) all.push(n);
          for (const el of Array.from(root.querySelectorAll("*"))) {
            const sr = (el as HTMLElement).shadowRoot;
            if (sr != null) collect(sr);
          }
        };
        collect(document);

        let pool: Element[];
        if (mode === "css") {
          pool = all.filter((el) => isVisible(el) && (intent === "click" || hasTypeAffordance(el)));
        } else {
          const want = norm(value);
          if (want.length === 0) {
            return {
              element: null,
              count: 0,
              candidates: [] as string[],
              text: "",
              labels: [] as string[],
              documentOrigin: location.origin,
            };
          }
          const affordable = all.filter(
            (el) =>
              isVisible(el) &&
              (intent === "click" ? hasClickAffordance(el) : hasTypeAffordance(el)),
          );
          const matchText = (el: Element): string =>
            intent === "click" ? rendered(el) : norm(typeLabel(el));
          const exact = affordable.filter((el) => matchText(el) === want);
          // Prefer exact-text matches; only fall back to "contains" (with a
          // length guard so a big wrapper doesn't swallow the query) when no
          // element's rendered text equals the query.
          pool =
            exact.length > 0
              ? exact
              : affordable.filter((el) => {
                  const t = matchText(el);
                  return t.includes(want) && t.length <= Math.max(80, want.length + 20);
                });
        }
        // Bound the O(n²) nesting-collapse below: a broad selector (css=* /
        // css=div) can match thousands of nodes, and a pairwise `contains` scan
        // over all of them would block the page for seconds. A pool this large
        // is ambiguous by any measure (the caller wants exactly one), so
        // short-circuit to ambiguous before the quadratic pass (no-mistakes review).
        const AMBIGUOUS_POOL_CAP = 40;
        if (pool.length > AMBIGUOUS_POOL_CAP) {
          return {
            element: null,
            count: pool.length,
            candidates: pool.slice(0, 8).map((el) => renderedRaw(el).slice(0, 60)),
            text: "",
            labels: [] as string[],
            documentOrigin: location.origin,
          };
        }
        // Collapse nesting WITHOUT silently merging two genuine controls. A
        // STRONG candidate (real interactive semantics) always survives. A WEAK
        // candidate (only inherits cursor:pointer — a decorative wrapper or the
        // inner label span of a real control) is dropped only when it sits
        // inside a strong candidate (it's part of that control's subtree, e.g.
        // Casetify's <span> inside the button <div>). Two WEAK candidates in a
        // nesting relationship — each a bare click-handler div with its own
        // listener — are NOT collapsed:
        // dropping the outer would pick the inner, whose click bubbles to the
        // outer and fires BOTH handlers (a double add-to-cart). They both
        // survive → reported ambiguous rather than silently double-clicked (codex).
        const leaves = pool.filter((el) => {
          if (isStrong(el)) return true;
          for (const other of pool) {
            if (other === el) continue;
            if (other.contains(el) && isStrong(other)) return false;
          }
          return true;
        });
        const uniq = Array.from(new Set(leaves));
        const candidates = uniq.slice(0, 8).map((el) => renderedRaw(el).slice(0, 60));
        const win = uniq.length === 1 ? (uniq[0] as HTMLElement) : null;
        return {
          element: win,
          count: uniq.length,
          candidates,
          text: win !== null ? renderedRaw(win).slice(0, 120) : "",
          labels: win !== null ? effectiveLabels(win) : [],
          documentOrigin: location.origin,
        };
      },
      { mode, value, intent },
    );
    const meta = await resultHandle.evaluate((r) => ({
      count: r.count,
      candidates: r.candidates,
      text: r.text,
      labels: r.labels,
      documentOrigin: r.documentOrigin,
    }));
    if (meta.count !== 1) {
      await resultHandle.dispose();
      return {
        ok: false,
        reason: meta.count === 0 ? "none" : "ambiguous",
        candidates: meta.candidates,
      };
    }
    // Pull out a live ElementHandle to the winning node; dispose the wrapper.
    const winHandle = await resultHandle.evaluateHandle((r) => r.element);
    await resultHandle.dispose();
    const asElement = winHandle.asElement();
    if (asElement === null) {
      await winHandle.dispose();
      return { ok: false, reason: "none", candidates: meta.candidates };
    }
    return {
      ok: true,
      handle: asElement,
      text: meta.text ?? "",
      labels: meta.labels ?? [],
      documentOrigin: meta.documentOrigin,
    };
  }

  async resolvePageTarget(
    mode: "text" | "css",
    value: string,
    intent: "click" | "type" = "click",
    page: Page | null = this.page,
  ): Promise<ResolvedPageTarget> {
    if (page === null) throw new Error("Browser not started");
    const matches: Array<{
      handle: ElementHandle<Element>;
      text: string;
      labels: string[];
      frameTarget: FrameTarget | null;
    }> = [];
    const candidates: string[] = [];
    for (const frame of page.frames()) {
      if (frame.isDetached()) continue;
      const rawUrl = frame.url();
      if (frame !== page.mainFrame() && this.frameWithinCaptcha(frame)) continue;
      const resolved = await this.resolveTargetInContext(frame, mode, value, intent).catch(
        () => null,
      );
      if (resolved === null) continue;
      if (!resolved.ok) {
        if (resolved.reason === "ambiguous") candidates.push(...resolved.candidates);
        continue;
      }
      let frameTarget: FrameTarget | null = null;
      if (frame !== page.mainFrame()) {
        try {
          frameTarget = {
            framePath: this.framePath(frame),
            frameOrigin: this.frameOrigin(frame),
            frameUrl: rawUrl,
          };
        } catch {
          await resolved.handle.dispose().catch(() => undefined);
          continue;
        }
      }
      matches.push({ ...resolved, frameTarget });
      candidates.push(resolved.text);
    }
    if (matches.length !== 1 || candidates.length > 1) {
      await Promise.all(matches.map((match) => match.handle.dispose().catch(() => undefined)));
      return {
        ok: false,
        reason: candidates.length === 0 ? "none" : "ambiguous",
        candidates: candidates.slice(0, 8),
      };
    }
    return { ok: true, ...matches[0]! };
  }

  private async locatorClickState(
    handle: ElementHandle<Element>,
  ): Promise<"detached" | "disabled" | "ok"> {
    return await handle.evaluate((el) => {
      if (!el.isConnected) return "detached";
      if (typeof el.matches === "function" && el.matches(":disabled")) return "disabled";
      let n: Element | null = el;
      while (n !== null) {
        if (n.getAttribute("aria-disabled") === "true") return "disabled";
        const parentEl: Element | null = n.parentElement;
        if (parentEl !== null) {
          n = parentEl;
        } else {
          const root = n.getRootNode();
          n = root instanceof ShadowRoot ? root.host : null;
        }
      }
      return "ok";
    });
  }

  private async runTrackedClick(
    handle: ElementHandle<Element>,
    click: () => Promise<void>,
  ): Promise<ClickDispatchStatus> {
    const token = `ts-click-${this.clickDispatchSequence++}`;
    const installed = await handle
      .evaluate((element, dispatchToken) => {
        const stateWindow = window as Window & {
          __trustySquireClickDispatch?: { token: string; dispatched: boolean };
        };
        const tracked = element as Element & { __tsClickDispatchListener?: EventListener };
        if (tracked.__tsClickDispatchListener !== undefined) {
          element.removeEventListener("click", tracked.__tsClickDispatchListener, true);
        }
        stateWindow.__trustySquireClickDispatch = { token: dispatchToken, dispatched: false };
        const listener: EventListener = () => {
          const state = stateWindow.__trustySquireClickDispatch;
          if (state?.token === dispatchToken) state.dispatched = true;
        };
        tracked.__tsClickDispatchListener = listener;
        element.addEventListener("click", listener, { capture: true, once: true });
      }, token)
      .then(() => true)
      .catch(() => false);
    const readState = async (): Promise<ClickDispatchStatus> => {
      if (!installed) return "unknown";
      return await handle
        .evaluate((element, dispatchToken) => {
          const stateWindow = window as Window & {
            __trustySquireClickDispatch?: { token: string; dispatched: boolean };
          };
          const tracked = element as Element & { __tsClickDispatchListener?: EventListener };
          const state = stateWindow.__trustySquireClickDispatch;
          if (tracked.__tsClickDispatchListener !== undefined) {
            element.removeEventListener("click", tracked.__tsClickDispatchListener, true);
            delete tracked.__tsClickDispatchListener;
          }
          if (state?.token !== dispatchToken) return "unknown" as const;
          delete stateWindow.__trustySquireClickDispatch;
          return state.dispatched ? ("dispatched" as const) : ("not_dispatched" as const);
        }, token)
        .catch(() => "unknown" as const);
    };
    try {
      await click();
    } catch (error) {
      if (error instanceof BrowserClickDispatchError) {
        await readState();
        throw error;
      }
      throw new BrowserClickDispatchError(await readState(), error);
    }
    await readState();
    return "dispatched";
  }

  private async clickTargetLabels(handle: ElementHandle<Element>): Promise<string[]> {
    const signals = await handle.evaluate((element) => {
      const rendered = (node: Element): string => {
        const innerText = (node as HTMLElement).innerText;
        return (typeof innerText === "string" ? innerText : (node.textContent ?? ""))
          .replace(/\s+/g, " ")
          .trim();
      };
      const labelTexts =
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement ||
        element instanceof HTMLSelectElement
          ? Array.from(element.labels ?? [], rendered)
          : [];
      return {
        ariaLabel: element.getAttribute("aria-label"),
        inputValue: element instanceof HTMLInputElement ? element.value : null,
        textContent: rendered(element),
        labelTexts,
      };
    });
    return Array.from(
      new Set(
        [signals.ariaLabel, signals.inputValue, signals.textContent, ...signals.labelTexts]
          .map((label) => label?.trim() ?? "")
          .filter((label) => label.length > 0),
      ),
    );
  }

  async clickWithDispatchTracking(
    target: TrackedClickTarget,
    shouldTrack: (labels: readonly string[]) => boolean = () => true,
    performClick?: () => Promise<void>,
    page: Page | null = this.page,
  ): Promise<ClickDispatchStatus> {
    // Accepted residual: aria-labelledby-only names can escape this final probe;
    // closing it would broaden shared click instrumentation again.
    // Accepted residual: same-handle labels can change during the actionability
    // wait; dispatch-boundary hooks would alter shared click semantics.
    // Accepted residual: page closure during the pre-click state probe remains
    // ambiguous; tightening it would deepen the primitive that regressed ordinary clicks.
    if (page === null) {
      throw new BrowserClickDispatchError("not_dispatched", new Error("Browser not started"));
    }
    let handle: ElementHandle<Element> | null;
    let dispose = false;
    try {
      if (target.kind === "handle") {
        handle = target.handle;
      } else if (target.kind === "frame") {
        handle = await this.resolveFrameElement(target.frame, target.selector, 0, page);
        dispose = true;
      } else {
        handle = await page.$(target.selector);
        dispose = true;
      }
    } catch (error) {
      throw new BrowserClickDispatchError("not_dispatched", error);
    }
    if (handle === null) {
      throw new BrowserClickDispatchError(
        "not_dispatched",
        new Error("click target detached before dispatch"),
      );
    }
    try {
      let labels: string[];
      try {
        labels = await this.clickTargetLabels(handle);
      } catch (error) {
        throw new BrowserClickDispatchError("not_dispatched", error);
      }
      // Ordinary operator clicks retain their checkbox, modal and widget semantics.
      const click =
        performClick ??
        (() => (target.method === "click" ? this.clickHandle(handle) : this.jsClickHandle(handle)));
      await markOperatorMutationDispatchAttempted();
      if (!shouldTrack(labels)) {
        await click();
        return "dispatched";
      }
      return await this.runTrackedClick(handle, click);
    } finally {
      if (dispose) await handle.dispose().catch(() => undefined);
    }
  }

  async clickHandle(handle: ElementHandle<Element>): Promise<void> {
    const state = await this.locatorClickState(handle);
    if (state === "detached") {
      throw new BrowserClickDispatchError(
        "not_dispatched",
        new Error("locator target detached from the page before the click"),
      );
    }
    if (state === "disabled") {
      throw new BrowserClickDispatchError(
        "not_dispatched",
        new Error("locator target is disabled"),
      );
    }
    await handle.click({ timeout: 8000, noWaitAfter: true });
  }

  async jsClickHandle(handle: ElementHandle<Element>): Promise<void> {
    const state = await this.locatorClickState(handle);
    if (state === "detached") {
      throw new BrowserClickDispatchError(
        "not_dispatched",
        new Error("locator target detached from the page before the click"),
      );
    }
    if (state === "disabled") {
      throw new BrowserClickDispatchError(
        "not_dispatched",
        new Error("locator target is disabled"),
      );
    }
    const dispatchState = await handle.evaluate((el) => {
      if (!el.isConnected) return "detached";
      if (typeof el.matches === "function" && el.matches(":disabled")) return "disabled";
      let n: Element | null = el;
      while (n !== null) {
        if (n.getAttribute("aria-disabled") === "true") return "disabled";
        const parentEl: Element | null = n.parentElement;
        if (parentEl !== null) {
          n = parentEl;
        } else {
          const root = n.getRootNode();
          n = root instanceof ShadowRoot ? root.host : null;
        }
      }
      (el as HTMLElement).click();
      return "ok";
    });
    if (dispatchState === "detached") {
      throw new BrowserClickDispatchError(
        "not_dispatched",
        new Error("locator target detached from the page before the click"),
      );
    }
    if (dispatchState === "disabled") {
      throw new BrowserClickDispatchError(
        "not_dispatched",
        new Error("locator target is disabled"),
      );
    }
  }

  async clickOnPage(page: Page, selector: string): Promise<void> {
    await page.locator(selector).click({ timeout: 8000, noWaitAfter: true });
  }

  async typeHandle(handle: ElementHandle<Element>, text: string, sealed = false): Promise<void> {
    const ownerFrame = await handle.ownerFrame();
    if (ownerFrame === null) throw new Error("locator target has no owning frame");
    await markOperatorMutationDispatchAttempted();
    if (sealed) {
      await handle.evaluate((el) => el.setAttribute("data-ts-sealed-payment", "1"));
    }
    if (!this.humanize) {
      await handle.fill(text);
      return;
    }
    await handle.click({ timeout: 8000 }).catch(() => undefined);
    await handle.fill("").catch(() => undefined);
    await handle.type(text, { delay: rand(40, 110) });
  }

  // Dispatch a DOM .click() in the page context. Some React copy buttons fire
  // their onClick (and thus navigator.clipboard.writeText) on the synthetic
  // event a real Playwright mouse click doesn't reliably reproduce (deepinfra's
  // "copy key": a JS click populated the clipboard in a probe where the
  // positional click did not). Used as a copy-extraction fallback; the preceding
  // real click supplies the transient user-activation writeText needs.
  private async clickViaJs(selector: string, index = 0): Promise<void> {
    if (!this.page) return;
    const safeIndex = Math.max(0, Math.floor(index));
    await this.page
      .evaluate(
        ({ sel, i }) => {
          const els = Array.from(document.querySelectorAll<HTMLElement>(sel));
          const el = els[i] ?? els[0];
          if (el !== undefined) el.click();
        },
        { sel: selector, i: safeIndex },
      )
      .catch(() => undefined);
  }

  async check(selector: string): Promise<void> {
    if (!this.page) throw new Error("Browser not started");
    // Use force:true because TOS checkboxes are sometimes visually covered by
    // a custom label/styled wrapper but the underlying input is checkable.
    await this.page.waitForSelector(selector, { state: "attached", timeout: 10000 });
    // Bring it into the viewport first — MongoDB/Sentry signup
    // checkboxes sit below the fold and a bezier mouse-click misses
    // an off-screen element (F3 T6).
    await this.page
      .locator(selector)
      .scrollIntoViewIfNeeded({ timeout: 5000 })
      .catch(() => {});
    if (!this.humanize) {
      await this.page.check(selector, { force: true }).catch(() => undefined);
      if (await this.ensureChecked(selector)) return;
      throw new Error(`Unable to check selector "${selector}" after label and DOM fallbacks`);
    }
    // For visible checkboxes, move the mouse to it first (a real user
    // would). For force-checked invisible ones, fall back to the
    // Playwright API so we don't try to mouse-click an offscreen element.
    await this.humanClick(selector).catch(() => undefined);
    await this.page.check(selector, { force: true }).catch(() => undefined);
    if (await this.ensureChecked(selector)) return;
    throw new Error(`Unable to check selector "${selector}" after click, label, and DOM fallbacks`);
  }

  private async ensureChecked(selector: string): Promise<boolean> {
    if (!this.page) return false;
    if (
      await this.page
        .locator(selector)
        .isChecked()
        .catch(() => false)
    )
      return true;

    await this.clickAssociatedLabel(selector).catch(() => false);
    if (
      await this.page
        .locator(selector)
        .isChecked()
        .catch(() => false)
    )
      return true;

    const domChecked = await this.page
      .locator(selector)
      .first()
      .evaluate((el) => {
        if (!(el instanceof HTMLInputElement)) return false;
        if (el.type !== "checkbox" && el.type !== "radio") return false;
        if (!el.checked) {
          el.click();
        }
        if (!el.checked) {
          el.checked = true;
          el.setAttribute("checked", "");
          el.setAttribute("aria-checked", "true");
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }
        return el.checked;
      })
      .catch(() => false);
    if (!domChecked) return false;
    return await this.page
      .locator(selector)
      .isChecked()
      .catch(() => false);
  }

  // Click the <label> associated with a checkbox/radio input — either a
  // `<label for="<id>">` or the wrapping `<label>` ancestor. Mantine/Radix
  // render the real input visually-hidden inside a styled label; clicking the
  // label is what fires the library's onChange (a direct input check can
  // leave React's controlled state stale). Returns true if a label was
  // found + clicked. Best-effort — never throws.
  private async clickAssociatedLabel(selector: string): Promise<boolean> {
    if (!this.page) return false;
    try {
      const id = await this.page
        .locator(selector)
        .first()
        .evaluate((el) => (el instanceof HTMLElement ? el.id : ""))
        .catch(() => "");
      if (id) {
        const forLabel = this.page.locator(`label[for="${id}"]`).first();
        if ((await forLabel.count()) > 0) {
          await forLabel.click({ timeout: 4000 });
          return true;
        }
      }
      // No `for=` label — try the wrapping <label> ancestor.
      const wrapping = this.page.locator(selector).locator("xpath=ancestor::label[1]").first();
      if ((await wrapping.count()) > 0) {
        await wrapping.click({ timeout: 4000 });
        return true;
      }
      // Some Radix/shadcn-style controls render the hidden input as a sibling
      // of the visible agreement label, with no `for=` and no wrapping label
      // (Mistral's terms checkbox). At this point direct check has already
      // failed/not toggled, so clicking the nearest agreement-shaped label in
      // the same form is the safest remaining human-equivalent action.
      const clickedAgreement = await this.page
        .locator(selector)
        .first()
        .evaluate((el) => {
          const agreementRe = /terms|tos\b|privacy|policy|i accept|i agree|agree to/i;
          const form = el.closest("form");
          const labels = [
            ...(form ? Array.from(form.querySelectorAll("label")) : []),
            ...Array.from(document.querySelectorAll("label")),
          ];
          const label = labels.find((candidate) => agreementRe.test(candidate.textContent ?? ""));
          if (!(label instanceof HTMLElement)) return false;
          label.click();
          return true;
        })
        .catch(() => false);
      if (clickedAgreement) {
        return true;
      }
    } catch {
      // best-effort
    }
    return false;
  }

  // Deterministic pre-submit guard: tick every visible, unchecked,
  // non-disabled REQUIRED-AGREEMENT checkbox (terms/privacy/consent),
  // while never touching marketing/newsletter opt-ins.
  //
  // Why this exists separate from the LLM planner: amplitude's signup
  // has a required TOS checkbox the planner skipped (it read the
  // adjacent data-storage card-radios as the whole cluster being
  // "ambiguous radios"), and amplitude does NOT disable submit when the
  // box is unticked — so the click silently no-ops and the bot then
  // waits forever for a verification mail that never sends. This is a
  // submit-path guard, independent of any particular submit selector.
  //
  // Returns the labels/testids it checked (for step logging); empty when
  // it ticked nothing.
  async checkRequiredAgreementBoxes(): Promise<string[]> {
    if (!this.page) throw new Error("Browser not started");
    // Best-effort: a page-eval failure (navigation mid-call, detached
    // frame) must never fail the parent submit — return nothing.
    try {
      return await this.page.evaluate(() => {
        // The page realm can't import module code, so these regexes are
        // inlined here.
        const agreementRe =
          /terms|tos\b|privacy|consent|policy|i agree|agree to|acknowledge|gdpr|age|18\+|18 years|certif/i;
        const marketingRe =
          /newsletter|updates|offers|product tips|marketing|promotional|receive emails|opt[- ]?in to|subscribe/i;

        const checked: string[] = [];
        const boxes = Array.from(
          document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
        );
        for (const box of boxes) {
          if (box.checked || box.disabled) continue;
          const rect = box.getBoundingClientRect();
          const ancestorLabel = box.closest("label");
          const labelRect = ancestorLabel?.getBoundingClientRect();
          const visible =
            (rect.width > 0 && rect.height > 0) ||
            (labelRect !== undefined && labelRect.width > 0 && labelRect.height > 0);
          if (!visible) continue;

          // Associated text = attributes + a label[for=id] + nearest
          // ancestor <label> + the immediately following sibling text.
          const parts: string[] = [
            box.getAttribute("data-testid") ?? "",
            box.getAttribute("name") ?? "",
            box.id,
            box.getAttribute("aria-label") ?? "",
          ];
          if (box.id) {
            const forLabel = document.querySelector(`label[for="${CSS.escape(box.id)}"]`);
            if (forLabel) parts.push(forLabel.textContent ?? "");
          }
          if (ancestorLabel) parts.push(ancestorLabel.textContent ?? "");
          const sibling = box.nextSibling;
          if (sibling && sibling.textContent) parts.push(sibling.textContent);
          if (box.nextElementSibling) {
            parts.push(box.nextElementSibling.textContent ?? "");
          }

          const text = parts.join(" ");
          if (!agreementRe.test(text) || marketingRe.test(text)) continue;

          // React/Vue controlled inputs ignore a bare `.checked = true`:
          // their state lives in the framework, updated only by the real
          // event flow. Click first (while unchecked) so the framework sees the
          // same transition a user would make, then force-ensure checked and
          // dispatch input/change for styled/hidden inputs whose click target
          // does not toggle the underlying control.
          box.click();
          if (!box.checked) box.checked = true;
          box.dispatchEvent(new Event("input", { bubbles: true }));
          box.dispatchEvent(new Event("change", { bubbles: true }));

          const label =
            box.getAttribute("data-testid") ||
            box.getAttribute("name") ||
            box.id ||
            box.getAttribute("aria-label") ||
            "agreement-checkbox";
          checked.push(label);
        }
        return checked;
      });
    } catch {
      return [];
    }
  }

  // Deterministic pre-submit guard for required signup category choices.
  //
  // Paddle-class forms ask a required "What do you sell?" question where one
  // product category must be selected before account creation, but the submit
  // button remains enabled. The planner can satisfy the agreement checkbox and
  // still skip the category, producing a rejected submit + no verification mail.
  //
  // Keep this conservative: only fire when the page text explicitly says a
  // product/category choice is required, never touch agreement/marketing boxes,
  // and prefer low-risk SaaS/software labels over restricted categories.
  async checkRequiredSignupChoiceBoxes(): Promise<string[]> {
    if (!this.page) throw new Error("Browser not started");
    try {
      return await this.page.evaluate(() => {
        const choiceGateRe =
          /what do you sell|categories we support|select which types? of products|choose (?:a|your) (?:category|product|business type)|product category|business category/i;
        const safeChoiceRe =
          /digital products?|saas|software|developer tools?|apis?|mobile apps?|data|analytics/i;
        const riskyChoiceRe =
          /gambling|financial services?|physical products?|marketplace|human services?|adult|weapons?|medical|restricted|crypto|payments?|banking/i;
        const agreementRe = /terms|tos\b|privacy|consent|policy|i agree|agree to|acknowledge|gdpr/i;
        const marketingRe =
          /newsletter|updates|offers|product tips|marketing|promotional|receive emails|opt[- ]?in to|subscribe/i;

        const bodyText = document.body?.innerText ?? "";
        if (!choiceGateRe.test(bodyText)) return [];

        const associatedText = (box: HTMLInputElement): string => {
          const parts: string[] = [
            box.getAttribute("data-testid") ?? "",
            box.getAttribute("name") ?? "",
            box.id,
            box.getAttribute("aria-label") ?? "",
          ];
          if (box.id) {
            const forLabel = document.querySelector(`label[for="${CSS.escape(box.id)}"]`);
            if (forLabel) parts.push(forLabel.textContent ?? "");
          }
          const ancestorLabel = box.closest("label");
          if (ancestorLabel) parts.push(ancestorLabel.textContent ?? "");
          if (box.nextElementSibling) {
            parts.push(box.nextElementSibling.textContent ?? "");
          }
          return parts.join(" ").replace(/\s+/g, " ").trim();
        };

        const boxes = Array.from(
          document.querySelectorAll<HTMLInputElement>(
            'input[type="checkbox"], input[type="radio"]',
          ),
        );
        const visibleBoxes = boxes.filter((box) => {
          if (box.disabled) return false;
          const rect = box.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        });

        const alreadyChoseCategory = visibleBoxes.some((box) => {
          if (!box.checked) return false;
          const text = associatedText(box);
          return !agreementRe.test(text) && !marketingRe.test(text) && !riskyChoiceRe.test(text);
        });
        if (alreadyChoseCategory) return [];

        const candidates = visibleBoxes
          .filter((box) => !box.checked)
          .map((box) => ({ box, text: associatedText(box) }))
          .filter(({ text }) => {
            if (!text) return false;
            if (agreementRe.test(text) || marketingRe.test(text)) return false;
            if (riskyChoiceRe.test(text)) return false;
            return safeChoiceRe.test(text);
          })
          .sort((a, b) => {
            const score = (text: string): number => {
              if (/digital products?|saas|software/i.test(text)) return 3;
              if (/developer tools?|apis?|data|analytics/i.test(text)) return 2;
              if (/mobile apps?/i.test(text)) return 1;
              return 0;
            };
            return score(b.text) - score(a.text);
          });
        const choice = candidates[0];
        if (!choice) return [];

        choice.box.checked = true;
        choice.box.dispatchEvent(new Event("input", { bubbles: true }));
        choice.box.dispatchEvent(new Event("change", { bubbles: true }));
        choice.box.click();
        return [
          choice.box.getAttribute("data-testid") ||
            choice.box.getAttribute("name") ||
            choice.box.id ||
            choice.box.getAttribute("aria-label") ||
            choice.text ||
            "signup-choice",
        ];
      });
    } catch {
      return [];
    }
  }

  // Scroll a Terms-of-Service style modal to the bottom so the gated
  // "Accept" button enables. Railway's signup is the canonical case:
  // a modal with a virtualized ToS list watches real `scroll` /
  // `wheel` events on its container and only flips the button to
  // enabled once `scrollTop + clientHeight ~= scrollHeight`.
  //
  // The post-verify planner has no way to name a non-interactive div
  // (the inventory only carries interactive elements), so when
  // `selector` is omitted this method auto-detects the most plausible
  // scrollable container: the largest visible element with
  // `overflow:auto|scroll` and real scroll headroom. Returns a
  // structured result so the executor can log what it found and the
  // calling planner round can re-plan if nothing was scrollable.
  //
  // Strategy:
  //   1. Resolve a target element (selector or auto-detected).
  //   2. Position the mouse over it and emit a series of `mouse.wheel`
  //      events. Real wheel events fire `scroll` + `wheel` handlers
  //      and walk virtualized lists row by row; a single JS
  //      `scrollTop = scrollHeight` skips them.
  //   3. Fallback: once wheel loop exits, set `scrollTop = scrollHeight`
  //      and dispatch a synthetic `scroll` event. Covers static lists
  //      whose handlers only debounce on the final scroll position.
  // Operator surface — reveal below-the-fold controls so the planner can act on
  // them (heavy SPAs like the GCP console render long forms whose lower fields
  // sit outside the viewport and so never enter the element inventory). Scrolls
  // the page by ~80% of a viewport (or to an extreme); the next observe picks
  // up the newly-visible elements.
  // Pick a valid option for either a native <select> OR a custom
  // ARIA combobox (Radix, Headless UI, React Aria, cmdk — F11). The
  // bot must not call type() on a select-shaped element (Sentry,
  // legacy form path: "Element is not an <input>"); modern dashboards
  // increasingly render permission / role / region pickers as
  // <button role="combobox"> that open a <ul role="listbox"> with
  // <li role="option"> children, so Playwright's selectOption fails
  // with "no selectable option" on them.
  //
  // Dispatch: read the element's tag. <select> → native path
  // (existing behavior, picks the first non-placeholder option).
  // Anything else → combobox path (click to open, find role=option,
  // click the chosen one).
  //
  // `optionMatcher` is the planner-supplied text of the option to
  // pick (e.g. "Project: Read"). Case-insensitive substring match
  // against the option's visible text. When undefined, picks the
  // first option — preserves the existing behavior for native
  // selects whose contents are interchangeable (country pickers).
  // Contract C `select` verb: the driver owns the frame/page dispatch.
  async select(target: DriverTarget, optionMatcher?: string, page?: Page | null): Promise<string> {
    const p = page ?? undefined;
    if (target.kind === "frame") {
      return await this.selectInFrame(target.frame, target.selector, optionMatcher, p);
    }
    if (target.kind !== "selector") {
      throw new Error("select: handle targets are not supported");
    }
    const active = p ?? this.page;
    if (!active) throw new Error("Browser not started");
    return await this.selectOptionOnPage(active, target.selector, optionMatcher);
  }

  async selectOptionOnPage(page: Page, selector: string, optionMatcher?: string): Promise<string> {
    return await this.withModalInertNeutralized(
      selector,
      () => this.selectOptionInner(page, selector, optionMatcher),
      page,
    );
  }

  private async selectOptionInner(
    page: Page,
    selector: string,
    optionMatcher?: string,
  ): Promise<string> {
    await page.waitForSelector(selector, { state: "attached", timeout: 10000 });
    await markOperatorMutationDispatchAttempted();
    let activeSelector = selector;
    let tagName = await page
      .locator(activeSelector)
      .first()
      .evaluate((node) => node.tagName.toLowerCase());

    // 0.8.2-rc.21 — Railway-class fix. The captured selector frequently
    // points at a `<label>` (the inventory ranker prefers visible-text
    // elements). If that label's `for=` association resolves to a
    // native `<select>`, take the native path instead of routing into
    // selectFromCombobox — native selects don't reveal their options
    // via any DOM pattern in headless Chromium (they're OS-rendered),
    // so the combobox path is guaranteed to fail for them. Without
    // this redirect, every captured Railway/legacy-form `<select>`
    // step replays as "no options found after click."
    if (tagName === "label") {
      const resolved = await this.resolveLabelToInput(activeSelector, page);
      if (resolved !== activeSelector) {
        const resolvedTag = await page
          .locator(resolved)
          .first()
          .evaluate((node) => node.tagName.toLowerCase())
          .catch(() => "");
        if (resolvedTag === "select") {
          activeSelector = resolved;
          tagName = "select";
        }
      } else {
        const rowControl = await page
          .locator(activeSelector)
          .first()
          .evaluate((label) => {
            const root =
              label.closest(".n-form-group__row") ??
              label.closest("label")?.parentElement ??
              label.parentElement;
            // Only fall back to a control found by row proximity when the
            // row offers EXACTLY ONE candidate. Taking the first of several
            // silently drove the wrong control (measured live: a "Phone
            // country" label over a row holding an address select and a
            // phone select committed the ADDRESS select and reported
            // success). With several candidates the label is left as the
            // target and the combobox path refuses loudly.
            const controls = Array.from(
              root?.querySelectorAll<HTMLElement>(
                'select,button[role="combobox"],input[role="combobox"],[role="combobox"]',
              ) ?? [],
            );
            const control = controls.length === 1 ? controls[0] : undefined;
            if (control === undefined) return null;
            const id = control.getAttribute("id");
            if (id !== null && id.length > 0) return `#${CSS.escape(id)}`;
            const testId =
              control.getAttribute("data-qa") ??
              control.getAttribute("data-testid") ??
              control.getAttribute("data-test") ??
              control.getAttribute("data-cy");
            if (testId !== null && testId.length > 0) {
              return `[data-qa="${CSS.escape(testId)}"],[data-testid="${CSS.escape(testId)}"],[data-test="${CSS.escape(testId)}"],[data-cy="${CSS.escape(testId)}"]`;
            }
            return null;
          })
          .catch(() => null);
        if (rowControl !== null) {
          activeSelector = rowControl;
          tagName = await page
            .locator(activeSelector)
            .first()
            .evaluate((node) => node.tagName.toLowerCase())
            .catch(() => tagName);
        }
      }
    }

    if (tagName === "select") {
      // Keep the resolved target as a Locator. Walker selectors can include
      // Playwright chains such as `select.foo >> nth=1`; appending CSS text to
      // those strings changes the chain's meaning (`... >> nth=1 option`) and
      // makes a full select appear option-less. Descendant lookup, selection,
      // and verification must all stay anchored to the same resolved element.
      const selectLocator = page.locator(activeSelector).first();
      const optionLocator = selectLocator.locator("option");
      // Native path. rc.15 — keep value="" options selectable. The
      // Railway workspace dropdown's "No workspace" option is value=""
      // and it IS the right pick for an account-scoped token. The
      // prior implementation filtered empty strings out of the fallback
      // list AND rejected matched value="" picks, so the planner could
      // never reach that option. Now: fallback list keeps every option
      // (with the first option's value, even if empty), and a matched
      // text-based pick is honored verbatim — including empty values.
      const allValues = await optionLocator.evaluateAll((opts) =>
        opts.map((o) => (o instanceof HTMLOptionElement ? o.value : "")),
      );
      if (allValues.length === 0) {
        throw new Error(`<select> ${activeSelector} has no selectable option`);
      }
      // Default to the first NON-empty value when the planner gave no
      // hint — historic behavior, kept because "Select…" placeholder
      // options are almost always the wrong default pick.
      const firstReal = allValues.find((v) => v.length > 0);
      let chosenValue: string | undefined = firstReal !== undefined ? firstReal : allValues[0];
      if (optionMatcher !== undefined) {
        // Whitespace-normalized on both sides so a matcher read from a
        // wrapped inventory line still compares cleanly.
        const matcherLower = optionMatcher.replace(/\s+/g, " ").trim().toLowerCase();
        // Whitespace-normalized, case-insensitive. An EXACT match wins
        // outright. A substring fallback is taken only when it is UNIQUE:
        // `includes` + first-match silently committed the wrong option on
        // any text collision (measured live: "Guinea" committed
        // "Equatorial Guinea", "Korea" committed "North Korea"), and a
        // silent wrong pick is worse than a loud refusal the planner can
        // re-plan from. Ambiguity names the candidates and refuses.
        // Returns either a chosen value (may be "") or the ambiguous texts.
        const matched = await optionLocator.evaluateAll((opts, needle) => {
          const options = opts.filter(
            (o): o is HTMLOptionElement => o instanceof HTMLOptionElement,
          );
          const text = (o: HTMLOptionElement): string =>
            (o.textContent ?? "").replace(/\s+/g, " ").trim().toLowerCase();
          const exact = options.find((o) => text(o) === needle);
          if (exact !== undefined) return { value: exact.value };
          const partial = options.filter((o) => text(o).includes(needle));
          const only = partial[0];
          if (partial.length === 1 && only !== undefined) return { value: only.value };
          if (partial.length > 1) {
            return {
              ambiguous: partial.slice(0, 6).map((o) => (o.textContent ?? "").trim()),
            };
          }
          return null;
        }, matcherLower);
        if (matched === null) {
          throw new Error(
            `<select> ${activeSelector}: no option matched ${JSON.stringify(optionMatcher)}`,
          );
        }
        if ("ambiguous" in matched) {
          throw new Error(
            `<select> ${activeSelector}: ${JSON.stringify(optionMatcher)} matches several options ` +
              `(${matched.ambiguous.map((t) => JSON.stringify(t)).join(", ")}) — ` +
              "pass the exact option text",
          );
        }
        chosenValue = matched.value;
      }
      if (chosenValue === undefined) {
        throw new Error(`<select> ${activeSelector} has no selectable option`);
      }
      await selectLocator.selectOption(chosenValue);
      const committedValue = await selectLocator.inputValue();
      if (committedValue !== chosenValue) {
        throw new Error(
          `<select> ${activeSelector}: selected value ${JSON.stringify(chosenValue)} did not stick`,
        );
      }
      // rc.17 — mark the element as touched so subsequent inventory
      // reads can suppress the DEFAULTED-dropdown warning for it.
      // Without this, a select whose committed value is "" (Railway's
      // "No workspace") keeps tripping the warning every round, and
      // the planner gets stuck in a select→select→… loop trying to
      // satisfy a warning the form has already satisfied.
      await selectLocator
        .evaluate((el) => {
          if (el instanceof HTMLElement) el.setAttribute("data-ts-touched", "1");
        })
        .catch(() => {});
      return await selectLocator.evaluate((select) =>
        select instanceof HTMLSelectElement
          ? (select.selectedOptions[0]?.textContent ?? "").replace(/\s+/g, " ").trim()
          : "",
      );
    }

    // Custom combobox path. Sentry, Radix, Headless UI, React Aria
    // — every modern React picker emits role=option on its items.
    return await this.selectFromCombobox(activeSelector, optionMatcher, page);
  }

  // Set the country on a phone-number field backed by a phone-local native
  // <select>, including react-phone-number-input's opacity:0 country select.
  // The inventory walker omits that hidden control and Playwright refuses to
  // select it, so this path uses the native value setter, dispatches change,
  // and verifies the selected value. Custom phone widget families are not
  // supported and fail loudly.
  async setPhoneCountry(country: string, page: Page | null = this.page): Promise<void> {
    if (!page) throw new Error("Browser not started");
    const query = classifyPhoneCountryQuery(country);
    if (query.dialCode === undefined && query.iso2 === undefined && query.name === undefined) {
      throw new Error("setPhoneCountry: empty country argument");
    }
    await this.clearPhoneCountryMarkers(page);
    await page
      .locator('[data-ts-phone-country-control="1"]')
      .evaluateAll((elements) => {
        elements.forEach((element) => element.removeAttribute("data-ts-phone-country-control"));
      })
      .catch(() => undefined);
    if (await this.trySetPhoneCountryNativeSelect(query, page)) return;
    throw new Error(
      "set_phone_country: no supported native phone-country <select> found " +
        "(this widget family is not supported yet) — enter a valid contact number instead.",
    );
  }

  async verifyPhoneCountry(country: string, page: Page | null = this.page): Promise<boolean> {
    if (!page) return false;
    const query = classifyPhoneCountryQuery(country);
    if (query.dialCode === undefined && query.iso2 === undefined && query.name === undefined) {
      return false;
    }
    const selected = await page.evaluate(() => {
      const control = document.querySelector('select[data-ts-phone-country-control="1"]');
      if (!(control instanceof HTMLSelectElement)) return null;
      const option = control.selectedOptions[0];
      return option === undefined
        ? null
        : {
            value: option.value,
            text: (option.textContent ?? "").replace(/\s+/g, " ").trim(),
          };
    });
    if (selected === null) return false;
    const option: PhoneCountryOption = {
      text: selected.text.length > 0 ? selected.text : undefined,
      iso2: /^[A-Za-z]{2}$/.test(selected.value) ? selected.value.toUpperCase() : undefined,
      dialCode: /^\+?\d{1,4}$/.test(selected.value) ? selected.value.replace(/\D/g, "") : undefined,
    };
    return phoneCountryOptionMatches(query, option);
  }

  async hasPhoneCountryControl(page: Page | null = this.page): Promise<boolean> {
    if (!page) return false;
    return (await page.locator('select[data-ts-phone-country-control="1"]').count()) === 1;
  }

  // Strategy 1 — a native <select> that governs the phone country (react-
  // phone-number-input's `opacity:0` PhoneInputCountrySelect, or any bespoke
  // widget backed by a real <select>). Detection is deliberately conservative
  // so it does NOT grab the address "country" select that lives elsewhere on
  // the checkout: a select qualifies only when its class/name/id names it a
  // PHONE control and its options carry country evidence, or its options look
  // like countries AND it is a direct sibling of the tel input or lives in an
  // immediately adjacent wrapper.
  // Returns false when no such select exists; throws when one is found but the
  // requested country isn't among its options.
  private async trySetPhoneCountryNativeSelect(
    query: PhoneCountryQuery,
    page: Page,
  ): Promise<boolean> {
    const candidates = await page.evaluate(() => {
      const out: Array<{
        marker: number;
        options: Array<{ value: string; text: string }>;
        phoneNamed: boolean;
        telDistance: number;
      }> = [];
      const selects = Array.from(document.querySelectorAll("select"));
      selects.forEach((sel, i) => {
        if (!(sel instanceof HTMLSelectElement)) return;
        const hay = `${sel.className} ${sel.getAttribute("name") ?? ""} ${sel.id}`.toLowerCase();
        const phoneNamed = /phone|dial|calling/.test(hay);
        let telDistance = Number.POSITIVE_INFINITY;
        const isTel = (el: Element | null): boolean => el?.matches('input[type="tel"]') === true;
        const parent = sel.parentElement;
        if (
          parent !== null &&
          parent.tagName !== "FORM" &&
          (isTel(sel.previousElementSibling) || isTel(sel.nextElementSibling))
        ) {
          telDistance = 0;
        } else if (
          parent !== null &&
          parent.tagName !== "FORM" &&
          Array.from(parent.children).some(isTel)
        ) {
          telDistance = 1;
        }
        const options = Array.from(sel.options).map((o) => ({
          value: o.value,
          text: (o.textContent ?? "").replace(/\s+/g, " ").trim(),
        }));
        const isoish = options.filter((o) => /^[A-Za-z]{2}$/.test(o.value)).length;
        const dialish = options.filter(
          (o) => /\+\d/.test(o.text) || /^\+?\d{1,4}$/.test(o.value),
        ).length;
        const explicitDialish = options.filter(
          (o) => /\+\d/.test(o.text) || /^\+\d{1,4}$/.test(o.value),
        ).length;
        const countryish = options.length >= 10 && (isoish >= 5 || dialish >= 5);
        const countryNamed = /country|nation|iso/.test(hay);
        const dialCodeNamed = /dial|calling/.test(hay);
        const phoneCountryish =
          countryish ||
          explicitDialish > 0 ||
          (dialCodeNamed && dialish >= 2) ||
          (countryNamed && isoish >= 2);
        if ((phoneNamed && phoneCountryish) || (countryish && telDistance <= 1)) {
          sel.setAttribute("data-ts-phone-cc", String(i));
          out.push({
            marker: i,
            options,
            phoneNamed,
            telDistance: telDistance === Number.POSITIVE_INFINITY ? 99 : telDistance,
          });
        }
      });
      return out;
    });
    if (candidates.length === 0) return false;
    // Prefer a phone-NAMED select, then the one physically closest to a tel
    // input — the strongest evidence it's the dial-code control, not address.
    candidates.sort(
      (a, b) => Number(b.phoneNamed) - Number(a.phoneNamed) || a.telDistance - b.telDistance,
    );
    const best = candidates[0];
    if (best === undefined) return false;
    const opts: PhoneCountryOption[] = best.options.map((o) => ({
      text: o.text.length > 0 ? o.text : undefined,
      iso2: /^[A-Za-z]{2}$/.test(o.value) ? o.value.toUpperCase() : undefined,
      dialCode: /^\+?\d{1,4}$/.test(o.value) ? o.value.replace(/\D/g, "") : undefined,
    }));
    const idx = pickPhoneCountryOption(query, opts);
    const chosenOpt = idx === -1 ? undefined : best.options[idx];
    if (chosenOpt === undefined) {
      await this.clearPhoneCountryMarkers(page);
      const sample = best.options
        .map((o) => o.text)
        .filter((t) => t.length > 0)
        .slice(0, 6)
        .join(" | ");
      throw new Error(
        `setPhoneCountry: native phone <select> found but no option matched ` +
          `${JSON.stringify(query)} (sample: ${sample})`,
      );
    }
    const value = chosenOpt.value;
    // Set through the native value setter + a dispatched `change` so a React-
    // controlled select (react-phone-number-input) sees the update: assigning
    // .value directly is swallowed by React's value tracker, so we go through
    // the prototype setter the tracker also patches, then fire the event React
    // listens on. Works on the opacity:0 select without a visibility check.
    await markOperatorMutationDispatchAttempted();
    const assigned = await page.evaluate(
      ({ marker, val }) => {
        const sel = document.querySelector(`select[data-ts-phone-cc="${marker}"]`);
        if (!(sel instanceof HTMLSelectElement)) return false;
        const desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
        if (desc?.set !== undefined) desc.set.call(sel, val);
        else sel.value = val;
        sel.dispatchEvent(new Event("input", { bubbles: true }));
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        sel.setAttribute("data-ts-phone-country-control", "1");
        return true;
      },
      { marker: best.marker, val: value },
    );
    const committedValue = assigned
      ? await page
          .locator(`select[data-ts-phone-cc="${best.marker}"]`)
          .inputValue()
          .catch(() => "")
      : "";
    await this.clearPhoneCountryMarkers(page);
    if (!assigned || committedValue !== value) {
      throw new Error(
        `setPhoneCountry: native phone <select> did not retain value ${JSON.stringify(value)}`,
      );
    }
    return true;
  }

  private async clearPhoneCountryMarkers(page: Page | null = this.page): Promise<void> {
    if (!page) return;
    await page
      .evaluate(() => {
        document.querySelectorAll("[data-ts-phone-cc]").forEach((el) => {
          el.removeAttribute("data-ts-phone-cc");
        });
      })
      .catch(() => {});
  }

  private async markComboboxPreexistingElements(page: Page = this.page!): Promise<void> {
    await page.evaluate(() => {
      const visible = (el: Element): boolean => {
        const rect = el.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) return false;
        const style = getComputedStyle(el);
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          parseFloat(style.opacity || "1") > 0.01
        );
      };
      const popupSelector =
        '[role="listbox"],[role="menu"],[role="dialog"],[id*="listbox" i],[id*="dropdown" i],[id*="popover" i],[id*="menu" i],[id*="options" i],[class*="listbox" i],[class*="dropdown" i],[class*="popover" i],[class*="menu" i],[class*="options" i]';
      document
        .querySelectorAll(popupSelector)
        .forEach((el) => visible(el) && el.setAttribute("data-ts-select-preexisting-popup", "1"));
    });
  }

  private async refreshComboboxMarkers(
    triggerSelector: string,
    page: Page = this.page!,
  ): Promise<void> {
    await page
      .locator(triggerSelector)
      .first()
      .evaluate((trigger) => {
        const visible = (el: Element): boolean => {
          const rect = el.getBoundingClientRect();
          if (rect.width < 2 || rect.height < 2) return false;
          const style = getComputedStyle(el);
          return (
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            parseFloat(style.opacity || "1") > 0.01
          );
        };
        document
          .querySelectorAll("[data-ts-select-popup],[data-ts-select-option-tier]")
          .forEach((el) => {
            el.removeAttribute("data-ts-select-popup");
            el.removeAttribute("data-ts-select-option-tier");
          });
        const popupSelector =
          '[role="listbox"],[role="menu"],[role="dialog"],[id*="listbox" i],[id*="dropdown" i],[id*="popover" i],[id*="menu" i],[id*="options" i],[class*="listbox" i],[class*="dropdown" i],[class*="popover" i],[class*="menu" i],[class*="options" i]';
        const controlledPopups: Element[] = [];
        for (const attr of ["aria-controls", "aria-owns"]) {
          for (const id of (trigger.getAttribute(attr) ?? "").split(/\s+/).filter(Boolean)) {
            const popup = trigger.ownerDocument.getElementById(id);
            if (popup !== null && visible(popup) && !controlledPopups.includes(popup)) {
              controlledPopups.push(popup);
            }
          }
        }
        const openedPopups: Element[] = [];
        trigger.ownerDocument.querySelectorAll(popupSelector).forEach((el) => {
          if (
            !el.hasAttribute("data-ts-select-preexisting-popup") &&
            visible(el) &&
            !openedPopups.includes(el)
          ) {
            openedPopups.push(el);
          }
        });
        const singlePopup = (candidates: Element[]): Element | undefined => {
          const semantic = candidates.filter((el) =>
            el.matches('[role="listbox"],[role="dialog"],[role="menu"]'),
          );
          const pool = semantic.length > 0 ? semantic : candidates;
          const innermost = pool.filter(
            (candidate) => !pool.some((other) => other !== candidate && candidate.contains(other)),
          );
          return innermost.length === 1 ? innermost[0] : undefined;
        };
        const popup =
          controlledPopups.length > 0 ? singlePopup(controlledPopups) : singlePopup(openedPopups);
        popup?.setAttribute("data-ts-select-popup", "1");
        const optionSelectors = [
          '[role="option"]',
          '[role="menuitem"]',
          '[role="menuitemradio"]',
          "mat-option",
          ".mat-mdc-option",
          '[id^="react-select-"][role*="menu"]',
          '[role="listbox"] li',
        ];
        optionSelectors.forEach((selector, tier) => {
          trigger.ownerDocument.querySelectorAll(selector).forEach((el) => {
            if (popup !== undefined && visible(el) && (popup === el || popup.contains(el))) {
              el.setAttribute("data-ts-select-option-tier", String(tier));
            }
          });
        });
      });
  }

  private async clearComboboxMarkers(page: Page = this.page!): Promise<void> {
    await page
      .evaluate(() => {
        document
          .querySelectorAll(
            "[data-ts-select-preexisting-popup],[data-ts-select-popup],[data-ts-select-option-tier]",
          )
          .forEach((el) => {
            el.removeAttribute("data-ts-select-preexisting-popup");
            el.removeAttribute("data-ts-select-popup");
            el.removeAttribute("data-ts-select-option-tier");
          });
      })
      .catch(() => {});
  }

  private async selectFromCombobox(
    triggerSelector: string,
    optionMatcher?: string,
    page: Page = this.page!,
  ): Promise<string> {
    // 0.8.2-rc.11 — selector normalization. The planner sometimes
    // emits a selector pointing at a `<label for="X">` instead of the
    // associated `<input id="X">` — the label has the visible text
    // ("Project") so the inventory ranking surfaces it as the target.
    // Clicking a label is NOT equivalent to clicking the input for
    // react-select: the synthetic focus DOES move to the input via
    // the `for` association, but no mouse-down lands on the
    // react-select control, so the menu never opens. Resolve the
    // label to its associated input here so downstream tiers (the
    // keyboard fallback in particular) actually see an input target.
    const normalizedSelector = await this.resolveLabelToInput(triggerSelector, page);
    await this.markComboboxPreexistingElements(page);
    try {
      if (page === this.page) await this.humanClick(normalizedSelector);
      else await page.locator(normalizedSelector).first().click({ timeout: 8000 });
      await this.refreshComboboxMarkers(normalizedSelector, page);
      let popup = page.locator('[data-ts-select-popup="1"]').first();
      if ((await popup.count()) === 0) {
        await this.openComboboxWithKeyboard(normalizedSelector, page);
        await this.refreshComboboxMarkers(normalizedSelector, page);
        popup = page.locator('[data-ts-select-popup="1"]').first();
      }
      if ((await popup.count()) === 0) {
        throw new Error(`combobox ${triggerSelector}: no single opened popup could be resolved`);
      }
      const options = page.locator("[data-ts-select-option-tier]");
      let target = options.first();
      if (optionMatcher !== undefined) {
        // Same contract as the native <select> path: an EXACT option text
        // wins, a substring fallback is taken only when it is UNIQUE, and
        // ambiguity refuses loudly. Playwright's `hasText` substring +
        // `.first()` silently committed the wrong option on a collision
        // (measured live: "Vue" committed "Vue.js").
        const matched = await options.evaluateAll((els, needle) => {
          const text = (el: Element): string =>
            ((el as HTMLElement).innerText ?? "").replace(/\s+/g, " ").trim().toLowerCase();
          const exact = els.findIndex((el) => text(el) === needle);
          if (exact !== -1) return { index: exact };
          const partial = els
            .map((el, index) => ({ index, text: text(el) }))
            .filter((o) => o.text.includes(needle));
          const only = partial[0];
          if (partial.length === 1 && only !== undefined) return { index: only.index };
          if (partial.length > 1) {
            return {
              ambiguous: partial
                .slice(0, 6)
                .map((o) => ((els[o.index] as HTMLElement).innerText ?? "").trim()),
            };
          }
          return null;
        }, optionMatcher.replace(/\s+/g, " ").trim().toLowerCase());
        if (matched === null) {
          throw new Error(
            `combobox ${triggerSelector}: no option matched ${JSON.stringify(optionMatcher)}`,
          );
        }
        if ("ambiguous" in matched) {
          throw new Error(
            `combobox ${triggerSelector}: ${JSON.stringify(optionMatcher)} matches several options ` +
              `(${matched.ambiguous.map((t) => JSON.stringify(t)).join(", ")}) — ` +
              "pass the exact option text",
          );
        }
        target = options.nth(matched.index);
      } else if ((await options.count()) === 0) {
        throw new Error(`combobox ${triggerSelector}: opened popup has no actionable options`);
      }
      const committedText = (await target.innerText()).replace(/\s+/g, " ").trim();
      await this.clickComboboxOption(target, page);
      return committedText;
    } finally {
      await this.clearComboboxMarkers(page);
    }
  }

  // 0.8.2-rc.11 — resolve a `<label for="X">` selector to `#X` so the
  // executor lands on the actual input rather than the label decoration.
  // The planner-emitted inventory line for Sentry's permission grid
  // sometimes targets the label (the visible text is "Project", which
  // lives on the <label>, not the <input>); a click on a label only
  // synthetically focuses its `for` target, which is insufficient to
  // open a react-select menu. Returns the original selector unchanged
  // when the resolution doesn't apply (target isn't a label, has no
  // `for`, or the `for`-id doesn't resolve to an input).
  private async resolveLabelToInput(selector: string, page: Page = this.page!): Promise<string> {
    try {
      const resolvedId = await page
        .locator(selector)
        .first()
        .evaluate((node) => {
          if (!(node instanceof HTMLLabelElement)) return null;
          const forAttr = node.htmlFor;
          if (forAttr.length === 0) return null;
          const target = node.ownerDocument.getElementById(forAttr);
          if (target === null) return null;
          // Only redirect when the target is input/textarea/select. A
          // label pointing at a non-form element (rare; React Aria
          // does it for a labelled-by relationship) shouldn't trigger
          // the redirect.
          const tag = target.tagName.toLowerCase();
          if (tag !== "input" && tag !== "textarea" && tag !== "select") {
            return null;
          }
          return forAttr;
        });
      if (resolvedId === null) return selector;
      // CSS-escape the id so unusual characters (Sentry's `--` separator
      // is fine, but the helper is defensive against future ids that
      // include `.`, spaces, …) don't break the locator.
      const escaped =
        typeof (globalThis as { CSS?: { escape?: (s: string) => string } }).CSS?.escape ===
        "function"
          ? (globalThis as { CSS: { escape: (s: string) => string } }).CSS.escape(resolvedId)
          : resolvedId.replace(/([!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, "\\$1");
      return `#${escaped}`;
    } catch {
      return selector;
    }
  }

  private async openComboboxWithKeyboard(
    triggerSelector: string,
    page: Page = this.page!,
  ): Promise<void> {
    const trigger = page.locator(triggerSelector).first();
    try {
      if ((await trigger.evaluate((node) => node.tagName.toLowerCase())) !== "input") return;
      await trigger.focus({ timeout: 1500 });
      await page.keyboard.press("Alt+ArrowDown");
      await this.wait(0.4);
    } catch {
      return;
    }
  }

  private async clickComboboxOption(target: Locator, page: Page = this.page!): Promise<void> {
    // cmdk (the command-menu library) does NOT commit a selection from the
    // bot's humanized page.mouse.click(x, y): cmdk re-renders + re-orders its
    // list as the search filters, so the cached click coordinates land on the
    // wrong row (or empty space), and cmdk's onSelect — bound to a real
    // pointer/click event ON the item, or Enter on the highlighted item —
    // never fires. The trigger keeps its placeholder and the gated submit
    // stays disabled (MEASURED 2026-06-11: meilisearch's /welcome-informations
    // "reasons" + "SDK" comboboxes looped the whole run). Detect cmdk/Radix
    // option items and commit via a real, re-resolved actionable click (plus a
    // pointer-event sequence as backup) instead of raw mouse coordinates.
    const isCmdkItem = await target
      .evaluate(
        (el) =>
          el.hasAttribute("cmdk-item") ||
          el.closest("[cmdk-root],[cmdk-list],[cmdk-group]") !== null,
      )
      .catch(() => false);
    if (isCmdkItem) {
      await target.scrollIntoViewIfNeeded().catch(() => {});
      // Playwright's locator.click() re-resolves geometry and dispatches the
      // full trusted pointer/mouse sequence at the element's center — what
      // cmdk's onSelect actually listens for.
      await target.click({ timeout: 5000 }).catch(async () => {
        await target.dispatchEvent("pointerdown");
        await target.dispatchEvent("pointerup");
        await target.dispatchEvent("click");
      });
      await this.wait(0.5);
      return;
    }
    if (page === this.page) await this.humanClickLocator(target);
    else await target.click({ timeout: 5000 });
    await this.wait(0.5);
  }

  // ───────────── humanization internals ─────────────

  // Click that mimics a real user: locate element, bezier-path the
  // mouse to it, hover briefly, then click. The mouse position is
  // remembered so successive clicks form a continuous path.
  private async humanClick(selector: string): Promise<void> {
    if (!this.page) throw new Error("Browser not started");
    // A bare selector through a strict-mode locator throws "strict mode
    // violation" before humanClickLocator can even waitFor — and several
    // OAuth widgets (Descope's <descope-button>, seen on Weaviate + Redis
    // Cloud) stamp the SAME generated id on both the wrapping web component
    // and its inner text node, so a single id selector resolves to 2
    // elements. For a click that's harmless: every match is the same visual
    // affordance. Narrow to the first match (Playwright's documented
    // disambiguation for clicks) when the selector isn't already unique.
    const locator = this.page.locator(selector);
    const count = await locator.count().catch(() => 1);
    await this.humanClickLocator(pickClickLocator(locator, count));
  }

  // Locator-based core of humanClick. Taking a Locator (not a selector
  // string) lets a caller hand us a `.nth(i)`-narrowed locator when a
  // selector matched several elements — a bare selector through a
  // strict-mode locator would throw before we could disambiguate.
  private async humanClickLocator(locator: Locator): Promise<void> {
    if (!this.page) throw new Error("Browser not started");
    // 0.8.3-rc.1 — widened from 10s to 20s for SPA-load races. The
    // mixpanel-class signup page (Next.js + heavy auth JS, ~12-15s
    // to first-paint the form) was timing out here even when the
    // submit button DOES eventually mount. Bound stays low enough
    // that a genuinely-missing target still surfaces a clear error
    // within the bot's per-action budget.
    await locator.waitFor({ state: "visible", timeout: 20000 });
    // rc.20 — wait for the target to be ENABLED before issuing the
    // click. humanClick uses page.mouse.click(x, y) which bypasses
    // Playwright's actionability check, so a disabled button receives
    // the mousedown/mouseup events but the browser no-ops them, and
    // the caller sees no error. Symptom: OpenRouter's /sign-up renders
    // Clerk's OAuth buttons with `disabled` + `cl-loading` while Clerk
    // JS is initialising; humanClick fires against the disabled
    // Google button, nothing happens, then auth-state detection
    // misreads "URL unchanged, not on provider" as "OAuth completed"
    // and the run falls apart.
    //
    // Poll for up to 15s for the disabled state to clear. Both the
    // HTML `disabled` attribute AND `aria-disabled="true"` are
    // honored — the latter covers ARIA-styled buttons (Radix, Headless
    // UI) that visually appear interactive but reject input.
    //
    // rc.16 — when the poll times out we now THROW instead of silently
    // proceeding to a no-op click. PostHog's "Create key" submit stays
    // aria-disabled until both an org/project access option AND a
    // scopes preset are set; humanClick previously fired a mouse
    // click at the disabled button (which does nothing), the page
    // didn't change, and the post-verify no-progress detector
    // re-planned generically. The planner kept retrying click on the
    // same button because nothing in its hint named the specific
    // root cause ("button is disabled — find what precondition is
    // missing"). Throwing surfaces the disabled state explicitly to
    // the planner via the executor's existing catch handler, so the
    // next round's reason includes "click failed: target is
    // aria-disabled" and the planner pivots to checking other fields.
    {
      const deadline = Date.now() + 15_000;
      let isDisabled = false;
      while (Date.now() < deadline) {
        isDisabled = await locator
          .first()
          .evaluate((el) => {
            if (el instanceof HTMLButtonElement || el instanceof HTMLInputElement) {
              if (el.disabled) return true;
            }
            const aria = el.getAttribute("aria-disabled");
            return aria === "true" || aria === "";
          })
          .catch(() => false);
        if (!isDisabled) break;
        await this.sleep(150);
      }
      if (isDisabled) {
        // Name the SPECIFIC unfilled required field(s) so the planner fills the
        // right one instead of re-clicking the dead submit. MEASURED 2026-06-11
        // (meilisearch/zilliz: planner clicked a disabled Next 4+ times because
        // the generic hint didn't say WHICH field blocked it). Feedback only.
        const hint = await this.unfilledRequiredHint();
        throw new Error(
          "target is disabled (HTML disabled or aria-disabled=true) after 15s — " +
            "the click would no-op. A required precondition is unmet: an empty " +
            "input, an unselected dropdown, an unchecked agreement checkbox, or " +
            "a missing preset/permission choice. Do NOT retry this click — pick a " +
            "different action that fills the missing field first." +
            hint,
        );
      }
    }
    // Scroll the element into the viewport BEFORE measuring it. A
    // humanized click is a raw page.mouse.click(x, y) at viewport
    // coordinates — boundingBox() of a below-the-fold element returns
    // an off-screen y, and the click then lands on nothing (it was
    // why a Sentry OAuth button below the fold never navigated). The
    // regular .click() path auto-scrolls; the humanized path must too
    // — same fix check() already carries.
    await locator.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
    const box = await locator.boundingBox();
    if (box === null) {
      // Element exists but isn't in the layout (e.g., display:none).
      // Fall back to the regular click which will fail loudly with a
      // useful error.
      await locator.click();
      return;
    }
    // Aim for a random point inside the bounding box (not always the
    // exact center — that's a fingerprintable bot tell).
    const targetX = box.x + rand(box.width * 0.25, box.width * 0.75);
    const targetY = box.y + rand(box.height * 0.25, box.height * 0.75);

    await this.bezierMouseTo(targetX, targetY);
    // Hover hesitation. Real users land on a button and pause briefly
    // before clicking. 80-300ms is short enough not to slow runs much
    // and long enough to register as "non-instant" in scoring JS.
    await this.sleep(rand(80, 300));
    await this.page.mouse.click(targetX, targetY);
    this.mouseX = targetX;
    this.mouseY = targetY;
  }

  // Moves the mouse along a bezier curve from the current position to
  // (x, y). Uses 12-25 intermediate steps with small per-step delays.
  // The curve avoids the dead-straight teleport that Playwright's
  // default move() does.
  async bezierMouseTo(x: number, y: number, page: Page | null = this.page): Promise<void> {
    if (!page) throw new Error("Browser not started");
    const steps = rand(12, 25);
    // Bezier control points: bow the curve slightly perpendicular to
    // the travel direction so it's a recognizable arc, not a straight
    // line. Magnitude scales with distance.
    const dx = x - this.mouseX;
    const dy = y - this.mouseY;
    const distance = Math.sqrt(dx * dx + dy * dy);
    const bowMagnitude = Math.min(distance * 0.2, 80);
    // Perpendicular direction (rotate the (dx, dy) vector 90°), then
    // randomize which side of the line we bow toward.
    const perpX = -dy / (distance || 1);
    const perpY = dx / (distance || 1);
    const sign = Math.random() < 0.5 ? -1 : 1;
    const cx = this.mouseX + dx / 2 + perpX * bowMagnitude * sign;
    const cy = this.mouseY + dy / 2 + perpY * bowMagnitude * sign;

    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      // Quadratic bezier: (1-t)^2 * P0 + 2(1-t)t * P1 + t^2 * P2
      const oneMinusT = 1 - t;
      const px = oneMinusT * oneMinusT * this.mouseX + 2 * oneMinusT * t * cx + t * t * x;
      const py = oneMinusT * oneMinusT * this.mouseY + 2 * oneMinusT * t * cy + t * t * y;
      await page.mouse.move(px, py);
      // 6-18ms per step → ~150-400ms total travel for a typical click.
      await this.sleep(rand(6, 18));
    }
  }

  sleep(ms: number): Promise<void> {
    const signal = currentOperatorRequestSignal();
    if (signal === undefined) return new Promise((resolve) => setTimeout(resolve, ms));
    if (signal.aborted)
      return Promise.reject(signal.reason ?? new Error("operator_request_cancelled"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", aborted);
        resolve();
      }, ms);
      const aborted = (): void => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("operator_request_cancelled"));
      };
      signal.addEventListener("abort", aborted, { once: true });
    });
  }

  async wait(seconds: number): Promise<void> {
    await this.sleep(seconds * 1000);
  }

  async screenshot(): Promise<string> {
    if (!this.page) throw new Error("Browser not started");
    // PERF: JPEG quality=70 yields ~250-400KB vs PNG's 1-3MB, with
    // no loss of legibility for the planner (Claude reads button
    // labels, not pixel detail). Smaller upload + faster Claude
    // tokenization saves ~300-500ms per planner round, and there
    // are 8-15 rounds per signup.
    const buffer = await this.page.screenshot({
      fullPage: false,
      type: "jpeg",
      quality: 70,
      timeout: 8_000,
    });
    return buffer.toString("base64");
  }

  // Resolve a caller-supplied frame reference to a live Frame, or null for
  // "the whole page" (no frame args given). Throws when a reference was
  // given but nothing matches — a silent fallback to the full page would
  // make operate_screenshot's frame targeting unreliable for exactly the
  // case it exists for (an unpredictable ACS/challenge iframe).
  private resolveOperatorScreenshotFrame(
    opts: {
      frameIndex?: number;
      frameUrlContains?: string;
    },
    page: Page | null = this.page,
  ): Frame | null {
    if (!page) throw new Error("Browser not started");
    if (opts.frameIndex !== undefined) {
      const frame = page.frames()[opts.frameIndex];
      if (frame === undefined) throw new Error("screenshot_frame_not_found");
      return frame;
    }
    if (opts.frameUrlContains !== undefined) {
      const needle = opts.frameUrlContains.toLowerCase();
      const frame = page.frames().find((f) => f.url().toLowerCase().includes(needle));
      if (frame === undefined) throw new Error("screenshot_frame_not_found");
      return frame;
    }
    return null;
  }

  private async cardMaskPixelRects(page: Page): Promise<PixelMaskRect[]> {
    if (!this.cardValueOutputMask.active) return [];
    const needles = this.cardValueOutputMask.screenshotNeedles();
    const rects: PixelMaskRect[] = [];
    for (const frame of page.frames()) {
      if (frame.isDetached()) continue;
      let offset = { x: 0, y: 0 };
      if (frame !== page.mainFrame()) {
        const frameElement = await frame.frameElement().catch((error: unknown) => {
          if (frame.isDetached()) return null;
          throw new Error("card_mask_frame_unavailable", { cause: error });
        });
        if (frameElement === null) continue;
        try {
          const box = await frameElement.boundingBox();
          if (box === null) throw new Error("card_mask_frame_not_visible");
          offset = { x: box.x, y: box.y };
        } finally {
          await frameElement.dispose().catch(() => undefined);
        }
      }
      const local = await frame
        .evaluate(
          ({ pans, cvvs, cvvNameSource, targets }) => {
            const found: Array<{ x: number; y: number; width: number; height: number }> = [];
            const roots: Array<Document | ShadowRoot> = [document];
            const nativeShadowRoot = Object.getOwnPropertyDescriptor(
              Element.prototype,
              "shadowRoot",
            )?.get;
            for (let index = 0; index < roots.length; index += 1) {
              for (const element of Array.from(roots[index]!.querySelectorAll("*"))) {
                const shadow = nativeShadowRoot?.call(element) as ShadowRoot | null | undefined;
                if (shadow !== null && shadow !== undefined) roots.push(shadow);
              }
            }
            const pushControlValue = (element: Element): void => {
              const box = element.getBoundingClientRect();
              if (box.width <= 0 || box.height <= 0) return;
              const insetX = Math.min(8, box.width * 0.08);
              const insetY = Math.min(6, box.height * 0.2);
              found.push({
                x: box.x + insetX,
                y: box.y + insetY,
                width: Math.max(1, box.width - insetX * 2),
                height: Math.max(1, box.height - insetY * 2),
              });
            };
            const cvvLabel = new RegExp(cvvNameSource, "i");
            const panSeparator = String.raw`[\s.\u00b7\u2010-\u2015-]*`;
            for (const root of roots) {
              root
                .querySelectorAll('[data-ts-card-mask="pan"],[data-ts-card-mask="cvv"]')
                .forEach(pushControlValue);
              for (const target of targets) {
                try {
                  root.querySelectorAll(target.selector).forEach(pushControlValue);
                } catch {
                  // A stale or browser-specific selector is an ordinary miss.
                }
              }
              root.querySelectorAll("input,textarea").forEach((element) => {
                const digits = (
                  (element as HTMLInputElement | HTMLTextAreaElement).value ?? ""
                ).replace(/\D/g, "");
                if (
                  cvvs.includes(digits) ||
                  pans.some(
                    (pan) => digits === pan || (digits.length >= 8 && pan.startsWith(digits)),
                  )
                ) {
                  pushControlValue(element);
                }
              });
              const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
              let current: Node | null;
              while ((current = walker.nextNode()) !== null) {
                const value = current.nodeValue ?? "";
                const patterns = pans.map((pan) => {
                  const prefixes = Array.from({ length: pan.length - 7 }, (_, index) =>
                    [...pan.slice(0, pan.length - index)].join(panSeparator),
                  );
                  return new RegExp(`(?<!\\d)(?:${prefixes.join("|")})(?!${panSeparator}\\d)`, "g");
                });
                let labelledCvvCopy = false;
                let ancestor = current.parentElement;
                for (let depth = 0; ancestor !== null && depth < 3; depth += 1) {
                  const ancestorText = ancestor.textContent ?? "";
                  if (ancestorText.length <= 160 && cvvLabel.test(ancestorText)) {
                    labelledCvvCopy = true;
                    break;
                  }
                  ancestor = ancestor.parentElement;
                }
                if (labelledCvvCopy) {
                  for (const cvv of cvvs) patterns.push(new RegExp(`(?<!\\d)${cvv}(?!\\d)`, "g"));
                }
                for (const pattern of patterns) {
                  for (const match of value.matchAll(pattern)) {
                    if (match.index === undefined) continue;
                    const range = document.createRange();
                    range.setStart(current, match.index);
                    range.setEnd(current, match.index + match[0].length);
                    for (const box of Array.from(range.getClientRects())) {
                      if (box.width > 0 && box.height > 0) {
                        found.push({ x: box.x, y: box.y, width: box.width, height: box.height });
                      }
                    }
                  }
                }
              }
            }
            return found;
          },
          {
            ...needles,
            targets: this.cardValueOutputMask.screenshotTargets(
              frame === page.mainFrame() ? null : this.framePath(frame),
            ),
          },
        )
        .catch((error: unknown) => {
          if (frame.isDetached()) return [];
          throw new Error("card_mask_frame_scan_failed", { cause: error });
        });
      for (const rect of local) {
        rects.push({ ...rect, x: rect.x + offset.x, y: rect.y + offset.y });
      }
    }
    return rects;
  }

  // Read-only pixel capture for operate_screenshot. Once card output masking is
  // active, compositing changes only the returned image bytes, never the page.
  async captureOperatorScreenshot(
    opts: {
      frameIndex?: number;
      frameUrlContains?: string;
      fullPage?: boolean;
    } = {},
    page: Page | null = this.page,
  ): Promise<{
    base64: string;
    mimeType: "image/jpeg" | "image/png";
    frameUrl: string | null;
    frameCount: number;
    clickBinding?: ScreenshotBinding;
  }> {
    return await this.screenshotForOperator(opts, page);
  }

  async screenshotForOperator(
    opts: {
      frameIndex?: number;
      frameUrlContains?: string;
      fullPage?: boolean;
    } = {},
    page: Page | null = this.page,
  ): Promise<{
    base64: string;
    mimeType: "image/jpeg" | "image/png";
    frameUrl: string | null;
    frameCount: number;
    clickBinding?: ScreenshotBinding;
  }> {
    if (!page) throw new Error("Browser not started");
    const targetFrame = this.resolveOperatorScreenshotFrame(opts, page);
    const maskRectsBefore = await this.cardMaskPixelRects(page);
    const cdp = await page.context().newCDPSession(page);
    try {
      // caret:"initial" is not needed here — the CDP capture never runs
      // Playwright's caret-hiding pass, so element styles stay untouched.
      const frameOrigin = (frame: Frame) => this.frameOrigin(frame);
      const captured = await captureBoundScreenshot(page, frameOrigin, async () => {
        let base64: string;
        const metrics = await cdp.send("Page.getLayoutMetrics");
        const viewport = metrics.cssVisualViewport;
        let rect = {
          x: viewport.pageX,
          y: viewport.pageY,
          width: viewport.clientWidth,
          height: viewport.clientHeight,
        };
        if (targetFrame !== null && targetFrame !== page.mainFrame()) {
          const handle = await targetFrame.frameElement();
          try {
            const box = await handle.boundingBox();
            if (box === null) throw new Error("screenshot_frame_not_visible");
            const scroll = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
            rect = {
              x: box.x + scroll.x,
              y: box.y + scroll.y,
              width: box.width,
              height: box.height,
            };
            const result = await cdp.send("Page.captureScreenshot", {
              format: this.cardValueOutputMask.active ? "png" : "jpeg",
              ...(this.cardValueOutputMask.active ? {} : { quality: 80 }),
              fromSurface: true,
              captureBeyondViewport: true,
              clip: {
                x: box.x + scroll.x,
                y: box.y + scroll.y,
                width: box.width,
                height: box.height,
                scale: 1,
              },
            });
            base64 = result.data;
          } finally {
            await handle.dispose().catch(() => undefined);
          }
        } else if (opts.fullPage === true) {
          const size = await page.evaluate(() => ({
            width: document.documentElement.scrollWidth,
            height: document.documentElement.scrollHeight,
          }));
          rect = { x: 0, y: 0, width: size.width, height: size.height };
          const result = await cdp.send("Page.captureScreenshot", {
            format: this.cardValueOutputMask.active ? "png" : "jpeg",
            ...(this.cardValueOutputMask.active ? {} : { quality: 80 }),
            fromSurface: true,
            captureBeyondViewport: true,
            clip: { x: 0, y: 0, width: size.width, height: size.height, scale: 1 },
          });
          base64 = result.data;
        } else {
          const result = await cdp.send("Page.captureScreenshot", {
            format: this.cardValueOutputMask.active ? "png" : "jpeg",
            ...(this.cardValueOutputMask.active ? {} : { quality: 80 }),
            fromSurface: true,
          });
          base64 = result.data;
        }
        return { base64, rect };
      });
      const maskRectsAfter = await this.cardMaskPixelRects(page);
      let output = captured.base64;
      if (this.cardValueOutputMask.active) {
        const scroll = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
        const targetBox =
          targetFrame !== null && targetFrame !== page.mainFrame()
            ? await targetFrame.frameElement().then(async (handle) => {
                try {
                  const box = await handle.boundingBox();
                  if (box === null) throw new Error("card_mask_frame_not_visible");
                  return box;
                } finally {
                  await handle.dispose().catch(() => undefined);
                }
              })
            : null;
        const translated = [...maskRectsBefore, ...maskRectsAfter].map((rect) => ({
          ...rect,
          x:
            targetBox !== null
              ? rect.x - targetBox.x
              : opts.fullPage === true
                ? rect.x + scroll.x
                : rect.x,
          y:
            targetBox !== null
              ? rect.y - targetBox.y
              : opts.fullPage === true
                ? rect.y + scroll.y
                : rect.y,
        }));
        output = await compositePngCardMasks(output, translated);
      }
      this.operatorEvidence.recordScreenshot({
        url: page.url(),
        frame_url: targetFrame?.url() ?? null,
        full_page: opts.fullPage === true,
      });
      return {
        ...captured,
        base64: output,
        mimeType: this.cardValueOutputMask.active ? "image/png" : "image/jpeg",
        frameUrl: targetFrame?.url() ?? null,
        frameCount: page.frames().length,
      };
    } finally {
      await cdp.detach().catch(() => undefined);
    }
  }

  async getState(page: Page | null = this.page): Promise<BrowserState> {
    if (!page) throw new Error("Browser not started");
    // page.content() / page.title() / screenshot() all throw
    // "Execution context was destroyed" when the page is mid-
    // navigation — common after an OAuth-button click that kicks off
    // a 3-5 hop redirect chain (sentry.io → accounts.google.com →
    // consent → callback → onboarding). Retry once after a short
    // settle: most navigations finish in <500ms even on slow links.
    try {
      return await this.snapshotState(page);
    } catch {
      await this.wait(0.8);
      return await this.snapshotState(page);
    }
  }

  private async snapshotState(page: Page | null = this.page): Promise<BrowserState> {
    if (!page) throw new Error("Browser not started");
    return {
      url: page.url(),
      title: await page.title(),
      html: await page.content(),
      screenshot: await page
        .screenshot({ fullPage: false, type: "jpeg", quality: 70, timeout: 8_000 })
        .then((shot) => shot.toString("base64"))
        .catch(() => ""),
    };
  }

  async extractText(): Promise<string> {
    if (!this.page) throw new Error("Browser not started");
    return (await this.page.textContent("body")) || "";
  }

  // RENDERED, visibility-respecting body text. extractText() reads
  // textContent("body"), which includes display:none / visibility:hidden /
  // off-screen nodes — so a fully-rendered dashboard whose DOM merely
  // CONTAINS a hidden skeleton / "Loading…" / "Please wait 30 seconds…"
  // string (Next.js RSC inline payloads, lazy placeholders, aria-hidden
  // spinners) reads as still-loading and false-trips the loading-shell gate.
  // innerText is layout-aware: it omits hidden text and reflects what a user
  // would actually see. Use this for the SHELL decision ONLY — credential/key
  // extraction and wall-text checks deliberately read RAW text via
  // extractText() and must stay byte-identical, so this is purely additive.
  async extractVisibleText(page: Page | null = this.page): Promise<string> {
    if (page === null) throw new Error("Browser not started");
    return this.cardValueOutputMask.maskText(await page.evaluate(extractObservationVisibleText));
  }

  /**
   * RAW link candidates for mailbox reads: every anchor's href attribute read
   * VERBATIM — full length, no truncation — together with its visible text.
   * The interactive-element inventory caps hrefs at 300 characters and drops
   * invisible anchors, which silently mangles long verification links
   * (Cal.com gauntlet 2026-09-16: the signed token exceeded the cap, the
   * reconstructed URL failed with "No token found"). The mailbox read must
   * score links from this faithful read, not from the size-capped inventory.
   */
  async extractRawMailLinks(
    page: Page | null = this.page,
  ): Promise<Array<{ href: string; visibleText: string | null }>> {
    if (page === null) throw new Error("Browser not started");
    const raw = await page.evaluate(() => {
      const anchors: HTMLAnchorElement[] = [];
      // Main document plus open shadow roots; the mailbox read only needs
      // href-carrying anchors, and getAttribute returns the DECODED attribute
      // value (no &amp;/soft-wrap artifacts) — the actual URL the DOM holds.
      const collect = (root: Document | ShadowRoot): void => {
        root.querySelectorAll("a[href]").forEach((a) => anchors.push(a as HTMLAnchorElement));
        root.querySelectorAll("*").forEach((el) => {
          const sr = Object.getOwnPropertyDescriptor(Element.prototype, "shadowRoot")?.get?.call(
            el,
          );
          if (sr instanceof ShadowRoot) collect(sr);
        });
      };
      collect(document);
      return anchors.map((a) => ({
        href: a.getAttribute("href") ?? "",
        visibleText: (a.textContent ?? "").replace(/\s+/g, " ").trim() || null,
      }));
    });
    return raw.filter((l) => l.href.length > 0).map((l) => this.cardValueOutputMask.maskValue(l));
  }

  /** Canonical tree capture, with the existing whole-document action bindings. */
  async extractBrowserUseObservation(
    page: Page | null = this.page,
    settlePage = false,
  ): Promise<BrowserUseCapture> {
    if (page === null) throw new Error("Browser not started");
    if (settlePage) {
      // A load event alone precedes SPA hydration. Network quiet plus bounded
      // DOM quiet gives pending scripts/frames time to install their controls.
      // Busy analytics/animations must never make observation wait indefinitely.
      await page.waitForLoadState("networkidle", { timeout: 1_500 }).catch(() => undefined);
      await page
        .evaluate(
          () =>
            new Promise<void>((resolve) => {
              let quiet: ReturnType<typeof setTimeout>;
              const finish = () => {
                clearTimeout(quiet);
                clearTimeout(deadline);
                observer.disconnect();
                resolve();
              };
              const observer = new MutationObserver(() => {
                clearTimeout(quiet);
                quiet = setTimeout(finish, 500);
              });
              const deadline = setTimeout(finish, 2_000);
              observer.observe(document, {
                subtree: true,
                childList: true,
                attributes: true,
                characterData: true,
              });
              quiet = setTimeout(finish, 500);
            }),
        )
        .catch(() => undefined);
    }
    const bindingDeadline = Date.now() + 1_000;
    for (;;) {
      const elements = await this.extractInteractiveElements(page);
      const capture = await captureBrowserUseDOM(page, elements, (frame) => this.framePath(frame));
      if (
        !capture.omissions.some((omission) => omission.kind === "frame_binding_failed") ||
        Date.now() >= bindingDeadline
      ) {
        // Persistent omissions remain explicit; every attempt uses fresh trees
        // and bindings, and every returned path retains the card-value mask.
        return this.cardValueOutputMask.maskCapture(capture);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /**
   * Tiny structural source for compact V2. The raw values never leave the
   * provision session: compact-observation-v2 applies its allowlist seal
   * before the result is stored, delta'd, or emitted.
   */
  async extractObservationSemantics(
    page: Page | null = this.page,
  ): Promise<{ title: string; headings: string[] }> {
    if (page === null) throw new Error("Browser not started");
    return await page.evaluate(() => {
      const visible = (element: Element): boolean => {
        const html = element as HTMLElement;
        const style = window.getComputedStyle(html);
        const rect = html.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0
        );
      };
      const headings = Array.from(document.querySelectorAll("h1,h2"))
        .filter(visible)
        .map((element) => (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 160))
        .filter(Boolean)
        .slice(0, 2);
      return { title: document.title.slice(0, 160), headings };
    });
  }

  // Deterministically satisfy required, currently-EMPTY combobox/listbox
  // selectors (cmdk / Radix / Headless UI multi-selects) that gate a disabled
  // submit. The dominant `oauth_onboarding_failed` blocker is a post-OAuth
  // "tell us about yourself" survey whose required multi-selects the greedy
  // planner opens but never commits — it concludes "all filled", clicks the
  // disabled Next, and stalls (MEASURED 2026-06-23, meilisearch
  // /welcome-informations: `[data-cy=...-trigger]` role=combobox → cmdk-list of
  // `[role=option][cmdk-item]`). For each unfilled trigger: open it, click the
  // first non-disabled option (Playwright locator click COMMITS where a raw
  // coordinate click drops — same as the post-verify combobox path), and Escape
  // to close the multi-select popover. Returns the labels it satisfied. Tightly
  // scoped: only acts on placeholder-showing (empty) comboboxes, never a
  // combobox that already holds a value.
  async fillRequiredComboboxes(): Promise<string[]> {
    if (!this.page) throw new Error("Browser not started");
    const page = this.page;
    let triggerSelectors: string[] = [];
    try {
      triggerSelectors = await page.evaluate(() => {
        const isVisible = (el: Element): boolean => {
          const r = (el as HTMLElement).getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        const out: string[] = [];
        const seen = new Set<string>();
        // Candidate trigger elements: an ARIA combobox/listbox-popup, OR a
        // shadcn/Radix `*-trigger` data-cy button. MEASURED 2026-06-23
        // (meilisearch): the clickable trigger carries `data-cy="…-trigger"`
        // but role=combobox lives on a separate inner node with NO data-cy, so
        // a role-only query found an un-addressable element. Collect both and
        // resolve each to its nearest stable data-cy selector.
        const candidates = new Set<Element>();
        for (const e of Array.from(
          document.querySelectorAll(
            "[role='combobox'],[aria-haspopup='listbox'],button[data-cy$='-trigger']",
          ),
        )) {
          candidates.add(e);
        }
        for (const el of Array.from(candidates)) {
          if (!isVisible(el)) continue;
          // Skip text/autocomplete inputs (role=combobox is also set on search
          // multiselects like MongoDB's "data types") — we click-to-pick from a
          // dropdown, never type into a filter box.
          if (el.tagName === "INPUT") continue;
          const txt = (el.textContent ?? "").replace(/\s+/g, " ").trim();
          // Unfilled signals: (1) Radix sets `data-placeholder` on a SelectTrigger
          // until a value is committed — present even when the trigger PREVIEWS
          // the first option (meilisearch's role/referral show "Founder/CTO" /
          // "Open Source" but stay uncommitted, so Next stays disabled); (2) empty
          // text; (3) a clear "Select…/Choose…/Pick…" placeholder. NOT
          // "search"/"add"/"type" — those are filter inputs we must not auto-pick.
          const hasPlaceholderAttr =
            el.hasAttribute("data-placeholder") || el.querySelector("[data-placeholder]") !== null;
          const placeholderish =
            hasPlaceholderAttr ||
            txt.length === 0 ||
            /^(?:please\s+)?(?:select|choose|pick)\b/i.test(txt);
          if (!placeholderish) continue;
          // Resolve a stable data-cy selector — own, or nearest ancestor — so
          // the locator click can't drift after the portal re-renders.
          const dcEl = el.getAttribute("data-cy") !== null ? el : el.closest("[data-cy]");
          const dc = dcEl !== null ? dcEl.getAttribute("data-cy") : null;
          const sel = dc !== null && dc.length > 0 ? `[data-cy="${dc}"]` : null;
          if (sel === null || seen.has(sel)) continue;
          seen.add(sel);
          out.push(sel);
        }
        // LeafyGreen (MongoDB Atlas) path. Its select triggers are
        // `<button data-lgid="lg-button">Select</button>` with NO data-cy and NO
        // data-placeholder — the placeholder is the literal text "Select".
        // Address each by its index among lg-buttons (Playwright `>> nth=`),
        // since there's no stable per-trigger attribute. MEASURED 2026-06-23
        // (mongodb-atlas /atlas onboarding personalization wizard).
        const lgButtons = Array.from(document.querySelectorAll("button[data-lgid='lg-button']"));
        for (let i = 0; i < lgButtons.length; i++) {
          const el = lgButtons[i];
          if (el === undefined || !isVisible(el)) continue;
          const txt = (el.textContent ?? "").replace(/\s+/g, " ").trim();
          if (!/^(?:please\s+)?(?:select|choose|pick)\b/i.test(txt)) continue;
          const sel = `button[data-lgid="lg-button"] >> nth=${i}`;
          if (seen.has(sel)) continue;
          seen.add(sel);
          out.push(sel);
        }
        // Autocomplete-list combobox INPUTS that are part of the survey and
        // still EMPTY (mongodb's required "data types" multiselect). These are
        // distinct from free-text search boxes: `aria-autocomplete=list/both`
        // means a fixed option list, and an empty value means unfilled. Click +
        // pick-first via the same option locator. Addressed by index.
        const acInputs = Array.from(
          document.querySelectorAll("input[role='combobox'][aria-autocomplete]"),
        );
        for (let i = 0; i < acInputs.length; i++) {
          const el = acInputs[i] as HTMLInputElement | undefined;
          if (el === undefined || !isVisible(el)) continue;
          if ((el.value ?? "").trim().length > 0) continue;
          const sel = `input[role='combobox'][aria-autocomplete] >> nth=${i}`;
          if (seen.has(sel)) continue;
          seen.add(sel);
          out.push(sel);
        }
        return out.slice(0, 8);
      });
    } catch {
      return [];
    }
    const filled: string[] = [];
    for (const sel of triggerSelectors) {
      try {
        const trigger = page.locator(sel).first();
        if ((await trigger.count().catch(() => 0)) === 0) continue;
        await trigger.click({ timeout: 5000 });
        await page.waitForTimeout(600);
        // An autocomplete input may only render its option list after a
        // keystroke — nudge it with ArrowDown so the option locator can resolve.
        if (sel.includes("input[")) {
          await page.keyboard.press("ArrowDown").catch(() => undefined);
          await page.waitForTimeout(400);
        }
        const option = page
          .locator(
            "[role='option']:not([aria-disabled='true']):not([data-disabled='true'])," +
              "[cmdk-item]:not([aria-disabled='true']):not([data-disabled='true'])," +
              "[data-lgid='lg-option']:not([aria-disabled='true'])",
          )
          .first();
        if ((await option.count().catch(() => 0)) > 0) {
          const name = ((await option.textContent().catch(() => "")) ?? "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 40);
          await option.click({ timeout: 5000 });
          filled.push(`${sel} → ${name}`);
          await page.waitForTimeout(300);
        }
        // Close the (multi-select) popover so the next trigger isn't occluded.
        await page.keyboard.press("Escape").catch(() => undefined);
        await page.waitForTimeout(200);
      } catch {
        // Best-effort per combobox — a miss falls back to the planner.
      }
    }
    return filled;
  }

  // True when a visible advance/submit button (Next / Continue / Create /
  // Register / Submit / Get started / Finish) is currently DISABLED. The gate
  // for the deterministic combobox filler: only auto-satisfy a survey's
  // required selects when something is actually blocking forward progress.
  async hasDisabledSubmit(): Promise<boolean> {
    if (!this.page) return false;
    try {
      return await this.page.evaluate(() => {
        const re =
          /\b(?:next|continue|register|submit|get started|finish|complete|done|create account|sign up|create key|create token|create personal)\b/i;
        for (const el of Array.from(document.querySelectorAll("button,[role='button']"))) {
          const r = (el as HTMLElement).getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) continue;
          const disabled =
            (el as HTMLButtonElement).disabled === true ||
            el.getAttribute("aria-disabled") === "true" ||
            el.getAttribute("disabled") !== null;
          if (!disabled) continue;
          // A disabled advance/submit button gates the survey. Match by verb
          // text OR by type=submit (meilisearch's button-register is a
          // type=submit whose visible label is icon+text, so a text-only match
          // missed it).
          const txt = (el.textContent ?? "").replace(/\s+/g, " ").trim();
          const isSubmit = (el as HTMLButtonElement).type === "submit";
          if (re.test(txt) || isSubmit) return true;
        }
        return false;
      });
    } catch {
      return false;
    }
  }

  // Discrete strings an API key might occupy — for credential
  // extraction. Gathered so a key is read WHOLE and un-glued from its
  // neighbours: extractText() concatenates the whole <body>, which
  // fuses a key to an adjacent "Copy"/"Done" button with no separator.
  //
  // Two surfaces:
  //   1. input/textarea VALUES — a copy-to-clipboard key field. An
  //      input's value is not in textContent at all. Hidden and
  //      password fields are excluded (captcha tokens / the signup
  //      password), keeping this a clean credential surface.
  //   2. Each element's OWN direct text — the text nodes that are its
  //      immediate children, excluding descendants. A key in a
  //      <code>/<span>/<div> yields its clean value here even when a
  //      sibling button shares the same parent.
  // F10: read the clipboard contents (typically populated by the
  // user-modal's Copy button — every modern API-key reveal modal puts
  // the full secret here while displaying a masked stub). Requires
  // `clipboard-read` permission, granted at context creation. Returns
  // an empty string if the clipboard is empty; throws on permission
  // failure (caller catches and falls through to other paths).
  async readClipboard(page: Page | null = this.page): Promise<string> {
    if (!page) throw new Error("Browser not started");
    // navigator.clipboard.readText() REJECTS ("Document is not focused") unless
    // the page has focus — which a sequence of Playwright actions + page.evaluate
    // reads between the copy-click and here can drop, silently yielding "". Bring
    // the tab to front and focus the document first. MEASURED 2026-06-24
    // (deepinfra: the copy-key clipboard held the 32-char key in a probe but the
    // replay's read came back empty — focus was the difference).
    await page.bringToFront().catch(() => undefined);
    await page.evaluate(() => window.focus()).catch(() => undefined);
    return await page.evaluate(async () => {
      try {
        return await navigator.clipboard.readText();
      } catch {
        return "";
      }
    });
  }

  // F10 fallback: ALL <input> / <textarea> values, ignoring
  // visibility and type filters. extractCredentialCandidates
  // deliberately skips `type=hidden` / `type=password` / invisible
  // elements (correct for general candidate scanning), but some
  // API-key modals stash the full key in a hidden input the masked
  // display reads from — and that needs to be reachable when the
  // visible extraction comes back truncated.
  async extractAllInputValues(page: Page | null = this.page): Promise<string[]> {
    if (!page) throw new Error("Browser not started");
    return await page.evaluate(() => {
      const out: string[] = [];
      document.querySelectorAll("input, textarea").forEach((el) => {
        if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) return;
        const value = el.value;
        if (value.trim().length > 0) out.push(value.trim());
      });
      return out;
    });
  }

  // Last-resort scan: walk innerText looking for credential-shaped
  // tokens (UUIDs and other long alnum+hyphen blobs) inside any DOM
  // subtree that ALSO contains a "Copy" / "Copy token" / "Copy to
  // clipboard" affordance. The Copy-button colocation is what tells
  // us "the UI is presenting this string AS a credential" — without
  // it, we'd false-positive on session IDs in URLs, cache-buster
  // query params, etc. Returns every match it finds; the caller picks
  // the first that survives extractApiKeyFromText.
  async extractCredentialsNearCopyButtons(page: Page | null = this.page): Promise<string[]> {
    if (!page) throw new Error("Browser not started");
    return await page.evaluate(() => {
      const out: string[] = [];
      const isVisible = (el: Element): boolean => {
        const r = el.getBoundingClientRect();
        return r.width > 2 && r.height > 2;
      };
      // Find every Copy- OR reveal-class affordance. A secret table-cell value
      // (deepinfra's keys table) lives in a row next to BOTH a copy and a
      // toggle-visibility/reveal control — but those are often icon buttons
      // whose accessible NAME is the row's date, not "copy". So match the
      // element's id / class / data-testid too, which carry the semantic name
      // ("copy-key", "toggle-token-visibility"). Reveal patterns are scoped to
      // key/token/secret/visibility context so a generic "Show more" doesn't
      // anchor a harvest.
      const copyButtons = Array.from(
        document.querySelectorAll<HTMLElement>('button, [role="button"], a, [aria-label]'),
      ).filter((el) => {
        if (!isVisible(el)) return false;
        const name =
          `${el.textContent ?? ""} ${el.getAttribute("aria-label") ?? ""} ${el.getAttribute("title") ?? ""}`.toLowerCase();
        // el.className is an SVGAnimatedString on SVG elements — read via attr.
        const attrs =
          `${el.id} ${el.getAttribute("class") ?? ""} ${el.getAttribute("data-testid") ?? ""} ${el.getAttribute("data-test") ?? ""}`.toLowerCase();
        const hay = `${name} ${attrs}`;
        return /\bcopy\b|clipboard|reveal|toggle[-_ ]?(?:token|visibility)|show[-_ ]?(?:key|token|secret|api)/.test(
          hay,
        );
      });
      // For each, walk up a few ancestors and dump the subtree's
      // innerText. The token is somewhere in there.
      const seen = new Set<string>();
      const harvest = (text: string): void => {
        if (text.length === 0 || text.length > 4096) return;
        // Tokenize by whitespace — each token is a separate candidate.
        text.split(/\s+/).forEach((tok) => {
          if (tok.length < 16 || tok.length > 256) return;
          if (seen.has(tok)) return;
          seen.add(tok);
          out.push(tok);
        });
      };
      for (const btn of copyButtons) {
        // The value often lives in the copy button's OWN aria-label/title
        // ("Copy to clipboard: GOCSPX-…", "Copy api key sk-…") rather than in
        // any visible text node — GCP's new client-secret reveal does exactly
        // this, so the innerText-only walk below would miss it entirely.
        harvest(
          `${btn.getAttribute("aria-label") ?? ""} ${btn.getAttribute("title") ?? ""}`.trim(),
        );
        // Then walk up a few ancestors and dump the subtree's innerText.
        let anc: HTMLElement | null = btn;
        for (let i = 0; i < 6 && anc !== null; i++) {
          anc = anc.parentElement;
        }
        if (anc === null) continue;
        harvest((anc.innerText ?? "").trim());
      }
      return out;
    });
  }

  // DOM-proximity labeled credential candidates. Walks every visible
  // input/code/text element looking for credential-shape strings,
  // pairs each one with its nearest credential-label text in the DOM
  // tree, and returns the labeled tuples for the multi-cred extractor
  // to fold into the credentials Record.
  //
  // Complements the Phase E planner-quoted extractor — when the
  // planner's prose doesn't explicitly label values (multi-cred page
  // where the planner missed one), this DOM-grounded pass picks them
  // up via the visible labels the page itself renders.
  //
  // Returns shape:
  //   { value: "<credential-shape string>",
  //     label: "<the closest matching label text>" | null,
  //     isMasked: true if the value looks like a redacted display
  //               (••••, ****, contains "•" or runs of "*") }
  //
  // The caller maps label
  // text to canonical credential keys using the same vocabulary the
  // Phase E parser uses.
  async extractLabeledCredentialCandidates(page: Page | null = this.page): Promise<
    Array<{
      value: string;
      label: string | null;
      isMasked: boolean;
      hasRevealButton: boolean;
    }>
  > {
    if (!page) throw new Error("Browser not started");
    return await page.evaluate(() => {
      const LABEL_PHRASES = [
        // Generic
        "api key",
        "api token",
        "api secret",
        "secret key",
        "access key",
        "access token",
        "auth token",
        "bearer token",
        "personal access token",
        "client id",
        "client secret",
        "team id",
        "project id",
        "client key",
        // Cloudinary
        "cloud name",
        "cloudname",
        // Algolia
        "application id",
        "app id",
        "admin api key",
        "search api key",
        "monitoring api key",
        "search-only api key",
        // Twilio
        "account sid",
        "auth token",
        // Stripe
        "publishable key",
        "secret key",
        // AWS
        "access key id",
        "secret access key",
        // OAuth1
        "consumer key",
        "consumer secret",
        "access token secret",
        // Misc
        "project api key",
        "personal api key",
        "organization id",
        "org id",
        "app key",
        "app secret",
        // Pusher (and other keys tables) label fields bare: key / secret /
        // cluster. Without these the value inherits the nearest recognized
        // label (the app_id field), mislabeling key + secret as "app id".
        "cluster",
        "key",
        "secret",
      ];

      const isVisible = (el: Element): boolean => {
        const r = el.getBoundingClientRect();
        return r.width > 2 && r.height > 2;
      };
      const isCredentialShape = (s: string): boolean => {
        // Reasonable credential length range
        if (s.length < 6 || s.length > 256) return false;
        // Reject pure prose (spaces inside)
        if (/\s/.test(s)) return false;
        // Must include some entropy markers: digit + letter combo OR
        // a credential prefix like sk_/pk_/api_/ etc.
        const hasDigit = /\d/.test(s);
        const hasLetter = /[A-Za-z]/.test(s);
        if (!hasDigit && !hasLetter) return false;
        // Reject pure URL fragments
        if (/^https?:\/\//i.test(s)) return false;
        // Reject simple words / capitalized phrases
        if (/^[A-Za-z]+$/.test(s) && s.length < 12) return false;
        // Reject label-text masquerading as a value: a short token of only
        // letters + separators with NO digit (e.g. the literal "app_id" /
        // "secret" label text pusher renders next to the real value). Real
        // credentials carry a digit or are long; field labels don't.
        if (!hasDigit && /^[a-z][a-z_-]*$/i.test(s) && s.length < 16) return false;
        return true;
      };
      // Inline mirror of credential-shape.ts MASKED_DISPLAY_RE — page.evaluate
      // code can't import, so keep this regex byte-identical to the canonical.
      // Any mask glyph: bullet/circle, 3+ asterisks, ellipsis, or 3+ dots. (Was
      // `[•●⬤]{3,}|\*{4,}`, which MISSED the ellipsis masks GCP/Zilliz/S3 use.)
      const isMaskedShape = (s: string): boolean => /[•●⬤]|\*{3,}|…|\.{3,}/.test(s);

      // Compute element-center coords for proximity matching.
      const centerOf = (el: Element): { x: number; y: number } => {
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      };

      // Collect every visible label-text bounding box on the page.
      // Each label entry = { phrase, x, y }. We pre-compute these so
      // the per-candidate inner loop is O(L) not O(L * N).
      type LabelHit = { phrase: string; x: number; y: number; el: Element };
      const labelHits: LabelHit[] = [];
      document.querySelectorAll("body *").forEach((el) => {
        if (el.tagName === "SCRIPT" || el.tagName === "STYLE") return;
        if (!isVisible(el)) return;
        // Only consider DIRECT text content — child element text gets
        // claimed by THOSE elements' own label scans.
        let direct = "";
        el.childNodes.forEach((n) => {
          if (n.nodeType === Node.TEXT_NODE) direct += n.textContent ?? "";
        });
        direct = direct.trim().toLowerCase();
        if (direct.length === 0 || direct.length > 100) return;
        // Normalize separators so underscore/hyphen field labels match the
        // space-form phrases: pusher renders "app_id" / "app_key" / "app_secret"
        // and "app_id".includes("app id") is false, so every value used to
        // inherit a far "App keys" heading. With this, each field label matches
        // its own phrase and wins the proximity match.
        const directNorm = direct.replace(/[_-]+/g, " ");
        for (const phrase of LABEL_PHRASES) {
          if (directNorm.includes(phrase)) {
            const c = centerOf(el);
            labelHits.push({ phrase, x: c.x, y: c.y, el });
            break; // one label per element is enough
          }
        }
      });

      // Detect reveal buttons (eye / show / unmask icons) — any visible
      // button or [role=button] / svg whose aria-label / title / text
      // matches the reveal vocabulary. We only check WHETHER one exists
      // near a candidate; the clicker (revealMaskedCredentials below)
      // does the actual click pass.
      const REVEAL_PATTERN = /\b(?:reveal|show|unmask|view|toggle|copy)\b/i;
      const revealButtons: Array<{ x: number; y: number; el: Element }> = [];
      document
        .querySelectorAll<HTMLElement>('button, [role="button"], a, [aria-label], [title]')
        .forEach((el) => {
          if (!isVisible(el)) return;
          const hay = `${el.textContent ?? ""} ${el.getAttribute("aria-label") ?? ""} ${el.getAttribute("title") ?? ""}`;
          if (!REVEAL_PATTERN.test(hay)) return;
          const c = centerOf(el);
          revealButtons.push({ x: c.x, y: c.y, el });
        });

      // For each candidate, find nearest label by Euclidean distance.
      const findNearestLabel = (x: number, y: number): string | null => {
        let best: { phrase: string; d: number } | null = null;
        for (const lh of labelHits) {
          const dx = lh.x - x;
          const dy = lh.y - y;
          const d = Math.sqrt(dx * dx + dy * dy);
          // Conservative cap — labels more than 400px away from the
          // value aren't visually grouped with it. Roughly: a typical
          // table-row width.
          if (d > 400) continue;
          if (best === null || d < best.d) best = { phrase: lh.phrase, d };
        }
        return best?.phrase ?? null;
      };
      const hasNearbyReveal = (x: number, y: number): boolean => {
        for (const rb of revealButtons) {
          const dx = rb.x - x;
          const dy = rb.y - y;
          // Reveal/copy buttons are usually right next to the value —
          // 200px is generous.
          if (Math.sqrt(dx * dx + dy * dy) < 200) return true;
        }
        return false;
      };

      const seen = new Set<string>();
      const out: Array<{
        value: string;
        label: string | null;
        isMasked: boolean;
        hasRevealButton: boolean;
      }> = [];
      const pushCandidate = (value: string, el: Element): void => {
        const trimmed = value.trim();
        if (trimmed.length === 0) return;
        const masked = isMaskedShape(trimmed);
        if (!masked && !isCredentialShape(trimmed)) {
          // 0.8.2-rc.17 — when the whole text-node string has
          // whitespace (Cloudinary's "Cloud name: dlq4xgrca" sits
          // in a SINGLE <div> with the label and value glued
          // together), isCredentialShape rejects the whole string.
          // Try to split on the canonical label-value separator
          // patterns ("Label: value", "Label = value", "Label\nvalue")
          // and re-evaluate each side. The token side gets the
          // candidate slot; the label side already lives on its own
          // (we don't need to push it). First-wins on duplicates.
          const split = /^([A-Za-z][A-Za-z _-]{1,40}?)\s*[:=]\s*([A-Za-z0-9._\-]{4,256})$/.exec(
            trimmed,
          );
          if (split === null) return;
          const valueToken = split[2];
          if (valueToken === undefined) return;
          if (!isCredentialShape(valueToken)) return;
          if (seen.has(valueToken)) return;
          seen.add(valueToken);
          const c = centerOf(el);
          const label = findNearestLabel(c.x, c.y);
          out.push({
            value: valueToken,
            label,
            isMasked: false,
            hasRevealButton: false,
          });
          return;
        }
        if (seen.has(trimmed)) return;
        seen.add(trimmed);
        const c = centerOf(el);
        const label = findNearestLabel(c.x, c.y);
        const hasReveal = masked ? hasNearbyReveal(c.x, c.y) : false;
        out.push({
          value: trimmed,
          label,
          isMasked: masked,
          hasRevealButton: hasReveal,
        });
      };

      // 0. Inline config snippets: a credential block listing multiple
      //    label = "value" pairs in one text run (pusher's App Keys page:
      //    app_id = "2164307" key = "..." secret = "..." cluster = "ap3").
      //    No separate label ELEMENTS exist, so the proximity matcher mislabels
      //    every value with whatever heading is nearest. Parse the label-value
      //    pairs straight from the page text — each pair's own label is
      //    authoritative. Runs FIRST so its correctly-labeled candidates win
      //    the `seen` dedup over the proximity passes. Noise pairs are harmless:
      //    a skill only matches the labels it asks for.
      const bodyText = document.body?.innerText ?? "";
      const INLINE_PAIR =
        /\b([A-Za-z][A-Za-z0-9_-]{1,40})\s*[:=]\s*["']?([A-Za-z0-9._-]{6,256})["']?/g;
      for (const m of bodyText.matchAll(INLINE_PAIR)) {
        const label = (m[1] ?? "").toLowerCase();
        const value = m[2] ?? "";
        if (!isCredentialShape(value)) continue;
        if (seen.has(value)) continue;
        seen.add(value);
        out.push({ value, label, isMasked: false, hasRevealButton: false });
      }

      // 1. <input> / <textarea> values (visible only).
      document.querySelectorAll("input, textarea").forEach((el) => {
        if (el instanceof HTMLInputElement && (el.type === "hidden" || el.type === "password"))
          return;
        if (!isVisible(el)) return;
        const value =
          el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : "";
        if (value.length > 0) pushCandidate(value, el);
      });

      // 2. Direct text content in visible leaf elements.
      document.querySelectorAll("body *").forEach((el) => {
        if (el.tagName === "SCRIPT" || el.tagName === "STYLE") return;
        if (!isVisible(el)) return;
        let direct = "";
        el.childNodes.forEach((n) => {
          if (n.nodeType === Node.TEXT_NODE) direct += n.textContent ?? "";
        });
        direct = direct.trim();
        if (direct.length === 0 || direct.length > 256) return;
        pushCandidate(direct, el);
      });

      // 3. Structural containers (code/pre/kbd) where the credential
      //    is interpolated through nested spans.
      document.querySelectorAll('code, pre, kbd, samp, [role="textbox"]').forEach((el) => {
        if (!isVisible(el)) return;
        const full = (el.textContent ?? "").trim();
        if (full.length === 0 || full.length > 256) return;
        pushCandidate(full, el);
      });

      return out;
    });
  }

  // Click every visible "Reveal" / "Show" / "Eye" / "Copy" button on
  // the page that sits next to a masked credential display. Used as a
  // pre-extract pass for services like Cloudinary that hide the
  // api_secret behind a click-to-reveal icon. Best-effort: failures
  // don't throw; subsequent extract pass tries whatever surfaced.
  // Returns the number of buttons successfully clicked.
  async revealMaskedCredentials(page: Page | null = this.page): Promise<{
    clicked: number;
    diagnostic: string[];
  }> {
    if (page === null) throw new Error("Browser not started");
    const probe = await page.evaluate(() => {
      const isVisible = (el: Element): boolean => {
        const r = el.getBoundingClientRect();
        return r.width > 2 && r.height > 2;
      };
      // Walk up to the nearest "row-like" ancestor — a <tr>, a <li>,
      // or any container ≤ 800px wide with limited height. Cloudinary,
      // Algolia, Twilio all use table rows; clicking the reveal in
      // ROW X must populate the value in ROW X, not some neighbor row.
      const rowAncestor = (el: Element): Element | null => {
        let cur: Element | null = el;
        for (let i = 0; i < 8 && cur !== null; i++) {
          if (cur.tagName === "TR" || cur.tagName === "LI") return cur;
          const r = cur.getBoundingClientRect();
          if (r.width > 200 && r.width < 900 && r.height < 200) return cur;
          cur = cur.parentElement;
        }
        return el.parentElement;
      };

      // 1. Find masked-display elements + their row containers.
      type Masked = { el: Element; row: Element | null };
      const masked: Masked[] = [];
      document.querySelectorAll("body *").forEach((el) => {
        if (el.tagName === "SCRIPT" || el.tagName === "STYLE") return;
        if (!isVisible(el)) return;
        let direct = "";
        el.childNodes.forEach((n) => {
          if (n.nodeType === Node.TEXT_NODE) direct += n.textContent ?? "";
        });
        const t = direct.trim();
        if (t.length < 3 || t.length > 100) return;
        if (!/[•●⬤*]{3,}/.test(t) && !/^[•*]+$/.test(t)) return;
        masked.push({ el, row: rowAncestor(el) });
      });
      document.querySelectorAll<HTMLInputElement>('input[type="password"]').forEach((el) => {
        if (!isVisible(el)) return;
        masked.push({ el, row: rowAncestor(el) });
      });
      const selectorFor = (el: Element): string => {
        const parts: string[] = [];
        let current: Element | null = el;
        while (current !== null && current !== document.body) {
          const tag = current.tagName.toLowerCase();
          const siblings = Array.from(current.parentElement?.children ?? []).filter(
            (sibling) => sibling.tagName === current!.tagName,
          );
          parts.unshift(`${tag}:nth-of-type(${siblings.indexOf(current) + 1})`);
          current = current.parentElement;
        }
        return `body > ${parts.join(" > ")}`;
      };

      // No masked placeholder anywhere — but some consoles hide the key
      // ENTIRELY behind a "View/Show Key" button with no ••• shown at all
      // (Zilliz's "View My Personal Key"). The row-anchored pass below has
      // nothing to anchor on, so without this the reveal pass bails and the
      // extractor reports no_legit_credential on a page that DOES have a key.
      // Anchor-free fallback: click a button whose label pairs a SAFE reveal
      // verb with a credential noun, excluding destructive verbs (reset/
      // regenerate/delete/revoke/rotate would mint or destroy a key, not
      // reveal the existing one).
      if (masked.length === 0) {
        const KEY_NOUN =
          /\b(?:api\s*key|secret|token|credential|personal\s+key|access\s+key|key)\b/i;
        const SAFE_REVEAL = /\b(?:view|show|reveal|display|see)\b/i;
        const DESTRUCTIVE =
          /\b(?:reset|regenerat\w*|delete|revoke|rotate|create|new|remove|add|download)\b/i;
        const out: string[] = [];
        const diag: string[] = [];
        document
          .querySelectorAll<HTMLElement>('button, [role="button"], a[role="button"]')
          .forEach((el) => {
            if (!isVisible(el)) return;
            const hay =
              `${el.textContent ?? ""} ${el.getAttribute("aria-label") ?? ""} ${el.getAttribute("title") ?? ""}`
                .replace(/\s+/g, " ")
                .trim();
            if (hay.length === 0 || hay.length > 60) return;
            if (!SAFE_REVEAL.test(hay) || !KEY_NOUN.test(hay)) return;
            if (DESTRUCTIVE.test(hay)) return;
            out.push(selectorFor(el));
            diag.push(`anchorless_key_reveal:"${hay.slice(0, 40)}"`);
          });
        return {
          selectors: out,
          diagnostic: out.length > 0 ? diag : ["no_masked_displays"],
        };
      }

      // 2. Classify candidate buttons. Prefer SHOW/REVEAL/EYE; fall
      //    back to COPY only when no show button exists in the row.
      //    (Copy generally puts value in clipboard, not in DOM —
      //    which our extractor can't read in headless.)
      const SHOW_PATTERN = /\b(?:reveal|show|unmask|view|toggle|eye)\b/i;
      const COPY_PATTERN = /\bcopy\b/i;

      const collectButtonsInRow = (
        row: Element | null,
      ): { showBtns: Element[]; copyBtns: Element[] } => {
        const showBtns: Element[] = [];
        const copyBtns: Element[] = [];
        if (row === null) return { showBtns, copyBtns };
        row
          .querySelectorAll<HTMLElement>(
            'button, [role="button"], a[role="button"], [aria-label], [title]',
          )
          .forEach((el) => {
            if (!isVisible(el)) return;
            const hay = `${el.textContent ?? ""} ${el.getAttribute("aria-label") ?? ""} ${el.getAttribute("title") ?? ""} ${el.className ?? ""}`;
            if (SHOW_PATTERN.test(hay)) showBtns.push(el);
            else if (COPY_PATTERN.test(hay)) copyBtns.push(el);
          });
        return { showBtns, copyBtns };
      };

      const selectors: string[] = [];
      const diagnostic: string[] = [];
      const usedRows = new Set<Element>();
      for (const m of masked) {
        if (m.row === null) continue;
        if (usedRows.has(m.row)) continue;
        usedRows.add(m.row);
        const { showBtns, copyBtns } = collectButtonsInRow(m.row);
        if (showBtns.length > 0) {
          const btn = showBtns[0]!;
          const sel = selectorFor(btn);
          selectors.push(sel);
          const label = (
            btn.textContent ??
            btn.getAttribute("aria-label") ??
            btn.getAttribute("title") ??
            ""
          )
            .trim()
            .slice(0, 40);
          diagnostic.push(`row→show:"${label}"→${sel}`);
        } else if (copyBtns.length > 0) {
          diagnostic.push(
            `row→copy_only_no_show_button (copy='${copyBtns.length} found' — skipped, would only populate clipboard not DOM)`,
          );
        } else {
          diagnostic.push("row→no_buttons_found");
        }
      }
      return { selectors, diagnostic };
    });

    let clicked = 0;
    for (const sel of probe.selectors) {
      try {
        await page.locator(sel).first().click({ timeout: 1500 });
        clicked += 1;
        // Reveal click often triggers a fetch (Cloudinary returns the
        // secret over an XHR before populating the DOM). Wait longer
        // than the previous 150ms.
        await this.sleep(800);
      } catch {
        // Click failed — best-effort.
      }
    }
    return { clicked, diagnostic: probe.diagnostic };
  }

  async extractCredentialCandidates(): Promise<string[]> {
    if (!this.page) throw new Error("Browser not started");
    return await this.page.evaluate(() => {
      const out: string[] = [];
      const isVisible = (el: Element): boolean => {
        const r = el.getBoundingClientRect();
        return r.width > 2 && r.height > 2;
      };
      document.querySelectorAll("input, textarea").forEach((el) => {
        // Only text-shaped inputs can RENDER a credential. A checkbox/
        // radio/button's `value` is a markup constant, not page content —
        // zilliz's CookieScript banner ships `<input type="checkbox"
        // value="personalization">` and those words sit earlier in DOM
        // order than the real key, so the validator-shaped scan tier was
        // returning them as the "credential".
        if (
          el instanceof HTMLInputElement &&
          !["text", "search", "url", "tel", "number", "email", ""].includes(el.type)
        ) {
          return;
        }
        const value =
          el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : "";
        if (value.trim().length > 0 && isVisible(el)) out.push(value.trim());
      });
      document.querySelectorAll("body *").forEach((el) => {
        if (el.tagName === "SCRIPT" || el.tagName === "STYLE") return;
        if (!isVisible(el)) return;
        let direct = "";
        el.childNodes.forEach((n) => {
          if (n.nodeType === Node.TEXT_NODE) direct += n.textContent ?? "";
        });
        direct = direct.trim();
        // A real key is short; a long blob is a paragraph, not a key.
        if (direct.length > 0 && direct.length <= 256) out.push(direct);
      });
      // Structural containers (<code>, <pre>, kbd, samp, [role=textbox])
      // often render a credential by interpolating it through nested
      // <span>s — the loop above sees an empty direct-text and skips
      // them. Push the full textContent so a UUID built as
      // <code><span>7</span><span>5</span>…</code> is still scannable.
      document.querySelectorAll('code, pre, kbd, samp, [role="textbox"]').forEach((el) => {
        if (!isVisible(el)) return;
        const full = (el.textContent ?? "").trim();
        if (full.length > 0 && full.length <= 256) out.push(full);
      });
      return out;
    });
  }

  // Wait for the signup form to actually render before the planner
  // screenshots the page (F1). SPA and two-stage signup pages render
  // the form after JS executes; planning against a pre-render
  // skeleton makes the planner emit plausible-but-wrong selectors and
  // every executed action then times out. Best-effort — both waits
  // swallow their own timeout so the planner always still runs.
  async waitForFormReady(timeoutMs = 15000): Promise<void> {
    if (!this.page) throw new Error("Browser not started");
    // PERF: networkidle almost never settles on real signup pages
    // (analytics sockets / long-poll / Intercom widgets keep traffic
    // flowing indefinitely), so the previous 15s ceiling was 15s of
    // pure deadtime per call. Cap at 1500ms so the bot gets the
    // signal-when-it's-real and moves on otherwise. domcontentloaded
    // is the real "DOM is parsed" signal; networkidle here is just
    // a best-effort polish wait for the SPA to settle.
    try {
      await this.page.waitForLoadState("domcontentloaded", { timeout: 5_000 });
    } catch {
      // already past domcontentloaded → fine
    }
    try {
      await this.page.waitForLoadState("networkidle", { timeout: 1_500 });
    } catch {
      // expected on most modern pages — fall through to the element wait.
    }
    // F13 follow-up — if we landed on a full-page anti-bot interstitial
    // (Cloudflare "Just a moment..." / Turnstile pre-clear / similar),
    // wait for it to clear and the real page to render. networkidle
    // sometimes fires DURING the interstitial because Cloudflare keeps
    // the connection quiet between the verify-handshake and the
    // redirect to the real page. Without this, the bot snapshots a
    // 2-element interstitial inventory and bails.
    await this.waitForAntiBotInterstitialToClear(timeoutMs);
    // rc.33 — extended the element-wait selector to match the broader
    // inventory walk added in rc.26 (menuitem/option/combobox plus
    // anchors). Porter and Koyeb's API-tokens pages are nested SPAs
    // that initially render with NO <input>/<button> — just <a> and
    // role=button divs. The old selector timed out at 15s on those
    // pages, the planner saw an empty inventory, and the post-verify
    // loop burned rounds clicking nothing.
    try {
      await this.page.waitForSelector(
        'input, button, textarea, select, a[href], [role="button"], [role="menuitem"]',
        { state: "visible", timeout: timeoutMs },
      );
    } catch {
      // No interactive element appeared in time — let the planner run
      // anyway; it fails cleanly rather than hanging.
    }
    // The generic wait above is satisfied by ANY interactive element —
    // on a signup page with marketing chrome (links, marketplace badges)
    // that fires while the actual auth widget is still an async spinner.
    // The bot then snapshots a form-less inventory and bails
    // `oauth_required` ("no email/password form"). MEASURED 2026-06-11
    // (zilliz /signup: right-panel spinner, marketing copy on the left).
    // So: if a loading spinner is visible AND no auth-form signal exists
    // yet, give the widget a bounded extra wait to hydrate.
    await this.waitForAuthWidgetHydration();
  }

  // Bounded poll for an auth-form signal when the page is still showing a
  // loading spinner. Strictly additive: returns immediately unless a
  // spinner is visible AND no auth signal (email/password input or a
  // provider/sign-up button) is present yet. Best-effort — never throws.
  async waitForAuthWidgetHydration(timeoutMs = 8_000): Promise<void> {
    if (!this.page) return;
    const authWidgetHydrationProbe = String.raw`(() => {
      const vis = (el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const anyVis = (sel) =>
        Array.from(document.querySelectorAll(sel)).some(vis);
      const hasAuthInput = anyVis(
        'input[type="email"],input[type="password"],input[name="email" i],input[name="password" i]',
      );
      let hasAuthButton = false;
      const re = /\b(sign\s?up|continue with|log ?in with|with google|with github|with sso|create account)\b/i;
      for (const el of Array.from(
        document.querySelectorAll('button,a[href],[role="button"]'),
      )) {
        if (!vis(el)) continue;
        if (re.test((el.textContent ?? "").trim())) {
          hasAuthButton = true;
          break;
        }
      }
      const spinnerVisible = anyVis(
        '[role="progressbar"],[aria-busy="true"],[class*="spin" i],[class*="loading" i],[class*="loader" i],.ant-spin,.MuiCircularProgress-root',
      );
      return { hasAuth: hasAuthInput || hasAuthButton, spinnerVisible };
    })()`;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const state = (await Promise.race([
          this.page.evaluate(authWidgetHydrationProbe),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("auth widget probe timed out")), 1_500),
          ),
        ])) as {
          hasAuth: boolean;
          spinnerVisible: boolean;
        };
        // Done the moment an auth signal appears, or once nothing is
        // spinning anymore (no point waiting on a page that simply has
        // no auth widget — a true OAuth-less/blank page bails honestly).
        if (state.hasAuth) return;
        if (!state.spinnerVisible) return;
      } catch {
        return; // navigation / context teardown — let the caller proceed
      }
      await this.sleep(500);
    }
  }

  // rc.33 — wait for the DOM to grow past a minimum interactive-
  // element count, polling every 500ms up to timeoutMs. The
  // single-element wait in waitForFormReady is fast-path; this is
  // for SPAs where DOMContentLoaded fires almost immediately but the
  // React/Vue/Svelte tree takes 5-15s more to actually render. Used
  // after navigate() in the post-verify loop so the planner doesn't
  // see a 0-button page that's still rendering. Best-effort —
  // returns whenever the count is reached OR the timeout elapses.
  async waitForInteractiveDom(
    minElements = 5,
    timeoutMs = 20_000,
    page: Page | null = this.page,
  ): Promise<void> {
    if (!page) return;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const count = await Promise.race([
          page.evaluate((min: number) => {
            const sels =
              'input,textarea,select,button,a[href],[role="button"],[role="menuitem"],[role="option"]';
            const nodes = Array.from(document.querySelectorAll(sels));
            let visible = 0;
            for (const n of nodes) {
              const el = n as HTMLElement;
              const r = el.getBoundingClientRect();
              if (r.width >= 2 && r.height >= 2) visible++;
              if (visible >= min) return visible;
            }
            return visible;
          }, minElements),
          new Promise<number>((_, reject) =>
            setTimeout(() => reject(new Error("interactive DOM probe timed out")), 1_500),
          ),
        ]);
        if (count >= minElements) return;
      } catch {
        // Page may be mid-navigation — try again on the next tick.
      }
      await this.sleep(500);
    }
  }

  // Find and click an "Accept"-class button to dismiss any visible
  // cookie/consent banner. Returns the clicked button's text when a
  // dismiss fired, or null when no banner / no clickable affordance
  // was found. Best-effort: never throws.
  //
  // Strategy: cookie-banner CTAs use a very narrow vocabulary across
  // the entire web ("Accept all", "Allow all", "Got it", "Reject all"
  // …). Instead of trying to enumerate every vendor's container
  // selector (osano/onetrust/cookiebot/trustarc/iubenda/quantcast/
  // truste/usercentrics/etc. — never complete), we just hunt for any
  // visible button whose TEXT matches the canonical CTA. Risk of a
  // false positive (clicking a non-consent button whose text happens
  // to match) is acceptable because the strings we accept are
  // extremely banner-specific. We don't match bare "accept" / "ok" /
  // "continue" — too generic to be safe.
  //
  // 2026-09-15: an audit removal (which lumped this in with the Cloudflare
  // interstitial stack) was WITHDRAWN on provenance: a consent overlay is
  // not a bot gate, and this was introduced against two recorded real-site
  // failures (Railway 7889ff0d/c773db55; Robinhood faucet fabb8a9f). See
  // data/ts-wave2-cloudflare-interstitial/findings.md.
  async dismissConsentBanner(): Promise<string | null> {
    if (!this.page) return null;
    // Prefer-order: most specific (and most clearly consent-only)
    // first. First visible button matching one of these wins.
    const PREFER_ORDER: RegExp[] = [
      /^\s*(?:accept all cookies|accept all|allow all cookies|allow all)\s*$/i,
      /^\s*(?:i accept|i agree|i understand|got it!?|sounds good)\s*$/i,
      /^\s*(?:accept|agree)\s*(?:cookies|all|&\s*close)?\s*$/i,
      /^\s*(?:reject all cookies|reject all|decline all|deny all)\s*$/i,
    ];
    let target: { x: number; y: number; text: string } | null = null;
    try {
      target = await this.page.evaluate(
        ({ patterns }) => {
          const candidates = Array.from(
            document.querySelectorAll('button, a, [role="button"], [role="link"]'),
          ) as HTMLElement[];
          const visible = (el: HTMLElement): boolean => {
            const r = el.getBoundingClientRect();
            if (r.width < 2 || r.height < 2) return false;
            const s = window.getComputedStyle(el);
            return (
              s.display !== "none" &&
              s.visibility !== "hidden" &&
              parseFloat(s.opacity || "1") > 0.01
            );
          };
          for (const reStr of patterns) {
            const re = new RegExp(reStr, "i");
            const hit = candidates.find((c) => visible(c) && re.test((c.textContent || "").trim()));
            if (hit !== undefined) {
              const r = hit.getBoundingClientRect();
              return {
                x: r.x + r.width / 2,
                y: r.y + r.height / 2,
                text: (hit.textContent || "").trim().slice(0, 40),
              };
            }
          }
          return null;
        },
        { patterns: PREFER_ORDER.map((p) => p.source) },
      );
    } catch {
      return null;
    }
    if (target === null) return null;
    try {
      await this.page.mouse.click(target.x, target.y);
      // Wait for the banner to fade out + any post-dismiss reflow
      // (e.g. lazy-rendering the previously-blocked OAuth chooser).
      // Try networkidle first for SPA re-renders, fall back to a
      // fixed dwell.
      await this.page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => undefined);
      await this.page.waitForTimeout(800);
      return target.text;
    } catch {
      return null;
    }
  }

  // Cloudflare and similar gateways serve a full-page interstitial
  // ("Just a moment..." / Turnstile pre-clear) before the real page.
  // The challenge usually clears within ~5-10s — the bot just needs
  // to wait. Detected from page text patterns rather than URL: the
  // URL stays the same; the body replaces.
  //
  // Returns when the interstitial is gone, or after `timeoutMs` if it
  // never cleared. Best-effort: any unexpected error returns early
  // rather than failing the whole signup.
  //
  // 2026-09-15: an audit removal of this whole stack (plus
  // clearCloudflareCookiesAndRetry, forceNavigatePastClearedChallenge,
  // pollUntilInterstitialClears, classifyInterstitialText,
  // stripCloudflareChallengeParams — ~300 lines) was attempted and WITHDRAWN
  // on live-repro evidence (data/ts-wave2-cloudflare-interstitial/findings.md).
  // Nothing here auto-surmounts a challenge: the wait observes, the cookie
  // branch RE-ARMS a fresh challenge, and the token-strip branch fires only
  // after a CONFIRMED pass to finish CF's own stalled redirect — each against
  // a recorded real-site failure (codesandbox stale clearance / stuck
  // redirect; 27436695, 555aec8f). Removing the stack was measured to leave
  // the planner facing a challenge page with ZERO interactive elements (and
  // the operate_* surface has no captcha verb), i.e. a stop nobody can act
  // on. Every function was introduced against a named real-site failure.
  private async waitForAntiBotInterstitialToClear(timeoutMs: number): Promise<void> {
    if (!this.page) return;
    const first = await this.pollUntilInterstitialClears(timeoutMs);
    // Never saw an interstitial, or saw one and it cleared on its own —
    // nothing more to do.
    if (!first.detected || first.cleared) return;
    // Still on the interstitial at the deadline. If Cloudflare reported
    // the challenge PASSED ("Verification successful"), the redirect is
    // just racing/stuck — be patient through ANOTHER full window before
    // touching anything (a reload mid-redirect can re-arm the challenge).
    if (first.verificationPassed) {
      const patient = await this.pollUntilInterstitialClears(timeoutMs);
      if (patient.cleared) return;
      // "Verification successful" but the page never advances is the
      // signature of a STALE cf_clearance cookie — issued on a prior visit
      // (often a different egress IP), which CF matches ("successful") but
      // the origin then rejects, looping forever on "Waiting for the page
      // to load." MEASURED: a clean profile clears codesandbox's challenge
      // in ~12s; the stale cookie is what stalls the shared profile. Drop
      // the CF cookies to force a FRESH challenge, then reload.
      if (await this.clearCloudflareCookiesAndRetry(timeoutMs)) return;
      // Or the auto-redirect simply stalled with a still-valid clearance —
      // re-navigate past the one-shot challenge token.
      if (await this.forceNavigatePastClearedChallenge()) return;
    }
    // Force the real page: now that the cf_clearance cookie is set, a
    // reload often renders it. domcontentloaded (not networkidle) — the
    // real page is usually a heavy SPA that never reaches networkidle, so
    // waiting for it just burns the budget back into a timeout. (If it's a
    // server-side risk-score block — fingerprint/IP — reload won't help,
    // but the caller's inventory diagnostic will still surface the block.)
    try {
      await this.page.reload({ waitUntil: "domcontentloaded", timeout: 15_000 });
    } catch {
      // reload failed — proceed with what's there
    }
    await this.pollUntilInterstitialClears(Math.max(5000, timeoutMs / 2));
  }

  // Drop Cloudflare's anti-bot cookies (cf_clearance + __cf_bm) so the next
  // request triggers a FRESH managed challenge, then reload and wait for it
  // to clear. Scope by name, exact domain and path of cookies applying to
  // THIS page, so unrelated sites retain their own Cloudflare clearance. A fresh challenge on a residential IP clears in ~12-15s, so
  // we give it a generous window. Returns true if the interstitial is gone.
  private async clearCloudflareCookiesAndRetry(timeoutMs: number): Promise<boolean> {
    if (!this.page || !this.context) return false;
    try {
      const cookies = await this.context.cookies(this.page.url());
      for (const cookie of cookies) {
        if (cookie.name !== "cf_clearance" && cookie.name !== "__cf_bm") continue;
        await this.context.clearCookies({
          name: cookie.name,
          domain: cookie.domain,
          path: cookie.path,
        });
      }
    } catch {
      // clearCookies filter unsupported / failed — nothing to retry on.
      return false;
    }
    try {
      await this.page.reload({ waitUntil: "domcontentloaded", timeout: 20_000 });
    } catch {
      // reload failed — still give the poll a chance below.
    }
    const after = await this.pollUntilInterstitialClears(Math.max(20_000, timeoutMs));
    return after.cleared || !after.detected;
  }

  // With a CONFIRMED Cloudflare pass, re-navigate to the current URL with
  // the one-shot `__cf_chl_*` challenge token stripped — the cf_clearance
  // cookie is already set, so the edge serves the real page instead of the
  // stuck redirect. Returns true if the interstitial is gone afterwards.
  // Returns false (caller falls back to a plain reload) when there's no
  // token to strip or the navigation didn't clear the gate.
  private async forceNavigatePastClearedChallenge(): Promise<boolean> {
    if (!this.page) return false;
    const cleaned = stripCloudflareChallengeParams(this.page.url());
    if (!cleaned) return false;
    try {
      await this.page.goto(cleaned, {
        waitUntil: "domcontentloaded",
        timeout: 15_000,
      });
    } catch {
      return false;
    }
    const after = await this.pollUntilInterstitialClears(Math.max(5000, 8000));
    // cleared = saw it then it went away; !detected = the real page rendered
    // immediately (no interstitial on the post-nav page at all).
    return after.cleared || !after.detected;
  }

  // One poll loop. `detected` = an interstitial was observed at least
  // once; `cleared` = it was observed AND then went away (vs. still there
  // at the deadline); `verificationPassed` = Cloudflare reported the
  // challenge succeeded at some point during the wait (see
  // classifyInterstitialText).
  private async pollUntilInterstitialClears(
    timeoutMs: number,
  ): Promise<{ detected: boolean; cleared: boolean; verificationPassed: boolean }> {
    if (!this.page) return { detected: false, cleared: false, verificationPassed: false };
    const deadline = Date.now() + timeoutMs;
    let detected = false;
    let verificationPassed = false;
    while (Date.now() < deadline) {
      let title = "";
      let bodyText = "";
      try {
        title = await this.page.title();
        bodyText = await this.page.evaluate(() => (document.body?.innerText ?? "").slice(0, 500));
      } catch {
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      const c = classifyInterstitialText(title + " " + bodyText);
      if (c.verificationPassed) verificationPassed = true;
      if (!c.onInterstitial) {
        if (detected) {
          // Give the freshly-revealed page a tick to hydrate before
          // the inventory scan.
          await new Promise((r) => setTimeout(r, 800));
        }
        return { detected, cleared: detected, verificationPassed };
      }
      detected = true;
      await new Promise((r) => setTimeout(r, 1000));
    }
    return { detected, cleared: false, verificationPassed };
  }

  // Walk the live DOM (piercing open shadow roots) and return every
  // visible interactive element with a bot-computed selector (F3 T1).
  // The planner picks from this inventory instead of inventing
  // selector strings. Selectors prefer #id then [name] — Playwright's
  // CSS engine pierces open shadow roots, so those resolve for
  // shadow-DOM fields too.
  // The DOM-walk + extraction logic, generalized to run against ANY frame
  // context (the main page or a child <iframe>'s own Frame) — Playwright's
  // Frame.evaluate reaches a cross-origin frame's main world at the CDP level,
  // the same primitive direct frame-targeted actions use for hosted fields.
  // Pulled out of extractInteractiveElements (below) so that method can call
  // it once for the main frame and once per child frame, tagging each result
  // with where it came from.
  private async extractElementsFromContext(ctx: Page | Frame) {
    return await ctx.evaluate(() => {
      const SELECTOR =
        // rc.26 — added Radix/Headless-UI menu + option items so
        // dropdown contents (Fireworks "Create API Key" → API Key /
        // Service Account menu, Sentry's per-row permissions) end up
        // in the planner's inventory.
        // rc.35 — added [role="link"] (Google account-chooser cards
        // are <div role="link" data-identifier="…">), and <label>
        // (Koyeb's onboarding renders each radio choice as a styled
        // <label> wrapping a sr-only <input type=radio>; the visible
        // click target is the label, but the bot's inventory selector
        // didn't catch labels so the planner had no clickable target
        // matching the visible button text).
        // T38 — added [role="radio"] for onboarding wizards that mark
        // each card with a semantic radio role (some Cloudinary /
        // Stytch flows). Card-radio clusters with NO role are detected
        // post-extraction by assignCardRadioGroups using bounding-box
        // similarity, so this addition is just for the semantically-
        // tagged case.
        'input,textarea,select,button,a,label,[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"],[role="option"],[role="combobox"],[contenteditable=""],[contenteditable="true"]';

      // Collect candidates across the document and every open shadow
      // root. Closed shadow roots are unreachable — accepted.
      const collected: Element[] = [];
      const getNativeShadowRoot = Object.getOwnPropertyDescriptor(
        Element.prototype,
        "shadowRoot",
      )?.get;
      const shadowRootFor = (element: Element): ShadowRoot | null =>
        getNativeShadowRoot?.call(element) ?? null;
      const walk = (root: Document | ShadowRoot): void => {
        // Defensive: a root with no querySelectorAll (a detached/closed
        // node surfaced mid-render by Descope-style web components on
        // app.redislabs.com / console.weaviate.cloud) used to crash the
        // whole inventory with "Cannot read properties of undefined
        // (reading 'querySelectorAll')", failing the run before the
        // planner ever saw the page. Skip such a node instead.
        //
        // `== null` (not `=== null`) is load-bearing: `el.shadowRoot` is
        // typed `ShadowRoot | null`, but a detached/closed custom element
        // can yield `undefined` at runtime. The recursion below calls
        // `walk(el.shadowRoot)` whenever it isn't `null`, so an `undefined`
        // shadowRoot reaches here and `typeof undefined.querySelectorAll`
        // THROWS before the typeof guard can fire — exactly the #59
        // redis-cloud crash, which recurred 2026-06-03 even with the
        // null-only guard in place. The loose check covers both.
        if (root == null || typeof root.querySelectorAll !== "function") return;
        root.querySelectorAll(SELECTOR).forEach((n) => collected.push(n));
        root.querySelectorAll("*").forEach((el) => {
          const shadowRoot = shadowRootFor(el);
          if (shadowRoot !== null) walk(shadowRoot);
        });
      };
      walk(document);

      // 0.8.3-rc.1 — also collect OAuth-affordance iframes. Modern
      // signup pages (Mixpanel, many Next.js sites) render "Continue
      // with Google" via Google's GIS iframe at
      // `accounts.google.com/gsi/button` — cross-origin, so the
      // button INSIDE the iframe isn't in our DOM. The iframe element
      // ITSELF is clickable from the parent page though; clicking its
      // bounding box dispatches the click event into the iframe, and
      // Google's button-handler then opens the OAuth popup. We
      // surface these iframes as synthetic OAuth buttons (with a
      // visibleText that findOAuthButton matches) so the OAuth-first
      // scan can pick them up.
      document
        .querySelectorAll<HTMLIFrameElement>('iframe[src*="accounts.google.com/gsi/button"]')
        .forEach((n) => collected.push(n));

      const isVisible = (el: Element): boolean => {
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return false;
        const s = window.getComputedStyle(el);
        return (
          s.display !== "none" && s.visibility !== "hidden" && parseFloat(s.opacity || "1") > 0.01
        );
      };

      // G12 — visually-hidden checkbox/radio surfacing. Custom-styled
      // TOS checkboxes are real `<input type=checkbox>` elements with
      // `opacity:0` / `sr-only` styling behind a styled <label>; they
      // are user-clickable (the label's click event fires the input)
      // and `page.check()` reaches them, but isVisible() drops them
      // and the inventory has nothing for the planner to target.
      // Mistral's org-creation TOS gate is the canonical case.
      //
      // Returns true when the hidden input is a checkbox/radio AND
      // its label (associated by `for=` or by ancestor wrap) is
      // itself visible. Standalone hidden checkboxes outside any
      // label stay filtered — they're typically state-tracking inputs
      // the bot must not toggle.
      const isCheckableHiddenByStyledLabel = (el: Element): boolean => {
        if (!(el instanceof HTMLInputElement)) return false;
        const t = el.type;
        if (t !== "checkbox" && t !== "radio") return false;
        // Style-hidden (sr-only / opacity:0) is the case to recover;
        // genuinely display:none is intentionally hidden state, skip.
        const s = window.getComputedStyle(el);
        if (s.display === "none") return false;
        // Find an associated label and check its visibility.
        const id = el.getAttribute("id");
        let label: Element | null = null;
        if (id !== null && id.length > 0) {
          try {
            label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
          } catch {
            /* malformed id — fall through */
          }
        }
        if (label === null) label = el.closest("label");
        if (label === null) return false;
        return isVisible(label);
      };

      const clean = (s: string | null | undefined): string | null => {
        if (s === null || s === undefined) return null;
        const t = s.replace(/\s+/g, " ").trim();
        return t.length === 0 ? null : t.slice(0, 120);
      };

      const labelFor = (el: Element): string | null => {
        const id = el.getAttribute("id");
        if (id !== null && id.length > 0) {
          try {
            const l = document.querySelector(`label[for="${CSS.escape(id)}"]`);
            if (l !== null) return clean(l.textContent);
          } catch {
            /* malformed id — fall through */
          }
        }
        const labelledBy = el.getAttribute("aria-labelledby");
        if (labelledBy !== null && labelledBy.trim().length > 0) {
          const parts: string[] = [];
          for (const part of labelledBy.split(/\s+/)) {
            const t = clean(document.getElementById(part)?.textContent);
            if (t !== null) parts.push(t);
          }
          if (parts.length > 0) return clean(parts.join(" "));
        }
        const anc = el.closest("label");
        const ancestorLabel = anc !== null ? clean(anc.textContent) : null;
        if (ancestorLabel !== null) return ancestorLabel;

        let cur: Element | null = el;
        for (let depth = 0; depth < 3 && cur !== null; depth += 1) {
          let sib = cur.previousElementSibling;
          for (let scanned = 0; scanned < 4 && sib !== null; scanned += 1) {
            const nestedLabel = clean(sib.querySelector("label")?.textContent);
            if (nestedLabel !== null) return nestedLabel;
            const labelish =
              sib.tagName.toLowerCase() === "label" ||
              /\b(label|field|form|control)\b/i.test(sib.getAttribute("class") ?? "");
            const t = clean(sib.textContent);
            if (
              t !== null &&
              t.length <= 80 &&
              !/[{};]/.test(t) &&
              (labelish || t.split(/\s+/).length <= 8)
            ) {
              return t;
            }
            sib = sib.previousElementSibling;
          }
          cur = cur.parentElement;
        }
        return null;
      };

      const inConsent = (el: Element): boolean =>
        el.closest(
          '[class*="osano"],[id*="onetrust"],[id*="cookie"],[class*="cookie-consent"],[class*="cookie-banner"],[class*="cookieConsent"]',
        ) !== null;

      // Accessible label of a descendant icon — an icon-only "Sign in
      // with Google" button carries no text, but its <img alt>, its
      // <svg><title>, or a descendant [aria-label] names the provider.
      const iconLabelFor = (el: Element): string | null => {
        const img = el.querySelector("img[alt]");
        if (img !== null) {
          const alt = clean(img.getAttribute("alt"));
          if (alt !== null) return alt;
        }
        const svgTitle = el.querySelector("svg title");
        if (svgTitle !== null) {
          const t = clean(svgTitle.textContent);
          if (t !== null) return t;
        }
        const labelled = el.querySelector("[aria-label]");
        if (labelled !== null) {
          const l = clean(labelled.getAttribute("aria-label"));
          if (l !== null) return l;
        }
        return null;
      };

      const selectorFor = (el: Element): string => {
        const tag = el.tagName.toLowerCase();
        let base: string;
        const testId =
          el.getAttribute("data-testid") ??
          el.getAttribute("data-test-id") ??
          el.getAttribute("data-test") ??
          el.getAttribute("data-cy") ??
          el.getAttribute("data-qa");
        const id = el.getAttribute("id");
        const name = el.getAttribute("name");
        if (testId !== null && testId.length > 0) {
          const attr = el.hasAttribute("data-testid")
            ? "data-testid"
            : el.hasAttribute("data-test-id")
              ? "data-test-id"
              : el.hasAttribute("data-test")
                ? "data-test"
                : el.hasAttribute("data-cy")
                  ? "data-cy"
                  : "data-qa";
          base = `[${attr}="${CSS.escape(testId)}"]`;
        } else if (id !== null && /^[A-Za-z][\w-]*$/.test(id)) {
          base = `#${id}`;
        } else if (name !== null && name.length > 0) {
          base = `${tag}[name="${name.replace(/"/g, '\\"')}"]`;
        } else {
          // Structural fallback — a short nth-of-type path.
          const parts: string[] = [];
          let node: Element | null = el;
          for (let depth = 0; depth < 4 && node !== null; depth++) {
            const cur: Element = node;
            const t = cur.tagName.toLowerCase();
            const parent: Element | null = cur.parentElement;
            if (parent === null) {
              parts.unshift(t);
              break;
            }
            const sibs = Array.from(parent.children).filter((c) => c.tagName === cur.tagName);
            const idx = sibs.indexOf(cur) + 1;
            parts.unshift(sibs.length > 1 ? `${t}:nth-of-type(${idx})` : t);
            node = parent;
          }
          base = parts.join(" > ");
        }
        // Guarantee the selector resolves to exactly this element. A
        // 4-level path (or a stray duplicate id) can be ambiguous —
        // Back4App's "Continue with email" path also matched a
        // "Flexibility" tab, and Playwright strict mode then refuses
        // to act. `>> nth=` is Playwright syntax that pins the exact
        // match. (querySelectorAll can't see into shadow roots, so a
        // shadow element's count reads 0 — fine, it returns base.)
        try {
          const matches = document.querySelectorAll(base);
          if (matches.length <= 1) return base;
          const idx = Array.prototype.indexOf.call(matches, el);
          return idx >= 0 ? `${base} >> nth=${idx}` : base;
        } catch {
          return base;
        }
      };

      const slug = (s: string | null, fallback: string): string => {
        const base = (s ?? fallback)
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 48);
        return base.length > 0 ? base : fallback;
      };

      const directLabel = (el: Element): string | null =>
        clean(el.getAttribute("aria-label")) ??
        clean(el.getAttribute("title")) ??
        clean(el.getAttribute("name")) ??
        clean(el.textContent);

      const isFormControlElement = (el: Element): boolean =>
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLSelectElement;

      const regionFor = (el: Element): Element | null =>
        el.closest(
          '[role="dialog"],dialog,[aria-modal="true"],nav,main,header,footer,aside,form,section,article',
        );

      const regionIds = new Map<Element, number>();
      let nextRegionId = 1;
      const regionId = (region: Element | null): number | null => {
        if (region === null) return null;
        const existing = regionIds.get(region);
        if (existing !== undefined) return existing;
        const id = nextRegionId++;
        regionIds.set(region, id);
        return id;
      };

      const regionName = (region: Element | null): string | null => {
        if (region === null) return null;
        const role = region.getAttribute("role");
        const tag = region.tagName.toLowerCase();
        const kind =
          role === "dialog" || tag === "dialog" || region.getAttribute("aria-modal") === "true"
            ? "dialog"
            : tag === "nav"
              ? "navigation"
              : tag;
        const labelledBy = region.getAttribute("aria-labelledby");
        let label: string | null = null;
        if (labelledBy !== null && labelledBy.length > 0) {
          try {
            label = clean(document.getElementById(labelledBy)?.textContent);
          } catch {
            label = null;
          }
        }
        label =
          label ??
          clean(region.getAttribute("aria-label")) ??
          clean(region.querySelector("h1,h2,h3,[role='heading']")?.textContent) ??
          clean(region.textContent)?.slice(0, 60) ??
          kind;
        return `${kind}:${slug(label, kind)}`;
      };

      const elementKind = (el: Element): string => {
        const role = el.getAttribute("role");
        const tag = el.tagName.toLowerCase();
        if (role !== null && role.length > 0) return role;
        if (tag === "a") return "link";
        return tag;
      };

      const composedParent = (node: Node): Element | null => {
        const parent = node.parentNode;
        if (parent === null) return null;
        if (parent instanceof ShadowRoot) return parent.host;
        return parent instanceof Element ? parent : null;
      };

      const isDialogElement = (el: Element): boolean =>
        el.getAttribute("role") === "dialog" ||
        el.tagName.toLowerCase() === "dialog" ||
        el.getAttribute("aria-modal") === "true";

      const nearestModalRegion = (el: Element): Element | null => {
        let cur: Element | null = el;
        while (cur !== null) {
          if (isDialogElement(cur)) return cur;
          cur = composedParent(cur);
        }
        return null;
      };

      // `inert`, used to hide the background while a modal is open, is meant
      // to sit on a SIBLING of a truly-portaled dialog (Angular CDK/Material
      // append the overlay container as a sibling of the app root and mark
      // only the app root inert — that structure is unaffected by this).
      // Some dialogs are never portaled to <body> at all: they merely escape
      // their container VISUALLY via position:fixed while remaining a
      // structural DESCENDANT of whatever ancestor got marked inert for the
      // background-hiding trick. `inert` (unlike display/visibility/opacity)
      // makes Chromium's native hit-testing skip the entire subtree, so
      // document.elementFromPoint never resolves to the escaped dialog or
      // anything inside it — every one of its controls reports
      // topmost:false/occludedBy even though it is the genuinely visible,
      // user-clickable control (and a real click on it hangs the same way —
      // see withModalInertNeutralized in browser.ts). Scoped tight: only
      // ancestors of an element found by a dedicated nearest-DIALOG search are
      // neutralized. The composed-tree walk pierces open shadow-root boundaries;
      // closed roots remain unreachable like the rest of the extractor. A real
      // background control outside any modal keeps its inert protection
      // (money-fence boundary untouched).
      const neutralizeInertForHitTest = (el: Element): Element[] => {
        if (nearestModalRegion(el) === null) return [];
        const neutralized: Element[] = [];
        let cur: Element | null = el;
        while (cur !== null) {
          if (cur.hasAttribute("inert")) {
            cur.removeAttribute("inert");
            neutralized.push(cur);
          }
          cur = composedParent(cur);
        }
        return neutralized;
      };

      const topmostStatus = (el: Element): { topmost: boolean; occludedBy: string | null } => {
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) return { topmost: false, occludedBy: null };
        const x = Math.min(window.innerWidth - 1, Math.max(0, r.left + r.width / 2));
        const y = Math.min(window.innerHeight - 1, Math.max(0, r.top + r.height / 2));
        const neutralized = neutralizeInertForHitTest(el);
        try {
          let top = document.elementFromPoint(x, y);
          if (top === null) return { topmost: false, occludedBy: null };
          // document.elementFromPoint returns the shadow HOST, not the control
          // nested in its open shadow root — so a shadow-DOM CTA (Casetify's
          // Add-to-Cart web component) hit-tested against its own host would be
          // reported occludedBy that host and topmost:false, and the host agent
          // would skip a button nothing actually covers. Re-hit-test inside each
          // open shadow root at the same point to reach the deepest composed
          // element, matching what the user's pointer would strike. Closed roots
          // yield a null shadowRoot and the descent stops — same as the DOM.
          let shadowRoot = shadowRootFor(top);
          while (shadowRoot !== null) {
            const deeper = shadowRoot.elementFromPoint(x, y);
            if (deeper === null || deeper === top) break;
            top = deeper;
            shadowRoot = shadowRootFor(top);
          }
          if (top === el || el.contains(top)) return { topmost: true, occludedBy: null };
          let owner: Node | null = top;
          while (owner !== null) {
            if (owner === el) return { topmost: true, occludedBy: null };
            const assignedSlot: HTMLSlotElement | null =
              owner instanceof Element || owner instanceof Text ? owner.assignedSlot : null;
            if (assignedSlot !== null) {
              owner = assignedSlot;
              continue;
            }
            const parent: ParentNode | null = owner.parentNode;
            owner = parent instanceof ShadowRoot ? parent.host : parent;
          }
          return { topmost: false, occludedBy: regionName(regionFor(top)) ?? elementKind(top) };
        } finally {
          for (const a of neutralized) a.setAttribute("inert", "");
        }
      };

      // N1 onboarding-wizard cards (2026-06-08). Chakra/React card pickers
      // (imagekit's step-1/3 objective cards, axiom/pusher role cards) render
      // each selectable card as a BARE clickable div — cursor:pointer, but no
      // button/a/role/input semantics — so the SELECTOR walk above misses
      // them entirely and the planner has no target → it hallucinates
      // selectors and the stalled-wizard breaker fires. Collect them so the
      // existing assignCardRadioGroups can cluster them. Tightly scoped to
      // avoid flooding the inventory on ordinary pages:
      //   - cursor:pointer + visible
      //   - card-sized (not a tiny inline link, not a full-page wrapper)
      //   - has its OWN short label text
      //   - does NOT contain an already-collected interactive element (a
      //     wrapper around a real button isn't a card — we already have it)
      //   - OUTERMOST clickable in a nest (keep the card, drop its inner <p>)
      //   - capped
      {
        const alreadyMatched = new Set<Element>(collected);
        const MAX_CARDS = 16;
        const raw: Element[] = [];
        // Eligible tags: generic containers OR any custom element (hyphenated
        // tag).
        // 1inch onboarding renders each choice as a custom UI-kit element
        // (<uikit-internal-chip data-test-id="activity-chip-…">) with
        // cursor:pointer but no button/role/input semantics and no div/section
        // wrapper, so the SELECTOR walk AND the old div-only scan both missed
        // it, leaving the planner no clickable target.
        const isCardTag = (t: string): boolean =>
          t === "div" ||
          t === "li" ||
          t === "article" ||
          t === "section" ||
          t === "label" ||
          t.includes("-");
        // Walk the light DOM AND every open shadow root — a UI-kit chip can
        // live inside a web component's shadow tree.
        const scanRoot = (root: Document | ShadowRoot): void => {
          if (root == null || typeof root.querySelectorAll !== "function") return;
          for (const el of Array.from(root.querySelectorAll<HTMLElement>("*"))) {
            if (raw.length >= MAX_CARDS) break;
            const shadowRoot = shadowRootFor(el);
            if (shadowRoot !== null) scanRoot(shadowRoot);
            const tag = el.tagName.toLowerCase();
            if (!isCardTag(tag)) continue;
            if (alreadyMatched.has(el)) continue;
            if (!isVisible(el)) continue;
            if (window.getComputedStyle(el).cursor !== "pointer") continue;
            const r = el.getBoundingClientRect();
            if (r.width < 40 || r.height < 24 || r.width > 900 || r.height > 600) continue;
            const txt = clean(el.textContent);
            const hasText = txt !== null && txt.length >= 2 && txt.length <= 120;
            // A custom element whose label renders inside its shadow DOM has an
            // empty textContent — qualify it on a stable test-id instead, which
            // is exactly what a QA-instrumented chip carries.
            const testId =
              el.getAttribute("data-testid") ??
              el.getAttribute("data-test-id") ??
              el.getAttribute("data-test") ??
              el.getAttribute("data-cy") ??
              el.getAttribute("data-qa");
            const hasTestId = tag.includes("-") && testId !== null && testId.length > 0;
            if (!hasText && !hasTestId) continue;
            try {
              if (el.querySelector(SELECTOR) !== null) continue;
            } catch {
              continue;
            }
            raw.push(el);
          }
        };
        scanRoot(document);
        // Keep only the outermost clickable per nest (Chakra cards wrap an
        // inner <p>; cursor:pointer inherits, so both match — we want the card).
        const rawSet = new Set(raw);
        for (const el of raw) {
          let p = el.parentElement;
          let nested = false;
          while (p !== null) {
            if (rawSet.has(p)) {
              nested = true;
              break;
            }
            p = p.parentElement;
          }
          if (!nested) collected.push(el);
        }
      }

      const seen = new Set<Element>();
      // T38 — parent identity + bounding-box dimensions + clickable
      // bit, captured in lockstep with `out` so the Node-side
      // assignCardRadioGroups can detect card-radio clusters without
      // re-walking the DOM.
      const parentIds = new Map<Element, number>();
      let nextParentId = 0;
      const clusterMeta: Array<{
        parentId: number;
        width: number;
        height: number;
        clickable: boolean;
      }> = [];
      const out: Array<{
        tag: string;
        type: string | null;
        id: string | null;
        name: string | null;
        placeholder: string | null;
        ariaLabel: string | null;
        role: string | null;
        labelText: string | null;
        visibleText: string | null;
        selector: string;
        visible: boolean;
        inViewport: boolean;
        inConsentWidget: boolean;
        href: string | null;
        iconLabel: string | null;
        testId: string | null;
        title: string | null;
        landmark: string | null;
        value: string | null;
        checked: boolean | null;
        disabled: boolean | null;
        required: boolean | null;
        selectOptions: Array<{ value: string; text: string }> | null;
        selectedOptionText: string | null;
        interactedThisRun: boolean;
        screenPath: string | null;
        container: string | null;
        inDialog: boolean;
        containerId: number | null;
        formId: number | null;
        topmost: boolean | null;
        occludedBy: string | null;
        autocomplete: string | null;
        dataRole: string | null;
        cardMaskKind: CardMaskKind | null;
      }> = [];
      for (const el of collected) {
        if (seen.has(el)) continue;
        seen.add(el);
        if (!isVisible(el) && !isCheckableHiddenByStyledLabel(el)) continue;
        const r = el.getBoundingClientRect();
        // T38 — capture parent identity + dimensions in lockstep with
        // the `out.push` below. Pure scalars only; no DOM nodes leak
        // through serialization.
        const parent = el.parentElement;
        let parentId: number;
        if (parent === null) {
          parentId = -1;
        } else if (parentIds.has(parent)) {
          parentId = parentIds.get(parent) as number;
        } else {
          parentId = nextParentId++;
          parentIds.set(parent, parentId);
        }
        const tagLower = el.tagName.toLowerCase();
        const roleAttr = el.getAttribute("role");
        const clickable =
          tagLower === "button" ||
          tagLower === "a" ||
          tagLower === "label" ||
          roleAttr === "button" ||
          roleAttr === "link" ||
          roleAttr === "radio" ||
          roleAttr === "menuitem" ||
          roleAttr === "menuitemradio" ||
          roleAttr === "option" ||
          window.getComputedStyle(el).cursor === "pointer";
        clusterMeta.push({
          parentId,
          width: r.width,
          height: r.height,
          clickable,
        });
        // 0.8.3-rc.1 — Google Identity Services iframe special-case.
        // The iframe is cross-origin so el.textContent is empty,
        // but we know structurally it's a "Continue with Google"
        // affordance. Surface synthetic text so findOAuthButton
        // matches it and the OAuth-first scan picks it up.
        const isGoogleGSIIframe =
          el instanceof HTMLIFrameElement &&
          (el.getAttribute("src") ?? "").includes("accounts.google.com/gsi/button");
        const region = regionFor(el);
        const container = regionName(region);
        const containerId = regionId(region);
        const inDialog = nearestModalRegion(el) !== null;
        const formId = regionId(el.closest("form"));
        const status = topmostStatus(el);
        const pathLabel = isGoogleGSIIframe
          ? "Continue with Google"
          : isFormControlElement(el)
            ? (labelFor(el) ?? directLabel(el) ?? iconLabelFor(el))
            : (directLabel(el) ?? labelFor(el) ?? iconLabelFor(el));
        out.push({
          tag: isGoogleGSIIframe ? "button" : el.tagName.toLowerCase(),
          type: el.getAttribute("type"),
          id: el.getAttribute("id"),
          name: el.getAttribute("name"),
          placeholder: el.getAttribute("placeholder"),
          ariaLabel: isGoogleGSIIframe ? "Continue with Google" : el.getAttribute("aria-label"),
          role: isGoogleGSIIframe ? "button" : el.getAttribute("role"),
          labelText: labelFor(el),
          visibleText: isGoogleGSIIframe ? "Continue with Google" : clean(el.textContent),
          selector: selectorFor(el),
          visible: true,
          inViewport:
            r.top >= 0 &&
            r.left >= 0 &&
            r.bottom <= window.innerHeight &&
            r.right <= window.innerWidth,
          inConsentWidget: inConsent(el),
          href: (el.getAttribute("href") ?? "").slice(0, 300) || null,
          iconLabel: iconLabelFor(el),
          // The element's test-id, the GOLD-STANDARD stable anchor: authors set
          // data-testid/data-test/data-cy precisely so it survives refactors +
          // copy changes, which is exactly what text_match does not. Captured so
          // the synthesizer can prefer it over planner-gloss text. Common
          // variants folded to one field; first present wins.
          testId:
            el.getAttribute("data-testid") ??
            el.getAttribute("data-test-id") ??
            el.getAttribute("data-test") ??
            el.getAttribute("data-cy") ??
            el.getAttribute("data-qa") ??
            null,
          title: clean(el.getAttribute("title")),
          landmark: (() => {
            // F15 — nearest HTML5 landmark ancestor. Used by the
            // inventory renderer to disambiguate elements with the
            // same visibleText. Returns the lowercased tag name
            // ("header" / "main" / "footer" / "nav" / "aside" /
            // "article" / "section") or null when outside any.
            const lm = el.closest("header,main,footer,nav,aside,article,section");
            return lm !== null ? lm.tagName.toLowerCase() : null;
          })(),
          // Locale-stable role signals for money-path fill guards. Prefer
          // autocomplete over visible labels (labels flip under i18n).
          autocomplete: (el.getAttribute("autocomplete") ?? "").trim() || null,
          dataRole:
            (el.getAttribute("data-field-role") ?? el.getAttribute("data-role") ?? "").trim() ||
            null,
          cardMaskKind:
            el.getAttribute("data-ts-card-mask") === "pan" ||
            el.getAttribute("data-ts-card-mask") === "cvv"
              ? (el.getAttribute("data-ts-card-mask") as CardMaskKind)
              : null,
          value:
            el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
              ? el.value
              : el instanceof HTMLSelectElement
                ? el.value
                : null,
          // 0.8.3-rc.1 — checkbox/radio runtime state. `value` for a
          // checkbox is the static `value` attribute (defaults to
          // "on") regardless of whether it's currently ticked, so any
          // caller wanting to find UNCHECKED checkboxes needs `checked`
          // explicitly. The submit-disabled re-plan hint uses this to
          // surface concrete unticked candidates to the planner.
          checked:
            el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")
              ? el.checked
              : null,
          disabled:
            el.matches(":disabled") || el.getAttribute("aria-disabled") === "true" ? true : null,
          required:
            el.matches(":required") || el.getAttribute("aria-required") === "true" ? true : null,
          // For <select>: the currently-selected option's visible text
          // and a short list of available option labels. The combination
          // is how the planner detects the "React-defaulted dropdown"
          // pattern that broke Railway — `value=""` + a first option
          // whose text reads as a placeholder ("No workspace", "Select
          // …", "Choose …") means the user (or bot) has not yet
          // committed a choice and React form state still treats the
          // field as untouched. The planner needs that signal to issue
          // a `select` step before clicking submit. Limit to 8 options
          // — long pickers (countries, timezones) would otherwise blow
          // the inventory rendering.
          selectOptions:
            el instanceof HTMLSelectElement
              ? Array.from(el.options)
                  .slice(0, 8)
                  .map((o) => ({
                    value: o.value,
                    text: clean(o.textContent) ?? "",
                  }))
              : null,
          selectedOptionText:
            el instanceof HTMLSelectElement
              ? clean(el.options[el.selectedIndex]?.textContent ?? null)
              : null,
          interactedThisRun: el.getAttribute("data-ts-touched") === "1",
          screenPath:
            `${container ?? "body:root"} > ${elementKind(el)}:` +
            slug(pathLabel, `${elementKind(el)}-${out.length}`),
          container,
          inDialog,
          containerId,
          formId,
          topmost: status.topmost,
          occludedBy: status.occludedBy,
        });
      }
      return { out, clusterMeta, documentOrigin: location.origin };
    });
  }

  private framePath(frame: Frame): string {
    const indexes: number[] = [];
    let current: Frame | null = frame;
    while (current !== null) {
      const parent = current.parentFrame();
      if (parent === null) break;
      const index = parent.childFrames().indexOf(current);
      if (index < 0) return "";
      indexes.unshift(index);
      current = parent;
    }
    return indexes.join("/");
  }

  /**
   * A rendered 3-D Secure challenge, or null. URL/ACS markers plus frame and
   * rendered-text signals; captcha frames are fraud checks, never
   * authentication. Detection is read-only — it never clears, advances, waits
   * on, or takes custody of the challenge.
   */
  async detectThreeDsChallenge(page: Page | null = this.page): Promise<{ url: string } | null> {
    if (page === null) return null;
    // Cross-processor markers (CardinalCommerce backs many processors, not
    // just Stripe): the URL/ACS path, the structural forms/frames, and the
    // rendered challenge copy. The URL pattern is module-level
    // (threeDsChallengeUrlPattern) so tests can pin the ACS paths it covers.
    const challengeText =
      /\b(?:3d secure|authenticate (?:this )?payment|verify (?:your )?identity|security code sent to)\b/i;
    for (const frame of page.frames()) {
      if (this.frameWithinCaptcha(frame)) continue;
      const url = frame.url();
      if (threeDsChallengeUrlPattern.test(url)) return { url };
      const structural = await frame
        .locator(
          'iframe[title*="3d secure" i],form[action*="acs" i],form:has(input[name="creq" i]),form[name="credit3d2FepBuyAuthenticateActionForm" i],form:has(input[name="md" i]):has([name="resSumbitButtonId" i],#resSumbitButtonId)',
        )
        .first()
        .isVisible()
        .catch(() => false);
      if (structural) return { url: url || page.url() };
      const text = await frame.evaluate(extractObservationVisibleText).catch(() => "");
      if (challengeText.test(text) || /本人認証/u.test(text)) {
        return { url: url || page.url() };
      }
    }
    return null;
  }

  private frameWithinCaptcha(frame: Frame): boolean {
    let current: Frame | null = frame;
    while (current !== null) {
      if (isCaptchaFrameUrl(current.url())) return true;
      current = current.parentFrame();
    }
    return false;
  }

  // The frame's own URL origin — plain metadata used for the x=s / x=x compact
  // fact and for the stale-frame-target check in resolveFrameElement. A frame's
  // origin never makes it unreachable: every frame captureBrowserUseDOM can
  // attach to is captured and addressable, and the released-card output mask
  // still covers every emitted value.
  private frameOrigin(frame: Frame): string {
    return frameOriginOf(frame);
  }

  // Resolve a previously-tagged frame path back to its live Playwright Frame —
  // used by the frame-aware act helpers below (clickInFrame/typeInFrame/
  // clickViaJsInFrame/selectInFrame) to act on an element that
  // extractInteractiveElements found inside a child <iframe>. Returns null
  // when the frame has since navigated or detached (a fresh observe/extract
  // picks up whatever replaced it); the
  // caller surfaces that as a normal "target not found" error, never a
  // silent wrong-frame action.
  private resolveFrame(target: FrameTarget, page: Page | null = this.page): Frame | null {
    if (page === null) return null;
    let frame = page.mainFrame();
    for (const part of target.framePath.split("/")) {
      if (!/^\d+$/.test(part)) return null;
      const child = frame.childFrames()[Number.parseInt(part, 10)];
      if (child === undefined) return null;
      frame = child;
    }
    if (frame.isDetached()) return null;
    return frame;
  }

  private async resolveFrameElement(
    target: FrameTarget,
    selector: string,
    index = 0,
    page: Page | null = this.page,
  ): Promise<ElementHandle<Element> | null> {
    const handle = await this.resolveFrameElementInFrame(
      this.resolveFrame(target, page),
      target,
      selector,
      index,
      page,
    );
    if (handle !== null) return handle;
    // Hosted-field providers (Braintree, PayPal, Stripe Elements) remount
    // their card <iframe>s after the first input; Playwright then appends the
    // replacement to the parent's childFrames() list, so the positional path
    // recorded at observation time no longer addresses the live frame. The
    // remount keeps the iframe's src: re-resolve by exact frame URL at write
    // time. The origin check inside the per-frame resolution still guards
    // every candidate, so this can never land in a foreign-origin frame.
    if (page === null || target.frameUrl === undefined || target.frameUrl === "") return null;
    for (const frame of page.frames()) {
      if (frame === page.mainFrame() || frame.isDetached()) continue;
      if (frame.url() !== target.frameUrl) continue;
      const byUrl = await this.resolveFrameElementInFrame(frame, target, selector, index, page);
      if (byUrl !== null) return byUrl;
    }
    return null;
  }

  // Resolve a selector inside ONE candidate frame; null when the frame is
  // gone, captcha-scoped, or no longer holds the expected origin.
  private async resolveFrameElementInFrame(
    frame: Frame | null,
    target: FrameTarget,
    selector: string,
    index: number,
    page: Page | null,
  ): Promise<ElementHandle<Element> | null> {
    if (page === null) return null;
    if (frame === null || this.frameWithinCaptcha(frame)) return null;
    const handle = await frame
      .locator(selector)
      .nth(Math.max(0, Math.floor(index)))
      .elementHandle({ timeout: 8000 })
      .catch(() => null);
    if (handle === null) return null;
    try {
      const origin = this.frameOrigin(frame);
      // A hosted-field remount can leave the OLD frame momentarily enumerable
      // (not yet isDetached()) with its former input still resolvable but no
      // longer in a document. Reading/writing that node silently reports an
      // empty value, so a disconnected element must resolve to null and let
      // the URL fallback find the live frame.
      const connected = await handle.evaluate((element) => element.isConnected);
      if (!connected || origin !== target.frameOrigin) {
        await handle.dispose().catch(() => undefined);
        return null;
      }
      return handle;
    } catch {
      await handle.dispose().catch(() => undefined);
      return null;
    }
  }

  private frameLabel(target: FrameTarget): string {
    return target.frameOrigin;
  }

  // Frame-scoped click. Deliberately simpler than click() above (no radio/
  // checkbox/aria-toggle special-casing) — it's the escape hatch for a
  // control that lives inside an <iframe>, mirroring how resolvePageTarget is
  // the escape hatch for a control missing from the main-frame inventory.
  // Plain Playwright locator actions cover the money-path case this exists
  // for (a merchant's own same-domain checkout options rendered in an
  // iframe), using the same cross-origin frame resolution as other direct
  // frame-targeted actions.
  async clickInFrame(
    target: FrameTarget,
    selector: string,
    page: Page | null = this.page,
  ): Promise<void> {
    const handle = await this.resolveFrameElement(target, selector, 0, page);
    if (handle === null) {
      throw new Error(
        `click: the target's frame is no longer present (${this.frameLabel(target)})`,
      );
    }
    try {
      // Derive the frame from the already-validated handle rather than
      // re-resolving the index-based frame path: child-frame indices can
      // shift during the intervening async security checks, and neutralize +
      // restore must run against the document the handle actually lives in.
      const frame = await handle.ownerFrame();
      if (frame === null) {
        await handle.click({ timeout: 8000 });
      } else {
        await this.neutralizeModalInert(handle, frame, () => handle.click({ timeout: 8000 }));
      }
    } finally {
      await handle.dispose().catch(() => undefined);
    }
  }

  async clickViaJsInFrame(
    target: FrameTarget,
    selector: string,
    index = 0,
    page: Page | null = this.page,
  ): Promise<void> {
    const handle = await this.resolveFrameElement(target, selector, index, page);
    if (handle === null) {
      throw new Error(
        `js_click: the target's frame is no longer present (${this.frameLabel(target)})`,
      );
    }
    try {
      await handle.evaluate((el) => (el as HTMLElement).click());
    } finally {
      await handle.dispose().catch(() => undefined);
    }
  }

  // Frame-scoped type/fill, for type and (guarded, see provision-session.ts)
  // type_secret targets that resolve into a frame. Same humanized-vs-fast
  // split as type() above, without the multi-input-OTP auto-advance nuance —
  // out of scope for the checkout-option case this exists for.
  async typeInFrame(
    target: FrameTarget,
    selector: string,
    text: string,
    sealed = false,
    page: Page | null = this.page,
  ): Promise<void> {
    const handle = await this.resolveFrameElement(target, selector, 0, page);
    if (handle === null) {
      throw new Error(`type: the target's frame is no longer present (${this.frameLabel(target)})`);
    }
    try {
      await handle.waitForElementState("visible", { timeout: 10000 });
      const frame = await handle.ownerFrame();
      if (frame === null) throw new Error("type target has no owning frame");
      await markOperatorMutationDispatchAttempted();
      if (sealed) {
        await handle.evaluate((el) => el.setAttribute("data-ts-sealed-payment", "1"));
      }
      if (!this.humanize) {
        await handle.fill(text);
        return;
      }
      await handle.click({ timeout: 8000 }).catch(() => undefined);
      await this.typeWithRealKeys(frame.locator(selector).first(), text);
    } finally {
      await handle.dispose().catch(() => undefined);
    }
  }

  // Frame-scoped native-<select> pick. Deliberately narrower than
  // selectOption() above (no custom-combobox path, no row-scan label
  // heuristics — only the direct label→control association): the escape
  // hatch exists for a merchant's own checkout dropdowns rendered inside an
  // <iframe>, which are native selects. Resolution + option match + commit +
  // input/change dispatch all happen in ONE in-frame evaluate, so a frame
  // DOM that re-renders between round-trips can't strand the action halfway.
  async selectInFrame(
    target: FrameTarget,
    selector: string,
    optionMatcher?: string,
    page: Page | null = this.page,
  ): Promise<string> {
    const handle = await this.resolveFrameElement(target, selector, 0, page);
    if (handle === null) {
      throw new Error(
        `select: the target's frame is no longer present (${this.frameLabel(target)})`,
      );
    }
    try {
      await markOperatorMutationDispatchAttempted();
      const result = await handle.evaluate(
        (element, needle) => {
          let control: Element | null = element;
          if (control instanceof HTMLLabelElement) control = control.control;
          if (!(control instanceof HTMLSelectElement)) {
            return {
              ok: false as const,
              reason:
                `target resolves to <${(control ?? element).tagName.toLowerCase()}>, not a ` +
                `native <select> — only native selects are supported inside a frame ` +
                `(drive a custom widget with click)`,
            };
          }
          const options = Array.from(control.options);
          if (options.length === 0) {
            return { ok: false as const, reason: "the <select> has no selectable option" };
          }
          // Same default as the main-frame path: first NON-empty value when
          // no matcher is given ("Select…" placeholders are the wrong pick).
          let chosen = options.find((option) => option.value.length > 0) ?? options[0]!;
          if (needle !== null) {
            // Same contract as the main-frame path: exact text wins, a
            // substring fallback only when unique, ambiguity refuses loudly
            // (see selectOptionInner).
            const text = (option: HTMLOptionElement): string =>
              (option.textContent ?? "").replace(/\s+/g, " ").trim().toLowerCase();
            const exact = options.find((option) => text(option) === needle);
            if (exact !== undefined) {
              chosen = exact;
            } else {
              const partial = options.filter((option) => text(option).includes(needle));
              const only = partial[0];
              if (partial.length === 1 && only !== undefined) {
                chosen = only;
              } else if (partial.length > 1) {
                return {
                  ok: false as const,
                  reason: `option text is ambiguous (${partial
                    .slice(0, 6)
                    .map((option) => JSON.stringify((option.textContent ?? "").trim()))
                    .join(", ")}) — pass the exact option text`,
                };
              } else {
                return { ok: false as const, reason: "no option matched" };
              }
            }
          }
          control.value = chosen.value;
          if (control.value !== chosen.value) {
            return { ok: false as const, reason: "selected value did not stick" };
          }
          // Playwright's own selectOption fires input+change natively — the
          // merchant form listens on these; mirror it.
          control.dispatchEvent(new Event("input", { bubbles: true }));
          control.dispatchEvent(new Event("change", { bubbles: true }));
          // Same touched-marker as the main-frame path (DEFAULTED-dropdown
          // warning suppression).
          control.setAttribute("data-ts-touched", "1");
          return {
            ok: true as const,
            text: (chosen.textContent ?? "").replace(/\s+/g, " ").trim(),
          };
        },
        optionMatcher !== undefined
          ? optionMatcher.replace(/\s+/g, " ").trim().toLowerCase()
          : null,
      );
      if (!result.ok) {
        const detail =
          result.reason === "no option matched" && optionMatcher !== undefined
            ? `no option matched ${JSON.stringify(optionMatcher)}`
            : result.reason;
        throw new Error(`select (frame ${this.frameLabel(target)}) ${selector}: ${detail}`);
      }
      return result.text;
    } finally {
      await handle.dispose().catch(() => undefined);
    }
  }

  async injectCardIntoTargets(
    card: CheckoutCard,
    targets: Partial<Record<InjectCardField, InjectCardResolvedTarget>>,
    page: Page | null = this.page,
    // Optional live resolver. When supplied, every field is resolved HERE, at
    // its own write step, instead of from the caller's shared snapshot: the
    // resolver re-extracts the page on every call, so a hosted-field frame
    // that was mid-remount a moment ago is seen in its settled state. Tests
    // that hand in pre-resolved elements omit it and keep the old behaviour.
    resolveTargetAtWriteTime?: (field: InjectCardField) => Promise<InjectCardResolvedTarget>,
  ): Promise<Record<InjectCardField, InjectCardFieldResult>> {
    if (page === null) throw new Error("Browser not started");
    // The mask is session-persistent and must exist before the first field write.
    this.registerCardValueOutputMask(card);
    const results = {} as Record<InjectCardField, InjectCardFieldResult>;
    // The element each field actually resolved to at its write step. Later
    // verification reads THIS, not the caller's one-shot snapshot.
    const resolvedTargets: Partial<Record<InjectCardField, InjectCardResolvedTarget>> = {};
    const valueFor = (field: InjectCardField, format?: string): string => {
      switch (field) {
        case "pan":
          return format === "groups4" ? card.pan.replace(/(.{4})(?=.)/g, "$1 ") : card.pan;
        case "cvv":
          return card.cvv;
      }
    };
    const resolveInjectTarget = async (
      element: InteractiveElement,
    ): Promise<ElementHandle<Element> | null> =>
      element.framePath === null || element.framePath === undefined
        ? await page
            .locator(element.selector)
            .elementHandle({ timeout: 3_000 })
            .catch(() => null)
        : await this.resolveFrameElement(
            {
              framePath: element.framePath,
              frameOrigin: element.frameOrigin ?? "null",
              frameUrl: element.frameUrl ?? "",
            },
            element.selector,
            0,
            page,
          );
    const fillField = async (field: InjectCardField): Promise<InjectCardFieldResult> => {
      // Resolve at write time. A miss is retried on a bounded window rather
      // than reported on first glance; `detached` (the ref was live in the
      // last observation, so its frame is remounting) and `not_found` (never
      // observed) both retry, and the distinction survives into the status.
      let target: InjectCardResolvedTarget;
      if (resolveTargetAtWriteTime === undefined) {
        target = targets[field]!;
      } else {
        target = await resolveTargetAtWriteTime(field);
        const deadline = Date.now() + CARD_FIELD_RESOLVE_WINDOW_MS;
        while (target.element === undefined && Date.now() < deadline) {
          await page.waitForTimeout(CARD_FIELD_RESOLVE_RETRY_MS);
          target = await resolveTargetAtWriteTime(field);
        }
      }
      resolvedTargets[field] = target;
      if (target.element === undefined) {
        return { status: target.missing ?? "not_found" };
      }
      const element = target.element;
      if (field === "pan" || field === "cvv") {
        this.cardValueOutputMask.registerTarget({
          kind: field,
          selector: element.selector,
          framePath: element.framePath ?? null,
        });
      }
      let handle: ElementHandle<Element> | null = null;
      try {
        handle = await resolveInjectTarget(element);
        if (handle === null) {
          return { status: "detached" };
        }
        await markOperatorMutationDispatchAttempted();
        if (field === "pan" || field === "cvv") {
          await handle.evaluate(
            (node, value) => node.setAttribute("data-ts-card-mask", value),
            field,
          );
        }
        const value = valueFor(field, target.format);
        const tag = await handle.evaluate((node) => node.tagName.toLowerCase());
        if (tag === "select") {
          const owner = await handle.ownerFrame();
          if (owner === null) throw new Error("target has no owning frame");
          const selector = element.selector;
          const select = owner.locator(selector);
          try {
            await select.selectOption({ value }, { timeout: 3_000 });
          } catch {
            await select.selectOption({ label: value }, { timeout: 3_000 });
          }
        } else {
          // A hosted-field client is a script watching its own input: a
          // one-shot fill() sets the value with no key events and can leave
          // the provider treating the field as invalid even though the DOM
          // value looks right (the Oura/Braintree card-number input reported
          // filled, then carried invalid=true and the order failed). Type
          // through the same real-key path ordinary field typing uses, so
          // the page sees normal key events. The value still goes straight
          // from the vault into the page — never into a tool result or log.
          const owner = await handle.ownerFrame();
          if (owner === null) throw new Error("target has no owning frame");
          await this.typeWithRealKeys(owner.locator(element.selector).first(), value, {
            timeoutMs: CARD_FIELD_WRITE_TIMEOUT_MS,
          });
        }
        return { status: "filled" };
      } catch (error) {
        return {
          status: "native_error",
          error: this.cardValueOutputMask.maskText(
            error instanceof Error ? error.message : String(error),
          ),
        };
      } finally {
        await handle?.dispose().catch(() => undefined);
      }
    };
    // ONE uninterrupted pass over every targeted field. Expiry and cardholder
    // name are NOT secret and are not inject_card fields: the agent fills
    // them with ordinary operate_type/operate_select, or places the masked
    // per-digit card tokens ({{pan}}, {{cvv}}, {{pan:N}}, {{cvv:N}}) itself.
    const attempted: InjectCardField[] = [];
    for (const field of ["pan", "cvv"] as const) {
      if (targets[field] === undefined) {
        results[field] = { status: "not_found" };
        continue;
      }
      // Requested but not natively resolved before this point is still
      // attempted: fillField resolves it now and retries within its window.
      attempted.push(field);
      results[field] = await fillField(field);
    }
    if (attempted.length > 0) {
      // Hosted-field providers (Braintree) rebuild every card frame after the
      // first input into any one field — asynchronously from the writes that
      // triggered the rebuild — and a rebuilt frame reopens EMPTY. A per-field
      // "filled" that does not survive to submit is a lie the caller cannot
      // detect, so the pass ends by re-reading every written value INSIDE its
      // live frame (the read returns a boolean; card values never leave the
      // frame) and re-filling whatever the rebuild cleared — all within this
      // same call. Two consecutive clean verifications, separated by a settle
      // that lets an in-flight rebuild land, mean the values are stable.
      // Several targeted fields can resolve to ONE element (e.g. a combined
      // card box addressed as both pan and cvv): each element is verified
      // against its LAST-written value, and a stale element re-fills its
      // fields in write order so the last write governs.
      const groups = new Map<string, InjectCardField[]>();
      for (const field of attempted) {
        const element = resolvedTargets[field]?.element;
        if (element === undefined) continue;
        const key =
          element.framePath === null || element.framePath === undefined
            ? `main|${element.selector}`
            : `frame|${element.framePath}|${element.frameUrl ?? ""}|${element.selector}`;
        const members = groups.get(key);
        if (members === undefined) groups.set(key, [field]);
        else members.push(field);
      }
      // Normalise ONLY formatting separators, on BOTH sides, then require
      // equality. This keeps the legitimate reformat (a card number the page
      // rewrites with spaces or dashes as you type) while refusing the loose
      // match that let `filled` be a lie: a superset, a truncation, a doubled
      // value, or any non-separator content the field does not hold fails.
      const holdsValue = async (field: InjectCardField): Promise<boolean> => {
        const target = resolvedTargets[field];
        if (target?.element === undefined) return false;
        const handle = await resolveInjectTarget(target.element);
        if (handle === null) return false;
        try {
          const expected = valueFor(field, target.format);
          return await handle.evaluate((node, expected) => {
            const control = node as HTMLInputElement | HTMLSelectElement;
            const actual = control.value ?? "";
            const normalize = (value: string) => value.replace(/[\s\-/.]+/g, "");
            return normalize(actual) === normalize(expected);
          }, expected);
        } catch {
          return false;
        } finally {
          await handle.dispose().catch(() => undefined);
        }
      };
      const refillBudget = new Map<InjectCardField, number>(
        attempted.map((f) => [f, 2] as [InjectCardField, number]),
      );
      const refill = async (field: InjectCardField): Promise<void> => {
        if ((refillBudget.get(field) ?? 0) <= 0) return;
        refillBudget.set(field, (refillBudget.get(field) ?? 0) - 1);
        results[field] = await fillField(field);
      };
      let cleanRounds = 0;
      for (let round = 0; round < 4 && cleanRounds < 2; round++) {
        await page.waitForTimeout(300);
        // Writes that never landed (frame mid-rebuild at write time) get
        // another attempt before the value check.
        for (const field of attempted) {
          if (results[field].status !== "filled") await refill(field);
        }
        const stale: InjectCardField[] = [];
        for (const members of groups.values()) {
          const last = members[members.length - 1]!;
          if (results[last].status !== "filled" || !(await holdsValue(last))) {
            stale.push(...members);
          }
        }
        if (stale.length === 0) {
          cleanRounds++;
          continue;
        }
        cleanRounds = 0;
        for (const field of stale) await refill(field);
      }
      // Still not holding after the bounded pass: report it — "filled" would
      // be the lie this verification exists to prevent.
      for (const members of groups.values()) {
        const last = members[members.length - 1]!;
        if (results[last].status === "filled" && !(await holdsValue(last))) {
          for (const field of members) {
            results[field] = {
              status: "cleared",
              error: "value did not survive in the live frame",
            };
          }
        }
      }
    }
    return results;
  }

  async extractInteractiveElements(page: Page | null = this.page): Promise<InteractiveElement[]> {
    if (page === null) throw new Error("Browser not started");
    const mainRaw = await this.extractElementsFromContext(page);
    const mainGroups = assignCardRadioGroups(mainRaw.clusterMeta);
    const mainElements = mainRaw.out.map((e, i) => ({
      ...e,
      cardRadioGroup: mainGroups[i] ?? null,
      frameOrigin: null,
      frameUrl: null,
      framePath: null,
    }));

    // Cross-frame support — surface elements inside child <iframe>s (same- AND
    // cross-origin), each tagged with the frame's own origin/url so direct
    // observation and action can address the correct document. Nothing is
    // flattened away: every frame element keeps its origin.
    // page.frames() is already flat (it includes nested frames, not just
    // direct children) and reaches cross-origin hosted-field content.
    const framedElements: Array<Omit<InteractiveElement, "index">> = [];
    for (const frame of page.frames()) {
      if (frame === page.mainFrame() || frame.isDetached()) continue;
      const frameUrl = frame.url();
      // Captcha challenge iframes are handled by the dedicated captcha-gate
      // flow, not by ordinary ref-based clicking — surfacing their internal
      // DOM as el_table rows would invite the planner to poke at the
      // challenge instead of going through that flow. Skip them; nothing
      // else about captcha handling changes.
      if (this.frameWithinCaptcha(frame)) continue;
      try {
        const raw = await this.extractElementsFromContext(frame);
        const frameOrigin = this.frameOrigin(frame);
        const groups = assignCardRadioGroups(raw.clusterMeta);
        for (const [i, e] of raw.out.entries()) {
          framedElements.push({
            ...e,
            cardRadioGroup: groups[i] ?? null,
            frameOrigin,
            frameUrl,
            framePath: this.framePath(frame),
          });
        }
      } catch {
        // Cross-origin frame mid-navigation, torn down, or otherwise
        // unreachable this instant — best-effort; the next observe retries.
      }
    }

    // T38 index is assigned ONCE, after merging, so it stays a stable,
    // collision-free ordinal across the whole combined set.
    return this.cardValueOutputMask.maskInteractiveElements(
      [...mainElements, ...framedElements].map((e, i) => ({ ...e, index: i })),
    );
  }

  // checkout-leg-signature — the checkout-leg shape signature
  // (checkoutFieldSetSignature, formerly in @trusty-squire/recipe-schema) is computed
  // from a page's FULL field-name set, deliberately including `type=hidden`
  // fields — unlike extractInteractiveElements above (which deliberately
  // skips hidden/password inputs, since those aren't things a planner can
  // act on), a checkout platform's own hidden session/GraphQL-serialized
  // fields are exactly the stable, platform-authored signal the signature
  // depends on. Reads every input/select/textarea's `name` (falling back to
  // `id`) with a single flat query — no visibility/shadow-DOM handling,
  // matching the method proven in the field-name-set discriminator report.
  async extractCheckoutFieldNames(page: Page | null = this.page): Promise<string[]> {
    if (!page) throw new Error("Browser not started");
    return await page.evaluate(() => {
      const names: string[] = [];
      document.querySelectorAll("input,select,textarea").forEach((el) => {
        const name = el.getAttribute("name") ?? el.getAttribute("id") ?? "";
        if (name.length > 0) names.push(name);
      });
      return names;
    });
  }

  // Resolve a selector against the live page for the verify step
  // (F3 T5). Returns the match count plus the first match's
  // tag/id/name so the caller can confirm a still-resolving selector
  // points at the element it was extracted from (not a recycled
  // node). An invalid selector (e.g. a stray `:contains()`) is caught
  // and reported as count 0 — never an uncaught throw.
  async inspectSelector(
    selector: string,
  ): Promise<{ count: number; tag: string | null; id: string | null; name: string | null }> {
    if (!this.page) throw new Error("Browser not started");
    try {
      const loc = this.page.locator(selector);
      const count = await loc.count();
      if (count === 0) return { count: 0, tag: null, id: null, name: null };
      const info = await loc.first().evaluate((el) => ({
        tag: el.tagName.toLowerCase(),
        id: el.getAttribute("id"),
        name: el.getAttribute("name"),
      }));
      return { count, tag: info.tag, id: info.id, name: info.name };
    } catch {
      return { count: 0, tag: null, id: null, name: null };
    }
  }

  currentUrl(): string {
    return this.pageDriver.currentUrl();
  }
  activePage(): Page | null {
    return this.page;
  }
  recoverActivePage(): boolean {
    return this.pageDriver.recoverActivePage();
  }
  returnFromClosedPopup(page: Page): Page | null {
    return this.pageDriver.returnFromClosedPopup(page);
  }
  armOpenedTabAdoption(): void {
    return this.pageDriver.armOpenedTabAdoption();
  }
  async adoptOpenedTab(graceMs = 0): Promise<string | null> {
    return await this.pageDriver.adoptOpenedTab(graceMs);
  }
  adoptLivePage(): boolean {
    return this.pageDriver.adoptLivePage();
  }

  // Press a keyboard key (e.g. "Escape" to dismiss a focus-trapped modal that
  // exposes no in-DOM close control). Best-effort. Used by the nav-search
  // overlay handler's dismiss fallback.
  async focusedElementLabels(page: Page | null = this.page): Promise<string[]> {
    if (!page) return [];
    const labels: string[] = [];
    for (const frame of page.frames()) {
      const frameLabels = await frame
        .evaluate(() => {
          const element = document.activeElement;
          if (!(element instanceof HTMLElement) || element === document.body) return [];
          const associatedLabels =
            element instanceof HTMLInputElement ||
            element instanceof HTMLButtonElement ||
            element instanceof HTMLSelectElement ||
            element instanceof HTMLTextAreaElement
              ? Array.from(element.labels ?? [], (label) => label.innerText)
              : [];
          const values = [
            element.getAttribute("aria-label") ?? "",
            element instanceof HTMLInputElement ? element.value : "",
            element.innerText ?? "",
            ...associatedLabels,
          ];
          return values.map((value) => value.replace(/\s+/g, " ").trim()).filter(Boolean);
        })
        .catch(() => []);
      labels.push(...frameLabels);
    }
    return [...new Set(labels)];
  }

  // Fetch a URL's final response (following redirects) and return its
  // status, final URL, and body text — or null on any failure.
  //
  // WHY the CONTEXT request API (this.context.request) and not global
  // fetch / a fresh node http client: the context's APIRequestContext
  // shares the BrowserContext's proxy + cookie jar, so this egresses
  // through the SAME residential tunnel the real navigation uses. That
  // makes a probe here representative of what the browser would actually
  // land on (same IP reputation, same cf_clearance cookie) — and needs no
  // separate SOCKS/HTTP-proxy plumbing. Used by the signup-URL resolver to
  // distinguish a stale /signup that serves a login SPA from the real
  // signup form, BEFORE committing to a ~6-minute navigation.
  //
  // Bounded (15s, ≤10 redirects) and non-throwing — the resolver treats
  // null as "couldn't tell" and escalates.
  async fetchText(
    url: string,
  ): Promise<{ finalUrl: string; status: number; bodyText: string } | null> {
    if (this.context === null) return null;
    try {
      const response = await this.context.request.get(url, {
        maxRedirects: 10,
        timeout: 15_000,
        // We inspect 404/redirect bodies ourselves; don't let a non-2xx
        // throw before we can classify it.
        failOnStatusCode: false,
      });
      return {
        finalUrl: response.url(),
        status: response.status(),
        bodyText: await response.text(),
      };
    } catch {
      return null;
    }
  }

  // True when the active OAuth page is gone — for the popup flow, the

  async close(options: { cancelStart?: boolean } = {}): Promise<ProfileCloseState> {
    if (this.isSatelliteAttachment) return await this.closeOwnPagesOnly();
    return await this.processOwner.close(options);
  }
  async waitForCancelledStartQuiescence(): Promise<void> {
    if (this.isSatelliteAttachment) return;
    return await this.processOwner.waitForCancelledStartQuiescence();
  }
  async forceCloseOwnedProcessTree(): Promise<ProfileCloseState> {
    if (this.isSatelliteAttachment) return await this.closeOwnPagesOnly();
    return await this.processOwner.forceCloseOwnedProcessTree();
  }
}

// Random integer in [min, max]. We use Math.random() (not crypto)
// because these values are used for timing only — predictability
// isn't a security concern. The shape of the distribution matters
// for behavior scoring, but uniform-in-range is close enough to the
// human distribution that scorers can't reliably distinguish.
function rand(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min + 1));
}

// Score signup-form submit candidates by visible text; return the index
// of the best, or null when none scores positive. Signup pages commonly
// render OAuth buttons ("Continue with Google" / "GitHub") as
// button[type=submit] next to the real account-creation button, so a
// generic selector resolves to several — this picks the right one.
//
// Same shape and rationale as the verification-link picker: a positive
// score gate so an OAuth-only page (every candidate negative) returns
// null rather than mis-clicking "Continue with Google".
// Click disambiguation (regression: #61 weaviate). A bare id selector can
// resolve to >1 element — Descope's <descope-button> stamps the same
// generated id on the web component AND its inner text node — which trips
// Playwright strict mode before the click. When the selector isn't unique,
// narrow to the first match (Playwright's documented click disambiguation).
// Exported so the decision is unit-tested without a live page.
export function pickClickLocator<L extends { first(): L }>(locator: L, count: number): L {
  return count > 1 ? locator.first() : locator;
}

// ───────────── phone-country widget selection ─────────────
//
// International checkouts may back their phone-country picker with an
// opacity:0 native <select> that the inventory walker omits. These helpers
// classify the requested country and match it against those native options.

// A phone-country request classified into the strongest available signal. The
// operator passes ONE string; we infer whether it's a dial code ("+81" / "81"),
// an ISO2 alpha-2 code ("JP"), or a country name ("Japan"). Kept mutually
// exclusive so the matcher never fuzzy-matches an exact-signal query on text.
export interface PhoneCountryQuery {
  // Digits only, no "+". Set when the input parsed as a dial code.
  dialCode?: string;
  // Upper-case alpha-2. Set when the input parsed as an ISO2 code.
  iso2?: string;
  // Lower-cased free text for substring matching. Set for a country name.
  name?: string;
}

// One native phone-country option normalized for matching.
export interface PhoneCountryOption {
  // `| undefined` (not just optional) because the page.evaluate reads produce
  // explicit undefined for absent fields, and the repo runs
  // exactOptionalPropertyTypes — a bare `text?: string` would reject it.
  text?: string | undefined;
  iso2?: string | undefined;
  dialCode?: string | undefined;
}

// Classify the operator's single country argument. WHY exact-signal buckets:
// "+1" is a dial code, "US" an ISO2, "United States" a name — matching each
// against the wrong DOM attribute (e.g. substring-matching "US" against option
// text) produces false hits, so we commit to one interpretation per input.
export function classifyPhoneCountryQuery(raw: string): PhoneCountryQuery {
  const t = raw.trim();
  if (t.length === 0) return {};
  // Dial code: an optional leading "+" then 1-4 digits and nothing else.
  if (/^\+?\d{1,4}$/.test(t)) return { dialCode: t.replace(/\D/g, "") };
  // ISO2: exactly two ASCII letters. Almost always an alpha-2 country code
  // ("JP", "US"); a two-letter country NAME doesn't exist, so this is safe.
  if (/^[A-Za-z]{2}$/.test(t)) return { iso2: t.toUpperCase() };
  // Otherwise a free-text country name for case-insensitive substring match.
  return { name: t.toLowerCase() };
}

// Decide whether a picker option satisfies the query. Exact-signal queries
// (iso2/dialCode) match ONLY against the corresponding structured field (with
// a dial-code fallback to a "+NN" embedded in native option text). A name query is a
// case-insensitive substring test against the option's visible text.
export function phoneCountryOptionMatches(
  query: PhoneCountryQuery,
  opt: PhoneCountryOption,
): boolean {
  const digits = (s: string): string => s.replace(/\D/g, "");
  if (query.iso2 !== undefined) {
    return opt.iso2 !== undefined && opt.iso2.toUpperCase() === query.iso2;
  }
  if (query.dialCode !== undefined) {
    if (opt.dialCode !== undefined && digits(opt.dialCode) === query.dialCode) return true;
    if (opt.text !== undefined) {
      const m = opt.text.match(/\+(\d{1,4})/);
      if (m !== null && m[1] === query.dialCode) return true;
    }
    return false;
  }
  if (query.name !== undefined) {
    return opt.text !== undefined && opt.text.toLowerCase().includes(query.name);
  }
  return false;
}

// Index of the first option matching the query, or -1. Extracted so the
// pick-a-row decision is unit-tested independently of the DOM read.
export function pickPhoneCountryOption(
  query: PhoneCountryQuery,
  options: readonly PhoneCountryOption[],
): number {
  return options.findIndex((o) => phoneCountryOptionMatches(query, o));
}

// ───────────── element inventory (F3) ─────────────

// One interactive element the planner can target. `selector` is
// computed by the bot from the live DOM, so it is known to resolve —
// the planner PICKS from these rather than inventing selector
// strings (the bug behind the 0/14 sweep). `index` is assigned after
// ranking, so it is a stable handle for the planner to reference.
export interface CompactControlNames {
  ariaLabel: string | null;
  labelledByText: string | null;
  accessibleName: string | null;
  labelText: string | null;
  visibleText: string | null;
  alt: string | null;
  iconLabel: string | null;
  title: string | null;
  placeholder: string | null;
  name: string | null;
  value: string | null;
  container: string | null;
}

export interface InteractiveElement {
  /** Private CDP node identity; never a page-authored attribute or wire ref. */
  observationIdentity?: string;
  /** Full material intent captured with that node, excluding transient state. */
  observationIntent?: string;
  /** Physical owner evidence for live checks; excluded from durable re-render intent. */
  observationOwnership?: string;
  index: number;
  tag: string;
  type: string | null;
  id: string | null;
  name: string | null;
  placeholder: string | null;
  ariaLabel: string | null;
  compactNames?: CompactControlNames;
  role: string | null;
  labelText: string | null;
  visibleText: string | null;
  selector: string;
  visible: boolean;
  inViewport: boolean;
  inConsentWidget: boolean;
  // T13 follow-up — OAuth-affordance signals. `href` is the link
  // target (an OAuth <a> points at e.g. /identity/login/google/);
  // `iconLabel` folds in a descendant <img alt> / <svg><title> /
  // [aria-label] so an icon-only "Sign in with Google" button — no
  // visible text at all — is still discoverable. Optional: only the
  // live extractInteractiveElements sets them; test fixtures omit them.
  href?: string | null;
  iconLabel?: string | null;
  // rc.19 — the element's own `title` attribute. Tooltip-style labels
  // used by icon-only buttons like Railway's modal "Copy Code" copy
  // button, which has no visible text and no aria-label. Without this
  // signal, findCopyButton in the synthesizer falls back to
  // extract_via_regex on bare UUIDs (which the regex library cannot
  // match without a label). Optional; test fixtures may omit.
  title?: string | null;
  // The element's data-testid / data-test / data-cy / data-qa — the most stable
  // selector anchor a site offers (authored to survive refactors + copy
  // changes). pickStableDomHint prefers it; replay's matchesDomHint resolves it
  // ahead of text_match. Optional; test fixtures may omit.
  testId?: string | null;
  // HTML autocomplete attribute (e.g. "given-name", "shipping postal-code").
  // Locale-stable role signal for money-path fill guards. Optional; fixtures
  // may omit (absence ⇒ no confident field fill when role is required).
  autocomplete?: string | null;
  // Site-authored stable role: data-field-role or data-role. Fallback when
  // autocomplete is absent.
  dataRole?: string | null;
  /** Operator-authored provenance for the narrow PAN/CVV output mask. */
  cardMaskKind?: CardMaskKind | null;
  // F15 — nearest HTML5 landmark ancestor: header | main | footer |
  // nav | aside | article | section, or null when the element is
  // outside any landmark. The agent's inventory renderer uses this to
  // disambiguate elements with identical visibleText (a Railway run
  // had "Email" appear twice — body CTA and footer link — with
  // similar selectors that confused the planner). Optional: only the
  // live extractor sets it; fixtures may omit.
  landmark?: string | null;
  // Current value of a text-shaped input/textarea OR a <select>.
  // Surfaces "is this field actually empty / unselected?" to the
  // planner. For an input/textarea: empty string means the field
  // exists and is empty. For a <select>: empty string means the
  // first option's value is "" — typically the "Select…" placeholder
  // option, which is the React-form-state-untouched pattern that
  // broke Railway's token-creation form (clicking Create silently
  // bailed because React Hook Form treated workspaceId as untouched).
  // null means "not applicable (button/link) or not captured (test
  // fixture)".
  value?: string | null;
  // 0.8.3-rc.1 — runtime `checked` state for checkbox/radio inputs.
  // Null for everything else. Use this (not `value`) to identify
  // unticked checkboxes — checkbox `value` is the static attribute.
  checked?: boolean | null;
  /** Native or ARIA disabled state captured with the interactive DOM record. */
  disabled?: boolean | null;
  /** Native or ARIA required state captured with the interactive DOM record. */
  required?: boolean | null;
  /**
   * Per-field validation state (C7): the browser's AX `invalid` property or an
   * authored `aria-invalid="true"`. Surfaced so the operator can confirm a
   * card/field landed correctly before money moves, without rendering the
   * value anywhere. Absent/null means "not captured or not invalid".
   */
  invalid?: boolean | null;
  // <select>-only: the visible text of the currently-selected option
  // and a short list of available option labels (capped to 8 — long
  // pickers like countries blow the inventory rendering). Lets the
  // planner emit a `{"kind":"select", option_text: …}` step targeting
  // an option by name. Both null for non-select elements.
  selectOptions?: Array<{ value: string; text: string }> | null;
  selectedOptionText?: string | null;
  // True when the bot has issued a selectOption / type / etc. against
  // this element earlier in this run, leaving a `data-ts-touched`
  // attribute. Inventory rendering uses this to suppress the
  // DEFAULTED-dropdown warning on selects we've already committed —
  // a Railway "No workspace" (value="") select otherwise re-trips
  // the warning every round and the planner gets stuck in a select
  // loop. Default false (or absent).
  interactedThisRun?: boolean;
  // Compact visual/structural context for non-vision host agents.
  // screenPath is a stable-ish human target path like
  // "dialog:finish-account > button:create-account"; container names the
  // closest dialog/nav/main/form/etc.; topmost/occludedBy report whether the
  // element is actually reachable at its center point.
  screenPath?: string | null;
  container?: string | null;
  // Dedicated dialog-role/aria-modal ancestry via composed tree (pierces open shadows).
  inDialog?: boolean;
  containerId?: number | null;
  formId?: number | null;
  topmost?: boolean | null;
  occludedBy?: string | null;
  // T38 — card-radio cluster membership. Set on elements that are
  // part of a "choose one of these N visually-similar siblings" group:
  // onboarding wizards like Cloudinary's "What are you using
  // Cloudinary for?" and Koyeb's use-case picker render their radio
  // choices as styled cards/labels with no semantic radio role. The
  // detector groups ≥2 sibling clickables that share parentElement
  // and have bounding boxes within ±20%. The planner reads this to
  // know exactly one card needs to be picked and "Continue" is the
  // expected next step. Null/absent when not part of a group.
  cardRadioGroup?: { id: number; position: number; total: number } | null;
  // Frame support — the ORIGIN (scheme://host[:port]) and full URL of the
  // <iframe> this element was extracted from, when it lives inside a child
  // frame (same- or cross-origin). null/undefined for an ordinary main-frame
  // element — every pre-existing element keeps this shape unchanged. This is
  // the origin used for the x=s / x=x compact fact and for stale-target
  // checks; it is metadata only, never a reachability gate.
  frameOrigin?: string | null;
  frameUrl?: string | null;
  framePath?: string | null;
}

// T38 — pure clustering logic. Identifies card-radio groups from a
// flat list of inventory candidates: each candidate carries its
// parent's identity (an integer assigned in DOM-walk order) plus
// the rendered bounding-box dimensions. Returns one slot per
// candidate, populated only for members of a qualifying group.
//
// A group qualifies when:
//   - 2..8 clickable siblings share the same parent (a list of N
//     things in a <ul> would usually exceed 8, and ≥9 sibling
//     similar-sized clickables aren't a card-radio in practice);
//   - their widths and heights agree within ±20% (real card grids
//     line up to a CSS grid template, so this is loose enough for
//     pixel rounding but tight enough to reject a button+text-link
//     row).
//
// Exported so the unit tests can exercise the logic in Node — the
// DOM-side caller in extractInteractiveElements feeds the same
// shape from inside page.evaluate.
export function assignCardRadioGroups(
  candidates: ReadonlyArray<{
    parentId: number;
    width: number;
    height: number;
    clickable: boolean;
  }>,
): Array<{ id: number; position: number; total: number } | null> {
  const result: Array<{ id: number; position: number; total: number } | null> = new Array(
    candidates.length,
  ).fill(null);
  // Bucket by parent.
  const byParent = new Map<number, number[]>();
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (c === undefined || c.parentId < 0) continue;
    const arr = byParent.get(c.parentId) ?? [];
    arr.push(i);
    byParent.set(c.parentId, arr);
  }
  let nextGroupId = 1;
  // Iterate in insertion order — keeps group ids stable across runs
  // for tests that exercise multiple clusters.
  for (const indices of byParent.values()) {
    if (indices.length < 2 || indices.length > 8) continue;
    const clickableIdx = indices.filter((i) => candidates[i]?.clickable === true);
    if (clickableIdx.length < 2) continue;
    const widths = clickableIdx.map((i) => candidates[i]!.width);
    const heights = clickableIdx.map((i) => candidates[i]!.height);
    const minW = Math.min(...widths);
    const minH = Math.min(...heights);
    if (minW < 1 || minH < 1) continue; // degenerate — reject
    const wRatio = Math.max(...widths) / minW;
    const hRatio = Math.max(...heights) / minH;
    if (wRatio > 1.2 || hRatio > 1.2) continue;
    const groupId = nextGroupId++;
    const total = clickableIdx.length;
    clickableIdx.forEach((idx, pos) => {
      result[idx] = { id: groupId, position: pos + 1, total };
    });
  }
  return result;
}

export {
  canSelfLaunchWithProxy,
  captureOwnedChromeProcessTreeProof,
  childProcessIsRunning,
  closeBrowserContextWithin,
  closeLocalBrowserLaunch,
  isProxyReachable,
  isSelfManagedChromeTerminationSignalExitEnabled,
  launchCancellablePersistentContext,
  ownedChromeProcessTreeState,
  parseEgressGeo,
  parseProxyUrl,
  persistentProxyOptions,
  proxyDefaultPort,
  proxyHasCredentials,
  registerLocalBrowserLaunch,
  resolveAttachedProfileChildIdentity,
  resolveChannelBinary,
  resolveExplicitProxy,
  resolvePersistentFallbackIdentity,
  selfLaunchEnabled,
  setSelfManagedChromeTerminationSignalExitEnabled,
  signalOwnedChromeProcessTree,
  synchronizeSelfManagedChromeTerminationSignalHandlers,
  terminateTrackedProfileChild,
  waitForOwnedDevtoolsEndpoint,
  withChromeStartupLock,
  type EgressGeo,
  type OwnedChromeProcessTreeProof,
  type PersistentFallbackIdentityProof,
  type ProxySettings,
  type StealthProfile,
} from "./browser-process-runtime.js";
