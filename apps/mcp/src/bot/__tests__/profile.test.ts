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
import { clearStaleSingletonLock } from "../profile.js";

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
