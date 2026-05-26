// Covers extractApiKeyFromText — the pure credential-scraping logic
// behind SignupAgent.extractCredentials. The load-bearing concerns:
//   - rejecting captcha challenge tokens (g-recaptcha-response,
//     cf-turnstile-response) and session tokens that a naive labeled
//     regex would otherwise surface as credentials.api_key.
//   - F10: detecting truncated displays (modal shows the masked
//     prefix + "…" while the full secret lives only on the clipboard).
//     This is the dominant failure mode for OpenRouter / Anthropic /
//     OpenAI / Stripe key modals.

import { describe, expect, it } from "vitest";
import { extractApiKeyFromText, isTruncatedCapture } from "../agent.js";

describe("extractApiKeyFromText — prefixed keys", () => {
  it("extracts a Resend key", () => {
    const text = "Your API key: re_abcdefGHIJKLmnop1234567 — copy it now.";
    expect(extractApiKeyFromText(text)).toBe("re_abcdefGHIJKLmnop1234567");
  });

  it("extracts a Resend key whose body contains underscores", () => {
    // Real Resend keys carry an underscore mid-body — the prefix
    // charset must include it. Synthetic fixture (32 random chars
    // with one underscore mid-body) — no live keys in source.
    const key = "re_" + "FAKEonlyAA_AAaaBBbbCCccDDdd1234567890";
    expect(extractApiKeyFromText(`shown once: ${key}`)).toBe(key);
  });

  it("extracts a Stripe secret key", () => {
    // Built by concatenation on purpose: a contiguous sk_live_<value>
    // literal trips GitHub push protection's Stripe-key detector even
    // though this is a fabricated fixture. The runtime value still
    // exercises the sk_(live|test)_ prefix branch in extractApiKeyFromText.
    const stripeKey = "sk_" + "live_examplekeyEXAMPLE0000000000";
    const text = `secret ${stripeKey} done`;
    expect(extractApiKeyFromText(text)).toBe(stripeKey);
  });

  it("prefers a prefixed key over a labeled match", () => {
    const text = "api key: somethingelse re_abcdefGHIJKLmnop1234567";
    expect(extractApiKeyFromText(text)).toBe("re_abcdefGHIJKLmnop1234567");
  });

  it("ignores a Stripe publishable key — public, not a credential", () => {
    // pk_live_ ships in client-side JS on every Stripe-using site;
    // matching it surfaced Mistral's billing key as a false api_key.
    const pubKey = "pk_" + "live_examplePUBkey0000000000abcd";
    expect(extractApiKeyFromText(`checkout uses ${pubKey} here`)).toBeNull();
  });

  it("ignores a PostHog project key — public analytics key, not a credential", () => {
    // phc_ project keys ship in client-side analytics JS on every
    // PostHog-using site; matching one surfaced Mistral's embedded
    // analytics key as a false api_key.
    const phc = "phc_" + "exampleANALYTICSkey00000000000000abcd";
    expect(extractApiKeyFromText(`window.posthog.init('${phc}')`)).toBeNull();
  });

  it("extracts a Render key by its rnd_ prefix", () => {
    // The clean prefix match — needed for keys read out of a copy
    // <input>, where there is no "API Key:" label to anchor on.
    const key = "rnd_RenderKEYvalue000111222333";
    expect(extractApiKeyFromText(`new key ${key} created`)).toBe(key);
  });

  it("extracts a Sentry org auth token by its sntrys_ prefix", () => {
    // Sentry org tokens are sntrys_ + a long base64url payload, shown
    // once in a copy field — too long for the labeled-pattern ceiling,
    // but the prefix path has no length cap.
    const key = "sntrys_" + "eyJpYXQiOjE3Nzkw".repeat(6) + "abcd";
    expect(extractApiKeyFromText(key)).toBe(key);
  });

  it("extracts a Neon key by its napi_ prefix (rc.14)", () => {
    // Neon's modal renders a truncated napi_xxx… in visible text but
    // keeps the full value in the input field's value attribute. The
    // bot's input-value scan (pass 3) reads the full key — only the
    // prefix regex was missing.
    const key = "napi_" + "oks9t4wy562g2efcbqknzio7xl63ush65rdkzib2f52p4y";
    expect(extractApiKeyFromText(key)).toBe(key);
  });

  it("rejects a Neon-shaped value too short to be a real key", () => {
    // Defensive: `napi_short` shouldn't match — the {30,80} length
    // bound is what keeps a bare `napi_x` placeholder from being
    // surfaced as a credential.
    expect(extractApiKeyFromText("napi_short123")).toBeNull();
  });

  it("extracts a Replicate token by its r8_ prefix (rc.20)", () => {
    const key = "r8_" + "X9zKvFp2QmL4nBcRtY7uHsJa6gWdEi3oZ8";
    expect(extractApiKeyFromText(`Token: ${key}`)).toBe(key);
  });

  it("extracts a PlanetScale Service Token by pscale_tkn_ prefix (rc.23)", () => {
    const key = "pscale_tkn_" + "s0LTv2btBUksKAmuNnlKwxfnidEbHIUiYAlTOEEOZj8";
    expect(extractApiKeyFromText(`Token=${key}`)).toBe(key);
  });

  it("extracts a Supabase PAT by sbp_ prefix (rc.23)", () => {
    const key = "sbp_" + "61c3fa224cb4fbbdb61648c6f6ba1f00047babab";
    expect(extractApiKeyFromText(`copy ${key} from banner`)).toBe(key);
  });

  it("extracts a Baseten key by its dot-separated shape (rc.23)", () => {
    // 8 lowercase alnum + '.' + 32 mixed-case alnum
    const key = "y38s5kub.YFr4iVn4HVjUSW5cNlpGyL72PVwlDeso";
    expect(extractApiKeyFromText(`modal shows ${key}`)).toBe(key);
  });

  it("does not false-positive on version strings (rc.23 Baseten regex safety)", () => {
    // Short body on the right rules out version strings.
    expect(extractApiKeyFromText("v1.0.0")).toBeNull();
    expect(extractApiKeyFromText("2026.05.26")).toBeNull();
  });

  it("extracts a Qdrant Cloud token by its UUID|opaque shape (rc.23)", () => {
    const key =
      "8dd5f3b3-c05b-4ff0-927d-4cc94448c35b|" +
      "7aRYo27E9AijT5f99SMl3H7LoDbqjETxQKODSwnAqpHM4bgCKNJPLw";
    expect(extractApiKeyFromText(`API key visible: ${key}`)).toBe(key);
  });

  it("extracts a JWT (eyJ.eyJ.sig) — Convex token shape (rc.23)", () => {
    // 3-segment base64url JWT
    const jwt =
      "eyJ" + "A".repeat(32) +
      ".eyJ" + "B".repeat(40) +
      "." + "C".repeat(43);
    expect(extractApiKeyFromText(`token=${jwt}`)).toBe(jwt);
  });

  it("extracts a Zeabur sk- key (32 lowercase) — shorter than OpenAI legacy (rc.24)", () => {
    const key = "sk-4hgbjcurt2lwtjbc7picghp3qhgag";
    expect(extractApiKeyFromText(`API key '${key}' is visible`)).toBe(key);
  });

  it("Zeabur sk- regex does not steal mixed-case OpenAI legacy matches", () => {
    // An OpenAI-legacy mixed-case key (>=40 chars) should still match
    // the OpenAI legacy regex, NOT the Zeabur lowercase-only one.
    const openaiLegacy = "sk-" + "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEf";
    expect(extractApiKeyFromText(openaiLegacy)).toBe(openaiLegacy);
  });

  it("rejects the truncated Neon display from visible page text", () => {
    // The exact failure mode that broke harvester pass 3: visible
    // text shows `napi_<48 chars>…` with an ellipsis. isTruncatedCapture
    // catches it; the bot then has to find the full value via the
    // input-value scan. Verify here that the truncated marker is
    // detected.
    const truncated =
      "Your new key: napi_oks9t4wy562g2efcbqknzio7xl63ush65rdkzib2f5… (click to copy)";
    const hit = extractApiKeyFromText(truncated);
    expect(hit).not.toBeNull();
    if (hit !== null) {
      expect(isTruncatedCapture(truncated, hit)).toBe(true);
    }
  });
});

