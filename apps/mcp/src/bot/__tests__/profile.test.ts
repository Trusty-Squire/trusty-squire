// Regression: stale Chrome SingletonLock self-heal.
//
// A bot Chrome that was SIGKILLed (or torn down hard) leaves a
// SingletonLock symlink behind. Without recovery, the next
// launchPersistentContext aborts with "Failed to create a
// ProcessSingleton" and bricks every signup AND `mcp login` — the
// "relogin prompted, no noVNC, still failed" bug. clearStaleSingletonLock
// removes the lock iff its holder pid is provably dead on this host, and
// NEVER yanks a lock held by a live process.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, lstatSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { clearStaleSingletonLock, launchWithProfileGate, waitForProfileFree } from "../profile.js";

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
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ts-profile-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

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
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ts-profile-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

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
      onWait: (h) => { waitedFor = h.pid; },
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

describe("launchWithProfileGate (race retry)", () => {
  let dir: string; // empty → re-waits return free instantly
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ts-profile-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("returns the launch result on first success", async () => {
    let calls = 0;
    const r = await launchWithProfileGate(dir, async () => { calls++; return "ctx"; });
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
      launchWithProfileGate(dir, async () => { calls++; throw new Error("unrelated boom"); }),
    ).rejects.toThrow("unrelated boom");
    expect(calls).toBe(1);
  });

  it("gives up after exhausting retries on persistent collisions", async () => {
    let calls = 0;
    await expect(
      launchWithProfileGate(
        dir,
        async () => { calls++; throw new Error("SingletonLock: File exists (17)"); },
        { retries: 2, reWaitMs: 100 },
      ),
    ).rejects.toThrow(/SingletonLock/);
    expect(calls).toBe(3); // initial attempt + 2 retries
  });
});
