// The shared-broker ceremony exposure must never start a noVNC rig it cannot
// PROVE is ours: the holder's XAUTHORITY has to be a `tsq-login-` private
// rig the broker minted. Any other state — no holder at all, no display
// variables, a foreign Xauthority — skips the exposure silently (the operator
// is assumed to be looking at the screen themselves, or the broker runs
// headless and the user follows the confirm tab another way).

import { symlinkSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { exposeSharedBrokerCeremonyDisplay } from "../google-login.js";
import type * as RemoteLoginDisplayModule from "../remote-login-display.js";

// The degradation rule: an exposure failure must NEVER refuse a connect that
// would otherwise succeed. The noVNC page is how the human is SHOWN the
// login, not a precondition for logging in. This mock makes the attach fail
// deterministically; the test below pins that the helper still resolves null.
const mockState = { rigCreated: 0, attachAttempts: 0 };
vi.mock("../remote-login-display.js", async (importOriginal) => {
  const actual = await importOriginal<typeof RemoteLoginDisplayModule>();
  return {
    ...actual,
    createRemoteLoginRig: () => {
      mockState.rigCreated += 1;
      return {
        width: 720,
        height: 1280,
        procs: [],
        binaries: {
          xvfb: "/unused/xvfb",
          x11vnc: "/unused/x11vnc",
          websockify: "/unused/websockify",
        },
      };
    },
    exposeRemoteLoginDisplay: async () => {
      mockState.attachAttempts += 1;
      throw new Error("vnc attach down");
    },
  };
});

const dirs: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  mockState.rigCreated = 0;
  mockState.attachAttempts = 0;
});

async function tempProfile(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ts-ceremony-exposure-"));
  dirs.push(root);
  const profile = join(root, "profile");
  await mkdir(profile, { recursive: true, mode: 0o700 });
  return profile;
}

// The production reader (`currentProfileHolderPid`) consults the profile's
// SingletonLock SYMLINK ("<host>-<pid>") — not the operation-guard lock file
// — so the fixture's holder is a live child whose pid the symlink names.
// The child's exec-time environment (read via /proc/<pid>/environ) decides
// whether the helper sees a display at all.
async function spawnHolder(env: NodeJS.ProcessEnv): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000);"], {
    env,
    stdio: "ignore",
  });
  children.push(child);
  // Wait until the pid is actually live so the symlink never names a dead
  // process (a dead pid would read as a stale lock, a different branch).
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      process.kill(child.pid!, 0);
      break;
    } catch {
      if (Date.now() > deadline) throw new Error("holder did not become ready");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  return child;
}

async function holderOwnsProfile(profile: string, child: ChildProcess): Promise<void> {
  symlinkSync(`${hostname()}-${child.pid}`, join(profile, "SingletonLock"));
}

describe("exposeSharedBrokerCeremonyDisplay", () => {
  it("skips exposure when no process holds the profile", async () => {
    const profile = await tempProfile();
    await expect(exposeSharedBrokerCeremonyDisplay(profile, "test")).resolves.toBeNull();
  });

  it("skips exposure when the holder's environment has no owned login rig", async () => {
    const profile = await tempProfile();
    // A live holder whose environment carries no DISPLAY/XAUTHORITY at all:
    // there is nothing to expose — and certainly no rig the helper should
    // adopt — so it must return before touching the mocked rig helpers.
    const child = await spawnHolder({ PATH: process.env.PATH ?? "" });
    await holderOwnsProfile(profile, child);
    await expect(exposeSharedBrokerCeremonyDisplay(profile, "test")).resolves.toBeNull();
    // Prove the skip happened BEFORE the mocked rig helpers: no rig was
    // created and no attach was attempted for a non-owned environment.
    expect(mockState.rigCreated).toBe(0);
    expect(mockState.attachAttempts).toBe(0);
  });

  it("degrades to no exposure when the noVNC attach fails — it never refuses the connect", async () => {
    const profile = await tempProfile();
    // The holder's environment names an owned tsq-login- rig, so the helper
    // TRIES to attach — and the mocked attach fails. The ceremony must still
    // get its null (plain-tab banner, connect continues), never a throw.
    const child = await spawnHolder({
      PATH: process.env.PATH ?? "",
      DISPLAY: ":99",
      XAUTHORITY: join(tmpdir(), "tsq-login-ceremonytest", "Xauthority"),
    });
    await holderOwnsProfile(profile, child);
    await expect(exposeSharedBrokerCeremonyDisplay(profile, "test")).resolves.toBeNull();
    // Prove the degradation path was REACHED: the rig was created and the
    // attach was attempted (and threw) — the null came from the degradation,
    // not from an early skip. The test would fail if the helper refused a
    // connect on attach failure.
    expect(mockState.rigCreated).toBe(1);
    expect(mockState.attachAttempts).toBe(1);
  });
});
