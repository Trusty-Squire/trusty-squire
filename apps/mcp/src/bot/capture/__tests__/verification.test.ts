// Pure-helper tests for the verification cluster, moved alongside the code
// from bot/__tests__/provision-session.test.ts when awaitVerification moved
// to bot/capture/verification.ts. The session-flow integration coverage for
// awaitVerification stays in bot/__tests__/operate-session-flow.test.ts.
import { describe, it, expect } from "vitest";
import {
  parseVerification,
  extractSenderEmail,
  expectedVerificationDomains,
  buildVerificationResult,
  buildConsentRefusal,
  buildVerificationSearchQuery,
  mailRowIsSessionCandidate,
  mailRowMatchedSession,
  mailRowMatchesRecipient,
  resolveInboxSearch,
  serviceHostFromUrl,
  isGmailChromeLink,
  mailRowMatchesSender,
  parseMailRowDate,
  mailRowIsRecent,
  mailRowPredatesSession,
  pickNewestMailRow,
  pickOpenedMailMessage,
  openedMailMatchesRecipient,
  registrableMailDomain,
  sessionCandidateReason,
  inboxReaderDiagEnabled,
  chooseMailRow,
  type MailResultRow,
  type OpenedMailMessage,
} from "../verification.js";

describe("parseVerification (email OTP + link extraction)", () => {
  it("prefers a code adjacent to an OTP keyword", () => {
    const text = "Your order 1842 shipped. Your verification code is 503914. Thanks.";
    expect(parseVerification(text, []).code).toBe("503914");
  });

  it("matches a code that precedes the keyword", () => {
    expect(parseVerification("Enter 284619 to verify your email", []).code).toBe("284619");
  });

  it("falls back to a standalone 4-8 digit run when no keyword is present", () => {
    expect(parseVerification("Your one time pin: 9087", []).code).toBe("9087");
  });

  it("returns null code when there is no plausible OTP", () => {
    expect(parseVerification("Welcome to the service! Get started now.", []).code).toBeNull();
  });

  it("picks a verification link from the mail's hrefs", () => {
    const links = [
      "https://mail.google.com/settings",
      "https://resend.com/verify-email?token=abc123def456",
    ];
    expect(parseVerification("Click to confirm your email", links).link).toContain("resend.com");
  });

  it("returns both code and link when present", () => {
    const r = parseVerification("Your code 778201. Or click https://x.com/confirm?t=zz", [
      "https://x.com/confirm?t=zz",
    ]);
    expect(r.code).toBe("778201");
    expect(r.link).toContain("confirm");
  });

  it("extracts a magic-link login CTA with no code (Resend 'Log in to Resend')", () => {
    const links = [
      "https://resend.com/unsubscribe?u=1",
      "https://resend.com/login?token=abc123def456",
    ];
    const r = parseVerification("Log in to Resend. Click the button below to log in.", links);
    expect(r.code).toBeNull();
    expect(r.link).toBe("https://resend.com/login?token=abc123def456");
  });

  it("extracts a Keycloak account-link CTA (Xata 'link your Google account')", () => {
    const links = [
      "https://auth.xata.io/realms/xata/login-actions/action-token?key=eyJhbGciOiJIUzI1NiJ9.abc",
      "https://xata.io/unsubscribe?u=2",
    ];
    const r = parseVerification(
      "Someone tried to link your account with a Google account. Click to confirm this action.",
      links,
    );
    expect(r.link).toBe(
      "https://auth.xata.io/realms/xata/login-actions/action-token?key=eyJhbGciOiJIUzI1NiJ9.abc",
    );
  });

  it("does not return an unsubscribe/footer link when a verify CTA is also present", () => {
    const links = [
      "https://example.com/unsubscribe?u=123",
      "https://example.com/email/preferences",
      "https://example.com/verify?token=abc123",
    ];
    const r = parseVerification("Please verify your email", links);
    expect(r.link).toBe("https://example.com/verify?token=abc123");
  });

  it("prefers a link on the expected (sender/source) domain when candidates tie otherwise", () => {
    const links = [
      "https://tracker.example.net/login?token=abc",
      "https://app.realservice.com/login?token=abc",
    ];
    const r = parseVerification("Log in to continue", links, ["realservice.com"]);
    expect(r.link).toBe("https://app.realservice.com/login?token=abc");
  });
});

