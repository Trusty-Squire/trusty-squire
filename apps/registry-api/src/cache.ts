// Per-worker manifest cache. Manifests are immutable per (service,
// version) and disabled flips return 410 — meaning a cached `null`
// would cache a not-found, which we don't want. Cache only successful
// reads; misses go to the store every time.

import type { ManifestRecord } from "./types.js";

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1h

interface CacheEntry {
  record: ManifestRecord;
  expires_at: number;
}

export class ManifestCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(
    private readonly ttlMs: number = DEFAULT_TTL_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get(service: string, version: string): ManifestRecord | null {
    const key = this.key(service, version);
    const entry = this.entries.get(key);
    if (entry === undefined) return null;
    if (entry.expires_at <= this.now()) {
      this.entries.delete(key);
      return null;
    }
    return entry.record;
  }

  set(record: ManifestRecord): void {
    this.entries.set(this.key(record.service, record.version), {
      record,
      expires_at: this.now() + this.ttlMs,
    });
  }

  invalidate(service: string, version: string): void {
    this.entries.delete(this.key(service, version));
  }

  size(): number {
    return this.entries.size;
  }

  private key(service: string, version: string): string {
    return `${service}@${version}`;
  }
}
