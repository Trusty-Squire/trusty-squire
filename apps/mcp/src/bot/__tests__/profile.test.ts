// Regression: stale Chrome SingletonLock self-heal.
//
// A bot Chrome that was SIGKILLed (or torn down hard) leaves a
// SingletonLock symlink behind. Without recovery, the next
// launchPersistentContext aborts with "Failed to create a
// ProcessSingleton" and bricks every signup AND `mcp login` — the
// "relogin prompted, no noVNC, still failed" bug. clearStaleSingletonLock
// removes the lock iff its holder pid is provably dead on this host, and
// NEVER yanks a lock held by a live process.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import {
  acquireFreeProfileOperationGuard,
  acquireProfileOperationGuard,
  clearStaleSingletonLock,
  closeProfileWithProof,
  currentProfileHolderPid,
  launchWithProfileGate,
  profileProcessIdentity,
  processBirthIdentityState,
  ProfileBusyError,
  reapLeakedProfileHolder,
  reapProfileHolderIfOwned,
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
      expect(lockPresent(profileDir)).toBe(false);
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

describe("clearStaleSingletonLock", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ts-profile-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns false when there is no lock", () => {
    expect(clearStaleSingletonLock(dir)).toBe(false);
  });

  it("clears a stale lock whose holder pid is dead (this host)", () => {
    writeSingletons(dir, `${hostname()}-${deadPid()}`);
    expect(clearStaleSingletonLock(dir)).toBe(true);
    expect(lockPresent(dir)).toBe(false);
    expect(existsSync(join(dir, "SingletonSocket"))).toBe(false);
    expect(existsSync(join(dir, "SingletonCookie"))).toBe(false);
  });

  it("leaves a lock held by a LIVE pid untouched", () => {
    writeSingletons(dir, `${hostname()}-${process.pid}`); // we're alive
    expect(clearStaleSingletonLock(dir)).toBe(false);
    expect(lockPresent(dir)).toBe(true);
  });

  it("leaves a lock minted on another host untouched", () => {
    writeSingletons(dir, `some-other-host-${deadPid()}`);
    expect(clearStaleSingletonLock(dir)).toBe(false);
    expect(lockPresent(dir)).toBe(true);
  });

  it("ignores a malformed lock target", () => {
    symlinkSync("garbage-no-pid-here", join(dir, "SingletonLock"));
    expect(clearStaleSingletonLock(dir)).toBe(false);
    expect(lockPresent(dir)).toBe(true);
  });
});

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

  it("reclaims a stale lock and returns free", async () => {
    writeSingletons(dir, `${hostname()}-${deadPid()}`);
    expect(await waitForProfileFree(dir, { deadlineMs: 200, pollMs: 20 })).toBe(true);
    expect(lockPresent(dir)).toBe(false);
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

describe("profile operation guard", () => {
  let dir: string;
  let lockRoot: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ts-profile-"));
    lockRoot = mkdtempSync(join(tmpdir(), "ts-profile-locks-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(lockRoot, { recursive: true, force: true });
  });

  it("rejects a concurrent operation and releases cleanly", async () => {
    const first = await acquireFreeProfileOperationGuard(dir, lockRoot);
    expect(() => acquireProfileOperationGuard(dir, lockRoot)).toThrow(ProfileBusyError);
    first.release();
    const second = await acquireFreeProfileOperationGuard(dir, lockRoot);
    second.release();
  });

  it.skipIf(process.platform !== "linux")(
    "quarantines only the exact stale process birth before reclaiming",
    () => {
      const digest = createHash("sha256").update(dir).digest("hex").slice(0, 24);
      const lockDir = join(lockRoot, `trusty-squire-profile-${digest}.lock`);
      mkdirSync(lockDir);
      writeFileSync(
        join(lockDir, "owner.json"),
        JSON.stringify({
          host: hostname(),
          pid: process.pid,
          start_time: "not-this-process",
          token: "stale-token",
        }),
      );

      const lease = acquireProfileOperationGuard(dir, lockRoot);
      expect(() => acquireProfileOperationGuard(dir, lockRoot)).toThrow(ProfileBusyError);
      expect(readdirSync(lockRoot).filter((name) => name.includes(".stale-"))).toEqual([]);
      lease.release();
    },
  );

  it("keeps a quarantined live owner exclusive until that owner releases", () => {
    const digest = createHash("sha256").update(dir).digest("hex").slice(0, 24);
    const lockDir = join(lockRoot, `trusty-squire-profile-${digest}.lock`);
    const tombstone = `${lockDir}.stale-race`;
    const lease = acquireProfileOperationGuard(dir, lockRoot);
    renameSync(lockDir, tombstone);

    expect(() => acquireProfileOperationGuard(dir, lockRoot)).toThrow(ProfileBusyError);
    lease.release();
    expect(existsSync(tombstone)).toBe(false);
    const next = acquireProfileOperationGuard(dir, lockRoot);
    next.release();
  });

  it("reclaims an aged ownerless public lock without reclaiming a fresh one", () => {
    const digest = createHash("sha256").update(dir).digest("hex").slice(0, 24);
    const lockDir = join(lockRoot, `trusty-squire-profile-${digest}.lock`);
    mkdirSync(lockDir);
    expect(() => acquireProfileOperationGuard(dir, lockRoot)).toThrow(ProfileBusyError);

    const old = new Date(Date.now() - 60_000);
    utimesSync(lockDir, old, old);
    const lease = acquireProfileOperationGuard(dir, lockRoot);
    lease.release();
  });

  it("retains an aged legacy guard while its same-host process is alive", () => {
    const digest = createHash("sha256").update(dir).digest("hex").slice(0, 24);
    const lockDir = join(lockRoot, `trusty-squire-profile-${digest}.lock`);
    mkdirSync(lockDir);
    writeFileSync(
      join(lockDir, "owner.json"),
      JSON.stringify({ host: hostname(), pid: process.pid, token: "legacy-token" }),
    );
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockDir, old, old);

    expect(() => acquireProfileOperationGuard(dir, lockRoot)).toThrow(ProfileBusyError);
  });

  it("reclaims an aged legacy guard after its same-host process exits", () => {
    const digest = createHash("sha256").update(dir).digest("hex").slice(0, 24);
    const lockDir = join(lockRoot, `trusty-squire-profile-${digest}.lock`);
    mkdirSync(lockDir);
    writeFileSync(
      join(lockDir, "owner.json"),
      JSON.stringify({ host: hostname(), pid: deadPid(), token: "legacy-token" }),
    );
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockDir, old, old);

    const lease = acquireProfileOperationGuard(dir, lockRoot);
    lease.release();
  });

  it.skipIf(process.platform !== "linux")(
    "scavenges a stale private tombstone left by a crashed reclaimer",
    () => {
      const digest = createHash("sha256").update(dir).digest("hex").slice(0, 24);
      const tombstone = join(lockRoot, `trusty-squire-profile-${digest}.lock.stale-crashed`);
      mkdirSync(tombstone);
      writeFileSync(
        join(tombstone, "owner.json"),
        JSON.stringify({
          host: hostname(),
          pid: process.pid,
          start_time: "not-this-process",
          token: "stale-token",
        }),
      );

      const lease = acquireProfileOperationGuard(dir, lockRoot);
      expect(existsSync(tombstone)).toBe(false);
      lease.release();
    },
  );

  it("releases the operation lock when Chrome already owns the profile", async () => {
    writeSingletons(dir, `${hostname()}-${process.pid}`);
    await expect(acquireFreeProfileOperationGuard(dir, lockRoot)).rejects.toThrow(ProfileBusyError);
    rmSync(join(dir, "SingletonLock"), { force: true });
    const lease = await acquireFreeProfileOperationGuard(dir, lockRoot);
    lease.release();
  });

  it("allows nested work in the same operation", async () => {
    await expect(
      withProfileOperationGuard(
        dir,
        () => withProfileOperationGuard(dir, async () => "nested", lockRoot),
        lockRoot,
      ),
    ).resolves.toBe("nested");
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

describe("reapLeakedProfileHolder", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ts-profile-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns false when there is no lock", () => {
    expect(reapLeakedProfileHolder(dir)).toBe(false);
  });

  it("leaves a holder on ANOTHER host alone (shared profile)", () => {
    writeSingletons(dir, `some-other-box-${process.pid}`);
    expect(reapLeakedProfileHolder(dir)).toBe(false);
    expect(lockPresent(dir)).toBe(true);
  });

  it("frees the lock for a local holder (dead pid → SIGKILL no-ops, lock cleared)", () => {
    // A dead pid stands in for our leaked Chrome: the SIGKILL no-ops (already
    // gone) but the lock + sockets are reaped so the next run starts clean.
    // We do NOT pid-match — Chrome rewrites the lock asynchronously, so the
    // close() caller only knows "we own the profile, free whatever's here".
    writeSingletons(dir, `${hostname()}-${deadPid()}`);
    expect(reapLeakedProfileHolder(dir)).toBe(true);
    expect(lockPresent(dir)).toBe(false);
    expect(existsSync(join(dir, "SingletonSocket"))).toBe(false);
    expect(existsSync(join(dir, "SingletonCookie"))).toBe(false);
  });
});

describe("reapProfileHolderIfOwned", () => {
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
      reapProfileHolderIfOwned(
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
          reapProfileHolderIfOwned(dir, identity, (pid) => {
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

  it("clears a dead captured holder without signaling a recycled pid", () => {
    const pid = deadPid();
    writeSingletons(dir, `${hostname()}-${pid}`);
    const killed: number[] = [];
    expect(
      reapProfileHolderIfOwned(
        dir,
        { host: hostname(), pid, start_time: "dead", user_data_dir: dir },
        (signaledPid) => {
          killed.push(signaledPid);
        },
      ),
    ).toBe(true);
    expect(killed).toEqual([]);
    expect(lockPresent(dir)).toBe(false);
  });
});
