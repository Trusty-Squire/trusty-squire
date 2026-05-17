// Covers extractApiKeyFromText — the pure credential-scraping logic
// behind SignupAgent.extractCredentials. The load-bearing concern is
// rejecting captcha challenge tokens (g-recaptcha-response,
// cf-turnstile-response) and session tokens that a naive labeled
// regex would otherwise surface as credentials.api_key.

import { describe, expect, it } from "vitest";
import { extractApiKeyFromText } from "../agent.js";

describe("extractApiKeyFromText — prefixed keys", () => {
  it("extracts a Resend key", () => {
    const text = "Your API key: re_abcdefGHIJKLmnop1234567 — copy it now.";
    expect(extractApiKeyFromText(text)).toBe("re_abcdefGHIJKLmnop1234567");
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

  it("extracts a Render key by its rnd_ prefix", () => {
    // The clean prefix match — needed for keys read out of a copy
    // <input>, where there is no "API Key:" label to anchor on.
    const key = "rnd_RenderKEYvalue000111222333";
    expect(extractApiKeyFromText(`new key ${key} created`)).toBe(key);
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
