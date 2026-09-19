// Regression: the daemon's maintenance window must stay owned for as long as
// the teardown that follows it runs.
//
// `connect` drains the broker, does the plain login, and releases on the lease
// boundary. That release is not instantaneous: the daemon re-reads the enrolled
// session, refreshes the operator credential, resumes the runtime and re-takes
// the profile lease. Freeing the window before that finishes lets a second
// `connect` — the drain retry, or the captain tapping Retry — be answered
// `ready` for a browser the first owner is in the middle of taking back. The two
// then race for the profile: one of them dies on "another Trusty Squire session
// is already using the browser", which is the exact symptom this whole path
// exists to remove.
//
// This drives the REAL daemon over a REAL unix socket. The only substitutions
// are the enrolled-session source (whose disk read is what makes the teardown
// await in production — here it is a gate the test opens deliberately) and the
// owner-process reaper, which spawns a worker unrelated to this contract.
// Nothing launches Chrome: no session is ever opened, so the runtime holds only
// the profile lease.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const session = { account_id: "fixture-account", agent_session_token: "fixture-token" };
  let guards = 0;
  let gate: Promise<void> | undefined;
  let open: (() => void) | undefined;
  return {
    session,
    holdTeardown(): void {
      gate = new Promise<void>((resolve) => {
        open = resolve;
      });
    },
    releaseTeardown(): void {
      const resolve = open;
      gate = undefined;
      open = undefined;
      resolve?.();
    },
    createSessionGuard: () => {
      // The daemon builds the first guard. Every later one belongs to a
      // `withBrokerMaintenance` client and must never be held.
      const daemonGuard = guards++ === 0;
      return {
        bind: async () => {
          if (daemonGuard && gate !== undefined) await gate;
          return session;
        },
        inspect: async () => ({ problem: null }),
      };
    },
  };
});

vi.mock("../../session-guard.js", () => ({
  createSessionGuard: harness.createSessionGuard,
  setServingAccountId: () => undefined,
}));
vi.mock("../owner-process-reaper.js", () => ({
  startOwnerProcessReaper: () => null,
  sweepOrphanedOwnerProcesses: async () => undefined,
}));

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

it("keeps the maintenance window owned until the post-window teardown finishes", async () => {
  const root = await mkdtemp(join(tmpdir(), "ts-maint-window-"));
  dirs.push(root);
  const socket = join(root, "b.sock");
  vi.stubEnv("TRUSTY_SQUIRE_BROKER_SOCKET", socket);
  vi.stubEnv("TRUSTY_SQUIRE_MAINTENANCE_DRAIN_WAIT_MS", "15000");

  const { runBrokerDaemon } = await import("../broker/daemon.js");
  const { withBrokerMaintenance } = await import("../broker/maintenance.js");
  const { BrokerClient } = await import("../broker/transport.js");

  await runBrokerDaemon();

  const first = await BrokerClient.connect(socket, harness.session.agent_session_token, {
    maintain: true,
  });
  expect(first.welcome?.maintenance).toBe("ready");

  harness.holdTeardown();
  const released = first.release();

  let secondRan = false;
  const second = withBrokerMaintenance(async () => {
    secondRan = true;
    return "connected";
  });

  // Long enough for several of the client's 500 ms drain retries to be answered.
  await sleep(1_600);
  expect(secondRan).toBe(false);

  harness.releaseTeardown();
  await released;
  await expect(second).resolves.toBe("connected");
  expect(secondRan).toBe(true);
}, 30_000);
