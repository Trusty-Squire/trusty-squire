// One typed answer for "is the browser in use".
//
// Four layers each have their own word for busy (tab families, profile
// leases, connect's maintenance window, custody). A reader who holds only
// one will reason correctly about the wrong layer. This façade folds them
// at the package boundary. Wire refusal codes are unchanged; the mapping
// lives here, not on the broker protocol.

import { brokerBrowserCustody } from "./bot/broker/custody.js";
import { BrokerRefusal } from "./bot/broker/refusal.js";
import {
  CHROME_PROFILE_DIR,
  currentProfileHolderPid,
  ProfileBusyError,
  profilePathIdentity,
  waitForProfileFree,
} from "./bot/profile.js";

/** Wire codes that mean "not now", each mapped onto exactly one layer. */
export const BUSY_REFUSAL_LAYER = {
  stale_lease: "tabs",
  profile_busy: "profile",
  maintenance: "maintenance",
  broker_unavailable: "custody",
  incompatible_runtime: "custody",
  launch_timeout: "custody",
} as const;

export type BusyRefusalCode = keyof typeof BUSY_REFUSAL_LAYER;
export type BrowserBusyLayer = (typeof BUSY_REFUSAL_LAYER)[BusyRefusalCode];

export type BrowserBusyReason =
  | {
      layer: "tabs";
      code: "stale_lease";
      holder: { purpose: string; sessionId?: string };
    }
  | {
      layer: "profile";
      code: "profile_busy";
      holder?: { purpose?: string; pid?: number; host?: string };
    }
  | {
      layer: "maintenance";
      code: "maintenance";
      owner?: string;
    }
  | {
      layer: "custody";
      code: "broker_unavailable" | "incompatible_runtime" | "launch_timeout";
      detail?: string;
    };

export type BrowserStatus = { busy: false } | { busy: true; reason: BrowserBusyReason };

/** Structural page surface. Playwright's Page satisfies it. */
export interface TabPage {
  goto(url: string): Promise<unknown>;
}

export interface TabHandle {
  readonly page: TabPage;
  readonly profile: string;
  readonly purpose: string;
  release(): Promise<void>;
}

export interface OpenTabOptions {
  profile: string;
  purpose: string;
  /** Bound on the acquire finishing or aborting. Never a poll sleep. */
  deadlineMs?: number;
  signal?: AbortSignal;
}

export interface BrowserBusyInspect {
  tabs?: (profile: string) => BrowserBusyReason | undefined;
  profile?: (
    profile: string,
  ) => BrowserBusyReason | undefined | Promise<BrowserBusyReason | undefined>;
  maintenance?: (profile: string) => BrowserBusyReason | undefined;
  custody?: (profile: string) => BrowserBusyReason | undefined;
}

export interface AcquireTabInput {
  profile: string;
  purpose: string;
  signal: AbortSignal;
}

export interface AcquiredTab {
  page: TabPage;
  release: () => Promise<void>;
  sessionId?: string;
}

export interface BrowserFacadePorts {
  inspect?: BrowserBusyInspect;
  acquire?: (input: AcquireTabInput) => Promise<AcquiredTab>;
  /**
   * Fired when the façade deadline elapses so a broker request registered
   * through `OperatorBroker.withRegisteredRequest` can be aborted.
   */
  abortRegistered?: (signal: AbortSignal) => void;
}

const OPEN_TAB_DEFAULT_DEADLINE_MS = 30_000;

export class BrowserBusy extends Error {
  readonly reason: BrowserBusyReason;
  constructor(reason: BrowserBusyReason, message?: string) {
    super(message ?? busyMessage(reason));
    this.name = "BrowserBusy";
    this.reason = reason;
  }
  action(): string {
    switch (this.reason.layer) {
      case "tabs":
        return `Release the tab held for ${this.reason.holder.purpose}, then retry.`;
      case "profile": {
        const pid = this.reason.holder?.pid;
        return pid === undefined
          ? "Close the other process using this Chrome profile, then retry."
          : `Close the other process using this Chrome profile (pid ${pid}), then retry.`;
      }
      case "maintenance":
        return "Finish the connect login window that owns maintenance, then retry.";
      case "custody":
        switch (this.reason.code) {
          case "broker_unavailable":
            return "Start or reconnect the operator broker, then retry.";
          case "incompatible_runtime":
            return "Finish the sessions that pin this browser identity, then retry.";
          case "launch_timeout":
            return "Retry the launch; the previous attempt was aborted at its deadline.";
        }
    }
  }
}

