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
  isGmailChromeLink,
  mailRowMatchesSender,
  parseMailRowDate,
  mailRowIsRecent,
  mailRowPredatesSession,
  pickNewestMailRow,
  chooseMailRow,
  type MailResultRow,
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
    expect(
      mailRowPredatesSession(row("Sep 16, 2026, 11:39 PM"), sessionStart),
    ).toBe(true);
  });
  it("keeps a row dated after the session start", () => {
    expect(
      mailRowPredatesSession(row("Sep 17, 2026, 5:10 AM"), sessionStart),
    ).toBe(false);
    expect(
      mailRowPredatesSession(row("Sep 17, 2026, 5:00 AM"), sessionStart),
    ).toBe(false);
  });
  it("never marks rows without a parseable date (cannot be proven old)", () => {
    expect(mailRowPredatesSession(row(null), sessionStart)).toBe(false);
    expect(mailRowPredatesSession(row("Not starred"), sessionStart)).toBe(false);
  });
});
