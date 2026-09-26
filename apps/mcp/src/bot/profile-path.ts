import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export const CHROME_PROFILE_DIR =
  process.env.TRUSTY_SQUIRE_PROFILE_DIR ?? join(homedir(), ".trusty-squire", "chrome-profile");

/**
 * The profile in force for this call. CHROME_PROFILE_DIR freezes the launch
 * environment, but connect can point TRUSTY_SQUIRE_PROFILE_DIR at the target
 * agent's profile before broker discovery. Read that override at call time so
 * discovery and custody address the same profile.
 */
export function currentProfileDir(): string {
  const configured = (process.env.TRUSTY_SQUIRE_PROFILE_DIR ?? "").trim();
  return configured.length > 0 ? configured : CHROME_PROFILE_DIR;
}

/** Resolve symlinked ancestors even when the profile directory does not exist yet. */
export function profilePathIdentity(profileDir: string): string {
  const absolute = resolve(profileDir);
  const suffix: string[] = [];
  let candidate = absolute;
  for (;;) {
    try {
      return join(realpathSync.native(candidate), ...suffix.reverse());
    } catch {
      const parent = dirname(candidate);
      if (parent === candidate) return absolute;
      suffix.push(basename(candidate));
      candidate = parent;
    }
  }
}
