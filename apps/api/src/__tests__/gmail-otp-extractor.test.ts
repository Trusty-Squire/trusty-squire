// OTP extractor — pinned by the 2026-05-26 rc.27 → rc.30 regression
// where the naive /\b(\d{6,8})\b/ picked up a date timestamp
// (e.g. "20260526") instead of the actual verification code. The
// strict pass now anchors on the keyword "code"/"OTP"/"verify"
// near the digits.

import { describe, it, expect } from "vitest";
import { decodeMimeBody, extractOtp } from "../services/gmail-otp-poller.js";

describe("extractOtp — strict keyword-anchored pass", () => {
  it("returns the OTP after 'verification code:'", () => {
    expect(
      extractOtp("Your verification code is: 482915. It expires in 10 minutes."),
    ).toBe("482915");
  });

  it("returns the OTP after 'Enter this code:'", () => {
    expect(extractOtp("Enter this code: 123456 to verify.")).toBe("123456");
  });

  it("handles 8-digit codes (WorkOS shape)", () => {
    expect(extractOtp("Your code: 20264805")).toBe("20264805");
  });

  it("strips spaces between digits (some services display 1 2 3 4 5 6)", () => {
    expect(extractOtp("Use code: 1 2 3 4 5 6")).toBe("123456");
  });

  it("strips dashes between digits", () => {
    expect(extractOtp("Code: 123-456")).toBe("123456");
  });

  it("matches 'one-time' keyword variants", () => {
    expect(extractOtp("Your one-time password: 987654")).toBe("987654");
    expect(extractOtp("Your one time code: 555111")).toBe("555111");
  });

  it("matches OTP keyword", () => {
    expect(extractOtp("OTP: 654321")).toBe("654321");
  });
});

describe("extractOtp — date-rejection in fallback pass", () => {
  it("does NOT return 20260526 (a date) when no keyword anchor present", () => {
    // The 2026-05-26 regression input: an email with date in the
    // header/timestamp area and no explicit code keyword.
    expect(
      extractOtp("Email received on 20260526. No further content."),
    ).toBeNull();
  });

  it("does NOT return a 4-digit year alone", () => {
    expect(extractOtp("Copyright 2026 Acme Corp.")).toBeNull();
  });

  it("falls back to the first non-date 6-digit run when no keyword anchor present", () => {
    expect(extractOtp("Reference id 482915 logged.")).toBe("482915");
  });
});

describe("extractOtp — custom regex override", () => {
  it("uses caller-supplied pattern when provided", () => {
    // Custom regex matches a literal AB-prefixed 4-digit code.
    expect(
      extractOtp("Your access code AB-7301 is ready.", /AB-(\d{4})/),
    ).toBe("7301");
  });

  it("returns null when custom pattern doesn't match", () => {
    expect(extractOtp("Nothing here", /XYZ-\d+/)).toBeNull();
  });
});

describe("extractOtp — defensive cases", () => {
  it("returns null on an empty body", () => {
    expect(extractOtp("")).toBeNull();
  });

  it("returns null when body has only non-numeric content", () => {
    expect(extractOtp("Hello there, no codes here at all.")).toBeNull();
  });
});

describe("decodeMimeBody (rc.31)", () => {
  it("decodes quoted-printable =XX escapes", () => {
    // "Your verification code is: 482915" QP-encoded
    const qp = "Your verification code is=3A 482915";
    expect(decodeMimeBody(qp)).toContain("482915");
    // ":" was the encoded char
    expect(decodeMimeBody(qp)).toContain(":");
  });

  it("drops soft line breaks (= at end of line)", () => {
    const qp = "Your verification co=\r\nde is 482915";
    const out = decodeMimeBody(qp);
    expect(out).toContain("code is 482915");
  });

  it("strips HTML tags so digits between tags remain searchable", () => {
    const html = "<p>Your code is <strong>482915</strong>.</p>";
    expect(extractOtp(decodeMimeBody(html))).toBe("482915");
  });

  it("decodes a base64-encoded multipart body inline", () => {
    // Realistic multipart fixture: a single clean base64 run >=60
    // chars encoding readable text with an OTP keyword.
    const text =
      "Your verification code is 482915. It expires in 10 minutes. " +
      "Don't share this code with anyone.";
    const b64 = Buffer.from(text).toString("base64");
    // Verify the fixture is long enough to trip the >=60-char detector.
    expect(b64.length).toBeGreaterThanOrEqual(60);
    expect(extractOtp(decodeMimeBody(b64))).toBe("482915");
  });
});
