// workspace-inbox-poller.ts — IMAP-backed signup verification email
// fetcher for the Workspace catch-all path (trustysquire.ai).
//
// Pre-0.8.3 the signup verification path went:
//   service → Resend SMTP (trustysquire.com) → webhook → API → Prisma
// Several deliverability-sensitive services (SendGrid, Fathom,
// Browserbase, Axiom) silent-dropped mail because trustysquire.com is
// a fresh-MX domain. trustysquire.ai sits behind Google Workspace
// (aged MX, top-tier reputation) with catch-all routing — every
// `<random>@trustysquire.ai` lands in lunchbox@trustysquire.ai's
// inbox. We poll that inbox by IMAP, searching for messages whose TO
// header matches the bot's per-signup alias.
//
// The shape mirrors gmail-otp-poller's IMAP setup; the search and
// extraction differ:
//   - search filters by TO header (specific alias), not by FROM
//     domain
//   - extraction returns the whole decoded body + harvested links +
//     subject/from/date, so the bot's pickVerificationLink heuristic
//     can choose which link to click
// Returns null on miss; never throws.

import { ImapFlow } from "imapflow";

export interface WorkspacePollerConfig {
  imapUser: string;
  imapAppPassword: string;
}

export interface WorkspacePollInput {
  to_address: string;
  since_seconds: number;
}

export interface WorkspaceReceivedEmail {
  subject: string;
  from_address: string;
  body_text: string;
  body_html: string;
  parsed_links: string[];
  parsed_codes: string[];
  received_at: string;
}

export interface WorkspacePollResult {
  email: WorkspaceReceivedEmail | null;
  reason: string;
  scanned: number;
}

const MIN_SINCE = 10;
const MAX_SINCE = 600;

export class WorkspaceInboxPoller {
  constructor(private readonly cfg: WorkspacePollerConfig) {}

  async poll(input: WorkspacePollInput): Promise<WorkspacePollResult> {
    const sinceSeconds = clamp(input.since_seconds, MIN_SINCE, MAX_SINCE);
    const sinceDate = new Date(Date.now() - sinceSeconds * 1000);
    const wantTo = input.to_address.toLowerCase();
    if (wantTo.length === 0 || !wantTo.includes("@")) {
      return { email: null, reason: "invalid_to_address", scanned: 0 };
    }

    const client = new ImapFlow({
      host: "imap.gmail.com",
      port: 993,
      secure: true,
      auth: { user: this.cfg.imapUser, pass: this.cfg.imapAppPassword },
      logger: false,
    });

    let scanned = 0;
    let sawCandidates = false;
    try {
      await client.connect();
      // Search INBOX first, then Spam. Fresh-domain automated-signup
      // verification mail is routinely spam-filtered, and this poller
      // used to look ONLY in INBOX — silently returning
      // verification_not_sent even though the mail had arrived (confirmed
      // 2026-06-03: ipdata/imagekit verification mails sat in Spam).
      // [Gmail]/Spam is Gmail's IMAP path for the spam folder; a non-
      // Gmail server won't have it, so a missing-folder lock failure is
      // skipped rather than fatal.
      for (const mailbox of ["INBOX", "[Gmail]/Spam"]) {
        let lock: Awaited<ReturnType<typeof client.getMailboxLock>>;
        try {
          lock = await client.getMailboxLock(mailbox);
        } catch {
          continue; // folder doesn't exist on this server
        }
        try {
          const found = await this.searchMailbox(client, sinceDate, wantTo);
          scanned += found.scanned;
          if (found.scanned > 0) sawCandidates = true;
          if (found.email !== null) {
            return { email: found.email, reason: "found", scanned };
          }
        } finally {
          lock.release();
        }
      }
      return {
        email: null,
        reason: sawCandidates ? "no_match" : "no_recent_messages",
        scanned,
      };
    } catch (err) {
      return {
        email: null,
        reason: `imap_error:${err instanceof Error ? err.message : String(err)}`,
        scanned,
      };
    } finally {
      try {
        await client.logout();
      } catch {
        // ignore
      }
    }
  }

