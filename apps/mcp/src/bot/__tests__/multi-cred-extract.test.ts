// Phase E — extractAllLabeledTokensFromReason tests.
//
// Cover the multi-credential parser the post-verify extract step
// now consults FIRST when the planner labels multiple credentials in
// its reason. Each test pairs a realistic planner-prose reason with
// the page text that should validate the values (anti-hallucination
// guardrail).

import { describe, expect, it } from "vitest";
import { extractAllLabeledTokensFromReason } from "../agent.js";

describe("extractAllLabeledTokensFromReason — single-cred passthrough", () => {
  it("returns empty for single-cred prose without labels (legacy path)", () => {
    const reason = "The token '4e768abbf134297cb8f2d505830935' is fully visible.";
    const page = "4e768abbf134297cb8f2d505830935";
    expect(extractAllLabeledTokensFromReason(reason, page)).toEqual({});
  });

  it("returns one entry when only api_key is labeled (still useful for single-cred)", () => {
    const reason = "The api_key='491741466469613' is visible in the table.";
    const page = "491741466469613";
    const out = extractAllLabeledTokensFromReason(reason, page);
    expect(out).toEqual({ api_key: "491741466469613" });
  });
});

describe("extractAllLabeledTokensFromReason — Cloudinary (3 creds)", () => {
  it("extracts cloud_name + api_key from the planner's prose", () => {
    const reason =
      "The API key '491741466469613' for cloud 'dlq4xgrca' is fully visible " +
      "in the table. Page shows cloud_name='dlq4xgrca' and api_key='491741466469613'.";
    const page = "dlq4xgrca 491741466469613";
    const out = extractAllLabeledTokensFromReason(reason, page);
    expect(out).toEqual({
      cloud_name: "dlq4xgrca",
      api_key: "491741466469613",
    });
  });

  it("captures api_secret when the planner mentions all three", () => {
    const reason =
      "All three Cloudinary credentials visible: cloud_name='dlq4xgrca', " +
      "api_key='491741466469613', api_secret='abc-def-ghi-jkl-mno-pqrstuvw'";
    const page = "dlq4xgrca 491741466469613 abc-def-ghi-jkl-mno-pqrstuvw";
    const out = extractAllLabeledTokensFromReason(reason, page);
    expect(out).toEqual({
      cloud_name: "dlq4xgrca",
      api_key: "491741466469613",
      api_secret: "abc-def-ghi-jkl-mno-pqrstuvw",
    });
  });
});

describe("extractAllLabeledTokensFromReason — Algolia (3 creds)", () => {
  it("extracts application_id + admin_api_key + search_api_key", () => {
    const reason =
      "Algolia API Keys page shows: application_id='LATENCY', " +
      "admin_api_key='bf4e07ce6a3e44d57f9eaad32b8d3df3', " +
      "search_api_key='6be0576ff61c053d5f9a3225e2a90f76'.";
    const page =
      "LATENCY bf4e07ce6a3e44d57f9eaad32b8d3df3 6be0576ff61c053d5f9a3225e2a90f76";
    const out = extractAllLabeledTokensFromReason(reason, page);
    expect(out).toEqual({
      application_id: "LATENCY",
      admin_api_key: "bf4e07ce6a3e44d57f9eaad32b8d3df3",
      search_api_key: "6be0576ff61c053d5f9a3225e2a90f76",
    });
  });

  it("normalizes app_id alias to application_id", () => {
    const reason = "app_id='LATENCY' and admin_api_key='abcdef0123456789'";
    const page = "LATENCY abcdef0123456789";
    const out = extractAllLabeledTokensFromReason(reason, page);
    expect(out).toEqual({
      application_id: "LATENCY",
      admin_api_key: "abcdef0123456789",
    });
  });
});

describe("extractAllLabeledTokensFromReason — Twilio + Stripe shapes", () => {
  it("extracts account_sid + auth_token (Twilio)", () => {
    const reason =
      "Console shows account_sid='ZZa1b2c3d4e5f60123456789abcdef0123' " +
      "and auth_token='a1b2c3d4e5f60123456789abcdef0123'";
    const page = "ZZa1b2c3d4e5f60123456789abcdef0123 a1b2c3d4e5f60123456789abcdef0123";
    const out = extractAllLabeledTokensFromReason(reason, page);
    expect(out).toEqual({
      account_sid: "ZZa1b2c3d4e5f60123456789abcdef0123",
      auth_token: "a1b2c3d4e5f60123456789abcdef0123",
    });
  });

  it("extracts publishable_key + secret_key (Stripe-shape)", () => {
    // The labeled (prose) path doesn't care about value shape, so use
    // neutral placeholders rather than real Stripe test prefixes — the
    // GitHub secret scanner flags pk_test_/sk_test_ tokens even in tests.
    const reason =
      "API keys page shows publishable_key='pubkey_abcdefghijklmnopqrstuvwx' " +
      "and secret_key='seckey_zyxwvutsrqponmlkjihgfedcba'";
    const page =
      "pubkey_abcdefghijklmnopqrstuvwx seckey_zyxwvutsrqponmlkjihgfedcba";
    const out = extractAllLabeledTokensFromReason(reason, page);
    expect(out).toEqual({
      publishable_key: "pubkey_abcdefghijklmnopqrstuvwx",
      secret_key: "seckey_zyxwvutsrqponmlkjihgfedcba",
    });
  });
});

