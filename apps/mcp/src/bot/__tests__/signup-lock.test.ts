import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { dirname, join } from "node:path";

// Isolate the lock file to a temp profile dir BEFORE importing the module
// (LOCK_PATH is computed from CHROME_PROFILE_DIR at import time).
const tmpProfile = mkdtempSync(join(tmpdir(), "ts-lock-"));
process.env.TRUSTY_SQUIRE_PROFILE_DIR = join(tmpProfile, "chrome-profile");
const LOCK_PATH = join(dirname(process.env.TRUSTY_SQUIRE_PROFILE_DIR), "signup-queue.lock");

type Mod = typeof import("../signup-lock.js");
let mod: Mod;
beforeAll(async () => {
  mod = await import("../signup-lock.js");
});
afterEach(() => {
  try { rmSync(LOCK_PATH); } catch { /* not held */ }
});

describe("lockIsReclaimable", () => {
  it("reclaims a dead local pid", () => {
    // pid 2^22 is above the typical pid_max → not alive.
    const rec = { pid: 4194303, host: hostname(), startedAt: Date.now(), label: "x" };
    expect(mod.lockIsReclaimable(rec, Date.now(), hostname())).toBe(true);
  });
  it("reclaims an expired holder regardless of host", () => {
    const rec = { pid: process.pid, host: "some-other-box", startedAt: Date.now() - 60 * 60_000, label: "x" };
    expect(mod.lockIsReclaimable(rec, Date.now(), hostname())).toBe(true);
  });
  it("does NOT reclaim a fresh, alive, local holder", () => {
    const rec = { pid: process.pid, host: hostname(), startedAt: Date.now(), label: "x" };
    expect(mod.lockIsReclaimable(rec, Date.now(), hostname())).toBe(false);
  });
});

describe("acquireSignupLock", () => {
  it("acquires when free, then releases (file gone)", async () => {
    const release = await mod.acquireSignupLock("svc:form");
    expect(existsSync(LOCK_PATH)).toBe(true);
    const rec = JSON.parse(readFileSync(LOCK_PATH, "utf8"));
    expect(rec.pid).toBe(process.pid);
    expect(rec.label).toBe("svc:form");
    release();
    expect(existsSync(LOCK_PATH)).toBe(false);
  });

  it("reclaims a stale dead-pid lock left by a crashed process", async () => {
    // Simulate an orphan: a lock file owned by a dead local pid.
    writeFileSync(LOCK_PATH, JSON.stringify({ pid: 4194303, host: hostname(), startedAt: Date.now(), label: "orphan" }));
    const release = await mod.acquireSignupLock("new:form", { deadlineMs: 3000 });
    const rec = JSON.parse(readFileSync(LOCK_PATH, "utf8"));
    expect(rec.pid).toBe(process.pid); // we stole it
    release();
  });
});

describe("withSignupLock — in-process serialization", () => {
  it("runs queued callers strictly one at a time", async () => {
    let active = 0;
    let maxActive = 0;
    const task = () => mod.withSignupLock("svc:form", async () => {
      active++; maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 20));
      active--;
      return true;
    });
    await Promise.all([task(), task(), task()]);
    expect(maxActive).toBe(1); // never overlapped
    expect(existsSync(LOCK_PATH)).toBe(false); // released after all
  });
});
