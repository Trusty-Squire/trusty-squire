// In-memory implementations of AliasStore + EmailStore. Used by tests
// and for early dev. Production wires Prisma-backed implementations
// (intentionally not in this package — keeps the dep surface tight).

import type {
  AliasStore,
  EmailAliasRecord,
  EmailStore,
  ReceivedEmail,
} from "./types.js";

export class InMemoryAliasStore implements AliasStore {
  private readonly aliases = new Map<string, EmailAliasRecord>();

  async insert(record: EmailAliasRecord): Promise<void> {
    if (this.aliases.has(record.alias)) {
      throw new Error(`alias already registered: ${record.alias}`);
    }
    this.aliases.set(record.alias, { ...record });
  }

  async find(alias: string): Promise<EmailAliasRecord | null> {
    const r = this.aliases.get(alias);
    return r === undefined ? null : { ...r };
  }

  async revoke(alias: string): Promise<void> {
    const r = this.aliases.get(alias);
    if (r === undefined) return;
    r.active = false;
  }

  async bumpInbound(alias: string): Promise<void> {
    const r = this.aliases.get(alias);
    if (r === undefined) return;
    r.inbound_count += 1;
  }
}

export class InMemoryEmailStore implements EmailStore {
  private readonly emails = new Map<string, ReceivedEmail>(); // keyed by message_id

  async insertIfAbsent(record: ReceivedEmail): Promise<{ inserted: boolean }> {
    if (this.emails.has(record.message_id)) return { inserted: false };
    this.emails.set(record.message_id, clone(record));
    return { inserted: true };
  }

  async findByAlias(alias: string): Promise<ReceivedEmail[]> {
    const out: ReceivedEmail[] = [];
    for (const e of this.emails.values()) {
      if (e.alias === alias) out.push(clone(e));
    }
    // Most recent first — matches Postgres index ordering and the
    // spec rule "return most recent matching".
    out.sort((a, b) => b.received_at.getTime() - a.received_at.getTime());
    return out;
  }

  async markConsumed(id: string, consumedAt: Date): Promise<void> {
    for (const e of this.emails.values()) {
      if (e.id === id) {
        e.consumed_at = consumedAt;
        return;
      }
    }
  }
}

function clone(e: ReceivedEmail): ReceivedEmail {
  return {
    ...e,
    parsed_links: [...e.parsed_links],
    parsed_codes: [...e.parsed_codes],
  };
}
