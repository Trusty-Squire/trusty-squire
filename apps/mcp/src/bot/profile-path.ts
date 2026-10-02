import { mkdirSync, realpathSync, statSync } from "node:fs";
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

/** The dev/ino + name of the profile's membership anchor for locking and
 * socket derivation. The anchor is the canonical parent directory (the deepest
 * existing ancestor), and the profile's own directory name travels as a suffix,
 * so a profile directory that is REPLACED on --force-relogin keeps one
 * identity (its parent inode is untouched) and two paths to one physical
 * profile (bind mount, symlink, HOME override) resolve to one anchor. Returns
 * null when no ancestor exists at all (nothing to stat). */
export interface ProfileDeviceAnchor {
  dev: number;
  ino: number;
  name: string;
}

export function profileDeviceAnchor(profileDir: string): ProfileDeviceAnchor | null {
  const absolute = resolve(profileDir);
  let resolvedProfile: string;
  try {
    resolvedProfile = realpathSync.native(absolute);
  } catch {
    // The profile directory does not exist (fresh machine, or replaced path
    // not yet recreated). Anchor on the nearest existing ancestor, keeping the
    // missing suffix so a name still reads anchor → profile. Callers that
    // provision the parent first (ensureProfileDeviceAnchor) take the main
    // path below and never drift.
    const suffix: string[] = [basename(absolute)];
    let candidate = dirname(absolute);
    for (;;) {
      try {
        const canonical = realpathSync.native(candidate);
        const st = statSync(canonical);
        return { dev: st.dev, ino: st.ino, name: suffix.reverse().join("/") };
      } catch {
        const up = dirname(candidate);
        if (up === candidate) return null;
        suffix.push(basename(candidate));
        candidate = up;
      }
    }
  }
  // The anchor is the canonical PARENT's dev/ino plus the profile directory's
  // own resolved name: symlinked aliases and bind-mounted paths collapse to
  // one anchor, and a --force-relogin REPLACEMENT of the profile directory
  // (a new inode at the same path) keeps this identity because the parent is
  // untouched.
  const parent = dirname(resolvedProfile);
  const st = statSync(parent);
  return { dev: st.dev, ino: st.ino, name: basename(resolvedProfile) };
}

/** Create the parent of the canonical profile path if missing, so the device
 * anchor (parent dev/ino + name) is stable from the very first call. */
export function ensureProfileDeviceAnchor(profileDir: string): void {
  const parent = dirname(profilePathIdentity(profileDir));
  mkdirSync(parent, { recursive: true, mode: 0o700 });
}

/** One stable identity per physical profile: parent dev/ino plus the profile
 * directory's name. After --force-relogin replaces the profile directory this
 * still matches the old identity; two aliases of one directory render the
 * same identity. Falls back to the realpath string when no anchor exists. */
export function profileDeviceIdentity(profileDir: string): string {
  const anchor = profileDeviceAnchor(profileDir);
  return anchor === null
    ? `path:${profilePathIdentity(profileDir)}`
    : `${anchor.dev}:${anchor.ino}:${anchor.name}`;
}
