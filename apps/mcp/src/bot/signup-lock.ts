// signup-lock.ts — an explicit cross-process locked queue for signup runs,
// with expiry-based reclaim + a process watchdog.
//
// Why this exists (the failure it replaces). Every signup run launches Chrome
// from the ONE shared persistent profile, so runs MUST serialize. Two
// mechanisms existed and both were insufficient:
//   • withOAuthLock (oauth-lock.ts) is an IN-PROCESS promise chain — it does
//     nothing across separate `node` processes. The heal pass runs each
//     discover as its OWN process, and a hand-run `--service=X` is another, so
//     withOAuthLock never serialized them.
//   • Chrome's SingletonLock (profile.ts/waitForProfileFree) is the only
//     cross-process gate, but it has no expiry: a run that HANGS (a stuck
//     browser.close()/await — MEASURED 2026-06-12: ~26 discover processes
//     launched while the proxy was dead never exited, each pinning a
//     Chrome+Xvfb, starving the queue).
//
// This module is the fix: a file lock keyed on (pid, host, startedAt) that any
// process acquires before running. A holder that is DEAD (pid gone) or EXPIRED
// (held longer than the hold cap — i.e. hung) is reclaimed, and a per-run
// WATCHDOG hard-exits a process that overruns the cap so it can't live forever.
// In-process calls still queue (the promise chain below) so the file lock is
// never contended same-pid (which would self-deadlock).

import { writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { CHROME_PROFILE_DIR } from "./profile.js";

// Sibling of the profile dir (NOT inside it — Chrome must never touch it).
const LOCK_PATH = join(dirname(CHROME_PROFILE_DIR), "signup-queue.lock");

// A normal discover caps its signup at 600s, plus OAuth + email polls +
// teardown + telemetry/auto-promote. WATCHDOG fires well above that so it never
// kills a legit run; LOCK_EXPIRY is slightly higher so a holder that somehow
// outlived its own watchdog is still reclaimable; DEADLINE bounds how long a
// queued run waits (one full run + a reclaim window).
const WATCHDOG_MS = 18 * 60_000;
const LOCK_EXPIRY_MS = 20 * 60_000;
const DEADLINE_MS = 22 * 60_000;
const POLL_MS = 1_000;

export interface SignupLockRecord {
  pid: number;
  host: string;
  startedAt: number;
  label: string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = liveness probe, doesn't actually signal
    return true;
  } catch {
    return false; // ESRCH (gone) or EPERM (alive but not ours — treat conservatively below)
  }
}

function readLock(): SignupLockRecord | null {
  try {
    return JSON.parse(readFileSync(LOCK_PATH, "utf8")) as SignupLockRecord;
  } catch {
    return null; // absent or unparseable
  }
}

// True when a held lock should be forcibly reclaimed: the holder is a dead
// local pid, OR it has been held past the hold cap (hung). Exported for tests.
export function lockIsReclaimable(
  rec: SignupLockRecord,
  now: number,
  thisHost: string,
): boolean {
  const expired = now - rec.startedAt > LOCK_EXPIRY_MS;
  const localDead = rec.host === thisHost && !pidAlive(rec.pid);
  return expired || localDead;
}

// Acquire the cross-process lock, returning a release function. Reclaims a
// dead/expired holder (SIGKILLing a live-but-expired LOCAL holder first so its
// orphaned Chrome dies with it). Throws if the deadline is exceeded.
export async function acquireSignupLock(
  label: string,
  opts: { deadlineMs?: number } = {},
): Promise<() => void> {
  const deadline = Date.now() + (opts.deadlineMs ?? DEADLINE_MS);
  const me: SignupLockRecord = {
    pid: process.pid,
    host: hostname(),
    startedAt: Date.now(),
    label,
  };
  for (;;) {
    try {
      // Atomic claim — fails (EEXIST) if a lock file already exists.
      writeFileSync(LOCK_PATH, JSON.stringify(me), { flag: "wx" });
      return makeRelease(me);
    } catch {
      // Held by someone — evaluate whether to reclaim or wait.
    }
    const cur = readLock();
    if (cur === null) {
      continue; // raced with a release; retry the claim immediately
    }
    if (lockIsReclaimable(cur, Date.now(), hostname())) {
      if (cur.host === hostname() && pidAlive(cur.pid) && cur.pid !== process.pid) {
        // Live-but-expired LOCAL holder = a hung run. Kill it so its leaked
        // Chrome/Xvfb dies, then steal the lock.
        try {
          process.kill(cur.pid, "SIGKILL");
        } catch {
          // already gone between read and kill
        }
      }
      try {
        unlinkSync(LOCK_PATH);
      } catch {
        // someone else reclaimed it first; loop and re-try the claim
      }
      continue;
    }
    if (Date.now() > deadline) {
      throw new SignupLockTimeoutError(
        `signup-lock: timed out after ${Math.round(
          (opts.deadlineMs ?? DEADLINE_MS) / 1000,
        )}s waiting for "${cur.label}" (pid ${cur.pid}, held ${Math.round(
          (Date.now() - cur.startedAt) / 1000,
        )}s)`,
      );
    }
    await sleep(POLL_MS);
  }
}

export class SignupLockTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignupLockTimeoutError";
  }
}

function makeRelease(me: SignupLockRecord): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    // Only delete if WE still own it (a reclaim may have stolen it after our
    // watchdog fired); identity = pid + startedAt.
    const cur = readLock();
    if (cur !== null && cur.pid === me.pid && cur.startedAt === me.startedAt) {
      try {
        unlinkSync(LOCK_PATH);
      } catch {
        // already gone — fine
      }
    }
  };
}

// In-process queue tail so concurrent same-process callers serialize BEFORE
// touching the file lock (a same-pid file-lock contention would self-deadlock,
// since our own pid never reads as dead). Subsumes withOAuthLock.
let inProcTail: Promise<unknown> = Promise.resolve();

// Run `fn` holding the signup lock: queued in-process, serialized cross-process
// (with dead/hung-holder reclaim), and guarded by a hard watchdog that
// process.exit()s if the run overruns the hold cap — so a hung run can never
// accumulate as an orphan again. The lock is released however `fn` settles.
export function withSignupLock<T>(
  label: string,
  fn: () => Promise<T>,
  opts: { deadlineMs?: number } = {},
): Promise<T> {
  const run = inProcTail.then(
    () => acquireRunRelease(label, fn, opts),
    () => acquireRunRelease(label, fn, opts),
  );
  inProcTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function acquireRunRelease<T>(
  label: string,
  fn: () => Promise<T>,
  opts: { deadlineMs?: number },
): Promise<T> {
  const release = await acquireSignupLock(label, opts);
  // Watchdog: a run that hangs past the cap hard-exits the process so it can't
  // become a lock-starving orphan. unref() so the timer itself never keeps the
  // loop alive. Releases the lock first as a best-effort on the way out.
  const watchdog = setTimeout(() => {
    console.error(
      `[signup-lock] WATCHDOG: "${label}" exceeded ${Math.round(
        WATCHDOG_MS / 60_000,
      )}min — hard-exiting (process.exit) to avoid a hung orphan holding the queue`,
    );
    try {
      release();
    } catch {
      // best-effort
    }
    process.exit(1);
  }, WATCHDOG_MS);
  watchdog.unref();
  try {
    return await fn();
  } finally {
    clearTimeout(watchdog);
    release();
  }
}
