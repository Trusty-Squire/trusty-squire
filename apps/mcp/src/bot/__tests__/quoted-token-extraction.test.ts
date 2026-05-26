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

describe("extractQuotedTokenFromReason — bare-UUID fallback (rc.36)", () => {
  it("extracts an unquoted UUID near 'API key' keyword (Upstash shape)", () => {
    const reason =
      "The full API key b7dd0ff0-2497-4dc8-a793-8261a38e0339 is visible in the modal dialog";
    const page =
      "Created token b7dd0ff0-2497-4dc8-a793-8261a38e0339 — copy it now.";
    expect(extractQuotedTokenFromReason(reason, page)).toBe(
      "b7dd0ff0-2497-4dc8-a793-8261a38e0339",
    );
  });

  it("requires a credential keyword near the UUID (no false-positive on project IDs)", () => {
    // Same UUID shape but the reason is talking about a project, not
    // a credential. Should NOT match.
    const reason =
      "Created project b7dd0ff0-2497-4dc8-a793-8261a38e0339 in workspace.";
    const page = "Project b7dd0ff0-2497-4dc8-a793-8261a38e0339 settings";
    expect(extractQuotedTokenFromReason(reason, page)).toBeNull();
  });

  it("requires the UUID to ALSO appear in page text (no hallucinated UUIDs)", () => {
    const reason =
      "The API key b7dd0ff0-2497-4dc8-a793-8261a38e0339 is visible.";
    // Page text has a DIFFERENT UUID.
    const page = "Created cccccccc-cccc-cccc-cccc-cccccccccccc on the dashboard.";
    expect(extractQuotedTokenFromReason(reason, page)).toBeNull();
  });

  it("falls back to bare-UUID only when quoted-token path didn't fire", () => {
    // Both a quoted credential AND a UUID present — the quoted path
    // wins because it's tried first.
    const reason =
      "The API key 'sk-myquotedkey-aaaaaaaaaaaa' is shown, also UUID b7dd0ff0-2497-4dc8-a793-8261a38e0339";
    const page =
      "Tokens: sk-myquotedkey-aaaaaaaaaaaa and b7dd0ff0-2497-4dc8-a793-8261a38e0339";
    expect(extractQuotedTokenFromReason(reason, page)).toBe(
      "sk-myquotedkey-aaaaaaaaaaaa",
    );
  });
});
