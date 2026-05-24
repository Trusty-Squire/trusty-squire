// Covers extractQuotedTokenFromReason — the rc.28 fallback for
// credentials whose shape isn't in the bot's regex library but the
// Claude vision planner quotes verbatim in its `extract` step reason.
//
// Motivated by the rc.27 IPInfo signup: planner correctly stated
// "The API token 'fd3afcbe09648c' is fully visible on the dashboard
// under 'API Access' section", but extractApiKeyFromText returned
// null because the 14-char hex value fits no labeled or service-
// prefixed pattern. This fallback closes the gap with a
// verbatim-in-DOM guardrail against planner hallucination.

import { describe, expect, it } from "vitest";
import { extractQuotedTokenFromReason } from "../agent.js";

describe("extractQuotedTokenFromReason — positive", () => {
  it("extracts the ipinfo 14-char hex token from the planner reason", () => {
    const reason =
      "The API token 'fd3afcbe09648c' is fully visible on the dashboard " +
      "under 'API Access' section.";
    const pageText =
      "API Access\nREST API integration\nAPI Token\nfd3afcbe09648c\n" +
      "cURL Example";
    expect(extractQuotedTokenFromReason(reason, pageText)).toBe(
      "fd3afcbe09648c",
    );
  });

  it("supports double-quoted tokens", () => {
    expect(
      extractQuotedTokenFromReason(
        'Token "sk-or-v1-abc123def456ghi789" is shown.',
        "Your key: sk-or-v1-abc123def456ghi789",
      ),
    ).toBe("sk-or-v1-abc123def456ghi789");
  });

  it("supports backtick-quoted tokens", () => {
    expect(
      extractQuotedTokenFromReason(
        "API key: `phx_live_abcdef1234567890`",
        "Active keys:\nphx_live_abcdef1234567890",
      ),
    ).toBe("phx_live_abcdef1234567890");
  });
});

describe("extractQuotedTokenFromReason — guardrails", () => {
  it("rejects a quoted value not present in the page text (hallucination)", () => {
    const reason = "The API token 'fakehallucinated123' is visible.";
    const pageText = "Welcome to the dashboard.";
    expect(extractQuotedTokenFromReason(reason, pageText)).toBeNull();
  });

  it("ignores quoted UI labels that include spaces", () => {
    const reason =
      "The 'API Access' section is empty, but 'Your token' isn't shown yet.";
    const pageText = "Page: 'API Access' (empty)";
    // Both candidates contain a space → don't match the character
    // class, so nothing is extracted even though the strings appear
    // in pageText.
    expect(extractQuotedTokenFromReason(reason, pageText)).toBeNull();
  });

  it("skips quoted strings shorter than 10 chars", () => {
    expect(
      extractQuotedTokenFromReason(
        "Copy button labeled 'Copy'.",
        "Copy button labeled 'Copy'.",
      ),
    ).toBeNull();
  });

  it("picks the first quoted-and-verified candidate when several appear", () => {
    const reason =
      "The token 'first1234567890' is here; ignore 'second9876543210'.";
    const pageText = "Tokens: first1234567890 and second9876543210";
    expect(extractQuotedTokenFromReason(reason, pageText)).toBe(
      "first1234567890",
    );
  });

  it("returns null on an empty reason", () => {
    expect(extractQuotedTokenFromReason("", "anything")).toBeNull();
  });
});
