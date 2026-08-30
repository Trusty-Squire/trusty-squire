import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, renameSync } from "node:fs";
import { chmod, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext } from "playwright";

export type BrowserStorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

export const SESSION_STATE_FILE = "trusty-squire-session-state.json";
export const CANONICAL_IDENTITY_METADATA_FILE = "trusty-squire-identity.json";
export const PENDING_SESSION_STATE_PREFIX = `${SESSION_STATE_FILE}.pending.`;
const LEGACY_PROVIDER_EMAILS_FILE = "provider-emails.json";
const LOGGED_IN_PROVIDERS_FILE = "logged-in-providers.json";
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

export function hasUsableGoogleIdentity(
  state: BrowserStorageState | undefined,
  nowSeconds = Date.now() / 1_000,
): boolean {
  if (state === undefined) return false;
  return state.cookies.some((cookie) => {
    if (typeof cookie.domain !== "string") return false;
    const host = cookie.domain.replace(/^\./, "");
    return (
      /(^|\.)google\.com$/i.test(host) &&
      GOOGLE_LOGIN_COOKIE_MARKERS.includes(
        cookie.name as (typeof GOOGLE_LOGIN_COOKIE_MARKERS)[number],
      ) &&
      cookie.value.length > 10 &&
      (cookie.expires === undefined || cookie.expires <= 0 || cookie.expires > nowSeconds)
    );
  });
}

export function isSessionStateArtifact(entry: string): boolean {
  return (
    entry === SESSION_STATE_FILE ||
    entry === CANONICAL_IDENTITY_METADATA_FILE ||
    (entry.startsWith(PENDING_SESSION_STATE_PREFIX) && entry.endsWith(".json")) ||
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

export interface CanonicalIdentityState {
  storageState: BrowserStorageState | undefined;
  identityMetadata: CanonicalIdentityMetadata | undefined;
}

export type CanonicalIdentitySnapshotDisposition = "accepted" | "invalid_metadata" | "oversized";

function canonicalIdentityMetadataPath(profileDir: string): string {
  return join(profileDir, CANONICAL_IDENTITY_METADATA_FILE);
}

function legacyProviderEmailsPath(profileDir: string): string {
  return join(profileDir, LEGACY_PROVIDER_EMAILS_FILE);
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
  return (await readCanonicalIdentityState(profileDir)).identityMetadata;
}

async function readLegacyIdentityMetadata(
  profileDir: string,
): Promise<CanonicalIdentityMetadata | undefined> {
  for (const path of [
    canonicalIdentityMetadataPath(profileDir),
    legacyProviderEmailsPath(profileDir),
  ]) {
    try {
      const serialized = await readFile(path);
      if (serialized.byteLength > MAX_IDENTITY_METADATA_BYTES) continue;
      const parsed = JSON.parse(serialized.toString("utf8")) as Record<string, unknown>;
      const email = path.endsWith(LEGACY_PROVIDER_EMAILS_FILE)
        ? parsed.google
        : parsed.googleAccountEmail;
      if (validGoogleAccountEmail(email)) return { googleAccountEmail: email };
    } catch {
      continue;
    }
  }
  return undefined;
}

export async function readCanonicalIdentityState(
  profileDir: string,
): Promise<CanonicalIdentityState> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parsed = await readCanonicalIdentityFile(profileDir);
    if (parsed === undefined) {
      return { storageState: undefined, identityMetadata: undefined };
    }
    if (parsed.kind === "snapshot") {
      return {
        storageState: parsed.value.storageState,
        identityMetadata: parsed.value.identityMetadata,
      };
    }
    const identityMetadata = await readLegacyIdentityMetadata(profileDir);
    const confirmed = await readCanonicalIdentityFile(profileDir);
    if (confirmed?.serialized !== parsed.serialized) continue;
    return {
      storageState: parsed.value,
      identityMetadata,
    };
  }
  return { storageState: undefined, identityMetadata: undefined };
}

async function readCanonicalIdentityFile(
  profileDir: string,
): Promise<
  | { kind: "snapshot"; value: CanonicalIdentitySnapshot; serialized: string }
  | { kind: "legacy"; value: BrowserStorageState; serialized: string }
  | undefined
