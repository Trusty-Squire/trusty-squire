// Verification-side code, extracted verbatim from provision-session.ts
// (layer-contracts PR 11 — the capture module split). Owns the email
// verification thick tool: the pure OTP/link parsers, Gmail transient-error
// resilience, and the session-facing awaitVerification (plus the detached
// Google-identity operation wrapper it runs under). No behaviour change.
// provision-session imports the session-facing entry point back and keeps
// re-exporting the tool layer's import surface; this module imports only from
// the rest of the tree, never from provision-session.

import type { Page } from "playwright";
import type { BrowserController } from "../browser.js";
import { withOAuthActionLease } from "../oauth-login.js";
import { waitForCaptchaChallengeToSettle } from "../captcha.js";
import { pickVerificationLink, type VerificationLinkCandidate } from "../email-verification.js";
import { findOtpCredential } from "../credential-shape.js";
import type { Session } from "../session/model.js";
import { audit, sessionForCall } from "../session/lifecycle.js";
import { stashSecretSlot, type SlotHandle } from "../session/slots.js";
import { invalidateCompactV2Snapshot } from "../observe/observe.js";
import { runSerializedGoogleIdentityOperation } from "../act/act.js";

async function runDetachedGoogleIdentityOperation<T>(
  session: Session,
  operation: (browser: BrowserController) => Promise<T>,
): Promise<T> {
  return await withOAuthActionLease(
    undefined,
    async () => (await runSerializedGoogleIdentityOperation(session, operation)).result,
  );
}

// ── email verification (thick tool — user-inbox-via-browser) ──

// Flow A hand-back (wall-handoff design): the inbox poll found no code, but the
// thick session is STILL LIVE, so this is resumable, not a give-up. The host
// asks the user for the code (SMS / authenticator / not-yet-delivered email),
// then types it with operate_act and keeps driving. Session + vault moat
// preserved. See docs/ARCHITECTURE.md.
export interface NeedsUserCode {
  wall: "verification_code";
  message: string;
  resume: "code";
}

export interface VerificationResult {
  session_id: string;
  found: boolean;
  // A short numeric OTP if one appears in the matching mail, else null. NULL
  // when sealed (the code was stashed into a slot — use type_secret to enter it).
  code: string | null;
  // A verification/confirm link if present, else null. The host decides whether
  // to navigate to it.
  link: string | null;
  // Set when found=false: the code wasn't auto-retrievable from the inbox. The
  // session is alive — ASK THE USER for the code and type it, don't abandon.
  needs_user?: NeedsUserCode;
  // Set when into_slot was requested AND a code was found: the OTP was sealed
  // into a session slot (host gets only the masked handle) so it never round-
  // trips through the host. Enter it with operate_act type_secret{slot,target}.
  sealed?: boolean;
  slot?: SlotHandle;
  // The sender address the code/link was read from (e.g. "search-api@brave.com"),
  // best-effort from the opened mail header. Lets the caller VERIFY the code came
  // from the expected service before using it — a broad (no-sender) search can
  // surface an unrelated sender's OTP, so this makes a wrong-sender grab visible.
  source_from?: string;
}

export interface AwaitVerificationOptions {
  // Narrow the Gmail search to the sending service, e.g. "resend.com".
  sender?: string;
  // Seal a found OTP into this session slot instead of returning it, so the
  // code is typed via type_secret and never crosses the MCP boundary to the
  // host (also dodges host-side payload truncation — see T3).
  intoSlot?: string;
  // Overrides inbox reading for this session only. true grants (or restores)
  // access and false opts out without changing the saved advanced preference.
  grantConsent?: boolean;
}

// Pure verification parser (exported for unit tests). Extracts a {code, link}
// from mail text + its links. A 4-8 digit code is PREFERRED when it sits near
// an OTP keyword ("code"/"verification"/"otp"/"passcode"), so a date or order
// number elsewhere in the mail doesn't win; falls back to the first standalone
// 4-8 digit run. The link uses the bot's pickVerificationLink heuristic.
const OTP_ANY_RE = /(?:^|[^0-9])(\d{4,8})(?:[^0-9]|$)/g;

