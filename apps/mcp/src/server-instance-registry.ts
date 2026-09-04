// Self-clean stale prior `mcp server` instances at startup.
//
// A host agent relaunches `mcp server` on every reconnect but does not
// reliably terminate the instance it superseded. A live box carried a
// superseded claude-code server sitting beside its replacement, plus two
// codex-identity servers orphaned to init for ~31 hours — each keeping a
// browser/reaper child tree resident. The owner-process reaper next door
// only reaps a dead owner's CHILDREN; nothing reaped a wedged owner itself.
// This registry does.
//
// The gate is deliberately narrow, because one shared box legitimately runs
// many concurrent servers — including several of the SAME agent identity,
// one per project/lane. So there is no name-based or blanket kill anywhere
// here. A prior instance is a candidate only when all of these hold:
//   * its recorded agent identity EXACTLY matches ours (and ours is set),
//   * it is not us, and its birth identity still names a live process,
//   * and it is either orphaned — its spawning host is gone, i.e. PPid
//     collapsed to init when the instance did not start that way — past a
//     short grace, or quiet past the very bound it should have self-exited
//     on (server.ts's idle backstop, mirrored here).
// A non-orphan is therefore only reaped after it already failed its own
// exit policy, and an instance still serving a client is never a candidate.

import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { sweepOrphanedOwnerProcesses } from "./bot/owner-process-reaper.js";
import {
  processBirthIdentity,
  processBirthIdentityState,
  type ProcessIdentityState,
} from "./bot/profile.js";
import { VERSION } from "./version.js";

// Idle self-exit bounds. transport.onclose / stdin EOF / SIGTERM already exit
// the process on a well-behaved disconnect; these bound the case a live box
// surfaced instead — a host that spawns a *new* server on reconnect without
// ever closing the old child's stdio or signaling it. They live here rather
// than in server.ts because the startup reaper enforces the same policy from
// the outside for an instance that failed to enforce it on itself.
const DEFAULT_IDLE_TIMEOUT_MS = 20 * 60 * 1_000; // 20m, no open session
const DEFAULT_IDLE_TIMEOUT_WITH_SESSION_MS = 12 * 60 * 60 * 1_000; // 12h, session open
const DEFAULT_IDLE_CHECK_INTERVAL_MS = 5 * 60 * 1_000; // 5m — must stay well under the 20m bound
// An orphan's stdio peer is gone, so a well-behaved instance exits within
// milliseconds. Still alive and quiet this long past that means wedged.
const DEFAULT_ORPHAN_GRACE_MS = 60 * 1_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30 * 1_000;
const DEFAULT_REAP_GRACE_MS = 2_000;

function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function idleTimeoutMs(): number {
  return envMs("TRUSTY_SQUIRE_SERVER_IDLE_TIMEOUT_MS", DEFAULT_IDLE_TIMEOUT_MS);
}

export function idleTimeoutWithSessionMs(): number {
  return envMs(
    "TRUSTY_SQUIRE_SERVER_IDLE_TIMEOUT_WITH_SESSION_MS",
    DEFAULT_IDLE_TIMEOUT_WITH_SESSION_MS,
  );
}

export function idleCheckIntervalMs(): number {
  return envMs("TRUSTY_SQUIRE_SERVER_IDLE_CHECK_INTERVAL_MS", DEFAULT_IDLE_CHECK_INTERVAL_MS);
}

export function heartbeatIntervalMs(): number {
  return envMs("TRUSTY_SQUIRE_SERVER_HEARTBEAT_INTERVAL_MS", DEFAULT_HEARTBEAT_INTERVAL_MS);
}

export interface ServerBirthIdentity {
  pid: number;
  start_time: string;
}

/** The activity a live instance publishes so a later launch can judge it. */
export interface ServerInstanceActivity {
  lastActivityAt: number;
  activeSessions: number;
  inFlightCalls: number;
}

export interface ServerInstanceRecord extends ServerBirthIdentity {
  version: 1;
  agent_identity: string;
  /** PPid at registration, so a host that IS init isn't read as an orphan. */
  parent_pid: number;
  started_at: number;
  /** Last heartbeat write — proves the instance's event loop still runs. */
  heartbeat_at: number;
  /** Last inbound client message — proves a client is still talking to it. */
  last_activity_at: number;
  active_sessions: number;
  in_flight_calls: number;
  server_version: string;
}

