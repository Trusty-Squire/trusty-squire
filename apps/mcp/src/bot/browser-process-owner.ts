import type { Browser, BrowserContext } from "playwright";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type ChildProcess } from "node:child_process";
import {
  clearStaleSingletonLock,
  closeProfileWithProof,
  currentProfileHolderPid,
  profileProcessIdentity,
  profileProcessIdentityState,
  profileProcessMatches,
  reapProfileHolderIfOwned,
  type ProfileCloseState,
  type ProfileProcessIdentity,
} from "./profile.js";
import {
  createOperatorBrowserMarker,
  OPERATOR_BROWSER_MARKER_ENV,
  operatorBrowserProcessMatchesMarker,
  startGlobalOperatorBrowserProcessWatchdog,
} from "./operator-browser-watchdog.js";
import {
  bindOwnerBrowserLaunch,
  markOwnerBrowserLaunchTerminal,
  terminateOwnerBrowserLaunch,
  untrackOwnerBrowserLaunch,
} from "./owner-process-reaper.js";
import {
  activeStealthProfileValue,
  canSelfLaunchWithProxy,
  captureOwnedChromeProcessTreeProof,
  detectChromiumChannel,
  DEVTOOLS_ACTIVE_PORT_FILE,
  getChromium,
  launchCancellablePersistentContext,
  OPERATOR_BROWSER_HEADLESS,
  ownedChromeProcessTreeState,
  parseEgressGeo,
  PERSISTENT_CONTEXT_CANCELLATION_SETTLE_MS,
  persistentProxyOptions,
  PROFILE_IDENTITY_POLL_MS,
  PROFILE_IDENTITY_PROOF_TIMEOUT_MS,
  registerLocalBrowserLaunch,
  registerSelfManagedChrome,
  releaseOwnedChromeProcessTree,
  resolveAttachedProfileChildIdentity,
  resolveChannelBinary,
  resolveExplicitProxy,
  resolvePersistentFallbackIdentity,
  selfLaunchEnabled,
  selfManagedChromes,
  signalOwnedChromeProcessTree,
  spawnLocalBrowser,
  terminateTrackedProfileChild,
  trackOwnedChromeProcessTree,
  waitForOwnedDevtoolsEndpoint,
  type EgressGeo,
  type OwnedChromeProcessTreeProof,
  type PersistentFallbackIdentityProof,
  type ProxySettings,
  type StealthProfile,
} from "./browser-process-runtime.js";
import type { RemoteLoginRig } from "./remote-login-display.js";
import type { PageDriver } from "./page-driver.js";

/** Exclusive Chrome custody. Page setup is awaited at the original startup boundary. */
export class BrowserProcessOwner {
  // A persistent browser context backed by the user's real Chrome profile.
  context: BrowserContext | null = null;

  // Self-launch path (Turnstile-safe; see selfLaunchEnabled). When we spawn
  // Chrome ourselves and attach over CDP, these hold the child process and
  // the connected Browser so close() can tear both down.
  private childChrome: ChildProcess | null = null;

  private childChromeIdentity: ProfileProcessIdentity | null = null;

  private childChromeProcessGroup = false;

  private ownedDisplayRig: RemoteLoginRig | null = null;

  private ownedChromeProcessTreeProof: OwnedChromeProcessTreeProof | null = null;

  private operatorProcessMarker: string | null = null;

  private ownerLaunchTracked = false;

  private cdpBrowser: Browser | null = null;

  // True once a local browser context launched this session.
  private launchedContext = false;

  private launchedProfileHolderIdentity: ProfileProcessIdentity | null = null;

  private startPromise: Promise<void> | null = null;

  private closePromise: Promise<ProfileCloseState> | null = null;

  private startCancellationRequested = false;

  private startLaunchCommitted = false;

  private startSettled = false;

  private persistentFallbackLaunchInFlight = false;

  private persistentFallbackOwnershipMonitor: Promise<void> | null = null;

  private persistentFallbackCancellationState: ProfileCloseState | null = null;

  private resolveStartCancellation: (() => void) | null = null;

  private readonly startCancellation = new Promise<void>((resolveCancellation) => {
    this.resolveStartCancellation = resolveCancellation;
  });

  private cancelledStartReaper: Promise<void> | null = null;

  // Records the browser channel that .start() actually launched. Set
  // post-launch so telemetry can surface "this run
  // used real Chrome" vs "this run used bundled Chromium." Useful for
  // separating fingerprint regressions from network regressions when
  // a service starts failing.
  private launchedChannel: string | null = null;

  // The proxy server this run egressed through, or null for a direct
  // connection. Set by .start(); surfaced via the `proxied` getter —
  // a captcha failure behind a residential proxy is materially
  // different signal from the same failure on a raw datacenter IP.
  private proxyServer: string | null = null;

  private readonly profileDir: string;

  // Per-launch egress override. null means direct egress. Explicit overrides
  // are never subject to host-network classification.
  private readonly proxyOverride: string | null;

  // Surfaced in the run trail so operators can distinguish local headed,
  // remote, and headless launches.
  launchedMode: "headed" | "headless" | "remote" | "unknown" = "unknown";
  constructor(
    opts: { profileDir?: string; proxyUrl?: string },
    private readonly pages: PageDriver,
    private readonly initializePages: (
      context: BrowserContext,
      hardened: boolean,
      remoteMode: boolean,
    ) => Promise<void>,
  ) {
    this.profileDir = opts.profileDir ?? "";
    this.proxyOverride =
      opts.proxyUrl !== undefined && opts.proxyUrl.trim().length > 0 ? opts.proxyUrl.trim() : null;
  }

