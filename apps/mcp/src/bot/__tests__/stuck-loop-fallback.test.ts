// 0.8.2-rc.10 — covers the helpers introduced by the stuck-loop
// escalation work in postVerifyLoop.
//
// pickStuckLoopFallbackUrl: given the currently-stuck URL and a set
//   of URLs already tried, return the next plausible API-key path
//   on the same origin (or null when exhausted).
// detectExistingAccountNoExtract: given the final URL + page text +
//   the planner's last `done` reason, return true when the run
//   should be classified as existing_account_no_extract rather than
//   the generic oauth_onboarding_failed.

import { describe, expect, it } from "vitest";
import {
  detectExistingAccountNoExtract,
  pickStuckLoopFallbackUrl,
} from "../agent.js";

describe("pickStuckLoopFallbackUrl", () => {
  it("returns the most-specific path first on a stuck dashboard URL", () => {
    const fallback = pickStuckLoopFallbackUrl(
      "https://platform.claude.com/dashboard",
      new Set(),
    );
    expect(fallback).toBe("https://platform.claude.com/settings/keys");
  });

  it("skips a path that already matches the current pathname", () => {
    // The bot is stuck AT /settings/keys, so the next fallback must
    // not be the same URL — fall through to the next candidate.
    const fallback = pickStuckLoopFallbackUrl(
      "https://platform.claude.com/settings/keys",
      new Set(),
    );
    expect(fallback).toBe("https://platform.claude.com/settings/api-keys");
  });

  it("is trailing-slash tolerant when matching against the current path", () => {
    const fallback = pickStuckLoopFallbackUrl(
      "https://example.test/settings/keys/",
      new Set(),
    );
    expect(fallback).toBe("https://example.test/settings/api-keys");
  });

  it("skips paths already tried", () => {
    const fallback = pickStuckLoopFallbackUrl(
      "https://platform.claude.com/dashboard",
      new Set([
        "https://platform.claude.com/settings/keys",
        "https://platform.claude.com/settings/api-keys",
      ]),
    );
    expect(fallback).toBe("https://platform.claude.com/settings/api_keys");
  });

  it("returns null when every fallback path is exhausted", () => {
    const exhausted = new Set([
      "https://example.test/settings/keys",
      "https://example.test/settings/api-keys",
      "https://example.test/settings/api_keys",
      "https://example.test/settings/tokens",
      "https://example.test/settings/api-tokens",
      "https://example.test/settings/account/api/auth-tokens/",
      "https://example.test/account/api-keys",
      "https://example.test/account/api_tokens",
      "https://example.test/account/keys",
      "https://example.test/account/tokens",
      "https://example.test/api-keys",
      "https://example.test/api_keys",
      "https://example.test/keys",
      "https://example.test/tokens",
      "https://example.test/auth-tokens",
      "https://example.test/dashboard/api-keys",
      "https://example.test/dashboard/keys",
    ]);
    expect(
      pickStuckLoopFallbackUrl("https://example.test/dashboard", exhausted),
    ).toBeNull();
  });

  it("returns null when the URL isn't parseable", () => {
    expect(pickStuckLoopFallbackUrl("not-a-url", new Set())).toBeNull();
  });
});

describe("detectExistingAccountNoExtract", () => {
  it("matches when the URL names an API-keys page AND the page shows both a mask glyph and an existing-key word", () => {
    expect(
      detectExistingAccountNoExtract({
        url: "https://console.neon.tech/app/org-foo/settings#api-keys",
        pageText:
          "Existing API key\nname: ts-7229\nkey value: ts-•••••••••••\nActions",
        lastPlannerReason: "",
      }),
    ).toBe(true);
  });

  it("matches via the planner's reason describing a no-reveal masked credential", () => {
    expect(
      detectExistingAccountNoExtract({
        url: "https://example.test/settings/keys",
        pageText: "(empty)",
        lastPlannerReason:
          "The visible api key value is masked and cannot be revealed — the dashboard only shows it once at create-time.",
      }),
    ).toBe(true);
  });

  it("does not match when the URL is unrelated to API keys", () => {
    expect(
      detectExistingAccountNoExtract({
        url: "https://example.test/billing",
        pageText: "Existing card •••• ending in 4242",
        lastPlannerReason: "",
      }),
    ).toBe(false);
  });

  it("does not match when only the mask glyph is present (marketing decor)", () => {
    expect(
      detectExistingAccountNoExtract({
        url: "https://example.test/api-keys",
        pageText: "All set. ••• See docs at api.example.test",
        lastPlannerReason: "",
      }),
    ).toBe(false);
  });

  it("does not match when only an existing-key word is present (no mask)", () => {
    expect(
      detectExistingAccountNoExtract({
        url: "https://example.test/api-keys",
        pageText: "Reveal an api key to read the value.",
        lastPlannerReason: "",
      }),
    ).toBe(false);
  });
});
