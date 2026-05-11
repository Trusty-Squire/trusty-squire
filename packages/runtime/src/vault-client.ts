// VaultClient — interface only. The actual implementation (HSM-backed
// encryption + per-account KEK derivation) lands in chunk 6.
//
// Two retrieve paths exist intentionally:
//   - retrieve(reference, purpose, deviceAssertion): user-driven reads,
//     gated on a fresh device signature (the user explicitly authorised
//     this read).
//   - retrieveForRuntime(reference, purpose): runtime-driven reads
//     (compensation, scheduled rotations) where there's no fresh user
//     signature. Chunk 6 will gate this on a separate "runtime
//     authority" key with a stricter audit trail.

import type { CredentialType } from "./types.js";

export interface VaultStoreInput {
  account_id: string;
  subscription_id: string;
  type: CredentialType;
  value: string;
  env_var_suggestion: string | null;
  metadata: Record<string, unknown>;
}

export interface VaultEntry {
  reference: string;
  type: CredentialType;
  created_at: string;
}

export interface DeviceAssertion {
  signature: string;
  signed_at: string;
  signing_device_id: string;
}

export interface VaultClient {
  store(input: VaultStoreInput): Promise<VaultEntry>;
  retrieve(
    reference: string,
    purpose: string,
    deviceAssertion: DeviceAssertion,
  ): Promise<string>;
  // Runtime-internal retrieve. Chunk-6 implementation will require a
  // signed runtime-authority assertion in production; the chunk-5
  // mock lets it through.
  retrieveForRuntime(reference: string, purpose: string): Promise<string>;
  delete(reference: string): Promise<void>;
  rotate(reference: string, newValue: string): Promise<void>;
}

export class VaultUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultUnavailableError";
  }
}