  // Search the currently-locked mailbox for a message addressed to
  // `wantTo` since `sinceDate`, returning the first with extractable
  // content (or null). The server-side TO filter matches the literal
  // address in any of the To/Cc/Bcc/Delivered-To headers — perfect for
  // catch-all where envelope-recipient rewriting puts the original alias
  // in Delivered-To.
  private async searchMailbox(
    client: ImapFlow,
    sinceDate: Date,
    wantTo: string,
  ): Promise<{ email: WorkspacePollResult["email"]; scanned: number }> {
    let scanned = 0;
    const searchResult = await client.search(
      { since: sinceDate, to: wantTo },
      { uid: true },
    );
    const uids: number[] = Array.isArray(searchResult) ? searchResult : [];
    if (uids.length === 0) return { email: null, scanned: 0 };
    uids.sort((a, b) => b - a);
    for (const uid of uids.slice(0, 20)) {
      scanned += 1;
      const msg = await client.fetchOne(
        String(uid),
        { envelope: true, source: true, internalDate: true },
        { uid: true },
      );
      if (msg === false || msg === null) continue;
      if (msg.internalDate !== undefined) {
        const ts =
          msg.internalDate instanceof Date
            ? msg.internalDate.getTime()
            : new Date(msg.internalDate).getTime();
        if (Number.isFinite(ts) && ts < sinceDate.getTime()) continue;
      }
      const raw = msg.source !== undefined ? msg.source.toString("utf8") : "";
      const headerEnd = raw.search(/\r?\n\r?\n/);
      const bodyOnly = headerEnd >= 0 ? raw.slice(headerEnd + 2) : raw;
      const { text, html, links } = decodeMimeForVerification(bodyOnly);
      const codes = extractShortCodes(text);
      const fromAddrs = msg.envelope?.from ?? [];
      const fromAddress =
        fromAddrs.length > 0 && fromAddrs[0] ? fromAddrs[0].address ?? "" : "";
      const subject = msg.envelope?.subject ?? "";
      const receivedAt =
        msg.internalDate instanceof Date
          ? msg.internalDate.toISOString()
          : new Date().toISOString();
      return {
        email: {
          subject,
          from_address: fromAddress,
          body_text: text,
          body_html: html,
          parsed_links: links,
          parsed_codes: codes,
          received_at: receivedAt,
        },
        scanned,
      };
    }
    return { email: null, scanned };
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

// Decode the MIME body and return text + html + extracted links.
// Same quoted-printable / base64-chunk decoding as gmail-otp-poller,
// kept separate so this poller can return the html part as-is for
// callers that want to render it.
function decodeMimeForVerification(body: string): {
  text: string;
  html: string;
  links: string[];
} {
  let out = body.replace(/=([0-9A-Fa-f]{2})/g, (_m, h: string) =>
    String.fromCharCode(parseInt(h, 16)),
  );
  out = out.replace(/=\r?\n/g, "");
  // Try to detect HTML by looking for a tag-shaped substring.
  const htmlMatch = out.match(/<html[\s\S]*?<\/html>/i);
  const html = htmlMatch !== null ? htmlMatch[0] : "";
  // Collect URLs from href attributes BEFORE stripping tags (same
  // fix as the gmail-otp-poller href-extraction patch).
  const hrefLinks = new Set<string>();
  for (const m of out.matchAll(/\bhref\s*=\s*["']([^"']+)["']/gi)) {
    if (m[1] !== undefined && m[1].startsWith("http")) hrefLinks.add(m[1]);
  }
  // Strip tags for the plaintext body.
  const text = out.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  // Also collect bare URLs in the plaintext.
  for (const m of text.matchAll(/https?:\/\/[^\s"<>)]+/g)) {
    hrefLinks.add(m[0]);
  }
  return { text, html, links: Array.from(hrefLinks) };
}

// Extract 4-10 digit codes from the plaintext body. Best-effort —
// the bot's link-picking path is the dominant one for signup
// verifications; codes are surfaced for the rare service that asks
// the user to type one (those usually use the operator-OTP path).
function extractShortCodes(text: string): string[] {
  const codes = new Set<string>();
  for (const m of text.matchAll(/\b(\d{4,10})\b/g)) {
    if (m[1] !== undefined) codes.add(m[1]);
  }
  return Array.from(codes);
}
