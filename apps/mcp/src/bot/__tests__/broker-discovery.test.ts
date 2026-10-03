import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  brokerConnectionTarget,
  connectBroker,
  defaultBrokerSocket,
  findLiveManagedBrokerUnit,
  liveUnixSocket,
  parseManagedBrokerShow,
  readSystemctlUnits,
  resolveBrokerSocket,
  unitServesLiveProfile,
} from "../broker/discovery.js";
import { listenBroker } from "../broker/transport.js";
import {
  acquireProfileOperationGuard,
  ProfileBusyError,
  profileDeviceAnchor,
  profileDeviceIdentity,
  profileOperationLockPath,
} from "../profile.js";
import {
  brokerUnitMarkerPath,
  writeBrokerUnitMarker,
  removeBrokerUnitMarker,
} from "../broker/managed-marker.js";
import { brokerAccountBindingPath } from "../broker/account-binding.js";
import { sharedMcpSocketPath } from "../broker/mcp-socket-path.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** Prepend an executable fake `systemctl` to PATH for the duration of `fn`.
 * Returns the value `fn` produced. */
async function withSystemctlShim<T>(script: string, fn: () => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "ts-systemctl-shim-"));
  roots.push(root);
  const bin = join(root, "systemctl");
  writeFileSync(bin, script, { mode: 0o755 });
  const priorPath = process.env.PATH ?? "";
  process.env.PATH = `${root}:${priorPath}`;
  try {
    return await fn();
  } finally {
    process.env.PATH = priorPath;
  }
}

const FAILING_SYSTEMCTL = `#!/bin/sh\nexit 1\n`;

function liveUnitShim(profileDir: string, socket: string): string {
  return [
    `#!/bin/sh`,
    `if [ "$1" = "--user" ]; then`,
    `  cat <<'EOF'`,
    `Id=trusty-squire-broker.service`,
    `ActiveState=activating`,
    `Environment=TRUSTY_SQUIRE_PROFILE_DIR=${profileDir} TRUSTY_SQUIRE_BROKER_SOCKET=${socket}`,
    `ExecStart={ path=/usr/bin/node ; argv[]=/usr/bin/node /opt/mcp/dist/bin.js broker ; ignore_errors=no }`,
    `EOF`,
    `  exit 0`,
    `fi`,
    `exit 1`,
  ].join("\n");
}

/** The sandbox profile every test process is pointed at by isolate-config-home. */
function sandboxProfile(): string {
  return (
    process.env.TRUSTY_SQUIRE_PROFILE_DIR ??
    join(process.env.HOME ?? "/tmp", ".trusty-squire", "chrome-profile")
  );
}

function ensureProfile(profile: string): void {
  mkdirSync(profile, { recursive: true, mode: 0o700 });
}

async function writeProfileMarker(
  profile: string,
  socket: string,
  accountBinding: string | null = null,
): Promise<void> {
  const anchor = profileDeviceAnchor(profile);
  if (anchor === null) throw new Error("profile has no device anchor");
  mkdirSync(join(profile, ".."), { recursive: true });
  await writeBrokerUnitMarker(profile, {
    version: 1,
    socket,
    profile: anchor,
    accountBinding,
  });
}

