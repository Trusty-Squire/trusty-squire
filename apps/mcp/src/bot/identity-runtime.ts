// Runtime foundation for broker custody; see docs/browser-process-page-boundary.md.
// Generic over the launched handle so tests need not construct a real browser.

export class IncompatibleIdentityRuntimeSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IncompatibleIdentityRuntimeSettingsError";
  }
}

export interface IdentityRuntimeCloseable {
  close(): Promise<unknown>;
}

export interface AcquiredIdentity<THandle> {
  handle: THandle;
  // Increments on every real (re)launch. A caller that stashes this value can
  // later detect a stale reference: if the runtime's currentEpoch() has moved
  // on, the handle it was given no longer names the live Chrome.
  epoch: number;
  // True when this acquire() was served by the already-live Chrome rather
  // than a fresh launch.
  reused: boolean;
  // Releases THIS caller's claim on the shared Chrome's tab family. Never
  // closes Chrome; the owner closes it before forgetAfterShutdown(). Idempotent.
  releaseTabs: () => void;
}

export interface IdentityRuntimeOptions<TSettings> {
  // Structural compatibility check between the currently-live settings and a
  // newly-requested set. Defaults to strict JSON equality. Override when
  // TSettings carries fields that shouldn't gate reuse (e.g. a label used
  // only for logging).
  settingsCompatible?: (live: TSettings, requested: TSettings) => boolean;
}

function defaultSettingsCompatible<TSettings>(live: TSettings, requested: TSettings): boolean {
  return JSON.stringify(live) === JSON.stringify(requested);
}

/** Owns one Chrome for one identity/profile. Launch is single-flight; tab
 * acquisition and Chrome shutdown are deliberately separate operations so
 * releasing a session never has to mean tearing the browser down. */
export class IdentityRuntime<THandle extends IdentityRuntimeCloseable, TSettings> {
  private handle: THandle | null = null;
  private settings: TSettings | null = null;
  private pendingSettings: TSettings | null = null;
  private epoch = 0;
  private launchPromise: Promise<THandle> | null = null;
  private leaseCount = 0;
  private readonly settingsCompatible: (live: TSettings, requested: TSettings) => boolean;

  constructor(opts: IdentityRuntimeOptions<TSettings> = {}) {
    this.settingsCompatible = opts.settingsCompatible ?? defaultSettingsCompatible;
  }

  currentEpoch(): number {
    return this.epoch;
  }

  isLive(): boolean {
    return this.handle !== null;
  }

  isLaunching(): boolean {
    return this.launchPromise !== null;
  }

  activeLeaseCount(): number {
    return this.leaseCount;
  }

  // Detects a stale reference: true once the runtime has moved past the epoch
  // a caller was handed at acquire time (a relaunch happened underneath it).
  isEpochStale(epoch: number): boolean {
    return epoch !== this.epoch;
  }

  /**
   * Acquires this identity's Chrome, launching it at most once for any number
   * of concurrent callers. `launch` runs only for the caller that wins the
   * single-flight race; every other concurrent caller (and every caller while
   * a compatible instance is already live) awaits that one launch or reuses
   * the live handle without relaunching.
   *
   * A request whose settings differ from the currently live (or in-flight)
   * launch is rejected rather than silently applied to the shared context —
   * the caller must forgetAfterShutdown() a live runtime before requesting
   * different settings.
   */
  async acquire(
    settings: TSettings,
    launch: (settings: TSettings) => Promise<THandle>,
  ): Promise<AcquiredIdentity<THandle>> {
    const liveSettings = this.settings ?? this.pendingSettings;
    if (liveSettings !== null && !this.settingsCompatible(liveSettings, settings)) {
      throw new IncompatibleIdentityRuntimeSettingsError(
        "IdentityRuntime.acquire: requested settings are incompatible with the live/in-flight " +
          "identity. Refusing to mutate a shared browser context — call forgetAfterShutdown() " +
          "after closing it, then acquire() again for a fresh identity.",
      );
    }
    if (this.handle !== null) {
      this.leaseCount += 1;
      return {
        handle: this.handle,
        epoch: this.epoch,
        reused: true,
        releaseTabs: this.makeReleaseTabs(),
      };
    }
    if (this.launchPromise === null) {
      this.pendingSettings = settings;
      this.launchPromise = launch(settings).finally(() => {
        this.pendingSettings = null;
      });
    }
    let handle: THandle;
    try {
      handle = await this.launchPromise;
    } finally {
      this.launchPromise = null;
    }
    // Only the first continuation to resume after the shared launch settles
    // records it as the live identity — every other concurrent waiter sees
    // `this.handle !== null` below and joins as a reuse rather than
    // double-counting the same launch as a second (re)launch.
    const wonLaunch = this.handle === null;
    if (wonLaunch) {
      this.handle = handle;
      this.settings = settings;
      this.epoch += 1;
    }
    const resolvedHandle = this.handle;
    if (resolvedHandle === null) {
      throw new Error("IdentityRuntime: invariant violated — no live handle after acquire");
    }
    this.leaseCount += 1;
    return {
      handle: resolvedHandle,
      epoch: this.epoch,
      reused: !wonLaunch,
      releaseTabs: this.makeReleaseTabs(),
    };
  }

  private makeReleaseTabs(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.leaseCount = Math.max(0, this.leaseCount - 1);
    };
  }

  /**
   * Forgets the current identity so the next acquire() launches fresh. Does
   * NOT close Chrome — the owner must prove closure before calling this;
   * forgetting an unproven owner would permit a competing launch.
   * Safe to call when nothing is live.
   */
  forgetAfterShutdown(): void {
    this.handle = null;
    this.settings = null;
    this.leaseCount = 0;
  }
}
