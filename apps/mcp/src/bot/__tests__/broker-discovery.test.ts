import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  connectOrLaunchBroker,
  defaultBrokerSocket,
  parseManagedBrokerShow,
} from "../broker/discovery.js";
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

  it("recognizes a Beeline-managed broker unit for its profile and ignores others", () => {
    const show = [
      "ExecStart={ path=/usr/bin/beeline ; argv[]=/usr/bin/beeline --squire-broker ; ignore_errors=no }",
      "Environment=PATH=/usr/bin TRUSTY_SQUIRE_PROFILE_DIR=/home/user/.trusty-squire/chrome-profile",
      "Id=trusty-squire-broker.service",
      "ActiveState=activating",
      "",
      "ExecStart={ path=/usr/bin/node ; argv[]=/usr/bin/node /opt/mcp/dist/bin.js broker ; ignore_errors=no }",
      "Environment=TRUSTY_SQUIRE_PROFILE_DIR=/home/user/.trusty-squire/signup-test-profile PATH=/usr/bin",
      "Id=trusty-squire-broker-signup.service",
      "ActiveState=active",
      "",
      "ExecStart={ path=/usr/bin/beeline ; argv[]=/usr/bin/beeline daemon --agent abc ; ignore_errors=no }",
      "Environment=BEELINE_MANAGED_BY_SYSTEMD=1 PATH=/usr/bin",
      "Id=beeline-agent@abc.service",
      "ActiveState=active",
      "",
    ].join("\n");
    const units = parseManagedBrokerShow(show);
    expect(units).toHaveLength(3);
    expect(units[0]).toMatchObject({
      id: "trusty-squire-broker.service",
      activeState: "activating",
      environment: { TRUSTY_SQUIRE_PROFILE_DIR: "/home/user/.trusty-squire/chrome-profile" },
    });
    expect(units[1]?.id).toBe("trusty-squire-broker-signup.service");
    expect(units[2]?.id).toBe("beeline-agent@abc.service");
  });
});
