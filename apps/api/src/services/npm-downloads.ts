// npm package download counts for the Panel 1 funnel (top-of-funnel,
// anonymous volume). Hits the public npm range API, with a ~1h
// module-level cache + stale-if-error: a fetch failure serves the last
// good value for the same window if we have one, else null (the funnel
// renders without the downloads row). Injectable fetch + clock for tests.

interface CacheEntry {
  key: string;
  fetchedAt: number;
  value: number;
}

let cache: CacheEntry | null = null;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1h — npm stats are daily/delayed

// Test seam: reset the module cache between cases.
export function __resetNpmCache(): void {
  cache = null;
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function fetchNpmDownloads(opts: {
  package: string;
  start: Date;
  end: Date;
  fetchFn?: typeof globalThis.fetch;
  now?: () => number;
}): Promise<number | null> {
  const fetchFn = opts.fetchFn ?? fetch;
  const now = opts.now ?? Date.now;
  const key = `${opts.package}:${ymd(opts.start)}:${ymd(opts.end)}`;

  if (cache !== null && cache.key === key && now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.value;
  }

  try {
    const url = `https://api.npmjs.org/downloads/range/${ymd(opts.start)}:${ymd(opts.end)}/${opts.package}`;
    const res = await fetchFn(url);
    if (!res.ok) throw new Error(`npm downloads HTTP ${res.status}`);
    const json = (await res.json()) as { downloads?: Array<{ downloads?: number }> };
    const total = (json.downloads ?? []).reduce((sum, d) => sum + (d.downloads ?? 0), 0);
    cache = { key, fetchedAt: now(), value: total };
    return total;
  } catch {
    // stale-if-error: serve the last good value for THIS window if the
    // cache holds it (even if expired); otherwise null.
    return cache !== null && cache.key === key ? cache.value : null;
  }
}
