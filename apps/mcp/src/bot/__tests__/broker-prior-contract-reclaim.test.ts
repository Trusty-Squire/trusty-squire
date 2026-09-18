import type * as ChildProcess from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as BrokerTransport from "../broker/transport.js";
import type * as DiscoveryModule from "../broker/discovery.js";
import type * as ProfileModule from "../profile.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The real spawn, for fixtures: the module graph's spawn is mocked below
 * (discovery's daemon launch is the unit under test). */
const realSpawn = (await (vi.importActual("node:child_process") as Promise<typeof ChildProcess>))
  .spawn;

// Discovery's daemon spawn is the seam: each test's "new-contract daemon"
// takes the election lease and binds a real Contract B listener.
const state = vi.hoisted(() => ({ spawn: vi.fn(), maintenanceToken: "test" }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return { ...actual, spawn: state.spawn };
});
vi.mock("../../session-guard.js", () => ({
  createSessionGuard: () => ({
    bind: async () => ({ agent_session_token: state.maintenanceToken }),
  }),
}));

const sleep = async (ms: number) => await new Promise((resolve) => setTimeout(resolve, ms));

/** A real prior-contract broker fixture: a separate process that
 *
 * - holds the profile election lease in the exact on-disk format the lease
 *   machinery reads (the lock file's content is the owner record with host,
 *   pid, and birth-identity start_time), and
 * - unless `no-listen`, listens on the socket speaking the pre-Contract-B
 *   wire: it refuses every pre-auth method that is not `hello` and
 *   authenticates `hello` with the token — a Contract B broker refuses
 *   `hello` instead. It dies on default SIGTERM exactly like the
 *   pre-wire-collapse daemon, unless told to ignore it. */
const PRIOR_CONTRACT_DAEMON_SCRIPT = `
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const [marker, socketPath, lockPath, token, mode] = process.argv.slice(1);
if (marker !== "broker") process.exit(78);
let startTime;
if (process.platform === "linux") {
  const stat = fs.readFileSync("/proc/self/stat", "utf8");
  startTime = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
} else if (process.platform === "darwin") {
  startTime = require("node:child_process")
    .execFileSync("/bin/ps", ["-p", String(process.pid), "-o", "lstart="], { encoding: "utf8" })
    .trim();
} else {
  startTime = "unknown";
}
fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
fs.writeFileSync(
  lockPath,
  JSON.stringify({ host: os.hostname(), pid: process.pid, start_time: startTime, token: "lease" }),
  { mode: 0o600 },
);
if (mode.includes("ignore-sigterm")) process.on("SIGTERM", () => undefined);
if (!mode.includes("no-listen")) {
  const server = net.createServer((socket) => {
    let buffered = "";
    socket.on("data", (chunk) => {
      buffered += chunk.toString("utf8");
      for (;;) {
        const end = buffered.indexOf("\\n");
        if (end < 0) break;
        const frame = buffered.slice(0, end);
        buffered = buffered.slice(end + 1);
        let request;
        try {
          request = JSON.parse(frame);
        } catch {
          socket.destroy();
          return;
        }
        const reply = (payload) =>
          socket.write(JSON.stringify({ id: request.id, ...payload }) + "\\n");
        const authedMethod = mode.includes("contract-b") ? "connect" : "hello";
        if (request.method !== authedMethod || typeof request.params?.token !== "string") {
          reply({
            error: { code: "unauthorized", message: "Authenticate before issuing commands" },
          });
          continue;
        }
        if (request.params.token !== token) {
          reply({ error: { code: "unauthorized", message: "Invalid broker credential" } });
          continue;
        }
        reply({
          result: {
            version: 1,
            clientId: mode.includes("contract-b") ? "stale-contract-fixture" : "prior-contract-fixture",
          },
        });
      }
    });
  });
  server.listen(socketPath);
} else {
  setInterval(() => undefined, 1000);
}
`;

type Lease = { release(): void };

/** The profile election lease machinery's lock file is a file whose content
 * is the owner record; read it back verbatim. */
async function leaseOwnerPid(lockPath: string): Promise<number> {
  const raw = await readFile(lockPath, "utf8");
  return (JSON.parse(raw) as { pid: number }).pid;
}

async function awaitExit(child: ChildProcess.ChildProcess): Promise<string | null> {
  return await new Promise((resolve) => {
    if (child.signalCode !== null) {
      resolve(child.signalCode);
      return;
    }
    child.once("exit", (_code, signal) => resolve(signal));
  });
}

/** Election lock path for a profile, derived through the real lease
 * machinery so fixtures write exactly where the production code reads. Only
 * valid while the lease is free. */
async function electionLockPath(
  discovery: typeof DiscoveryModule,
  profileModule: typeof ProfileModule,
  profile: string,
): Promise<string> {
  const electionRoot = discovery.brokerElectionRoot(profile);
  await mkdir(electionRoot, { recursive: true, mode: 0o700 });
  const probe = profileModule.acquireProfileOperationGuard(profile, electionRoot);
  const name = (await readdir(electionRoot)).find((n) => n.endsWith(".lock"))!;
  probe.release();
  await rm(join(electionRoot, name), { force: true });
  return join(electionRoot, name);
}

async function modules() {
  const discovery = await import("../broker/discovery.js");
  const profileModule = await import("../profile.js");
  const transport = await import("../broker/transport.js");
  return { discovery, profileModule, transport };
}

/** Wait until the fixture holds its lease and — when listening — answers
 * the socket. Prior-contract fixtures refuse Contract B `connect` (hello
 * only). Current-contract fixtures authenticate `connect` with the token. */
async function awaitFixtureReady(
  socketPath: string,
  leasePath: string,
  token: string,
  options: { listens?: boolean; contract?: "legacy" | "current" } = {},
): Promise<void> {
  const { BrokerClient } = await import("../broker/transport.js");
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (existsSync(leasePath)) {
      let ready = !options.listens;
      if (options.listens) {
        try {
          await BrokerClient.connect(socketPath, token).then(
            async (client) => {
              if (options.contract === "current") {
                ready = true;
                await client.close();
                return;
              }
              await client.close();
              throw new Error("legacy fixture authenticated Contract B connect");
            },
            (error) => {
              if (!(error instanceof Error)) throw error;
              if (options.contract === "current") {
                if (!error.message.includes("Invalid broker credential")) throw error;
                ready = true;
                return undefined;
              }
              if (!error.message.includes("Authenticate before issuing commands")) throw error;
              ready = true;
              return undefined;
            },
          );
        } catch {
          // Not ready yet.
        }
      }
      if (ready) return;
    }
    if (Date.now() > deadline) throw new Error("broker reclaim fixture never became ready");
    await sleep(25);
  }
}

