import { brokerAccountBindingPath } from "./account-binding.js";
import { brokerAdmissionId } from "./admission-context.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { BrowserController } from "../browser.js";
import { IdentityRuntime } from "../identity-runtime.js";
import {
  acquireProfileOperationGuard,
  profilePathIdentity,
  CHROME_PROFILE_DIR,
  ProfileBusyError,
  waitForProfileFree,
  type ProfileOperationLease,
} from "../profile.js";
import type { BrokerBrowserCustody } from "./custody.js";
import { BrokerRefusal } from "./refusal.js";

interface Settings {
  profileDir: string;
  proxyUrl?: string;
}

/** Physical custody belongs to the broker. The otherwise-unused root controller
 * configures the context once and never becomes an operate session. */
export class BrokerRuntime implements BrokerBrowserCustody {
  private readonly runtimeIdentity = new IdentityRuntime<BrowserController, Settings>();
  private readonly sessions = new Map<BrowserController, () => void>();
  private readonly admissionIds = new Map<BrowserController, string>();
  private readonly pendingAdmissions = new Map<string, number>();
  private readonly releases = new Map<BrowserController, Promise<void>>();
  private readonly releaseHooks = new Map<BrowserController, Set<() => Promise<void>>>();
  private readonly provenClosed = new WeakSet<BrowserController>();
  private lease: ProfileOperationLease | undefined;
  private leaseProfile: string | undefined;
  private owner: BrowserController | undefined;
  private closing = false;
  private recycling = false;
  private pending = 0;

  constructor(private readonly accountId: string) {}

  claimProfile(profileDir = CHROME_PROFILE_DIR): void {
    const identity = profilePathIdentity(profileDir);
    if (this.lease !== undefined) {
      if (this.leaseProfile !== identity)
        throw new BrokerRefusal("incompatible_runtime", "Broker is pinned to one physical profile");
      return;
    }
    this.lease = acquireProfileOperationGuard(identity);
    this.leaseProfile = identity;
  }