export function parseVerification(
  text: string,
  links: readonly (string | VerificationLinkCandidate)[],
  expectedDomains?: readonly string[],
): { code: string | null; link: string | null } {
  const link = pickVerificationLink([...links], expectedDomains);
  let code = findOtpCredential(text);
  if (code === null) {
    const m = OTP_ANY_RE.exec(text);
    code = m !== null ? (m[1] ?? null) : null;
  }
  return { code, link };
}

// Gmail's own page chrome leaks into any page-wide anchor read of a mailbox
// page: the account-menu, settings, and support links are ordinary <a> anchors
// sitting beside the mail content. Chrome anchors can score POSITIVE — the
// account menu's SignOutOptions URL carries a `continue=` parameter (+3), and
// support-article URLs often do too — so without this filter a mailbox page
// whose message body was never reached scored a UI URL as the verification
// link and returned {found:true, code:null, link:"https://accounts.google.com/
// SignOutOptions?...&continue=..."} — a claimed hit naming Gmail's own account
// menu instead of anything from the verification email (Proton gauntlet,
// operate_read_inbox on 1.1.14; the code WAS in the mailbox). A verification
// email's action link is never the mail app's own chrome, so these are
// unconditionally dropped before scoring — a chrome-only page then yields
// {code:null, link:null}, which keeps the retry loop running and stays honest
// (needs_user) instead of claiming a hit. Exported for unit tests.
export function isGmailChromeLink(rawUrl: string): boolean {
  const url = rawUrl.trim();
  if (url.startsWith("#")) return true;
  try {
    const u = new URL(url.replace(/&amp;/gi, "&"));
    const host = u.hostname.toLowerCase();
    // The mailbox app itself (its hash-UI paths and internal navigation) and
    // Google's account-menu/help chrome never carry a third-party signup's
    // verification link. Google's own account-security mail is exactly the
    // noise a third-party signup must not grab.
    if (host === "mail.google.com" || host === "support.google.com") return true;
    if (host === "accounts.google.com") return /^\/signoutoptions(?:$|[/?#])/i.test(u.pathname);
    return false;
  } catch {
    return false;
  }
}

// Best-effort sender address from an OPENED Gmail message: Gmail renders the
// header as "Name <addr@domain>". Returned as source_from so a caller can verify
// the code came from the expected service — a no-sender search can otherwise
// surface an unrelated sender's OTP (Brave signup 2026-07-04: a GO2bank code was
// grabbed instead of Brave's). Exported for unit tests.
export function extractSenderEmail(text: string): string | null {
  const m = /<([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})>/.exec(text);
  return m !== null ? m[1]!.toLowerCase() : null;
}

// Derives the domain(s) pickVerificationLink should prefer: the caller's
// `sender` search hint (an email address or a bare domain) and the sender
// address read off the opened message, deduped and lowercased. Exported for
// unit tests.
export function expectedVerificationDomains(
  sender: string | undefined,
  sourceFrom: string | null,
): string[] {
  const domainOf = (s: string): string => (s.includes("@") ? s.split("@").pop()! : s).toLowerCase();
  const domains = [sender, sourceFrom ?? undefined]
    .filter((s): s is string => s !== undefined && s.length > 0)
    .map(domainOf);
  return [...new Set(domains)];
}

// Pure: assemble the verification result. When neither a code nor a link was
// found, the thick session is still live, so this is a RESUMABLE hand-back
// (Flow A) — the host asks the user for the code and types it — not a give-up.
// Exported for unit tests.
export function buildVerificationResult(
  sessionId: string,
  code: string | null,
  link: string | null,
  sourceFrom: string | null = null,
): VerificationResult {
  const found = code !== null || link !== null;
  const src = sourceFrom !== null ? { source_from: sourceFrom } : {};
  if (found) return { session_id: sessionId, found, code, link, ...src };
  const needs_user: NeedsUserCode = {
    wall: "verification_code",
    message:
      "No verification email found in the inbox YET. Most often it just hasn't " +
      "arrived (they commonly take 10–30s) — call operate_read_inbox AGAIN " +
      "in a few seconds. If it still fails, the code may have gone by SMS/" +
      "authenticator: ask the user for it and type it with operate_type. The " +
      "session stays live either way.",
    resume: "code",
  };
  return { session_id: sessionId, found, code, link, needs_user, ...src };
}

// Inbox-read opt-out refusal. The session stays live (resumable): the host asks
// the user for the code and types it, or restores inbox access and retries.
// Distinct from buildVerificationResult so the host can tell "access disabled"
// apart from "code not found in an inbox we DID read".
// Exported for unit tests.
export function buildConsentRefusal(sessionId: string): VerificationResult {
  const needs_user: NeedsUserCode = {
    wall: "verification_code",
    message:
      "Inbox reading is disabled, so the operator did not read any mail. Ask " +
      "the user for the code and type it with operate_type, or retry " +
      "operate_read_inbox with grant_inbox_consent:true " +
      "to restore inbox reading for this session. The session stays live either way. " +
      "To change the default permanently, re-run `connect` and update advanced settings.",
    resume: "code",
  };
  return { session_id: sessionId, found: false, code: null, link: null, needs_user };
}

// The inbox search query. Covers verification/OTP AND passwordless sign-in /
// magic-link vocabulary — a passwordless "Login link" email (Loops: "Please
// login… Login") carries NONE of the OTP words, so the old keyword clause
// excluded the very email we needed and await returned found:false. MEASURED
// 2026-07-01 (Loops login magic link: body has "login", link is
// /api/auth/callback/email?token=…, which pickVerificationLink now extracts).
//
// "sign up"/signup joined the same way: MEASURED 2026-09-17 (rc.35 craigslist
// false found:false, #828): craigslist's activation email ("craigslist account
// sign-up", body "complete account sign-up") matched NONE of the previous 24
// keywords, so the sender-scoped query returned "No matches" in Gmail while
// the mail sat unread in the inbox — `from:craigslist newer_than:1d` alone
// found it fine, the keyword clause was the veto.
//
// There is deliberately NO `from:${sender}` here anymore. The sender filter is
// applied client-side to the returned rows (mailRowMatchesSender matches the
// From address, its display name, AND the subject), so one brittle Gmail
// operator can never veto the search; a broad keyword query over the last day
// stays within one results page. Exported for unit tests.
export function buildVerificationSearchQuery(): string {
  return [
    "newer_than:1d",
    '(verify OR verification OR confirm OR confirmation OR code OR otp OR passcode OR password OR login OR "log in" OR "sign in" OR "sign-in" OR signin OR "sign up" OR signup OR "magic link" OR activate OR activation OR welcome OR "link account" OR "link your" OR continue)',
  ].join(" ");
}

// One Gmail search-results row as read by BrowserController.extractMailResultRows.
export interface MailResultRow {
  // Selector of the tagged row element, valid on the same page until Gmail
  // rerenders the list; openMailResultRow opens exactly this row.
  selector: string;
  fromEmail: string | null;
  fromName: string | null;
  subject: string | null;
  snippet: string | null;
  // The date cell's full timestamp from its `title` attribute ("Sep 17, 2026,
  // 5:10 AM") — the visible text collapses it to "5:10 AM"/"Sep 16".
  dateTitle: string | null;
  visibleText: string;
}

// The sender hint matches what a real sender looks like — the From address,
// its display name, and the subject — never one brittle field. MEASURED
// 2026-09-17 (rc.35 #828): relying on a single operator/field is exactly the
// shape that missed. Rows without any From/subject metadata (legacy or exotic
// list shapes) cannot be filtered honestly and stay candidates; the keyword
// query and the newest-first pick still bound what gets opened. Multi-token
// hints ("craigslist activation") require EVERY token somewhere across the
// three fields. Exported for unit tests.
export function mailRowMatchesSender(
  row: Pick<MailResultRow, "fromEmail" | "fromName" | "subject">,
  sender?: string,
): boolean {
  if (sender === undefined || sender.trim().length === 0) return true;
  const fields = [row.fromEmail, row.fromName, row.subject]
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .join("\n")
    .toLowerCase();
  if (fields.length === 0) return true;
  const hint = sender.trim().toLowerCase();
  if (fields.includes(hint)) return true;
  const tokens = hint.split(/\s+/).filter((t) => t.length >= 3);
  return tokens.length > 0 && tokens.every((t) => fields.includes(t));
}

// Pure: the full row date to an epoch ms, or null when absent/unparseable.
// Exported for unit tests.
export function parseMailRowDate(dateTitle: string | null): number | null {
  if (dateTitle === null) return null;
  const ts = Date.parse(dateTitle.trim());
  return Number.isFinite(ts) ? ts : null;
}

// Gmail search results are ordered by RELEVANCE, not date ("Showing most
// relevant"), so the first row is not the newest mail. MEASURED 2026-09-17
// (rc.35 stale-code defect, #831): the unfiltered query ranked an 11:39 PM
// Proton code FIRST while the fresh 5:10 AM craigslist mail sat below it (and,
// without the keyword fix, was absent entirely) — openFirstMailResult's
// first-row click returned yesterday's code. Pick the row with the newest
// parsed date instead; rows without a parseable date keep their list order
// after all dated rows. Ties keep the earlier row. Exported for unit tests.
export function pickNewestMailRow(rows: readonly MailResultRow[]): MailResultRow | null {
  if (rows.length === 0) return null;
  let best = rows[0]!;
  let bestTs = parseMailRowDate(best.dateTitle);
  for (let i = 1; i < rows.length; i++) {
    const ts = parseMailRowDate(rows[i]!.dateTitle);
    if (ts !== null && (bestTs === null || ts > bestTs)) {
      best = rows[i]!;
      bestTs = ts;
    }
  }
  return best;
}

// Gmail's own search backend intermittently throws a transient error —
// "Oops... the system encountered a problem (#2014) - Retrying in Ns" —
// and while that banner is up a search like `from:xata.io` can spuriously
// render "No messages matched your search" even though the message is
// really there. Exported for unit tests.
export function isGmailTransientErrorText(text: string): boolean {
  return /#2014|encountered a problem|retrying in\s*\d+/i.test(text);
}

// Exported for unit tests.
export function isEmptyGmailResultText(text: string): boolean {
  return /no messages matched your search/i.test(text);
}

// Backoff schedule for the transient-error retry, in ms: 800, 1600, 3200,
// capped at 4000. Exported for unit tests.
export function gmailTransientBackoffMs(retryIndex: number): number {
  return Math.min(800 * 2 ** retryIndex, 4000);
}

// Bounded — a genuinely empty inbox must still resolve to not-found in
// finite time, not hang retrying forever.
const GMAIL_TRANSIENT_MAX_RETRIES = 3;

// Reads the Gmail search results list, retrying through Gmail's own transient
// backend error with backoff before accepting a result as final. Detects
// EITHER the error banner itself, or an empty-looking "No messages matched"
// render with no result links (the shape the banner's spurious empty state
// takes) — and only gives up on the bounded retries running out, never on
// the first read. Exported for unit tests via the pure detectors above; this
// wrapper needs a live browser so it isn't itself unit tested directly.
async function readGmailSearchResultsResilient(
  browser: BrowserController,
  searchUrl: string,
  page: Page,
  linksOf: (page: Page) => Promise<VerificationLinkCandidate[]>,
): Promise<{ text: string; links: VerificationLinkCandidate[] }> {
  let text = "";
  let links: VerificationLinkCandidate[] = [];
  for (let retry = 0; retry <= GMAIL_TRANSIENT_MAX_RETRIES; retry++) {
    if (retry > 0) {
      await waitForCaptchaChallengeToSettle(
        browser,
        gmailTransientBackoffMs(retry - 1),
        0,
        page,
      ).catch(() => false);
      await browser.goto(searchUrl, page);
    }
    for (let i = 0; i < 6; i++) {
      text = await browser.extractVisibleText(page);
      if (text.length > 200) break;
      await waitForCaptchaChallengeToSettle(browser, 1200, 0, page).catch(() => false);
    }
    links = await linksOf(page);
    const transientOrEmpty =
      isGmailTransientErrorText(text) || (isEmptyGmailResultText(text) && links.length === 0);
    if (!transientOrEmpty || retry === GMAIL_TRANSIENT_MAX_RETRIES) break;
  }
  return { text, links };
}

export async function awaitVerification(
  sessionId: string,
  opts: AwaitVerificationOptions = {},
): Promise<VerificationResult> {
  const session = sessionForCall(sessionId);
  if (session === undefined) throw new Error(`unknown provision session ${sessionId}`);

  // A caller can override the default for this session without changing the
  // saved advanced preference. In particular, false must win over default-on.
  if (opts.grantConsent !== undefined && opts.grantConsent !== session.consentInboxRead) {
    session.consentInboxRead = opts.grantConsent;
    audit(sessionId, opts.grantConsent ? "inbox_consent_granted" : "inbox_consent_revoked", {
      scope: "session",
    });
  }
  // Explicit opt-out gate: do NOT read mail while disabled. Hand the code
  // request back to the user instead (resumable).
  if (!session.consentInboxRead) {
    audit(sessionId, "await_verification", { refused: "no_inbox_consent" });
    return buildConsentRefusal(sessionId);
  }

  invalidateCompactV2Snapshot(session);

  const verification = await runDetachedGoogleIdentityOperation(session, async (browser) => {
    const query = buildVerificationSearchQuery();
    const searchUrl = `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(query)}`;
    // DEDICATED utility tab, closed before this call returns. Navigating the
    // session's operation page to the mailbox RESETS the form/dialog that is
    // waiting for the code (Proton signup, gauntlet 2026-09-16: the signup
    // page reloads, the verification dialog closes, and the code can never be
    // entered). The tab shares the context's cookies, so Gmail's session
    // applies; the waiting page is never touched. Links are read from the raw
    // href attributes (extractRawMailLinks) — the size-capped interactive
    // inventory truncated a long Cal.com token into a dead URL.
    const inboxTab = await browser.openUtilityTab();
    try {
      const rawLinksOf = async (page: Page): Promise<VerificationLinkCandidate[]> => {
        const raw = await browser.extractRawMailLinks(page);
        return raw.map((l) => ({ url: l.href, text: l.visibleText }));
      };
      let code: string | null = null;
      let link: string | null = null;
      let sourceFrom: string | null = null;
      for (let attempt = 0; attempt < 3 && code === null && link === null; attempt++) {
        sourceFrom = null;
        if (attempt > 0)
          await waitForCaptchaChallengeToSettle(browser, 4000, 0, inboxTab).catch(() => false);
        await browser.goto(searchUrl, inboxTab);
        const { text: listText, links: listLinks } = await readGmailSearchResultsResilient(
          browser,
          searchUrl,
          inboxTab,
          rawLinksOf,
        );
        // Read the result ROWS with their From/display/subject/date metadata so
        // BOTH the sender filter and the newest-first pick are decisions made on
        // what the rows actually say — never on Gmail's search operators or on
        // trust in list order (Gmail orders by relevance). A controller without
        // these newer methods (older mock surface) falls back to the legacy
        // first-row open below.
        const mailRowsOf = (
          browser as BrowserController & {
            extractMailResultRows?: (page: Page | null) => Promise<MailResultRow[]>;
          }
        ).extractMailResultRows?.bind(browser);
        const openMailRowOf = (
          browser as BrowserController & {
            openMailResultRow?: (page: Page | null, selector: string) => Promise<boolean>;
          }
        ).openMailResultRow?.bind(browser);
        const rows = (await mailRowsOf?.(inboxTab).catch(() => [])) ?? [];
        let chosen: MailResultRow | null = null;
        if (rows.length > 0) {
          const matches = rows.filter((r) => mailRowMatchesSender(r, opts.sender));
          if (opts.sender !== undefined && opts.sender.length > 0 && matches.length === 0) {
            // The hint matched no row's From address, display name, or
            // subject: do NOT open some other row's mail and read its code.
            // Bounded retries, then an honest not-found.
            continue;
          }
          chosen = pickNewestMailRow(matches);
        }
        const opened =
          chosen !== null && openMailRowOf !== undefined
            ? await openMailRowOf(inboxTab, chosen.selector).catch(() => false)
            : await browser.openFirstMailResult(inboxTab).catch(() => false);
        if (opened) {
          // Read the opened message's OWN container (card + body) when Gmail
          // renders one, so page chrome never enters the code parse, the link
          // scoring, or the sender read. Falls back to the page-wide read,
          // where chrome anchors are still filtered out below. A controller
          // without this newer method (older mock surface) falls back too.
          const openedBodyOf = (
            browser as BrowserController & {
              extractOpenedMailBody?: (page: Page | null) => Promise<{
                text: string;
                links: Array<{ url: string; text: string | null }>;
              } | null>;
            }
          ).extractOpenedMailBody?.bind(browser);
          const body = (await openedBodyOf?.(inboxTab).catch(() => null)) ?? null;
          const openedText = body?.text ?? (await browser.extractVisibleText(inboxTab));
          const openedLinks = body?.links ?? (await rawLinksOf(inboxTab));
          sourceFrom = extractSenderEmail(openedText);
          const expectedDomains = expectedVerificationDomains(opts.sender, sourceFrom);
          ({ code, link } = parseVerification(
            openedText,
            [...openedLinks, ...listLinks].filter((l) => !isGmailChromeLink(l.url)),
            expectedDomains,
          ));
        } else if (chosen !== null) {
          // The identified row never opened: parse ONLY that row's own list
          // text (subject + snippet), never the page-wide list — another row's
          // snippet must not leak a foreign code, and this row's code still
          // parses when Gmail shows it in the list. No links: the list does
          // not carry the mail's action links (that is why the row is opened
          // at all), and page chrome must never be scored.
          ({ code, link } = parseVerification(
            chosen.visibleText,
            [],
            expectedVerificationDomains(opts.sender, null),
          ));
        } else {
          ({ code, link } = parseVerification(
            listText,
            listLinks.filter((l) => !isGmailChromeLink(l.url)),
            expectedVerificationDomains(opts.sender, null),
          ));
        }
      }
      return { code, link, sourceFrom };
    } finally {
      await inboxTab.close().catch(() => undefined);
    }
  });
  const { code, link, sourceFrom } = verification;
  const found = code !== null || link !== null;
  audit(sessionId, "await_verification", {
    sender: opts.sender ?? null,
    source_from: sourceFrom,
    has_code: code !== null,
    has_link: link !== null,
    sealed: opts.intoSlot !== undefined && code !== null,
    needs_user: !found,
  });
  // Seal the OTP into a slot when asked: the host gets a masked handle, not the
  // code, and enters it with type_secret. The link (not secret) is still returned.
  if (opts.intoSlot !== undefined && code !== null) {
    const handle = stashSecretSlot(sessionId, opts.intoSlot, code);
    return {
      session_id: sessionId,
      found: true,
      code: null,
      link,
      sealed: true,
      slot: handle,
      ...(sourceFrom !== null ? { source_from: sourceFrom } : {}),
    };
  }
  return buildVerificationResult(sessionId, code, link, sourceFrom);
}
