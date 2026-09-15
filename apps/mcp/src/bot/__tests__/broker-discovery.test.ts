import { mkdtemp, mkdir, rm, symlink, writeFile, lstat } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import type * as BrokerTransport from "../broker/transport.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock("node:child_process", () => ({ spawn: state.spawn }));

const sleep = async (ms: number) => await new Promise((resolve) => setTimeout(resolve, ms));

describe("broker discovery election", () => {
  let root: string;
  let profile: string;
  let socket: string;
  let listener: { close(): Promise<void> } | undefined;
  let election: { release(): void } | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ts-broker-discovery-"));
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
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  async function modules() {
    const discovery = await import("../broker/discovery.js");
    const profileModule = await import("../profile.js");
    const transport = await import("../broker/transport.js");
    return { discovery, profileModule, transport };
  }

  async function listen(transport: typeof BrokerTransport) {
    listener = await transport.listenBroker(socket, {
      authenticate: async () => ({ accountId: "account", agentId: "agent" }),
      connected: async () => undefined,
      call: async () => ({}),
      disconnect: async () => undefined,
    });
  }

  it("derives one private socket for canonical aliases regardless of TMPDIR", async () => {
    const { discovery } = await modules();
    const alias = join(root, "alias");
    await symlink(profile, alias);
    expect(discovery.defaultBrokerSocket(alias)).toBe(discovery.defaultBrokerSocket(profile));
    const path = discovery.resolveBrokerSocket();
    vi.stubEnv("TMPDIR", join(root, "different-tmp"));
    expect(discovery.resolveBrokerSocket()).toBe(path);
    expect((await lstat(path.slice(0, path.lastIndexOf("/")))).mode & 0o777).toBe(0o700);
    await rm(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  });

  it("reclaims dead election and launch locks before a default-endpoint launch", async () => {
    const { discovery, profileModule, transport } = await modules();
    const roots = [discovery.brokerElectionRoot(profile), discovery.brokerLaunchRoot(profile)];
    for (const lockRoot of roots) {
      await mkdir(lockRoot, { recursive: true, mode: 0o700 });
      const lease = profileModule.acquireProfileOperationGuard(profile, lockRoot);
      const { readdir } = await import("node:fs/promises");
      const lock = (await readdir(lockRoot)).find((name) => name.endsWith(".lock"))!;
      lease.release();
      await writeFile(
        join(lockRoot, lock),
        JSON.stringify({
          host: hostname(),
          pid: 2147483647,
          start_time: "1",
          token: "dead-owner",
        }),
      );
    }
    socket = discovery.resolveBrokerSocket();
    state.spawn.mockImplementation(() => {
      election = profileModule.acquireProfileOperationGuard(profile, roots[0]);
      void sleep(10).then(async () => await listen(transport));
      return { once: vi.fn(), unref: vi.fn() };
    });
    const client = await discovery.connectOrLaunchBroker(socket, "token");
    expect(state.spawn).toHaveBeenCalledOnce();
    await client.close();
    await listener?.close();
    listener = undefined;
    await rm(socket.slice(0, socket.lastIndexOf("/")), { recursive: true });
  });

  it("attaches to an election holder without launching another broker", async () => {
    const { discovery, profileModule, transport } = await modules();
    const electionRoot = discovery.brokerElectionRoot(profile);
    await mkdir(electionRoot, { recursive: true, mode: 0o700 });
    election = profileModule.acquireProfileOperationGuard(profile, electionRoot);
    const connecting = discovery.connectOrLaunchBroker(socket, "token");
    await sleep(10);
    await listen(transport);
    const client = await connecting;

    expect(state.spawn).not.toHaveBeenCalled();
    await client.close();
  });

  it("lets one launch contender establish the owner and reconnects its loser", async () => {
    const { discovery, profileModule, transport } = await modules();
    const electionRoot = discovery.brokerElectionRoot(profile);
    await mkdir(electionRoot, { recursive: true, mode: 0o700 });
    state.spawn.mockImplementation(() => {
      election ??= profileModule.acquireProfileOperationGuard(profile, electionRoot);
      void sleep(10).then(async () => await listen(transport));
      return { once: vi.fn(), unref: vi.fn() };
    });

    const [first, second] = await Promise.all([
      discovery.connectOrLaunchBroker(socket, "token"),
      discovery.connectOrLaunchBroker(socket, "token"),
    ]);

    expect(state.spawn).toHaveBeenCalledTimes(1);
    await Promise.all([first.close(), second.close()]);
  });
});
