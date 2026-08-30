import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, renameSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext } from "playwright";

export type BrowserStorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

export const SESSION_STATE_FILE = "trusty-squire-session-state.json";
export const CANONICAL_IDENTITY_METADATA_FILE = "trusty-squire-identity.json";
export const MAX_SESSION_STATE_BYTES = 4 * 1024 * 1024;
const MAX_IDENTITY_METADATA_BYTES = 4 * 1024;
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
    entry === CANONICAL_IDENTITY_METADATA_FILE ||
    ((entry.startsWith(`${SESSION_STATE_FILE}.`) ||
      entry.startsWith(`${CANONICAL_IDENTITY_METADATA_FILE}.`)) &&
      entry.endsWith(".tmp"))
  );
}

export function sessionStatePath(profileDir: string): string {
  return join(profileDir, SESSION_STATE_FILE);
}

export interface CanonicalIdentityMetadata {
  googleAccountEmail: string;
}

interface CanonicalIdentitySnapshot {
  version: 1;
  storageState: BrowserStorageState;
  identityMetadata?: CanonicalIdentityMetadata;
}

function canonicalIdentityMetadataPath(profileDir: string): string {
  return join(profileDir, CANONICAL_IDENTITY_METADATA_FILE);
}

function validGoogleAccountEmail(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 320 &&
    /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(value)
  );
}

export async function readCanonicalIdentityMetadata(
  profileDir: string,
): Promise<CanonicalIdentityMetadata | undefined> {
  const snapshot = await readCanonicalIdentitySnapshot(profileDir);
  if (snapshot?.identityMetadata !== undefined) return snapshot.identityMetadata;
  if (snapshot !== undefined) return undefined;
  try {
    const serialized = await readFile(canonicalIdentityMetadataPath(profileDir));
    if (serialized.byteLength > MAX_IDENTITY_METADATA_BYTES) return undefined;
    const parsed = JSON.parse(serialized.toString("utf8")) as Record<string, unknown>;
    if (!validGoogleAccountEmail(parsed.googleAccountEmail)) return undefined;
    return { googleAccountEmail: parsed.googleAccountEmail };
  } catch {
    return undefined;
  }
}

export async function writeCanonicalIdentityMetadata(
  profileDir: string,
  metadata: CanonicalIdentityMetadata,
  canPublish: () => boolean = () => true,
): Promise<boolean> {
  const state = await readSessionState(profileDir);
  if (state === undefined) return false;
  return await writeCanonicalIdentitySnapshot(profileDir, state, metadata, canPublish);
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
 * The canonical profile is only login authoring state. Operator sessions never
 * open it; they restore this portable Playwright snapshot into a fresh profile.
 */
export async function readSessionState(
  profileDir: string,
): Promise<BrowserStorageState | undefined> {
  const snapshot = await readCanonicalIdentitySnapshot(profileDir);
  if (snapshot !== undefined) return snapshot.storageState;
  const path = sessionStatePath(profileDir);
  try {
    const serialized = await readFile(path);
    if (serialized.byteLength > MAX_SESSION_STATE_BYTES) {
      console.error(
        `[operator] storageState snapshot exceeds ${MAX_SESSION_STATE_BYTES} bytes; ignoring saved state`,
      );
      return undefined;
    }
    const parsed = JSON.parse(serialized.toString("utf8")) as BrowserStorageState;
    return isBrowserStorageState(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isBrowserStorageState(value: unknown): value is BrowserStorageState {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as { cookies?: unknown; origins?: unknown };
  return Array.isArray(candidate.cookies) && Array.isArray(candidate.origins);
}

async function readCanonicalIdentitySnapshot(
  profileDir: string,
): Promise<CanonicalIdentitySnapshot | undefined> {
  try {
    const serialized = await readFile(sessionStatePath(profileDir));
    if (serialized.byteLength > MAX_SESSION_STATE_BYTES) return undefined;
    const parsed = JSON.parse(serialized.toString("utf8")) as Record<string, unknown>;
    if (parsed.version !== 1 || !isBrowserStorageState(parsed.storageState)) return undefined;
    const metadata = parsed.identityMetadata;
    if (metadata !== undefined) {
      if (metadata === null || typeof metadata !== "object") return undefined;
      const email = (metadata as Record<string, unknown>).googleAccountEmail;
      if (!validGoogleAccountEmail(email)) return undefined;
      return {
        version: 1,
        storageState: parsed.storageState,
        identityMetadata: { googleAccountEmail: email },
      };
    }
    return { version: 1, storageState: parsed.storageState };
  } catch {
    return undefined;
  }
}

export function stripGoogleIdentityFromSessionState(
  state: BrowserStorageState,
): BrowserStorageState {
  const isGoogleHost = (host: unknown): boolean =>
    typeof host === "string" && /(^|\.)google\.com$/i.test(host.replace(/^\./, ""));
  return {
    ...state,
    cookies: state.cookies.filter((cookie) => !isGoogleHost(cookie.domain)),
    origins: state.origins.filter((origin) => {
      try {
        return !isGoogleHost(new URL(origin.origin).hostname);
      } catch {
        return true;
      }
    }),
  };
}

/** Last completed snapshot wins. Rename keeps concurrent writers from corrupting it. */
export async function writeSessionState(
  profileDir: string,
  state: BrowserStorageState,
  canPublish: () => boolean = () => true,
): Promise<boolean> {
  const metadata = await readCanonicalIdentityMetadata(profileDir);
  return await writeCanonicalIdentitySnapshot(profileDir, state, metadata, canPublish);
}

export async function writeCanonicalIdentitySnapshot(
  profileDir: string,
  state: BrowserStorageState,
  metadata: CanonicalIdentityMetadata | undefined,
  canPublish: () => boolean = () => true,
): Promise<boolean> {
  if (
    metadata !== undefined &&
    (!validGoogleAccountEmail(metadata.googleAccountEmail) ||
      Buffer.byteLength(JSON.stringify(metadata)) > MAX_IDENTITY_METADATA_BYTES)
  ) {
    return false;
  }
  const snapshot: CanonicalIdentitySnapshot = {
    version: 1,
    storageState: state,
    ...(metadata === undefined ? {} : { identityMetadata: metadata }),
  };
  const serialized = JSON.stringify(snapshot);
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