describe("expectedVerificationDomains (host-preference hint for link picking)", () => {
  it("derives a domain from a bare-domain sender hint", () => {
    expect(expectedVerificationDomains("resend.com", null)).toEqual(["resend.com"]);
  });

  it("derives a domain from an email-address sender hint", () => {
    expect(expectedVerificationDomains("noreply@xata.io", null)).toEqual(["xata.io"]);
  });

  it("includes the opened message's sender domain", () => {
    expect(expectedVerificationDomains(undefined, "search-api@brave.com")).toEqual(["brave.com"]);
  });

  it("dedupes when both hints resolve to the same domain", () => {
    expect(expectedVerificationDomains("xata.io", "noreply@xata.io")).toEqual(["xata.io"]);
  });

  it("returns an empty array when neither hint is present", () => {
    expect(expectedVerificationDomains(undefined, null)).toEqual([]);
  });
});

describe("buildVerificationResult (Flow A — code-wall hand-back)", () => {
  it("returns the code with no needs_user when a code was found", () => {
    const r = buildVerificationResult("sk_1", "492013", null);
    expect(r).toMatchObject({ session_id: "sk_1", found: true, code: "492013" });
    expect(r.needs_user).toBeUndefined();
  });

  it("returns found=true with no needs_user when only a link was found", () => {
    const r = buildVerificationResult("sk_1", null, "https://x.example/confirm");
    expect(r.found).toBe(true);
    expect(r.needs_user).toBeUndefined();
  });

  it("hands back to the user (resumable) when neither code nor link was found", () => {
    const r = buildVerificationResult("sk_1", null, null);
    expect(r.found).toBe(false);
    expect(r.needs_user).toEqual({
      wall: "verification_code",
      // Steers to a retry first (emails lag the trigger), then the user-ask fallback.
      message: expect.stringContaining("operate_read_inbox AGAIN"),
      resume: "code",
    });
    expect(r.needs_user?.message.toLowerCase()).toContain("ask the user");
  });

  it("names the stale older mail in the hand-back when only pre-session matches were seen", () => {
    const r = buildVerificationResult("sk_1", null, null, null, true);
    expect(r.found).toBe(false);
    expect(r.needs_user?.wall).toBe("verification_code");
    expect(r.needs_user?.resume).toBe("code");
    expect(r.needs_user?.message).toContain("BEFORE this task started");
    // Still steers to the retry, and does NOT leak any old link as found.
    expect(r.link).toBeNull();
    expect(r.needs_user?.message).toContain("operate_read_inbox AGAIN");
  });

  it("names a host scope in the miss hint only when one was actually applied", () => {
    const scoped = buildVerificationResult("sk_1", null, null, null, false, {
      query: "newer_than:1d",
      sender: "app.example.test",
    });
    expect(scoped.needs_user?.message).toContain("host:app.example.test");
    // An IP/localhost read is not host-scoped, so claiming it was would send
    // the host agent looking for a filter that never ran.
    const unscoped = buildVerificationResult("sk_1", null, null, null, false, {
      query: "newer_than:1d",
      sender: "127.0.0.1",
    });
    expect(unscoped.needs_user?.message).toContain("Searched newer_than:1d");
    expect(unscoped.needs_user?.message).not.toContain("host:");
  });

  it("never marks a found result with the stale-match hand-back", () => {
    const r = buildVerificationResult("sk_1", null, "https://x.example/confirm", null, true);
    expect(r.found).toBe(true);
    expect(r.needs_user).toBeUndefined();
  });
});

describe("extractSenderEmail (source_from provenance — wrong-sender guard)", () => {
  it("pulls the sender from a Gmail 'Name <addr>' header", () => {
    const text = "Brave Search API <search-api@brave.com> 8:55 PM to me Please verify";
    expect(extractSenderEmail(text)).toBe("search-api@brave.com");
  });

  it("lowercases the address and returns null when no angled sender is present", () => {
    expect(extractSenderEmail("Support <No-Reply@Example.COM> hi")).toBe("no-reply@example.com");
    expect(extractSenderEmail("Your verification code is 123456")).toBeNull();
  });

  it("buildVerificationResult surfaces source_from when provided, omits it otherwise", () => {
    expect(
      buildVerificationResult("sk_1", "492013", null, "search-api@brave.com").source_from,
    ).toBe("search-api@brave.com");
    expect(buildVerificationResult("sk_1", "492013", null).source_from).toBeUndefined();
  });
});

describe("buildConsentRefusal (PR2 — inbox-read consent withheld)", () => {
  it("hands back resumably without a code and names the consent reason", () => {
    const r = buildConsentRefusal("sk_2");
    expect(r).toMatchObject({ session_id: "sk_2", found: false, code: null, link: null });
    expect(r.needs_user).toEqual({
      wall: "verification_code",
      message: expect.stringContaining("Inbox reading is disabled"),
      resume: "code",
    });
  });
});

