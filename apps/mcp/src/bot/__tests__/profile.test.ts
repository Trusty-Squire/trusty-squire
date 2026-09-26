// Chrome owns its SingletonLock; the broker owns only the kernel SQLite lock.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import {
  acquireFreeProfileOperationGuard,
  acquireProfileOperationGuard,
  profileOperationLockPath,
  closeProfileWithProof,
  currentProfileHolderPid,
  launchWithProfileGate,
  profileProcessIdentity,
  profileProcessIdentityState,
  processBirthIdentityState,
  ProfileBusyError,
  signalProfileHolderIfOwned,
  signalProfileProcess,
  waitForProfileFree,
  withProfileOperationGuard,
} from "../profile.js";

describe("profile process identity", () => {
  it("treats a reused current pid as stale when its birth time differs", () => {
    expect(processBirthIdentityState({ pid: process.pid, start_time: "not-this-process" })).toBe(
      "stale",
    );
  });

  it("retains an identity when its birth time cannot be read", () => {
    expect(
      processBirthIdentityState({ pid: process.pid, start_time: "1" }, () => ({
        state: "unknown",
      })),
    ).toBe("unknown");
  });

  it.skipIf(process.platform !== "linux")(
    "signals only the same process birth and user-data directory",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "ts-profile-worker-"));
      const child = spawn(
        process.execPath,
        ["-e", "setInterval(() => undefined, 1000)", "--", `--user-data-dir=${dir}`],
        { stdio: "ignore" },
      );
      try {
        let identity = child.pid === undefined ? null : profileProcessIdentity(child.pid, dir);
        await vi.waitFor(() => {
          identity = child.pid === undefined ? null : profileProcessIdentity(child.pid, dir);
          expect(identity).not.toBeNull();
        });
        const killed: number[] = [];
        expect(
          signalProfileProcess(identity!, `${dir}-other`, "SIGKILL", (pid) => killed.push(pid)),
        ).toBe(false);
        expect(signalProfileProcess(identity!, dir, "SIGKILL", (pid) => killed.push(pid))).toBe(
          true,
        );
        expect(killed).toEqual([child.pid]);
      } finally {
        child.kill("SIGKILL");
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform !== "linux")(
    "keeps the launch identity valid after Chrome flattens its process title",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "ts-profile-flattened-title-"));
      const child = spawn(
        process.execPath,
        [
          "-e",
          `process.stdin.once("data", () => {
            process.title = process.execPath + " --user-data-dir=${dir}";
            process.stdout.write("flattened\\n");
          }); setInterval(() => undefined, 1000);`,
          "--",
          `--user-data-dir=${dir}`,
        ],
        { stdio: ["pipe", "pipe", "ignore"] },
      );
      try {
        let identity = child.pid === undefined ? null : profileProcessIdentity(child.pid, dir);
        await vi.waitFor(() => {
          identity = child.pid === undefined ? null : profileProcessIdentity(child.pid, dir);
          expect(identity).not.toBeNull();
        });

        child.stdin.write("flatten");
        await new Promise<void>((resolve) => child.stdout.once("data", () => resolve()));

        expect(profileProcessIdentityState(identity!, dir)).toBe("matching");
      } finally {
        child.kill("SIGKILL");
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

describe("profile close proof", () => {
  it("returns closed only after exact identity disappearance is observed", async () => {
    const profileDir = mkdtempSync(join(tmpdir(), "ts-profile-close-proof-"));
    const pid = deadPid();
    writeSingletons(profileDir, `${hostname()}-${pid}`);
    const states: Array<"matching" | "stale"> = ["matching", "stale"];
    try {
      await expect(
        closeProfileWithProof({
          profileDir,
          identity: {
            host: hostname(),
            pid,
            start_time: "1",
            user_data_dir: profileDir,
          },
          close: async () => undefined,
          forceClose: vi.fn(),
          pollMs: 0,
          identityState: () => states.shift() ?? "stale",
        }),
      ).resolves.toBe("closed");
      expect(lockPresent(profileDir)).toBe(true); // Chrome owns its symlink.
    } finally {
      rmSync(profileDir, { recursive: true, force: true });
    }
  });

  it("returns unknown when closure identity cannot be proven", async () => {
    await expect(
      closeProfileWithProof({
        profileDir: "/unused/profile",
        identity: null,
        close: async () => undefined,
        forceClose: vi.fn(),
      }),
    ).resolves.toBe("unknown");
  });

  it("returns force_closed_unproven when graceful close stalls", async () => {
    vi.useFakeTimers();
    const forceClose = vi.fn();
    const closing = closeProfileWithProof({
      profileDir: "/unused/profile",
      identity: null,
      close: () => new Promise<void>(() => undefined),
      forceClose,
      closeTimeoutMs: 100,
    });

    await vi.advanceTimersByTimeAsync(100);
    await expect(closing).resolves.toBe("force_closed_unproven");
    expect(forceClose).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
});

// existsSync follows symlinks, and SingletonLock's target ("host-pid") is
// a label, not a real file — so it always reports "missing". Probe the
// link itself with lstat.
function lockPresent(dir: string): boolean {
  try {
    return lstatSync(join(dir, "SingletonLock")).isSymbolicLink();
  } catch {
    return false;
  }
}

function writeSingletons(dir: string, lockTarget: string): void {
  symlinkSync(lockTarget, join(dir, "SingletonLock"));
  writeFileSync(join(dir, "SingletonSocket"), "");
  writeFileSync(join(dir, "SingletonCookie"), "");
}

// A pid that has certainly exited: spawn a no-op node and let it finish.
function deadPid(): number {
  const r = spawnSync(process.execPath, ["-e", ""]);
  if (r.pid === undefined) throw new Error("could not spawn a throwaway process");
  return r.pid;
}

describe("waitForProfileFree (cross-process gate)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ts-profile-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns free immediately when there is no lock", async () => {
    expect(await waitForProfileFree(dir, { deadlineMs: 200, pollMs: 20 })).toBe(true);
  });

  it("recognizes a stale Chrome lock and leaves recovery to Chrome", async () => {
    writeSingletons(dir, `${hostname()}-${deadPid()}`);
    expect(await waitForProfileFree(dir, { deadlineMs: 200, pollMs: 20 })).toBe(true);
    expect(lockPresent(dir)).toBe(true);
  });

  it("returns busy (false) when a live holder never releases", async () => {
    writeSingletons(dir, `${hostname()}-${process.pid}`); // we stay alive
    let waitedFor: number | null = null;
    const ok = await waitForProfileFree(dir, {
      deadlineMs: 150,
      pollMs: 25,
      onWait: (h) => {
        waitedFor = h.pid;
      },
    });
    expect(ok).toBe(false);
    expect(waitedFor).toBe(process.pid); // onWait fired for the live holder
    expect(lockPresent(dir)).toBe(true); // never yanked a live lock
  });

  it("proceeds once a live holder releases mid-wait", async () => {
    writeSingletons(dir, `${hostname()}-${process.pid}`);
    // Another process would release by exiting; simulate by removing the
    // lock after a beat. waitForProfileFree should then see it free.
    setTimeout(() => rmSync(join(dir, "SingletonLock"), { force: true }), 80);
    expect(await waitForProfileFree(dir, { deadlineMs: 2_000, pollMs: 25 })).toBe(true);
  });
});

describe("kernel profile lock", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ts-profile-kernel-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("respects a live holder and releases on close", () => {
    const first = acquireProfileOperationGuard(dir);
    expect(() => acquireProfileOperationGuard(dir)).toThrow(ProfileBusyError);
    first.release();
    acquireProfileOperationGuard(dir).release();
  });

  it.skipIf(process.platform === "win32")("frees immediately when its holder is SIGKILLed", async () => {
    const path = profileOperationLockPath(dir);
    const child = spawn(process.execPath, ["-e", `
      const Database = require('better-sqlite3');
      const db = new Database(process.argv[1], {timeout: 0});
      db.exec('BEGIN EXCLUSIVE');
      process.on('exit', () => db.close());
      process.stdout.write('held\\n');
      setInterval(() => {}, 1000);
    `, path], { cwd: join(import.meta.dirname, "../../.."), stdio: ["ignore", "pipe", "ignore"] });
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout!.once("data", () => resolve());
        child.once("error", reject);
      });
      expect(() => acquireProfileOperationGuard(dir)).toThrow(ProfileBusyError);
      child.kill("SIGKILL");
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
      acquireProfileOperationGuard(dir).release();
    } finally { child.kill("SIGKILL"); }
  });

  it("permits nested work in one operation", async () => {
    await expect(withProfileOperationGuard(dir, () =>
      withProfileOperationGuard(dir, async () => "nested"))).resolves.toBe("nested");
  });
});

