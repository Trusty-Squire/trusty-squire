// InboxService — public API the runtime's wait_for_email step
// executor (and external callers) use. Polling-based: every 2s the
// service checks for new mail at the given alias until a matcher hits
// or the deadline passes.

import { ulid } from "ulid";
import { extractLinks, extractOtp, matchString } from "./parser.js";
import { generateAlias } from "./alias-generator.js";
import {
  AliasInactiveError,
  EmailTimeoutError,
  type AliasStore,
  type CreateAliasInput,
  type EmailMatcher,
  type EmailStore,
  type ReceivedEmail,
  type WaitForEmailInput,
} from "./types.js";

const DEFAULT_TTL_SECONDS = 24 * 60 * 60;
const POLL_INTERVAL_MS = 2_000;

export interface InboxServiceDeps {
  aliasStore: AliasStore;
  emailStore: EmailStore;
  // Pluggable for tests; defaults to a real setTimeout-backed sleep.
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  // Domain override for the alias suffix; tests override.
  domain?: string;
  pollIntervalMs?: number;
}

export class InboxService {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => Date;
  private readonly pollIntervalMs: number;

  constructor(private readonly deps: InboxServiceDeps) {
    this.sleep = deps.sleep ?? defaultSleep;
    this.now = deps.now ?? (() => new Date());
    this.pollIntervalMs = deps.pollIntervalMs ?? POLL_INTERVAL_MS;
  }

  async createAlias(input: CreateAliasInput): Promise<string> {
    const alias = generateAlias(input.account_id, input.service, input.run_id, {
      ...(this.deps.domain !== undefined ? { domain: this.deps.domain } : {}),
    });
    const ttlSeconds = input.ttl_seconds ?? DEFAULT_TTL_SECONDS;
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + ttlSeconds * 1000);

    await this.deps.aliasStore.insert({
      alias,
      account_id: input.account_id,
      run_id: input.run_id,
      service: input.service,
      active: true,
      inbound_count: 0,
      created_at: createdAt,
      expires_at: expiresAt,
    });
    return alias;
  }

  async waitForEmail(input: WaitForEmailInput): Promise<ReceivedEmail> {
    // Up-front alias check. A revoked or expired alias should fail
    // fast rather than burn a 60s timeout. Re-checking inside the loop
    // would catch alias revocation mid-wait, but the polling cadence
    // is the dominant cost — once per loop is enough.
    await this.assertAliasActive(input.alias);

    const deadline = this.now().getTime() + input.timeout_seconds * 1000;

    while (true) {
      const emails = await this.deps.emailStore.findByAlias(input.alias);
      // findByAlias already sorts most-recent-first.
      const match = emails.find(
        (e) => e.consumed_at === null && emailMatches(e, input.matcher),
      );
      if (match !== undefined) {
        await this.deps.emailStore.markConsumed(match.id, this.now());
        return match;
      }

      if (this.now().getTime() >= deadline) {
        throw new EmailTimeoutError(input.alias, input.timeout_seconds);
      }
      await this.sleep(this.pollIntervalMs);
    }
  }

  // Pull a link from the email body. If `pattern` is supplied, only
  // links matching it are eligible; otherwise the first parsed link
  // wins. Re-extracts from raw bodies on demand so callers can ask
  // even if the row didn't pre-parse anything.
  async parseLink(email: ReceivedEmail, pattern?: string | RegExp): Promise<string | null> {
    const candidates =
      email.parsed_links.length > 0
        ? email.parsed_links
        : extractLinks((email.body_text ?? "") + " " + (email.body_html ?? ""));
    if (candidates.length === 0) return null;
    if (pattern === undefined) return candidates[0] ?? null;
    for (const link of candidates) {
      if (matchString(link, pattern)) return link;
    }
    return null;
  }

  // OTP extraction. Falls back to re-parsing the body if the
  // ReceivedEmail came in without parsed_codes (e.g. a test fixture).
  async parseCode(email: ReceivedEmail, pattern?: RegExp): Promise<string | null> {
    if (pattern !== undefined) {
      const content = (email.body_text ?? "") + " " + (email.body_html ?? "");
      return extractOtp(content, pattern);
    }
    if (email.parsed_codes.length > 0) return email.parsed_codes[0] ?? null;
    const content = (email.body_text ?? "") + " " + (email.body_html ?? "");
    return extractOtp(content);
  }

  async revokeAlias(alias: string): Promise<void> {
    await this.deps.aliasStore.revoke(alias);
  }

  // ── Internals ────────────────────────────────────────────────

  private async assertAliasActive(alias: string): Promise<void> {
    const record = await this.deps.aliasStore.find(alias);
    if (record === null || !record.active || record.expires_at <= this.now()) {
      throw new AliasInactiveError(alias);
    }
  }
}

export function emailMatches(email: ReceivedEmail, matcher: EmailMatcher): boolean {
  if (matcher.from !== undefined && !matchString(email.from_address, matcher.from)) {
    return false;
  }
  if (matcher.subject !== undefined && !matchString(email.subject, matcher.subject)) {
    return false;
  }
  if (matcher.body_contains !== undefined) {
    const body = (email.body_text ?? "") + " " + (email.body_html ?? "");
    if (!matchString(body, matcher.body_contains)) return false;
  }
  return true;
}

// Backward-compat helper for callers building ReceivedEmail records
// outside the SES handler (e.g. tests). Keeps the ULID generation in
// one place so the service can be deterministic when its now() is.
export function buildReceivedEmail(input: {
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
}): ReceivedEmail {
  return {
    id: ulid(),
    alias: input.alias,
    associated_run_id: input.associated_run_id,
    message_id: input.message_id,
    from_address: input.from_address,
    from_domain: input.from_domain,
    subject: input.subject,
    s3_raw_uri: input.s3_raw_uri,
    body_text: input.body_text,
    body_html: input.body_html,
    parsed_links: input.parsed_links,
    parsed_codes: input.parsed_codes,
    received_at: input.received_at,
    consumed_at: null,
    body_purged_at: null,
  };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