describe("broker discovery", () => {
  it("derives one endpoint and one lock for canonical profile aliases", async () => {
    const root = await mkdtemp(join(tmpdir(), "ts-broker-discovery-"));
    roots.push(root);
    const profile = join(root, "profile");
    const alias = join(root, "alias");
    await mkdir(profile);
    await symlink(profile, alias);
    // One socket name, one MCP name, one lock name for one physical profile.
    expect(defaultBrokerSocket(alias)).toBe(defaultBrokerSocket(profile));
    expect(sharedMcpSocketPath(root, alias)).toBe(sharedMcpSocketPath(root, profile));
    expect(profileOperationLockPath(alias)).toBe(profileOperationLockPath(profile));
    // One lock: holding via one path blocks via the other.
    const lease = acquireProfileOperationGuard(profile);
    try {
      expect(() => acquireProfileOperationGuard(alias)).toThrow(ProfileBusyError);
    } finally {
      lease.release();
    }
  });

  it("keys identity on the parent, so a replaced profile directory keeps one identity and one broker endpoint", async () => {
    const root = await mkdtemp(join(tmpdir(), "ts-broker-discovery-"));
    roots.push(root);
    const profile = join(root, "profile");
    ensureProfile(profile);
    const identityBefore = profileDeviceIdentity(profile);
    const socketBefore = defaultBrokerSocket(profile);
    const lockBefore = profileOperationLockPath(profile);
    // The basis is the parent's dev/ino plus the profile directory's name,
    // computed here independently of profileDeviceIdentity.
    const parent = statSync(dirname(profile));
    expect(identityBefore).toBe(`${parent.dev}:${parent.ino}:${basename(profile)}`);
    // A replaced directory inode does not change that basis.
    // --force-relogin replaces the whole directory at the same path.
    await rm(profile, { recursive: true, force: true });
    ensureProfile(profile);
    expect(profileDeviceIdentity(profile)).toBe(identityBefore);
    expect(defaultBrokerSocket(profile)).toBe(socketBefore);
    expect(profileOperationLockPath(profile)).toBe(lockBefore);
  });

  it("keeps one identity and one endpoint when the profile parent is created after the first read", async () => {
    const root = await mkdtemp(join(tmpdir(), "ts-broker-discovery-"));
    roots.push(root);
    const profile = join(root, ".trusty-squire", "signup-test-profile");
    // The first read happens before anything exists under root. Creating the
    // parent later (daemon startup, an MCP listener) must not move the anchor
    // from the nearest ancestor to the new parent.
    const identityBefore = profileDeviceIdentity(profile);
    const wireBefore = defaultBrokerSocket(profile);
    const mcpBefore = sharedMcpSocketPath(root, profile);
    await mkdir(join(root, ".trusty-squire"), { recursive: true, mode: 0o700 });
    expect(profileDeviceIdentity(profile)).toBe(identityBefore);
    expect(defaultBrokerSocket(profile)).toBe(wireBefore);
    expect(sharedMcpSocketPath(root, profile)).toBe(mcpBefore);
  });

  it("attaches to the live broker without launching a second one", async () => {
    const root = await mkdtemp(join(tmpdir(), "ts-broker-discovery-"));
    roots.push(root);
    const socket = join(root, "broker.sock");
    const listener = await listenBroker(socket, {
      call: async () => ({ live: true }),
      disconnect: async () => undefined,
    });
    try {
      const client = await connectBroker(socket);
      expect(await client.call("status", {})).toEqual({ live: true });
      await client.close();
    } finally {
      await listener.close();
    }
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
    expect(unitServesLiveProfile(units[0]!, profile)).toBe(true);
    expect(unitServesLiveProfile(units[3]!, profile)).toBe(false);
  });

  it("finds the live unit's configured broker socket for its profile", () => {
    const show = [
      "ExecStart={ path=/usr/bin/beeline ; argv[]=/usr/bin/beeline --squire-broker ; ignore_errors=no }",
      "Environment=TRUSTY_SQUIRE_PROFILE_DIR=/home/user/.trusty-squire/chrome-profile TRUSTY_SQUIRE_BROKER_SOCKET=/home/user/.trusty-squire/broker.sock",
      "Id=trusty-squire-broker.service",
      "ActiveState=active",
      "",
    ].join("\n");
    const units = parseManagedBrokerShow(show);
    expect(
      findLiveManagedBrokerUnit(units, "/home/user/.trusty-squire/chrome-profile")?.environment
        .TRUSTY_SQUIRE_BROKER_SOCKET,
    ).toBe("/home/user/.trusty-squire/broker.sock");
    expect(
      findLiveManagedBrokerUnit(units, "/home/user/.trusty-squire/other-profile"),
    ).toBeUndefined();
    expect(
      findLiveManagedBrokerUnit(
        [{ ...units[0]!, activeState: "failed" }],
        "/home/user/.trusty-squire/chrome-profile",
      ),
    ).toBeUndefined();
  });
});

