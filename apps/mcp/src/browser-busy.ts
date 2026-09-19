// One typed answer for "is the browser in use".
//
// Four layers each have their own word for busy: broker tab families, the
// profile lease, connect's maintenance window, and custody. A reader holding
// only one reasons correctly about the wrong layer — a queued page instruction
// read as a broker-wide wedge. This façade folds them at the package boundary.
// Wire refusal codes are unchanged; the mapping lives here, not on the broker
// protocol.
//
// Tab families are the layer that is NOT an answer: a live broker multiplexes
// many of them on one shared Chrome, so a running session never makes the
// browser unavailable, and the profile lease a live broker holds is that
// broker's own Chrome rather than a foreign process to close. `stale_lease`
// means "not yours, or gone" — a permanent failure, never "not now" — so it
// stays unmapped beside `cancelled` and `unauthorized`.

import { randomUUID } from "node:crypto";
import {
  brokerSocketPath,
  connectOrLaunchBroker,
  resolveBrokerSocket,
} from "./bot/broker/discovery.js";
import { BrokerRefusal } from "./bot/broker/refusal.js";
import { brokerEndpointHasLiveListener, type BrokerClient } from "./bot/broker/transport.js";
import { CHROME_PROFILE_DIR, profilePathIdentity, readLockHolder } from "./bot/profile.js";
import { createSessionGuard } from "./session-guard.js";

/**
 * Wire codes that mean "not now", each mapped onto exactly one layer. Private
 * on purpose: handing a consumer the per-layer vocabulary back is the thing
 * this façade exists to stop. `BrowserBusy.reason` is the public answer.
 */
const BUSY_REFUSAL_LAYER = {
  profile_busy: "profile",
  maintenance: "maintenance",
  broker_unavailable: "custody",
  incompatible_runtime: "custody",
  launch_timeout: "custody",
} as const;

type BusyRefusalCode = keyof typeof BUSY_REFUSAL_LAYER;

export type BrowserBusyReason =
  | {
      layer: "profile";
      code: "profile_busy";
      holder?: { pid?: number; host?: string };
    }
  | {
      layer: "maintenance";
      code: "maintenance";
      detail?: string;
    }
  | {
      layer: "custody";
      code: "broker_unavailable" | "incompatible_runtime" | "launch_timeout";
      detail?: string;
    };

export type BrowserStatus = { busy: false } | { busy: true; reason: BrowserBusyReason };

export interface PageCommandOptions {
  /**
   * Cancels the instruction through the wire `abort` frame. There is no
   * façade deadline: a navigate gets 60s per attempt over three attempts
   * inside the broker, so any bound invented here would fail a healthy slow
   * page — and aborting one does not stop the navigate already in flight.
   * Pass `AbortSignal.timeout(ms)` to choose a bound knowing that.
   */
  signal?: AbortSignal;
}

/** Structural page surface. Playwright's Page satisfies it. */
export interface TabPage {
  goto(url: string, options?: PageCommandOptions): Promise<unknown>;
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
  /**
   * Cancels the acquire. There is deliberately no façade deadline over it: the
   * broker owns the launch budget (connect, Chrome start, first observation)
   * and reports `launch_timeout` itself, so a cold start is never mistaken
   * here for a busy layer. This signal rides the wire `abort` frame.
   */
  signal?: AbortSignal;
}

export interface AcquireTabInput {
  signal?: AbortSignal;
}

export interface AcquiredTab {
  page: TabPage;
  release: () => Promise<void>;
}

export interface BrowserFacadePorts {
  /** Tab acquisition. Defaults to the broker wire. */
  acquire?: (input: AcquireTabInput) => Promise<AcquiredTab>;
}

/** The broker `open` needs a destination; the caller reaches its real page
 * through `tab.page.goto`. */
const BLANK_TAB_URL = "about:blank";

/**
 * The named profile is not the one this installation serves. No layer is
 * busy and no retry can clear it, so this is deliberately not a `BrowserBusy`.
 */
export class UnservableProfileError extends Error {
  constructor(
    readonly requested: string,
    readonly served: string,
  ) {
    super(`No broker serves the profile ${requested}; this installation serves ${served}`);
    this.name = "UnservableProfileError";
  }
}

