import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import Database from "better-sqlite3";
import {
  CHROME_PROFILE_DIR,
  profileProcessIdentity,
  profileProcessMatches,
  signalProfileProcess,
  type ProfileProcessIdentity,
  withProfileOperationGuard,
} from "./profile.js";

const ACTIVE_SLOT_COUNT = 1;
const STARTUP_GRACE_MS = 30_000;
const WARM_IDLE_TTL_MS = 6 * 60 * 60 * 1_000;
const WARM_MAX_REUSES = 50;
const WARM_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

const TRANSIENT_PROFILE_NAMES = new Set([
  "SingletonLock",
  "SingletonSocket",
  "SingletonCookie",
  "DevToolsActivePort",
]);
const TRANSIENT_PROFILE_DIRS = new Set(["Cache", "Code Cache", "GPUCache", "Crashpad"]);
const IDENTITY_SEED_FILES = [
  "Local State",
  "logged-in-providers.json",
  "provider-emails.json",
] as const;
const IDENTITY_COOKIE_FILES = ["Default/Cookies", "Default/Network/Cookies"] as const;
const IDENTITY_COOKIE_DOMAINS = ["google.com", "github.com"] as const;

interface ProcessIdentity {
  pid: number;
  start_time: string;
}

export type OperatorWorkerIdentity = ProfileProcessIdentity;

interface ActiveOwner extends ProcessIdentity {
  host: string;
  token: string;
  session_id: string;
}

interface SeedLockOwner extends ProcessIdentity {
  host: string;
  token: string;
}

interface ProfileLeaseDescriptor {
  version: 1;
  lease_token: string;
  profile_id: string;
  seed_generation: string;
  created_at: number;
  returned_at?: number;
  reuse_count: number;
  worker?: OperatorWorkerIdentity;
}

interface PoolPaths {
  root: string;
  seed: string;
  generations: string;
  current: string;
  seedLock: string;
  profiles: string;
  active: string;
  warm: string;
  tombstones: string;
}

export interface OperatorProfilePoolOptions {
  rootDir?: string;
  sourceProfileDir?: string;
  now?: () => number;
}

function defaultPoolRoot(): string {
  return process.env.VITEST === "true"
    ? join(tmpdir(), `trusty-squire-operator-profiles-test-${process.pid}`)
    : join(homedir(), ".trusty-squire", "operator-profiles");
}

function poolRootForSource(sourceProfileDir: string, rootDir?: string): string {
  if (rootDir !== undefined) return resolve(rootDir);
  const namespace = createHash("sha256")
    .update(resolve(sourceProfileDir))
    .digest("hex")
    .slice(0, 24);
  return join(defaultPoolRoot(), "namespaces", namespace);
}

function paths(rootDir?: string): PoolPaths {
  const root = resolve(rootDir ?? defaultPoolRoot());
  const seed = join(root, "seed");
  return {
    root,
    seed,
    generations: join(seed, "generations"),
    current: join(seed, "current"),
    seedLock: join(seed, ".lock"),
    profiles: join(root, "profiles"),
    active: join(root, "active"),
    warm: join(root, "warm"),
    tombstones: join(root, "tombstones"),
  };
}

function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function initializePool(p: PoolPaths): void {
  for (const dir of [p.root, p.seed, p.generations, p.profiles, p.active, p.warm, p.tombstones]) {
    ensurePrivateDir(dir);
  }
}

