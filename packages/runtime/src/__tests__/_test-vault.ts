// In-memory VaultClient for runtime tests. Records what was stored,
// fakes retrieval, and lets tests inject failures via the throwOn
// option. The real vault implementation arrives in chunk 6.

import { ulid } from "ulid";
import type {
  DeviceAssertion,
  VaultClient,
  VaultEntry,
  VaultStoreInput,
} from "../vault-client.js";

export interface MockVaultOptions {
  // When the next store call should throw — counts down on each call.
  throwOnStoreNumber?: number | null;
  // Triggered when retrieveForRuntime is called with a missing reference.
  throwOnMissingRetrieve?: boolean;
}

export class MockVault implements VaultClient {
  public readonly stored: Array<{ entry: VaultEntry; input: VaultStoreInput }> = [];
  public readonly deletedRefs: string[] = [];
  public readonly retrievedRefs: string[] = [];
  private storeCalls = 0;

  constructor(private readonly options: MockVaultOptions = {}) {}

  async store(input: VaultStoreInput): Promise<VaultEntry> {
    this.storeCalls++;
    if (
      this.options.throwOnStoreNumber !== undefined &&
      this.options.throwOnStoreNumber !== null &&
      this.storeCalls === this.options.throwOnStoreNumber
    ) {
      throw new Error(`mock vault: forced failure on store call #${this.storeCalls}`);
    }
    const entry: VaultEntry = {
      reference: `mockvault://entry/${ulid()}`,
      type: input.type,
      created_at: new Date().toISOString(),
    };
    this.stored.push({ entry, input });
    return entry;
  }

  async retrieve(
    reference: string,
    _purpose: string,
    _assertion: DeviceAssertion,
  ): Promise<string> {
    return this.retrieveForRuntime(reference, "user_assertion");
  }

  async retrieveForRuntime(reference: string, _purpose: string): Promise<string> {
    this.retrievedRefs.push(reference);
    const stored = this.stored.find((s) => s.entry.reference === reference);
    if (stored === undefined) {
      if (this.options.throwOnMissingRetrieve === true) {
        throw new Error(`mock vault: no entry at ${reference}`);
      }
      // Default: surface a synthetic value so reverse-http tests don't
      // need to seed the vault first.
      return `mock-secret-for-${reference}`;
    }
    return stored.input.value;
  }

  async delete(reference: string): Promise<void> {
    this.deletedRefs.push(reference);
    const idx = this.stored.findIndex((s) => s.entry.reference === reference);
    if (idx >= 0) this.stored.splice(idx, 1);
  }

  async rotate(_reference: string, _newValue: string): Promise<void> {
    // No-op for chunk-5 tests; rotation lifecycle exercised in later chunks.
  }
}
