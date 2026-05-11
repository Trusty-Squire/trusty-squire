// Adapter registry — looks up adapter manifests by id + version.
//
// Per-execution version pinning means in-flight runs always complete on
// their starting version, even if a newer manifest is registered
// mid-run. This package provides the in-memory implementation; the
// real registry is a separate service (chunk 9).

import type { AdapterManifest } from "@trusty-squire/adapter-sdk";

export interface AdapterRegistry {
  load(adapterId: string, version: string): Promise<AdapterManifest>;
}

export class AdapterNotFoundError extends Error {
  constructor(adapterId: string, version: string) {
    super(`Adapter not found: ${adapterId}@${version}`);
    this.name = "AdapterNotFoundError";
  }
}

export class InMemoryAdapterRegistry implements AdapterRegistry {
  private readonly manifests = new Map<string, AdapterManifest>();

  register(manifest: AdapterManifest): void {
    this.manifests.set(key(manifest.service, manifest.version), manifest);
  }

  async load(adapterId: string, version: string): Promise<AdapterManifest> {
    const manifest = this.manifests.get(key(adapterId, version));
    if (manifest === undefined) throw new AdapterNotFoundError(adapterId, version);
    return manifest;
  }
}

function key(adapterId: string, version: string): string {
  return `${adapterId}@${version}`;
}
