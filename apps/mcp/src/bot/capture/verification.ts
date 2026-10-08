// Gmail is read in a utility tab so the page waiting for a code stays open.
// This module lists mail; the agent decides which message belongs to the task.
import type { Page } from "playwright";
import type { BrowserController } from "../browser.js";
import { withOAuthActionLease } from "../oauth-login.js";
import { waitForCaptchaChallengeToSettle } from "../captcha.js";
import type { Session } from "../session/model.js";
import {
  audit,
  googleSessionGateForSession,
  sessionForCall,
  type NeedsUserLogin,
} from "../session/lifecycle.js";
import { stashSecretSlot, type SlotHandle } from "../session/slots.js";
import { invalidateCompactV2Snapshot } from "../observe/observe.js";
import { runSerializedGoogleIdentityOperation } from "../act/act.js";
import { findOtpCredential } from "../credential-shape.js";

export interface NeedsUserCode {
  wall: "verification_code";
  message: string;
  resume: "code";
}

export interface InboxMessage {
  /** Zero-based index to pass as pick with into_slot. */
  index: number;
  from: string | null;
  subject: string | null;
  received_at: string | null;
  body: string;
  codes: string[];
  links: Array<{ url: string; text: string | null }>;
}

export interface VerificationResult {
  session_id: string;
  found: boolean;
  messages?: InboxMessage[];
  /** Kept for drive dependency fixtures; the listing itself leaves these null. */
  code: string | null;
  link: string | null;
  needs_user?: NeedsUserCode | NeedsUserLogin;
  sealed?: boolean;
  slot?: SlotHandle;
  searched?: { query: string };
}

export interface AwaitVerificationOptions {
  /** Passed to Gmail search unchanged. Without a query, the All Mail listing is read. */
  query?: string;
  /** One-release compatibility aliases; Gmail applies them as search operators. */
  sender?: string;
  recipient?: string;
  /** Requires pick so the agent chooses the message whose code is sealed. */
  intoSlot?: string;
  pick?: number;
  grantConsent?: boolean;
}

export interface MailResultRow {
  selector: string;
  fromEmail: string | null;
  fromName: string | null;
  subject: string | null;
  dateTitle: string | null;
  visibleText: string;
}

export interface OpenedMailMessage {
  fromEmail: string | null;
  fromName: string | null;
  dateTitle: string | null;
  toEmails: string[];
  text: string;
  links: Array<{ url: string; text: string | null }>;
}

export const GMAIL_ALL_MAIL_URL = "https://mail.google.com/mail/u/0/#all";
const MAX_MESSAGES = 10;
const MAX_BODY_CHARS = 6000;
const OTP_RE = /(?:^|[^\d])(\d{4,8})(?=[^\d]|$)/g;

export function extractInboxCodes(text: string): string[] {
  const candidates = [
    ...new Set([...text.matchAll(OTP_RE)].map((match) => match[1]!).filter(Boolean)),
  ];
  const likelyCode =
    /\b(?:verification\s+code|code|otp|passcode)\b[^\d]{0,30}(\d{4,8})\b/i.exec(text)?.[1] ??
    findOtpCredential(text);
  return likelyCode === null
    ? candidates
    : [likelyCode, ...candidates.filter((code) => code !== likelyCode)];
}

export function inboxSearchQuery(opts: AwaitVerificationOptions): string | undefined {
  const pieces = [
    opts.query,
    opts.sender?.trim() && `from:${opts.sender.trim()}`,
    opts.recipient?.trim() && `to:${opts.recipient.trim()}`,
  ].filter(Boolean);
  return pieces.length > 0 ? pieces.join(" ") : undefined;
}

export function buildConsentRefusal(sessionId: string): VerificationResult {
  return {
    session_id: sessionId,
    found: false,
    messages: [],
    code: null,
    link: null,
    needs_user: {
      wall: "verification_code",
      message:
        "Inbox reading is disabled. Ask the user for the code, or retry operate_read_inbox with grant_inbox_consent:true. To change the default permanently, re-run connect and update advanced settings.",
      resume: "code",
    },
  };
}

export function isGmailTransientErrorText(text: string): boolean {
  return /#2014|encountered a problem|retrying in\s*\d+/i.test(text);
}

export function isEmptyGmailResultText(text: string): boolean {
  return /no messages matched your search/i.test(text);
}

export function gmailTransientBackoffMs(retryIndex: number): number {
  return Math.min(800 * 2 ** retryIndex, 4000);
}

