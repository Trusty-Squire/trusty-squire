import { brokerAdmissionId } from "./admission-context.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withBrokerIdentityLane } from "./identity-lane.js";
import { BrowserController } from "../browser.js";
import { IdentityRuntime } from "../identity-runtime.js";
import {
  acquireProfileOperationGuard,
  profilePathIdentity,
  CHROME_PROFILE_DIR,
  waitForProfileFree,
  type ProfileOperationLease,
} from "../profile.js";
import type { BrokerBrowserCustody } from "./custody.js";
import { BrokerRefusal } from "./scheduler.js";

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
  private lease: ProfileOperationLease | undefined;
  private leaseProfile: string | undefined;
  private owner: BrowserController | undefined;
  private closing = false;
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

  async identity<T>(operation: () => Promise<T>): Promise<T> {
    return await withBrokerIdentityLane(operation);
  }

  async acquire(options: {
    profileDir?: string;
    proxyUrl?: string;
  }): Promise<{ browser: BrowserController; profileDir: string }> {
    if (this.closing) throw new BrokerRefusal("maintenance", "Identity cell is draining");
    if ((process.env.BOT_CDP_ENDPOINT ?? "").trim() !== "")
      throw new BrokerRefusal("incompatible_runtime", "Broker requires a locally owned browser");
    const profileDir = profilePathIdentity(options.profileDir ?? CHROME_PROFILE_DIR);
    const admissionId = brokerAdmissionId();
    if (admissionId !== undefined)
      this.pendingAdmissions.set(admissionId, (this.pendingAdmissions.get(admissionId) ?? 0) + 1);
    this.pending++;
    try {
      const acquired = await this.runtimeIdentity.acquire(
        { profileDir, ...(options.proxyUrl === undefined ? {} : { proxyUrl: options.proxyUrl }) },
        async (settings) => {
          this.claimProfile(settings.profileDir);
          try {
            if (!(await waitForProfileFree(settings.profileDir, { deadlineMs: 0 })))
              throw new BrokerRefusal("profile_busy", "Profile is already open");
            await mkdir(settings.profileDir, { recursive: true, mode: 0o700 });
            const bindingPath = join(settings.profileDir, "trusty-squire-broker-account.json");
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
                      reject(
                        new BrokerRefusal("launch_timeout", "Broker browser launch timed out"),
                      ),
                    Number(process.env.BOT_START_TIMEOUT_MS) || 600_000,
                  );
                }),
              ]);
            } finally {
              if (timer !== undefined) clearTimeout(timer);
            }
            await owner.enableBrokerRouting();
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
        },
      );
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
    } finally {
      this.pending--;
      if (admissionId !== undefined) {
        const count = (this.pendingAdmissions.get(admissionId) ?? 1) - 1;
        if (count === 0) this.pendingAdmissions.delete(admissionId);
        else this.pendingAdmissions.set(admissionId, count);
      }
    }
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
    if (existing !== undefined) return await existing;
    const operation = this.releaseOnce(browser, beforeRelease);
    this.releases.set(browser, operation);
    try {
      await operation;
    } finally {
      this.releases.delete(browser);
    }
  }

  private async releaseOnce(
    browser: BrowserController,
    beforeRelease?: () => Promise<void>,
  ): Promise<void> {
    const release = this.sessions.get(browser);
    if (release === undefined) return;
    const state = await browser.closeOwnPagesOnly();
    if (state !== "closed")
      throw new BrokerRefusal("cleanup_unknown", "Tab family remains quarantined");
    await beforeRelease?.();
    this.sessions.delete(browser);
    this.admissionIds.delete(browser);
    release();
  }

  browserLost(): boolean {
    return (
      this.owner !== undefined && !this.runtimeIdentity.isLaunching() && !this.owner.isConnected()
    );
  }

  resume(): void {
    if (this.owner !== undefined || this.pending !== 0 || this.sessions.size !== 0)
      throw new BrokerRefusal("maintenance", "Physical browser has not drained");
    this.closing = false;
  }

  async close(): Promise<boolean> {
    this.closing = true;
    if (this.pending > 0 || this.sessions.size > 0) return false;
    if (
      this.owner !== undefined &&
      (await this.owner.close().catch(() => "unknown")) !== "closed"
    ) {
      if ((await this.owner.forceCloseOwnedProcessTree().catch(() => "unknown")) !== "closed")
        return false;
    }
    this.lease?.release();
    this.lease = undefined;
    this.leaseProfile = undefined;
    this.owner = undefined;
    this.runtimeIdentity.forgetAfterShutdown();
    return true;
  }
}