  operatorBrowserMarker(): string {
    this.operatorProcessMarker ??= createOperatorBrowserMarker();
    return this.operatorProcessMarker;
  }

  private async ownedHeadedBrowserEnvironment(): Promise<NodeJS.ProcessEnv> {
    if (this.ownedDisplayRig === null) {
      const { createXvfbDisplayRig, startRemoteLoginDisplay } =
        await import("./remote-login-display.js");
      const rig = createXvfbDisplayRig();
      this.ownedDisplayRig = rig;
      await startRemoteLoginDisplay(rig);
    }
    const { remoteLoginEnvironment } = await import("./remote-login-display.js");
    const rig = this.ownedDisplayRig;
    if (rig === null) throw new Error("headed operator display did not start");
    return remoteLoginEnvironment(rig, process.env);
  }

  private async teardownOwnedDisplay(): Promise<void> {
    const rig = this.ownedDisplayRig;
    this.ownedDisplayRig = null;
    if (rig === null) return;
    const { teardownRemoteLoginRig } = await import("./remote-login-display.js");
    await teardownRemoteLoginRig(rig);
  }

  private adoptOwnedChromeProcessTree(
    identity: ProfileProcessIdentity,
    processGroup: boolean,
  ): OwnedChromeProcessTreeProof | null {
    if (
      this.ownedChromeProcessTreeProof?.identity.pid === identity.pid &&
      this.ownedChromeProcessTreeProof.identity.start_time === identity.start_time
    ) {
      return this.ownedChromeProcessTreeProof;
    }
    const tracked = selfManagedChromes.get(identity.pid);
    const proof =
      tracked?.identity.start_time === identity.start_time
        ? tracked.proof
        : trackOwnedChromeProcessTree(identity, processGroup);
    if (proof !== null && this.ownerLaunchTracked) {
      if (!bindOwnerBrowserLaunch(this.operatorBrowserMarker(), proof.identity)) {
        releaseOwnedChromeProcessTree(proof);
        throw new Error("local browser launch identity could not be bound to owner custody");
      }
    }
    if (proof !== null) this.ownedChromeProcessTreeProof = proof;
    return proof;
  }

  private signalCurrentSelfManagedChrome(
    identity: ProfileProcessIdentity,
    signal: NodeJS.Signals,
  ): boolean {
    return signalOwnedChromeProcessTree(identity, this.childChromeProcessGroup, signal, {
      ...(this.ownedChromeProcessTreeProof === null
        ? {}
        : { proof: this.ownedChromeProcessTreeProof }),
    });
  }

  // Required health gate for a live session browser. BrowserContext alone is not a
  // sufficient signal: a dead CDP transport can leave stale JS objects behind.
  isConnected(): boolean {
    const browser = this.cdpBrowser ?? this.context?.browser() ?? null;
    return browser?.isConnected() === true;
  }

  // Which browser channel the most recent .start() actually used.
  // `null` means bundled Chromium; a string like "chrome" means a
  // real installed browser of that channel. Throws if .start() hasn't
  // been called yet — there's no sensible default to return.
  get channel(): string | null {
    if (this.context === null) {
      throw new Error("BrowserController.channel read before .start()");
    }
    return this.launchedChannel;
  }

  // The proxy server the most recent .start() routed egress through,
  // or null for a direct connection. Useful telemetry alongside
  // `channel`. Throws if .start() hasn't run — same reason as channel.
  get proxied(): string | null {
    if (this.context === null) {
      throw new Error("BrowserController.proxied read before .start()");
    }
    return this.proxyServer;
  }

  // The stealth profile the most recent .start() launched under:
  // "cdp_hardened" when the patchright launcher actually loaded
  // (BOT_CDP_HARDENED set + patchright present), else "baseline". Surfaced
  // for the CaptchaEvent A/B tag. Throws before .start() — same reason
  // as channel/proxied.
  get stealthProfile(): StealthProfile {
    if (this.context === null) {
      throw new Error("BrowserController.stealthProfile read before .start()");
    }
    return activeStealthProfileValue();
  }

  get launchMode(): "headed" | "headless" | "remote" | "unknown" {
    return this.launchedMode;
  }

