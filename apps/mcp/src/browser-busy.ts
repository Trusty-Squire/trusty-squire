// One typed answer for "is the browser in use".
//
// Four layers each have their own word for busy: broker tab families, the
// profile lease, connect's maintenance window, and custody. A reader holding
// only one reasons correctly about the wrong layer — a queued page instruction
// read as a broker-wide wedge. This façade folds them at the package boundary.
// Wire refusal codes are unchanged; the mapping lives here, not on the broker
// protocol.
//
// The fold itself is NOT computed here. `browserBusy` asks the broker, which
// is the only side that sees all four layers at the same instant; this module
// maps that answer, and openTab's refusals, onto one type. Inferring the
// answer from outside is what produced confident conclusions about the wrong
// layer — a live socket says nothing about whose Chrome holds the lease, and
// the connect maintenance window is not observable from another process at
// all. Only when no broker is resident does this read the profile lock
// directly, because then there is no broker to hold anything.
//
// Tab families are the layer that is never an answer: the broker multiplexes
// many on one shared Chrome, so a running family never makes the browser
// unavailable. `stale_lease` means "not yours, or gone" — a permanent
// failure, never "not now" — so it stays unmapped beside `cancelled` and
// `unauthorized`.

import { randomUUID } from "node:crypto";
import {
  brokerSocketPath,
  connectOrLaunchBroker,
  resolveBrokerSocket,
} from "./bot/broker/discovery.js";
import { BrokerRefusal } from "./bot/broker/refusal.js";
import { BrokerClient, brokerEndpointHasLiveListener } from "./bot/broker/transport.js";
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

/**
 * The broker handed the start back: no tab was opened and nothing changed.
 * Not a busy layer — no other process is holding anything — but it is the
 * likeliest first-run failure, so it carries the same actionable shape.
 */
export class BrowserNeedsUser extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserNeedsUser";
  }
  action(): string {
    return "Reconnect the browser session with `npx @trusty-squire/mcp connect`, then retry.";
  }
}

/**
 * The broker is pointed at an external Chrome it does not own. A standing
 * configuration choice rather than a layer that is busy: nothing is holding
 * the browser, and no retry clears it until the environment changes.
 */
export class ExternalBrowserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExternalBrowserError";
  }
  action(): string {
    return "Unset BOT_CDP_ENDPOINT so the broker owns its own Chrome, then retry.";
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
 * The refusal a caller saw, as one of this module's own types — or undefined
 * when it names nothing the façade models, in which case it propagates. The
 * holder is only ever what the refusing layer reported; the requester's own
 * purpose is never dressed up as the blocker.
 */
function mapBrokerRefusal(error: unknown): Error | undefined {
  if (!(error instanceof BrokerRefusal)) return undefined;
  if (error.code === "external_browser") return new ExternalBrowserError(error.message);
  if (!isBusyRefusalCode(error.code)) return undefined;
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
 * No broker is resident, so no broker holds anything and there is nothing to
 * ask: the only layer that can still answer is the profile lock. Read-only —
 * nothing here repairs a lock, sweeps an owner, signals a process, or sleeps.
 */
function unbrokeredBrowserStatus(): BrowserStatus {
  const holder = readLockHolder(servedBrowserProfile());
  if (holder === null || holder.stale) return { busy: false };
  return {
    busy: true,
    reason: reasonFromBusyRefusal("profile_busy", { pid: holder.pid, host: holder.host }),
  };
}

/** The broker's own answer, as this module's one type. */
function statusFromWire(raw: unknown): BrowserStatus {
  if (!isRecord(raw) || raw.busy !== true) return { busy: false };
  const holder = isRecord(raw.holder) ? raw.holder : undefined;
  const code = typeof raw.code === "string" && isBusyRefusalCode(raw.code) ? raw.code : undefined;
  if (code === undefined) return { busy: false };
  return {
    busy: true,
    reason: reasonFromBusyRefusal(code, {
      ...(typeof raw.detail === "string" ? { message: raw.detail } : {}),
      ...(typeof holder?.pid === "number" ? { pid: holder.pid } : {}),
      ...(typeof holder?.host === "string" ? { host: holder.host } : {}),
    }),
  };
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

async function agentSessionToken(): Promise<
  { token: string; accountId: string | undefined } | undefined
> {
  const session = await createSessionGuard().bind();
  if (session?.agent_session_token === undefined) return undefined;
  return { token: session.agent_session_token, accountId: session.account_id };
}

/**
 * Ask the broker. A resident broker is the only thing that can see the
 * maintenance window and knows whether the Chrome on the profile is its own;
 * when none is resident there is nothing to ask and nothing brokered to hold.
 */
export async function browserBusy(): Promise<BrowserStatus> {
  const socket = brokerSocketPath();
  if (!(await brokerEndpointHasLiveListener(socket))) return unbrokeredBrowserStatus();
  const credentials = await agentSessionToken();
  if (credentials === undefined)
    throw new BrowserNeedsUser(
      "A broker is running but this machine has no enrolled account, so its answer cannot be asked for",
    );
  const client = await BrokerClient.connect(socket, credentials.token, { probe: true });
  try {
    return statusFromWire(await client.call("status", {}));
  } finally {
    await client.close();
  }
}

/**
 * The broker is the only path that returns a tab, and it is reachable from any
 * process: connect over the local socket exactly as the operator forwarder
 * does, then `open` / `command` / `close`.
 */
export async function openTab(options: OpenTabOptions): Promise<TabHandle> {
  const profile = resolveBrowserProfile(options.profile);
  const served = servedBrowserProfile();
  if (profile !== served) throw new UnservableProfileError(profile, served);
  const purpose = options.purpose;
  const credentials = await agentSessionToken();
  if (credentials === undefined)
    throw new BrowserNeedsUser("No enrolled account on this machine; no tab was opened");
  let client: BrokerClient;
  try {
    client = await connectOrLaunchBroker(
      resolveBrokerSocket(),
      credentials.token,
      credentials.accountId,
    );
  } catch (error) {
    throw mapBrokerRefusal(error) ?? error;
  }
  let sessionId: string;
  try {
    const raw = await callWithWireAbort(client, options.signal, "open", {
      serviceUrl: BLANK_TAB_URL,
    });
    sessionId = isRecord(raw) && typeof raw.sessionId === "string" ? raw.sessionId : "";
    if (sessionId.length === 0)
      throw new BrowserNeedsUser("The broker handed the start back to the user; no tab was opened");
  } catch (error) {
    await client.close();
    throw mapBrokerRefusal(error) ?? error;
  }
  let released = false;
  return {
    page: {
      goto: async (url: string, pageOptions: PageCommandOptions = {}) =>
        await callWithWireAbort(client, pageOptions.signal, "command", {
          sessionId,
          name: "operate_navigate",
          args: { session_id: sessionId, url },
        }),
    },
    profile,
    purpose,
    async release() {
      if (released) return;
      released = true;
      try {
        await client.call("close", { sessionId, args: { session_id: sessionId } });
      } finally {
        await client.close();
      }
    },
  };
}
