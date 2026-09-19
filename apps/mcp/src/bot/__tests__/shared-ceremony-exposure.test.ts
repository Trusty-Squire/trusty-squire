// The shared-broker ceremony exposure must never start a noVNC rig it cannot
// PROVE is ours: the holder's XAUTHORITY has to be a `tsq-login-` private
// rig the broker minted. Any other state — no holder at all, no display
// variables, a foreign Xauthority — skips the exposure silently (the operator
// is assumed to be looking at the screen themselves, or the broker runs
// headless and the user follows the confirm tab another way).

import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireProfileOperationGuard } from "../profile.js";
import { exposeSharedBrokerCeremonyDisplay } from "../google-login.js";
import type * as RemoteLoginDisplayModule from "../remote-login-display.js";

// The degradation rule: an exposure failure must NEVER refuse a connect that
// would otherwise succeed. The noVNC page is how the human is SHOWN the
// login, not a precondition for logging in. This mock makes the attach fail
// deterministically; the test below pins that the helper still resolves null.
vi.mock("../remote-login-display.js", async (importOriginal) => {
  const actual = await importOriginal<typeof RemoteLoginDisplayModule>();
  return {
    ...actual,
    createRemoteLoginRig: () => ({
      width: 720,
      height: 1280,
      procs: [],
      binaries: { xvfb: "/unused/xvfb", x11vnc: "/unused/x11vnc", websockify: "/unused/websockify" },
    }),
    exposeRemoteLoginDisplay: async () => {
      throw new Error("vnc attach down");
    },
  };
});

const dirs: string[] = [];
const leases: { release: () => void }[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  leases.splice(0).forEach((lease) => lease.release());
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempProfile(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ts-ceremony-exposure-"));
  dirs.push(root);
  const profile = join(root, "profile");
  await mkdir(profile, { recursive: true, mode: 0o700 });
  return profile;
}

/** The lock file path the guard machinery actually derives for this profile. */
async function profileLockPath(profileDir: string, lockRoot: string): Promise<string> {
  const lease = acquireProfileOperationGuard(profileDir, lockRoot);
  const name = (await readdir(lockRoot)).find(
    (entry) => entry.startsWith("trusty-squire-profile-") && entry.endsWith(".lock"),
  )!;
  lease.release();
  await rm(join(lockRoot, name), { force: true });
  return join(lockRoot, name);
}

/** A live child that holds the profile lease with an owned-rig environment. */
async function spawnRigHolder(lockPath: string): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `const fs = require("node:fs");
       const stat = fs.readFileSync("/proc/self/stat", "utf8");
       const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
       fs.writeFileSync(process.argv[1], JSON.stringify({
         host: require("node:os").hostname(), pid: process.pid, start_time: start, token: "lease",
       }), { mode: 0o600 });
       setInterval(() => undefined, 1000);`,
      lockPath,
    ],
    {
      env: {
        ...process.env,
        DISPLAY: ":99",
        XAUTHORITY: join(tmpdir(), "tsq-login-ceremonytest", "Xauthority"),
      },
      stdio: "ignore",
    },
  );
  children.push(child);
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const holder = JSON.parse(readFileSync(lockPath, "utf8"));
      if (holder.pid === child.pid) break;
    } catch {
      /* not written yet */
    }
    if (Date.now() > deadline) throw new Error("rig holder did not become ready");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return child;
}

describe("exposeSharedBrokerCeremonyDisplay", () => {
  it("skips exposure when no process holds the profile", async () => {
    const profile = await tempProfile();
    await expect(exposeSharedBrokerCeremonyDisplay(profile, "test")).resolves.toBeNull();
  });

  it("skips exposure when the holder's environment has no owned login rig", async () => {
    const profile = await tempProfile();
    const root = dirname(profile);
    // This process holds the profile lease, but its environment carries no
    // tsq-login- XAUTHORITY (the test sandbox has none), so there is nothing
    // to expose — and certainly no rig the helper should adopt.
    const lease = acquireProfileOperationGuard(profile, root);
    leases.push(lease);
    await expect(exposeSharedBrokerCeremonyDisplay(profile, "test")).resolves.toBeNull();
  });

  it("degrades to no exposure when the noVNC attach fails — it never refuses the connect", async () => {
    const profile = await tempProfile();
    const root = dirname(profile);
    const lockPath = await profileLockPath(profile, root);
    await spawnRigHolder(lockPath);
    // The holder's environment names an owned tsq-login- rig, so the helper
    // TRIES to attach — and the mocked attach fails. The ceremony must still
    // get its null (plain-tab banner, connect continues), never a throw.
    await expect(exposeSharedBrokerCeremonyDisplay(profile, "test")).resolves.toBeNull();
  });
});
