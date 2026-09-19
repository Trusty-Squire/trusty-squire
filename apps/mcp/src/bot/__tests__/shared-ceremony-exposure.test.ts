// The shared-broker ceremony exposure must never start a noVNC rig it cannot
// PROVE is ours: the holder's XAUTHORITY has to be a `tsq-login-` private
// rig the broker minted. The result names WHY there is no exposure, because
// the states are not equivalent (round-12 review-3): "unshowable" means the
// ceremony tab provably cannot be shown to anyone and the connect fails
// immediately with the cause and the recovery; "already_visible" means the
// tab sits on a display this repository did not create (the machine's own
// screen), which the user may be looking at right now.

import { symlinkSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { exposeSharedBrokerCeremonyDisplay } from "../google-login.js";
import type * as RemoteLoginDisplayModule from "../remote-login-display.js";

const mockState = {
  rigCreated: 0,
  attachAttempts: 0,
  rigSetupFails: false,
};
vi.mock("../remote-login-display.js", async (importOriginal) => {
  const actual = await importOriginal<typeof RemoteLoginDisplayModule>();
  return {
    ...actual,
    createRemoteLoginRig: () => {
      mockState.rigCreated += 1;
      if (mockState.rigSetupFails) throw new Error("no x11vnc on PATH");
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
  mockState.rigSetupFails = false;
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
  it("reports unshowable when no process holds the profile", async () => {
    const profile = await tempProfile();
    await expect(exposeSharedBrokerCeremonyDisplay(profile, "test")).resolves.toEqual({
      kind: "unshowable",
      reason: expect.stringMatching(/could not be discovered/),
    });
  });

  it("reports unshowable when the holder's environment has no display at all", async () => {
    const profile = await tempProfile();
    // A live holder whose environment carries no DISPLAY/XAUTHORITY at all:
    // the tab provably cannot be shown to anyone — and certainly no rig the
    // helper should adopt — so it must return before touching the mocked rig
    // helpers.
    const child = await spawnHolder({ PATH: process.env.PATH ?? "" });
    await holderOwnsProfile(profile, child);
    await expect(exposeSharedBrokerCeremonyDisplay(profile, "test")).resolves.toEqual({
      kind: "unshowable",
      reason: expect.stringMatching(/without a DISPLAY\/XAUTHORITY/),
    });
    // Prove the skip happened BEFORE the mocked rig helpers: no rig was
    // created and no attach was attempted for a non-owned environment.
    expect(mockState.rigCreated).toBe(0);
    expect(mockState.attachAttempts).toBe(0);
  });

  it("reports already_visible when the holder runs on a display this repository did not create", async () => {
    const profile = await tempProfile();
    // A foreign XAUTHORITY belongs to the machine's own screen, which the
    // user may already be looking at — that is NOT an unshowable tab, and no
    // noVNC rig may be started for a display we do not own.
    const child = await spawnHolder({
      PATH: process.env.PATH ?? "",
      DISPLAY: ":0",
      XAUTHORITY: "/home/someone/.Xauthority",
    });
    await holderOwnsProfile(profile, child);
    await expect(exposeSharedBrokerCeremonyDisplay(profile, "test")).resolves.toEqual({
      kind: "already_visible",
      reason: expect.stringMatching(/display this repository did not create/),
    });
    expect(mockState.rigCreated).toBe(0);
    expect(mockState.attachAttempts).toBe(0);
  });

  it("reports unshowable — with the concrete cause — when preparing the noVNC rig fails", async () => {
    const profile = await tempProfile();
    const child = await spawnHolder({
      PATH: process.env.PATH ?? "",
      DISPLAY: ":99",
      XAUTHORITY: join(tmpdir(), "tsq-login-ceremonytest", "Xauthority"),
    });
    await holderOwnsProfile(profile, child);
    mockState.rigSetupFails = true;
    await expect(exposeSharedBrokerCeremonyDisplay(profile, "test")).resolves.toEqual({
      kind: "unshowable",
      reason: expect.stringMatching(/no x11vnc on PATH/),
    });
  });

  it("reports unshowable — with the concrete cause — when the noVNC attach fails", async () => {
    const profile = await tempProfile();
    // The holder's environment names an owned tsq-login- rig, so the helper
    // TRIES to attach — and the mocked attach fails. The tab provably cannot
    // be shown: the result carries the cause so the ceremony can stop
    // immediately instead of silently polling to its deadline.
    const child = await spawnHolder({
      PATH: process.env.PATH ?? "",
      DISPLAY: ":99",
      XAUTHORITY: join(tmpdir(), "tsq-login-ceremonytest", "Xauthority"),
    });
    await holderOwnsProfile(profile, child);
    await expect(exposeSharedBrokerCeremonyDisplay(profile, "test")).resolves.toEqual({
      kind: "unshowable",
      reason: expect.stringMatching(/noVNC attach failed.*vnc attach down/),
    });
    // Prove the attach path was REACHED: the rig was created and the attach
    // was attempted (and threw).
    expect(mockState.rigCreated).toBe(1);
    expect(mockState.attachAttempts).toBe(1);
  });
});