export interface ServerReapBounds {
  orphanGraceMs: number;
  idleMs: number;
  idleWithSessionMs: number;
  /** Slack past an idle bound before the instance counts as having missed it. */
  idleSlackMs: number;
  graceMs: number;
}

export function serverReapBounds(): ServerReapBounds {
  return {
    orphanGraceMs: envMs("TRUSTY_SQUIRE_SERVER_REAP_ORPHAN_GRACE_MS", DEFAULT_ORPHAN_GRACE_MS),
    idleMs: idleTimeoutMs(),
    idleWithSessionMs: idleTimeoutWithSessionMs(),
    idleSlackMs: idleCheckIntervalMs(),
    graceMs: envMs("TRUSTY_SQUIRE_SERVER_REAP_GRACE_MS", DEFAULT_REAP_GRACE_MS),
  };
}

function serverInstanceRootDir(): string {
  const configured = (process.env.TRUSTY_SQUIRE_SERVER_INSTANCE_DIR ?? "").trim();
  return configured.length > 0
    ? resolve(configured)
    : join(homedir(), ".trusty-squire", "server-instances");
}

function agentIdentity(): string {
  return (process.env.TRUSTY_SQUIRE_AGENT_IDENTITY ?? "").trim();
}

function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function isServerInstanceRecord(value: unknown): value is ServerInstanceRecord {
  if (value === null || typeof value !== "object") return false;
  const record = value as Partial<ServerInstanceRecord>;
  const numbers: ReadonlyArray<number | undefined> = [
    record.pid,
    record.parent_pid,
    record.started_at,
    record.heartbeat_at,
    record.last_activity_at,
    record.active_sessions,
    record.in_flight_calls,
  ];
  return (
    record.version === 1 &&
    typeof record.agent_identity === "string" &&
    typeof record.start_time === "string" &&
    typeof record.server_version === "string" &&
    numbers.every((entry) => Number.isSafeInteger(entry)) &&
    (record.pid ?? 0) > 0
  );
}

export function readServerInstanceRecord(path: string): ServerInstanceRecord | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isServerInstanceRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeServerInstanceRecord(path: string, record: ServerInstanceRecord): void {
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export type ParentPidRead = number | "stale" | "unknown";

/** PPid is field 4 of /proc/<pid>/stat — index 1 after the comm close-paren. */
function linuxParentPid(pid: number): ParentPidRead {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const closeParen = stat.lastIndexOf(")");
    if (closeParen < 0) return "unknown";
    const parent = Number(
      stat
        .slice(closeParen + 2)
        .trim()
        .split(/\s+/)[1],
    );
    return Number.isSafeInteger(parent) && parent >= 0 ? parent : "unknown";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ESRCH" ? "stale" : "unknown";
  }
}

function linuxProcessIds(): number[] {
  try {
    return readdirSync("/proc")
      .filter((entry) => /^\d+$/.test(entry))
      .map(Number);
  } catch {
    return [];
  }
}

/**
 * Descendants by PPid chain — never by process group. A stdio server shares
 * its parent's process group, so `kill(-pgid)` would take the host agent
 * down with it.
 */
export function processDescendantIdentities(
  pid: number,
  readers: {
    readProcessIds?: () => number[];
    readParentPid?: (pid: number) => ParentPidRead;
    readBirthIdentity?: (pid: number) => ServerBirthIdentity | null;
  } = {},
): ServerBirthIdentity[] {
  const readProcessIds = readers.readProcessIds ?? linuxProcessIds;
  const readParentPid = readers.readParentPid ?? linuxParentPid;
  const readBirthIdentity = readers.readBirthIdentity ?? processBirthIdentity;
  const children = new Map<number, number[]>();
  for (const candidate of readProcessIds()) {
    if (candidate === pid) continue;
    const parent = readParentPid(candidate);
    if (typeof parent !== "number") continue;
    const siblings = children.get(parent);
    if (siblings === undefined) children.set(parent, [candidate]);
    else siblings.push(candidate);
  }
  const seen = new Set<number>([pid]);
  const descendants: ServerBirthIdentity[] = [];
  const queue = [pid];
  while (queue.length > 0) {
    for (const child of children.get(queue.shift()!) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      queue.push(child);
      const identity = readBirthIdentity(child);
      if (identity !== null) descendants.push(identity);
    }
  }
  return descendants;
}

export type ServerInstanceReapDecision = "keep" | "reap" | "forget";

