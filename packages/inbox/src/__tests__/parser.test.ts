// Parser + OTP/link extraction tests.

import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  EncryptedEmailError,
  extractLinks,
  extractOtp,
  matchString,
  parseRfc822,
} from "../index.js";

const PLAIN_EMAIL = `From: noreply@resend.com\r
To: alex.resend.run-01h@mail.trustysquire.ai\r
Subject: Verify your email\r
Message-ID: <abc123@resend.com>\r
Content-Type: text/plain; charset=utf-8\r
\r
Welcome! Your verification code is 482915.\r
Click https://resend.com/verify?token=tok_xyz to confirm.\r
`;

const HTML_EMAIL = `From: noreply@resend.com\r
To: alex.resend.run-01h@mail.trustysquire.ai\r
Subject: Confirm signup\r
Message-ID: <html-1@resend.com>\r
Content-Type: text/html; charset=utf-8\r
\r
<p>Your code: <strong>123456</strong></p>\r
<p><a href="https://resend.com/click?u=42">Confirm here</a></p>\r
`;

const MULTIPART_EMAIL = `From: noreply@example.com\r
To: a@mail.trustysquire.ai\r
Subject: Multipart\r
Message-ID: <mp-1@example.com>\r
MIME-Version: 1.0\r
Content-Type: multipart/alternative; boundary="boundary42"\r
\r
--boundary42\r
Content-Type: text/plain\r
\r
Code: 8881\r
Visit https://example.com/x\r
\r
--boundary42\r
Content-Type: text/html\r
\r
<p>Code: <strong>8881</strong></p>\r
<a href="https://example.com/x">link</a>\r
--boundary42--\r
`;

const PGP_EMAIL = `From: secure@example.com\r
To: a@mail.trustysquire.ai\r
Subject: Encrypted\r
Message-ID: <pgp-1@example.com>\r
Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"\r
\r
opaque-cipher-bytes\r
`;

describe("parseRfc822", () => {
  it("extracts links + 6-digit code from a plain text email", async () => {
    const parsed = await parseRfc822(Buffer.from(PLAIN_EMAIL));
    expect(parsed.from_address).toBe("noreply@resend.com");
    expect(parsed.from_domain).toBe("resend.com");
    expect(parsed.subject).toBe("Verify your email");
    expect(parsed.message_id).toContain("abc123@resend.com");
    expect(parsed.codes).toContain("482915");
    expect(parsed.links).toContain("https://resend.com/verify?token=tok_xyz");
  });

  it("extracts code + link from an HTML email", async () => {
    const parsed = await parseRfc822(Buffer.from(HTML_EMAIL));
    expect(parsed.codes).toContain("123456");
    expect(parsed.links).toContain("https://resend.com/click?u=42");
  });

  it("multipart email surfaces both bodies and dedupes codes/links", async () => {
    const parsed = await parseRfc822(Buffer.from(MULTIPART_EMAIL));
    expect(parsed.body_text).toContain("Code: 8881");
    expect(parsed.body_html).toContain("<strong>");
    expect(parsed.codes).toEqual(["8881"]);
    expect(parsed.links).toEqual(["https://example.com/x"]);
  });

  it("rejects PGP/encrypted email with EncryptedEmailError", async () => {
    await expect(parseRfc822(Buffer.from(PGP_EMAIL))).rejects.toThrow(EncryptedEmailError);
  });

  it("captures To: addresses (lowercased downstream by the handler)", async () => {
    const parsed = await parseRfc822(Buffer.from(PLAIN_EMAIL));
    expect(parsed.to_addresses).toEqual(["alex.resend.run-01h@mail.trustysquire.ai"]);
  });
});

describe("extractOtp", () => {
  it("returns null when no code is present", () => {
    expect(extractOtp("nothing here, just words")).toBeNull();
  });

  it("matches 6-digit standalone first", () => {
    expect(extractOtp("Welcome 123456 to the club")).toBe("123456");
  });

  it("falls back to labeled 'code:' patterns", () => {
    expect(extractOtp("Your code: 4321 expires in 10m")).toBe("4321");
  });

  it("matches 'verification: 555111'", () => {
    expect(extractOtp("verification: 555111")).toBe("555111");
  });

  it("matches 3-3 split format when no 6-digit run is present", () => {
    // "Code: 123-456" — the 6-digit pattern's word boundary still
    // matches "123456"-equivalent? Actually "123-456" has \b between
    // the digits and dash, so 6-digit does NOT match; 3-3 split fires.
    expect(extractOtp("Code: 123-456")).toBe("123456");
    expect(extractOtp("Use 111 222 to confirm.")).toBe("111222");
  });

  it("custom regex takes precedence over default patterns", () => {
    expect(extractOtp("X 123456 Y", /Y(\d+)/)).toBeNull();
    expect(extractOtp("PIN=A1B2C3", /PIN=([A-Z0-9]+)/)).toBe("A1B2C3");
  });
});

describe("extractLinks", () => {
  it("strips trailing punctuation", () => {
    expect(extractLinks("Visit https://example.com/foo.")).toEqual([
      "https://example.com/foo",
    ]);
  });

  it("dedupes identical links", () => {
    const out = extractLinks("https://x.com same https://x.com");
    expect(out).toEqual(["https://x.com"]);
  });

  it("returns [] when no links", () => {
    expect(extractLinks("plain text only")).toEqual([]);
  });
});

describe("matchString", () => {
  it("string is case-insensitive substring match", () => {
    expect(matchString("Welcome to RESEND", "resend")).toBe(true);
    expect(matchString("Welcome", "noreply")).toBe(false);
  });

  it("RegExp uses .test() literally", () => {
    expect(matchString("123456", /^\d{6}$/)).toBe(true);
    expect(matchString("not a number", /^\d+$/)).toBe(false);
  });
});