function busyMessage(reason: BrowserBusyReason): string {
  switch (reason.layer) {
    case "tabs":
      return `A tab family is already held for ${reason.holder.purpose}`;
    case "profile":
      return "The Chrome profile lease is already held";
    case "maintenance":
      return "Connect owns the browser maintenance window";
    case "custody":
      return reason.detail ?? `Browser custody refused (${reason.code})`;
  }
}

export function isBusyRefusalCode(code: string): code is BusyRefusalCode {
  return Object.prototype.hasOwnProperty.call(BUSY_REFUSAL_LAYER, code);
}

export function reasonFromBusyRefusal(
  code: BusyRefusalCode,
  extras: {
    message?: string;
    purpose?: string;
    sessionId?: string;
    pid?: number;
    host?: string;
    owner?: string;
  } = {},
): BrowserBusyReason {
  switch (code) {
    case "stale_lease": {
      const holder: { purpose: string; sessionId?: string } = {
        purpose: extras.purpose ?? extras.message ?? "unknown",
      };
      if (extras.sessionId !== undefined) holder.sessionId = extras.sessionId;
      return { layer: "tabs", code, holder };
    }
    case "profile_busy": {
      const holder =
        extras.pid !== undefined || extras.host !== undefined || extras.purpose !== undefined
          ? {
              ...(extras.purpose !== undefined ? { purpose: extras.purpose } : {}),
              ...(extras.pid !== undefined ? { pid: extras.pid } : {}),
              ...(extras.host !== undefined ? { host: extras.host } : {}),
            }
          : undefined;
      return holder === undefined
        ? { layer: "profile", code }
        : { layer: "profile", code, holder };
    }
    case "maintenance":
      return extras.owner === undefined
        ? { layer: "maintenance", code }
        : { layer: "maintenance", code, owner: extras.owner };
    case "broker_unavailable":
    case "incompatible_runtime":
    case "launch_timeout":
      return extras.message === undefined
        ? { layer: "custody", code }
        : { layer: "custody", code, detail: extras.message };
  }
}

export function mapBusyRefusal(
  error: unknown,
  extras: { purpose?: string; sessionId?: string } = {},
): BrowserBusy | undefined {
  if (error instanceof ProfileBusyError) {
    return new BrowserBusy(reasonFromBusyRefusal("profile_busy", { message: error.message }));
  }
  if (!(error instanceof BrokerRefusal) || !isBusyRefusalCode(error.code)) return undefined;
  const mapped = reasonFromBusyRefusal(error.code, {
    message: error.message,
    ...extras,
  });
  return new BrowserBusy(mapped, error.message);
}

export function resolveBrowserProfile(profile: string): string {
  if (profile === "default") return profilePathIdentity(CHROME_PROFILE_DIR);
  return profilePathIdentity(profile);
}

async function defaultProfileBusy(profile: string): Promise<BrowserBusyReason | undefined> {
  const free = await waitForProfileFree(profile, { deadlineMs: 0 });
  if (free) return undefined;
  const pid = currentProfileHolderPid(profile);
  return reasonFromBusyRefusal(
    "profile_busy",
    pid === null ? {} : { pid },
  );
}

function defaultCustodyBusy(): BrowserBusyReason | undefined {
  if ((process.env.BOT_CDP_ENDPOINT ?? "").trim() !== "") {
    return reasonFromBusyRefusal("incompatible_runtime", {
      message: "Broker requires a locally owned browser",
    });
  }
  return undefined;
}

async function defaultAcquire(input: AcquireTabInput): Promise<AcquiredTab> {
  const custody = brokerBrowserCustody();
  if (custody === undefined) {
    throw new BrowserBusy(
      reasonFromBusyRefusal("broker_unavailable", {
        message: "Broker custody is not installed in this process",
      }),
    );
  }
  if (input.signal.aborted) {
    throw input.signal.reason instanceof Error
      ? input.signal.reason
      : new BrowserBusy(reasonFromBusyRefusal("launch_timeout", { message: "openTab aborted" }));
  }
  const acquired = await custody.acquire({ profileDir: input.profile });
  const page = acquired.browser.page;
  if (page === null) {
    await custody.release(acquired.browser);
    throw new BrowserBusy(
      reasonFromBusyRefusal("broker_unavailable", {
        message: "Acquired browser has no page",
      }),
    );
  }
  return {
    page,
    release: async () => {
      await custody.release(acquired.browser);
    },
  };
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new BrowserBusy(
    reasonFromBusyRefusal("launch_timeout", { message: "openTab aborted" }),
  );
}

