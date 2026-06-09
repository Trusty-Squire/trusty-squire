// profile.ts — the bot's persistent Chrome profile location.
//
// One canonical path, shared by two callers: google-login.ts writes the
// user's Google session into this profile, and BrowserController
// launches signup runs from it — so an OAuth signup reuses that
// session instead of starting logged-out. Override with
// TRUSTY_SQUIRE_PROFILE_DIR.

import { homedir, hostname } from "node:os";
import { lstatSync, readlinkSync, rmSync } from "node:fs";
import { join } from "node:path";

export const CHROME_PROFILE_DIR =
  process.env.TRUSTY_SQUIRE_PROFILE_DIR ?? join(homedir(), ".trusty-squire", "chrome-profile");

// Chrome's single-instance trio. SingletonLock is a symlink whose target
// is "<hostname>-<pid>"; the other two are sockets/cookies beside it.
const SINGLETON_FILES = ["SingletonLock", "SingletonSocket", "SingletonCookie"] as const;

// Thrown when the bot profile is held by a live run on another process and
// doesn't free up within the wait deadline. The CLI/MCP layers surface
// this as a clear "busy, retry" instead of a raw Playwright SingletonLock
// stack trace.
export class ProfileBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileBusyError";
  }
}

// process.kill(pid, 0) is a liveness probe — it sends no signal, it only
// asks "does this pid exist and am I allowed to signal it". ESRCH = the
// process is gone (stale lock). EPERM = it exists but isn't ours (still
// alive — do NOT treat as stale). Any other error: assume alive, because
// yanking a live profile's lock corrupts it.
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface LockHolder {
  host: string;
  pid: number;
  // True when the holder is a dead pid on THIS host — i.e. reclaimable.
  // A live pid, or any pid on another machine (shared profile), is not.
  stale: boolean;
}

// Read + parse Chrome's SingletonLock symlink ("<host>-<pid>"). null when
// there is no lock (the profile is free) or the link is malformed.
function readLockHolder(profileDir: string): LockHolder | null {
  const lockPath = join(profileDir, "SingletonLock");
  let target: string;
  try {
    if (!lstatSync(lockPath).isSymbolicLink()) return null;
    target = readlinkSync(lockPath);
  } catch {
    return null;
  }
  // The host may itself contain hyphens, so split on the LAST one.
  const dash = target.lastIndexOf("-");
  if (dash < 0) return null;
  const host = target.slice(0, dash);
  const pid = Number(target.slice(dash + 1));
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const onThisHost = host === hostname();
  return { host, pid, stale: onThisHost && !isPidAlive(pid) };
}

function removeSingletons(profileDir: string): void {
  for (const f of SINGLETON_FILES) {
    try { rmSync(join(profileDir, f), { force: true }); } catch { /* best-effort */ }
  }
}

// Self-heal a stale Chrome SingletonLock on the bot profile.
//
// Chrome single-instances a userDataDir via SingletonLock. A run that was
// SIGKILLed or a bot Chrome we tore down hard leaves the lock behind, and
// Playwright's launchPersistentContext then aborts with "Failed to create
// a ProcessSingleton ... File exists". Removing it is safe ONLY when the
// holder is provably gone (dead pid on this host). A lock held by a LIVE
// pid is a genuine concurrent run and is left untouched. Returns true iff
// a stale lock was cleared. Never throws.
export function clearStaleSingletonLock(profileDir: string = CHROME_PROFILE_DIR): boolean {
  const holder = readLockHolder(profileDir);
  if (holder === null || !holder.stale) return false;
  removeSingletons(profileDir);
  return true;
}

// The pid currently holding the profile's SingletonLock, IF it is on this
// host. Read right after a successful launch, this is unambiguously the
// Chrome WE just started (it created the lock). Stored by the caller so
// close() can verify the same process and reap it if it leaks. null when
// there's no lock or the holder is on another machine.
export function currentProfileHolderPid(
  profileDir: string = CHROME_PROFILE_DIR,
): number | null {
  const holder = readLockHolder(profileDir);
  if (holder === null || holder.host !== hostname()) return null;
  return holder.pid;
}

