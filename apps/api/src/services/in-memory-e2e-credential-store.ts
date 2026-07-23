import { ulid } from "ulid";

export interface E2ECredentialRecord {
  id: string;
  accountId: string;
  label: string;
  blob: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface E2ECredentialSummary {
  id: string;
  label: string;
  createdAt: Date;
}

export interface E2ECredentialStore {
  create(accountId: string, label: string, blob: string): Promise<string>;
  listByAccount(accountId: string): Promise<E2ECredentialSummary[]>;
  getByIdForAccount(id: string, accountId: string): Promise<E2ECredentialRecord | null>;
  deleteForAccount(id: string, accountId: string): Promise<boolean>;
}

export class InMemoryE2ECredentialStore implements E2ECredentialStore {
  private readonly records = new Map<string, E2ECredentialRecord>();
  private readonly now: () => Date;

  constructor(now?: () => Date) {
    this.now = now ?? (() => new Date());
  }

  async create(accountId: string, label: string, blob: string): Promise<string> {
    const at = this.now();
    const record: E2ECredentialRecord = {
      id: ulid(),
      accountId,
      label,
      blob,
      createdAt: at,
      updatedAt: at,
    };
    this.records.set(record.id, record);
    return record.id;
  }

  async listByAccount(accountId: string): Promise<E2ECredentialSummary[]> {
    return [...this.records.values()]
      .filter((record) => record.accountId === accountId)
      .sort((a, b) => {
        const createdAtOrder = b.createdAt.getTime() - a.createdAt.getTime();
        if (createdAtOrder !== 0) return createdAtOrder;
        return a.id === b.id ? 0 : a.id < b.id ? 1 : -1;
      })
      .map(({ id, label, createdAt }) => ({ id, label, createdAt }));
  }

  async getByIdForAccount(id: string, accountId: string): Promise<E2ECredentialRecord | null> {
    const record = this.records.get(id);
    return record === undefined || record.accountId !== accountId ? null : { ...record };
  }

  async deleteForAccount(id: string, accountId: string): Promise<boolean> {
    const record = this.records.get(id);
    if (record === undefined || record.accountId !== accountId) return false;
    return this.records.delete(id);
  }
}
