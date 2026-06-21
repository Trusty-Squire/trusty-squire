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
  serviceSlug,
} from "../agent.js";

// Drains pickStuckLoopFallbackUrl by repeatedly asking for the next
// candidate and recording it as tried, until it returns null. Returns
// the ordered list of distinct candidates offered. Bounded so a bug
// that never returns null fails the test instead of hanging.
function drainFallbacks(startUrl: string, service?: string): readonly string[] {
  const tried = new Set<string>();
  const offered: string[] = [];
  for (let i = 0; i < 200; i++) {
    const next = pickStuckLoopFallbackUrl(startUrl, tried, service);
    if (next === null) return offered;
    offered.push(next);
    tried.add(next);
  }
  throw new Error("pickStuckLoopFallbackUrl never exhausted");
}

describe("pickStuckLoopFallbackUrl", () => {
  it("returns the most-specific path first on a stuck dashboard URL", () => {
    const fallback = pickStuckLoopFallbackUrl(
      "https://platform.claude.com/dashboard",
      new Set(),
    );
    expect(fallback).toBe("https://platform.claude.com/settings/keys");
  });

  it("returns null on an opaque-origin URL (about:blank → no 'null/settings/keys')", () => {
    // about:blank / data: serialize origin to the string "null"; composing
    // "${origin}${path}" would yield an unnavigable "null/settings/keys".
    expect(pickStuckLoopFallbackUrl("about:blank", new Set())).toBeNull();
    expect(pickStuckLoopFallbackUrl("", new Set())).toBeNull();
    expect(pickStuckLoopFallbackUrl("data:text/html,x", new Set())).toBeNull();
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

  it("returns null once every fallback path has been offered and tried", () => {
    // Drive the helper to exhaustion by recording each candidate it
    // offers — the list grew (rc.2), so enumerate dynamically instead
    // of hard-coding it. After the drain, one more ask must be null.
    const offered = drainFallbacks("https://example.test/dashboard");
    expect(offered.length).toBeGreaterThan(0);
    const tried = new Set(offered);
    expect(
      pickStuckLoopFallbackUrl("https://example.test/dashboard", tried),
    ).toBeNull();
  });

  it("never offers the same candidate URL twice across a full drain", () => {
    const offered = drainFallbacks("https://example.test/dashboard");
    expect(new Set(offered).size).toBe(offered.length);
  });

  it("offers /settings/authorization (LaunchDarkly's keys path) in the generic list", () => {
    // Even without the service hint, the widened generic list must
    // include LD's authorization page so the planner-agnostic drain
    // eventually reaches it.
    const offered = drainFallbacks("https://app.example.test/dashboard");
    expect(offered).toContain("https://app.example.test/settings/authorization");
  });

  it("returns null when the URL isn't parseable", () => {
    expect(pickStuckLoopFallbackUrl("not-a-url", new Set())).toBeNull();
  });

  it("tries the curated per-service path FIRST when the host matches the service", () => {
    // groq keys live at console.groq.com/keys; the planner kept guessing
    // /settings/api-keys (404). With the service hint, /keys leads.
    const fallback = pickStuckLoopFallbackUrl(
      "https://console.groq.com/authenticate",
      new Set(),
      "groq",
    );
    expect(fallback).toBe("https://console.groq.com/keys");
  });

  it("keeps a live console origin instead of composing fallbacks onto a marketing signup host", () => {
    const fallback = pickStuckLoopFallbackUrl(
      "https://console.cloudinary.com/app/welcome/",
      new Set(),
      "cloudinary",
      "https://cloudinary.com/users/register_free",
    );
    expect(fallback).toBe("https://console.cloudinary.com/pm/developer-dashboard");
  });

  it("still composes fallbacks onto the app origin from an auth subdomain", () => {
    const fallback = pickStuckLoopFallbackUrl(
      "https://authkit.anyscale.com/oauth/callback",
      new Set(),
      "anyscale",
      "https://console.anyscale.com",
    );
    expect(fallback).toBe("https://console.anyscale.com/api-keys");
  });

  it("resolves the curated path from a multi-word / cased service name via the slug", () => {
    const fallback = pickStuckLoopFallbackUrl(
      "https://app.launchdarkly.com/dashboard",
      new Set(),
      "LaunchDarkly",
    );
    expect(fallback).toBe("https://app.launchdarkly.com/settings/authorization");
  });

  it("tries Sentry's auth-token path before generic 404-prone settings paths", () => {
    const fallback = pickStuckLoopFallbackUrl(
      "https://trustysquire-m3.sentry.io/onboarding/setup-docs/",
      new Set(),
      "sentry",
    );
    expect(fallback).toBe("https://trustysquire-m3.sentry.io/settings/account/api/auth-tokens/");
  });

  it("tries Axiom's documented API-token settings path before generic keys paths", () => {
    const fallback = pickStuckLoopFallbackUrl(
      "https://app.axiom.co/dashboard",
      new Set(),
      "axiom",
    );
    expect(fallback).toBe("https://app.axiom.co/settings/api-tokens");
  });

  it("tries Anyscale's account API-keys page before generic settings paths", () => {
    const fallback = pickStuckLoopFallbackUrl(
      "https://console.anyscale.com/",
      new Set(),
      "anyscale",
    );
    expect(fallback).toBe("https://console.anyscale.com/api-keys");
  });

  it("does NOT compose a curated path onto an unrelated host (host gate)", () => {
    // The bot wandered onto an OAuth provider; the groq curated paths
    // must not be glued onto accounts.google.com. Falls back to the
    // generic list's first entry instead.
    const fallback = pickStuckLoopFallbackUrl(
      "https://accounts.google.com/oauth/authorize",
      new Set(),
      "groq",
    );
    expect(fallback).toBe("https://accounts.google.com/settings/keys");
  });

  it("does not offer a curated path twice when it also exists in the generic list", () => {
    // groq's curated list is ["/keys", "/settings/keys"]; both also live
    // in the generic list. A full drain must contain each exactly once.
    const offered = drainFallbacks("https://console.groq.com/dashboard", "groq");
    const keys = offered.filter((u) => u === "https://console.groq.com/keys");
    const settingsKeys = offered.filter(
      (u) => u === "https://console.groq.com/settings/keys",
    );
    expect(keys.length).toBe(1);
    expect(settingsKeys.length).toBe(1);
    // And the curated paths lead.
    expect(offered[0]).toBe("https://console.groq.com/keys");
    expect(offered[1]).toBe("https://console.groq.com/settings/keys");
  });

  it("falls back to the generic list for a service with no curated entry", () => {
    const fallback = pickStuckLoopFallbackUrl(
      "https://app.somevendor.test/dashboard",
      new Set(),
      "somevendor",
    );
    expect(fallback).toBe("https://app.somevendor.test/settings/keys");
  });

  it("composes onto the APP origin, not the auth/IdP origin the run is stuck on", () => {
    // luma's real bug: post-OAuth the stuck URL is the auth subdomain
    // (auth.lumalabs.ai), which has no settings pages — every guess there
    // 404s. The app URL the bot navigated to is on lumalabs.ai, so the
    // fallback must be composed against THAT origin.
    const fallback = pickStuckLoopFallbackUrl(
      "https://auth.lumalabs.ai/sign-up",
      new Set(),
      "luma-ai",
      "https://lumalabs.ai/dream-machine",
    );
    expect(fallback).toBe("https://lumalabs.ai/settings/keys");
  });

  it("uses the app origin's host for the curated-path gate", () => {
    // Stuck on accounts.google.com (OAuth), but the app is console.groq.com.
    // The curated groq path must compose onto the app host, not the IdP.
    const fallback = pickStuckLoopFallbackUrl(
      "https://accounts.google.com/oauth/authorize",
      new Set(),
      "groq",
      "https://console.groq.com/login",
    );
    expect(fallback).toBe("https://console.groq.com/keys");
  });

  it("ignores a Google-search app URL and keeps the stuck origin", () => {
    // resolvedSignupUrl can be a google-search URL when no real signup
    // page resolved; that's not an app origin, so don't compose onto it.
    const fallback = pickStuckLoopFallbackUrl(
      "https://platform.claude.com/dashboard",
      new Set(),
      undefined,
      "https://www.google.com/search?q=claude+signup",
    );
    expect(fallback).toBe("https://platform.claude.com/settings/keys");
  });

  it("falls back to the stuck origin when no app URL is given (back-compat)", () => {
    const fallback = pickStuckLoopFallbackUrl(
      "https://platform.claude.com/dashboard",
      new Set(),
    );
    expect(fallback).toBe("https://platform.claude.com/settings/keys");
  });
});

describe("serviceSlug", () => {
  it("lowercases and strips non-alphanumerics", () => {
    expect(serviceSlug("LaunchDarkly")).toBe("launchdarkly");
    expect(serviceSlug("Groq Cloud")).toBe("groqcloud");
    expect(serviceSlug("xata.io")).toBe("xataio");
    expect(serviceSlug("north-flank")).toBe("northflank");
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

  it("matches Neon's existing-key listing shape (key name + created + last used, no mask glyph)", () => {
    // The actual page text Neon's bot capture produced for the stuck
    // mppra92f run — no `•••` because Neon never shows the value at
    // all, but multiple listing-row signals are present on a URL that
    // names the API-keys page. The rc.12 detector picks this up via
    // the 2+-existing-key-word path.
    expect(
      detectExistingAccountNoExtract({
        url: "https://console.neon.tech/app/org-foo/settings#api-keys",
        pageText:
          "Create new API key. Org-wide Key name ts-7229 Created May 28, 2026 Last used never",
        lastPlannerReason: "",
      }),
    ).toBe(true);
  });

  it("matches when a mask glyph appears next to an 'API keys' header on a keys URL", () => {
    expect(
      detectExistingAccountNoExtract({
        url: "https://example.test/api-keys",
        pageText: "API keys\nname1 •••••••••• actions",
        lastPlannerReason: "",
      }),
    ).toBe(true);
  });
});
