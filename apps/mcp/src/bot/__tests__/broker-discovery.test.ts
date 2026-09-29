import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  connectOrLaunchBroker,
  defaultBrokerSocket,
  managedBrokerUnitSocketPath,
  parseManagedBrokerShow,
  unitDefersOnDemandLaunch,
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
      "ExecStart={ path=/usr/bin/node ; argv[]=/usr/bin/node /opt/mcp/dist/bin.js broker ; ignore_errors=no }",
      "Environment=TRUSTY_SQUIRE_PROFILE_DIR=/home/user/.trusty-squire/chrome-profile PATH=/usr/bin",
      "Id=trusty-squire-broker-dead.service",
      "ActiveState=failed",
      "",
    ].join("\n");
    const units = parseManagedBrokerShow(show);
    const profile = "/home/user/.trusty-squire/chrome-profile";
    expect(units).toHaveLength(4);
    expect(units[0]).toMatchObject({
      id: "trusty-squire-broker.service",
      activeState: "activating",
      environment: { TRUSTY_SQUIRE_PROFILE_DIR: "/home/user/.trusty-squire/chrome-profile" },
    });
    expect(units[1]?.id).toBe("trusty-squire-broker-signup.service");
    expect(units[2]?.id).toBe("beeline-agent@abc.service");
    expect(units[3]).toMatchObject({
      id: "trusty-squire-broker-dead.service",
      activeState: "failed",
    });
    expect(unitDefersOnDemandLaunch(units[0]!, profile)).toBe(true);
    expect(unitDefersOnDemandLaunch(units[3]!, profile)).toBe(false);
  });

  it("reads the endpoint a live managed unit configured for its profile", () => {
    const show = [
      "ExecStart={ path=/usr/bin/beeline ; argv[]=/usr/bin/beeline --squire-broker ; ignore_errors=no }",
      "Environment=TRUSTY_SQUIRE_PROFILE_DIR=/home/user/.trusty-squire/chrome-profile TRUSTY_SQUIRE_BROKER_SOCKET=/home/user/.trusty-squire/broker.sock",
      "Id=trusty-squire-broker.service",
      "ActiveState=active",
      "",
    ].join("\n");
    const units = parseManagedBrokerShow(show);
    expect(managedBrokerUnitSocketPath(units[0]!)).toBe("/home/user/.trusty-squire/broker.sock");
    expect(managedBrokerUnitSocketPath(null)).toBeNull();
  });

  it.skipIf(process.platform !== "linux")(
    "reaches a live managed unit that bound a custom broker socket",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "ts-broker-unit-socket-"));
      roots.push(root);
      const profile = join(root, "chrome-profile");
      const custom = join(root, "beeline.sock");
      await mkdir(profile);
      // The Beeline unit serves this profile on a non-default socket. `connect`
      // runs without the env, so its only way to the owner is the unit itself.
      const binDir = join(root, "bin");
      await mkdir(binDir);
      const systemctl = join(binDir, "systemctl");
      await writeFile(
        systemctl,
        [
          "#!/bin/sh",
          "cat <<'SHOW'",
          "ExecStart={ path=/usr/bin/beeline ; argv[]=/usr/bin/beeline --squire-broker ; ignore_errors=no }",
          `Environment=TRUSTY_SQUIRE_PROFILE_DIR=${profile} TRUSTY_SQUIRE_BROKER_SOCKET=${custom}`,
          "Id=trusty-squire-broker.service",
          "ActiveState=active",
          "SHOW",
        ].join("\n"),
      );
      await chmod(systemctl, 0o755);
      const listener = await listenBroker(custom, {
        call: async () => ({ via: "unit" }),
        disconnect: async () => undefined,
      });
      const previousPath = process.env.PATH;
      const previousProfile = process.env.TRUSTY_SQUIRE_PROFILE_DIR;
      process.env.PATH = `${binDir}:${previousPath ?? ""}`;
      process.env.TRUSTY_SQUIRE_PROFILE_DIR = profile;
      try {
        const client = await connectOrLaunchBroker(defaultBrokerSocket(profile));
        expect(await client.call("status", {})).toEqual({ via: "unit" });
        await client.close();
      } finally {
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
        if (previousProfile === undefined) delete process.env.TRUSTY_SQUIRE_PROFILE_DIR;
        else process.env.TRUSTY_SQUIRE_PROFILE_DIR = previousProfile;
        await listener.close();
      }
    },
    20_000,
  );
});