describe("extractApiKeyFromText — labeled keys", () => {
  it("extracts a value adjacent to its label", () => {
    const text = "API Key: ak_live_REALapikeyVALUE0099";
    expect(extractApiKeyFromText(text)).toBe("ak_live_REALapikeyVALUE0099");
  });

  it("extracts a value after an equals sign", () => {
    const text = "access_token=tokenVALUE_abcdefgh12345";
    expect(extractApiKeyFromText(text)).toBe("tokenVALUE_abcdefgh12345");
  });

  it("extracts a bearer token", () => {
    const text = "Authorization: Bearer bearerTOKENvalue1234567890abcdef";
    expect(extractApiKeyFromText(text)).toBe(
      "bearerTOKENvalue1234567890abcdef",
    );
  });

  it("returns null when there is no key at all", () => {
    expect(extractApiKeyFromText("Welcome! Please confirm your email.")).toBeNull();
  });
});

describe("extractApiKeyFromText — captcha-token rejection", () => {
  it("rejects a cf-turnstile-response value carrying the widget marker", () => {
    // A real Turnstile token is long and the field name leaks into
    // visible text on some misrendered pages.
    const text =
      "secret_key: cf-turnstile-response.0.abcDEFghiJKLmnopqrstuvwxyz0123456789";
    expect(extractApiKeyFromText(text)).toBeNull();
  });

  it("rejects a g-recaptcha-response value carrying the widget marker", () => {
    const text =
      "api_key: g-recaptcha-response_03AGdBq24abcdefghijklmnopqrstuvwx";
    expect(extractApiKeyFromText(text)).toBeNull();
  });

  it("rejects a Cloudflare clearance cookie value", () => {
    const text = "access token: __cf_bm.aaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    expect(extractApiKeyFromText(text)).toBeNull();
  });

  it("rejects an over-long token that looks like a captcha payload", () => {
    // reCAPTCHA tokens run hundreds-to-thousands of chars; no real API
    // key the labeled patterns target is this long.
    const longToken = "x".repeat(400);
    const text = `access_token: ${longToken}`;
    expect(extractApiKeyFromText(text)).toBeNull();
  });

  it("still extracts a real key on a page that also has a captcha token", () => {
    const longCaptcha = "z".repeat(500);
    const text = `g-recaptcha-response value ${longCaptcha}\nYour API key: re_abcdefGHIJKLmnop1234567`;
    expect(extractApiKeyFromText(text)).toBe("re_abcdefGHIJKLmnop1234567");
  });

  it("rejects a label glued to nav text with no separator (Resend false-positive)", () => {
    // Resend's post-OAuth dashboard sidebar — "API Keys" "Webhooks"
    // "Settings" "<account>" as adjacent links — concatenates with no
    // separator. The labeled pattern must NOT capture the glued run.
    const text = "API KeysWebhooksSettingslunchboxfortwoProjects";
    expect(extractApiKeyFromText(text)).toBeNull();
  });

  it("rejects a labeled value that straddled glued dashboard text onto a key", () => {
    // Render's API-keys list renders as concatenated text with no
    // separators ("...Name bot-key Menu Key rnd_SsApfF") — the labeled
    // regex would otherwise capture the whole glob as a credential.
    const text = "API Keys Name1bot-keyMenuKeyrnd_SsApfFxxxxxx";
    expect(extractApiKeyFromText(text)).toBeNull();
  });

  it("does not match a label far from its value across a newline", () => {
    // The labeled pattern requires the value adjacent to the label
    // (spaces/tabs only). A value on a separate line belongs to some
    // other page section and must not be picked up.
    const text = "API key:\n\nsomeUnrelatedToken1234567890";
    expect(extractApiKeyFromText(text)).toBeNull();
  });
});

