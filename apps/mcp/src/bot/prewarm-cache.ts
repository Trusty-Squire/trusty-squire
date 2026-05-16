// Persistent record of "this domain was prewarmed recently."
//
// Prewarm is one of our highest-value bot-resistance moves — simulating
// a real user's referrer chain (google search → result click → scroll
// → navigate) lifts the reCAPTCHA v3 score meaningfully because v3
// weighs prior browsing activity. But it costs 20-45s of wall clock
// on every signup, which is brutal UX for the second-and-beyond
// attempts on the same service.
//
// This cache lets us pay that cost once per (domain × machine × TTL
// window) and skip straight to the cheap dwell-only prewarm on cache
// hits. Hits also indicate the domain has live cookies on this
// machine already, which is what we actually wanted the long prewarm
// to establish.
//
// Format: JSON map { "<domain>": "<iso8601-timestamp>" }. Stored under
// $XDG_STATE_HOME/trusty-squire/prewarm-cache.json (or
// ~/.local/state/trusty-squire/... on linux, ~/.trusty-squire/... as
// a fallback).
//
// We intentionally keep this dirt simple — no eviction job, no
// LRU, no concurrent-write locking. Failures are non-fatal in both
// directions (read fail = treat as cache miss, write fail = log + move
// on). The file's small enough that rewriting the whole thing every
// signup is fine.

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

// 24h matches the typical Cloudflare clearance cookie TTL. After 24h
// the cookies the long prewarm planted are stale enough that the
// scoring JS will retreat — so we may as well redo the prewarm.
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

function cacheFilePath(): string {
  // Respect XDG_STATE_HOME for linux desktops; fall back to a hidden
  // dir in $HOME on platforms that don't set it. This is the same
  // convention the session storage code uses.
  const stateRoot =
    process.env.XDG_STATE_HOME ??
    (process.platform === "linux"
      ? path.join(os.homedir(), ".local", "state")
      : path.join(os.homedir(), ".trusty-squire"));
  return path.join(stateRoot, "trusty-squire", "prewarm-cache.json");
}

type CacheMap = Record<string, string>;

async function readCache(): Promise<CacheMap> {
  try {
    const raw = await fs.readFile(cacheFilePath(), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return {};
    // Validate shape — anything malformed gets treated as empty so a
    // hand-edited or corrupted file doesn't crash the bot.
    const out: CacheMap = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

async function writeCache(map: CacheMap): Promise<void> {
  const file = cacheFilePath();
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(map, null, 2), "utf8");
  } catch (err) {
    // Cache is a perf hint, not a correctness boundary. Log and move on.
    console.error(
      `[universal-bot] prewarm cache write failed (non-fatal): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

// Was this domain successfully prewarmed within the TTL window?
// `domain` should be a URL origin like "https://www.postmark.com".
export async function wasRecentlyPrewarmed(
  domain: string,
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<boolean> {
  const map = await readCache();
  const ts = map[domain];
  if (ts === undefined) return false;
  const parsed = Date.parse(ts);
  if (Number.isNaN(parsed)) return false;
  return Date.now() - parsed < ttlMs;
}

// Record a successful prewarm for this domain.
export async function recordPrewarmSuccess(domain: string): Promise<void> {
  const map = await readCache();
  map[domain] = new Date().toISOString();
  await writeCache(map);
}
