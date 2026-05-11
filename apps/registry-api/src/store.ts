// Manifest persistence layer. Two implementations live here so the
// registry-api can run + test without a database — InMemory for
// tests, Prisma-backed for production. Both share the same interface.

import type { AdapterManifest } from "@trusty-squire/adapter-sdk";
import type { ManifestRecord } from "./types.js";

export interface InsertManifestInput {
  service: string;
  version: string;
  manifest: AdapterManifest;
  signature: string;
  signed_at: Date;
  signed_by: string;
}

export class ManifestConflictError extends Error {
  constructor(service: string, version: string) {
    super(`manifest already published: ${service}@${version}`);
    this.name = "ManifestConflictError";
  }
}

export interface ManifestStore {
  insert(input: InsertManifestInput): Promise<void>;
  get(service: string, version: string): Promise<ManifestRecord | null>;
  listVersions(service: string): Promise<ManifestRecord[]>;
  listLatestByService(): Promise<ManifestRecord[]>;
  disable(service: string, version: string, reason: string): Promise<void>;
}

// In-memory implementation. Maintains insertion order; tests can
// inspect internals via the public list methods.
export class InMemoryManifestStore implements ManifestStore {
  private readonly records = new Map<string, ManifestRecord>();

  private key(service: string, version: string): string {
    return `${service}@${version}`;
  }

  async insert(input: InsertManifestInput): Promise<void> {
    const key = this.key(input.service, input.version);
    if (this.records.has(key)) {
      throw new ManifestConflictError(input.service, input.version);
    }
    this.records.set(key, {
      ...input,
      disabled_at: null,
      disabled_reason: null,
      created_at: new Date(),
    });
  }

  async get(service: string, version: string): Promise<ManifestRecord | null> {
    const r = this.records.get(this.key(service, version));
    return r === undefined ? null : cloneRecord(r);
  }

  async listVersions(service: string): Promise<ManifestRecord[]> {
    const out: ManifestRecord[] = [];
    for (const r of this.records.values()) {
      if (r.service === service) out.push(cloneRecord(r));
    }
    return out;
  }

  async listLatestByService(): Promise<ManifestRecord[]> {
    const latest = new Map<string, ManifestRecord>();
    for (const r of this.records.values()) {
      if (r.disabled_at !== null) continue;
      const prev = latest.get(r.service);
      if (prev === undefined || r.created_at > prev.created_at) {
        latest.set(r.service, r);
      }
    }
    return [...latest.values()].map(cloneRecord);
  }

  async disable(service: string, version: string, reason: string): Promise<void> {
    const r = this.records.get(this.key(service, version));
    if (r === undefined) return;
    r.disabled_at = new Date();
    r.disabled_reason = reason;
  }
}

// Defensive clone so callers can't mutate the store's internal state
// (and a previously-cached value isn't observably affected by a later
// disable() against the same record). Mirrors Postgres-row semantics.
function cloneRecord(r: ManifestRecord): ManifestRecord {
  return {
    ...r,
    manifest: JSON.parse(JSON.stringify(r.manifest)) as ManifestRecord["manifest"],
    signed_at: new Date(r.signed_at),
    disabled_at: r.disabled_at === null ? null : new Date(r.disabled_at),
    created_at: new Date(r.created_at),
  };
}
