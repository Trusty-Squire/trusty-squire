// Bot-side credential redactor — pinned in lockstep with the
// harvester's redact.mjs. The 2026-05-26 incident leaked Supabase,
// PlanetScale, and Neon tokens into public GitHub issues via the
// planner's reason field; these tests prevent regression of any
// known-shape token slipping through.

import { describe, it, expect } from "vitest";
import { redactCredentials, redactHtml } from "../redact.js";

describe("redactCredentials", () => {
  it("strips Supabase PAT (sbp_) — the 2026-05-26 incident shape", () => {
    const out = redactCredentials(
      "Token: sbp_61c3fa224cb4fbbdb61648c6f6ba1f00047babab visible",
    );
    expect(out).not.toContain("sbp_61c3fa224cb4fbbdb61648c6f6ba1f00047babab");
    expect(out).toContain("sbp_REDACTED");
    expect(out).toContain("7babab"); // last 6 chars preserved for distinguishing leaks
  });

  it("strips PlanetScale service token (pscale_tkn_)", () => {
    const out = redactCredentials(
      "pscale_tkn_s0LTv2btBUksKAmuNnlKwxfnidEbHIUiYAlTOEEOZj8",
    );
    expect(out).not.toContain("s0LTv2btBUksKAmuNnlKwxfnidEbHIUiYAlTOEEOZj8");
  });

  it("strips Neon napi_ token", () => {
    const out = redactCredentials(
      "napi_oks9t4wy562g2efcbqknzio7xl63ush65rdkzib2f52p4y",
    );
    expect(out).not.toContain("oks9t4wy562g2efcbqknzio7xl63ush65rdkzib2f52p4y");
  });

  it("strips Replicate r8_ token", () => {
    const out = redactCredentials("r8_X9zKvFp2QmL4nBcRtY7uHsJa6gWdEi3oZ8");
    expect(out).not.toContain("X9zKvFp2QmL4nBcRtY7uHsJa6gWdEi3oZ8");
  });

  it("strips OpenRouter sk-or-v1- token", () => {
    const out = redactCredentials(
      "sk-or-v1-abc123def456abc123def456abc123def456abc123def456abc123def456",
    );
    expect(out).not.toContain(
      "abc123def456abc123def456abc123def456abc123def456abc123def456",
    );
  });

  it("strips multiple distinct tokens in the same string", () => {
    const out = redactCredentials(
      "saw napi_okabc123def456ghijkl789mnopqr012stuvwx345y and r8_X9zKvFp2QmL4nBcRtY7uHsJa6gWdEi3oZ8",
    );
    expect(out).not.toContain("okabc123def456");
    expect(out).not.toContain("X9zKvFp2QmL4");
  });

  it("preserves non-credential text unchanged", () => {
    const text = "Post-verify 1/12: navigate — Go to the API tokens page";
    expect(redactCredentials(text)).toBe(text);
  });

  it("strips Trusty Squire's machine token if it leaks", () => {
    const out = redactCredentials("Bearer tsm_A9cRiZhNff41IEryXECEH2DQNdkM88gUb2tPZMMGn94");
    expect(out).not.toContain("A9cRiZhNff41IEryXECEH2DQNdkM88gUb2tPZMMGn94");
  });
});

// Memory-overhaul Phase 2 — DOM-secret scrub for the evidence-upload path.
describe("redactHtml", () => {
  it("redacts a Cloudflare Turnstile response token in a hidden input", () => {
    const html =
      '<input type="hidden" name="cf-turnstile-response" value="0.AbCdEf-this_is_a_long_turnstile_token_1234567890">';
    const out = redactHtml(html);
    expect(out).not.toContain("0.AbCdEf-this_is_a_long_turnstile_token_1234567890");
    expect(out).toContain("REDACTED");
  });

  it("redacts a reCAPTCHA/hCaptcha token assigned in inline JS", () => {
    const html = `<script>window.token = "g-recaptcha-response":"03AGdBq26abcdefghijklmnopqrstuvwxyz1234567890"</script>`;
    const out = redactHtml(html);
    expect(out).not.toContain("03AGdBq26abcdefghijklmnopqrstuvwxyz1234567890");
  });

  it("redacts an Authorization header leaked into the DOM", () => {
    const html = `<div data-config='{"authorization":"Bearer abcdef0123456789abcdef0123456789"}'></div>`;
    const out = redactHtml(html);
    expect(out).not.toContain("abcdef0123456789abcdef0123456789");
  });

  it("redacts a populated password input value", () => {
    const html = '<input type="password" name="pw" value="Sup3rSecretP@ssw0rd!">';
    const out = redactHtml(html);
    expect(out).not.toContain("Sup3rSecretP@ssw0rd!");
    expect(out).toContain("REDACTED");
  });

  it("still applies the key-shape redactor to the DOM (a minted key on the page)", () => {
    const html = '<code class="api-key">sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH</code>';
    const out = redactHtml(html);
    expect(out).not.toContain("sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH");
  });

  it("leaves benign markup untouched", () => {
    const html = '<div class="card"><h1>Welcome</h1><p>Sign up to get started.</p></div>';
    expect(redactHtml(html)).toBe(html);
  });
});
