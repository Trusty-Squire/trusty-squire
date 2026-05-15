// Prisma-backed implementations of AliasStore and EmailStore.
//
// In-memory stores live alongside these for tests and the demo. Prod
// wires the Prisma variants via a shared PrismaClient (one per process)
// passed in at composition root.
//
// Schema: see packages/inbox/prisma/schema.prisma. Migrations live in
// prisma/migrations/. The `inbox_init` migration covers both models.
//
// The interfaces these classes implement (find / revoke / bumpInbound on
// AliasStore; insertIfAbsent / findByAlias on EmailStore) are the
// canonical names used by InboxService, SesHandler, and MailgunHandler.
// An earlier draft used findActive/incrementInbound/findMatching here;
// the rename happened in the in-memory store + call sites first, and
// this file lagged behind.

import type { PrismaClient } from "@prisma/client";
import type {
  AliasStore,
  EmailAliasRecord,
  EmailStore,
  ReceivedEmail,
} from "./types.js";

export class PrismaAliasStore implements AliasStore {
  constructor(private readonly prisma: PrismaClient) {}

  async insert(record: EmailAliasRecord): Promise<void> {
    await this.prisma.emailAlias.create({
      data: {
        alias: record.alias,
        account_id: record.account_id,
        run_id: record.run_id,
        service: record.service,
        issued_to: record.issued_to,
        active: record.active,
        inbound_count: record.inbound_count,
        created_at: record.created_at,
        expires_at: record.expires_at,
      },
    });
  }

  // Returns the alias regardless of active/expired state. Callers
  // (InboxService, SesHandler, MailgunHandler) decide what to do based
  // on `active` / `expires_at`. Mirrors InMemoryAliasStore.find.
  async find(alias: string): Promise<EmailAliasRecord | null> {
    const row = await this.prisma.emailAlias.findUnique({ where: { alias } });
    return row === null ? null : this.rowToRecord(row);
  }

  async revoke(alias: string): Promise<void> {
    // updateMany so missing rows are silent — callers may revoke
    // optimistically (e.g., MCP cleanup after signup), and a missing
    // row (alias never created, or already TTL-swept) is fine.
    await this.prisma.emailAlias.updateMany({
      where: { alias },
      data: { active: false },
    });
  }

  async bumpInbound(alias: string): Promise<void> {
    // Same updateMany rationale as revoke: SES misroutes for unknown
    // aliases shouldn't surface as P2025.
    await this.prisma.emailAlias.updateMany({
      where: { alias },
      data: { inbound_count: { increment: 1 } },
    });
  }

  private rowToRecord(row: {
    alias: string;
    account_id: string;
    run_id: string;
    service: string;
    issued_to: string | null;
    active: boolean;
    inbound_count: number;
    created_at: Date;
    expires_at: Date;
  }): EmailAliasRecord {
    return {
      alias: row.alias,
      account_id: row.account_id,
      run_id: row.run_id,
      service: row.service,
      issued_to: row.issued_to,
      active: row.active,
      inbound_count: row.inbound_count,
      created_at: row.created_at,
      expires_at: row.expires_at,
    };
  }
}

export class PrismaEmailStore implements EmailStore {
  constructor(private readonly prisma: PrismaClient) {}

  async insertIfAbsent(email: ReceivedEmail): Promise<{ inserted: boolean }> {
    try {
      // ReceivedEmail's optional-ish fields are typed `string | null`
      // (matches DB nullability), so nulls map cleanly to Prisma. No
      // conditional spread needed.
      await this.prisma.receivedEmail.create({
        data: {
          id: email.id,
          alias: email.alias,
          associated_run_id: email.associated_run_id,
          message_id: email.message_id,
          from_address: email.from_address,
          from_domain: email.from_domain,
          subject: email.subject,
          s3_raw_uri: email.s3_raw_uri,
          body_text: email.body_text,
          body_html: email.body_html,
          parsed_links: [...email.parsed_links],
          parsed_codes: [...email.parsed_codes],
          received_at: email.received_at,
          consumed_at: email.consumed_at,
          body_purged_at: email.body_purged_at,
        },
      });
      return { inserted: true };
    } catch (err) {
      // Unique-constraint on message_id: SES retry delivered the same
      // email twice. Treat as a no-op so the handler stays idempotent.
      if (isUniqueViolation(err)) return { inserted: false };
      throw err;
    }
  }

  async findByAlias(alias: string): Promise<ReceivedEmail[]> {
    const rows = await this.prisma.receivedEmail.findMany({
      where: { alias },
      // Most recent first — matches the in-memory contract and the
      // spec rule "return most recent matching".
      orderBy: { received_at: "desc" },
    });
    return rows.map(rowToReceivedEmail);
  }

  async markConsumed(id: string, at: Date): Promise<void> {
    await this.prisma.receivedEmail.update({
      where: { id },
      data: { consumed_at: at },
    });
  }
}

function rowToReceivedEmail(row: {
  id: string;
  alias: string;
  associated_run_id: string | null;
  message_id: string;
  from_address: string;
  from_domain: string;
  subject: string;
  s3_raw_uri: string;
  body_text: string | null;
  body_html: string | null;
  parsed_links: string[];
  parsed_codes: string[];
  received_at: Date;
  consumed_at: Date | null;
  body_purged_at: Date | null;
}): ReceivedEmail {
  // ReceivedEmail uses `| null` for absent fields (matches the DB).
  // Pass row columns through directly; no conditional spread needed.
  return {
    id: row.id,
    alias: row.alias,
    associated_run_id: row.associated_run_id,
    message_id: row.message_id,
    from_address: row.from_address,
    from_domain: row.from_domain,
    subject: row.subject,
    s3_raw_uri: row.s3_raw_uri,
    body_text: row.body_text,
    body_html: row.body_html,
    parsed_links: row.parsed_links,
    parsed_codes: row.parsed_codes,
    received_at: row.received_at,
    consumed_at: row.consumed_at,
    body_purged_at: row.body_purged_at,
  };
}

// Prisma's known-error code for unique-constraint violation. We don't
// import the type to keep the package's runtime deps narrow; checking
// the .code property is reliable across Prisma versions.
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "P2002"
  );
}