describe("prior-contract broker reclaim on upgrade", () => {
  let root: string;
  let profile: string;
  let socket: string;
  let lockPath: string;
  let listener: { close(): Promise<void> } | undefined;
  let election: Lease | undefined;
  const children: ChildProcess.ChildProcess[] = [];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ts-broker-reclaim-"));
    profile = join(root, "profile");
    socket = join(root, "broker.sock");
    listener = undefined;
    election = undefined;
    await mkdir(profile);
    vi.stubEnv("TRUSTY_SQUIRE_PROFILE_DIR", profile);
    vi.stubEnv("TRUSTY_SQUIRE_BROKER_SOCKET", undefined);
    vi.resetModules();
    state.spawn.mockReset();
    state.spawn.mockReturnValue({ once: vi.fn(), unref: vi.fn() });
  });

  afterEach(async () => {
    await listener?.close();
    election?.release();
    for (const child of children) child.kill("SIGKILL");
    await Promise.allSettled(children.map((child) => awaitExit(child)));
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  async function modules() {
    const discovery = await import("../broker/discovery.js");
    const profileModule = await import("../profile.js");
    const transport = await import("../broker/transport.js");
    return { discovery, profileModule, transport };
  }

  function spawnFixture(
    socketPath: string,
    leasePath: string,
    token: string,
    mode: string,
  ): ChildProcess.ChildProcess {
    const child = realSpawn(
      process.execPath,
      ["-e", PRIOR_CONTRACT_DAEMON_SCRIPT, "broker", socketPath, leasePath, token, mode],
      { stdio: "ignore" },
    );
    children.push(child);
    return child;
  }

  /** Spawn-mock stand-in for the new-contract daemon: takes the election
   * lease and binds a real Contract B listener on the socket. */
  function mockNewContractDaemon(
    transport: typeof BrokerTransport,
    profileModule: typeof ProfileModule,
    electionRoot: string,
  ): void {
    state.spawn.mockImplementation(() => {
      election ??= profileModule.acquireProfileOperationGuard(profile, electionRoot);
      void sleep(10).then(async () => {
        listener = await transport.listenBroker(socket, {
          authenticate: async () => ({ accountId: "account", agentId: "agent" }),
          connected: async () => undefined,
          call: async () => ({}),
          disconnect: async () => undefined,
        });
      });
      return { once: vi.fn(), unref: vi.fn() };
    });
  }

  it(
    "terminates a resident prior-contract broker for the same profile and attaches to a new-contract daemon",
    { timeout: 30_000 },
    async () => {
      const { discovery, profileModule, transport } = await modules();
      lockPath = await electionLockPath(discovery, profileModule, profile);
      const fixture = spawnFixture(socket, lockPath, "token", "");
      await awaitFixtureReady(socket, lockPath, "token", { listens: true });
      expect(await leaseOwnerPid(lockPath)).toBe(fixture.pid!);

      mockNewContractDaemon(transport, profileModule, discovery.brokerElectionRoot(profile));

      const client = await discovery.connectOrLaunchBroker(socket, "token");

      // Real termination of the real prior-contract daemon, and a real
      // attach to the new-contract daemon.
      expect(await awaitExit(fixture)).toBe("SIGTERM");
      expect(state.spawn).toHaveBeenCalledOnce();
      expect(client.welcome).toBeDefined();
      expect(await leaseOwnerPid(lockPath)).toBe(process.pid);
      await client.close();
    },
  );

  it(
    "escalates to SIGKILL when the prior-contract broker ignores SIGTERM, then attaches",
    { timeout: 30_000 },
    async () => {
      const { discovery, profileModule, transport } = await modules();
      lockPath = await electionLockPath(discovery, profileModule, profile);
      const fixture = spawnFixture(socket, lockPath, "token", "ignore-sigterm");
      await awaitFixtureReady(socket, lockPath, "token", { listens: true });

      mockNewContractDaemon(transport, profileModule, discovery.brokerElectionRoot(profile));

      const client = await discovery.connectOrLaunchBroker(socket, "token");

      expect(await awaitExit(fixture)).toBe("SIGKILL");
      expect(state.spawn).toHaveBeenCalledOnce();
      expect(client.welcome).toBeDefined();
      await client.close();
    },
  );

  it(
    "fails with a legible refusal naming the resident older-contract broker when reclaim cannot complete",
    { timeout: 30_000 },
    async () => {
      const { discovery, profileModule } = await modules();
      lockPath = await electionLockPath(discovery, profileModule, profile);
      // The legacy-wire listener lives on the socket (it is what the
      // client's connect refusal and the hello probe see), while a separate
      // holder process owns the profile election lease and ignores SIGTERM.
      // Even after the holder is killed the endpoint never clears, so
      // reclaim genuinely cannot finish.
      const scratchSocket = join(root, "scratch.sock");
      const scratchLockPath = join(root, "scratch.lock");
      spawnFixture(socket, scratchLockPath, "token", "");
      const holder = spawnFixture(scratchSocket, lockPath, "token", "no-listen ignore-sigterm");
      await awaitFixtureReady(socket, scratchLockPath, "token", { listens: true });
      await awaitFixtureReady(scratchSocket, lockPath, "token");
      const holderPid = holder.pid!;

      const { BrokerClient } = await import("../broker/transport.js");
      const connectError = await BrokerClient.connect(socket, "token").then(
        (client) => client.close().then(() => undefined),
        (error) => error,
      );
      const reclaiming = discovery.reclaimPriorContractBrokerIfPresent(
        socket,
        "token",
        connectError,
        { termGraceMs: 1_000, killGraceMs: 1_000, pollMs: 25 },
      );

      await expect(reclaiming).rejects.toThrow(/older release/);
      await expect(reclaiming).rejects.toMatchObject({ code: "broker_unavailable" });
      expect(String(await reclaiming.catch((error) => error.message))).toContain(String(holderPid));
      expect(await awaitExit(holder)).toBe("SIGKILL");
    },
  );

  it(
    "reuses a live same-contract daemon and never signals its lease holder",
    { timeout: 30_000 },
    async () => {
      const { discovery, profileModule, transport } = await modules();
      const electionRoot = discovery.brokerElectionRoot(profile);
      await mkdir(electionRoot, { recursive: true, mode: 0o700 });
      election = profileModule.acquireProfileOperationGuard(profile, electionRoot);
      const holderLockPath = join(
        electionRoot,
        (await readdir(electionRoot)).find((n) => n.endsWith(".lock"))!,
      );
      listener = await transport.listenBroker(socket, {
        authenticate: async () => ({ accountId: "account", agentId: "agent" }),
        connected: async () => undefined,
        call: async () => ({}),
        disconnect: async () => undefined,
      });

      const client = await discovery.connectOrLaunchBroker(socket, "token");

      expect(state.spawn).not.toHaveBeenCalled();
      expect(client.welcome).toBeDefined();
      // The lease holder (this test process, standing in for the daemon) is
      // untouched: the recorded owner pid is still ours and we are alive.
      const owner = JSON.parse(await readFile(holderLockPath, "utf8")) as { pid: number };
      expect(owner.pid).toBe(process.pid);
      // The same-contract daemon still answers a second client.
      const second = await discovery.connectOrLaunchBroker(socket, "token");
      expect(second.welcome).toBeDefined();
      await Promise.all([client.close(), second.close()]);
    },
  );

  it(
    "waits out a just-started same-contract daemon instead of reclaiming the lease holder",
    { timeout: 30_000 },
    async () => {
      const { discovery, profileModule, transport } = await modules();
      const electionRoot = discovery.brokerElectionRoot(profile);
      await mkdir(electionRoot, { recursive: true, mode: 0o700 });
      election = profileModule.acquireProfileOperationGuard(profile, electionRoot);
      const holderLockPath = join(
        electionRoot,
        (await readdir(electionRoot)).find((n) => n.endsWith(".lock"))!,
      );
      // No socket yet: the daemon holds the lease before its socket appears.
      const connecting = discovery.connectOrLaunchBroker(socket, "token");
      await sleep(50);
      listener = await transport.listenBroker(socket, {
        authenticate: async () => ({ accountId: "account", agentId: "agent" }),
        connected: async () => undefined,
        call: async () => ({}),
        disconnect: async () => undefined,
      });
      const client = await connecting;

      expect(state.spawn).not.toHaveBeenCalled();
      expect(client.welcome).toBeDefined();
      const owner = JSON.parse(await readFile(holderLockPath, "utf8")) as { pid: number };
      expect(owner.pid).toBe(process.pid);
      await client.close();
    },
  );

  it(
    "does not reclaim a credential-rejecting listener that is not this profile's elected broker",
    { timeout: 30_000 },
    async () => {
      const { discovery, transport } = await modules();
      listener = await transport.listenBroker(socket, {
        authenticate: async () => null,
        connected: async () => undefined,
        call: async () => ({}),
        disconnect: async () => undefined,
      });

      await expect(discovery.connectOrLaunchBroker(socket, "stale-token")).rejects.toThrow(
        "Invalid broker credential",
      );
      expect(state.spawn).not.toHaveBeenCalled();
    },
  );
});