describe("extractApiKeyFromText — OpenRouter / Anthropic / OpenAI prefixes (F10)", () => {
  it("extracts a full OpenRouter sk-or-v1-… key", () => {
    // Synthetic, not a live key — F10's whole point is that the
    // sk-or-v1- prefix is recognized so the Copy+clipboard recovery
    // path's clipboard contents can be parsed.
    const key = "sk-or-v1-" + "0".repeat(63);
    expect(extractApiKeyFromText(`Your key: ${key}`)).toBe(key);
  });

  it("extracts an Anthropic sk-ant-… key", () => {
    const key = "sk-ant-" + "abcdef0123456789".repeat(4);
    expect(extractApiKeyFromText(key)).toBe(key);
  });

  it("extracts an OpenAI sk-proj-… project key", () => {
    const key = "sk-proj-" + "abcdef0123456789".repeat(3) + "abcdef";
    expect(extractApiKeyFromText(key)).toBe(key);
  });

  it("extracts an OpenAI legacy sk-<48> key", () => {
    const key = "sk-" + "a".repeat(48);
    expect(extractApiKeyFromText(key)).toBe(key);
  });
});

describe("isTruncatedCapture — F10 truncation detection", () => {
  it("flags a key directly followed by '...'", () => {
    const text = "Your key: sk-or-v1-1687b94c0e589f34ea46ae2c3f4e124a8...";
    // Simulate what the labeled regex would have captured here.
    const captured = "sk-or-v1-1687b94c0e589f34ea46ae2c3f4e124a8";
    expect(isTruncatedCapture(text, captured)).toBe(true);
  });

  it("flags a key followed by the Unicode ellipsis", () => {
    const text = "sk-or-v1-1687b94c0e589f34ea46ae2c3f4e124a8…";
    expect(isTruncatedCapture(text, "sk-or-v1-1687b94c0e589f34ea46ae2c3f4e124a8")).toBe(
      true,
    );
  });

  it("flags a key with whitespace before the ellipsis", () => {
    // Some modals render "sk-…  …" with a gap. The detector tolerates
    // leading whitespace between the captured value and the marker.
    const text = "sk-or-v1-abc123 ...";
    expect(isTruncatedCapture(text, "sk-or-v1-abc123")).toBe(true);
  });

  it("does NOT flag a key followed by two dots (ordinary punctuation)", () => {
    // "sk-or-v1-abc123.. and ..." — two trailing dots can appear in
    // prose. Three or more dots is the marker.
    const text = "Your key sk-or-v1-abc123.. configured.";
    expect(isTruncatedCapture(text, "sk-or-v1-abc123")).toBe(false);
  });

  it("does NOT flag a key at end-of-string with no marker", () => {
    const text = "sk-or-v1-abc123";
    expect(isTruncatedCapture(text, "sk-or-v1-abc123")).toBe(false);
  });

  it("returns false when the captured key isn't in the source text", () => {
    expect(isTruncatedCapture("unrelated text", "sk-or-v1-abc")).toBe(false);
  });
});

