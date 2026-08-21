import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  linkSync,
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
import { basename, dirname, join, relative, resolve } from "node:path";
import type { OAuthProviderId } from "./oauth-providers.js";
import {
  CHROME_PROFILE_DIR,
  processBirthIdentity,
  processBirthIdentityState,
  profilePathIdentity,
  profileProcessIdentity,
  profileProcessIdentityState,
  signalProfileProcess,
  type ProfileCloseState,
  type ProfileProcessIdentity,
} from "./profile.js";

// Fixed per-namespace admission bound. These directories, rather than an
// in-memory counter, are the authority across MCP processes. A third operator
// start in the same namespace may wait at the provision seam, but can never
// create a third active profile while both slots are claimed.
const ACTIVE_SLOT_COUNT = 2;
const UNPUBLISHED_SEED_GENERATION = "unpublished";
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
export const GOOGLE_LOGIN_COOKIE_MARKERS = ["__Secure-1PSID", "SAPISID", "SID"] as const;

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
  disposition?: "destroy_required";
}

interface DeferredProfileRemoval {
  lease: ProfileLeaseDescriptor;
  finish: () => void;
}

interface PoolPaths {
  root: string;
  seed: string;
  generations: string;
  current: string;
  seedLock: string;
  profiles: string;
  active: string;
  activeClaims: string;
  warm: string;
  tombstones: string;
}

export interface OperatorProfilePoolOptions {
  rootDir?: string;
  sourceProfileDir?: string;
  now?: () => number;
  deadline?: number;
  signal?: AbortSignal;
}

export class OperatorProfileAcquisitionInterruptedError extends Error {
  constructor(
    readonly reason: "timeout" | "cancelled",
    readonly phase: "profile" | "seed_lock" = "profile",
  ) {
    super(`operator profile acquisition ${reason === "timeout" ? "timed out" : "was cancelled"}`);
    this.name = "OperatorProfileAcquisitionInterruptedError";
  }
}

type OperatorProfileAcquisitionControl = Pick<OperatorProfilePoolOptions, "deadline" | "signal">;

function defaultPoolRoot(): string {
  return process.env.VITEST === "true"
    ? join(tmpdir(), `trusty-squire-operator-profiles-test-${process.pid}`)
    : join(homedir(), ".trusty-squire", "operator-profiles");
}

function poolRootForSource(sourceProfileDir: string, rootDir?: string): string {
  if (rootDir !== undefined) return resolve(rootDir);
  const namespace = createHash("sha256")
    .update(profilePathIdentity(sourceProfileDir))
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
    activeClaims: join(root, "active-claims"),
    warm: join(root, "warm"),
    tombstones: join(root, "tombstones"),
  };
}

