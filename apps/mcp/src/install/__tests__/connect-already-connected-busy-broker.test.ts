// Regression: an install that is ALREADY connected must not be blocked by a
// busy browser.
//
// The captain's phone showed "Setting up this machine." and then
// "another Trusty Squire session is already using the browser — close it
// first", on a machine that was already installed. The cause was ordering, not
// custody: connect drained the broker and took the exclusive profile guard
// BEFORE it checked whether it needed the browser at all, so the
// already-provisioned preflight — which answers "Already connected" from the
// stored session plus a cookie read, with no login ceremony — never ran.
//
// The broker here is real: a `listenBroker` on the socket connect resolves,
// answering `draining` (live sessions still own the browser) to anyone who
// attempts the maintenance handshake. It counts those attempts. A connect that
// needs no ceremony must make ZERO of them, must never take the profile guard,
// and must never launch a login browser.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type * as GoogleLoginModule from "../../bot/google-login.js";
import type * as ProfileModule from "../../bot/profile.js";

const guardCalls = vi.hoisted(() => ({ count: 0 }));

vi.mock("../../bot/google-login.js", async (importOriginal) => {
  const actual = await importOriginal<typeof GoogleLoginModule>();
  return {
    ...actual,
    detectActiveProviderSessions: vi.fn(async () => ["google"]),
    openInstallConfirmInBotChrome: vi.fn(async () => {
      throw new Error("the login ceremony must not run for an already-connected install");
    }),
  };
});

vi.mock("../../bot/profile.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ProfileModule>();
  return {
    ...actual,
    withProfileOperationGuard: vi.fn(
      async <T>(profileDir: string, operation: () => Promise<T>): Promise<T> => {
        guardCalls.count += 1;
        return await actual.withProfileOperationGuard(profileDir, operation);
      },
    ),
  };
});

import { connect } from "../cli.js";
import { listenBroker } from "../../bot/broker/transport.js";

let tmpHome: string;
let socketRoot: string;
let originalHome: string | undefined;
let originalXdgConfigHome: string | undefined;
let broker: { close: () => Promise<void> } | undefined;

beforeEach(async () => {
  guardCalls.count = 0;
  originalHome = process.env.HOME;
  originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "ts-busy-broker-home-"));
  socketRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ts-busy-broker-sock-"));
  process.env.HOME = tmpHome;
  process.env.XDG_CONFIG_HOME = path.join(tmpHome, ".config");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 200 })),
  );
  await fs.mkdir(path.join(process.env.XDG_CONFIG_HOME, "trusty-squire"), { recursive: true });
  await fs.writeFile(
    path.join(process.env.XDG_CONFIG_HOME, "trusty-squire", "session.json"),
    JSON.stringify({
      api_base_url: "https://api.example.test",
      saved_at: "2026-09-04T00:00:00.000Z",
      machine_token: "machine-token",
      agent_session_token: "agent-token",
      account_id: "account-id",
    }),
  );
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await broker?.close();
  broker = undefined;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  await fs.rm(tmpHome, { recursive: true, force: true });
  await fs.rm(socketRoot, { recursive: true, force: true });
});

it("reports already connected without touching a broker whose browser is busy", async () => {
  const socket = path.join(socketRoot, "b.sock");
  let maintainAttempts = 0;
  broker = await listenBroker(socket, {
    authenticate: async () => ({ accountId: "account-id", agentId: "connect" }),
    connected: async (_principal, params) => {
      if (params.maintain === true) maintainAttempts += 1;
      // A live session still owns the shared browser.
      return params.maintain === true ? { maintenance: "draining" } : undefined;
    },
    call: async () => ({ closed: true }),
    disconnect: async () => undefined,
  });
  vi.stubEnv("TRUSTY_SQUIRE_BROKER_SOCKET", socket);

  const output: string[] = [];
  const warn = vi.spyOn(console, "warn").mockImplementation((message?: unknown) => {
    output.push(String(message));
  });
  try {
    await connect({
      command: "connect",
      target: "cursor",
      apiBase: "https://api.example.test",
      skipBrowser: false,
      forceRelogin: false,
      noRegistry: false,
      noInteractive: true,
    });
  } finally {
    warn.mockRestore();
  }

  expect(output.join("\n")).toContain("Already connected");
  expect(output.join("\n")).not.toContain("already using the browser");
  // The broker was never asked to give up its browser...
  expect(maintainAttempts).toBe(0);
  // ...and the exclusive profile guard was never taken.
  expect(guardCalls.count).toBe(0);
});
