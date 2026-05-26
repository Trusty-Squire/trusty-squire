// Resend inbound email handler — rc.19 cutover.
//
// Resend's inbound webhook posts already-parsed email payloads, so
// there's no S3 fetch step (the SesHandler's main bit of complexity).
// The shape mirrors what Resend documents for `email.received`
// events: a single email with from/to/subject/text/html and an
// RFC-822 Message-ID for dedupe.
//
// Modelled after MailgunHandler — same alias-lookup + dedupe +
// store flow, same IngestOutcome shape so the route's handler can
// switch on outcome.kind uniformly across providers.

import { extractLinks, extractOtp } from "./parser.js";
import type { AliasStore, EmailStore } from "./types.js";
import { ulid } from "ulid";

// Subset of Resend's `email.received` event we read. The full payload
// carries headers, attachments, raw EML, and Resend's own message id;
// we only need the fields below for the ReceivedEmail row.
export interface ResendInboundPayload {
  // Resend's own event id (Svix-style `evt_xxx` or `email_xxx`).
  // Different from the RFC-822 Message-ID below — kept distinct.
  id?: string;
  // The original RFC-822 Message-ID from the email's headers. This
  // is what the dedupe lookup uses.
  message_id: string;
  from: string;
  // Resend delivers `to` as an array; some shapes flatten to a
  // string. Accept both.
  to: string | string[];
  subject: string;
  text?: string | null;
  html?: string | null;
  received_at?: string;
}

export interface ResendHandlerDeps {
  aliasStore: AliasStore;
  emailStore: EmailStore;
  now?: () => Date;
}

export type ResendIngestOutcome =
  | { kind: "stored"; email: { id: string; alias: string } }
  | { kind: "duplicate"; message_id: string }
  | { kind: "no_alias_match"; recipients: string[] }
  | { kind: "missing_message_id" };

export class ResendHandler {
  constructor(private readonly deps: ResendHandlerDeps) {}

  async ingest(payload: ResendInboundPayload): Promise<ResendIngestOutcome> {
    const messageId = payload.message_id;
    if (typeof messageId !== "string" || messageId.length === 0) {
      return { kind: "missing_message_id" };
    }

    const recipients = normaliseRecipients(payload.to);
    if (recipients.length === 0) {
      return { kind: "no_alias_match", recipients: [] };
    }

    // Walk the recipients to find the first one we have an alias for.
    let alias: string | null = null;
    let aliasRecord = null;
    for (const r of recipients) {
      const candidate = r.toLowerCase();
      const found = await this.deps.aliasStore.find(candidate);
      if (found !== null && found.active) {
        alias = candidate;
        aliasRecord = found;
        break;
      }
    }
    if (alias === null || aliasRecord === null) {
      return { kind: "no_alias_match", recipients };
    }

    // Dedupe on RFC-822 Message-ID. Resend retries that re-deliver
    // the same email hit this branch; we do not bump inbound_count.
    const existing = await this.deps.emailStore.findByAlias(alias);
    const duplicate = existing.find((e) => e.message_id === messageId);
    if (duplicate !== undefined) {
      return { kind: "duplicate", message_id: messageId };
    }

    const bodyText = typeof payload.text === "string" && payload.text.length > 0 ? payload.text : null;
    const bodyHtml = typeof payload.html === "string" && payload.html.length > 0 ? payload.html : null;
    const links = bodyText !== null ? extractLinks(bodyText) : [];
    const codes = bodyText !== null ? collectOtpCodes(bodyText) : [];

    const fromDomain = (payload.from.split("@")[1] ?? "").toLowerCase();
    const id = ulid();
    const receivedAt = parseReceivedAt(payload.received_at, this.deps.now);

    await this.deps.emailStore.insertIfAbsent({
      id,
      alias,
      associated_run_id: aliasRecord.run_id,
      message_id: messageId,
      from_address: payload.from,
      from_domain: fromDomain,
      subject: payload.subject,
      // Resend doesn't write a raw EML to S3; the field is part of the
      // ReceivedEmail shape so we leave it empty. Callers that try to
      // reconstruct the original email get nothing — for the bot's
      // signup-verification flow that's fine (we only need links and
      // body_text).
      s3_raw_uri: "",
      body_text: bodyText,
      body_html: bodyHtml,
      parsed_links: links,
      parsed_codes: codes,
      received_at: receivedAt,
      consumed_at: null,
      body_purged_at: null,
    });
    await this.deps.aliasStore.bumpInbound(alias);
    return { kind: "stored", email: { id, alias } };
  }
}

function normaliseRecipients(to: string | string[]): string[] {
  if (typeof to === "string") return [to];
  if (Array.isArray(to)) {
    return to.filter((r): r is string => typeof r === "string");
  }
  return [];
}

function parseReceivedAt(raw: string | undefined, now?: () => Date): Date {
  if (typeof raw === "string" && raw.length > 0) {
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return now?.() ?? new Date();
}

// extractOtp returns the highest-confidence single code. The handler's
// parsed_codes field stores every plausible code so the bot's matcher
// can pick one. Walk a few common shapes and dedupe.
function collectOtpCodes(text: string): string[] {
  const codes = new Set<string>();
  const primary = extractOtp(text);
  if (primary !== null) codes.add(primary);
  // 4-8 digit numerics — the dominant verification-code shape.
  for (const m of text.matchAll(/\b\d{4,8}\b/g)) codes.add(m[0]);
  // 6-12 char uppercase alphanumerics — second most common shape.
  for (const m of text.matchAll(/\b[A-Z0-9]{6,12}\b/g)) codes.add(m[0]);
  return [...codes];
}