function mailTime(value: string | null): number {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function rowKey(row: MailResultRow): string {
  return `${row.fromEmail ?? row.fromName ?? ""}|${row.subject ?? ""}|${row.dateTitle ?? ""}|${row.visibleText}`;
}

/** Gmail search may lag; All Mail is the default and supplements a query. */
async function listRows(
  browser: BrowserController,
  page: Page,
  url: string,
): Promise<MailResultRow[]> {
  await browser.goto(url, page);
  for (let attempt = 0; attempt < 4; attempt++) {
    const text = await browser.extractVisibleText(page);
    const rows = await browser.extractMailResultRows(page).catch(() => []);
    if (rows.length > 0) return rows;
    if (new URL(page.url()).hostname === "accounts.google.com") return [];
    if (attempt < 3) {
      await waitForCaptchaChallengeToSettle(
        browser,
        isGmailTransientErrorText(text) || isEmptyGmailResultText(text)
          ? gmailTransientBackoffMs(attempt)
          : 400,
        0,
        page,
      ).catch(() => false);
      if (isGmailTransientErrorText(text)) await browser.goto(url, page);
    }
  }
  return [];
}

function toInboxMessage(message: OpenedMailMessage, row: MailResultRow): InboxMessage {
  const body = message.text.slice(0, MAX_BODY_CHARS);
  return {
    index: 0,
    from: message.fromEmail ?? row.fromEmail ?? message.fromName ?? row.fromName,
    subject: row.subject,
    received_at: message.dateTitle ?? row.dateTitle,
    body,
    codes: extractInboxCodes(message.text),
    links: message.links.filter((link) => link.url.length > 0),
  };
}

async function openRowMessages(
  browser: BrowserController,
  page: Page,
  row: MailResultRow,
  listingUrl: string,
): Promise<InboxMessage[]> {
  const refreshed = await listRows(browser, page, listingUrl);
  const current = refreshed.find((candidate) => rowKey(candidate) === rowKey(row));
  if (
    current === undefined ||
    !(await browser.openMailResultRow(page, current.selector).catch(() => false))
  )
    return [];
  await browser.expandCollapsedMailMessages(page).catch(() => 0);
  const opened = await browser.extractOpenedMailMessages(page).catch(() => []);
  if (opened.length > 0) return opened.map((message) => toInboxMessage(message, row));
  const body = await browser.extractOpenedMailBody(page).catch(() => null);
  if (body === null) return [];
  return [
    toInboxMessage(
      {
        fromEmail: row.fromEmail,
        fromName: row.fromName,
        dateTitle: row.dateTitle,
        toEmails: [],
        text: body.text,
        links: body.links,
      },
      row,
    ),
  ];
}

async function readMessages(
  browser: BrowserController,
  page: Page,
  query: string | undefined,
): Promise<{ messages: InboxMessage[]; gmailAuthRedirect: boolean }> {
  // Older controllers used by the session harness expose only a first-row
  // opener. The production controller supplies the row and message extractors.
  if (typeof browser.extractMailResultRows !== "function") {
    await browser.goto(
      query === undefined
        ? GMAIL_ALL_MAIL_URL
        : `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(query)}`,
      page,
    );
    if (new URL(page.url()).hostname === "accounts.google.com")
      return { messages: [], gmailAuthRedirect: true };
    if (!(await browser.openFirstMailResult(page).catch(() => false)))
      return { messages: [], gmailAuthRedirect: false };
    const body = await browser.extractOpenedMailBody(page).catch(() => null);
    const text = body?.text ?? (await browser.extractVisibleText(page));
    const links =
      body?.links ??
      (await browser.extractRawMailLinks(page)).map((link) => ({
        url: link.href,
        text: link.visibleText,
      }));
    const from = /<([^<>\s]+@[^<>\s]+)>/.exec(text)?.[1] ?? null;
    return {
      messages: [
        toInboxMessage(
          { fromEmail: from, fromName: null, dateTitle: null, toEmails: [], text, links },
          {
            selector: "",
            fromEmail: from,
            fromName: null,
            subject: null,
            dateTitle: null,
            visibleText: "",
          },
        ),
      ],
      gmailAuthRedirect: false,
    };
  }
  const listings: Array<{ url: string; rows: MailResultRow[] }> = [];
  if (query !== undefined) {
    const url = `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(query)}`;
    const rows = await listRows(browser, page, url);
    if (new URL(page.url()).hostname === "accounts.google.com")
      return { messages: [], gmailAuthRedirect: true };
    listings.push({ url, rows });
  }
  const allRows = await listRows(browser, page, GMAIL_ALL_MAIL_URL);
  if (new URL(page.url()).hostname === "accounts.google.com")
    return { messages: [], gmailAuthRedirect: true };
  listings.push({ url: GMAIL_ALL_MAIL_URL, rows: allRows });

  const ranked = listings.map((listing) =>
    listing.rows
      .map((row) => ({ url: listing.url, row }))
      .sort((a, b) => mailTime(b.row.dateTitle) - mailTime(a.row.dateTitle)),
  );
  // An explicit search gets most slots; reserve a few for fresh All Mail rows
  // that Gmail has not indexed yet. With no search, list All Mail directly.
  const candidates =
    query === undefined
      ? ranked[0]!
      : [
          ...ranked[0]!.slice(0, MAX_MESSAGES - 3),
          ...ranked[1]!.slice(0, 3),
          ...ranked[1]!.slice(3),
        ];
  const messages: InboxMessage[] = [];
  const seenRows = new Set<string>();
  for (const { url, row } of candidates) {
    if (messages.length >= MAX_MESSAGES) break;
    const key = rowKey(row);
    if (seenRows.has(key)) continue;
    seenRows.add(key);
    for (const message of await openRowMessages(browser, page, row, url)) {
      if (messages.length >= MAX_MESSAGES) break;
      messages.push(message);
    }
  }
  messages.sort((a, b) => mailTime(b.received_at) - mailTime(a.received_at));
  messages.forEach((message, index) => {
    message.index = index;
  });
  return { messages, gmailAuthRedirect: false };
}

export async function awaitVerification(
  sessionId: string,
  opts: AwaitVerificationOptions = {},
): Promise<VerificationResult> {
  const session = sessionForCall(sessionId);
  if (session === undefined) throw new Error(`unknown provision session ${sessionId}`);
  if (opts.grantConsent !== undefined && opts.grantConsent !== session.consentInboxRead) {
    session.consentInboxRead = opts.grantConsent;
    audit(sessionId, opts.grantConsent ? "inbox_consent_granted" : "inbox_consent_revoked", {
      scope: "session",
    });
  }
  if (!session.consentInboxRead) {
    audit(sessionId, "await_verification", { refused: "no_inbox_consent" });
    return buildConsentRefusal(sessionId);
  }
  const googleGate = await googleSessionGateForSession(sessionId);
  if (!googleGate.ok)
    return {
      session_id: sessionId,
      found: false,
      messages: [],
      code: null,
      link: null,
      needs_user: googleGate.needs_user,
    };
  invalidateCompactV2Snapshot(session);
  const query = inboxSearchQuery(opts);
  const result = await withOAuthActionLease(
    undefined,
    async () =>
      (
        await runSerializedGoogleIdentityOperation(session, async (browser) => {
          const tab = await browser.openUtilityTab();
          try {
            return await readMessages(browser, tab, query);
          } finally {
            await tab.close().catch(() => undefined);
          }
        })
      ).result,
  );
  if (result.gmailAuthRedirect) {
    audit(sessionId, "await_verification", { refused: "gmail_auth_redirect" });
    return {
      session_id: sessionId,
      found: false,
      messages: [],
      code: null,
      link: null,
      needs_user: {
        wall: "google_session",
        message:
          "Gmail redirected to Google sign-in. Reconnect with `npx @trusty-squire/mcp connect`, then retry the inbox read. Your signup page remains open.",
        resume: "connect",
      },
    };
  }
  const response: VerificationResult = {
    session_id: sessionId,
    found: result.messages.length > 0,
    messages: result.messages,
    code: null,
    link: null,
    ...(query === undefined ? {} : { searched: { query } }),
  };
  if (opts.intoSlot !== undefined && opts.pick !== undefined) {
    const code = result.messages[opts.pick]?.codes[0];
    if (code !== undefined) {
      response.slot = stashSecretSlot(sessionId, opts.intoSlot, code);
      response.sealed = true;
      const mask = (value: string | null): string | null =>
        value?.replaceAll(code, "[code]") ?? null;
      response.messages = result.messages.map((message) => ({
        ...message,
        from: mask(message.from),
        subject: mask(message.subject),
        received_at: mask(message.received_at),
        body: mask(message.body)!,
        codes: message.codes.filter((candidate) => candidate !== code),
        links: message.links.map((link) => ({ url: mask(link.url)!, text: mask(link.text) })),
      }));
    }
  }
  audit(sessionId, "await_verification", {
    query: query ?? null,
    message_count: result.messages.length,
    sealed: response.sealed === true,
  });
  return response;
}