describe("launchWithProfileGate (race retry)", () => {
  let dir: string; // empty → re-waits return free instantly
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ts-profile-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns the launch result on first success", async () => {
    let calls = 0;
    const r = await launchWithProfileGate(dir, async () => {
      calls++;
      return "ctx";
    });
    expect(r).toBe("ctx");
    expect(calls).toBe(1);
  });

  it("retries once on a ProcessSingleton collision, then succeeds", async () => {
    let calls = 0;
    const r = await launchWithProfileGate(
      dir,
      async () => {
        calls++;
        if (calls === 1) {
          throw new Error("Failed to create a ProcessSingleton for your profile directory");
        }
        return "ctx";
      },
      { reWaitMs: 200 },
    );
    expect(r).toBe("ctx");
    expect(calls).toBe(2); // lost the race once, won the retry
  });

  it("propagates a non-collision error without retrying", async () => {
    let calls = 0;
    await expect(
      launchWithProfileGate(dir, async () => {
        calls++;
        throw new Error("unrelated boom");
      }),
    ).rejects.toThrow("unrelated boom");
    expect(calls).toBe(1);
  });

  it("gives up after exhausting retries on persistent collisions", async () => {
    let calls = 0;
    await expect(
      launchWithProfileGate(
        dir,
        async () => {
          calls++;
          throw new Error("SingletonLock: File exists (17)");
        },
        { retries: 2, reWaitMs: 100 },
      ),
    ).rejects.toThrow(/SingletonLock/);
    expect(calls).toBe(3); // initial attempt + 2 retries
  });
});

