import type * as Profile from "../profile.js";
import { mkdir, mkdtemp, lstat, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ birth: "matching" as "matching" | "stale" | "unknown" }));
vi.mock("../profile.js", async (original) => ({
  ...(await original<typeof Profile>()),
  processBirthIdentityState: () => state.birth,
  get CHROME_PROFILE_DIR() {
    return process.env.TRUSTY_SQUIRE_PROFILE_DIR!;
  },
}));
let root: string;
let socket: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ts-broker-recovery-"));
  const profile = join(root, "profile");
  await mkdir(profile);
  vi.stubEnv("TRUSTY_SQUIRE_PROFILE_DIR", profile);
  vi.resetModules();
  socket = join(root, "broker.sock");
  await writeFile(socket, "fixture endpoint inode");
  const endpoint = await lstat(socket);
  await writeFile(
    `${socket}.owner.json`,
    JSON.stringify({
      version: 1,
      pid: 4321,
      start_time: "1",
      profileDir: profile,
      inode: endpoint.ino,
      device: endpoint.dev,
    }),
  );
  state.birth = "matching";
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
async function stalled() {
  const { BrokerRefusal } = await import("../broker/scheduler.js");
  const { BrokerClient } = await import("../broker/transport.js");
  vi.spyOn(BrokerClient, "connect").mockRejectedValue(
    new BrokerRefusal("broker_handshake_timeout", "Broker hello handshake timed out"),
  );
  return await import("../broker/discovery.js");
}
it("retires only the birth-proven unresponsive owner and preserves its journal", async () => {
  const { retireUnresponsiveBroker } = await stalled();
  const signal = vi.spyOn(process, "kill").mockImplementation(() => {
    state.birth = "stale";
    return true;
  });
  const journal = join(root, "profile", "trusty-squire-broker-dispatch.jsonl");
  await writeFile(journal, "unsettled payment fixture");
  await retireUnresponsiveBroker(socket, "token");
  expect(signal).toHaveBeenCalledOnce();
  expect(signal).toHaveBeenCalledWith(4321, "SIGTERM");
  const { readFile } = await import("node:fs/promises");
  expect(await readFile(journal, "utf8")).toBe("unsettled payment fixture");
});
it("does not terminate a healthy broker when a lineage handoff was slow", async () => {
  const { BrokerClient } = await import("../broker/transport.js");
  vi.spyOn(BrokerClient, "connect").mockResolvedValue({
    close: async () => undefined,
  } as never);
  const signal = vi.spyOn(process, "kill").mockImplementation(() => true);
  const { retireUnresponsiveBroker } = await import("../broker/discovery.js");
  await expect(retireUnresponsiveBroker(socket, "token")).rejects.toThrow("responsive");
  expect(signal).not.toHaveBeenCalled();
});
it("does not signal a process whose birth identity is unknown", async () => {
  const { retireUnresponsiveBroker } = await stalled();
  state.birth = "unknown";
  const signal = vi.spyOn(process, "kill").mockImplementation(() => true);
  await expect(retireUnresponsiveBroker(socket, "token")).rejects.toThrow("unproven");
  expect(signal).not.toHaveBeenCalled();
});
it("does not signal an owner when its endpoint was replaced", async () => {
  const { retireUnresponsiveBroker } = await stalled();
  const signal = vi.spyOn(process, "kill").mockImplementation(() => true);
  const { readFile } = await import("node:fs/promises");
  const owner = JSON.parse(await readFile(`${socket}.owner.json`, "utf8"));
  await writeFile(`${socket}.owner.json`, JSON.stringify({ ...owner, inode: owner.inode + 1 }));
  await expect(retireUnresponsiveBroker(socket, "token")).rejects.toThrow("ownership");
  expect(signal).not.toHaveBeenCalled();
});
