import { expect, it, vi } from "vitest";
import { BrokerClientRegistry, brokerIdleTimeoutMs } from "../broker/daemon.js";
import { brokerEnvironment } from "../broker/discovery.js";
import { BrokerRuntime } from "../broker/runtime.js";

it("passes the socket path to a detached broker without disturbing its environment", () => {
  expect(brokerEnvironment({ PATH: "/bin" }, "/tmp/broker.sock")).toEqual({
    PATH: "/bin",
    TRUSTY_SQUIRE_BROKER_SOCKET: "/tmp/broker.sock",
  });
});

it("uses a minutes-scale idle policy", () => {
  expect(brokerIdleTimeoutMs({})).toBe(5 * 60_000);
  expect(brokerIdleTimeoutMs({ TRUSTY_SQUIRE_BROKER_IDLE_TIMEOUT_MS: "1000" })).toBe(60_000);
  expect(brokerIdleTimeoutMs({ TRUSTY_SQUIRE_BROKER_IDLE_TIMEOUT_MS: "600000" })).toBe(600_000);
});

it("does not let a status probe keep the shared Chrome resident", () => {
  const clients = new BrokerClientRegistry();
  clients.admit("probe-1", true);
  // A probe is admitted but never holds off the idle countdown, so a consumer
  // probing on any cadence cannot pin the browser tree.
  expect(clients.idle()).toBe(true);
  expect(clients.counts("probe-1")).toBe(false);
  clients.touch("probe-1");
  expect(clients.idle()).toBe(true);
  clients.retire("probe-1");
  expect(clients.idle()).toBe(true);
});

it("stays non-idle while an ordinary client is connected", () => {
  const clients = new BrokerClientRegistry();
  clients.admit("client-1", false);
  expect(clients.counts("client-1")).toBe(true);
  expect(clients.idle()).toBe(false);
  clients.admit("probe-1", true);
  expect(clients.idle()).toBe(false);
  clients.retire("probe-1");
  expect(clients.idle()).toBe(false);
  clients.retire("client-1");
  expect(clients.idle()).toBe(true);
});

it("counts a client that first appears on a call, not a connect", () => {
  const clients = new BrokerClientRegistry();
  clients.touch("client-1");
  expect(clients.idle()).toBe(false);
});

it("a close that cannot drain leaves the identity cell serving", async () => {
  // A close is refused whenever a live session still
  // owns the shared browser. `BrokerRuntime.close()` is what decides that, and
  // entering the closing state on that path is what wedged the broker for good:
  // every later acquire reads `closing` as "Identity cell is draining" and
  // refuses, while the sessions that blocked the drain keep it alive.
  vi.stubEnv("BOT_CDP_ENDPOINT", "http://127.0.0.1:1");
  try {
    const runtime = new BrokerRuntime();
    // `acquire` launches a real browser, so plant the session bookkeeping a
    // live session would hold directly: `close()` reads only this map.
    const sessions = (runtime as unknown as { sessions: Map<unknown, () => void> }).sessions;
    sessions.set({}, () => undefined);
    await expect(runtime.close()).resolves.toBe(false);
    sessions.clear();
    // Past the closing gate, the next launch is refused for an unrelated,
    // real reason rather than "Identity cell is draining".
    await expect(runtime.acquire({})).rejects.toThrow("Broker requires a locally owned browser");
  } finally {
    vi.unstubAllEnvs();
  }
});

it("a close whose force-close cannot prove the tree died leaves the cell serving", async () => {
  // The other exit that returns false. `closing` is the flag every later
  // `acquire` reads as "identity cell is draining", and `resume()` — the only
  // thing that clears it — refuses while an owner remains, so leaving it set
  // here wedged the broker permanently: every session refused, the idle
  // shutdown looping on the same failed close, and connect reporting a busy
  // browser no session actually owned.
  vi.stubEnv("BOT_CDP_ENDPOINT", "http://127.0.0.1:1");
  try {
    const runtime = new BrokerRuntime();
    const internals = runtime as unknown as {
      owner: { close: () => Promise<string>; forceCloseOwnedProcessTree: () => Promise<string> };
    };
    internals.owner = {
      close: async () => "unknown",
      forceCloseOwnedProcessTree: async () => "unknown",
    };
    await expect(runtime.close()).resolves.toBe(false);
    await expect(runtime.acquire({})).rejects.toThrow("Broker requires a locally owned browser");
  } finally {
    vi.unstubAllEnvs();
  }
});

it("a failed close leaves a pre-existing custody-unproven latch set", async () => {
  // `closing` means two things. A drain sets it for the duration of the drain.
  // The launch-failure path sets it when an owner could NOT be closed, with the
  // owner deliberately retained, so no later acquire touches a profile whose
  // Chrome was never proven dead. A close that fails must undo only its own
  // drain, never that latch — the daemon reports "retaining physical custody"
  // on exactly this path, and the runtime has to actually retain it.
  vi.stubEnv("BOT_CDP_ENDPOINT", "http://127.0.0.1:1");
  try {
    const runtime = new BrokerRuntime();
    const internals = runtime as unknown as {
      closing: boolean;
      owner: { close: () => Promise<string>; forceCloseOwnedProcessTree: () => Promise<string> };
    };
    internals.owner = {
      close: async () => "unknown",
      forceCloseOwnedProcessTree: async () => "unknown",
    };
    internals.closing = true;

    await expect(runtime.close()).resolves.toBe(false);
    await expect(runtime.acquire({})).rejects.toThrow("Identity cell is draining");
  } finally {
    vi.unstubAllEnvs();
  }
});
