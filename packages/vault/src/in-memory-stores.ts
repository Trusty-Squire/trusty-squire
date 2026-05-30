// In-memory implementations of CredentialStore + VaultAuditStore.
// Used by tests + early dev; production wires Prisma-backed equivalents.

import { Buffer } from "node:buffer";
import { ulid } from "ulid";
import type {
  CredentialRecord,
  CredentialStore,
  VaultAuditEventInput,
  VaultAuditListOptions,
  VaultAuditPayload,
  VaultAuditRecord,
  VaultAuditStore,
} from "./types.js";

const AUDIT_LIST_MAX = 200;

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

  async findActiveByServiceLabel(
    accountId: string,
    service: string,
    label: string,
  ): Promise<CredentialRecord | null> {
    const want = service.toLowerCase();
    const matches = [...this.byReference.values()].filter(
      (r) =>
        r.account_id === accountId &&
        r.deleted_at === null &&
        r.label === label &&
        typeof r.metadata.service === "string" &&
        (r.metadata.service as string).toLowerCase() === want,
    );
    matches.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
    return matches[0] === undefined ? null : clone(matches[0]);
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

  async replaceSecret(
    reference: string,
    payload: {
      ciphertext: Buffer;
      encrypted_dek: Buffer;
      account_kek_blob: Buffer;
      field_names: string[];
      rotatedAt: Date;
    },
  ): Promise<void> {
    const r = this.byReference.get(reference);
    if (r === undefined) throw new Error(`credential not found: ${reference}`);
    r.ciphertext = Buffer.from(payload.ciphertext);
    r.encrypted_dek = Buffer.from(payload.encrypted_dek);
    r.account_kek_blob = Buffer.from(payload.account_kek_blob);
    r.field_names = [...payload.field_names];
    r.rotated_at = payload.rotatedAt;
  }

  async listByAccount(accountId: string): Promise<CredentialRecord[]> {
    return [...this.byReference.values()]
      .filter((r) => r.account_id === accountId && r.deleted_at === null)
      .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
      .map((r) => clone(r));
  }

  async listByAccountIncludingDeleted(accountId: string): Promise<CredentialRecord[]> {
    return [...this.byReference.values()]
      .filter((r) => r.account_id === accountId)
      .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
      .map((r) => clone(r));
  }

  async findByIdForAccount(
    id: string,
    accountId: string,
  ): Promise<CredentialRecord | null> {
    const r = [...this.byReference.values()].find(
      (c) => c.id === id && c.account_id === accountId && c.deleted_at === null,
    );
    return r === undefined ? null : clone(r);
  }

  async setAllowedHosts(reference: string, hosts: string[]): Promise<void> {
    const r = this.byReference.get(reference);
    if (r === undefined) return;
    r.allowed_hosts = [...hosts];
  }

  async purgeAccount(accountId: string): Promise<number> {
    let removed = 0;
    for (const [ref, rec] of this.byReference) {
      if (rec.account_id === accountId) {
        this.byReference.delete(ref);
        removed += 1;
      }
    }
    return removed;
  }
}

export interface InMemoryAuditEvent extends VaultAuditEventInput {
  id: string;
  emitted_at: Date;
}

export class InMemoryVaultAuditStore implements VaultAuditStore {
  public readonly events: InMemoryAuditEvent[] = [];

  // Clock injectable so tests that drive the vault with a fixed now()
  // stamp audit events on the same timeline the rate-limit window reads.
  constructor(private readonly now: () => Date = () => new Date()) {}

  async record(event: VaultAuditEventInput): Promise<void> {
    this.events.push({
      id: ulid(),
      emitted_at: this.now(),
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

  async list(accountId: string, opts: VaultAuditListOptions = {}): Promise<VaultAuditRecord[]> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), AUDIT_LIST_MAX);
    return this.events
      .filter(
        (e) =>
          e.account_id === accountId &&
          (opts.type === undefined || e.type === opts.type) &&
          (opts.reference === undefined || e.payload.reference === opts.reference) &&
          (opts.before === undefined || e.emitted_at < opts.before),
      )
      .sort((a, b) => b.emitted_at.getTime() - a.emitted_at.getTime())
      .slice(0, limit)
      .map((e) => ({
        id: e.id,
        account_id: e.account_id,
        type: e.type,
        payload: clonePayload(e.payload),
        emitted_at: e.emitted_at,
      }));
  }

  async exportAll(accountId: string): Promise<VaultAuditRecord[]> {
    return this.events
      .filter((e) => e.account_id === accountId)
      .sort((a, b) => b.emitted_at.getTime() - a.emitted_at.getTime())
      .map((e) => ({
        id: e.id,
        account_id: e.account_id,
        type: e.type,
        payload: clonePayload(e.payload),
        emitted_at: e.emitted_at,
      }));
  }

  async purgeAccount(accountId: string): Promise<number> {
    let removed = 0;
    for (let i = this.events.length - 1; i >= 0; i--) {
      if (this.events[i]!.account_id === accountId) {
        this.events.splice(i, 1);
        removed += 1;
      }
    }
    return removed;
  }
}

function clonePayload(p: VaultAuditPayload): VaultAuditPayload {
  return { ...p };
}

function clone<T extends CredentialRecord>(r: T): T {
  return {
    ...r,
    field_names: [...r.field_names],
    allowed_hosts: [...r.allowed_hosts],
    ciphertext: Buffer.from(r.ciphertext),
    encrypted_dek: Buffer.from(r.encrypted_dek),
    account_kek_blob: Buffer.from(r.account_kek_blob),
    metadata: { ...r.metadata },
  };
}
