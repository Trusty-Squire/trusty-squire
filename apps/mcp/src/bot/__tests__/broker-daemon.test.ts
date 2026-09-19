import { expect, it } from "vitest";
import {
  BrokerClientRegistry,
  brokerIdleTimeoutMs,
  completeMaintenanceCredentialRefresh,
} from "../broker/daemon.js";
import { brokerEnvironment } from "../broker/discovery.js";

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
