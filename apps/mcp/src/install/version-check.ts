// Freshness guard for `connect`.
//
// The footgun this closes: `npx @trusty-squire/mcp connect` does NOT fetch the
// latest version when a copy is already installed. npx reuses an existing global
// bin (or a cached copy) instead of hitting the registry, so a months-old
// install keeps running — and connect then pins the host-agent config to
// whatever stale copy ran it. The documented one-liner silently freezes the
// user's version, and only a separate `npm install -g` moves it. That's the bug.
//
// Fix: before connect does anything, compare our own version against the npm
// `latest` dist-tag. If we're behind, re-exec via `npx -y @pkg@<latest> …` — the
// EXPLICIT version defeats npx's reuse-the-stale-copy behavior and forces the
// real latest to run, which then writes a current config. One `npx connect`,
// current version, no manual step.

import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { VERSION } from "../version.js";

const PKG = "@trusty-squire/mcp";
const REGISTRY = process.env.TRUSTY_SQUIRE_NPM_REGISTRY ?? "https://registry.npmjs.org";

interface ParsedVersion {
  readonly nums: readonly [number, number, number];
  readonly pre: string | null;
}

// Parse `1.2.3` or `1.2.3-rc.4`. Returns null on anything non-semver (a dev
// build, a git description) — callers treat null as "don't nag".
export function parseVersion(v: string): ParsedVersion | null {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(v.trim());
  if (m === null) return null;
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null };
}

// Compare dot-separated prerelease identifiers per semver §11: numeric
// identifiers compared numerically, alphanumerics lexically, a shorter set is
// lower when all preceding identifiers are equal. Returns <0, 0, or >0.
function comparePre(a: string, b: string): number {
  const as = a.split(".");
  const bs = b.split(".");
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const x = as[i];
    const y = bs[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

// True iff `current` is strictly older than `latest`. Handles the semver rule
// that a prerelease precedes its release (1.0.39-rc.1 < 1.0.39), so a user on a
// `next` prerelease AHEAD of `latest` (1.0.40-rc.1 vs 1.0.39) is NOT flagged.
// Unparseable inputs → false: never self-heal off a version we can't read.
export function isBehind(current: string, latest: string): boolean {
  const c = parseVersion(current);
  const l = parseVersion(latest);
  if (c === null || l === null) return false;
  for (let i = 0; i < 3; i++) {
    const cn = c.nums[i] ?? 0;
    const ln = l.nums[i] ?? 0;
    if (cn < ln) return true;
    if (cn > ln) return false;
  }
  // Equal X.Y.Z: a prerelease is behind the matching release.
  if (c.pre !== null && l.pre === null) return true;
  if (c.pre === null && l.pre !== null) return false;
  if (c.pre !== null && l.pre !== null) return comparePre(c.pre, l.pre) < 0;
  return false;
}

// Only self-heal from a PUBLISHED install (a global node_modules copy or an npx
// cache) — never from a source checkout, where the running version is
// intentionally whatever the developer built.
export function isPublishedInstall(binUrl: string): boolean {
  const p = fileURLToPath(new URL(binUrl));
  return /[/\\]node_modules[/\\]@trusty-squire[/\\]mcp[/\\]/.test(p) || /[/\\]_npx[/\\]/.test(p);
}

async function fetchLatestVersion(timeoutMs = 4000): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${REGISTRY}/${PKG}/latest`, { signal: controller.signal });
      if (!res.ok) return null;
      const body: unknown = await res.json();
      const version = (body as { version?: unknown }).version;
      return typeof version === "string" ? version : null;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // Offline, registry down, DNS — fail OPEN. We only block when we KNOW the
    // running copy is behind; an unreachable registry must not stop an install.
    return null;
  }
}

/**
 * Ensure `connect` runs on the current published version. If we're behind
 * `latest`, re-exec as the real latest via npx and exit with its status;
 * otherwise return and let connect proceed. No-op for dev checkouts, when the
 * registry is unreachable, or when TRUSTY_SQUIRE_SKIP_VERSION_CHECK is set.
 *
 * `argv` is the full CLI argv (including the `connect` subcommand) so the
 * re-exec reproduces the exact invocation.
 */
export async function ensureLatestVersion(argv: readonly string[]): Promise<void> {
  const skip = process.env.TRUSTY_SQUIRE_SKIP_VERSION_CHECK;
  if (skip === "1" || skip === "true") return;
  if (!isPublishedInstall(import.meta.url)) return;

  const latest = await fetchLatestVersion();
  if (latest === null) return;
  if (!isBehind(VERSION, latest)) return;

  console.error(
    `[trusty-squire] This copy is ${VERSION}, but ${latest} is the current release.\n` +
      `[trusty-squire] npx reused a stale local copy — re-running connect on ${latest}…`,
  );
  const result = spawnSync("npx", ["-y", `${PKG}@${latest}`, ...argv], {
    stdio: "inherit",
    // Guard against a re-exec loop and skip the child's own check (it IS latest).
    env: { ...process.env, TRUSTY_SQUIRE_SKIP_VERSION_CHECK: "1" },
  });
  if (result.error === undefined && typeof result.status === "number") {
    process.exit(result.status);
  }
  // Couldn't self-heal (npx missing / spawn failed). Fail CLOSED — refuse to pin
  // a stale version silently, which is the whole bug. Tell the user exactly what
  // to run.
  console.error(
    `[trusty-squire] Couldn't auto-update via npx. Update, then re-run connect:\n` +
      `    npm install -g ${PKG}@latest`,
  );
  process.exit(70);
}
