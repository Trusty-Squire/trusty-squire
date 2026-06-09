// Persistent attempt counter for the single escalation condition: an `unknown`
// provision state is retried up to UNKNOWN_ESCALATION_THRESHOLD times on the
// SAME (service, state-signature) before the loop emits its ONE human-facing
// ping. The count must survive across heal passes (which are ~12h apart), so it
// lives in a small JSON file, not in-memory.
//
// Keyed by `${service}:${signature}` so a different novel DOM state on the same
// service is its own fresh count. Best-effort + non-throwing: a read/write
// failure degrades to count=1 (escalates later rather than never), never blocks
// the loop.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

interface UnknownEntry {
  count: number;
  first_seen: string; // ISO; set by the caller (no Date in pure modules, fine here)
  last_url?: string;
  escalated: boolean;
}

type Store = Record<string, UnknownEntry>;

function storePath(): string {
  const configHome =
    process.env.XDG_CONFIG_HOME !== undefined && process.env.XDG_CONFIG_HOME !== ""
      ? process.env.XDG_CONFIG_HOME
      : join(homedir(), ".config");
  // Override hook for tests / alternate installs.
  return (
    process.env.TRUSTY_SQUIRE_UNKNOWN_STATE_FILE ??
    join(configHome, "trusty-squire", "unknown-states.json")
  );
}

function read(path: string): Store {
  try {
    if (!existsSync(path)) return {};
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed !== null && typeof parsed === "object" ? (parsed as Store) : {};
  } catch {
    return {};
  }
}

function write(path: string, store: Store): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(store, null, 2), "utf8");
  } catch {
    // best-effort — a write failure just means the next pass re-counts from disk
  }
}

export interface RecordUnknownInput {
  service: string;
  signature: string;
  url?: string;
  now: string; // ISO timestamp from the caller
}

export interface RecordUnknownResult {
  attempts: number;
  alreadyEscalated: boolean; // true if a prior pass already pinged for this key
}

// Record one observation of an unknown state. Returns the running attempt count
// for the (service, signature) and whether it was escalated before. The caller
// consults shouldEscalate(attempts) and, on a fresh escalation, calls
// markEscalated() so we never re-ping the same novel state.
export function recordUnknownState(input: RecordUnknownInput): RecordUnknownResult {
  const path = storePath();
  const store = read(path);
  const key = `${input.service}:${input.signature}`;
  const prev = store[key];
  const entry: UnknownEntry = prev ?? {
    count: 0,
    first_seen: input.now,
    escalated: false,
  };
  entry.count += 1;
  if (input.url !== undefined) entry.last_url = input.url;
  store[key] = entry;
  write(path, store);
  return { attempts: entry.count, alreadyEscalated: entry.escalated };
}

// Mark a (service, signature) as escalated so it never pings again. Call this
// only after the notifier fan-out succeeds-or-is-attempted.
export function markEscalated(service: string, signature: string): void {
  const path = storePath();
  const store = read(path);
  const key = `${service}:${signature}`;
  const entry = store[key];
  if (entry !== undefined) {
    entry.escalated = true;
    store[key] = entry;
    write(path, store);
  }
}