describe("buildVerificationSearchQuery (finds passwordless mail)", () => {
  it("covers passwordless sign-in / login vocabulary, not just OTP words", () => {
    // Regression: a Loops "Login link" email ("Please login… Login") has none of
    // verify/confirm/code/otp, so the old query missed it → found:false.
    const q = buildVerificationSearchQuery();
    expect(q).toContain("login");
    expect(q).toContain('"sign in"');
    expect(q).toContain("verify");
    expect(q).toContain("newer_than:1d");
    expect(q).not.toContain("from:");
  });
  it("covers sign-up vocabulary — the craigslist activation miss (rc.35 #828)", () => {
    // MEASURED live 2026-09-17: craigslist's activation email (subject
    // "craigslist account sign-up", body "complete account sign-up") matched
    // NONE of the old keywords, so `from:craigslist newer_than:1d (verify OR
    // …)` rendered "No matches" in Gmail and the tool returned found:false
    // while the mail sat unread in the inbox — `from:craigslist
    // newer_than:1d` alone found it fine; the keyword clause was the veto.
    const q = buildVerificationSearchQuery();
    expect(q).toContain('"sign up"');
    expect(q).toContain("signup");
    // Sender narrowing is client-side now (the From address, display name,
    // and subject of the returned rows are all matched), so one brittle
    // Gmail operator must not gate the query.
    expect(q).not.toContain("from:");
  });
  it("scopes the Gmail query to the session recipient when one is known", () => {
    const q = buildVerificationSearchQuery({
      recipient: "ada+run1@example.test",
    });
    expect(q.startsWith("to:ada+run1@example.test ")).toBe(true);
    expect(q).toContain("newer_than:1d");
    expect(buildVerificationSearchQuery().startsWith("to:")).toBe(false);
  });
  it("end-to-end: the real Loops login email now yields its magic link", () => {
    // The actual email body + the actual /api/auth/callback link (token redacted).
    const body =
      "Please login to Loops by clicking the button below. Login Alternatively, you can click here. If you didn't request this, please reply.";
    const links = [
      "https://loops.so",
      "https://app.loops.so/api/auth/callback/email?callbackUrl=https%3A%2F%2Fapp.loops.so%2Fadd-domain&token=REDACTED&email=x%40y.com",
      "https://loops.so?utm_source=footer",
    ];
    const { link } = parseVerification(body, links);
    expect(link).toBe(
      "https://app.loops.so/api/auth/callback/email?callbackUrl=https%3A%2F%2Fapp.loops.so%2Fadd-domain&token=REDACTED&email=x%40y.com",
    );
  });
});

describe("isGmailChromeLink (mailbox chrome never scores as a verification link)", () => {
  it("drops the account-menu URL the 1.1.14 Proton defect returned", () => {
    expect(
      isGmailChromeLink(
        "https://accounts.google.com/SignOutOptions?hl=en&continue=https://mail.google.com/mail/u/0/",
      ),
    ).toBe(true);
  });

  it("drops the mailbox app itself, its hash UI, and Google support chrome", () => {
    expect(isGmailChromeLink("https://mail.google.com/mail/u/0/#inbox")).toBe(true);
    expect(isGmailChromeLink("#compose")).toBe(true);
    expect(
      isGmailChromeLink(
        "https://support.google.com/mail/answer/91324?hl=en&continue=https://mail.google.com/mail/u/0/",
      ),
    ).toBe(true);
  });

  it("keeps ordinary accounts.google.com surfaces other than the account menu", () => {
    expect(isGmailChromeLink("https://accounts.google.com/o/oauth2/auth?client_id=x")).toBe(false);
  });

  it("keeps everything that is not Google mailbox chrome, including trackers", () => {
    expect(isGmailChromeLink("https://mail.proton.me/click-tracking?u=abc123def456")).toBe(false);
    expect(
      isGmailChromeLink(
        "https://click.esp-service.com/redirect?u=https%3A%2F%2Fexample.com%2Fverify%3Ftoken%3Dabc",
      ),
    ).toBe(false);
  });
});