// UUID-style API tokens (Railway uses bare UUIDs; some smaller services
// do too). MUST be labeled — bare UUIDs are everywhere on dashboards as
// trace IDs, project IDs, and request IDs, so an unlabeled UUID regex
// would false-positive on the first error page the bot lands on.
//
// Regression fixture: Railway's signup ran 12 post-verify rounds with
// the message "The full API token is visible on the page:
// db3a32ea-dd1b-4e28-9680-db2991c81e3e" — the planner could see the
// token but the extractor's regex library had no UUID pattern, so each
// extract returned null and the loop never broke.
describe("extractApiKeyFromText — UUID-style tokens (Railway)", () => {
  // Synthetic fixture UUID — random hex, not a real Railway token.
  const UUID = "12345678-1111-2222-3333-444455556666";

  it("extracts a UUID labeled with 'API token:'", () => {
    const text = `Your new API token: ${UUID} — copy it now.`;
    expect(extractApiKeyFromText(text)).toBe(UUID);
  });

  it("extracts a UUID labeled with 'API key:'", () => {
    const text = `API key: ${UUID}`;
    expect(extractApiKeyFromText(text)).toBe(UUID);
  });

  it("extracts a UUID labeled with bare 'Token' (Railway dashboard pattern)", () => {
    // Railway specifically renders "Token" (not "API key") next to the
    // value in the "New Token" section.
    const text = `New Token\nmy-api-token\nToken ${UUID}`;
    expect(extractApiKeyFromText(text)).toBe(UUID);
  });

  it("extracts a UUID with '=' separator", () => {
    const text = `secret=${UUID}`;
    expect(extractApiKeyFromText(text)).toBe(UUID);
  });

  it("does NOT extract a bare UUID with no credential label", () => {
    // Trace IDs and request IDs would false-positive otherwise.
    const text = `Request failed. Trace ID: ${UUID}`;
    expect(extractApiKeyFromText(text)).toBeNull();
  });

  it("does NOT extract a UUID labeled as a project/trace ID", () => {
    const text = `Project ID: ${UUID}`;
    expect(extractApiKeyFromText(text)).toBeNull();
  });

  it("extracts the UUID even when surrounded by dashboard chrome", () => {
    // Realistic-ish layout — Railway's modal renders the token below a
    // 'New Token' header with the name field above it.
    const text = [
      "Account / Tokens",
      "Create New Token",
      "Name: my-api-token",
      "New Token",
      `Token ${UUID}`,
      "Copy",
      "Make sure to copy your token now. You won't see it again.",
    ].join("\n");
    expect(extractApiKeyFromText(text)).toBe(UUID);
  });

  it("is case-insensitive on the label", () => {
    expect(extractApiKeyFromText(`api token: ${UUID}`)).toBe(UUID);
    expect(extractApiKeyFromText(`API TOKEN: ${UUID}`)).toBe(UUID);
    expect(extractApiKeyFromText(`Api_Token = ${UUID}`)).toBe(UUID);
  });
});
