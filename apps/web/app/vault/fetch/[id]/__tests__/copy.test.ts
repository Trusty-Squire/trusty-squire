import { describe, expect, it } from "vitest";
import {
  consequenceLine,
  fieldLabel,
  formatExpiryRemaining,
  humanizeFieldKey,
  requestedByLine,
  revealQuestion,
} from "../copy";

describe("humanizeFieldKey", () => {
  it("title-cases a single word", () => {
    expect(humanizeFieldKey("password")).toBe("Password");
  });

  it("keeps known acronyms and lowercases the rest after the first word", () => {
    expect(humanizeFieldKey("account_sid")).toBe("Account SID");
    expect(humanizeFieldKey("api_key")).toBe("API key");
  });

  it("splits on hyphens as well as underscores", () => {
    expect(humanizeFieldKey("secret-access-key")).toBe("Secret access key");
  });
});

describe("fieldLabel", () => {
  it("prefers the named field over the field list", () => {
    expect(fieldLabel("account_sid", ["account_sid", "auth_token"])).toBe("Account SID");
  });

  it("humanizes a single unnamed field", () => {
    expect(fieldLabel(null, ["api_key"])).toBe("API key");
  });
});

describe("revealQuestion", () => {
  it("asks about the service and humanized field", () => {
    expect(revealQuestion("Twilio", "account_sid", ["account_sid"])).toBe(
      "Reveal Twilio Account SID to your agent?",
    );
  });

  it("omits a missing service rather than substituting a placeholder", () => {
    expect(revealQuestion(null, "password", ["password"])).toBe("Reveal Password to your agent?");
  });
});

describe("requestedByLine", () => {
  it("joins both values with a middle dot", () => {
    expect(requestedByLine("Grok", "write it into GitHub Actions")).toBe(
      "Requested by Grok · write it into GitHub Actions",
    );
  });

  it("shows only the agent when there is no reason", () => {
    expect(requestedByLine("Grok", null)).toBe("Requested by Grok");
  });

  it("shows only the reason when there is no agent, with no placeholder", () => {
    expect(requestedByLine(null, "write it into a .env file")).toBe("write it into a .env file");
  });

  it("returns null when neither value is present", () => {
    expect(requestedByLine(null, null)).toBeNull();
    expect(requestedByLine("  ", "")).toBeNull();
  });
});

describe("formatExpiryRemaining", () => {
  const now = Date.parse("2026-09-05T12:00:00.000Z");

  it("names whole minutes left", () => {
    expect(formatExpiryRemaining("2026-09-05T12:10:00.000Z", now)).toBe("10 minutes");
    expect(formatExpiryRemaining("2026-09-05T12:01:00.000Z", now)).toBe("1 minute");
  });

  it("names seconds when less than a minute remains", () => {
    expect(formatExpiryRemaining("2026-09-05T12:00:45.000Z", now)).toBe("45 seconds");
    expect(formatExpiryRemaining("2026-09-05T12:00:01.000Z", now)).toBe("1 second");
  });

  it("does not go negative after expiry", () => {
    expect(formatExpiryRemaining("2026-09-05T11:59:00.000Z", now)).toBe("0 seconds");
  });
});

describe("consequenceLine", () => {
  it("states the once-in-clear cost and the remaining time once", () => {
    expect(
      consequenceLine("2026-09-05T12:10:00.000Z", Date.parse("2026-09-05T12:00:00.000Z")),
    ).toBe(
      "Your agent sees this value once, in clear, and it stays in that conversation. Expires in 10 minutes.",
    );
  });
});
