// The shared-broker ceremony exposure must never start a noVNC rig it cannot
// PROVE is ours: the holder's XAUTHORITY has to be a `tsq-login-` private
// rig the broker minted. The result names WHY there is no exposure, because
// the states are not equivalent (round-12 review-3): "unshowable" means the
// ceremony tab provably cannot be shown to anyone and the connect fails
// immediately with the cause and the recovery; "already_visible" means the
// tab sits on a display this repository did not create (the machine's own
// screen), which the user may be looking at right now.

import { existsSync, symlinkSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { exposeSharedBrokerCeremonyDisplay } from "../google-login.js";
import { registerLocalBrowserLaunch } from "../browser-process-runtime.js";
import {
  bindOwnerBrowserLaunch,
  spawnOwnerTrackedHelper,
  stopOwnerProcessReaper,
  untrackOwnerBrowserLaunch,
} from "../owner-process-reaper.js";
import { profileProcessIdentity } from "../profile.js";
import type * as RemoteLoginDisplayModule from "../remote-login-display.js";

const mockState = {
  rigCreated: 0,
  attachAttempts: 0,
  rigSetupFails: false,
  attachSucceeds: false,
  secretSetupFails: false,
  privateDirs: [] as string[],
  helpers: [] as ChildProcess[],
  rigs: [] as RemoteLoginDisplayModule.RemoteLoginRig[],
};
vi.mock("../remote-login-display.js", async (importOriginal) => {
  const actual = await importOriginal<typeof RemoteLoginDisplayModule>();
  return {
    ...actual,
    createRemoteLoginRig: () => {
      mockState.rigCreated += 1;
      if (mockState.rigSetupFails) throw new Error("no x11vnc on PATH");
      const rig = {
        width: 720,
        height: 1280,
        procs: [],
        binaries: {
          xvfb: "/unused/xvfb",
          x11vnc: "/unused/x11vnc",
          websockify: "/unused/websockify",
        },
      };
      mockState.rigs.push(rig);
      return rig;
    },
    createRemoteLoginVncSecrets: (rig: RemoteLoginDisplayModule.RemoteLoginRig) => {
      actual.createRemoteLoginVncSecrets(rig);
      mockState.privateDirs.push(rig.privateDir!);
      if (mockState.secretSetupFails) {
        // A helper already belongs to the partially prepared rig. Failure
        // must reap it as well as remove secrets, without touching the holder.
        const helper = spawnOwnerTrackedHelper(
          process.execPath,
          ["-e", "setInterval(() => {}, 1000)"],
          { stdio: "ignore" },
        );
        rig.procs.push(helper);
        mockState.helpers.push(helper);
        throw new Error("secret setup failed");
      }
    },
    exposeRemoteLoginDisplay: async () => {
      mockState.attachAttempts += 1;
      if (!mockState.attachSucceeds) throw new Error("vnc attach down");
      return "https://fixture.invalid";
    },
  };
});

const dirs: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of mockState.helpers.splice(0)) child.kill("SIGKILL");
  stopOwnerProcessReaper();
  vi.unstubAllEnvs();
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  mockState.rigCreated = 0;
  mockState.attachAttempts = 0;
  mockState.rigSetupFails = false;
  mockState.attachSucceeds = false;
  mockState.secretSetupFails = false;
  mockState.privateDirs = [];
  for (const rig of mockState.rigs.splice(0)) {
    if (rig.privateDir) await rm(rig.privateDir, { recursive: true, force: true });
  }
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
async function spawnHolder(env: NodeJS.ProcessEnv, profile?: string): Promise<ChildProcess> {
  const args = ["-e", "setInterval(() => undefined, 1000);"];
  if (profile !== undefined) args.push("--", `--user-data-dir=${profile}`);
  const child = spawn(process.execPath, args, {
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

const headless = { hasDisplay: () => false };
const screened = { hasDisplay: () => true };

describe("exposeSharedBrokerCeremonyDisplay", () => {
  it("prefers the tracked rig for the holder profile over the process environment", async () => {
    const profile = await tempProfile();
    vi.stubEnv("TRUSTY_SQUIRE_REAPER_DIR", join(profile, "reaper"));
    const authFile = join(tmpdir(), "tsq-login-tracked", "xauthority");
    const launch = registerLocalBrowserLaunch(profile, { DISPLAY: ":72", XAUTHORITY: authFile });
    const child = await spawnHolder({ DISPLAY: ":0", XAUTHORITY: "/foreign/xauthority" }, profile);
    await holderOwnsProfile(profile, child);
    expect(
      bindOwnerBrowserLaunch(launch.marker, profileProcessIdentity(child.pid!, profile)!),
    ).toBe(true);
    mockState.attachSucceeds = true;
    try {
      const exposure = await exposeSharedBrokerCeremonyDisplay(profile, "test", headless);
      expect(exposure.kind).toBe("exposed");
      expect(mockState.rigs[0]).toMatchObject({ display: ":72", authFile });
      if (exposure.kind === "exposed") await exposure.stop();
      expect(mockState.privateDirs.every((path) => !existsSync(path))).toBe(true);
      untrackOwnerBrowserLaunch(launch.marker);
      await expect(
        exposeSharedBrokerCeremonyDisplay(profile, "test", headless),
      ).resolves.toMatchObject({
        kind: "already_visible",
      });
    } finally {
      untrackOwnerBrowserLaunch(launch.marker);
    }
  });

  // The broker daemon and connect are different processes and may run under
  // different TMPDIRs — broker discovery supports exactly that. A rig this
  // repo RECORDED for the holder launch is ours wherever the daemon's temp
  // root put it; rejecting it because its parent is not the CLIENT's temp
  // root exposed no noVNC URL and stranded a headless user until the
  // deadline, on a display we created ourselves.
  it("exposes the tracked rig when the broker's temp root differs from this process's", async () => {
    const profile = await tempProfile();
    vi.stubEnv("TRUSTY_SQUIRE_REAPER_DIR", join(profile, "reaper"));
    const brokerTemp = join(profile, "broker-temp");
    await mkdir(join(brokerTemp, "tsq-login-elsewhere"), { recursive: true, mode: 0o700 });
    const authFile = join(brokerTemp, "tsq-login-elsewhere", "xauthority");
    expect(dirname(dirname(authFile))).not.toBe(tmpdir());
    const launch = registerLocalBrowserLaunch(profile, { DISPLAY: ":73", XAUTHORITY: authFile });
    const child = await spawnHolder({ DISPLAY: ":0", XAUTHORITY: "/foreign/xauthority" }, profile);
    await holderOwnsProfile(profile, child);
    expect(
      bindOwnerBrowserLaunch(launch.marker, profileProcessIdentity(child.pid!, profile)!),
    ).toBe(true);
    mockState.attachSucceeds = true;
    try {
      const exposure = await exposeSharedBrokerCeremonyDisplay(profile, "test", headless);
      expect(exposure.kind).toBe("exposed");
      expect(mockState.rigs[0]).toMatchObject({ display: ":73", authFile });
      if (exposure.kind === "exposed") await exposure.stop();
    } finally {
      untrackOwnerBrowserLaunch(launch.marker);
    }
  });

  it("exposes the child's display when Chrome erased the holder environment", async () => {
    const profile = await tempProfile();
    const authFile = join(tmpdir(), "tsq-login-child", "xauthority");
    const holder = spawn(
      process.execPath,
      [
        "-e",
        `
      const { spawn } = require("node:child_process");
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        env: { DISPLAY: ":71", XAUTHORITY: ${JSON.stringify(authFile)} }, stdio: "ignore"
      });
      child.once("spawn", () => process.send(child.pid));
      process.on("disconnect", () => { child.kill("SIGKILL"); process.exit(); });
    `,
      ],
      { env: { PATH: process.env.PATH }, stdio: ["ignore", "ignore", "ignore", "ipc"] },
    );
    const childPid = await new Promise<number>((resolve) => holder.once("message", resolve));
    try {
      await holderOwnsProfile(profile, holder);
      mockState.attachSucceeds = true;
      const exposure = await exposeSharedBrokerCeremonyDisplay(profile, "test", headless);
      expect(exposure.kind).toBe("exposed");
      expect(mockState.rigs[0]).toMatchObject({ display: ":71", authFile });
      if (exposure.kind === "exposed") await exposure.stop();
      expect(() => process.kill(holder.pid!, 0)).not.toThrow();
    } finally {
      try {
        process.kill(childPid, "SIGKILL");
      } catch {}
      holder.disconnect();
    }
  });

  it("removes a partially prepared exposure rig when setup fails", async () => {
    const profile = await tempProfile();
    const child = await spawnHolder({
      DISPLAY: ":99",
      XAUTHORITY: join(tmpdir(), "tsq-login-broker", "xauthority"),
    });
    await holderOwnsProfile(profile, child);
    vi.stubEnv("TRUSTY_SQUIRE_REAPER_DIR", join(profile, "reaper"));
    mockState.secretSetupFails = true;
    const exposure = await exposeSharedBrokerCeremonyDisplay(profile, "test", headless);
    expect(exposure).toMatchObject({
      kind: "unshowable",
      reason: expect.stringContaining("secret setup failed"),
    });
    expect(mockState.rigs).toHaveLength(1);
    expect(mockState.rigs[0]!.privateDir).toBeUndefined();
    expect(mockState.privateDirs.every((path) => !existsSync(path))).toBe(true);
    expect(mockState.attachAttempts).toBe(0);
    expect(mockState.helpers).toHaveLength(1);
    await vi.waitFor(() => expect(mockState.helpers[0]!.signalCode).toBe("SIGTERM"));
    expect(() => process.kill(child.pid!, 0)).not.toThrow();
  });

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
    await expect(exposeSharedBrokerCeremonyDisplay(profile, "test", headless)).resolves.toEqual({
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
    await expect(exposeSharedBrokerCeremonyDisplay(profile, "test", headless)).resolves.toEqual({
      kind: "unshowable",
      reason: expect.stringMatching(/noVNC attach failed.*vnc attach down/),
    });
    // Prove the attach path was REACHED: the rig was created and the attach
    // was attempted (and threw).
    expect(mockState.rigCreated).toBe(1);
    expect(mockState.attachAttempts).toBe(1);
  });

  it("treats a tracked host display as already visible without noVNC", async () => {
    const profile = await tempProfile();
    vi.stubEnv("TRUSTY_SQUIRE_REAPER_DIR", join(profile, "reaper"));
    const authFile = "/home/someone/.Xauthority";
    const launch = registerLocalBrowserLaunch(profile, { DISPLAY: ":0", XAUTHORITY: authFile });
    const child = await spawnHolder({ DISPLAY: ":99", XAUTHORITY: join(tmpdir(), "tsq-login-x", "x") }, profile);
    await holderOwnsProfile(profile, child);
    expect(
      bindOwnerBrowserLaunch(launch.marker, profileProcessIdentity(child.pid!, profile)!),
    ).toBe(true);
    try {
      await expect(
        exposeSharedBrokerCeremonyDisplay(profile, "test", headless),
      ).resolves.toMatchObject({
        kind: "already_visible",
        reason: expect.stringMatching(/display this repository did not create/),
      });
      expect(mockState.rigCreated).toBe(0);
      expect(mockState.attachAttempts).toBe(0);
    } finally {
      untrackOwnerBrowserLaunch(launch.marker);
    }
  });

  it("does not attach noVNC to an owned Xvfb when the machine has a screen", async () => {
    const profile = await tempProfile();
    const child = await spawnHolder({
      PATH: process.env.PATH ?? "",
      DISPLAY: ":99",
      XAUTHORITY: join(tmpdir(), "tsq-login-hidden", "xauthority"),
    });
    await holderOwnsProfile(profile, child);
    await expect(
      exposeSharedBrokerCeremonyDisplay(profile, "test", screened),
    ).resolves.toMatchObject({
      kind: "already_visible",
      reason: expect.stringMatching(/machine has a screen/),
    });
    expect(mockState.rigCreated).toBe(0);
    expect(mockState.attachAttempts).toBe(0);
  });
});
