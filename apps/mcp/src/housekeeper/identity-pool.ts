// identity-pool.ts — the verify-fleet identity pool + usage notebook.
//
// The verify redesign (docs: DESIGN identity pool): verify replays a FRESH-signup
// recipe, but the one operator account is a RETURNING user → the recipe diverges.
// The fix is a small fleet of fresh Google identities (Cloud Identity Free robots
// verify-01..NN@trustysquire.ai). Each is a distinct browser profile (its own
// logged-in session) + its own egress; the housekeeper picks UNSPENT identities
// for a service, fresh-signs-up through each, and promotes on 2-of-N agreement.
//
// "Spent" is one-shot per (identity, service): once a robot signs up at Sentry,
// it's a returning user there forever, so it's never reused for that service. The
// usage notebook records those pairs so the picker never hands one back.
//
// This module is intentionally just the pool model + notebook; the fresh-verify
// orchestration (launch N, compare outcomes) and the registry 2-of-N gate are
// separate. NO containers — a profile + a per-launch proxy give the isolation.

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  renameSync,
  rmdirSync,
  readdirSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export type IdentityProvider = "google" | "github";

export interface VerifyIdentity {
  id: string; // stable short id, e.g. "verify-01"
  email: string;
  profileDir: string; // the Chrome profile holding this robot's logged-in session
  providers: ReadonlyArray<IdentityProvider>;
  proxyUrl?: string; // per-identity egress; omitted → env-global proxy
}

export interface UsageRecord {
  identityId: string;
  service: string;
  at: string; // ISO timestamp, stamped by the caller
}

export interface IdentityLeaseRecord {
  identityId: string;
  service: string;
  runId: string;
  pid: number;
  startedAt: string;
  expiresAt: string;
}

interface PoolFile {
  identities: VerifyIdentity[];
}

interface UsageFile {
  spent: UsageRecord[];
}

interface LeaseFile {
  leases: IdentityLeaseRecord[];
}

// Base dir is overridable for tests + alternate operator homes.
function baseDir(): string {
  return process.env.TRUSTY_SQUIRE_VERIFY_POOL_DIR ?? join(homedir(), ".trusty-squire");
}
function poolPath(): string {
  return join(baseDir(), "verify-identities.json");
}
function usagePath(): string {
  return join(baseDir(), "identity-usage.json");
}
function usageLockPath(): string {
  return join(baseDir(), "identity-usage.lock");
}
function leasePath(): string {
  return join(baseDir(), "identity-leases.json");
}

// Expand a leading ~ in a configured profile path so the operator can write
// "~/.trusty-squire/profiles/verify-01" in the config.
function expandHome(p: string): string {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback; // missing / unparseable → empty
  }
}