export class BrowserBusy extends Error {
  readonly reason: BrowserBusyReason;
  constructor(reason: BrowserBusyReason, message?: string) {
    super(message ?? busyMessage(reason));
    this.name = "BrowserBusy";
    this.reason = reason;
  }
  action(): string {
    switch (this.reason.layer) {
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
    case "profile":
      return "The Chrome profile lease is already held";
    case "maintenance":
      return reason.detail ?? "Connect owns the browser maintenance window";
    case "custody":
      return reason.detail ?? `Browser custody refused (${reason.code})`;
  }
}

function isBusyRefusalCode(code: string): code is BusyRefusalCode {
  return Object.prototype.hasOwnProperty.call(BUSY_REFUSAL_LAYER, code);
}

function reasonFromBusyRefusal(
  code: BusyRefusalCode,
  extras: { message?: string; pid?: number; host?: string } = {},
): BrowserBusyReason {
  switch (code) {
    case "profile_busy": {
      const holder = {
        ...(extras.pid !== undefined ? { pid: extras.pid } : {}),
        ...(extras.host !== undefined ? { host: extras.host } : {}),
      };
      return Object.keys(holder).length === 0
        ? { layer: "profile", code }
        : { layer: "profile", code, holder };
    }
    case "maintenance":
      return extras.message === undefined
        ? { layer: "maintenance", code }
        : { layer: "maintenance", code, detail: extras.message };
    case "broker_unavailable":
    case "incompatible_runtime":
    case "launch_timeout":
      return extras.message === undefined
        ? { layer: "custody", code }
        : { layer: "custody", code, detail: extras.message };
  }
}

/**
 * The refusal a caller saw, as a busy answer — or undefined when it was not a
 * "not now" at all. The holder is only ever what the refusing layer reported;
 * the requester's own purpose is never dressed up as the blocker.
 */
function mapBusyRefusal(error: unknown): BrowserBusy | undefined {
  if (!(error instanceof BrokerRefusal) || !isBusyRefusalCode(error.code)) return undefined;
  return new BrowserBusy(
    reasonFromBusyRefusal(error.code, { message: error.message }),
    error.message,
  );
}

function resolveBrowserProfile(profile: string): string {
  return profilePathIdentity(profile === "default" ? CHROME_PROFILE_DIR : profile);
}

/** The single physical profile the broker is pinned to. */
function servedBrowserProfile(): string {
  return profilePathIdentity(CHROME_PROFILE_DIR);
}

/**
 * Read-only: a live broker listener, then the profile's lock holder. A live
 * broker owns the lease and hands out tab families, so its own Chrome is not
 * an answer of "busy". Nothing here repairs a lock, sweeps an owner, signals a
 * process, or sleeps.
 */
async function readBrowserStatus(): Promise<BrowserBusyReason | undefined> {
  if (await brokerEndpointHasLiveListener(brokerSocketPath())) return undefined;
  const holder = readLockHolder(servedBrowserProfile());
  if (holder === null || holder.stale) return undefined;
  return reasonFromBusyRefusal("profile_busy", { pid: holder.pid, host: holder.host });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * One wire call whose deadline is honoured by Contract B's reserved `abort`
 * control frame: the broker aborts exactly that request id and the connection,
 * its lease, and its other sessions are untouched.
 */
async function callWithWireAbort(
  client: BrokerClient,
  signal: AbortSignal | undefined,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  if (signal?.aborted === true) throw signal.reason;
  const requestId = randomUUID();
  const abort = (): void => {
    void client.abort(requestId);
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    return await client.call(method, params, requestId);
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

/**
 * The broker is the only path that returns a tab, and it is reachable from any
 * process: connect over the local socket exactly as the operator forwarder
 * does, then `open` / `command` / `close`.
 */
async function wireAcquire(input: AcquireTabInput): Promise<AcquiredTab> {
  const session = await createSessionGuard().bind();
  if (session?.agent_session_token === undefined)
    throw new BrokerRefusal("unauthorized", "Connect before opening a tab");
  const client = await connectOrLaunchBroker(
    resolveBrokerSocket(),
    session.agent_session_token,
    session.account_id,
  );
  try {
    const raw = await callWithWireAbort(client, input.signal, "open", {
      serviceUrl: BLANK_TAB_URL,
    });
    const sessionId = isRecord(raw) && typeof raw.sessionId === "string" ? raw.sessionId : "";
    if (sessionId.length === 0)
      throw new BrokerRefusal(
        "needs_user",
        "Broker handed the start back to the user; no tab was opened",
      );
    return {
      page: {
        goto: async (url: string, options: PageCommandOptions = {}) =>
          await callWithWireAbort(client, options.signal, "command", {
            sessionId,
            name: "operate_navigate",
            args: { session_id: sessionId, url },
          }),
      },
      release: async () => {
        try {
          await client.call("close", { sessionId, args: { session_id: sessionId } });
        } finally {
          await client.close();
        }
      },
    };
  } catch (error) {
    await client.close();
    throw error;
  }
}

export interface BrowserFacade {
  browserBusy(): Promise<BrowserStatus>;
  openTab(options: OpenTabOptions): Promise<TabHandle>;
}

export function createBrowserFacade(ports: BrowserFacadePorts = {}): BrowserFacade {
  const acquire = ports.acquire ?? wireAcquire;

  return {
    async browserBusy(): Promise<BrowserStatus> {
      const reason = await readBrowserStatus();
      return reason === undefined ? { busy: false } : { busy: true, reason };
    },

    async openTab(options: OpenTabOptions): Promise<TabHandle> {
      const profile = resolveBrowserProfile(options.profile);
      const served = servedBrowserProfile();
      if (profile !== served) throw new UnservableProfileError(profile, served);
      const purpose = options.purpose;
      let opened: AcquiredTab;
      try {
        opened = await acquire({
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
        });
      } catch (error) {
        throw mapBusyRefusal(error) ?? error;
      }
      let released = false;
      return {
        page: opened.page,
        profile,
        purpose,
        async release() {
          if (released) return;
          released = true;
          await opened.release();
        },
      };
    },
  };
}

const defaultFacade = createBrowserFacade();

export async function browserBusy(): Promise<BrowserStatus> {
  return await defaultFacade.browserBusy();
}

export async function openTab(options: OpenTabOptions): Promise<TabHandle> {
  return await defaultFacade.openTab(options);
}