describe("mailRowMatchesSender (From address + display name + subject, not one field)", () => {
  const craigslistRow = {
    fromEmail: "automail@craigslist.org",
    fromName: "craigslist",
    subject: "craigslist account sign-up",
  };
  it("matches the From address, the display name, and the subject", () => {
    expect(mailRowMatchesSender(craigslistRow, "craigslist.org")).toBe(true);
    expect(mailRowMatchesSender(craigslistRow, "craigslist")).toBe(true);
    expect(mailRowMatchesSender(craigslistRow, "sign-up")).toBe(true);
  });
  it("requires every token of a multi-token hint across the fields", () => {
    expect(mailRowMatchesSender(craigslistRow, "craigslist activation")).toBe(false);
    expect(mailRowMatchesSender(craigslistRow, "craigslist sign-up")).toBe(true);
  });
  it("rejects rows that plainly do not match", () => {
    expect(mailRowMatchesSender(craigslistRow, "proton.me")).toBe(false);
    expect(
      mailRowMatchesSender(
        { fromEmail: "no-reply@proton.me", fromName: "Proton", subject: "Verification code" },
        "craigslist",
      ),
    ).toBe(false);
  });
  it("keeps rows without From/subject metadata as candidates", () => {
    // Legacy surfaces carry no metadata; the query and newest-first pick
    // still bound what gets opened. Filtering them out would turn every
    // legacy row into a false not-found.
    expect(
      mailRowMatchesSender({ fromEmail: null, fromName: null, subject: null }, "proton.me"),
    ).toBe(true);
  });
  it("matches everything when no hint is given", () => {
    expect(mailRowMatchesSender(craigslistRow, undefined)).toBe(true);
    expect(mailRowMatchesSender(craigslistRow, "   ")).toBe(true);
  });
});

describe("pickNewestMailRow (relevance order must not decide recency)", () => {
  const row = (over: Partial<MailResultRow> & { dateTitle: string | null }) => ({
    selector: '[data-ts-mail-row="0"]',
    fromEmail: null,
    fromName: null,
    subject: null,
    visibleText: "",
    ...over,
  });
  it("picks the newest dated row, not the first in list order", () => {
    // The live rc.35 order: the OLD Proton code ranked FIRST by relevance.
    const newest = pickNewestMailRow([
      row({ dateTitle: "Sep 16, 2026, 11:39 PM", visibleText: "proton 934870" }),
      row({ dateTitle: "Sep 17, 2026, 5:03 AM", visibleText: "cal.com" }),
      row({ dateTitle: "Sep 17, 2026, 5:10 AM", visibleText: "craigslist" }),
    ]);
    expect(newest?.visibleText).toBe("craigslist");
  });
  it("keeps undated rows after all dated ones in list order", () => {
    const best = pickNewestMailRow([
      row({ dateTitle: null, visibleText: "undated-first" }),
      row({ dateTitle: "Sep 17, 2026, 5:10 AM", visibleText: "dated" }),
      row({ dateTitle: null, visibleText: "undated-second" }),
    ]);
    expect(best?.visibleText).toBe("dated");
  });
  it("falls back to the first row when nothing is dated", () => {
    const best = pickNewestMailRow([
      row({ dateTitle: null, visibleText: "first" }),
      row({ dateTitle: null, visibleText: "second" }),
    ]);
    expect(best?.visibleText).toBe("first");
  });
  it("returns null for an empty list", () => {
    expect(pickNewestMailRow([])).toBeNull();
  });
  it("parseMailRowDate accepts Gmail's title shapes and rejects junk", () => {
    expect(parseMailRowDate("Sep 17, 2026, 5:10 AM")).not.toBeNull();
    expect(parseMailRowDate("Wed, Sep 16, 2026, 11:39 PM")).not.toBeNull();
    expect(parseMailRowDate(null)).toBeNull();
    expect(parseMailRowDate("Not starred")).toBeNull();
  });
});

describe("chooseMailRow (real-time All Mail supplement vs eventually-consistent search)", () => {
  const row = (over: Partial<MailResultRow> & { dateTitle: string | null }) => ({
    selector: '[data-ts-mail-row="0"]',
    fromEmail: null,
    fromName: null,
    subject: null,
    visibleText: "",
    ...over,
  });
  it("keeps the search pick when the All Mail listing has no match", () => {
    const search = row({ dateTitle: "Sep 17, 2026, 5:10 AM", visibleText: "search" });
    expect(chooseMailRow(search, null)).toBe(search);
  });
  it("takes the All Mail row when the search listing matched nothing (the #828 stale-index window)", () => {
    const allMail = row({ dateTitle: "Sep 17, 2026, 5:10 AM", visibleText: "all-mail" });
    expect(chooseMailRow(null, allMail)).toBe(allMail);
    expect(chooseMailRow(null, null)).toBeNull();
  });
  it("prefers the newer All Mail row when search matched an older indexed mail (the #831 staleness variant)", () => {
    const search = row({ dateTitle: "Sep 17, 2026, 5:03 AM", visibleText: "stale-search" });
    const allMail = row({ dateTitle: "Sep 17, 2026, 5:10 AM", visibleText: "fresh-all-mail" });
    expect(chooseMailRow(search, allMail)).toBe(allMail);
  });
  it("keeps the search row on date ties and when the All Mail row is undated", () => {
    const search = row({ dateTitle: "Sep 17, 2026, 5:10 AM", visibleText: "search" });
    const tie = row({ dateTitle: "Sep 17, 2026, 5:10 AM", visibleText: "tie" });
    expect(chooseMailRow(search, tie)).toBe(search);
    const undated = row({ dateTitle: null, visibleText: "undated" });
    expect(chooseMailRow(search, undated)).toBe(search);
  });
  it("defers to the All Mail row when the search row's date is unparseable", () => {
    const search = row({ dateTitle: null, visibleText: "undated-search" });
    const allMail = row({ dateTitle: "Sep 17, 2026, 5:10 AM", visibleText: "all-mail" });
    expect(chooseMailRow(search, allMail)).toBe(allMail);
  });
});

