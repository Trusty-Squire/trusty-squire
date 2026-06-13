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

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
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

interface PoolFile {
  identities: VerifyIdentity[];
}

interface UsageFile {
  spent: UsageRecord[];
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

// ── Notebook I/O (thin) ────────────────────────────────────────────

export function loadIdentities(): VerifyIdentity[] {
  const file = readJson<PoolFile>(poolPath(), { identities: [] });
  return (file.identities ?? []).map((i) => ({ ...i, profileDir: expandHome(i.profileDir) }));
}

export function loadUsage(): UsageRecord[] {
  return readJson<UsageFile>(usagePath(), { spent: [] }).spent ?? [];
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
  const usage = loadUsage();
  if (isSpent(usage, identityId, service)) return; // idempotent
  usage.push({ identityId, service, at });
  const path = usagePath();
  mkdirSync(dirname(path), { recursive: true });
  // Write to a temp sibling then rename would be ideal; a single write is fine
  // here (one writer — the serial housekeeper) and keeps it simple.
  writeFileSync(path, `${JSON.stringify({ spent: usage }, null, 2)}\n`);
}

// Exposed so the housekeeper can log where it's reading the fleet from.
export function poolPaths(): { pool: string; usage: string; configured: boolean } {
  return { pool: poolPath(), usage: usagePath(), configured: existsSync(poolPath()) };
}
