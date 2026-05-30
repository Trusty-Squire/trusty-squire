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

// Self-heal a stale Chrome SingletonLock on the bot profile.
//
// Chrome single-instances a userDataDir via SingletonLock. A run that was
// SIGKILLed or a bot Chrome we tore down hard leaves the lock behind, and
// Playwright's launchPersistentContext then aborts with "Failed to create
// a ProcessSingleton ... File exists" — which bricks EVERY later signup
// AND `mcp login` until someone clears it by hand. (This is exactly the
// "relogin prompted, no noVNC, still failed" failure: login died on the
// stale lock before the noVNC rig could start.)
//
// Removing the lock is safe ONLY when its holder is provably gone: the
// lock names a pid on THIS host that is no longer alive. A lock held by a
// LIVE pid is a genuine concurrent run and is left untouched. Returns
// true iff a stale lock was cleared. Never throws.
export function clearStaleSingletonLock(profileDir: string = CHROME_PROFILE_DIR): boolean {
  const lockPath = join(profileDir, "SingletonLock");
  let target: string;
  try {
    if (!lstatSync(lockPath).isSymbolicLink()) return false;
    target = readlinkSync(lockPath);
  } catch {
    return false; // no lock present — nothing to heal
  }
  // "<host>-<pid>". The host may itself contain hyphens, so split on the
  // LAST one to isolate the pid.
  const dash = target.lastIndexOf("-");
  const host = dash >= 0 ? target.slice(0, dash) : "";
  const pid = Number(dash >= 0 ? target.slice(dash + 1) : "");
  // Only reason about liveness for a lock minted on THIS host — a pid
  // from another machine (shared profile) is meaningless here.
  if (host !== hostname() || !Number.isInteger(pid) || pid <= 0) return false;
  if (isPidAlive(pid)) return false; // live holder — concurrent run, leave it
  for (const f of SINGLETON_FILES) {
    try { rmSync(join(profileDir, f), { force: true }); } catch { /* best-effort */ }
  }
  return true;
}
