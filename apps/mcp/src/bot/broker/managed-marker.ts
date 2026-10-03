// Service endpoint markers survive profile-directory replacement. Each physical
// profile has its own marker beside the directory; the default name remains
// compatible with installed systemd units. Clients only read/join, never spawn.
// Version 1 records the wire socket, device anchor, and optional account binding.
// Contract: docs/browser-broker.md.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { profilePathIdentity, type ProfileDeviceAnchor } from "../profile-path.js";

export const BROKER_UNIT_MARKER_FILE = ".trusty-squire-broker-unit.json";
/** The marker version the client side understands. Writers must use it. */
export const BROKER_UNIT_MARKER_VERSION = 1;

export interface ManagedBrokerMarker {
  version: typeof BROKER_UNIT_MARKER_VERSION;
  /** Broker wire socket the unit listens on. */
  socket: string;
  /** Device anchor of the physical profile the unit serves. */
  profile: ProfileDeviceAnchor;
  /** Account id the profile is bound to, or null when unenrolled. */
  accountBinding: string | null;
}

/** Strict read outcome. `invalid` means present but unreadable or
 * unparsable. No read outcome permits a client to launch a broker. */
export type BrokerMarkerRead =
  | { kind: "absent" }
  | { kind: "invalid" }
  | { kind: "valid"; marker: ManagedBrokerMarker };

/** Marker path: the profile's canonical parent, BESIDE the profile directory,
 * so a replaced profile dir (--force-relogin) does not destroy the marker. */
export function brokerUnitMarkerPath(profileDir: string): string {
  const canonicalProfile = profilePathIdentity(profileDir);
  const name = basename(canonicalProfile);
  const markerName =
    name === "chrome-profile"
      ? BROKER_UNIT_MARKER_FILE
      : `.trusty-squire-broker-${createHash("sha256").update(name).digest("hex").slice(0, 16)}-unit.json`;
  return join(dirname(canonicalProfile), markerName);
}

function isAnchor(value: unknown): value is ProfileDeviceAnchor {
  if (value === null || typeof value !== "object") return false;
  const anchor = value as Record<string, unknown>;
  return (
    typeof anchor.dev === "number" &&
    Number.isSafeInteger(anchor.dev) &&
    typeof anchor.ino === "number" &&
    Number.isSafeInteger(anchor.ino) &&
    typeof anchor.name === "string" &&
    anchor.name.length > 0
  );
}

function parseMarker(text: string): ManagedBrokerMarker | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const marker = parsed as Record<string, unknown>;
  if (marker.version !== BROKER_UNIT_MARKER_VERSION) return null;
  if (typeof marker.socket !== "string" || marker.socket.length === 0) return null;
  if (!isAnchor(marker.profile)) return null;
  const binding = marker.accountBinding;
  if (binding !== null && binding !== undefined && typeof binding !== "string") return null;
  if (typeof binding === "string" && binding.length === 0) return null;
  return {
    version: BROKER_UNIT_MARKER_VERSION,
    socket: marker.socket,
    profile: marker.profile,
    accountBinding: (binding as string | null) ?? null,
  };
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

type MarkerFileRead = { kind: "text"; text: string } | { kind: "absent" } | { kind: "unreadable" };

function classify(read: MarkerFileRead): BrokerMarkerRead {
  if (read.kind === "absent") return { kind: "absent" };
  if (read.kind === "unreadable") return { kind: "invalid" };
  const marker = parseMarker(read.text);
  return marker === null ? { kind: "invalid" } : { kind: "valid", marker };
}

function legacyMarkerPath(profileDir: string): string {
  return join(dirname(profilePathIdentity(profileDir)), BROKER_UNIT_MARKER_FILE);
}

function acceptLegacy(text: string, profileDir: string): MarkerFileRead {
  const marker = parseMarker(text);
  if (marker !== null && marker.profile.name !== basename(profilePathIdentity(profileDir)))
    return { kind: "absent" };
  return { kind: "text", text };
}

function readMarkerFile(profileDir: string): MarkerFileRead {
  try {
    return { kind: "text", text: readFileSync(brokerUnitMarkerPath(profileDir), "utf8") };
  } catch (error) {
    // ENOENT is the only "absent"; anything else (EACCES, EIO) fails closed.
    if (!isMissing(error)) return { kind: "unreadable" };
    if (brokerUnitMarkerPath(profileDir) === legacyMarkerPath(profileDir))
      return { kind: "absent" };
    try {
      return acceptLegacy(readFileSync(legacyMarkerPath(profileDir), "utf8"), profileDir);
    } catch (legacyError) {
      return isMissing(legacyError) ? { kind: "absent" } : { kind: "unreadable" };
    }
  }
}

async function readMarkerFileAsync(profileDir: string): Promise<MarkerFileRead> {
  try {
    return { kind: "text", text: await readFile(brokerUnitMarkerPath(profileDir), "utf8") };
  } catch (error) {
    return isMissing(error) ? readMarkerFile(profileDir) : { kind: "unreadable" };
  }
}

/** Strict sync read for hot paths (brokerSocketPath). */
export function readBrokerUnitMarkerSync(profileDir: string): BrokerMarkerRead {
  return classify(readMarkerFile(profileDir));
}

/** Strict async read for connection discovery. */
export async function readBrokerUnitMarkerAsync(profileDir: string): Promise<BrokerMarkerRead> {
  return classify(await readMarkerFileAsync(profileDir));
}

/** Write the marker. Used by the service installer and by tests
 * that must prove the client honors a conforming marker. */
export async function writeBrokerUnitMarker(
  profileDir: string,
  marker: ManagedBrokerMarker,
): Promise<void> {
  await writeFile(brokerUnitMarkerPath(profileDir), JSON.stringify(marker, null, 2) + "\n", {
    mode: 0o600,
  });
}

/** Remove the marker. Specified in the contract: the unit uninstaller MUST
 * call this to remove stale endpoint routing; clients remain connection-only. */
export async function removeBrokerUnitMarker(profileDir: string): Promise<void> {
  try {
    await unlink(brokerUnitMarkerPath(profileDir));
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}
