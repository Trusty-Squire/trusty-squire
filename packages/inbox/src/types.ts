// Inbox types — public + internal data shapes.
//
// The `EmailMatcher` is what callers (the runtime's wait_for_email
// step executor) supply to filter inbound mail. Pattern fields accept
// strings (substring match, case-insensitive) or RegExp.

export interface ReceivedEmail {
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
}

export interface EmailAliasRecord {
  alias: string;
  account_id: string;
  run_id: string;
  service: string;
  active: boolean;
  inbound_count: number;
  created_at: Date;
  expires_at: Date;
}

export interface EmailMatcher {
  from?: string | RegExp;
  subject?: string | RegExp;
  body_contains?: string | RegExp;
}

export interface CreateAliasInput {
  account_id: string;
  run_id: string;
  service: string;
  // Optional override of the default expiry (default 24h).
  ttl_seconds?: number;
}

export interface WaitForEmailInput {
  alias: string;
  matcher: EmailMatcher;
  timeout_seconds: number;
}

export class InboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InboxError";
  }
}

export class EmailTimeoutError extends InboxError {
  constructor(public readonly alias: string, public readonly timeoutSeconds: number) {
    super(`no matching email at ${alias} within ${timeoutSeconds}s`);
    this.name = "EmailTimeoutError";
  }
}

export class AliasInactiveError extends InboxError {
  constructor(alias: string) {
    super(`alias ${alias} is revoked or expired`);
    this.name = "AliasInactiveError";
  }
}

export class EncryptedEmailError extends InboxError {
  constructor() {
    super("PGP/encrypted email is not supported");
    this.name = "EncryptedEmailError";
  }
}

// ── Storage seam (DI for tests) ──────────────────────────────

export interface AliasStore {
  insert(record: EmailAliasRecord): Promise<void>;
  find(alias: string): Promise<EmailAliasRecord | null>;
  revoke(alias: string): Promise<void>;
  bumpInbound(alias: string): Promise<void>;
}

export interface EmailStore {
  insertIfAbsent(record: ReceivedEmail): Promise<{ inserted: boolean }>;
  findByAlias(alias: string): Promise<ReceivedEmail[]>;
  markConsumed(id: string, consumedAt: Date): Promise<void>;
}
