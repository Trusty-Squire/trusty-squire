import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { symlinkSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureOnDemandBroker,
  onDemandStartEligible,
  onDemandStartLockPath,
  OnDemandBrokerStartError,
  reapOrphanedProfileChrome,
  userServiceManagerAvailable,
  type OnDemandBrokerDeps,
} from "../on-demand.js";
import { writeBrokerUnitMarker, removeBrokerUnitMarker } from "../managed-marker.js";
import { profileDeviceAnchor } from "../../profile.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function freshProfile(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ts-on-demand-"));
  roots.push(root);
  const profile = join(root, ".trusty-squire", "chrome-profile");
  await mkdir(profile, { recursive: true, mode: 0o700 });
  return profile;
}

class FakeChild extends EventEmitter {
  pid: number | undefined = undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  unref(): void {
    /* detached */
  }
}

function sockets(root: string): { wire: string; mcp: string } {
  return { wire: join(root, "broker.sock"), mcp: join(root, "mcp.sock") };
}

describe("on-demand broker start eligibility", () => {
  it("is ineligible when a user service manager is available", async () => {
    const profile = await freshProfile();
    expect(onDemandStartEligible(profile, () => true)).toBe(false);
  });

  it("is ineligible when a managed-broker marker owns the profile", async () => {
    const profile = await freshProfile();
    const anchor = profileDeviceAnchor(profile);
    if (anchor === null) throw new Error("missing anchor");
    await writeBrokerUnitMarker(profile, {
      version: 1,
      socket: join(profile, "broker.sock"),
      profile: anchor,
      accountBinding: null,
    });
    try {
      expect(onDemandStartEligible(profile, () => false)).toBe(false);
    } finally {
      await removeBrokerUnitMarker(profile);
    }
  });

  it("is eligible when no manager and no marker exist", async () => {
    const profile = await freshProfile();
    expect(onDemandStartEligible(profile, () => false)).toBe(true);
  });
});

describe("on-demand broker start lock", () => {
  it("serializes concurrent callers so only one spawn runs", async () => {
    const profile = await freshProfile();
    const root = join(profile, "..", "..");
    let spawns = 0;
    let live = false;
    const deps: OnDemandBrokerDeps = {
      managerAvailable: () => false,
      liveSocket: async () => live,
      reapOrphanedChrome: async () => undefined,
      spawnBroker: () => {
        spawns += 1;
        const child = new FakeChild();
        setTimeout(() => {
          live = true;
        }, 80);
        return child;
      },
    };
    await Promise.all([
      ensureOnDemandBroker(profile, sockets(root), { deps }),
      ensureOnDemandBroker(profile, sockets(root), { deps }),
      ensureOnDemandBroker(profile, sockets(root), { deps }),
    ]);
    expect(spawns).toBe(1);
  });

  it("does not retry inside one failed attempt and surfaces the broker output", async () => {
    const profile = await freshProfile();
    const root = join(profile, "..", "..");
    let spawns = 0;
    const deps: OnDemandBrokerDeps = {
      managerAvailable: () => false,
      liveSocket: async () => false,
      reapOrphanedChrome: async () => undefined,
      spawnBroker: ({ logPath }) => {
        spawns += 1;
        const child = new FakeChild();
        writeFileSync(logPath, "Profile lock does not identify Chrome for this profile\n", {
          mode: 0o600,
        });
        queueMicrotask(() => {
          child.exitCode = 1;
          child.emit("exit", 1, null);
        });
        return child;
      },
    };
    const first = ensureOnDemandBroker(profile, sockets(root), { deps });
    const second = ensureOnDemandBroker(profile, sockets(root), { deps });
    await expect(first).rejects.toThrow(OnDemandBrokerStartError);
    await expect(first).rejects.toThrow(/Profile lock does not identify Chrome/);
    await expect(first).rejects.toThrow(/No retry was attempted/);
    await expect(second).rejects.toThrow(/Profile lock does not identify Chrome|in-flight attempt/);
    expect(spawns).toBe(1);
  });

  it("lets a later call start once after a previous attempt finished", async () => {
    const profile = await freshProfile();
    const root = join(profile, "..", "..");
    let spawns = 0;
    const deps: OnDemandBrokerDeps = {
      managerAvailable: () => false,
      liveSocket: async () => false,
      reapOrphanedChrome: async () => undefined,
      spawnBroker: ({ logPath }) => {
        spawns += 1;
        const child = new FakeChild();
        writeFileSync(logPath, `boom-${spawns}\n`, { mode: 0o600 });
        queueMicrotask(() => {
          child.exitCode = 1;
          child.emit("exit", 1, null);
        });
        return child;
      },
    };
    await expect(ensureOnDemandBroker(profile, sockets(root), { deps })).rejects.toThrow(/boom-1/);
    await expect(ensureOnDemandBroker(profile, sockets(root), { deps })).rejects.toThrow(/boom-2/);
    expect(spawns).toBe(2);
  });

  it("does not spawn when a user service manager is available", async () => {
    const profile = await freshProfile();
    const root = join(profile, "..", "..");
    let spawns = 0;
    await ensureOnDemandBroker(profile, sockets(root), {
      deps: {
        managerAvailable: () => true,
        liveSocket: async () => false,
        spawnBroker: () => {
          spawns += 1;
          return new FakeChild();
        },
      },
    });
    expect(spawns).toBe(0);
  });

  it("does not spawn when a unit marker owns the profile", async () => {
    const profile = await freshProfile();
    const root = join(profile, "..", "..");
    const anchor = profileDeviceAnchor(profile);
    if (anchor === null) throw new Error("missing anchor");
    await writeBrokerUnitMarker(profile, {
      version: 1,
      socket: join(root, "broker.sock"),
      profile: anchor,
      accountBinding: null,
    });
    let spawns = 0;
    try {
      await ensureOnDemandBroker(profile, sockets(root), {
        deps: {
          managerAvailable: () => false,
          liveSocket: async () => false,
          spawnBroker: () => {
            spawns += 1;
            return new FakeChild();
          },
        },
      });
      expect(spawns).toBe(0);
    } finally {
      await removeBrokerUnitMarker(profile);
    }
  });

  it("names the lock beside the profile, not inside it", async () => {
    const profile = await freshProfile();
    const lock = onDemandStartLockPath(profile);
    expect(lock.startsWith(join(profile, ".."))).toBe(true);
    expect(lock.includes(".lock")).toBe(true);
  });
});