function runWithDeadline<T>(
  deadlineMs: number,
  userSignal: AbortSignal | undefined,
  abortRegistered: ((signal: AbortSignal) => void) | undefined,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const onUserAbort = (): void => {
    controller.abort(userSignal?.reason ?? abortError(controller.signal));
  };
  if (userSignal?.aborted) onUserAbort();
  else userSignal?.addEventListener("abort", onUserAbort, { once: true });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const reason = new BrowserBusy(
        reasonFromBusyRefusal("launch_timeout", {
          message: `openTab deadline elapsed after ${deadlineMs}ms`,
        }),
      );
      controller.abort(reason);
      abortRegistered?.(controller.signal);
      reject(reason);
    }, deadlineMs);
  });

  return Promise.race([operation(controller.signal), deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
    userSignal?.removeEventListener("abort", onUserAbort);
  });
}

export interface BrowserFacade {
  browserBusy(options?: { profile?: string }): Promise<BrowserStatus>;
  openTab(options: OpenTabOptions): Promise<TabHandle>;
}

export function createBrowserFacade(ports: BrowserFacadePorts = {}): BrowserFacade {
  const held = new Map<string, { purpose: string; sessionId?: string }>();

  const tabsInspect =
    ports.inspect?.tabs ??
    ((profile: string): BrowserBusyReason | undefined => {
      const holder = held.get(profile);
      return holder === undefined
        ? undefined
        : reasonFromBusyRefusal("stale_lease", holder);
    });
  const profileInspect = ports.inspect?.profile ?? defaultProfileBusy;
  const maintenanceInspect = ports.inspect?.maintenance ?? (() => undefined);
  const custodyInspect = ports.inspect?.custody ?? defaultCustodyBusy;
  const acquire = ports.acquire ?? defaultAcquire;

  async function inspect(profile: string): Promise<BrowserBusyReason | undefined> {
    return (
      tabsInspect(profile) ??
      maintenanceInspect(profile) ??
      (await profileInspect(profile)) ??
      custodyInspect(profile)
    );
  }

  return {
    async browserBusy(options = {}): Promise<BrowserStatus> {
      const profile = resolveBrowserProfile(options.profile ?? "default");
      const reason = await inspect(profile);
      return reason === undefined ? { busy: false } : { busy: true, reason };
    },

    async openTab(options: OpenTabOptions): Promise<TabHandle> {
      const profile = resolveBrowserProfile(options.profile);
      const purpose = options.purpose;
      const deadlineMs = options.deadlineMs ?? OPEN_TAB_DEFAULT_DEADLINE_MS;
      const opened = await runWithDeadline(
        deadlineMs,
        options.signal,
        ports.abortRegistered,
        async (signal) => {
          const reason = await inspect(profile);
          if (reason !== undefined) throw new BrowserBusy(reason);
          if (signal.aborted) throw abortError(signal);
          try {
            return await acquire({ profile, purpose, signal });
          } catch (error) {
            if (error instanceof BrowserBusy) throw error;
            const mapped = mapBusyRefusal(error, { purpose });
            if (mapped !== undefined) throw mapped;
            throw error;
          }
        },
      );
      const holder: { purpose: string; sessionId?: string } = { purpose };
      if (opened.sessionId !== undefined) holder.sessionId = opened.sessionId;
      held.set(profile, holder);
      let released = false;
      return {
        page: opened.page,
        profile,
        purpose,
        async release() {
          if (released) return;
          released = true;
          held.delete(profile);
          await opened.release();
        },
      };
    },
  };
}

const defaultFacade = createBrowserFacade();

export async function browserBusy(options?: { profile?: string }): Promise<BrowserStatus> {
  return await defaultFacade.browserBusy(options);
}

export async function openTab(options: OpenTabOptions): Promise<TabHandle> {
  return await defaultFacade.openTab(options);
}