function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function initializePool(p: PoolPaths): void {
  for (const dir of [
    p.root,
    p.seed,
    p.generations,
    p.profiles,
    p.active,
    p.activeClaims,
    p.warm,
    p.tombstones,
  ]) {
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

function currentProcessIdentity(): ProcessIdentity {
  return processBirthIdentity(process.pid) ?? { pid: process.pid, start_time: "unknown" };
}

function processState(identity: ProcessIdentity): "matching" | "stale" | "unknown" {
  return processBirthIdentityState(identity);
}

function readSeedLockOwner(path: string): SeedLockOwner | null {
  try {
    return lstatSync(path).isDirectory()
      ? readJson<SeedLockOwner>(join(path, "owner.json"))
      : readJson<SeedLockOwner>(path);
  } catch {
    return null;
  }
}

function seedLockState(path: string): "matching" | "stale" | "unknown" {
  // Valid owner records are reclaimed only when their same-host PID/start_time is
  // confirmed stale. A matching or cross-host owner is intentionally unreclaimed:
  // wall-clock reclaim of a plausibly-live owner cannot be fully race-free without
  // a heavier heartbeat or fencing protocol, which was rejected as out of scope.
  // It also cannot protect against an already-running old-version orphan like the
  // 2026-08-15 incident; identify and kill that process by PID instead. The
  // startup grace below applies only when no valid owner record can be read.
  const owner = readSeedLockOwner(path);
  if (owner !== null) {
    if (owner.host !== hostname()) return "unknown";
    return processState(owner);
  }
  try {
    return Date.now() - lstatSync(path).mtimeMs >= STARTUP_GRACE_MS ? "stale" : "unknown";
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? "stale" : "unknown";
  }
}

function seedLockArtifacts(p: PoolPaths, kind: "claim" | "stale"): string[] {
  const dir = kind === "claim" ? p.seed : p.tombstones;
  const prefix = kind === "claim" ? `${basename(p.seedLock)}.claim-` : "seed-lock-";
  try {
    return readdirSync(dir)
      .filter((name) => name.startsWith(prefix))
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
}

function scavengeSeedLockArtifacts(p: PoolPaths): boolean {
  let retainedTombstone = false;
  for (const tombstone of seedLockArtifacts(p, "stale")) {
    if (seedLockState(tombstone) === "stale") {
      rmSync(tombstone, { recursive: true, force: true });
    } else {
      retainedTombstone = true;
    }
  }
  for (const claim of seedLockArtifacts(p, "claim")) {
    if (seedLockState(claim) === "stale") rmSync(claim, { force: true });
  }
  return retainedTombstone;
}

function quarantineStaleSeedLock(p: PoolPaths): boolean {
  if (seedLockState(p.seedLock) !== "stale") return false;
  const tombstone = join(p.tombstones, `seed-lock-${randomUUID()}`);
  try {
    renameSync(p.seedLock, tombstone);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT";
  }
  if (seedLockState(tombstone) === "stale") {
    rmSync(tombstone, { recursive: true, force: true });
    return true;
  }
  return false;
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

// Pooled clones must never carry Google's session cookies: a clone presents
// already-rotated-away cookie values (Google rotates them on the live
// profile as it's used), and Google's server treats that as credential
// replay and invalidates the whole session family — killing the user's real
// Google session for a casual pooled run. Google identity now only flows
// through the direct, unshared profile (operator-direct-identity.ts, gated
// by operate_start's require_live_identity); the seed and its clones carry
// no cookies at all.
function copyIdentitySeed(sourceProfileDir: string, destination: string): void {
  if (!lstatSync(sourceProfileDir).isDirectory()) {
    throw new Error(`operator login source is not a directory: ${sourceProfileDir}`);
  }
  ensurePrivateDir(destination);
  for (const relative of IDENTITY_SEED_FILES) {
    copyIdentitySeedFile(sourceProfileDir, destination, relative);
  }
}

function assertProfileAcquisitionActive(
  control: OperatorProfileAcquisitionControl,
  phase: "profile" | "seed_lock" = "profile",
): void {
  if (control.signal?.aborted === true) {
    throw new OperatorProfileAcquisitionInterruptedError("cancelled", phase);
  }
  if (control.deadline !== undefined && Date.now() >= control.deadline) {
    throw new OperatorProfileAcquisitionInterruptedError("timeout", phase);
  }
}

async function waitForSeedLockRetry(control: OperatorProfileAcquisitionControl): Promise<void> {
  assertProfileAcquisitionActive(control, "seed_lock");
  const delay =
    control.deadline === undefined ? 25 : Math.max(0, Math.min(25, control.deadline - Date.now()));
  await new Promise<void>((resolveWait) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      control.signal?.removeEventListener("abort", finish);
      resolveWait();
    };
    timer = setTimeout(finish, delay);
    control.signal?.addEventListener("abort", finish, { once: true });
    if (control.signal?.aborted === true) finish();
  });
  assertProfileAcquisitionActive(control, "seed_lock");
}

async function withSeedLock<T>(
  p: PoolPaths,
  fn: () => Promise<T> | T,
  control: OperatorProfileAcquisitionControl = {},
): Promise<T> {
  const token = randomUUID();
  const owner = {
    host: hostname(),
    ...currentProcessIdentity(),
    token,
  } satisfies SeedLockOwner;
  for (;;) {
    assertProfileAcquisitionActive(control, "seed_lock");
    if (scavengeSeedLockArtifacts(p)) {
      await waitForSeedLockRetry(control);
      continue;
    }
    const claim = `${p.seedLock}.claim-${randomUUID()}`;
    writeFileSync(claim, `${JSON.stringify(owner)}\n`, { mode: 0o600, flag: "wx" });
    try {
      linkSync(claim, p.seedLock);
    } catch (err) {
      rmSync(claim, { force: true });
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (quarantineStaleSeedLock(p)) continue;
      await waitForSeedLockRetry(control);
      continue;
    }
    try {
      rmSync(claim, { force: true });
    } catch (err) {
      if (readSeedLockOwner(p.seedLock)?.token === token) {
        rmSync(p.seedLock, { recursive: true, force: true });
      }
      throw err;
    }
    break;
  }
  try {
    assertProfileAcquisitionActive(control, "seed_lock");
    return await fn();
  } finally {
    if (readSeedLockOwner(p.seedLock)?.token === token) {
      rmSync(p.seedLock, { recursive: true, force: true });
    }
    for (const tombstone of seedLockArtifacts(p, "stale")) {
      if (readSeedLockOwner(tombstone)?.token === token) {
        rmSync(tombstone, { recursive: true, force: true });
      }
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

async function publishSeedLocked(p: PoolPaths, sourceProfileDir: string): Promise<string> {
  const generation = randomUUID();
  const staging = join(p.generations, `.${generation}.tmp`);
  const destination = join(p.generations, generation);
  try {
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
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    throw err;
  }
}

export function assertOperatorProfileRuntimeSupported(
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== "linux") {
    throw new Error("operator profile leases require Linux process identity");
  }
}

export interface OperatorSeedPublicationProof {
  loginStatus: "completed" | "preflight_satisfied" | "timeout";
  closeState: ProfileCloseState;
  provider: OAuthProviderId | null;
}

export function canPublishOperatorProfileSeed(
  proof: OperatorSeedPublicationProof,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return (
    platform === "linux" &&
    proof.provider === "google" &&
    proof.loginStatus === "completed" &&
    proof.closeState === "closed"
  );
}

export async function publishOperatorProfileSeed(
  sourceProfileDir: string = CHROME_PROFILE_DIR,
  opts: Pick<OperatorProfilePoolOptions, "rootDir"> & {
    proof: OperatorSeedPublicationProof;
  },
): Promise<string> {
  if (!canPublishOperatorProfileSeed(opts.proof)) {
    throw new Error(
      "operator profile seed publication requires explicit completed Google login provenance and verified Linux Chrome closure",
    );
  }
  const resolvedSource = profilePathIdentity(sourceProfileDir);
  const p = paths(poolRootForSource(resolvedSource, opts.rootDir));
  initializePool(p);
  return await withSeedLock(p, () => publishSeedLocked(p, resolvedSource));
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
    typeof lease.reuse_count !== "number" ||
    (lease.disposition !== undefined && lease.disposition !== "destroy_required")
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

function removeSlotContainer(p: PoolPaths, path: string): void {
  let privateClaim: string | null = null;
  try {
    if (lstatSync(path).isSymbolicLink()) {
      privateClaim = resolve(dirname(path), readlinkSync(path));
    }
  } catch {
    return;
  }
  rmSync(path, { recursive: true, force: true });
  if (privateClaim !== null && dirname(privateClaim) === p.activeClaims) {
    rmSync(privateClaim, { recursive: true, force: true });
  }
}

function reserveActiveSlot(
  p: PoolPaths,
  index: number,
  sessionId: string,
  beforePublish?: () => void,
): { slotDir: string; ownerToken: string } | null {
  const ownerToken = randomUUID();
  const privateClaim = join(p.activeClaims, randomUUID());
  const candidate = join(p.active, `slot-${index}`);
  ensurePrivateDir(privateClaim);
  let published = false;
  try {
    const identity = currentProcessIdentity();
    writePrivateJson(join(privateClaim, "owner.json"), {
      host: hostname(),
      ...identity,
      token: ownerToken,
      session_id: sessionId,
    } satisfies ActiveOwner);
    beforePublish?.();
    try {
      symlinkSync(relative(p.active, privateClaim), candidate, "dir");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return null;
      throw err;
    }
    published = true;
    if (readJson<ActiveOwner>(join(candidate, "owner.json"))?.token !== ownerToken) {
      throw new Error("operator active-slot ownership was lost during reservation");
    }
    return { slotDir: candidate, ownerToken };
  } finally {
    if (!published) rmSync(privateClaim, { recursive: true, force: true });
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

// removeProfile deletes a real, potentially large per-session Chrome profile
// (cache/history/IndexedDB accumulated over real browsing) — a disk-bound
// rmSync that can be genuinely slow. onRemovable, when supplied, lets the
// caller defer that physical delete until after the seed lock (which this
// function normally runs under, via scavengeQuarantinedActive /
// scavengeActiveSlots) has been released, so an unrelated concurrent
// operate_start never queues behind someone else's cleanup.
function reapQuarantinedActive(
  p: PoolPaths,
  tombstone: string,
  workerState: typeof profileProcessIdentityState = profileProcessIdentityState,
  signalWorker: typeof signalProfileProcess = signalProfileProcess,
  onRemovable?: (removal: DeferredProfileRemoval) => void,
): void {
  const owner = readJson<ActiveOwner>(join(tombstone, "owner.json"));
  if (owner !== null && (owner.host !== hostname() || processState(owner) !== "stale")) {
    const slotIndex = /^active-(\d+)-/.exec(basename(tombstone))?.[1];
    if (slotIndex === undefined) return;
    const publicSlot = join(p.active, `slot-${slotIndex}`);
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
    removeSlotContainer(p, tombstone);
    return;
  }
  const dir = profileDir(p, lease.profile_id);
  const worker = lease.worker;
  if (worker === undefined) return;
  const state = workerState(worker, dir);
  if (state === "unknown") return;
  if (state === "matching") {
    if (!signalWorker(worker, dir, "SIGKILL")) return;
    return;
  }
  if (onRemovable) {
    onRemovable({ lease, finish: () => removeSlotContainer(p, tombstone) });
  } else {
    removeProfile(p, lease);
    removeSlotContainer(p, tombstone);
  }
}

function scavengeDestroyRequired(
  p: PoolPaths,
  workerState: typeof profileProcessIdentityState = profileProcessIdentityState,
  signalWorker: typeof signalProfileProcess = signalProfileProcess,
): void {
  for (const entry of readdirSync(p.tombstones)) {
    if (!entry.startsWith("destroy-required-")) continue;
    const tombstone = join(p.tombstones, entry);
    const lease = readLease(join(tombstone, "claim"));
    if (lease?.disposition !== "destroy_required" || lease.worker === undefined) continue;
    const dir = profileDir(p, lease.profile_id);
    const state = workerState(lease.worker, dir);
    if (state === "unknown") continue;
    if (state === "matching") {
      signalWorker(lease.worker, dir, "SIGKILL");
      continue;
    }
    removeProfile(p, lease);
    removeSlotContainer(p, tombstone);
  }
}

function scavengeQuarantinedActive(
  p: PoolPaths,
  workerState: typeof profileProcessIdentityState = profileProcessIdentityState,
  signalWorker: typeof signalProfileProcess = signalProfileProcess,
  onRemovable?: (removal: DeferredProfileRemoval) => void,
): void {
  for (const entry of readdirSync(p.tombstones)) {
    if (!/^active-\d+-/.test(entry)) continue;
    reapQuarantinedActive(p, join(p.tombstones, entry), workerState, signalWorker, onRemovable);
  }
}

function scavengeActiveSlots(
  p: PoolPaths,
  now: number,
  onRemovable?: (removal: DeferredProfileRemoval) => void,
): void {
  for (let index = 0; index < ACTIVE_SLOT_COUNT; index += 1) {
    const slot = join(p.active, `slot-${index}`);
    if (!existsSync(slot)) continue;
    const owner = readJson<ActiveOwner>(join(slot, "owner.json"));
    if (owner === null) {
      if (now - statSync(slot).mtimeMs < STARTUP_GRACE_MS) continue;
    } else if (owner.host !== hostname() || processState(owner) !== "stale") {
      continue;
    }
    // The public slot is only a candidate until this rename wins. No process is
    // inspected again, signalled, or deleted while the lease remains claimable.
    const tombstone = quarantine(p, slot, `active-${index}`);
    if (tombstone !== null) reapQuarantinedActive(p, tombstone, undefined, undefined, onRemovable);
  }
}

// onRemovable defers the physical delete of an expired warm profile's real
// (potentially large) directory to after the caller releases the seed lock —
// see reapQuarantinedActive's comment for why.
function scavengeWarm(
  p: PoolPaths,
  generation: string,
  now: number,
  onRemovable?: (removal: DeferredProfileRemoval) => void,
): void {
  const removeQuarantinedWarm = (tombstone: string): void => {
    const lease = readLease(tombstone);
    if (lease === null) {
      rmSync(tombstone, { recursive: true, force: true });
    } else if (onRemovable) {
      onRemovable({
        lease,
        finish: () => rmSync(tombstone, { recursive: true, force: true }),
      });
    } else {
      removeProfile(p, lease);
      rmSync(tombstone, { recursive: true, force: true });
    }
  };
  for (const entry of readdirSync(p.tombstones)) {
    if (entry.startsWith("warm-")) removeQuarantinedWarm(join(p.tombstones, entry));
  }
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
  removeQuarantinedWarm(tombstone);
}

function flushDeferredProfileRemovals(p: PoolPaths, removals: DeferredProfileRemoval[]): void {
  for (const removal of removals) {
    try {
      removeProfile(p, removal.lease);
      removal.finish();
    } catch {}
  }
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
    if (
      worker.host !== hostname() ||
      profilePathIdentity(worker.user_data_dir) !== profilePathIdentity(this.profileDir)
    ) {
      throw new Error("operator worker identity does not match its leased profile");
    }
    this.descriptor = { ...this.descriptor, worker };
    writePrivateJson(join(this.claimDir, "lease.json"), this.descriptor);
  }

  async returnWarm(closeState: ProfileCloseState): Promise<void> {
    if (this.finished) return;
    if (this.descriptor.disposition === "destroy_required") {
      if (closeState === "closed") await this.destroy();
      else await this.retain(true);
      return;
    }
    if (closeState !== "closed") {
      await this.retain();
      return;
    }
    const withoutWorker = { ...this.descriptor };
    delete withoutWorker.worker;
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
    this.descriptor = { ...this.descriptor, disposition: "destroy_required" };
    writePrivateJson(join(this.claimDir, "lease.json"), this.descriptor);
    this.discardOwnedSlot("destroy-required");
    this.finished = true;
  }

  async retain(destroyRequired = false): Promise<void> {
    if (this.finished) return;
    if (destroyRequired || this.descriptor.disposition === "destroy_required") {
      this.descriptor = { ...this.descriptor, disposition: "destroy_required" };
      writePrivateJson(join(this.claimDir, "lease.json"), this.descriptor);
    }
    quarantineOwnedActiveSlot(
      this.p,
      this.slotDir,
      this.ownerToken,
      this.descriptor.disposition === "destroy_required" ? "destroy-required" : "unverified-close",
    );
    this.finished = true;
  }

  private discardOwnedSlot(label = "owned-active"): void {
    const tombstone = quarantineOwnedActiveSlot(this.p, this.slotDir, this.ownerToken, label);
    if (tombstone === null) return;
    const quarantinedLease = readLease(join(tombstone, "claim"));
    if (quarantinedLease?.lease_token !== this.descriptor.lease_token) {
      // Ownership changed or the descriptor became ambiguous. The private
      // tombstone is no longer claimable, so retain it without deleting data.
      return;
    }
    removeProfile(this.p, quarantinedLease);
    removeSlotContainer(this.p, tombstone);
  }

  private releaseSlot(): void {
    const owner = readJson<ActiveOwner>(join(this.slotDir, "owner.json"));
    if (owner?.token === this.ownerToken) removeSlotContainer(this.p, this.slotDir);
  }
}

export async function acquireOperatorProfile(
  sessionId: string,
  opts: OperatorProfilePoolOptions = {},
): Promise<OperatorProfileLease> {
  assertOperatorProfileRuntimeSupported();
  const sourceProfileDir = profilePathIdentity(opts.sourceProfileDir ?? CHROME_PROFILE_DIR);
  const p = paths(poolRootForSource(sourceProfileDir, opts.rootDir));
  const now = opts.now ?? Date.now;
  initializePool(p);
  scavengeDestroyRequired(p);

  // Collected by scavengeQuarantinedActive/scavengeActiveSlots instead of
  // physically removed inline, so the (potentially slow, disk-bound) removal
  // of a real per-session profile directory happens after the seed lock
  // below is released, never while it's held.
  const reclaimedFromReservation: DeferredProfileRemoval[] = [];
  const reservation = await withSeedLock(
    p,
    () => {
      scavengeQuarantinedActive(p, undefined, undefined, (removal) =>
        reclaimedFromReservation.push(removal),
      );
      scavengeActiveSlots(p, now(), (removal) => reclaimedFromReservation.push(removal));
      for (let index = 0; index < ACTIVE_SLOT_COUNT; index += 1) {
        const claimed = reserveActiveSlot(p, index, sessionId);
        if (claimed !== null) return claimed;
      }
      return null;
    },
    opts,
  );
  flushDeferredProfileRemovals(p, reclaimedFromReservation);
  if (reservation === null) {
    throw new Error(
      "operate_start capacity reached: 2 operator sessions are active; finish one and retry",
    );
  }
  const { slotDir, ownerToken } = reservation;

  const claimDir = join(slotDir, "claim");
  let allocatedProfileId: string | null = null;
  // Same deferred-removal reasoning as reclaimedFromReservation above, for
  // the expired-warm-profile case surfaced while cloning/reusing.
  const reclaimedFromWarm: DeferredProfileRemoval[] = [];
  try {
    assertProfileAcquisitionActive(opts);
    const acquiredDescriptor = await withSeedLock(
      p,
      () => {
        const generation = currentGeneration(p);
        scavengeWarm(p, generation ?? UNPUBLISHED_SEED_GENERATION, now(), (removal) =>
          reclaimedFromWarm.push(removal),
        );
        const warm = join(p.warm, "slot-0");
        let descriptor: ProfileLeaseDescriptor | null = null;
        try {
          renameSync(warm, claimDir);
          descriptor = readLease(claimDir);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
        if (descriptor !== null) {
          const activeDescriptor = { ...descriptor };
          delete activeDescriptor.returned_at;
          delete activeDescriptor.worker;
          writePrivateJson(join(claimDir, "lease.json"), activeDescriptor);
          return activeDescriptor;
        }

        rmSync(claimDir, { recursive: true, force: true });
        const profileId = randomUUID();
        allocatedProfileId = profileId;
        const profileRoot = join(p.profiles, profileId);
        ensurePrivateDir(profileRoot);
        const userDataDir = join(profileRoot, "user-data");
        if (generation === null) {
          ensurePrivateDir(userDataDir);
        } else {
          cpSync(join(p.generations, generation, "user-data"), userDataDir, {
            recursive: true,
            force: false,
            errorOnExist: true,
          });
          stripTransientProfileState(userDataDir);
        }
        ensurePrivateDir(claimDir);
        const coldDescriptor: ProfileLeaseDescriptor = {
          version: 1,
          lease_token: randomUUID(),
          profile_id: profileId,
          seed_generation: generation ?? UNPUBLISHED_SEED_GENERATION,
          created_at: now(),
          reuse_count: 0,
        };
        writePrivateJson(join(claimDir, "lease.json"), coldDescriptor);
        return coldDescriptor;
      },
      opts,
    );
    assertProfileAcquisitionActive(opts);
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
      if (descriptorWasSafe) removeSlotContainer(p, tombstone);
    }
    throw err;
  } finally {
    flushDeferredProfileRemovals(p, reclaimedFromWarm);
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
  withSeedLock,
  reserveActiveSlot,
  scavengeQuarantinedActive,
  scavengeDestroyRequired,
  resetDefaultPool: (): void => rmSync(defaultPoolRoot(), { recursive: true, force: true }),
};
