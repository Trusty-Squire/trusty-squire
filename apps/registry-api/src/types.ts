// Public-facing response shapes + internal record types.

import type { AdapterManifest } from "@trusty-squire/adapter-sdk";

export interface ManifestResponseBody {
  manifest: AdapterManifest;
  signature: string;
  signed_at: string;
  signed_by: string;
}

export interface ManifestRecord {
  service: string;
  version: string;
  manifest: AdapterManifest;
  signature: string;
  signed_at: Date;
  signed_by: string;
  disabled_at: Date | null;
  disabled_reason: string | null;
  created_at: Date;
}

export interface AdapterDirectoryEntry {
  service: string;
  latest_version: string;
  display_name: string;
  category: string;
  homepage: string;
  description: string | null;
}
