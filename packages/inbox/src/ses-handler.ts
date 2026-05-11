// SES inbound handler — turns an SNS notification into a
// ReceivedEmail row. The actual S3 fetch is behind the
// RawEmailFetcher interface so tests don't need AWS.
//
// SES + SNS contract: SES writes the raw RFC 822 to S3, then publishes
// an SNS notification with the bucket / object key. The HTTP webhook
// (apps/inbox-api/src/routes/ses-inbound.ts) deserialises the SNS
// envelope and calls into this handler.

import type { Buffer } from "node:buffer";
import { parseRfc822 } from "./parser.js";
import { buildReceivedEmail } from "./inbox-service.js";
import {
  EncryptedEmailError,
  type AliasStore,
  type EmailStore,
  type ReceivedEmail,
} from "./types.js";

// What the handler expects after SNS deserialisation. Keep narrow —
// SES's "Notification" payload has many fields, we only consume the
// S3 pointer + a couple of metadata convenience fields.
export interface SesInboundNotification {
  bucket: string;
  key: string;
  // Optional — SES includes the to-address in the notification metadata
  // so we can route without parsing first. Falls back to recipient
  // extraction from the parsed RFC 822 if absent.
  recipients?: string[];
}

export interface RawEmailFetcher {
  fetch(bucket: string, key: string): Promise<Buffer>;
}

export interface SesHandlerDeps {
  aliasStore: AliasStore;
  emailStore: EmailStore;
  fetcher: RawEmailFetcher;
  now?: () => Date;
}

export type IngestOutcome =
  | { kind: "stored"; email: ReceivedEmail }
  | { kind: "duplicate"; message_id: string }
  | { kind: "no_alias_match"; recipients: string[] }
  | { kind: "encrypted_rejected" };

export class SesHandler {
  constructor(private readonly deps: SesHandlerDeps) {}

  async ingest(notification: SesInboundNotification): Promise<IngestOutcome> {
    const raw = await this.deps.fetcher.fetch(notification.bucket, notification.key);

    let parsed;
    try {
      parsed = await parseRfc822(raw);
    } catch (err) {
      if (err instanceof EncryptedEmailError) {
        return { kind: "encrypted_rejected" };
      }
      throw err;
    }

    // Resolve the alias the email landed at. Prefer the SNS-supplied
    // recipients (cheap), fall back to parsed To: addresses.
    const recipients =
      notification.recipients !== undefined && notification.recipients.length > 0
        ? notification.recipients
        : parsed.to_addresses;

    let aliasRecord = null;
    let alias: string | null = null;
    for (const r of recipients) {
      const candidate = r.toLowerCase();
      const found = await this.deps.aliasStore.find(candidate);
      if (found !== null) {
        aliasRecord = found;
        alias = candidate;
        break;
      }
    }

    if (alias === null || aliasRecord === null) {
      return { kind: "no_alias_match", recipients };
    }

    const now = this.deps.now?.() ?? new Date();
    const email = buildReceivedEmail({
      alias,
      associated_run_id: aliasRecord.run_id,
      message_id: parsed.message_id,
      from_address: parsed.from_address,
      from_domain: parsed.from_domain,
      subject: parsed.subject,
      s3_raw_uri: `s3://${notification.bucket}/${notification.key}`,
      body_text: parsed.body_text,
      body_html: parsed.body_html,
      parsed_links: parsed.links,
      parsed_codes: parsed.codes,
      received_at: now,
    });

    const result = await this.deps.emailStore.insertIfAbsent(email);
    if (!result.inserted) {
      // RFC 822 Message-ID dedupe — SES retries that re-deliver the
      // same email hit this branch. We DO NOT bump inbound_count for
      // duplicates (would skew alias rate-limit signals).
      return { kind: "duplicate", message_id: parsed.message_id };
    }
    await this.deps.aliasStore.bumpInbound(alias);
    return { kind: "stored", email };
  }
}