function writePrivateJson(path: string, value: unknown): void {
  const temporary = `${path}.tmp.${randomUUID()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } catch (err) {
    rmSync(temporary, { force: true });
    throw err;
  }
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function processStartTime(pid: number): string | null {
  if (process.platform !== "linux") return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    if (close < 0) return null;
    const fields = stat.slice(close + 2).split(" ");
    return fields[19] ?? null;
  } catch {
    return null;
  }
}

function currentProcessIdentity(): ProcessIdentity {
  return { pid: process.pid, start_time: processStartTime(process.pid) ?? "unknown" };
}

function processMatches(identity: ProcessIdentity): boolean {
  if (identity.pid === process.pid) return true;
  // A platform without a process birth marker cannot safely prove an owner is
  // stale. Conservatively retain it instead of treating raw PID liveness as identity.
  if (identity.start_time === "unknown") return true;
  const actual = processStartTime(identity.pid);
  return actual !== null && actual === identity.start_time;
}

function stripTransientProfileState(root: string): void {
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (TRANSIENT_PROFILE_NAMES.has(entry.name) || TRANSIENT_PROFILE_DIRS.has(entry.name)) {
        rmSync(path, { recursive: true, force: true });
      } else if (entry.isDirectory()) {
        walk(path);
      }
    }
  };
  if (existsSync(root)) walk(root);
}

function copyIdentitySeedFile(sourceRoot: string, destinationRoot: string, relative: string): void {
  const source = join(sourceRoot, relative);
  try {
    if (!lstatSync(source).isFile()) return;
  } catch {
    return;
  }
  const destination = join(destinationRoot, relative);
  ensurePrivateDir(dirname(destination));
  copyFileSync(source, destination);
  chmodSync(destination, 0o600);
}

function retainIdentityCookies(cookiePath: string): void {
  if (!existsSync(cookiePath)) return;
  let db: Database.Database | null = null;
  try {
    db = new Database(cookiePath);
    const cookieTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cookies'")
      .get();
    if (cookieTable === undefined) throw new Error("Chrome cookie store has no cookies table");
    const allowed = IDENTITY_COOKIE_DOMAINS.map(
      () => "(lower(host_key) = ? OR lower(host_key) LIKE ?)",
    ).join(" OR ");
    const bindings = IDENTITY_COOKIE_DOMAINS.flatMap((domain) => [domain, `%.${domain}`]);
    db.prepare(`DELETE FROM cookies WHERE NOT (${allowed})`).run(...bindings);
    db.pragma("wal_checkpoint(TRUNCATE)");
  } catch {
    db?.close();
    for (const suffix of ["", "-wal", "-shm"] as const) {
      rmSync(`${cookiePath}${suffix}`, { force: true });
    }
    return;
  }
  db.close();
  rmSync(`${cookiePath}-wal`, { force: true });
  rmSync(`${cookiePath}-shm`, { force: true });
}

function copyIdentitySeed(sourceProfileDir: string, destination: string): void {
  if (!lstatSync(sourceProfileDir).isDirectory()) {
    throw new Error(`operator login source is not a directory: ${sourceProfileDir}`);
  }
  ensurePrivateDir(destination);
  for (const relative of IDENTITY_SEED_FILES) {
    copyIdentitySeedFile(sourceProfileDir, destination, relative);
  }
  for (const relative of IDENTITY_COOKIE_FILES) {
    copyIdentitySeedFile(sourceProfileDir, destination, relative);
    copyIdentitySeedFile(sourceProfileDir, destination, `${relative}-wal`);
    copyIdentitySeedFile(sourceProfileDir, destination, `${relative}-shm`);
    retainIdentityCookies(join(destination, relative));
  }
}

async function withSeedLock<T>(p: PoolPaths, fn: () => Promise<T> | T): Promise<T> {
  const token = randomUUID();
  for (;;) {
    try {
      mkdirSync(p.seedLock, { mode: 0o700 });
      try {
        writePrivateJson(join(p.seedLock, "owner.json"), {
          host: hostname(),
          ...currentProcessIdentity(),
          token,
        } satisfies SeedLockOwner);
      } catch (err) {
        rmSync(p.seedLock, { recursive: true, force: true });
        throw err;
      }
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const owner = readJson<SeedLockOwner>(join(p.seedLock, "owner.json"));
      const malformedAndOld =
        owner === null &&
        (() => {
          try {
            return Date.now() - statSync(p.seedLock).mtimeMs >= STARTUP_GRACE_MS;
          } catch {
            return false;
          }
        })();
      if (
        malformedAndOld ||
        (owner !== null && owner.host === hostname() && !processMatches(owner))
      ) {
        const stale = join(p.tombstones, `seed-lock-${randomUUID()}`);
        try {
          renameSync(p.seedLock, stale);
          rmSync(stale, { recursive: true, force: true });
          continue;
        } catch {
          // Another publisher/clone won cleanup or replaced the lock.
        }
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
  }
  try {
    return await fn();
  } finally {
    if (readJson<SeedLockOwner>(join(p.seedLock, "owner.json"))?.token === token) {
      rmSync(p.seedLock, { recursive: true, force: true });
    }
  }
}

function currentGeneration(p: PoolPaths): string | null {
  try {
    const target = readlinkSync(p.current);
    const generation = basename(target);
    return existsSync(join(p.generations, generation, "user-data")) ? generation : null;
  } catch {
    return null;
  }
}

function publishSeedLocked(p: PoolPaths, sourceProfileDir: string): string {
  const generation = randomUUID();
  const staging = join(p.generations, `.${generation}.tmp`);
  const destination = join(p.generations, generation);
  ensurePrivateDir(staging);
  copyIdentitySeed(sourceProfileDir, join(staging, "user-data"));
  renameSync(staging, destination);
  const nextLink = join(p.seed, `.current-${generation}`);
  symlinkSync(join("generations", generation), nextLink, "dir");
  renameSync(nextLink, p.current);
  for (const entry of readdirSync(p.generations, { withFileTypes: true })) {
    if (entry.name !== generation) {
      rmSync(join(p.generations, entry.name), { recursive: true, force: true });
    }
  }
  return generation;
}

export async function publishOperatorProfileSeed(
  sourceProfileDir: string = CHROME_PROFILE_DIR,
  opts: Pick<OperatorProfilePoolOptions, "rootDir"> = {},
): Promise<string> {
  const resolvedSource = resolve(sourceProfileDir);
  const p = paths(poolRootForSource(resolvedSource, opts.rootDir));
  initializePool(p);
  return await withSeedLock(p, () => publishSeedLocked(p, resolvedSource));
}

async function ensureSeed(p: PoolPaths, sourceProfileDir: string): Promise<string> {
  const resolveOrPublish = (): string => {
    const existing = currentGeneration(p);
    if (existing !== null) return existing;
    return publishSeedLocked(p, sourceProfileDir);
  };
  const existing = await withSeedLock(p, () => currentGeneration(p));
  if (existing !== null) return existing;
  // Login publication already holds the canonical profile guard before taking
  // the seed lock. Initial publication uses the same order, then rechecks the
  // generation under the lock so two cold starters cannot both publish.
  // Vitest workers use isolated roots and mocked browsers, so the canonical
  // profile guard would only serialize unrelated fixtures.
  if (process.env.VITEST === "true") return await withSeedLock(p, resolveOrPublish);
  return await withProfileOperationGuard(sourceProfileDir, async () =>
    withSeedLock(p, resolveOrPublish),
  );
}

function profileDir(p: PoolPaths, profileId: string): string {
  return join(p.profiles, profileId, "user-data");
}

function readLease(claimDir: string): ProfileLeaseDescriptor | null {
  const lease = readJson<ProfileLeaseDescriptor>(join(claimDir, "lease.json"));
  if (
    lease?.version !== 1 ||
    typeof lease.lease_token !== "string" ||
    typeof lease.profile_id !== "string" ||
    !/^[0-9a-f-]{36}$/.test(lease.profile_id) ||
    typeof lease.seed_generation !== "string" ||
    typeof lease.created_at !== "number" ||
    typeof lease.reuse_count !== "number"
  ) {
    return null;
  }
  return lease;
}

function removeProfile(p: PoolPaths, lease: ProfileLeaseDescriptor): void {
  rmSync(join(p.profiles, lease.profile_id), { recursive: true, force: true });
}

function quarantine(p: PoolPaths, publicPath: string, label: string): string | null {
  const privatePath = join(p.tombstones, `${label}-${randomUUID()}`);
  try {
    renameSync(publicPath, privatePath);
    return privatePath;
  } catch (err) {
    if (["ENOENT", "EEXIST", "ENOTEMPTY"].includes((err as NodeJS.ErrnoException).code ?? "")) {
      return null;
    }
    throw err;
  }
}

function quarantineOwnedActiveSlot(
  p: PoolPaths,
  slotDir: string,
  ownerToken: string,
  label: string,
): string | null {
  if (readJson<ActiveOwner>(join(slotDir, "owner.json"))?.token !== ownerToken) return null;
  const tombstone = quarantine(p, slotDir, label);
  if (tombstone === null) return null;
  if (readJson<ActiveOwner>(join(tombstone, "owner.json"))?.token !== ownerToken) {
    // The renamed directory is private, so retaining an ambiguity is safe.
    return null;
  }
  return tombstone;
}

function reapQuarantinedActive(p: PoolPaths, tombstone: string): void {
  const owner = readJson<ActiveOwner>(join(tombstone, "owner.json"));
  if (owner !== null && (owner.host !== hostname() || processMatches(owner))) {
    // A transient identity read failed before quarantine. Restore the lease if
    // its public slot is still free; never inspect or signal the worker.
    const publicSlot = join(p.active, "slot-0");
    try {
      renameSync(tombstone, publicSlot);
    } catch {
      // Another owner already reserved capacity. Keep this lease private and
      // leak-safe for a later manual inspection rather than killing ambiguity.
    }
    return;
  }
  const claim = join(tombstone, "claim");
  const lease = readLease(claim);
  if (lease === null) {
    rmSync(tombstone, { recursive: true, force: true });
    return;
  }
  const dir = profileDir(p, lease.profile_id);
  const worker = lease.worker;
  if (worker !== undefined && processMatches(worker)) {
    if (!profileProcessMatches(worker, dir)) {
      // PID exists but its birth/cmdline/profile identity cannot be proven. Keep
      // the private tombstone and profile; freeing capacity is safe, signalling is not.
      return;
    }
    if (!signalProfileProcess(worker, dir, "SIGKILL")) return;
  }
  removeProfile(p, lease);
  rmSync(tombstone, { recursive: true, force: true });
}

function scavengeActiveSlots(p: PoolPaths, now: number): void {
  for (let index = 0; index < ACTIVE_SLOT_COUNT; index += 1) {
    const slot = join(p.active, `slot-${index}`);
    if (!existsSync(slot)) continue;
    const owner = readJson<ActiveOwner>(join(slot, "owner.json"));
    if (owner === null) {
      if (now - statSync(slot).mtimeMs < STARTUP_GRACE_MS) continue;
    } else if (owner.host !== hostname() || processMatches(owner)) {
      continue;
    }
    // The public slot is only a candidate until this rename wins. No process is
    // inspected again, signalled, or deleted while the lease remains claimable.
    const tombstone = quarantine(p, slot, `active-${index}`);
    if (tombstone !== null) reapQuarantinedActive(p, tombstone);
  }
}

function scavengeWarm(p: PoolPaths, generation: string, now: number): void {
  const warm = join(p.warm, "slot-0");
  if (!existsSync(warm)) return;
  const lease = readLease(warm);
  const expired =
    lease === null ||
    lease.worker !== undefined ||
    lease.seed_generation !== generation ||
    lease.returned_at === undefined ||
    now - lease.returned_at >= WARM_IDLE_TTL_MS ||
    now - lease.created_at >= WARM_MAX_AGE_MS ||
    lease.reuse_count >= WARM_MAX_REUSES;
  if (!expired) return;
  const tombstone = quarantine(p, warm, "warm");
  if (tombstone === null) return;
  const quarantinedLease = readLease(tombstone);
  if (quarantinedLease !== null) removeProfile(p, quarantinedLease);
  rmSync(tombstone, { recursive: true, force: true });
}

export class OperatorProfileLease {
  readonly profileDir: string;
  readonly profileId: string;
  readonly seedGeneration: string;
  private finished = false;

  constructor(
    private readonly p: PoolPaths,
    private readonly slotDir: string,
    private readonly claimDir: string,
    private readonly ownerToken: string,
    private descriptor: ProfileLeaseDescriptor,
    private readonly now: () => number,
  ) {
    this.profileId = descriptor.profile_id;
    this.seedGeneration = descriptor.seed_generation;
    this.profileDir = profileDir(p, descriptor.profile_id);
  }

  bindWorker(worker: OperatorWorkerIdentity): void {
    if (this.finished) throw new Error("operator profile lease is already released");
    if (worker.host !== hostname() || resolve(worker.user_data_dir) !== resolve(this.profileDir)) {
      throw new Error("operator worker identity does not match its leased profile");
    }
    this.descriptor = { ...this.descriptor, worker };
    writePrivateJson(join(this.claimDir, "lease.json"), this.descriptor);
  }

  async returnWarm(): Promise<void> {
    if (this.finished) return;
    const { worker: _worker, ...withoutWorker } = this.descriptor;
    this.descriptor = {
      ...withoutWorker,
      returned_at: this.now(),
      reuse_count: this.descriptor.reuse_count + 1,
    };
    writePrivateJson(join(this.claimDir, "lease.json"), this.descriptor);
    const current = currentGeneration(this.p);
    const warm = join(this.p.warm, "slot-0");
    let pooled = current === this.descriptor.seed_generation;
    if (pooled) {
      try {
        renameSync(this.claimDir, warm);
      } catch (err) {
        if (!["EEXIST", "ENOTEMPTY"].includes((err as NodeJS.ErrnoException).code ?? "")) throw err;
        pooled = false;
      }
    }
    if (!pooled) {
      this.discardOwnedSlot();
      this.finished = true;
      return;
    }
    this.releaseSlot();
    this.finished = true;
  }

  async destroy(): Promise<void> {
    if (this.finished) return;
    this.discardOwnedSlot();
    this.finished = true;
  }

  private discardOwnedSlot(): void {
    const tombstone = quarantineOwnedActiveSlot(
      this.p,
      this.slotDir,
      this.ownerToken,
      "owned-active",
    );
    if (tombstone === null) return;
    const quarantinedLease = readLease(join(tombstone, "claim"));
    if (quarantinedLease?.lease_token !== this.descriptor.lease_token) {
      // Ownership changed or the descriptor became ambiguous. The private
      // tombstone is no longer claimable, so retain it without deleting data.
      return;
    }
    removeProfile(this.p, quarantinedLease);
    rmSync(tombstone, { recursive: true, force: true });
  }

  private releaseSlot(): void {
    const owner = readJson<ActiveOwner>(join(this.slotDir, "owner.json"));
    if (owner?.token === this.ownerToken) rmSync(this.slotDir, { recursive: true, force: true });
  }
}

export async function acquireOperatorProfile(
  sessionId: string,
  opts: OperatorProfilePoolOptions = {},
): Promise<OperatorProfileLease> {
  const sourceProfileDir = resolve(opts.sourceProfileDir ?? CHROME_PROFILE_DIR);
  const p = paths(poolRootForSource(sourceProfileDir, opts.rootDir));
  const now = opts.now ?? Date.now;
  initializePool(p);
  await ensureSeed(p, sourceProfileDir);
  scavengeActiveSlots(p, now());

  let slotDir: string | null = null;
  let ownerToken = "";
  for (let index = 0; index < ACTIVE_SLOT_COUNT; index += 1) {
    const candidate = join(p.active, `slot-${index}`);
    try {
      mkdirSync(candidate, { mode: 0o700 });
      try {
        ownerToken = randomUUID();
        const identity = currentProcessIdentity();
        writePrivateJson(join(candidate, "owner.json"), {
          host: hostname(),
          ...identity,
          token: ownerToken,
          session_id: sessionId,
        } satisfies ActiveOwner);
        if (readJson<ActiveOwner>(join(candidate, "owner.json"))?.token !== ownerToken) {
          throw new Error("operator active-slot ownership was lost during reservation");
        }
      } catch (err) {
        // The slot may already have been quarantined and its public name reused.
        // Never clean a failed reservation by path; the grace-based scavenger
        // will tombstone an owner-less slot if this directory is still ours.
        throw err;
      }
      slotDir = candidate;
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  if (slotDir === null) {
    throw new Error(
      "operate_start capacity reached: 1 operator session is active; finish it and retry",
    );
  }

  const claimDir = join(slotDir, "claim");
  let allocatedProfileId: string | null = null;
  try {
    const acquiredDescriptor = await withSeedLock(p, () => {
      const generation = currentGeneration(p);
      if (generation === null) throw new Error("operator login seed is unavailable");
      scavengeWarm(p, generation, now());
      const warm = join(p.warm, "slot-0");
      let descriptor: ProfileLeaseDescriptor | null = null;
      try {
        renameSync(warm, claimDir);
        descriptor = readLease(claimDir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      if (descriptor !== null) {
        const { returned_at: _returnedAt, worker: _worker, ...activeDescriptor } = descriptor;
        writePrivateJson(join(claimDir, "lease.json"), activeDescriptor);
        return activeDescriptor;
      }

      rmSync(claimDir, { recursive: true, force: true });
      const profileId = randomUUID();
      allocatedProfileId = profileId;
      const profileRoot = join(p.profiles, profileId);
      ensurePrivateDir(profileRoot);
      cpSync(join(p.generations, generation, "user-data"), join(profileRoot, "user-data"), {
        recursive: true,
        force: false,
        errorOnExist: true,
      });
      stripTransientProfileState(join(profileRoot, "user-data"));
      ensurePrivateDir(claimDir);
      const coldDescriptor: ProfileLeaseDescriptor = {
        version: 1,
        lease_token: randomUUID(),
        profile_id: profileId,
        seed_generation: generation,
        created_at: now(),
        reuse_count: 0,
      };
      writePrivateJson(join(claimDir, "lease.json"), coldDescriptor);
      return coldDescriptor;
    });
    return new OperatorProfileLease(p, slotDir, claimDir, ownerToken, acquiredDescriptor, now);
  } catch (err) {
    const tombstone = quarantineOwnedActiveSlot(p, slotDir, ownerToken, "failed-active");
    if (tombstone !== null) {
      const lease = readLease(join(tombstone, "claim"));
      let descriptorWasSafe = false;
      if (lease !== null) {
        removeProfile(p, lease);
        descriptorWasSafe = true;
      } else if (allocatedProfileId !== null) {
        rmSync(join(p.profiles, allocatedProfileId), { recursive: true, force: true });
        descriptorWasSafe = true;
      }
      if (descriptorWasSafe) rmSync(tombstone, { recursive: true, force: true });
    }
    throw err;
  }
}

export function localWorkerIdentity(
  pid: number,
  userDataDir: string,
): OperatorWorkerIdentity | null {
  return profileProcessIdentity(pid, userDataDir);
}

export const operatorProfilePoolTest = {
  paths,
  poolRootForSource,
  currentGeneration,
  processStartTime,
  resetDefaultPool: (): void => rmSync(defaultPoolRoot(), { recursive: true, force: true }),
};
