import { describe, expect, it } from "vitest";
import {
  buildConsentRefusal,
  extractInboxCodes,
  gmailTransientBackoffMs,
  inboxSearchQuery,
  isEmptyGmailResultText,
  isGmailTransientErrorText,
} from "../verification.js";

describe("inbox listing helpers", () => {
  it("does not search by the session host or recipient by default", () => {
    expect(inboxSearchQuery({})).toBeUndefined();
  });

  it("passes an explicit Gmail query through and converts legacy aliases", () => {
    expect(inboxSearchQuery({ query: "subject:code newer_than:1d" })).toBe(
      "subject:code newer_than:1d",
    );
    expect(inboxSearchQuery({ sender: "dev.tiktok.com", recipient: "ada@example.com" })).toBe(
      "from:dev.tiktok.com to:ada@example.com",
    );
  });

  it("returns every distinct code candidate in message order", () => {
    expect(
      extractInboxCodes("Order 12345. Your code is 614208. Repeat 614208; backup 916004."),
    ).toEqual(["614208", "12345", "916004"]);
  });

  it("keeps the consent refusal as a resumable wall", () => {
    expect(buildConsentRefusal("session")).toMatchObject({
      session_id: "session",
      found: false,
      messages: [],
      needs_user: { wall: "verification_code", resume: "code" },
    });
  });

  it("recognizes Gmail transient search failures with bounded backoff", () => {
    expect(isGmailTransientErrorText("encountered a problem (#2014) - Retrying in 5s")).toBe(true);
    expect(isEmptyGmailResultText("No messages matched your search")).toBe(true);
    expect(gmailTransientBackoffMs(5)).toBe(4000);
  });
});