  async acquire(options: {
    profileDir?: string;
    proxyUrl?: string;
  }): Promise<{ browser: BrowserController; profileDir: string }> {
    if (this.closing) throw new BrokerRefusal("maintenance", "Identity cell is draining");
    // Distinct from incompatible_runtime: that code means "not now, finish the
    // sessions pinning this identity". This is a standing configuration choice
    // no retry can clear.
    if ((process.env.BOT_CDP_ENDPOINT ?? "").trim() !== "")
      throw new BrokerRefusal(
        "external_browser",
        "Broker requires a locally owned browser; BOT_CDP_ENDPOINT names an external Chrome",
      );
    // A dead shared Chrome takes every live session with it. Forget the dead
    // tab families and relaunch on the same persistent profile before serving
    // the next start, instead of handing out pages from a dead browser.
    if (this.browserLost()) await this.recycleLostBrowser();
    const profileDir = profilePathIdentity(options.profileDir ?? CHROME_PROFILE_DIR);
    const settings = {
      profileDir,
      ...(options.proxyUrl === undefined ? {} : { proxyUrl: options.proxyUrl }),
    };
    if (this.recycling || this.runtimeIdentity.requestsIncompatibleIdentity(settings)) {
      if (this.recycling)
        throw new BrokerRefusal(
          "incompatible_runtime",
          "A proxy/identity recycle is already in progress; retry operate_start",
        );
      if (this.sessions.size > 0 || this.pending > 0)
        throw new BrokerRefusal(
          "incompatible_runtime",
          "A proxy or identity change requires no other active sessions on the broker " +
            "profile. Finish or close every active session first, then retry with the " +
            "new proxy; the shared Chrome is recycled in-band without killing the broker.",
        );
      this.recycling = true;
      try {
        await this.recycleIdentity();
      } finally {
        this.recycling = false;
      }
      if (this.closing) throw new BrokerRefusal("maintenance", "Identity cell is draining");
    }
    const admissionId = brokerAdmissionId();
    if (admissionId !== undefined)
      this.pendingAdmissions.set(admissionId, (this.pendingAdmissions.get(admissionId) ?? 0) + 1);
    this.pending++;
    try {
      const acquired = await this.runtimeIdentity.acquire(settings, async (settings) => {
        this.claimProfile(settings.profileDir);
        try {
          if (!(await waitForProfileFree(settings.profileDir, { deadlineMs: 0 })))
            throw new BrokerRefusal("profile_busy", "Profile is already open");
          await mkdir(settings.profileDir, { recursive: true, mode: 0o700 });
          const bindingPath = brokerAccountBindingPath(settings.profileDir);
          try {
            await writeFile(
              bindingPath,
              JSON.stringify({ version: 1, accountId: this.accountId }),
              { flag: "wx", mode: 0o600 },
            );
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            const binding = JSON.parse(await readFile(bindingPath, "utf8")) as {
              version: number;
              accountId: string;
            };
            if (binding.version !== 1 || binding.accountId !== this.accountId)
              throw new BrokerRefusal(
                "account_mismatch",
                "Profile is enrolled to a different account",
              );
          }
          const owner = new BrowserController(settings);
          this.owner = owner;
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              owner.start(),
              new Promise<never>((_resolve, reject) => {
                timer = setTimeout(
                  () =>
                    reject(new BrokerRefusal("launch_timeout", "Broker browser launch timed out")),
                  Number(process.env.BOT_START_TIMEOUT_MS) || 600_000,
                );
              }),
            ]);
          } finally {
            if (timer !== undefined) clearTimeout(timer);
          }
          return owner;
        } catch (error) {
          const closed =
            this.owner === undefined ||
            (await this.owner.close({ cancelStart: true }).catch(() => "unknown")) === "closed";
          if (closed) {
            this.lease?.release();
            this.lease = undefined;
            this.leaseProfile = undefined;
            this.owner = undefined;
          } else this.closing = true;
          throw error;
        }
      });
      let browser: BrowserController;
      try {
        if (this.closing) throw new BrokerRefusal("maintenance", "Identity cell is draining");
        browser = await BrowserController.attachSessionPage(acquired.handle, options);
      } catch (error) {
        acquired.releaseTabs();
        throw error;
      }
      this.sessions.set(browser, acquired.releaseTabs);
      if (admissionId !== undefined) this.admissionIds.set(browser, admissionId);
      return { browser, profileDir };
    } catch (error) {
      // The profile-operation lease and Chrome's SingletonLock both refuse
      // with a plain ProfileBusyError, which the wire flattens to
      // broker_execution_failed. It is the profile layer saying "not now", so
      // it has to reach the client under the code that says so.
      if (error instanceof ProfileBusyError) throw new BrokerRefusal("profile_busy", error.message);
      throw error;
    } finally {
      this.pending--;
      if (admissionId !== undefined) {
        const count = (this.pendingAdmissions.get(admissionId) ?? 1) - 1;
        if (count === 0) this.pendingAdmissions.delete(admissionId);
        else this.pendingAdmissions.set(admissionId, count);
      }
    }
  }

  /** Clean IN-BAND identity recycle for a compatible-profile settings change
   * (notably a new proxy): prove the live Chrome closed, release the profile
   * lease, then forget so the next acquire launches fresh. The broker process
   * stays up; the persistent profile — enrollment and Google login cookies —
   * lives on disk and survives the close. Callers must have proven no other
   * active sessions first; recycling under live siblings would yank the
   * shared Chrome out from under them. */
  private async recycleIdentity(): Promise<void> {
    if (this.owner !== undefined) {
      const closed = await this.owner.close().catch(() => "unknown" as const);
      if (closed !== "closed") {
        const forced = await this.owner
          .forceCloseOwnedProcessTree()
          .catch(() => "unknown" as const);
        if (forced !== "closed")
          throw new BrokerRefusal(
            "cleanup_unknown",
            "Previous broker browser did not close; the proxy/identity change was not applied",
          );
      }
    }
    this.lease?.release();
    this.lease = undefined;
    this.leaseProfile = undefined;
    this.owner = undefined;
    this.runtimeIdentity.forgetAfterShutdown();
  }

  /** Drop the tab bookkeeping of a browser that died underneath its sessions
   * and prove it is gone before the next launch may reclaim the profile. */
  private async recycleLostBrowser(): Promise<void> {
    for (const release of [...this.sessions.values()]) release();
    this.sessions.clear();
    this.admissionIds.clear();
    if (this.owner !== undefined) {
      const closed =
        (await this.owner.close().catch(() => "unknown" as const)) === "closed" ||
        (await this.owner.forceCloseOwnedProcessTree().catch(() => "unknown" as const)) ===
          "closed";
      if (!closed)
        throw new BrokerRefusal(
          "cleanup_unknown",
          "Lost broker browser did not close; refusing to relaunch over the shared profile",
        );
    }
    this.lease?.release();
    this.lease = undefined;
    this.leaseProfile = undefined;
    this.owner = undefined;
    this.runtimeIdentity.forgetAfterShutdown();
  }

  async cleanupAdmission(sessionId: string): Promise<boolean> {
    if (this.pendingAdmissions.has(sessionId)) return false;
    for (const [browser, id] of this.admissionIds) {
      if (id === sessionId) await this.release(browser);
    }
    // An incomplete physical launch retains the profile until process closure
    // is independently proven. Successful siblings must never be closed here.
    if (this.closing && this.sessions.size === 0) return await this.close();
    return !this.closing;
  }

  async orphanAdmission(sessionId: string): Promise<void> {
    if (this.pendingAdmissions.has(sessionId)) return;
    await Promise.all(
      [...this.admissionIds]
        .filter(([, id]) => id === sessionId)
        .map(async ([browser]) => await this.orphan(browser)),
    );
  }

  async orphan(browser: BrowserController): Promise<void> {
    const release = this.sessions.get(browser);
    if (release === undefined) return;
    this.sessions.delete(browser);
    this.admissionIds.delete(browser);
    release();
  }

  async release(browser: BrowserController, beforeRelease?: () => Promise<void>): Promise<void> {
    const existing = this.releases.get(browser);
    if (existing !== undefined) {
      if (beforeRelease !== undefined) this.releaseHooks.get(browser)!.add(beforeRelease);
      return await existing;
    }
    const hooks = new Set<() => Promise<void>>();
    if (beforeRelease !== undefined) hooks.add(beforeRelease);
    this.releaseHooks.set(browser, hooks);
    const operation = this.releaseOnce(browser, hooks);
    this.releases.set(browser, operation);
    try {
      await operation;
    } finally {
      this.releases.delete(browser);
      this.releaseHooks.delete(browser);
    }
  }

  private async releaseOnce(
    browser: BrowserController,
    hooks: Set<() => Promise<void>>,
  ): Promise<void> {
    const release = this.sessions.get(browser);
    if (release === undefined) {
      if (hooks.size > 0 && !this.provenClosed.has(browser))
        throw new BrokerRefusal("cleanup_unknown", "No retained closure proof for this tab family");
      for (const hook of hooks) await hook();
      return;
    }
    const state = await browser.closeOwnPagesOnly();
    if (state !== "closed")
      throw new BrokerRefusal("cleanup_unknown", "Tab family remains quarantined");
    for (const hook of hooks) await hook();
    this.provenClosed.add(browser);
    this.sessions.delete(browser);
    this.admissionIds.delete(browser);
    release();
  }

  /** What custody itself can see, for the wire `status` fold. */
  custodyStatus(): { draining: boolean; ownsLiveBrowser: boolean } {
    return {
      draining: this.closing,
      ownsLiveBrowser: this.owner !== undefined && this.owner.isConnected(),
    };
  }

  browserLost(): boolean {
    return (
      this.owner !== undefined && !this.runtimeIdentity.isLaunching() && !this.owner.isConnected()
    );
  }

  // Active tab families on the shared Chrome. A proxy/identity recycle is only
  // safe while this is zero.
  activeSessionCount(): number {
    return this.sessions.size;
  }

  resume(): void {
    if (this.owner !== undefined || this.pending !== 0 || this.sessions.size !== 0)
      throw new BrokerRefusal("maintenance", "Physical browser has not drained");
    this.closing = false;
  }

  async close(): Promise<boolean> {
    // `closing` is set only while a drain is actually in progress. It is what
    // every later `acquire` reads as "identity cell is draining", so a close
    // that returns false must leave it clear on EVERY such exit — live sessions
    // below, and the force-close that could not prove the tree died. Otherwise
    // the cell refuses every session forever: `resume()` is the only reset and
    // it refuses while an owner remains, so nothing would ever clear it.
    if (this.pending > 0 || this.sessions.size > 0) return false;
    this.closing = true;
    if (
      this.owner !== undefined &&
      (await this.owner.close().catch(() => "unknown")) !== "closed"
    ) {
      if ((await this.owner.forceCloseOwnedProcessTree().catch(() => "unknown")) !== "closed") {
        this.closing = false;
        return false;
      }
    }
    this.lease?.release();
    this.lease = undefined;
    this.leaseProfile = undefined;
    this.owner = undefined;
    this.runtimeIdentity.forgetAfterShutdown();
    return true;
  }
}