describe("extractAllLabeledTokensFromReason — prose-word rejection (Cloudinary regression)", () => {
  it("does NOT capture 'hidden' as the value of api_secret in 'api_secret is hidden behind asterisks'", async () => {
    // Real Cloudinary planner reason from the live trace. Without the
    // PROSE_BLACKLIST guard, the regex matched `api_secret is hidden`
    // and the anti-hallucination check passed (the word "hidden" is
    // in the same reason as pageText). Result: bogus secret in the
    // credentials dict.
    const reason =
      "The Cloudinary API Keys page shows cloud_name='dlq4xgrca' and " +
      "api_key='491741466469613' in the table; api_secret is hidden " +
      "behind asterisks.";
    const page = "dlq4xgrca 491741466469613 hidden behind asterisks";
    const out = extractAllLabeledTokensFromReason(reason, page);
    expect(out["api_secret"]).toBeUndefined();
    expect(out).toEqual({
      cloud_name: "dlq4xgrca",
      api_key: "491741466469613",
    });
  });

  it("rejects 'masked', 'shown', 'visible' and similar status words", async () => {
    for (const word of ["masked", "shown", "visible", "redacted", "missing"]) {
      const reason = `api_secret is ${word} on the page`;
      const page = `${word} on the page`;
      const out = extractAllLabeledTokensFromReason(reason, page);
      expect(out["api_secret"], `failed on word: ${word}`).toBeUndefined();
    }
  });

  it("rejects pure-word values even with credential labels (api_key is foo)", async () => {
    const reason = "api_key is empty and api_secret is null";
    const page = "empty null";
    const out = extractAllLabeledTokensFromReason(reason, page);
    expect(out).toEqual({});
  });

  it("ACCEPTS credential-shape values in 'is' prose (mixed alpha+digit ≥16ch)", async () => {
    const reason = "The api_key is 491741466469613 in the table";
    const page = "491741466469613";
    const out = extractAllLabeledTokensFromReason(reason, page);
    expect(out).toEqual({ api_key: "491741466469613" });
  });
});

describe("extractAllLabeledTokensFromReason — anti-hallucination guardrails", () => {
  it("drops labeled values that don't appear in the page text", () => {
    const reason =
      "api_key='hallucinated-value-12345' and cloud_name='dlq4xgrca'";
    const page = "dlq4xgrca";
    const out = extractAllLabeledTokensFromReason(reason, page);
    expect(out).toEqual({ cloud_name: "dlq4xgrca" });
  });

  it("ignores label tokens not in the whitelist (dashboard_url etc.)", () => {
    const reason =
      "The dashboard_url='https://example.com/foo' and api_key='abc123def456ghi'";
    const page = "https://example.com/foo abc123def456ghi";
    const out = extractAllLabeledTokensFromReason(reason, page);
    expect(out).toEqual({ api_key: "abc123def456ghi" });
  });

  it("returns empty when no labeled credentials are present at all", () => {
    const reason = "The page shows a table with various API keys.";
    const page = "anything";
    expect(extractAllLabeledTokensFromReason(reason, page)).toEqual({});
  });

  it("first-wins when the planner restates the same label multiple times", () => {
    // Mirrors the Cloudinary trace where rounds 4/5/10 all named the
    // same api_key. First occurrence wins.
    const reason =
      "Round 1: api_key='aaaaaaaaaa-firsthit'. Later: api_key='bbbbbbbbbb-rephrase'.";
    const page = "aaaaaaaaaa-firsthit bbbbbbbbbb-rephrase";
    const out = extractAllLabeledTokensFromReason(reason, page);
    expect(out["api_key"]).toBe("aaaaaaaaaa-firsthit");
  });
});

describe("extractAllLabeledTokensFromReason — label syntax tolerance", () => {
  it("accepts label: value (colon)", () => {
    const reason = "api_key: '4917abcdefghijkl' and cloud_name: 'dlq4xgrca'";
    const page = "4917abcdefghijkl dlq4xgrca";
    const out = extractAllLabeledTokensFromReason(reason, page);
    expect(out).toEqual({
      api_key: "4917abcdefghijkl",
      cloud_name: "dlq4xgrca",
    });
  });

  it("accepts label is value (English prose)", () => {
    const reason = "The api_key is '4917abcdefghijkl' and cloud_name is 'dlq4xgrca'";
    const page = "4917abcdefghijkl dlq4xgrca";
    const out = extractAllLabeledTokensFromReason(reason, page);
    expect(out).toEqual({
      api_key: "4917abcdefghijkl",
      cloud_name: "dlq4xgrca",
    });
  });

  it("accepts double-quoted values", () => {
    const reason = `api_key="4917abcdefghijkl"`;
    const page = "4917abcdefghijkl";
    const out = extractAllLabeledTokensFromReason(reason, page);
    expect(out).toEqual({ api_key: "4917abcdefghijkl" });
  });

  it("accepts unquoted values when the syntax is unambiguous", () => {
    const reason = "api_key=4917abcdefghijkl cloud_name=dlq4xgrca";
    const page = "4917abcdefghijkl dlq4xgrca";
    const out = extractAllLabeledTokensFromReason(reason, page);
    expect(out).toEqual({
      api_key: "4917abcdefghijkl",
      cloud_name: "dlq4xgrca",
    });
  });
});
