import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    vi.stubEnv("TRUSTY_SQUIRE_BROKER_SUPERVISED", undefined);
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

  async function listen(transport: typeof import("../broker/transport.js")) {
    listener = await transport.listenBroker(socket, {
      authenticate: async () => ({
        accountId: "account",
        agentId: "agent",
        forwarderId: "lineage",
      }),
      connected: async () => undefined,
      call: async () => ({}),
      disconnect: async () => undefined,
    });
  }

  it("finds a supervised election holder without a frontend supervision flag", async () => {
    const { discovery, profileModule, transport } = await modules();
    const electionRoot = discovery.brokerElectionRoot(profile);
    await mkdir(electionRoot, { recursive: true, mode: 0o700 });
    election = profileModule.acquireProfileOperationGuard(profile, electionRoot);
    const connecting = discovery.connectOrLaunchBroker(socket, "token", "a".repeat(43));
    await sleep(10);
    await listen(transport);
    const client = await connecting;

    expect(state.spawn).not.toHaveBeenCalled();
    await client.close();
  });

  it("upgrades an incumbent owner through an authenticated supervisor attachment", async () => {
    const { transport } = await modules();
    let supervised = false;
    listener = await transport.listenBroker(socket, {
      authenticate: async (_token, _agentId, _lineage, supervisor) =>
        supervisor
          ? { accountId: "account", agentId: "supervisor", supervisor: true as const }
          : { accountId: "account", agentId: "agent", forwarderId: "lineage" },
      connected: async () => undefined,
      call: async (principal, method) => {
        if (method === "supervise") {
          expect(principal.supervisor).toBe(true);
          supervised = true;
        }
        return {};
      },
      disconnect: async () => undefined,
    });

    const supervisor = await transport.BrokerClient.connectSupervisor(socket, "token");
    await supervisor.call("supervise", {});

    expect(supervised).toBe(true);
    await supervisor.close();
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
      discovery.connectOrLaunchBroker(socket, "token", "a".repeat(43)),
      discovery.connectOrLaunchBroker(socket, "token", "b".repeat(43)),
    ]);

    expect(state.spawn).toHaveBeenCalledTimes(1);
    await Promise.all([first.close(), second.close()]);
  });
});
