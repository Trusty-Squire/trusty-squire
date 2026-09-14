import { expect, it } from "vitest";
import { brokerIdleTimeoutMs } from "../broker/daemon.js";
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