describe("managed-broker connection discovery", () => {
  it("parses a failing systemctl as unknown, not no-unit", async () => {
    await withSystemctlShim(FAILING_SYSTEMCTL, async () => {
      expect(readSystemctlUnits(sandboxProfile())).toEqual({ state: "unknown" });
    });
  });

  it("a failing systemctl without a marker only resolves a connection target", async () => {
    await withSystemctlShim(FAILING_SYSTEMCTL, async () => {
      const decision = await brokerConnectionTarget(sandboxProfile(), "/tmp/ts-absent-broker.sock");
      expect(decision.socket).toBe("/tmp/ts-absent-broker.sock");
    });
  });

  it("the marker wins over a failing systemctl: never spawns, waits for the declared socket", async () => {
    const profile = sandboxProfile();
    ensureProfile(profile);
    const declared = join("/tmp", `ts-broker-marker-${randomUUID()}.sock`);
    await writeProfileMarker(profile, declared);
    try {
      await withSystemctlShim(FAILING_SYSTEMCTL, async () => {
        const decision = await brokerConnectionTarget(profile, defaultBrokerSocket(profile));
        expect(decision.socket).toBe(declared);
      });
    } finally {
      await removeBrokerUnitMarker(profile);
    }
  });

  it("a marker with no socket still never reopens spawning", async () => {
    const profile = sandboxProfile();
    ensureProfile(profile);
    // An unparsable marker file is present but invalid: fail closed.
    const path = brokerUnitMarkerPath(profile);
    mkdirSync(join(profile, ".."), { recursive: true });
    writeFileSync(path, "{ not json", { mode: 0o600 });
    try {
      const decision = await brokerConnectionTarget(profile, defaultBrokerSocket(profile));
      expect(decision.socket).toBe(defaultBrokerSocket(profile));
    } finally {
      await rm(path, { force: true });
    }
  });

  it("spawning is blocked while a live unit is restarting with its socket absent", async () => {
    const profile = sandboxProfile();
    ensureProfile(profile);
    const unitSocket = join("/tmp", `ts-broker-restart-${randomUUID()}.sock`); // absent
    await withSystemctlShim(liveUnitShim(profile, unitSocket), async () => {
      const decision = await brokerConnectionTarget(profile, defaultBrokerSocket(profile));
      expect(decision.socket).toBe(unitSocket);
    });
  });

  it("an enrolled client joins a live unit whose profile is not yet bound", async () => {
    const profile = sandboxProfile();
    ensureProfile(profile);
    await removeBrokerUnitMarker(profile);
    // Fresh unit or --force-relogin profile: no binding file yet. The client's
    // first account-acting acquire claims it, so joining must be allowed.
    await rm(brokerAccountBindingPath(profile), { force: true });
    const unitSocket = join("/tmp", `ts-broker-unit-unbound-${randomUUID()}.sock`);
    const listener = await listenBroker(unitSocket, {
      call: async () => ({ live: true }),
      disconnect: async () => undefined,
    });
    try {
      await withSystemctlShim(liveUnitShim(profile, unitSocket), async () => {
        const client = await connectBroker(defaultBrokerSocket(profile), {
          accountId: "account-a",
        });
        try {
          expect(await client.call("status", {})).toEqual({ live: true });
        } finally {
          await client.close();
        }
      });
    } finally {
      await listener.close();
    }
  });

  it("refuses to join a live managed unit whose profile is bound to a different account", async () => {
    const profile = sandboxProfile();
    ensureProfile(profile);
    await removeBrokerUnitMarker(profile);
    const unitSocket = join("/tmp", `ts-broker-unit-account-${randomUUID()}.sock`);
    // The profile this live unit serves is bound to account-a.
    writeFileSync(
      brokerAccountBindingPath(profile),
      JSON.stringify({ version: 1, accountId: "account-a" }) + "\n",
      { mode: 0o600 },
    );
    const listener = await listenBroker(unitSocket, {
      call: async () => ({ live: true }),
      disconnect: async () => undefined,
    });
    try {
      await withSystemctlShim(liveUnitShim(profile, unitSocket), async () => {
        await expect(
          connectBroker(defaultBrokerSocket(profile), { accountId: "account-b" }),
        ).rejects.toThrow(/account_mismatch|bound to account/);
      });
    } finally {
      await listener.close();
      await rm(brokerAccountBindingPath(profile), { force: true });
    }
  });

  it("recognizes a live unit through a bind-mount alias by device identity", async () => {
    // A bind mount is the case realpath cannot resolve, so profilePathIdentity
    // sees two paths where profileDeviceIdentity sees one profile. Creating one
    // needs an unprivileged user namespace; without it the case cannot be
    // reproduced here and the test stands aside.
    const probe = spawnSync("unshare", ["-Ur", "-m", "true"], { stdio: "ignore" });
    if (probe.status !== 0) {
      console.warn("skipping bind-mount alias test: unprivileged user namespaces unavailable");
      return;
    }
    const root = await mkdtemp(join(tmpdir(), "ts-broker-bindmount-"));
    roots.push(root);
    const realParent = join(root, "real-parent");
    const aliasParent = join(root, "mnt");
    await mkdir(join(realParent, "chrome-profile"), { recursive: true });
    await mkdir(aliasParent, { recursive: true });
    const real = join(realParent, "chrome-profile");
    const alias = join(aliasParent, "chrome-profile");
    const discoveryUrl = new URL("../broker/discovery.ts", import.meta.url).href;
    const profileUrl = new URL("../profile-path.ts", import.meta.url).href;
    const probePath = join(root, "alias-probe.mjs");
    await writeFile(
      probePath,
      [
        `import { unitServesLiveProfile } from ${JSON.stringify(discoveryUrl)};`,
        `import { profileDeviceIdentity } from ${JSON.stringify(profileUrl)};`,
        `const unit = {`,
        `  id: "trusty-squire-broker.service",`,
        `  activeState: "active",`,
        `  execStart: "{ path=/usr/bin/node ; argv[]=/usr/bin/node /opt/mcp/dist/bin.js broker ; ignore_errors=no }",`,
        `  environment: { TRUSTY_SQUIRE_PROFILE_DIR: ${JSON.stringify(real)} },`,
        `};`,
        `process.stdout.write(JSON.stringify({`,
        `  defers: unitServesLiveProfile(unit, ${JSON.stringify(alias)}),`,
        `  real: profileDeviceIdentity(${JSON.stringify(real)}),`,
        `  alias: profileDeviceIdentity(${JSON.stringify(alias)}),`,
        `}));`,
        ``,
      ].join("\n"),
    );
    const shell = [
      `mount --bind ${JSON.stringify(realParent)} ${JSON.stringify(aliasParent)}`,
      `cd ${JSON.stringify(process.cwd())}`,
      `node --import tsx ${JSON.stringify(probePath)}`,
    ].join(" && ");
    const result = spawnSync(
      "unshare",
      ["-Ur", "-m", "--propagation", "private", "sh", "-c", shell],
      {
        encoding: "utf8",
      },
    );
    expect(result.status, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout) as { defers: boolean; real: string; alias: string };
    // Same physical profile, two path strings: device identity must agree and
    // the live unit must be recognised rather than a competitor spawned.
    expect(parsed.real).toBe(parsed.alias);
    expect(parsed.defers).toBe(true);
  }, 30_000);

  it("refuses to join a managed socket declaring a different profile", async () => {
    const profile = sandboxProfile();
    ensureProfile(profile);
    const other = join(tmpdir(), "other-profile");
    mkdirSync(other, { recursive: true });
    const socket = join("/tmp", `ts-broker-foreign-${randomUUID()}.sock`);
    await writeProfileMarker(profile, socket, null);
    try {
      // Rewrite the marker so its declared anchor is a different physical profile.
      const path = brokerUnitMarkerPath(profile);
      writeFileSync(
        path,
        JSON.stringify({
          version: 1,
          socket,
          profile: { dev: 1, ino: 2, name: "other-profile" },
          accountBinding: null,
        }) + "\n",
        { mode: 0o600 },
      );
      const listener = await listenBroker(socket, {
        call: async () => ({ live: true }),
        disconnect: async () => undefined,
      });
      try {
        await expect(connectBroker(defaultBrokerSocket(profile))).rejects.toThrow(
          /different profile|Refusing to join/,
        );
      } finally {
        await listener.close();
      }
    } finally {
      await removeBrokerUnitMarker(profile);
    }
  });

  it("refuses to join a managed socket declaring a different account binding", async () => {
    const profile = sandboxProfile();
    ensureProfile(profile);
    const socket = join("/tmp", `ts-broker-account-${randomUUID()}.sock`);
    const anchor = profileDeviceAnchor(profile);
    if (anchor === null) throw new Error("profile has no device anchor");
    const path = brokerUnitMarkerPath(profile);
    mkdirSync(join(profile, ".."), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        socket,
        profile: anchor,
        accountBinding: "account-b",
      }) + "\n",
      { mode: 0o600 },
    );
    try {
      const listener = await listenBroker(socket, {
        call: async () => ({ live: true }),
        disconnect: async () => undefined,
      });
      try {
        await expect(
          connectBroker(defaultBrokerSocket(profile), { accountId: "account-a" }),
        ).rejects.toThrow(/account_mismatch|different account|bound to account/);
      } finally {
        await listener.close();
      }
    } finally {
      await removeBrokerUnitMarker(profile);
    }
  });

  it("an enrolled client joins a marker whose profile is not yet bound", async () => {
    const profile = sandboxProfile();
    ensureProfile(profile);
    await rm(brokerAccountBindingPath(profile), { force: true });
    const socket = join("/tmp", `ts-broker-marker-unbound-${randomUUID()}.sock`);
    await writeProfileMarker(profile, socket, null);
    try {
      const listener = await listenBroker(socket, {
        call: async () => ({ live: true }),
        disconnect: async () => undefined,
      });
      try {
        const client = await connectBroker(defaultBrokerSocket(profile), {
          accountId: "account-a",
        });
        try {
          expect(await client.call("status", {})).toEqual({ live: true });
        } finally {
          await client.close();
        }
      } finally {
        await listener.close();
      }
    } finally {
      await removeBrokerUnitMarker(profile);
    }
  });

  it("joins a managed socket whose declared profile and account match", async () => {
    const profile = sandboxProfile();
    ensureProfile(profile);
    const socket = join("/tmp", `ts-broker-match-${randomUUID()}.sock`);
    await writeProfileMarker(profile, socket, null);
    try {
      const listener = await listenBroker(socket, {
        call: async () => ({ live: true }),
        disconnect: async () => undefined,
      });
      try {
        const client = await connectBroker(defaultBrokerSocket(profile));
        try {
          expect(await client.call("status", {})).toEqual({ live: true });
        } finally {
          await client.close();
        }
      } finally {
        await listener.close();
      }
    } finally {
      await removeBrokerUnitMarker(profile);
    }
  });
});

