import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, renameSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext } from "playwright";
import { seedOperatorIdentityProfile } from "./operator-profile-pool.js";

export type BrowserStorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

export const SESSION_STATE_FILE = "trusty-squire-session-state.json";
export const MAX_SESSION_STATE_BYTES = 4 * 1024 * 1024;
export const GOOGLE_LOGIN_COOKIE_MARKERS = [
  "__Secure-1PSID",
  "SID",
  "HSID",
  "SSID",
  "APISID",
  "SAPISID",
] as const;

export function isSessionStateArtifact(entry: string): boolean {
  return (
    entry === SESSION_STATE_FILE ||
    (entry.startsWith(`${SESSION_STATE_FILE}.`) && entry.endsWith(".tmp"))
  );
}

export function sessionStatePath(profileDir: string): string {
  return join(profileDir, SESSION_STATE_FILE);
}

/** A private Chrome profile for exactly one operate session. */
export function createEphemeralProfile(): string {
  const profileDir = mkdtempSync(join(tmpdir(), "trusty-squire-operate-"));
  chmodSync(profileDir, 0o700);
  return profileDir;
}

export async function destroyEphemeralProfile(profileDir: string): Promise<void> {
  await rm(profileDir, { recursive: true, force: true });
}

/**
 * Bootstrap an ephemeral profile from a legacy canonical Chrome login.
 *
 * Plain-Chrome login intentionally has no Playwright context, so older and
 * newly connected installations may have Google cookies but no portable
 * storageState file. The seed helper copies only identity metadata and the
 * allowlisted Google cookies into this session's private profile; it never
 * opens the shared profile in Chrome and therefore does not restore the old
 * cross-session profile lock.
 */
export function seedEphemeralIdentityFromCanonical(
  canonicalProfileDir: string,
  ephemeralProfileDir: string,
): boolean {
  if (!existsSync(canonicalProfileDir)) return false;
  try {
    return seedOperatorIdentityProfile(canonicalProfileDir, ephemeralProfileDir);
  } catch (error) {
    console.error(
      `[operator] failed to seed canonical login into private profile: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

export function sessionStateHasGoogleIdentity(state: BrowserStorageState | undefined): boolean {
  return (
    state?.cookies.some(
      (cookie) =>
        /(^|\.)google\.com$/i.test(cookie.domain.replace(/^\./, "")) &&
        GOOGLE_LOGIN_COOKIE_MARKERS.includes(
          cookie.name as (typeof GOOGLE_LOGIN_COOKIE_MARKERS)[number],
        ) &&
        cookie.value.length > 10,
    ) === true
  );
}

/**
 * The canonical profile is only login authoring state. Operator sessions never
 * open it; they restore this portable Playwright snapshot into a fresh profile.
 */
export async function readSessionState(
  profileDir: string,
): Promise<BrowserStorageState | undefined> {
  const path = sessionStatePath(profileDir);
  try {
    const serialized = await readFile(path);
    if (serialized.byteLength > MAX_SESSION_STATE_BYTES) {
      console.error(
        `[operator] storageState snapshot exceeds ${MAX_SESSION_STATE_BYTES} bytes; ignoring saved state`,
      );
      return undefined;
    }
    return JSON.parse(serialized.toString("utf8")) as BrowserStorageState;
  } catch {
    return undefined;
  }
}

/** Last completed snapshot wins. Rename keeps concurrent writers from corrupting it. */
export async function writeSessionState(
  profileDir: string,
  state: BrowserStorageState,
  canPublish: () => boolean = () => true,
): Promise<boolean> {
  const serialized = JSON.stringify(state);
  const serializedBytes = Buffer.byteLength(serialized);
  if (serializedBytes > MAX_SESSION_STATE_BYTES) {
    console.error(
      `[operator] storageState snapshot is ${serializedBytes} bytes, exceeding the ${MAX_SESSION_STATE_BYTES}-byte limit; retaining prior snapshot`,
    );
    return false;
  }
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  const destination = sessionStatePath(profileDir);
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  let published = false;
  try {
    await writeFile(temporary, serialized, { mode: 0o600 });
    await chmod(temporary, 0o600);
    if (!canPublish()) return false;
    renameSync(temporary, destination);
    published = true;
    return true;
  } finally {
    if (!published) await rm(temporary, { force: true }).catch(() => undefined);
  }
}