/**
 * The whole safety contract, as one pure function. `forget` means the record
 * names no live process — delete the file, signal nothing.
 */
export function serverInstanceReapDecision(
  record: ServerInstanceRecord,
  self: { agent_identity: string; pid: number; start_time: string },
  liveness: ProcessIdentityState,
  parentPid: ParentPidRead,
  now: number,
  bounds: ServerReapBounds,
): ServerInstanceReapDecision {
  if (record.pid === self.pid) return "keep";
  // A record naming a process that is already gone is file GC, not a kill —
  // safe for any identity, and the only thing that keeps the directory from
  // growing for an identity that never launches again.
  if (liveness === "stale" || parentPid === "stale") return "forget";
  // Guard rail: identity is the outer fence on SIGNALLING. An unset identity
  // matches nothing, so a host that never set one is never a target.
  if (self.agent_identity.length === 0) return "keep";
  if (record.agent_identity !== self.agent_identity) return "keep";
  // A pid we cannot read is a pid we do not kill.
  if (liveness === "unknown" || parentPid === "unknown") return "keep";

  const quietMs = now - record.last_activity_at;
  // Its spawning host is gone, so no client can still be attached over the
  // stdio pipe it was handed. A host that was ALREADY init at registration
  // (container PID 1) never reads as orphaned.
  const orphaned = record.parent_pid !== 1 && parentPid === 1;
  if (orphaned) return quietMs >= bounds.orphanGraceMs ? "reap" : "keep";

  // Not orphaned: mirror the instance's own idle bound, so we only ever reap
  // one that already blew past the deadline it should have exited on itself.
  // The slack is that bound's poll interval — an instance whose own idle timer
  // is working exits on its next poll, so anything still here past bound +
  // interval demonstrably failed to.
  const busy = record.active_sessions > 0 || record.in_flight_calls > 0;
  const threshold = (busy ? bounds.idleWithSessionMs : bounds.idleMs) + bounds.idleSlackMs;
  return quietMs >= threshold ? "reap" : "keep";
}

export interface ServerInstanceHandle {
  readonly path: string;
  heartbeat(activity: ServerInstanceActivity): void;
  release(): void;
}

/**
 * Publish this instance's heartbeat so a later launch of the same identity can
 * tell "still serving a client" from "wedged". Returns null when there is
 * nothing to publish (non-Linux, no agent identity, unreadable birth identity).
 */
export function registerServerInstance(
  options: { rootDir?: string; identity?: string; now?: () => number } = {},
): ServerInstanceHandle | null {
  if (process.platform !== "linux") return null;
  const identity = options.identity ?? agentIdentity();
  if (identity.length === 0) return null;
  const birth = processBirthIdentity(process.pid);
  if (birth === null) return null;
  const parent = linuxParentPid(process.pid);
  const now = options.now ?? Date.now;
  const rootDir = resolve(options.rootDir ?? serverInstanceRootDir());
  const startedAt = now();
  let record: ServerInstanceRecord = {
    version: 1,
    agent_identity: identity,
    pid: birth.pid,
    start_time: birth.start_time,
    parent_pid: typeof parent === "number" ? parent : 0,
    started_at: startedAt,
    heartbeat_at: startedAt,
    last_activity_at: startedAt,
    active_sessions: 0,
    in_flight_calls: 0,
    server_version: VERSION,
  };
  const path = join(rootDir, `${birth.pid}-${randomUUID()}.json`);
  try {
    ensurePrivateDir(rootDir);
    writeServerInstanceRecord(path, record);
  } catch {
    return null;
  }
  let released = false;
  return {
    path,
    heartbeat: (activity) => {
      if (released) return;
      record = {
        ...record,
        heartbeat_at: now(),
        last_activity_at: activity.lastActivityAt,
        active_sessions: activity.activeSessions,
        in_flight_calls: activity.inFlightCalls,
      };
      try {
        writeServerInstanceRecord(path, record);
      } catch {
        // A heartbeat that cannot be written only costs this instance its
        // protection from a later launch; it must never break serving.
      }
    },
    release: () => {
      released = true;
      rmSync(path, { force: true });
    },
  };
}

export interface ServerInstanceReapSummary {
  reaped: number;
  forgotten: number;
  kept: number;
  signalled: number[];
}

