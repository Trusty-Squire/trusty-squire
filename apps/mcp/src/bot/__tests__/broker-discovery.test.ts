import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { connectOrLaunchBroker, defaultBrokerSocket } from "../broker/discovery.js";
import { listenBroker } from "../broker/transport.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("broker discovery", () => {
  it("derives one endpoint for canonical profile aliases", async () => {
    const root = await mkdtemp(join(tmpdir(), "ts-broker-discovery-")); roots.push(root);
    const profile = join(root, "profile");
    const alias = join(root, "alias");
    await mkdir(profile);
    await symlink(profile, alias);
    expect(defaultBrokerSocket(alias)).toBe(defaultBrokerSocket(profile));
  });

  it("attaches to the live broker without launching a second one", async () => {
    const root = await mkdtemp(join(tmpdir(), "ts-broker-discovery-")); roots.push(root);
    const socket = join(root, "broker.sock");
    const listener = await listenBroker(socket, {
      call: async () => ({ live: true }),
      disconnect: async () => undefined,
    });
    try {
      const client = await connectOrLaunchBroker(socket);
      expect(await client.call("status", {})).toEqual({ live: true });
      await client.close();
    } finally { await listener.close(); }
  });
});
