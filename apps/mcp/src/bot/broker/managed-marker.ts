// Managed-broker marker: the record a systemd unit installer leaves next to
// the profile so every client knows a managed broker owns it and must never
// spawn a competitor. The read side is strict and fail-closed: any marker file
// present blocks spawning, whether or not it parses.
//
// Contract (documented in docs/browser-broker.md):
//   - The file lives NEXT TO the profile directory (its parent), never inside
//     it, so a --force-relogin profile-directory replacement does not destroy
//     it. Name: .trusty-squire-broker-unit.json
//   - JSON shape (version 1):
//       { "version": 1,
//         "socket": "/abs/path/broker.sock",
//         "profile": { "dev": <number>, "ino": <number>, "name": "chrome-profile" },
//         "accountBinding": "<account id>" | null }
//     `profile` is the same device anchor clients derive (parent dev/ino plus
//     the profile directory name), so a client verifies "same physical
//     profile" by comparing it against its own derived anchor.
//   - The unit installer writes it after the unit starts and removes it on
//     unit uninstall (removeBrokerUnitMarker below specifies that removal).
//     While it exists, clients never spawn; they wait for `socket` (bounded)
//     and return broker_unavailable on timeout. A marker with no socket never
//     reopens spawning.

import { readFileSync } from "node:fs";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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

/** Strict read outcome. `absent` is the ONLY value that permits on-demand
 * launch; `invalid` (present but unreadable/unparseable, or socket-less after
 * all) fails closed exactly like a valid marker. */
export type BrokerMarkerRead =
  | { kind: "absent" }
  | { kind: "invalid" }
  | { kind: "valid"; marker: ManagedBrokerMarker };

/** Marker path: the profile's canonical parent, BESIDE the profile directory,
 * so a replaced profile dir (--force-relogin) does not destroy the marker. */
export function brokerUnitMarkerPath(profileDir: string): string {
  const canonicalProfile = profilePathIdentity(profileDir);
  return join(dirname(canonicalProfile), BROKER_UNIT_MARKER_FILE);
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
  if (binding !== null && (binding as string).length === 0) return null;
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

type MarkerFileRead =
  | { kind: "text"; text: string }
  | { kind: "absent" }
  | { kind: "unreadable" };

function classify(read: MarkerFileRead): BrokerMarkerRead {
  if (read.kind === "absent") return { kind: "absent" };
  if (read.kind === "unreadable") return { kind: "invalid" };
  const marker = parseMarker(read.text);
  return marker === null ? { kind: "invalid" } : { kind: "valid", marker };
}

function readMarkerFile(profileDir: string): MarkerFileRead {
  try {
    return { kind: "text", text: readFileSync(brokerUnitMarkerPath(profileDir), "utf8") };
  } catch (error) {
    // ENOENT is the only "absent"; anything else (EACCES, EIO) fails closed.
    return isMissing(error) ? { kind: "absent" } : { kind: "unreadable" };
  }
}

async function readMarkerFileAsync(profileDir: string): Promise<MarkerFileRead> {
  try {
    return { kind: "text", text: await readFile(brokerUnitMarkerPath(profileDir), "utf8") };
  } catch (error) {
    return isMissing(error) ? { kind: "absent" } : { kind: "unreadable" };
  }
}

/** Strict sync read for hot paths (brokerSocketPath). */
export function readBrokerUnitMarkerSync(profileDir: string): BrokerMarkerRead {
  return classify(readMarkerFile(profileDir));
}

/** Strict async read for the launch gate. */
export async function readBrokerUnitMarkerAsync(profileDir: string): Promise<BrokerMarkerRead> {
  return classify(await readMarkerFileAsync(profileDir));
}

/** Write the marker. Used by the unit installer (Beeline-side) and by tests
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
 * call this so a removed unit restores on-demand launch. */
export async function removeBrokerUnitMarker(profileDir: string): Promise<void> {
  try {
    await unlink(brokerUnitMarkerPath(profileDir));
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}