  // Launch Chrome ourselves and attach over CDP — the Turnstile-safe launch
  // (see selfLaunchEnabled for the proof). The profile dir is the SAME shared
  // profile launchPersistentContext would use, so the OAuth session carries
  // over. Options that a default connectOverCDP context can't take at creation
  // are applied differently:
  //   • timezone  → TZ env on the child (more authentic than a CDP override)
  //   • proxy     → --proxy-server flag, with credentials applied post-connect
  //   • viewport  → --window-size (with viewport:null-equivalent: we never set
  //                 an emulated viewport on the connected context)
  //   • locale/geo/permissions → applied post-connect by start()
  private async launchSelfManagedContext(params: {
    binary: string;
    args: readonly string[];
    proxy: ProxySettings | null;
    env: NodeJS.ProcessEnv;
    window: { width: number; height: number };
  }): Promise<BrowserContext> {
    this.throwIfStartCancelled();
    // Remote-CDP attach: BOT_CDP_ENDPOINT points at a Chrome already running on
    // another host (e.g. a real-GPU Mac), reachable over Tailscale. We do NOT
    // spawn or own the binary — the remote host launched it with its own
    // profile, real GPU, and (residential) egress. Just attach over CDP. This
    // is the real-GPU path: software-WebGL output (llvmpipe) is what
    // hCaptcha-Enterprise-class anti-bot scores, and only real hardware fixes
    // the rendered-pixel fingerprint that JS spoofing can't.
    const remoteEndpoint = (process.env.BOT_CDP_ENDPOINT ?? "").trim();
    if (remoteEndpoint.length > 0) {
      const launcher = getChromium();
      const browser = await launcher.connectOverCDP(remoteEndpoint);
      this.cdpBrowser = browser;
      this.launchedMode = "remote";
      const ctx = browser.contexts()[0];
      if (ctx === undefined) {
        throw new Error(
          `remote Chrome (BOT_CDP_ENDPOINT=${remoteEndpoint}) exposed no default browser context`,
        );
      }
      return ctx;
    }
    const endpoint = await (async () => {
      this.throwIfStartCancelled();
      clearStaleSingletonLock(this.profileDir);
      rmSync(join(this.profileDir, DEVTOOLS_ACTIVE_PORT_FILE), { force: true });
      const argv = [
        "--remote-debugging-port=0",
        "--remote-debugging-address=127.0.0.1",
        `--user-data-dir=${this.profileDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--password-store=basic",
        "--window-position=0,0",
        `--window-size=${params.window.width},${params.window.height}`,
        "--lang=en-US",
        ...params.args,
        ...(params.proxy !== null ? [`--proxy-server=${params.proxy.server}`] : []),
        "about:blank",
      ];
      this.commitProfileLaunch();
      const child = spawnLocalBrowser(params.binary, argv, this.profileDir, {
        env: params.env,
        stdio: ["ignore", "ignore", "pipe"],
        // A dedicated process group gives the session a single, identity-
        // proven teardown target for Chrome plus every renderer/GPU helper.
        detached: process.platform !== "win32",
        marker: this.operatorBrowserMarker(),
      });
      this.childChrome = child;
      this.childChromeProcessGroup = process.platform !== "win32";
      this.childChromeIdentity = registerSelfManagedChrome(
        child,
        this.profileDir,
        this.childChromeProcessGroup,
      );
      if (this.childChromeIdentity !== null) {
        this.adoptOwnedChromeProcessTree(this.childChromeIdentity, this.childChromeProcessGroup);
      }
      let chromeStderr = "";
      let chromeExit = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        chromeStderr = (chromeStderr + chunk.toString("utf8")).slice(-4_000);
      });
      child.on("exit", (code, signal) => {
        chromeExit = ` exit=${code ?? "null"} signal=${signal ?? "none"}`;
      });
      if (this.startCancellationRequested) {
        await this.cancelSpawnedSelfManagedChrome(child);
        throw new Error("BrowserController start cancelled");
      }
      try {
        const endpoint = await waitForOwnedDevtoolsEndpoint(this.profileDir, 30_000, child);
        this.childChromeIdentity = await resolveAttachedProfileChildIdentity(
          child,
          this.profileDir,
          this.childChromeIdentity,
          { processGroup: this.childChromeProcessGroup },
        );
        if (process.platform === "linux" && this.childChromeIdentity === null) {
          throw new Error("self-launched Chrome exited before identity was proven");
        }
        if (this.childChromeIdentity !== null) {
          this.adoptOwnedChromeProcessTree(this.childChromeIdentity, this.childChromeProcessGroup);
        }
        return endpoint;
      } catch (err) {
        const alive =
          this.childChromeIdentity !== null &&
          profileProcessMatches(this.childChromeIdentity, this.profileDir);
        this.childChromeIdentity = await terminateTrackedProfileChild(child, this.profileDir, {
          identity: this.childChromeIdentity,
          terminate: (identity, profileDir) => {
            const signalled = signalOwnedChromeProcessTree(
              identity,
              this.childChromeProcessGroup,
              "SIGKILL",
              {
                ...(this.ownedChromeProcessTreeProof === null
                  ? {}
                  : { proof: this.ownedChromeProcessTreeProof }),
              },
            );
            reapProfileHolderIfOwned(profileDir, identity);
            return signalled;
          },
          processGroup: this.childChromeProcessGroup,
        });
        this.childChrome = null;
        this.childChromeIdentity = null;
        this.childChromeProcessGroup = false;
        const detail = chromeStderr.trim();
        throw new Error(
          `${err instanceof Error ? err.message : String(err)}; Chrome pid=${child.pid ?? "unknown"} alive=${alive ? 1 : 0}` +
            `${chromeExit}${detail.length > 0 ? `; Chrome stderr: ${detail}` : ""}`,
        );
      }
    })();
    // Use the patchright launcher's connectOverCDP — it's the exact path the
    // falsification experiment validated (its connect avoids Runtime.enable,
    // which a plain attach would emit). The anti-detection that matters here
    // is the LAUNCH (which we now own), not the connect.
    const launcher = getChromium();
    const browser = await launcher.connectOverCDP(endpoint);
    this.cdpBrowser = browser;
    const ctx = browser.contexts()[0];
    if (ctx === undefined) {
      throw new Error("self-launched Chrome exposed no default browser context");
    }
    return ctx;
  }

  private async cancelSpawnedSelfManagedChrome(child: ChildProcess): Promise<void> {
    this.childChromeIdentity = await terminateTrackedProfileChild(child, this.profileDir, {
      identity: this.childChromeIdentity,
      terminate: (identity, profileDir) => {
        const signalled = signalOwnedChromeProcessTree(
          identity,
          this.childChromeProcessGroup,
          "SIGKILL",
          {
            ...(this.ownedChromeProcessTreeProof === null
              ? {}
              : { proof: this.ownedChromeProcessTreeProof }),
          },
        );
        reapProfileHolderIfOwned(profileDir, identity);
        return signalled;
      },
      processGroup: this.childChromeProcessGroup,
    });
    if (this.childChrome === child) this.childChrome = null;
    this.childChromeIdentity = null;
    this.childChromeProcessGroup = false;
  }

  async start(): Promise<void> {
    if (this.profileDir.length === 0) {
      throw new Error("BrowserController.start requires a per-session profile directory");
    }
    if (this.closePromise !== null) throw new Error("BrowserController is already closing");
    this.startPromise ??= this.startOnce();
    await this.startPromise;
  }

  private async startOnce(): Promise<void> {
    const remoteMode = (process.env.BOT_CDP_ENDPOINT ?? "").trim().length > 0;
    if (!remoteMode) startGlobalOperatorBrowserProcessWatchdog();
    try {
      await this.startBrowser();
      if (this.startCancellationRequested) {
        await this.closeBrowser();
        throw new Error("BrowserController start cancelled");
      }
    } catch (err) {
      await this.teardownOwnedDisplay().catch(() => undefined);
      if (this.startCancellationRequested && this.persistentFallbackCancellationState === null) {
        await this.closeBrowser().catch(() => undefined);
      }
      throw err;
    } finally {
      this.startSettled = true;
    }
  }

  private throwIfStartCancelled(): void {
    if (this.startCancellationRequested) throw new Error("BrowserController start cancelled");
  }

  private commitProfileLaunch(): void {
    this.throwIfStartCancelled();
    this.startLaunchCommitted = true;
  }

  private async startBrowser(): Promise<void> {
    this.throwIfStartCancelled();
    const channel = await detectChromiumChannel();
    this.throwIfStartCancelled();
    this.launchedChannel = channel;
    const proxy = await this.resolveProxy();
    this.throwIfStartCancelled();
    this.proxyServer = proxy?.server ?? null;
    // Stderr so the MCP stdio transport's framing stays clean (the
    // module's existing logging convention).
    console.error(
      `[operator] launching browser channel=${channel ?? "bundled-chromium"} ` +
        `proxy=${proxy === null ? "direct" : "configured"}`,
    );
    // Remote-CDP mode (BOT_CDP_ENDPOINT): the browser runs on a REMOTE host
    // (e.g. a Mac with a real GPU + residential egress) and we attach over CDP
    // across Tailscale. The remote machine IS a real device, so we spoof
    // NOTHING — no WebGL/device fingerprint patch (a fake-Intel string over a
    // real Apple-GPU output would be its own mismatch tell), no local display, no
    // egress-geo override (the remote host's real timezone + residential IP are
    // authentic). software-WebGL output is exactly what the toughest anti-bot
    // (hCaptcha Enterprise) scores; only real hardware fixes the pixel
    // fingerprint, which is the whole point of this path.
    const remoteMode = (process.env.BOT_CDP_ENDPOINT ?? "").trim().length > 0;
    if (remoteMode) {
      console.error(
        `[operator] REMOTE-CDP mode — attaching to ${(process.env.BOT_CDP_ENDPOINT ?? "").trim()} ` +
          `(real-host GPU + egress; local fingerprint spoof + display setup disabled)`,
      );
    }
    if (!remoteMode && !this.ownerLaunchTracked) {
      registerLocalBrowserLaunch(this.profileDir, process.env, this.operatorBrowserMarker());
      this.ownerLaunchTracked = true;
    }
    const browserEnv = remoteMode ? process.env : await this.ownedHeadedBrowserEnvironment();
    // T3.1: probe where this run's traffic actually exits so the
    // browser's declared timezone matches its egress IP (a US-timezone
    // browser on a foreign proxy IP is itself an anti-bot signal).
    // Done before the real launch: launchPersistentContext bakes the
    // timezone in at creation, with no way to set it afterward. Skipped in
    // remote mode — the remote host's own clock/IP are the authentic truth.
    const geo = remoteMode ? null : await this.probeEgressGeo(channel, proxy, browserEnv);
    this.throwIfStartCancelled();
    if (geo !== null) {
      console.error(
        `[operator] egress geo: timezone=${geo.timezoneId}` +
          (geo.geolocation !== undefined
            ? ` loc=${geo.geolocation.latitude},${geo.geolocation.longitude}`
            : ""),
      );
    }
    // Keep the operator browser headed: the browser runs on the operator's
    // Xvfb display, preserving the normal Chrome surface OAuth providers see.
    this.launchedMode = "headed";

    // T3: a PERSISTENT context backed by this operator session's unique
    // profile. launchPersistentContext takes launch + context options in one
    // call.
    // Resolve the launcher first so activeStealthProfile is set before we
    // decide on executablePath below.
    const launcher = getChromium();
    const hardened = activeStealthProfileValue() === "cdp_hardened";
    // Both launchers drive real Chrome via `channel`: baseline through
    // playwright+stealth, hardened through patchright. patchright closes
    // the automation tells at the protocol layer and drives real Chrome
    // directly — so it no longer needs the bundled-chromium pin the old
    // rebrowser fork required (the pin is what crashed the OAuth flow and
    // confounded the A/B). One binary for both arms.
    this.launchedChannel = channel;
    // Launch args shared by BOTH paths (launchPersistentContext and the
    // self-launch). See the per-flag rationale: swiftshader gives a real
    // (software) WebGL context on GPU-less hosts; the others are the
    // standard headless/sandbox flags. The three background-throttling disables
    // are payment correctness controls: a backgrounded CardinalCommerce ACS
    // frame must keep running its timers long enough to finish the issuer's OOB
    // post-approval handshake with Stripe. Keep them paired with bringToFront()
    // before payment submission and in waitForThreeDsResolution(). NOTE we
    // deliberately do NOT include Playwright's automation flags
    // (--enable-automation et al.) — on the self-launch path their ABSENCE is
    // the whole fix.
    const launchArgs: readonly string[] = [
      "--disable-blink-features=AutomationControlled",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--enable-unsafe-swiftshader",
      "--ignore-gpu-blocklist",
    ];
    // F10 clipboard + egress-matched geolocation permission, built once for
    // either path. Typed as string[] (Playwright's grantPermissions /
    // permissions option both accept it).
    const grantedPermissions: string[] = [
      ...(geo?.geolocation !== undefined ? ["geolocation"] : []),
      "clipboard-read",
      "clipboard-write",
    ];
    const selfLaunchBinary = selfLaunchEnabled()
      ? (resolveChannelBinary(channel) ?? (channel === null ? launcher.executablePath() : null))
      : null;
    const useSelfLaunch =
      selfLaunchBinary !== null && existsSync(selfLaunchBinary) && canSelfLaunchWithProxy(proxy);
    let context: BrowserContext;
    this.throwIfStartCancelled();
    if (useSelfLaunch && selfLaunchBinary !== null) {
      console.error(
        `[operator] self-launch + connectOverCDP (Turnstile-safe launch) binary=${selfLaunchBinary}`,
      );
      const window = { width: 1280, height: 1024 };
      const selfEnv: NodeJS.ProcessEnv = {
        ...browserEnv,
        TZ: geo?.timezoneId ?? "America/New_York",
        [OPERATOR_BROWSER_MARKER_ENV]: this.operatorBrowserMarker(),
      };
      const launch = () => {
        this.throwIfStartCancelled();
        return this.launchSelfManagedContext({
          binary: selfLaunchBinary,
          args: launchArgs,
          proxy,
          env: selfEnv,
          window,
        });
      };
      context = await launch();
      try {
        await context.grantPermissions(grantedPermissions);
        if (geo?.geolocation !== undefined) {
          await context.setGeolocation(geo.geolocation);
        }
      } catch (err) {
        console.error(
          `[operator] post-connect context setup partial: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    } else {
      this.persistentFallbackLaunchInFlight = true;
      this.startPersistentFallbackOwnershipMonitor();
      const cleanupProfileHolder = async (): Promise<ProfileCloseState> => {
        const proof = await this.waitForPersistentFallbackIdentity();
        if (proof.state === "absent") return "closed";
        if (proof.state === "unknown") return "unknown";
        const { identity } = proof;
        const treeProof = this.adoptOwnedChromeProcessTree(identity, false);
        signalOwnedChromeProcessTree(identity, false, "SIGKILL", {
          ...(treeProof === null ? {} : { proof: treeProof }),
        });
        return (await this.waitForOwnedProfileExit(identity, treeProof)) ? "closed" : "unknown";
      };
      const cleanupCancelled = async (lateContext: BrowserContext): Promise<ProfileCloseState> => {
        const proof = await this.waitForPersistentFallbackIdentity().catch(
          () => ({ state: "unknown" }) as const,
        );
        if (proof.state !== "owned") {
          await lateContext.close().catch(() => undefined);
          return proof.state === "absent" ? "closed" : "unknown";
        }
        const { identity } = proof;
        const treeProof = this.adoptOwnedChromeProcessTree(identity, false);
        const closeState = await closeProfileWithProof({
          profileDir: this.profileDir,
          identity,
          close: () => lateContext.close(),
          forceClose: () => {
            signalOwnedChromeProcessTree(identity, false, "SIGKILL", {
              ...(treeProof === null ? {} : { proof: treeProof }),
            });
            reapProfileHolderIfOwned(this.profileDir, identity);
          },
          ...(treeProof === null
            ? {}
            : { identityState: () => ownedChromeProcessTreeState(treeProof) }),
        });
        if (closeState === "closed") return closeState;
        return (await this.waitForOwnedProfileExit(identity, treeProof)) ? "closed" : "unknown";
      };
      const outcome = await (async () => {
        try {
          return await launchCancellablePersistentContext({
            launch: (options) => launcher.launchPersistentContext(this.profileDir, options),
            options: {
              headless: OPERATOR_BROWSER_HEADLESS,
              env: {
                ...browserEnv,
                [OPERATOR_BROWSER_MARKER_ENV]: this.operatorBrowserMarker(),
              },
              ...(channel !== null ? { channel } : {}),
              ...persistentProxyOptions(proxy),
              args: [...launchArgs],
              viewport: null,
              locale: "en-US",
              timezoneId: geo?.timezoneId ?? "America/New_York",
              permissions: grantedPermissions,
              ...(geo?.geolocation !== undefined ? { geolocation: geo.geolocation } : {}),
            },
            cancellation: this.startCancellation,
            cleanupCancelled,
            cleanupRejected: cleanupProfileHolder,
          });
        } catch (error) {
          if (!this.startCancellationRequested) {
            this.persistentFallbackLaunchInFlight = false;
            throw error;
          }
          this.persistentFallbackCancellationState = await cleanupProfileHolder().catch(
            () => "unknown" as const,
          );
          this.persistentFallbackLaunchInFlight = false;
          throw new Error("BrowserController start cancelled");
        }
      })();
      if (outcome.status === "cancelled") {
        this.persistentFallbackCancellationState = outcome.closeState;
        this.persistentFallbackLaunchInFlight = false;
        throw new Error("BrowserController start cancelled");
      }
      context = outcome.value;
      if (this.startCancellationRequested) {
        this.persistentFallbackCancellationState = await cleanupCancelled(context).catch(
          () => "unknown" as const,
        );
        this.persistentFallbackLaunchInFlight = false;
        throw new Error("BrowserController start cancelled");
      }
      this.context = context;
      this.launchedContext = true;
      this.launchedProfileHolderIdentity = await this.requirePersistentFallbackOwnership(
        async () => {
          markOwnerBrowserLaunchTerminal(this.operatorBrowserMarker());
          await Promise.race([
            context.close().catch(() => undefined),
            new Promise<void>((resolveWait) => {
              const timer = setTimeout(resolveWait, PERSISTENT_CONTEXT_CANCELLATION_SETTLE_MS);
              timer.unref();
            }),
          ]);
          const markerClosed = await terminateOwnerBrowserLaunch(
            this.operatorBrowserMarker(),
            this.profileDir,
          );
          if (markerClosed) {
            untrackOwnerBrowserLaunch(this.operatorBrowserMarker());
            this.ownerLaunchTracked = false;
          }
          this.context = null;
          this.launchedContext = false;
        },
      );
      this.commitProfileLaunch();
      this.persistentFallbackLaunchInFlight = false;
    }
    this.context = context;
    // We own the profile now — close() may reap a leaked Chrome.
    this.launchedContext = true;
    if (!remoteMode) {
      const holderPid = this.childChrome?.pid ?? currentProfileHolderPid(this.profileDir);
      this.launchedProfileHolderIdentity =
        this.childChromeIdentity ??
        (holderPid === null ? null : profileProcessIdentity(holderPid, this.profileDir));
      if (this.launchedProfileHolderIdentity !== null) {
        this.adoptOwnedChromeProcessTree(
          this.launchedProfileHolderIdentity,
          this.childChromeIdentity !== null && this.childChromeProcessGroup,
        );
      }
    }
    if (this.startCancellationRequested) {
      await this.closeBrowser();
      throw new Error("BrowserController start cancelled");
    }
    await this.initializePages(context, hardened, remoteMode);
  }

  // Probe the run's actual egress geo by loading ipinfo.io. Launches a
  // throwaway browser: the persistent context isn't up yet, and its
  // timezone has to be known before it is. The throwaway inherits the
  // same channel + proxy so it reports the real egress. Best-effort —
  // any failure returns null and start() keeps a default timezone.
  private async probeEgressGeo(
    channel: string | null,
    proxy: ProxySettings | null,
    browserEnv: NodeJS.ProcessEnv,
  ): Promise<EgressGeo | null> {
    if (proxy === null) {
      try {
        const resp = await fetch("https://ipinfo.io/json", { signal: AbortSignal.timeout(10_000) });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return parseEgressGeo(await resp.text());
      } catch (err) {
        console.error(
          `[operator] egress geo probe failed — using default ` +
            `timezone: ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
      }
    }

    let probe: Browser | undefined;
    try {
      probe = await getChromium().launch({
        headless: OPERATOR_BROWSER_HEADLESS,
        env: browserEnv,
        ...(channel !== null ? { channel } : {}),
        ...(proxy !== null ? { proxy } : {}),
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
      });
      const page = await probe.newPage();
      await page.goto("https://ipinfo.io/json", {
        timeout: 10000,
        waitUntil: "domcontentloaded",
      });
      const body = await page.evaluate(() => document.body.innerText);
      return parseEgressGeo(body);
    } catch (err) {
      console.error(
        `[operator] egress geo probe failed — using default ` +
          `timezone: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    } finally {
      if (probe !== undefined) await probe.close();
    }
  }

  // Resolve the deliberate per-session egress selection. A session proxy is
  // not an optimization hint: falling back to the host's IP could submit a
  // geo-gated flow from the wrong country, so malformed or unreachable values
  // abort startup rather than silently egressing directly.
  private async resolveProxy(): Promise<ProxySettings | null> {
    if (this.proxyOverride === null) return null;
    return resolveExplicitProxy(this.proxyOverride);
  }

  async close(options: { cancelStart?: boolean } = {}): Promise<ProfileCloseState> {
    if (options.cancelStart === true) {
      this.startCancellationRequested = true;
      this.resolveStartCancellation?.();
      this.resolveStartCancellation = null;
    }
    this.closePromise ??= this.closeAfterStart();
    return await this.closePromise;
  }

  async waitForCancelledStartQuiescence(): Promise<void> {
    if (!this.startCancellationRequested) return;
    await Promise.allSettled([
      this.startPromise ?? Promise.resolve(),
      this.reapCancelledStartProcess(),
    ]);
    await this.persistentFallbackOwnershipMonitor?.catch(() => undefined);
  }

  async forceCloseOwnedProcessTree(): Promise<ProfileCloseState> {
    this.startCancellationRequested = true;
    this.resolveStartCancellation?.();
    this.resolveStartCancellation = null;
    const marker = this.operatorBrowserMarker();
    if (this.ownerLaunchTracked) markOwnerBrowserLaunchTerminal(marker);
    const proof = this.ownedChromeProcessTreeProof;
    const identity = proof?.identity ?? this.currentOwnedProfileIdentity();
    if (identity !== null) {
      signalOwnedChromeProcessTree(identity, proof?.processGroup ?? false, "SIGKILL", {
        ...(proof === null ? {} : { proof }),
      });
      reapProfileHolderIfOwned(this.profileDir, identity);
    }
    const closed =
      identity === null
        ? this.startSettled && !this.launchedContext
        : await this.waitForOwnedProfileExit(identity, proof);
    if (closed && proof !== null) {
      releaseOwnedChromeProcessTree(proof);
      const tracked = selfManagedChromes.get(proof.identity.pid);
      if (tracked?.proof === proof) selfManagedChromes.delete(proof.identity.pid);
      if (this.ownedChromeProcessTreeProof === proof) this.ownedChromeProcessTreeProof = null;
    }
    const markerClosed =
      !this.ownerLaunchTracked || (await terminateOwnerBrowserLaunch(marker, this.profileDir));
    if (closed && markerClosed && this.ownerLaunchTracked) {
      untrackOwnerBrowserLaunch(marker);
      this.ownerLaunchTracked = false;
    }
    await this.teardownOwnedDisplay().catch(() => undefined);
    return closed && markerClosed ? "closed" : "unknown";
  }

  private async closeCancelledStart(): Promise<ProfileCloseState> {
    void this.reapCancelledStartProcess().catch(() => undefined);
    if (this.persistentFallbackCancellationState !== null) {
      return this.persistentFallbackCancellationState;
    }
    if (!this.startLaunchCommitted) {
      const closeState = await this.closeBrowser();
      return this.startSettled ? closeState : "unknown";
    }
    return await this.closeBrowser();
  }

  private async reapCancelledStartProcess(): Promise<void> {
    this.cancelledStartReaper ??= this.monitorCancelledStartProcess();
    await this.cancelledStartReaper;
  }

  private async monitorCancelledStartProcess(): Promise<void> {
    while (!this.startSettled) {
      const identity = this.currentOwnedProfileIdentity();
      if (identity !== null) {
        this.signalCurrentSelfManagedChrome(identity, "SIGKILL");
        reapProfileHolderIfOwned(this.profileDir, identity);
      }
      await new Promise<void>((resolveWait) => {
        const timer = setTimeout(resolveWait, 25);
        timer.unref();
      });
    }
  }

  private currentOwnedProfileIdentity(): ProfileProcessIdentity | null {
    const known =
      this.ownedChromeProcessTreeProof?.identity ??
      this.childChromeIdentity ??
      this.launchedProfileHolderIdentity;
    if (known !== null) return known;
    const holderPid = currentProfileHolderPid(this.profileDir);
    if (holderPid === null) return null;
    const identity = profileProcessIdentity(holderPid, this.profileDir);
    if (identity === null) return null;
    if (!this.startCancellationRequested) return identity;
    return operatorBrowserProcessMatchesMarker(identity.pid, this.operatorBrowserMarker())
      ? identity
      : null;
  }

  private async waitForPersistentFallbackIdentity(): Promise<PersistentFallbackIdentityProof> {
    if (this.ownedChromeProcessTreeProof !== null) {
      return { state: "owned", identity: this.ownedChromeProcessTreeProof.identity };
    }
    const proof = await resolvePersistentFallbackIdentity({ profileDir: this.profileDir });
    if (
      proof.state === "owned" &&
      this.startCancellationRequested &&
      !operatorBrowserProcessMatchesMarker(proof.identity.pid, this.operatorBrowserMarker())
    ) {
      return { state: "unknown" };
    }
    if (proof.state === "owned") this.adoptOwnedChromeProcessTree(proof.identity, false);
    return proof;
  }

  private async requirePersistentFallbackOwnership(
    cleanupUnproven: () => Promise<void>,
  ): Promise<ProfileProcessIdentity> {
    try {
      const proof = await this.waitForPersistentFallbackIdentity();
      if (proof.state !== "owned" || this.ownedChromeProcessTreeProof === null) {
        throw new Error("persistent browser launch identity could not be bound to owner custody");
      }
      return proof.identity;
    } catch (error) {
      await cleanupUnproven().catch(() => undefined);
      this.persistentFallbackLaunchInFlight = false;
      throw error;
    }
  }

  private startPersistentFallbackOwnershipMonitor(): void {
    if (this.persistentFallbackOwnershipMonitor !== null) return;
    this.persistentFallbackOwnershipMonitor = (async () => {
      while (this.persistentFallbackLaunchInFlight && this.ownedChromeProcessTreeProof === null) {
        const holderPid = currentProfileHolderPid(this.profileDir);
        const identity =
          holderPid === null ? null : profileProcessIdentity(holderPid, this.profileDir);
        const controllerOwnsIdentity =
          identity !== null &&
          (!this.startCancellationRequested ||
            operatorBrowserProcessMatchesMarker(identity.pid, this.operatorBrowserMarker()));
        if (identity !== null && controllerOwnsIdentity) {
          this.launchedProfileHolderIdentity = identity;
          try {
            this.adoptOwnedChromeProcessTree(identity, false);
          } catch {}
          return;
        }
        await new Promise<void>((resolveWait) => {
          const timer = setTimeout(resolveWait, PROFILE_IDENTITY_POLL_MS);
          timer.unref();
        });
      }
    })();
  }

  private async waitForOwnedProfileExit(
    identity: ProfileProcessIdentity,
    existingProof?: OwnedChromeProcessTreeProof | null,
  ): Promise<boolean> {
    const deadline = Date.now() + PROFILE_IDENTITY_PROOF_TIMEOUT_MS;
    const proof = existingProof ?? captureOwnedChromeProcessTreeProof(identity, false);
    let state =
      proof === null
        ? profileProcessIdentityState(identity, this.profileDir)
        : ownedChromeProcessTreeState(proof);
    while (state !== "stale" && Date.now() < deadline) {
      if (proof !== null) {
        signalOwnedChromeProcessTree(identity, false, "SIGKILL", { proof });
      } else if (profileProcessMatches(identity, this.profileDir)) {
        signalOwnedChromeProcessTree(identity, false, "SIGKILL");
      }
      await new Promise<void>((resolveWait) => {
        const timer = setTimeout(resolveWait, PROFILE_IDENTITY_POLL_MS);
        timer.unref();
      });
      state =
        proof === null
          ? profileProcessIdentityState(identity, this.profileDir)
          : ownedChromeProcessTreeState(proof);
    }
    if (state !== "stale") return false;
    reapProfileHolderIfOwned(this.profileDir, identity);
    return true;
  }

  private async closeAfterStart(): Promise<ProfileCloseState> {
    if (this.startPromise !== null && !this.startSettled) {
      await Promise.race([this.startPromise.catch(() => undefined), this.startCancellation]);
    }
    if (this.startCancellationRequested) return await this.closeCancelledStart();
    return await this.closeBrowser();
  }

  private async closeBrowser(): Promise<ProfileCloseState> {
    this.pages.disposeRegistrations();
    if (this.pages.harnessAttachedPage) {
      this.pages.page = null;
      this.pages.primaryPage = null;
      this.pages.oauthProductPage = null;
      this.pages.oauthProviderPage = null;
      this.pages.oauthProviderPageClosed = false;
      this.context = null;
      return "closed";
    }
    const marker = this.operatorBrowserMarker();
    if (this.ownerLaunchTracked) markOwnerBrowserLaunchTerminal(marker);
    // Each step is best-effort and independent: a throw closing the page
    // or context must NOT skip the browser reap below, or an un-closed Chrome
    // keeps the profile's
    // SingletonLock held — bricking the next signup + `mcp connect`).
    //
    // EVERY close call is timeout-capped. On a wedged headed Chrome (e.g. a
    // run that crashed mid-captcha-click), BOTH page.close() AND
    // context.close() can hang INDEFINITELY — and an un-capped page.close()
    // blocked the reap below from ever running, so the browser leaked for
    // minutes and bricked the next 3 services (MEASURED 2026-06-09: supabase
    // crash → cockroachdb/weaviate/honeycomb all "profile held"). The cap
    // guarantees we always reach the SIGKILL reap.
    const page = this.pages.page;
    const context = this.context;
    const cdpBrowser = this.cdpBrowser;
    const childIdentity = this.childChromeIdentity;
    const childChromeProcessGroup = this.childChromeProcessGroup;
    const holderIdentity = this.launchedProfileHolderIdentity ?? this.currentOwnedProfileIdentity();
    const identity = this.ownedChromeProcessTreeProof?.identity ?? childIdentity ?? holderIdentity;
    const treeProof =
      identity === null
        ? null
        : (this.ownedChromeProcessTreeProof ??
          this.adoptOwnedChromeProcessTree(
            identity,
            childIdentity !== null ? childChromeProcessGroup : false,
          ));
    this.pages.page = null;
    this.pages.primaryPage = null;
    this.pages.oauthProductPage = null;
    this.pages.oauthProviderPage = null;
    this.pages.oauthProviderPageClosed = false;
    this.context = null;
    this.cdpBrowser = null;
    this.childChrome = null;
    this.childChromeIdentity = null;
    this.childChromeProcessGroup = false;
    this.launchedContext = false;
    this.launchedProfileHolderIdentity = null;
    const closeState = await closeProfileWithProof({
      profileDir: this.profileDir,
      identity,
      close: async () => {
        if (identity !== null) {
          signalOwnedChromeProcessTree(
            identity,
            treeProof?.processGroup ?? (childIdentity !== null ? childChromeProcessGroup : false),
            "SIGTERM",
            { ...(treeProof === null ? {} : { proof: treeProof }) },
          );
        }
        // A process-tree SIGTERM can close the CDP target before Playwright
        // observes it. That is successful teardown, not a reason to skip the
        // proof/reap path or retain a cleanly closed ephemeral profile.
        if (page !== null) await page.close().catch(() => undefined);
        if (context !== null) await context.close().catch(() => undefined);
        if (cdpBrowser !== null) await cdpBrowser.close().catch(() => undefined);
      },
      forceClose: () => {
        if (identity !== null) {
          signalOwnedChromeProcessTree(
            identity,
            treeProof?.processGroup ?? (childIdentity !== null ? childChromeProcessGroup : false),
            "SIGKILL",
            { ...(treeProof === null ? {} : { proof: treeProof }) },
          );
        }
        reapProfileHolderIfOwned(this.profileDir, identity);
      },
      ...(treeProof === null
        ? {}
        : { identityState: () => ownedChromeProcessTreeState(treeProof) }),
    });
    // Self-launch path: disconnect the CDP browser and SIGKILL the Chrome we
    // spawned. context.close() on a connectOverCDP context only disconnects —
    // it does NOT necessarily exit the browser process, which would leak the
    // SingletonLock and brick the next run (the reap below is the backstop, but
    // killing our own child directly is cleaner and faster).
    if (treeProof !== null && ownedChromeProcessTreeState(treeProof) === "stale") {
      releaseOwnedChromeProcessTree(treeProof);
      const tracked = selfManagedChromes.get(treeProof.identity.pid);
      if (tracked?.proof === treeProof) selfManagedChromes.delete(treeProof.identity.pid);
      if (this.ownedChromeProcessTreeProof === treeProof) {
        this.ownedChromeProcessTreeProof = null;
      }
    }
    const markerClosed =
      !this.ownerLaunchTracked || (await terminateOwnerBrowserLaunch(marker, this.profileDir));
    if (markerClosed && this.ownerLaunchTracked) {
      untrackOwnerBrowserLaunch(marker);
      this.ownerLaunchTracked = false;
    }
    await this.teardownOwnedDisplay().catch(() => undefined);
    return closeState === "closed" && !markerClosed ? "force_closed_unproven" : closeState;
  }
}