describe("same-contract stale-credential broker reclaim", () => {
  let root: string;
  let profile: string;
  let socket: string;
  let lockPath: string;
  let listener: { close(): Promise<void> } | undefined;
  let election: Lease | undefined;
  const children: ChildProcess.ChildProcess[] = [];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ts-broker-stale-"));
    profile = join(root, "profile");
    socket = join(root, "broker.sock");
    listener = undefined;
    election = undefined;
    await mkdir(profile);
    vi.stubEnv("TRUSTY_SQUIRE_PROFILE_DIR", profile);
    vi.stubEnv("TRUSTY_SQUIRE_BROKER_SOCKET", undefined);
    vi.resetModules();
    state.spawn.mockReset();
    state.spawn.mockReturnValue({ once: vi.fn(), unref: vi.fn() });
  });

  afterEach(async () => {
    await listener?.close();
    election?.release();
    for (const child of children) child.kill("SIGKILL");
    await Promise.allSettled(children.map((child) => awaitExit(child)));
    children.length = 0;
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  async function modules() {
    const discovery = await import("../broker/discovery.js");
    const profileModule = await import("../profile.js");
    const transport = await import("../broker/transport.js");
    return { discovery, profileModule, transport };
  }

  function spawnFixture(
    socketPath: string,
    leasePath: string,
    token: string,
    mode: string,
  ): ChildProcess.ChildProcess {
    const child = realSpawn(
      process.execPath,
      ["-e", PRIOR_CONTRACT_DAEMON_SCRIPT, "broker", socketPath, leasePath, token, mode],
      { stdio: "ignore" },
    );
    children.push(child);
    return child;
  }

  function mockNewContractDaemon(
    transport: typeof BrokerTransport,
    profileModule: typeof ProfileModule,
    electionRoot: string,
  ): void {
    state.spawn.mockImplementation(() => {
      election ??= profileModule.acquireProfileOperationGuard(profile, electionRoot);
      void sleep(10).then(async () => {
        listener = await transport.listenBroker(socket, {
          authenticate: async () => ({ accountId: "account", agentId: "agent" }),
          connected: async () => undefined,
          call: async () => ({}),
          disconnect: async () => undefined,
        });
      });
      return { once: vi.fn(), unref: vi.fn() };
    });
  }

  it(
    "reproduces the orphaning path: a resident same-contract broker whose digest lagged a re-enrollment is reclaimed and replaced",
    { timeout: 30_000 },
    async () => {
      // Orphaning path: the resident was started with old-token (connect,
      // a driver restart, or a maintenance release that skipped refresh).
      // The enrolled session now carries new-token. Contract B answers
      // connect and rejects the digest; nothing used to reclaim that.
      const { discovery, profileModule, transport } = await modules();
      lockPath = await electionLockPath(discovery, profileModule, profile);
      const fixture = spawnFixture(socket, lockPath, "old-token", "contract-b");
      await awaitFixtureReady(socket, lockPath, "old-token", {
        listens: true,
        contract: "current",
      });
      expect(await leaseOwnerPid(lockPath)).toBe(fixture.pid!);

      mockNewContractDaemon(transport, profileModule, discovery.brokerElectionRoot(profile));

      const client = await discovery.connectOrLaunchBroker(socket, "new-token");

      expect(await awaitExit(fixture)).toBe("SIGTERM");
      expect(state.spawn).toHaveBeenCalledOnce();
      expect(client.welcome).toBeDefined();
      await client.close();
    },
  );

  it(
    "does not kill a stale-credential broker that still has an attached client, and names the pid plus the TERM reclaim step",
    { timeout: 30_000 },
    async () => {
      const { discovery, profileModule, transport } = await modules();
      lockPath = await electionLockPath(discovery, profileModule, profile);
      const fixture = spawnFixture(socket, lockPath, "old-token", "contract-b");
      await awaitFixtureReady(socket, lockPath, "old-token", {
        listens: true,
        contract: "current",
      });
      const holderPid = fixture.pid!;
      const attached = await transport.BrokerClient.connect(socket, "old-token");
      try {
        await expect(discovery.connectOrLaunchBroker(socket, "new-token")).rejects.toMatchObject({
          code: "broker_unavailable",
        });
        const message = String(
          await discovery
            .connectOrLaunchBroker(socket, "new-token")
            .catch((error: unknown) => (error instanceof Error ? error.message : error)),
        );
        expect(message).toContain(String(holderPid));
        expect(message).toMatch(/TERM/);
        expect(message).toMatch(/attached client/);
        expect(state.spawn).not.toHaveBeenCalled();
        expect(fixture.exitCode).toBeNull();
        expect(fixture.signalCode).toBeNull();
      } finally {
        await attached.close();
      }
    },
  );

  it(
    "escalates to SIGKILL when an empty stale-credential broker ignores SIGTERM, then attaches",
    { timeout: 30_000 },
    async () => {
      const { discovery, profileModule, transport } = await modules();
      lockPath = await electionLockPath(discovery, profileModule, profile);
      const fixture = spawnFixture(socket, lockPath, "old-token", "contract-b ignore-sigterm");
      await awaitFixtureReady(socket, lockPath, "old-token", {
        listens: true,
        contract: "current",
      });

      mockNewContractDaemon(transport, profileModule, discovery.brokerElectionRoot(profile));

      const client = await discovery.connectOrLaunchBroker(socket, "new-token");

      expect(await awaitExit(fixture)).toBe("SIGKILL");
      expect(state.spawn).toHaveBeenCalledOnce();
      expect(client.welcome).toBeDefined();
      await client.close();
    },
  );
});