describe("managed-broker connection discovery end-to-end", () => {
  it("a marker with an absent socket never spawns: returns broker_unavailable, creates no lock", async () => {
    const profile = sandboxProfile();
    ensureProfile(profile);
    const declared = join("/tmp", `ts-broker-absent-${randomUUID()}.sock`);
    await writeProfileMarker(profile, declared);
    try {
      await withSystemctlShim(FAILING_SYSTEMCTL, async () => {
        await expect(connectBroker(defaultBrokerSocket(profile))).rejects.toThrow(
          /broker not running/,
        );
      });
      // No spawn: the profile lock file was never created and nothing listens.
      expect(existsSync(profileOperationLockPath(profile))).toBe(false);
      expect(await liveUnixSocket(declared)).toBe(false);
    } finally {
      await removeBrokerUnitMarker(profile);
    }
  }, 15_000);

  it("joins an explicitly owned foreground broker without a marker", async () => {
    const profile = sandboxProfile();
    ensureProfile(profile);
    // resolveBrokerSocket provisions the 0700 socket parent the daemon's own
    // permission check requires, exactly like real callers do.
    const socket = resolveBrokerSocket(profile);
    await expect(brokerConnectionTarget(profile, socket)).resolves.toEqual({ socket });
    // The harness owns the foreground broker and awaits its exit.
    const bin = fileURLToPath(new URL("../../bin.ts", import.meta.url));
    // A short daemon HOME, independent of the harness TMPDIR: the shared MCP
    // socket path is bounded by the Unix socket length limit, and a long
    // TMPDIR-derived HOME would push it over. This does not change the profile
    // under test (TRUSTY_SQUIRE_PROFILE_DIR pins it).
    const daemonHome = await mkdtemp(join("/tmp", "ts-daemon-home-"));
    roots.push(daemonHome);
    const daemonEnv: Record<string, string | undefined> = { ...process.env };
    daemonEnv.HOME = daemonHome;
    daemonEnv.XDG_CONFIG_HOME = join(daemonHome, ".config");
    daemonEnv.TRUSTY_SQUIRE_PROFILE_DIR = profile;
    daemonEnv.TRUSTY_SQUIRE_BROKER_SOCKET = socket;
    const daemon = spawn(process.execPath, ["--import", "tsx", bin, "broker"], {
      env: daemonEnv,
      stdio: "ignore",
    });
    try {
      const client = await connectBroker(socket);
      try {
        expect(await liveUnixSocket(socket)).toBe(true);
        expect(await client.call("status", {})).toBeDefined();
      } finally {
        await client.close();
      }
    } finally {
      const exited = new Promise<void>((resolve) => daemon.once("exit", () => resolve()));
      if (daemon.exitCode === null) daemon.kill("SIGTERM");
      if (daemon.exitCode === null) await exited;
    }
  }, 20_000);
});