export interface ServerInstanceReapRuntime {
  rootDir?: string;
  self?: { agent_identity: string; pid: number; start_time: string };
  bounds?: ServerReapBounds;
  now?: () => number;
  readBirthState?: (identity: ServerBirthIdentity) => ProcessIdentityState;
  readParentPid?: (pid: number) => ParentPidRead;
  readDescendants?: (pid: number) => ServerBirthIdentity[];
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  wait?: (ms: number) => Promise<void>;
  sweep?: () => Promise<number>;
}

async function terminateServerInstanceTree(
  record: ServerInstanceRecord,
  bounds: ServerReapBounds,
  runtime: ServerInstanceReapRuntime,
): Promise<number[]> {
  const readBirthState = runtime.readBirthState ?? processBirthIdentityState;
  const readDescendants =
    runtime.readDescendants ?? ((pid: number) => processDescendantIdentities(pid));
  const kill = runtime.kill ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
  const wait =
    runtime.wait ??
    (async (ms: number) => await new Promise<void>((done) => setTimeout(done, ms).unref()));

  // Snapshot the tree BEFORE signalling: once the owner dies its children are
  // re-parented to init and the PPid chain that identifies them is gone. Each
  // entry carries a birth identity so a pid recycled during the grace window
  // is not escalated to SIGKILL by mistake.
  const tree: ServerBirthIdentity[] = [
    { pid: record.pid, start_time: record.start_time },
    ...readDescendants(record.pid).filter((entry) => entry.pid !== process.pid),
  ];
  const signalled: number[] = [];
  const signal = (signalName: NodeJS.Signals): ServerBirthIdentity[] => {
    const alive: ServerBirthIdentity[] = [];
    for (const identity of tree) {
      if (readBirthState(identity) !== "matching") continue;
      alive.push(identity);
      try {
        kill(identity.pid, signalName);
        if (!signalled.includes(identity.pid)) signalled.push(identity.pid);
      } catch {}
    }
    return alive;
  };

  signal("SIGTERM");
  await wait(bounds.graceMs);
  if (signal("SIGKILL").length > 0) await wait(bounds.graceMs);
  return signalled;
}

/**
 * Reap stale prior instances of OUR agent identity. Never throws: a startup
 * housekeeping pass must not be able to stop the server from serving.
 */
export async function reapStaleServerInstances(
  runtime: ServerInstanceReapRuntime = {},
): Promise<ServerInstanceReapSummary> {
  const summary: ServerInstanceReapSummary = { reaped: 0, forgotten: 0, kept: 0, signalled: [] };
  if (process.platform !== "linux" && runtime.self === undefined) return summary;
  const birth = processBirthIdentity(process.pid);
  const self = runtime.self ?? {
    agent_identity: agentIdentity(),
    pid: process.pid,
    start_time: birth?.start_time ?? "unknown",
  };
  if (self.agent_identity.length === 0) return summary;
  const rootDir = resolve(runtime.rootDir ?? serverInstanceRootDir());
  const bounds = runtime.bounds ?? serverReapBounds();
  const now = (runtime.now ?? Date.now)();
  const readBirthState = runtime.readBirthState ?? processBirthIdentityState;
  const readParentPid = runtime.readParentPid ?? linuxParentPid;

  let entries: string[];
  try {
    entries = readdirSync(rootDir).filter((entry) => entry.endsWith(".json"));
  } catch {
    return summary;
  }
  for (const entry of entries) {
    const path = join(rootDir, entry);
    const record = readServerInstanceRecord(path);
    if (record === null) continue;
    const decision = serverInstanceReapDecision(
      record,
      self,
      readBirthState(record),
      readParentPid(record.pid),
      now,
      bounds,
    );
    if (decision === "keep") {
      summary.kept += 1;
      continue;
    }
    if (decision === "forget") {
      summary.forgotten += 1;
      rmSync(path, { force: true });
      continue;
    }
    try {
      summary.signalled.push(...(await terminateServerInstanceTree(record, bounds, runtime)));
    } catch {
      continue;
    }
    summary.reaped += 1;
    if (readBirthState(record) === "stale") rmSync(path, { force: true });
    process.stderr.write(
      `[trusty-squire] reaped stale prior server pid=${record.pid} ` +
        `identity=${record.agent_identity} v${record.server_version}\n`,
    );
  }
  if (summary.reaped > 0) {
    // Their owner-reaper manifests now name a dead owner, so the existing
    // sweep collects any browser the tree walk missed (already re-parented
    // to init before the snapshot).
    await (runtime.sweep ?? sweepOrphanedOwnerProcesses)().catch(() => 0);
  }
  return summary;
}