describe("orphan Chrome reap", () => {
  it("does not signal Chrome when a broker socket is live", async () => {
    const profile = await freshProfile();
    const signaled: Array<[number, NodeJS.Signals]> = [];
    symlinkSync(`${hostname()}-99999`, join(profile, "SingletonLock"));
    await reapOrphanedProfileChrome(profile, {
      wireSocket: join(profile, "broker.sock"),
      liveSocket: async () => true,
      brokerPid: () => null,
      kill: (pid, signal) => {
        signaled.push([pid, signal]);
      },
    });
    expect(signaled).toEqual([]);
  });

  it("does not signal Chrome when a live broker holds the profile", async () => {
    const profile = await freshProfile();
    const signaled: Array<[number, NodeJS.Signals]> = [];
    symlinkSync(`${hostname()}-99999`, join(profile, "SingletonLock"));
    await reapOrphanedProfileChrome(profile, {
      liveSocket: async () => false,
      brokerPid: () => 7,
      kill: (pid, signal) => {
        signaled.push([pid, signal]);
      },
    });
    expect(signaled).toEqual([]);
  });
});

describe("user service manager detection", () => {
  it("reports a live systemd user manager when systemctl answers a live state", () => {
    if (process.platform !== "linux") return;
    try {
      execFileSync("systemctl", ["--user", "is-system-running"], {
        encoding: "utf8",
        timeout: 2_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const stdout = (error as { stdout?: string }).stdout ?? "";
      if (!/^(running|degraded)\s*$/m.test(stdout)) return;
    }
    expect(userServiceManagerAvailable()).toBe(true);
  });

  it("does not treat a failing systemctl as a live user manager", async () => {
    if (process.platform !== "linux") return;
    const root = await mkdtemp(join(tmpdir(), "ts-fake-systemctl-"));
    roots.push(root);
    writeFileSync(
      join(root, "systemctl"),
      "#!/bin/sh\necho 'System has not been booted with systemd as init system (PID 1).' >&2\nexit 1\n",
      { mode: 0o755 },
    );
    const prior = process.env.PATH ?? "";
    process.env.PATH = `${root}:${prior}`;
    try {
      expect(userServiceManagerAvailable()).toBe(false);
    } finally {
      process.env.PATH = prior;
    }
  });
});