// Free the profile after WE are done with it (called from close(), once our
// own context is closed). context.close() is supposed to terminate the
// browser, but headed Chrome under Xvfb (and some patchright teardowns) can
// leave the main process alive holding the SingletonLock with a LIVE pid —
// which the next run's waitForProfileFree treats as a genuine concurrent run
// and waits 120s on before failing with ProfileBusyError. One leak bricks
// EVERY subsequent run in a batch (measured: 4/7 of a discovery batch).
//
// We do NOT pid-match here, and deliberately so: Chrome rewrites the
// SingletonLock asynchronously during startup, so the pid we could read right
// after launch is often the PREVIOUS holder's — a stale value that would make
// a pid-matched reap skip the real leak (the bug that left 2253353 alive).
// Instead: at close() we are definitively finished with the profile and the
// bot serializes profile access (the cross-process gate), so any holder still
// on THIS host is our own leaked browser — SIGKILL it and clear the lock. A
// holder on ANOTHER host (shared profile over a network mount) is left alone.
// Returns true iff it freed a live/stale local holder. Never throws.
export function reapLeakedProfileHolder(
  profileDir: string = CHROME_PROFILE_DIR,
): boolean {
  const holder = readLockHolder(profileDir);
  if (holder === null || holder.host !== hostname()) return false;
  try {
    process.kill(holder.pid, "SIGKILL");
  } catch {
    // already gone between the read and the kill — fall through to cleanup
  }
  removeSingletons(profileDir);
  return true;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface WaitForProfileOptions {
  // Max time to wait for a LIVE cross-process holder to release.
  deadlineMs?: number;
  pollMs?: number;
  // Fired once, the first time we actually have to wait on a live holder
  // (so the caller can print "another run is using the browser — waiting…").
  onWait?: (holder: LockHolder) => void;
}

// Cross-process serialization gate for the shared Chrome profile.
//
// The signup bot (in the MCP server) and a separate `mcp login` process
// both open the one profile, and Chrome single-instances it. Rather than
// run a parallel lock system, this waits on Chrome's OWN SingletonLock as
// the semaphore:
//   - no lock              → free, return immediately
//   - lock, holder dead    → stale, reclaim it (clearStaleSingletonLock)
//   - lock, holder alive   → a genuine concurrent run — poll until it
//                            releases, up to deadlineMs
//
// Returns true once the profile is free to open, or false if a live
// holder never released within the deadline (caller surfaces ProfileBusyError).
// This is what turns "separate `mcp login` collides and crashes" into
// "login waits its turn behind an in-flight signup, then proceeds".
export async function waitForProfileFree(
  profileDir: string = CHROME_PROFILE_DIR,
  opts: WaitForProfileOptions = {},
): Promise<boolean> {
  const deadlineMs = opts.deadlineMs ?? 120_000;
  const pollMs = opts.pollMs ?? 1_000;
  const deadline = Date.now() + deadlineMs;
  let warned = false;
  for (;;) {
    const holder = readLockHolder(profileDir);
    if (holder === null) return true; // free
    if (holder.stale) {
      removeSingletons(profileDir);
      return true; // reclaimed a dead holder
    }
    // Live holder (or a pid on another host we can't reclaim).
    if (!warned) {
      warned = true;
      opts.onWait?.(holder);
    }
    if (Date.now() >= deadline) return false; // never freed → busy
    await sleep(pollMs);
  }
}

// True when the error is Chrome/Playwright refusing to open the profile
// because the single-instance lock already exists.
function isSingletonCollision(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /ProcessSingleton|SingletonLock/i.test(msg);
}

// Open the profile, retrying on the free→launch race.
//
// waitForProfileFree closes the long window, but there is still a
// sub-second gap between "lock is absent" and Chrome creating it where a
// second process can win — launchPersistentContext then throws
// "Failed to create a ProcessSingleton". This wraps the launch: on that
// specific collision it re-waits for the new holder (reclaiming it if it
// died) and relaunches, up to `retries` times. Any other error, or a
// holder that never releases, propagates. This is what makes the
// cross-process gate race-free in practice.
export async function launchWithProfileGate<T>(
  profileDir: string,
  launch: () => Promise<T>,
  opts: { retries?: number; reWaitMs?: number } = {},
): Promise<T> {
  const retries = opts.retries ?? 3;
  for (let attempt = 0; ; attempt++) {
    try {
      return await launch();
    } catch (err) {
      if (attempt >= retries || !isSingletonCollision(err)) throw err;
      const free = await waitForProfileFree(profileDir, {
        deadlineMs: opts.reWaitMs ?? 30_000,
        pollMs: 500,
      });
      if (!free) {
        throw new ProfileBusyError(
          "bot Chrome profile stayed locked across launch retries — another run isn't releasing it",
        );
      }
    }
  }
}
