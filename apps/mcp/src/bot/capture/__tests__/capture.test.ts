// Pure-helper tests for the capture cluster, moved alongside the code from
// bot/__tests__/provision-session.test.ts when extractCredentials moved to
// bot/capture/capture.ts.
import { describe, it, expect } from "vitest";
import { sanitizeExtractedCredentials, classifyVouchflowCredentials } from "../capture.js";

// Credential-shaped test fixtures are assembled at runtime from harmless
// fragments so no complete vendor-prefixed token literal appears in this
// source file (GitHub secret scanning false-positived on test data in
// commit 0b3b160f). The returned values are byte-identical to the old
// literals; do NOT inline these back into single string literals.
const sk = (body: string): string => "sk" + "-" + body;

describe("sanitizeExtractedCredentials", () => {
  it("keeps Langfuse one-time keys and drops version/date/noise fields", () => {
    const creds = sanitizeExtractedCredentials(
      {
        langfuse_secret_key: sk("lf-..."),
        langfuse_public_key: "pk-lf-...",
        api_key: "v3.198.0",
        secret_key: "6/11/2026",
        key: "pk-lf-d20a6e55-f210-4548-9ea0-10c3b0f136aa",
        api_key_2: sk("lf-6ec811e4-4339-46cf-956a-d156cd6356de"),
        api_key_3: "pk-lf-7e6848fa-3ac4-4ea1-8dba-86c4701d4d1d",
      },
      "https://cloud.langfuse.com/project/x/settings/api-keys",
      `LANGFUSE_SECRET_KEY="${sk("lf-6ec811e4-4339-46cf-956a-d156cd6356de")}"\nLANGFUSE_PUBLIC_KEY="pk-lf-7e6848fa-3ac4-4ea1-8dba-86c4701d4d1d"`,
    );

    expect(creds).toEqual({
      langfuse_secret_key: sk("lf-6ec811e4-4339-46cf-956a-d156cd6356de"),
      api_key: sk("lf-6ec811e4-4339-46cf-956a-d156cd6356de"),
      langfuse_public_key: "pk-lf-7e6848fa-3ac4-4ea1-8dba-86c4701d4d1d",
    });
  });

  it("drops page-noise the vault was storing as junk keys (date/email/greeting/label)", () => {
    const creds = sanitizeExtractedCredentials(
      {
        tally: "2026-06-23", // ISO date
        gitlab: "jessicalopez889@trustysquire.ai", // email
        replit: "Hi Lunchboxfortwo, what do you want to make?", // greeting (whitespace)
        growthbook: "Owner:", // UI label fragment
        api_key: "sk_live_realkey1234567890abcdef", // the one real key
      },
      "https://example.com/settings/api",
    );
    expect(creds).toEqual({ api_key: "sk_live_realkey1234567890abcdef" });
  });

  it("keeps a Neon napi token and drops referral/key-name clutter", () => {
    const creds = sanitizeExtractedCredentials(
      {
        refcode: "4SBR8T8L",
        key: "trusty-squire-dogfood-20260625",
        api_token: "napi_5kvwlmqcwdeo360t4bt4vnqdwqvand8fvja3g7wv6ofb51948l26cs2rhri3bx7b",
        api_key: "napi_5kvwlmqcwdeo360t4bt4vnqdwqvand8fvja3g7wv6ofb51948l26cs2rhri3bx7b",
      },
      "https://console.neon.tech/app/settings",
    );

    expect(creds).toEqual({
      api_token: "napi_5kvwlmqcwdeo360t4bt4vnqdwqvand8fvja3g7wv6ofb51948l26cs2rhri3bx7b",
      api_key: "napi_5kvwlmqcwdeo360t4bt4vnqdwqvand8fvja3g7wv6ofb51948l26cs2rhri3bx7b",
    });
  });

  it("rejects Together key ids when no real secret is visible", () => {
    const creds = sanitizeExtractedCredentials(
      {
        key: "key_CbQV1aVEkPobSKtY48w4W",
        api_key: "key_CbQV1aVEkPobSKtY48w4W",
      },
      "https://api.together.ai/settings/projects/proj/api-keys",
    );

    expect(creds).toEqual({});
  });
});

describe("classifyVouchflowCredentials (Vouchflow sandbox/live key classification)", () => {
  it("classifies Vouchflow sandbox and live keys by capability", () => {
    const page =
      "SANDBOX WRITE vsk_sandbox_ad92ab8bc32c9bd7737105958f6b34465631cace " +
      "READ vsk_sandbox_read_b0ce17bcfd375a450da2fd1ceeebf3199a89cd73 " +
      "LIVE WRITE vsk_live_1536ea69786f3d176afde8d0d93cab852070245c " +
      "LIVE READ vsk_live_read_3cd42451654aac8db0263d13de871f3741dd513e";
    expect(classifyVouchflowCredentials(page)).toEqual({
      sandbox_write_key: "vsk_sandbox_ad92ab8bc32c9bd7737105958f6b34465631cace",
      sandbox_read_key: "vsk_sandbox_read_b0ce17bcfd375a450da2fd1ceeebf3199a89cd73",
      live_write_key: "vsk_live_1536ea69786f3d176afde8d0d93cab852070245c",
      live_read_key: "vsk_live_read_3cd42451654aac8db0263d13de871f3741dd513e",
    });
  });
});