> {
  try {
    const serialized = await readFile(sessionStatePath(profileDir));
    if (serialized.byteLength > MAX_SESSION_STATE_BYTES) return undefined;
    const text = serialized.toString("utf8");
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (parsed.version === 1 && isBrowserStorageState(parsed.storageState)) {
      const metadata = parsed.identityMetadata;
      if (metadata !== undefined) {
        if (metadata === null || typeof metadata !== "object") return undefined;
        const email = (metadata as Record<string, unknown>).googleAccountEmail;
        if (!validGoogleAccountEmail(email)) return undefined;
        return {
          kind: "snapshot",
          serialized: text,
          value: {
            version: 1,
            storageState: parsed.storageState,
            identityMetadata: { googleAccountEmail: email },
          },
        };
      }
      return {
        kind: "snapshot",
        serialized: text,
        value: { version: 1, storageState: parsed.storageState },
      };
    }
    return isBrowserStorageState(parsed)
      ? { kind: "legacy", value: parsed, serialized: text }
      : undefined;
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
  return (await readCanonicalIdentityState(profileDir)).storageState;
}

function isBrowserStorageState(value: unknown): value is BrowserStorageState {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as { cookies?: unknown; origins?: unknown };
  return Array.isArray(candidate.cookies) && Array.isArray(candidate.origins);
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

export async function invalidateCanonicalGoogleIdentity(
  profileDir: string,
  canPublish: () => boolean = () => true,
): Promise<boolean> {
  const current = await readSessionState(profileDir);
  if (current === undefined) return true;
  return await writeCanonicalIdentitySnapshot(
    profileDir,
    stripGoogleIdentityFromSessionState(current),
    undefined,
    canPublish,
  );
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

export interface PendingSessionState {
  path: string;
  state: BrowserStorageState;
}

export async function writePendingSessionState(
  profileDir: string,
  state: BrowserStorageState,
  canPublish: () => boolean = () => true,
): Promise<string | undefined> {
  const serialized = JSON.stringify(state);
  if (Buffer.byteLength(serialized) > MAX_SESSION_STATE_BYTES) return undefined;
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  const destination = join(
    profileDir,
    `${PENDING_SESSION_STATE_PREFIX}${String(Date.now()).padStart(16, "0")}.${randomUUID()}.json`,
  );
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  let published = false;
  try {
    await writeFile(temporary, serialized, { mode: 0o600 });
    await chmod(temporary, 0o600);
    if (!canPublish()) return undefined;
    renameSync(temporary, destination);
    published = true;
    return destination;
  } finally {
    if (!published) await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function readPendingSessionStates(profileDir: string): Promise<PendingSessionState[]> {
  let entries: string[];
  try {
    entries = await readdir(profileDir);
  } catch {
    return [];
  }
  const pending: PendingSessionState[] = [];
  for (const entry of entries.sort()) {
    if (!entry.startsWith(PENDING_SESSION_STATE_PREFIX) || !entry.endsWith(".json")) continue;
    const path = join(profileDir, entry);
    try {
      const serialized = await readFile(path);
      if (serialized.byteLength > MAX_SESSION_STATE_BYTES) continue;
      const parsed = JSON.parse(serialized.toString("utf8")) as unknown;
      if (isBrowserStorageState(parsed)) pending.push({ path, state: parsed });
    } catch {
      continue;
    }
  }
  return pending;
}

export async function removePendingSessionState(path: string): Promise<void> {
  await rm(path, { force: true });
}

export async function writeCanonicalIdentitySnapshot(
  profileDir: string,
  state: BrowserStorageState,
  metadata: CanonicalIdentityMetadata | undefined,
  canPublish: () => boolean = () => true,
): Promise<boolean> {
  const disposition = canonicalIdentitySnapshotDisposition(state, metadata);
  if (disposition === "invalid_metadata") return false;
  const snapshot: CanonicalIdentitySnapshot = {
    version: 1,
    storageState: state,
    ...(metadata === undefined ? {} : { identityMetadata: metadata }),
  };
  const serialized = JSON.stringify(snapshot);
  const serializedBytes = Buffer.byteLength(serialized);
  if (disposition === "oversized") {
    console.error(
      `[operator] storageState snapshot is ${serializedBytes} bytes, exceeding the ${MAX_SESSION_STATE_BYTES}-byte limit; retaining prior snapshot`,
    );
    return false;
  }
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  const destination = sessionStatePath(profileDir);
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  const markerDestination = join(profileDir, LOGGED_IN_PROVIDERS_FILE);
  let markerTemporary: string | undefined;
  let published = false;
  try {
    await writeFile(temporary, serialized, { mode: 0o600 });
    await chmod(temporary, 0o600);
    if (!hasUsableGoogleIdentity(state)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(markerDestination, "utf8"));
      } catch {
        // A missing/malformed marker already reads as no logged-in providers.
      }
      if (Array.isArray(parsed) && parsed.includes("google")) {
        markerTemporary = `${markerDestination}.${process.pid}.${randomUUID()}.tmp`;
        await writeFile(
          markerTemporary,
          JSON.stringify(parsed.filter((provider) => provider !== "google")),
          { mode: 0o600 },
        );
        await chmod(markerTemporary, 0o600);
      }
    }
    if (!canPublish()) return false;
    // Clear the positive marker first. A crash between these renames can cause
    // a conservative false negative, never the stale-positive inconsistency
    // where an empty portable snapshot still advertises Google as logged in.
    if (markerTemporary !== undefined) {
      renameSync(markerTemporary, markerDestination);
      markerTemporary = undefined;
    }
    renameSync(temporary, destination);
    published = true;
    return true;
  } finally {
    if (!published) await rm(temporary, { force: true }).catch(() => undefined);
    if (markerTemporary !== undefined) {
      await rm(markerTemporary, { force: true }).catch(() => undefined);
    }
  }
}

export function canonicalIdentitySnapshotDisposition(
  state: BrowserStorageState,
  metadata: CanonicalIdentityMetadata | undefined,
): CanonicalIdentitySnapshotDisposition {
  if (
    metadata !== undefined &&
    (!validGoogleAccountEmail(metadata.googleAccountEmail) ||
      Buffer.byteLength(JSON.stringify(metadata)) > MAX_IDENTITY_METADATA_BYTES)
  ) {
    return "invalid_metadata";
  }
  const snapshot: CanonicalIdentitySnapshot = {
    version: 1,
    storageState: state,
    ...(metadata === undefined ? {} : { identityMetadata: metadata }),
  };
  return Buffer.byteLength(JSON.stringify(snapshot)) > MAX_SESSION_STATE_BYTES
    ? "oversized"
    : "accepted";
}
