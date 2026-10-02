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
 * socket derivation. The anchor is the canonical parent directory plus the
 * profile directory's own name, so a profile directory that is REPLACED on
 * --force-relogin keeps one identity (its parent inode is untouched) and two
 * paths to one physical profile (bind mount, symlink, HOME override) resolve
 * to one anchor. The parent is created when missing, because the nearest
 * existing ancestor MOVES once an intermediate directory is created and the
 * identity must not drift between a first reader and a later one. Returns null
 * when no ancestor can be stat'd at all. */
export interface ProfileDeviceAnchor {
  dev: number;
  ino: number;
  name: string;
}

export function profileDeviceAnchor(profileDir: string): ProfileDeviceAnchor | null {
  const absolute = resolve(profileDir);
  // Make the canonical parent exist before reading its dev/ino. The nearest
  // existing ancestor MOVES once an intermediate directory is created, so a
  // caller that derives the identity before the profile's parent exists and a
  // caller that derives it after would disagree — two endpoints for one
  // profile. Best effort: a parent this process cannot create falls back to
  // the nearest existing ancestor below.
  try {
    mkdirSync(dirname(profilePathIdentity(absolute)), { recursive: true, mode: 0o700 });
  } catch {
    /* read-only or inaccessible parent: fall through to the nearest ancestor */
  }
  try {
    // The anchor is the canonical PARENT's dev/ino plus the profile
    // directory's own resolved name: symlinked aliases and bind-mounted paths
    // collapse to one anchor, and a --force-relogin REPLACEMENT of the profile
    // directory (a new inode at the same path) keeps this identity because the
    // parent is untouched.
    const resolvedProfile = realpathSync.native(absolute);
    const parent = dirname(resolvedProfile);
    const st = statSync(parent);
    return { dev: st.dev, ino: st.ino, name: basename(resolvedProfile) };
  } catch {
    // Neither the profile directory nor its newly canonical parent exists.
    // Anchor on the nearest existing ancestor, keeping the missing suffix so a
    // name still reads anchor → profile.
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
