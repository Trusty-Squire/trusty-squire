import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext } from "playwright";

export type BrowserStorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

export const SESSION_STATE_FILE = "trusty-squire-session-state.json";
export const GOOGLE_LOGIN_COOKIE_MARKERS = [
  "__Secure-1PSID",
  "SID",
  "HSID",
  "SSID",
  "APISID",
  "SAPISID",
] as const;

export function sessionStatePath(profileDir: string): string {
  return join(profileDir, SESSION_STATE_FILE);
}

/** A private Chrome profile for exactly one operate session. */
export function createEphemeralProfile(): string {
  const profileDir = mkdtempSync(join(tmpdir(), "trusty-squire-operate-"));
  chmodSync(profileDir, 0o700);
  return profileDir;
}

export function destroyEphemeralProfile(profileDir: string): void {
  rmSync(profileDir, { recursive: true, force: true });
}

/**
 * The canonical profile is only login authoring state. Operator sessions never
 * open it; they restore this portable Playwright snapshot into a fresh profile.
 */
export function readSessionState(profileDir: string): BrowserStorageState | undefined {
  const path = sessionStatePath(profileDir);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as BrowserStorageState;
  } catch {
    return undefined;
  }
}

/** Last completed snapshot wins. Rename keeps concurrent writers from corrupting it. */
export function writeSessionState(profileDir: string, state: BrowserStorageState): void {
  mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  const destination = sessionStatePath(profileDir);
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, destination);
  chmodSync(destination, 0o600);
}