describe("mailRowIsRecent (All Mail supplement's newer_than:1d pool bound)", () => {
  const row = (dateTitle: string | null): MailResultRow => ({
    selector: '[data-ts-mail-row="0"]',
    fromEmail: null,
    fromName: null,
    subject: null,
    dateTitle,
    visibleText: "",
  });
  it("accepts a row within 24h of now", () => {
    const now = Date.now();
    expect(mailRowIsRecent(row(new Date(now - 60_000).toString()), now)).toBe(true);
    expect(mailRowIsRecent(row(new Date(now - 23.5 * 60 * 60 * 1000).toString()), now)).toBe(true);
  });
  it("rejects a row older than 24h", () => {
    const now = Date.now();
    expect(mailRowIsRecent(row(new Date(now - 25 * 60 * 60 * 1000).toString()), now)).toBe(false);
  });
  it("rejects rows without a parseable date", () => {
    const now = Date.now();
    expect(mailRowIsRecent(row(null), now)).toBe(false);
    expect(mailRowIsRecent(row("Not starred"), now)).toBe(false);
  });
});

describe("mailRowPredatesSession (a previous task's mail never becomes this task's hit)", () => {
  const row = (dateTitle: string | null): MailResultRow => ({
    selector: '[data-ts-mail-row="0"]',
    fromEmail: null,
    fromName: null,
    subject: null,
    dateTitle,
    visibleText: "",
  });
  const sessionStart = new Date("2026-09-17T05:00:00").getTime();
  it("marks a row dated before the session start as predating", () => {
    // The 2026-09-17 rc.1 craigslist stale-link defect: a fresh signup's
    // read returned the older account's already-consumed activation link.
    expect(mailRowPredatesSession(row("Sep 16, 2026, 11:39 PM"), sessionStart)).toBe(true);
  });
  it("keeps a row dated after the session start", () => {
    expect(mailRowPredatesSession(row("Sep 17, 2026, 5:10 AM"), sessionStart)).toBe(false);
    expect(mailRowPredatesSession(row("Sep 17, 2026, 5:00 AM"), sessionStart)).toBe(false);
  });
  it("keeps a same-minute row whose listing date floors before the millisecond session start", () => {
    const sessionInMinute = new Date("2026-09-20T16:20:56").getTime();
    expect(mailRowPredatesSession(row("Sep 20, 2026, 4:20 PM"), sessionInMinute)).toBe(false);
    expect(mailRowPredatesSession(row("Sep 20, 2026, 4:19 PM"), sessionInMinute)).toBe(true);
  });
  it("never marks rows without a parseable date (cannot be proven old)", () => {
    expect(mailRowPredatesSession(row(null), sessionStart)).toBe(false);
    expect(mailRowPredatesSession(row("Not starred"), sessionStart)).toBe(false);
  });
});