function withUsageLock<T>(fn: () => T): T {
  const lockPath = usageLockPath();
  mkdirSync(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + 10_000;
  while (true) {
    try {
      mkdirSync(lockPath);
      break;
    } catch (err) {
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for identity usage lock at ${lockPath}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try {
    return fn();
  } finally {
    rmdirSync(lockPath);
  }
}

// ── Pure selection logic (the testable core) ───────────────────────

// The identities supporting `provider` that have NOT been spent at `service`,
// capped at `n`. Deterministic order (config order) so a re-run picks the same
// next-up identities until they're spent.
export function pickUnspentIdentities(
  identities: readonly VerifyIdentity[],
  usage: readonly UsageRecord[],
  service: string,
  provider: IdentityProvider,
  n: number,
): VerifyIdentity[] {
  const spent = new Set(
    usage.filter((u) => u.service === service).map((u) => u.identityId),
  );
  return identities
    .filter((i) => i.providers.includes(provider) && !spent.has(i.id))
    .slice(0, Math.max(0, n));
}

export function isSpent(
  usage: readonly UsageRecord[],
  identityId: string,
  service: string,
): boolean {
  return usage.some((u) => u.identityId === identityId && u.service === service);
}

// ── In-flight claim registry (CONCURRENT discover, HOUSEKEEPER_CONCURRENCY>1) ──
//
// pick→recordSpent is NOT atomic: a slot reads the usage notebook, picks the
// first-unspent robot, runs the signup for ~minutes, THEN writes spent. Two
// concurrent slots would therefore pick the SAME first-unspent robot and OAuth
// as one Google account simultaneously (a self-inflicted collision — and the
// account-sharing fails one of them). This module-level Set reserves a robot
// the instant it's picked and releases it when the run finishes, so concurrent
// slots always take DISTINCT robots. In-process only (the worker runs N
// runDiscover() in ONE process); single-threaded JS makes claim()'s check+add
// atomic between awaits, which is exactly the guarantee we need.
const inFlightClaims = new Set<string>();
export function claimIdentity(id: string): boolean {
  if (inFlightClaims.has(id)) return false;
  inFlightClaims.add(id);
  return true;
}
export type IdentityLease =
  | { ok: true; identityId: string }
  | { ok: false; reason: "already_claimed"; identityId: string };

export function acquireIdentityLease(id: string): IdentityLease {
  return claimIdentity(id)
    ? { ok: true, identityId: id }
    : { ok: false, reason: "already_claimed", identityId: id };
}
export function releaseIdentity(id: string): void {
  inFlightClaims.delete(id);
}
export function isIdentityClaimed(id: string): boolean {
  return inFlightClaims.has(id);
}

function processIsAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function activeLeases(now = Date.now()): IdentityLeaseRecord[] {
  return (readJson<LeaseFile>(leasePath(), { leases: [] }).leases ?? []).filter((lease) => {
    const expiresAt = Date.parse(lease.expiresAt);
    return Number.isFinite(expiresAt) && expiresAt > now && processIsAlive(lease.pid);
  });
}

function writeLeases(leases: readonly IdentityLeaseRecord[]): void {
  const path = leasePath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ leases }, null, 2)}\n`);
  renameSync(tmp, path);
}

export function reserveIdentityForService(input: {
  service: string;
  provider: IdentityProvider;
  runId: string;
  excludeIdentityIds?: readonly string[];
  ttlMs?: number;
}): VerifyIdentity | null {
  return withUsageLock(() => {
    const now = Date.now();
    const identities = loadIdentities();
    const usage = loadUsage();
    const leases = activeLeases(now);
    const excluded = new Set(input.excludeIdentityIds ?? []);
    const leased = new Set(leases.map((lease) => lease.identityId));
    const picked = pickUnspentIdentities(
      identities,
      usage,
      input.service,
      input.provider,
      identities.length,
    ).find((identity) => !excluded.has(identity.id) && !leased.has(identity.id));
    if (picked === undefined) {
      writeLeases(leases);
      return null;
    }
    const startedAt = new Date(now).toISOString();
    const expiresAt = new Date(now + (input.ttlMs ?? 15 * 60 * 1000)).toISOString();
    writeLeases([
      ...leases,
      {
        identityId: picked.id,
        service: input.service,
        runId: input.runId,
        pid: process.pid,
        startedAt,
        expiresAt,
      },
    ]);
    return picked;
  });
}

export function releaseIdentityLease(runId: string): void {
  withUsageLock(() => {
    writeLeases(activeLeases().filter((lease) => lease.runId !== runId));
  });
}

// How many fresh (identity, service) verifications remain possible for a service
// at the given agreement size (e.g. 2-of-N). Lets the scheduler warn before the
// pool is exhausted for a service.
export function remainingFreshVerifications(
  identities: readonly VerifyIdentity[],
  usage: readonly UsageRecord[],
  service: string,
  provider: IdentityProvider,
  agreement: number,
): number {
  const avail = pickUnspentIdentities(identities, usage, service, provider, identities.length).length;
  return agreement > 0 ? Math.floor(avail / agreement) : 0;
}

function liveProfileHolders(): Set<string> {
  let out = "";
  try {
    out = execFileSync("ps", ["-eo", "args"], { encoding: "utf8", timeout: 2_000 });
  } catch {
    return new Set();
  }
  const holders = new Set<string>();
  for (const line of out.split("\n")) {
    const match = line.match(/--user-data-dir=([^ ]*\/\.trusty-squire\/profiles\/(verify-[^ ]+))/);
    if (match?.[2] !== undefined) holders.add(match[2]);
  }
  return holders;
}

export interface IdentityAvailability {
  service: string;
  provider: IdentityProvider;
  total: number;
  unspent: number;
  liveProfileHeld: number;
  available: number;
}

export function summarizeIdentityAvailability(
  services: readonly string[],
  provider: IdentityProvider,
): IdentityAvailability[] {
  const identities = loadIdentities().filter((i) => i.providers.includes(provider));
  const usage = loadUsage();
  const held = liveProfileHolders();
  return [...new Set(services)].map((service) => {
    const unspent = pickUnspentIdentities(
      identities,
      usage,
      service,
      provider,
      identities.length,
    );
    const liveProfileHeld = unspent.filter((identity) => held.has(identity.id)).length;
    return {
      service,
      provider,
      total: identities.length,
      unspent: unspent.length,
      liveProfileHeld,
      available: Math.max(0, unspent.length - liveProfileHeld),
    };
  });
}

// ── Notebook I/O (thin) ────────────────────────────────────────────

export function loadIdentities(): VerifyIdentity[] {
  const file = readJson<PoolFile>(poolPath(), { identities: [] });
  return (file.identities ?? []).map((i) => ({ ...i, profileDir: expandHome(i.profileDir) }));
}

export function loadUsage(): UsageRecord[] {
  const dir = baseDir();
  const primary = usagePath();
  const paths = [primary];
  try {
    for (const name of readdirSync(dir)) {
      if (!/^identity-usage\.json\.bak-/.test(name)) continue;
      paths.push(join(dir, name));
    }
  } catch {
    // Missing/unreadable directory falls through to the primary read fallback.
  }

  const byPair = new Map<string, UsageRecord>();
  for (const path of paths) {
    const records = readJson<UsageFile>(path, { spent: [] }).spent ?? [];
    for (const record of records) {
      const key = `${record.identityId}\u0000${record.service}`;
      if (!byPair.has(key)) byPair.set(key, record);
    }
  }
  return [...byPair.values()];
}

// True once the operator has configured a non-empty pool — the housekeeper
// branches to the single-account path otherwise (no behavior change for boxes
// without a fleet).
export function verifyPoolConfigured(): boolean {
  return loadIdentities().length > 0;
}

// Append a spent (identity, service) record. `at` is injected (callers in the
// MCP runtime pass new Date().toISOString(); tests pass a fixed stamp).
export function recordSpent(identityId: string, service: string, at: string): void {
  withUsageLock(() => {
    const usage = loadUsage();
    if (isSpent(usage, identityId, service)) return; // idempotent
    usage.push({ identityId, service, at });
    const path = usagePath();
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ spent: usage }, null, 2)}\n`);
    renameSync(tmp, path);
  });
}

// Exposed so the housekeeper can log where it's reading the fleet from.
export function poolPaths(): { pool: string; usage: string; configured: boolean } {
  return { pool: poolPath(), usage: usagePath(), configured: existsSync(poolPath()) };
}
