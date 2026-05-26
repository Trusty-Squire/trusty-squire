// Credential redactor — strips known-shape API tokens from step trails
// before they hit GitHub issues / failure-reports / Telegram. The
// 2026-05-26 incident leaked a Supabase PAT, a PlanetScale Service
// Token, and a Neon API key into public GitHub issue comments via
// the bot's planner reason field. These tests pin the strip patterns
// so any regression of the regex set immediately fails CI.

import { describe, it, expect } from "vitest";
import { redactCredentials, redactSteps } from "../redact.mjs";

describe("redactCredentials", () => {
  it("strips a Supabase PAT (sbp_) — the 2026-05-26 incident shape", () => {
    const leak = "The full API token 'sbp_61c3fa224cb4fbbdb61648c6f6ba1f00047babab' is visible";
    const out = redactCredentials(leak);
    expect(out).not.toContain("sbp_61c3fa224cb4fbbdb61648c6f6ba1f00047babab");
    expect(out).toContain("sbp_REDACTED");
  });

  it("strips a PlanetScale service token (pscale_tkn_) — same incident shape", () => {
    const leak = "Token: pscale_tkn_s0LTv2btBUksKAmuNnlKwxfnidEbHIUiYAlTOEEOZj8";
    const out = redactCredentials(leak);
    expect(out).not.toContain("pscale_tkn_s0LTv2btBUksKAmuNnlKwxfnidEbHIUiYAlTOEEOZj8");
  });

  it("strips a Neon napi_ token — same incident, undetected by GitHub", () => {
    const leak = "napi_oks9t4wy562g2efcbqknzio7xl63ush65rdkzib2f52p4y";
    const out = redactCredentials(leak);
    expect(out).not.toContain("oks9t4wy562g2efcbqknzio7xl63ush65rdkzib2f52p4y");
    expect(out).toContain("napi_REDACTED");
  });

  it("strips a Replicate r8_ token", () => {
    // 40-char alnum body
    const leak = "r8_X9zKvFp2QmL4nBcRtY7uHsJa6gWdEi3oZ8";
    const out = redactCredentials(leak);
    expect(out).not.toContain("X9zKvFp2QmL4nBcRtY7uHsJa6gWdEi3oZ8");
  });

  it("strips multiple distinct shapes in the same string", () => {
    const leak = "found re_FAKEonlyAA_AAaaBBbbCCccDDdd1234567890 and sk-ant-FAKEsk_ant_value_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa here";
    const out = redactCredentials(leak);
    expect(out).not.toContain("re_FAKEonly");
    expect(out).not.toContain("sk-ant-FAKEsk_ant");
  });

  it("preserves the prefix + last 6 chars in the redaction marker (for distinguishing leaks)", () => {
    const out = redactCredentials("sbp_61c3fa224cb4fbbdb61648c6f6ba1f00047babab");
    expect(out).toMatch(/sbp_REDACTED…/);
    expect(out).toContain("7babab"); // last 6 chars of the original
  });

  it("returns input unchanged when no credentials are present", () => {
    const text = "Post-verify 1/12: navigate — Go directly to the API tokens page";
    expect(redactCredentials(text)).toBe(text);
  });

  it("handles non-string input safely", () => {
    expect(redactCredentials(null)).toBe(null);
    expect(redactCredentials(undefined)).toBe(undefined);
    expect(redactCredentials(42)).toBe(42);
  });

  it("strips Trusty Squire's own machine token if it leaks", () => {
    const leak = "Bearer tsm_A9cRiZhNff41IEryXECEH2DQNdkM88gUb2tPZMMGn94";
    const out = redactCredentials(leak);
    expect(out).not.toContain("A9cRiZhNff41IEryXECEH2DQNdkM88gUb2tPZMMGn94");
    expect(out).toContain("tsm_REDACTED");
  });

  it("strips a Svix/Resend webhook signing secret (whsec_)", () => {
    const leak = "secret=whsec_Rwk+JOfN0aARUCZcRF/RoB/FfACnYWc7";
    const out = redactCredentials(leak);
    expect(out).not.toContain("whsec_Rwk+JOfN0aARUCZcRF/RoB/FfACnYWc7");
  });
});

describe("redactSteps", () => {
  it("redacts each line of a step trail independently", () => {
    const steps = [
      "Post-verify 1/12: navigate — Go to /api-keys",
      "Post-verify 6/12: extract — The full API token 'sbp_61c3fa224cb4fbbdb61648c6f6ba1f00047babab' is visible",
      "Post-verify: credentials found on round 6.",
    ];
    const out = redactSteps(steps);
    expect(out).toHaveLength(3);
    expect(out[0]).toBe(steps[0]);
    expect(out[1]).not.toContain("sbp_61c3fa224cb4fbbdb61648c6f6ba1f00047babab");
    expect(out[2]).toBe(steps[2]);
  });

  it("returns a new array (does not mutate input)", () => {
    const steps = ["sbp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"];
    const out = redactSteps(steps);
    expect(out).not.toBe(steps);
    expect(steps[0]).toBe("sbp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });

  it("returns input unchanged for non-array", () => {
    expect(redactSteps(null)).toBe(null);
    expect(redactSteps("hi")).toBe("hi");
  });
});