describe("session-scoped inbox candidates", () => {
  const row = (partial: Partial<MailResultRow>): MailResultRow => ({
    selector: '[data-ts-mail-row="0"]',
    fromEmail: null,
    fromName: null,
    subject: null,
    dateTitle: null,
    visibleText: "",
    ...partial,
  });

  it("rejects a verification mail that matches neither recipient nor service host", () => {
    const foreign = row({
      fromEmail: "support@other.test",
      subject: "Confirm your registration",
      visibleText: "Confirm your registration",
    });
    expect(
      mailRowIsSessionCandidate(foreign, {
        recipient: "ada+run1@example.test",
        serviceHost: "app.example.test",
      }),
    ).toBe(false);
    expect(mailRowIsSessionCandidate(foreign, { serviceHost: "app.example.test" })).toBe(false);
    expect(mailRowIsSessionCandidate(foreign, {})).toBe(false);
  });

  it("accepts a to-scoped search row when From or the plus-address ties it to this session", () => {
    const espOnly = row({
      fromEmail: "notify@mailer.other.test",
      subject: "Check your email",
      visibleText: "Check your email",
    });
    // A to:-scoped listing already filtered by recipient; From can omit the
    // product host. Opening is cheap; To is decided on the opened message.
    expect(
      mailRowIsSessionCandidate(espOnly, {
        recipient: "ada+run1@example.test",
        serviceHost: "app.example.test",
        listingScopedToRecipient: true,
      }),
    ).toBe(true);
    expect(
      sessionCandidateReason(espOnly, {
        recipient: "ada+run1@example.test",
        serviceHost: "app.example.test",
        listingScopedToRecipient: true,
      }).reason,
    ).toBe("listing_scoped");
    expect(
      mailRowIsSessionCandidate(row({ ...espOnly, fromEmail: "notify@mail.app.example.test" }), {
        recipient: "ada+run1@example.test",
        serviceHost: "app.example.test",
        listingScopedToRecipient: true,
      }),
    ).toBe(true);
    expect(
      mailRowIsSessionCandidate(row({ ...espOnly, visibleText: "to ada+run1@example.test" }), {
        recipient: "ada+run1@example.test",
        serviceHost: "app.example.test",
        listingScopedToRecipient: true,
      }),
    ).toBe(true);
    expect(mailRowMatchesRecipient(espOnly, "ada+run1@example.test")).toBe(false);
  });

  it("matches a conversation row whose From is a subdomain of the service host", () => {
    // Live mailbox shape: one conversation groups a day's confirmations
    // ("service (19)"), From is an ESP subdomain, dateTitle is minute
    // precision, and the listing never shows To.
    const conversation = row({
      fromEmail: "notify@mailer.example.test",
      fromName: "example (19)",
      subject: "Confirm your account",
      dateTitle: "Sep 20, 2026, 4:20 PM",
      visibleText: "example (19) Confirm your account 4:20 PM",
    });
    expect(registrableMailDomain("notify@mailer.example.test")).toBe("example.test");
    expect(mailRowMatchesSender(conversation, "example.test")).toBe(true);
    expect(mailRowMatchesSender(conversation, "app.example.test")).toBe(true);
    expect(
      mailRowIsSessionCandidate(conversation, {
        recipient: "ada+run1@example.test",
        serviceHost: "app.example.test",
        listingScopedToRecipient: true,
      }),
    ).toBe(true);
    // All Mail omits To: service-host match is enough to open; To is later.
    expect(
      mailRowIsSessionCandidate(conversation, {
        recipient: "ada+run1@example.test",
        serviceHost: "app.example.test",
      }),
    ).toBe(true);
    expect(mailRowMatchesRecipient(conversation, "ada+run1@example.test")).toBe(false);
  });

  it("matches a page-host hint against the registrable From domain", () => {
    expect(
      mailRowMatchesSender(
        {
          fromEmail: "noreply@example.test",
          fromName: "Example",
          subject: "Confirm your account",
        },
        "app.example.test",
      ),
    ).toBe(true);
    expect(
      mailRowMatchesSender(
        {
          fromEmail: "noreply@other.test",
          fromName: "Other",
          subject: "Confirm your account",
        },
        "app.example.test",
      ),
    ).toBe(false);
  });

  it("keeps domain scoping for a real hostname and ignores it for an IP/localhost host (#888 IP-host regression)", () => {
    // A real hostname scopes: a foreign sender's mail is NOT a candidate.
    const foreign = row({
      fromEmail: "support@other.test",
      subject: "Confirm your registration",
      visibleText: "Confirm your registration",
    });
    expect(sessionCandidateReason(foreign, { serviceHost: "app.example.test" }).reason).toBe(
      "service_host_mismatch",
    );
    expect(mailRowIsSessionCandidate(foreign, { serviceHost: "app.example.test" })).toBe(false);
    // An IP/localhost start URL yields the IP as the service host; no From
    // address can ever match it, so scoping there blocks every candidate and
    // protects nothing. The row stays a candidate and the newest-row pick runs.
    expect(serviceHostFromUrl("http://127.0.0.1:4173/signup")).toBe("127.0.0.1");
    expect(registrableMailDomain("127.0.0.1")).toBeNull();
    expect(sessionCandidateReason(foreign, { serviceHost: "127.0.0.1" }).reason).toBe(
      "unscopeable_host",
    );
    expect(mailRowIsSessionCandidate(foreign, { serviceHost: "127.0.0.1" })).toBe(true);
    expect(mailRowIsSessionCandidate(foreign, { serviceHost: "localhost" })).toBe(true);
    expect(serviceHostFromUrl("http://[::1]:4173/signup")).toBe("[::1]");
    expect(mailRowIsSessionCandidate(foreign, { serviceHost: "[::1]" })).toBe(true);
    // A single-label intranet host has no registrable domain either, but it IS
    // matchable by From substring/token, so it keeps its scoping: a foreign
    // sender stays out and the intranet service's own mail stays in.
    expect(sessionCandidateReason(foreign, { serviceHost: "gitlab" }).reason).toBe(
      "service_host_mismatch",
    );
    expect(mailRowIsSessionCandidate(foreign, { serviceHost: "gitlab" })).toBe(false);
    expect(
      sessionCandidateReason(row({ ...foreign, fromEmail: "noreply@gitlab.corp.example" }), {
        serviceHost: "gitlab",
      }).reason,
    ).toBe("service_host");
    // With a recipient too, an unscopeable host imposes no From requirement.
    expect(
      mailRowIsSessionCandidate(foreign, {
        recipient: "ada+run1@example.test",
        serviceHost: "127.0.0.1",
      }),
    ).toBe(false);
    expect(
      mailRowIsSessionCandidate(row({ ...foreign, visibleText: "to ada+run1@example.test" }), {
        recipient: "ada+run1@example.test",
        serviceHost: "127.0.0.1",
      }),
    ).toBe(true);
  });

  it("counts a row as MATCHING the session only when it matched recipient or host", () => {
    const foreign = row({
      fromEmail: "support@other.test",
      subject: "Confirm your registration",
      visibleText: "Confirm your registration",
    });
    const own = row({
      fromEmail: "hello@app.example.test",
      subject: "Confirm your account",
      visibleText: "Confirm your account",
    });
    expect(mailRowMatchedSession(own, { serviceHost: "app.example.test" })).toBe(true);
    expect(
      mailRowMatchedSession(row({ ...foreign, visibleText: "to ada+run1@example.test" }), {
        recipient: "ada+run1@example.test",
      }),
    ).toBe(true);
    // Admitted only because the host is unscopeable: a candidate, but it
    // matched nothing about this session, so it is not stale-match evidence.
    expect(mailRowIsSessionCandidate(foreign, { serviceHost: "127.0.0.1" })).toBe(true);
    expect(mailRowMatchedSession(foreign, { serviceHost: "127.0.0.1" })).toBe(false);
    expect(mailRowMatchedSession(foreign, { serviceHost: "app.example.test" })).toBe(false);
  });

  it("opens an unscoped same-service row and rejects the wrong plus-address after open", () => {
    // All Mail never shows To, so a same-service conversation is openable.
    // The wrong plus-address is dropped on the opened message, not the row.
    const otherRun = row({
      fromEmail: "hello@app.example.test",
      subject: "Confirm your account",
      visibleText: "to ada+run0@example.test",
    });
    expect(
      mailRowIsSessionCandidate(otherRun, {
        recipient: "ada+run1@example.test",
        serviceHost: "app.example.test",
      }),
    ).toBe(true);
    expect(
      mailRowIsSessionCandidate(row({ ...otherRun, visibleText: "to ada+run1@example.test" }), {
        recipient: "ada+run1@example.test",
        serviceHost: "app.example.test",
      }),
    ).toBe(true);
  });

  it("resolves recipient from drive facts and host from the session start URL", () => {
    const search = resolveInboxSearch({
      startUrl: "https://app.example.test/signup",
      drive: { facts: { email: "ada+run1@example.test" } },
    });
    expect(search.recipient).toBe("ada+run1@example.test");
    expect(search.sender).toBe("app.example.test");
    expect(search.query.startsWith("to:ada+run1@example.test ")).toBe(true);
    expect(serviceHostFromUrl("https://app.example.test/signup")).toBe("app.example.test");
  });
});

