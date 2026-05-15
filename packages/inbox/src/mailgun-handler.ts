// Mailgun inbound email handler
// Parses Mailgun webhook payloads and stores emails via InboxService

import { parseRfc822, type ParsedEmail } from "./parser.js";
import type { AliasStore, EmailStore } from "./types.js";
import { EncryptedEmailError } from "./types.js";
import { ulid } from "ulid";

export interface MailgunInboundPayload {
  // Mailgun sends the raw email in different formats
  "body-mime"?: string;  // Full MIME message (preferred)
  "stripped-text"?: string;  // Plain text body
  "stripped-html"?: string;  // HTML body
  sender: string;  // From address
  recipient: string;  // To address (the alias)
  subject: string;
  "message-id": string;  // RFC 822 Message-ID
  // Other fields we don't need
}

export interface MailgunHandlerDeps {
  aliasStore: AliasStore;
  emailStore: EmailStore;
}

export type IngestOutcome =
  | { kind: "stored"; email: { id: string; alias: string } }
  | { kind: "duplicate"; message_id: string }
  | { kind: "no_alias_match"; recipient: string }
  | { kind: "encrypted_rejected" };

export class MailgunHandler {
  constructor(private readonly deps: MailgunHandlerDeps) {}

  async ingest(payload: MailgunInboundPayload): Promise<IngestOutcome> {
    const recipient = payload.recipient;
    const messageId = payload["message-id"];

    // Check if alias exists and is active
    const alias = await this.deps.aliasStore.find(recipient);
    if (!alias || !alias.active) {
      return { kind: "no_alias_match", recipient };
    }

    // Check for duplicate Message-ID by checking all emails for this alias
    const existingEmails = await this.deps.emailStore.findByAlias(recipient);
    const duplicate = existingEmails.find(e => e.message_id === messageId);
    if (duplicate) {
      return { kind: "duplicate", message_id: messageId };
    }

    // Parse email body
    let bodyText: string | null = null;
    let bodyHtml: string | null = null;
    let parsedLinks: string[] = [];
    let parsedCodes: string[] = [];

    if (payload["body-mime"]) {
      // Best case: we have the full MIME message
      try {
        const parsed = await parseRfc822(Buffer.from(payload["body-mime"], "utf-8"));
        bodyText = parsed.body_text;
        bodyHtml = parsed.body_html;
        parsedLinks = parsed.links;
        parsedCodes = parsed.codes;
      } catch (err) {
        if (err instanceof EncryptedEmailError) {
          return { kind: "encrypted_rejected" };
        }
        throw err;
      }
    } else {
      // Fallback: use stripped text/html
      bodyText = payload["stripped-text"] || null;
      bodyHtml = payload["stripped-html"] || null;
      
      // Extract links and codes manually from text
      if (bodyText) {
        parsedLinks = this.extractLinks(bodyText);
        parsedCodes = this.extractCodes(bodyText);
      }
    }

    // Extract domain from sender
    const fromDomain = payload.sender.split("@")[1] || "";

    // Store the email
    const emailId = ulid();
    await this.deps.emailStore.insertIfAbsent({
      id: emailId,
      alias: recipient,
      associated_run_id: alias.run_id,
      message_id: messageId,
      from_address: payload.sender,
      from_domain: fromDomain,
      subject: payload.subject,
      s3_raw_uri: "", // Mailgun doesn't use S3
      body_text: bodyText,
      body_html: bodyHtml,
      parsed_links: parsedLinks,
      parsed_codes: parsedCodes,
      received_at: new Date(),
      consumed_at: null,
      body_purged_at: null,
    });

    // Increment inbound count on alias
    await this.deps.aliasStore.bumpInbound(recipient);

    return {
      kind: "stored",
      email: { id: emailId, alias: recipient },
    };
  }

  private extractLinks(text: string): string[] {
    // Simple URL extraction
    const urlPattern = /https?:\/\/[^\s<>"]+/g;
    return [...text.matchAll(urlPattern)].map((m) => m[0]);
  }

  private extractCodes(text: string): string[] {
    // Extract common verification code patterns
    const patterns = [
      /\b\d{4,8}\b/g,  // 4-8 digit codes
      /\b[A-Z0-9]{6,12}\b/g,  // Uppercase alphanumeric codes
    ];

    const codes: string[] = [];
    for (const pattern of patterns) {
      const matches = [...text.matchAll(pattern)].map((m) => m[0]);
      codes.push(...matches);
    }

    // Dedupe
    return [...new Set(codes)];
  }
}