// Regression: a leaked bot Chrome (context.close() returned but the browser
// process stayed alive holding the lock) bricked every subsequent run in a
// batch with a 120s ProfileBusyError. close() now reaps it by pid.
describe("currentProfileHolderPid", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ts-profile-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when there is no lock", () => {
    expect(currentProfileHolderPid(dir)).toBeNull();
  });

  it("returns the holder pid for a lock on this host", () => {
    writeSingletons(dir, `${hostname()}-${process.pid}`);
    expect(currentProfileHolderPid(dir)).toBe(process.pid);
  });

  it("returns null for a lock held on another host (shared profile)", () => {
    writeSingletons(dir, `some-other-box-${process.pid}`);
    expect(currentProfileHolderPid(dir)).toBeNull();
  });
});

describe("signalProfileHolderIfOwned", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ts-profile-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not kill a later holder with a different pid", () => {
    writeSingletons(dir, `${hostname()}-${process.pid}`);
    const killed: number[] = [];
    expect(
      signalProfileHolderIfOwned(
        dir,
        {
          host: hostname(),
          pid: process.pid + 1,
          start_time: "different",
          user_data_dir: dir,
        },
        (pid) => {
          killed.push(pid);
        },
      ),
    ).toBe(false);
    expect(killed).toEqual([]);
    expect(lockPresent(dir)).toBe(true);
  });

  it.skipIf(process.platform !== "linux")(
    "retains a live holder singleton after requesting exact termination",
    async () => {
      const child = spawn(
        process.execPath,
        ["-e", "setInterval(() => undefined, 1000)", "--", `--user-data-dir=${dir}`],
        { stdio: "ignore" },
      );
      try {
        let identity = child.pid === undefined ? null : profileProcessIdentity(child.pid, dir);
        await vi.waitFor(() => {
          identity = child.pid === undefined ? null : profileProcessIdentity(child.pid, dir);
          expect(identity).not.toBeNull();
        });
        writeSingletons(dir, `${hostname()}-${child.pid}`);
        const killed: number[] = [];
        expect(
          signalProfileHolderIfOwned(dir, identity, (pid) => {
            killed.push(pid);
          }),
        ).toBe(false);
        expect(killed).toEqual([child.pid]);
        expect(lockPresent(dir)).toBe(true);
      } finally {
        child.kill("SIGKILL");
      }
    },
  );
});