describe("pickOpenedMailMessage (per-message To, never the conversation's first card)", () => {
  const msg = (over: Partial<OpenedMailMessage>): OpenedMailMessage => ({
    fromEmail: "notify@mailer.example.test",
    fromName: "example",
    dateTitle: "Sep 20, 2026, 4:00 PM",
    toEmails: [],
    text: "",
    links: [],
    ...over,
  });
  const sessionStart = new Date("2026-09-20T16:20:30").getTime();

  it("picks the message whose To is the session recipient, not an older sibling", () => {
    const older = msg({
      toEmails: ["ada+run0@example.test"],
      text: "Confirm older run",
      dateTitle: "Sep 20, 2026, 3:10 PM",
      links: [{ url: "https://example.test/confirm?t=old", text: "Confirm" }],
    });
    const newestWrong = msg({
      toEmails: ["ada+run2@example.test"],
      text: "Confirm other plus-address",
      dateTitle: "Sep 20, 2026, 4:25 PM",
      links: [{ url: "https://example.test/confirm?t=other", text: "Confirm" }],
    });
    const ours = msg({
      toEmails: ["ada+run1@example.test"],
      text: "Confirm this run sent to ada+run1@example.test",
      dateTitle: "Sep 20, 2026, 4:20 PM",
      links: [{ url: "https://example.test/confirm?t=fresh", text: "Confirm" }],
    });
    const picked = pickOpenedMailMessage([older, ours, newestWrong], {
      recipient: "ada+run1@example.test",
      serviceHost: "app.example.test",
      sessionStartMs: sessionStart,
    });
    expect(picked).toBe(ours);
    expect(openedMailMatchesRecipient(newestWrong, "ada+run1@example.test")).toBe(false);
  });

  it("matches recipient from the opened body when To headers are only 'to me'", () => {
    const picked = pickOpenedMailMessage(
      [
        msg({
          toEmails: [],
          text: "This email was sent to ada+run1@example.test to confirm",
          dateTitle: "Sep 20, 2026, 4:20 PM",
        }),
      ],
      {
        recipient: "ada+run1@example.test",
        sessionStartMs: sessionStart,
      },
    );
    expect(picked?.text).toContain("ada+run1@example.test");
  });

  it("returns null when no opened message is To the session recipient", () => {
    expect(
      pickOpenedMailMessage(
        [
          msg({
            toEmails: ["ada+run0@example.test"],
            text: "Confirm older run",
            dateTitle: "Sep 20, 2026, 4:20 PM",
          }),
        ],
        { recipient: "ada+run1@example.test", sessionStartMs: sessionStart },
      ),
    ).toBeNull();
  });

  it("picks the newest card for an IP host and still scopes a single-label host", () => {
    const stale = msg({
      text: "Your code is 111111",
      dateTitle: "Sep 20, 2026, 3:10 PM",
    });
    const fresh = msg({
      text: "Your code is 222222",
      dateTitle: "Sep 20, 2026, 4:25 PM",
    });
    // No recipient, IP service host: the From can never match it, so the pool
    // must stay whole and the newest-after-session card wins. Filtering on the
    // raw IP empties the pool, which sends the read to the whole-conversation
    // fallback and returns the older, already-consumed code.
    expect(
      pickOpenedMailMessage([stale, fresh], {
        serviceHost: "127.0.0.1",
        sessionStartMs: sessionStart,
      }),
    ).toBe(fresh);
    // A single-label host is matchable, so it still filters the pool. It is
    // dated OLDER than the foreign card on purpose: losing that scoping would
    // leave both in the pool and the newest-row pick would return `fresh`.
    const intranet = msg({
      fromEmail: "noreply@gitlab.corp.example",
      fromName: "GitLab",
      text: "Your code is 333333",
      dateTitle: "Sep 20, 2026, 4:22 PM",
    });
    expect(
      pickOpenedMailMessage([intranet, fresh], {
        serviceHost: "gitlab",
        sessionStartMs: sessionStart,
      }),
    ).toBe(intranet);
  });

  it("returns a matching-To message even when it predates a later re-read session", () => {
    const mail = msg({
      toEmails: ["ada+run1@example.test"],
      text: "Confirm this run",
      dateTitle: "Sep 20, 2026, 4:20 PM",
    });
    const laterSession = new Date("2026-09-20T16:40:00").getTime();
    expect(
      pickOpenedMailMessage([mail], {
        recipient: "ada+run1@example.test",
        sessionStartMs: laterSession,
      }),
    ).toBe(mail);
  });
});

describe("inboxReaderDiagEnabled", () => {
  it("is off by default and on for 1/true/on/yes", () => {
    expect(inboxReaderDiagEnabled({})).toBe(false);
    expect(inboxReaderDiagEnabled({ TRUSTY_SQUIRE_INBOX_READER_DIAG: "1" })).toBe(true);
    expect(inboxReaderDiagEnabled({ TRUSTY_SQUIRE_INBOX_READER_DIAG: "true" })).toBe(true);
    expect(inboxReaderDiagEnabled({ TRUSTY_SQUIRE_INBOX_READER_DIAG: "off" })).toBe(false);
  });
});