describe("broker reclaim through plain-login maintenance", () => {
  let root: string;
  let profile: string;
  let socket: string;
  let fixture: ChildProcess.ChildProcess | undefined;
  let fixtureExit: Promise<string | null> | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ts-maint-reclaim-"));
    profile = join(root, "profile");
    socket = join(root, "broker.sock");
    fixture = undefined;
    fixtureExit = undefined;
    await mkdir(profile);
    vi.stubEnv("TRUSTY_SQUIRE_PROFILE_DIR", profile);
    vi.stubEnv("TRUSTY_SQUIRE_BROKER_SOCKET", socket);
    vi.resetModules();
  });

  afterEach(async () => {
    fixture?.kill("SIGKILL");
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it(
    "drains a resident prior-contract broker instead of racing it for the profile, then logs in plain",
    { timeout: 30_000 },
    async () => {
      state.maintenanceToken = "test";
      const { discovery, profileModule, transport } = await modules();
      const lockPath = await electionLockPath(discovery, profileModule, profile);

      fixture = realSpawn(
        process.execPath,
        ["-e", PRIOR_CONTRACT_DAEMON_SCRIPT, "broker", socket, lockPath, "test", ""],
        { stdio: "ignore" },
      );
      fixtureExit = awaitExit(fixture);
      await awaitFixtureReady(socket, lockPath, "test", { listens: true });
      expect(await leaseOwnerPid(lockPath)).toBe(fixture.pid!);

      // The transport import above registered the real module before the
      // session-guard mock; a fresh import graph is not needed because the
      // maintenance module resolves session-guard at its own import.
      void transport;
      const { withBrokerMaintenance } = await import("../broker/maintenance.js");
      await expect(withBrokerMaintenance(async () => "plain-login")).resolves.toBe("plain-login");
      // The prior-contract daemon is gone: the plain login drained it rather
      // than racing it for the profile.
      expect(await fixtureExit).toBe("SIGTERM");
    },
  );

  it(
    "drains a resident same-contract broker whose credential no longer matches, then logs in plain",
    { timeout: 30_000 },
    async () => {
      state.maintenanceToken = "new-token";
      const { discovery, profileModule, transport } = await modules();
      const lockPath = await electionLockPath(discovery, profileModule, profile);

      fixture = realSpawn(
        process.execPath,
        ["-e", PRIOR_CONTRACT_DAEMON_SCRIPT, "broker", socket, lockPath, "old-token", "contract-b"],
        { stdio: "ignore" },
      );
      fixtureExit = awaitExit(fixture);
      await awaitFixtureReady(socket, lockPath, "old-token", {
        listens: true,
        contract: "current",
      });
      expect(await leaseOwnerPid(lockPath)).toBe(fixture.pid!);

      void transport;
      const { withBrokerMaintenance } = await import("../broker/maintenance.js");
      await expect(withBrokerMaintenance(async () => "plain-login")).resolves.toBe("plain-login");
      expect(await fixtureExit).toBe("SIGTERM");
    },
  );
});
