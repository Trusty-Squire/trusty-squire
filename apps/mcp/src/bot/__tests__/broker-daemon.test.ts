import { expect, it, vi } from "vitest";
import {
  BrokerClientRegistry,
  brokerIdleTimeoutMs,
  completeMaintenanceCredentialRefresh,
} from "../broker/daemon.js";
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

it("terminates the drained broker when maintenance cannot refresh the credential", async () => {
  await expect(
    completeMaintenanceCredentialRefresh({
      profileIsFree: false,
      restore: async () => {
        throw new Error("must not restore while the profile is busy");
      },
    }),
  ).resolves.toBe("terminate");
});

it("refreshes credentials when the profile is free after maintenance", async () => {
  let restored = false;
  await expect(
    completeMaintenanceCredentialRefresh({
      profileIsFree: true,
      restore: async () => {
        restored = true;
      },
    }),
  ).resolves.toBe("restored");
  expect(restored).toBe(true);
});

it("terminates rather than keeping a stale digest when restore throws", async () => {
  await expect(
    completeMaintenanceCredentialRefresh({
      profileIsFree: true,
      restore: async () => {
        throw new Error("enrolled session is missing");
      },
    }),
  ).resolves.toBe("terminate");
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
  // A maintenance connect is answered `draining` whenever a live session still
  // owns the shared browser. `BrokerRuntime.close()` is what decides that, and
  // entering the closing state on that path is what wedged the broker for good:
  // every later acquire reads `closing` as "Identity cell is draining" and
  // refuses, while the sessions that blocked the drain keep it alive.
  vi.stubEnv("BOT_CDP_ENDPOINT", "http://127.0.0.1:1");
  try {
    const runtime = new BrokerRuntime("fixture-account");
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
