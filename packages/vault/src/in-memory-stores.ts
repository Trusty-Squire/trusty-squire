// In-memory implementations of CredentialStore + VaultAuditStore.
//
// Used by tests + early dev. Production wires Prisma-backed
// implementations (intentionally not in this package — that's a deploy
// concern; this package keeps its dependency surface minimal).

import { Buffer } from "node:buffer";
import { ulid } from "ulid";
import type {
  CredentialRecord,
  CredentialStore,
  VaultAuditEventInput,
  VaultAuditPayload,
  VaultAuditStore,
} from "./types.js";

export class InMemoryCredentialStore implements CredentialStore {
  private readonly byReference = new Map<string, CredentialRecord>();

  async insert(record: CredentialRecord): Promise<void> {
    if (this.byReference.has(record.reference)) {
      throw new Error(`credential already exists at ${record.reference}`);
    }
    this.byReference.set(record.reference, clone(record));
  }

  async findActive(reference: string): Promise<CredentialRecord | null> {
    const r = this.byReference.get(reference);
    if (r === undefined || r.deleted_at !== null) return null;
    return clone(r);
  }

  async markRetrieved(reference: string, retrievedAt: Date): Promise<void> {
    const r = this.byReference.get(reference);
    if (r === undefined) return;
    r.retrieval_count += 1;
    r.last_retrieved_at = retrievedAt;
  }

  async softDelete(reference: string, deletedAt: Date): Promise<void> {
    const r = this.byReference.get(reference);
    if (r === undefined) return;
    r.deleted_at = deletedAt;
  }

  async rotate(reference: string, ciphertext: Buffer, rotatedAt: Date): Promise<void> {
    const r = this.byReference.get(reference);
    if (r === undefined) throw new Error(`credential not found: ${reference}`);
    r.ciphertext = Buffer.from(ciphertext);
    r.rotated_at = rotatedAt;
  }
}

export interface InMemoryAuditEvent extends VaultAuditEventInput {
  id: string;
  emitted_at: Date;
}

export class InMemoryVaultAuditStore implements VaultAuditStore {
  public readonly events: InMemoryAuditEvent[] = [];

  async record(event: VaultAuditEventInput): Promise<void> {
    this.events.push({
      id: ulid(),
      emitted_at: new Date(),
      account_id: event.account_id,
      type: event.type,
      payload: clonePayload(event.payload),
    });
  }

  async countRecentRetrievals(accountId: string, since: Date): Promise<number> {
    return this.events.filter(
      (e) =>
        e.account_id === accountId &&
        e.type === "vault.credential_retrieved" &&
        e.emitted_at >= since,
    ).length;
  }
}

function clonePayload(p: VaultAuditPayload): VaultAuditPayload {
  return { ...p };
}

function clone<T extends CredentialRecord>(r: T): T {
  return {
    ...r,
    ciphertext: Buffer.from(r.ciphertext),
    encrypted_dek: Buffer.from(r.encrypted_dek),
    account_kek_blob: Buffer.from(r.account_kek_blob),
    metadata: { ...r.metadata },
  };
}
