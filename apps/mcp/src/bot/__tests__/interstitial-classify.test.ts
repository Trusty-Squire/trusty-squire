// classifyInterstitialText — distinguish a still-blocking Cloudflare/
// Turnstile interstitial from one whose challenge already PASSED. The
// trap (codesandbox/lambda-labs): Cloudflare leaves the static "Just a
// moment / Performing security verification" copy on the page even after
// appending "Verification successful", so matching only the static copy
// reads a passed challenge as "still blocked" and the bot bails.

import { describe, expect, it } from "vitest";
import { classifyInterstitialText } from "../browser.js";

describe("classifyInterstitialText", () => {
  it("passed-but-static-copy-present (the codesandbox case): onInterstitial AND verificationPassed", () => {
    // Exact shape from the real codesandbox trail.
    const text =
      "Just a moment... codesandbox.io Performing security verification " +
      "This website uses a security service to protect against malicious bots. " +
      "Verification successful. Waiting for the page to load.";
    const c = classifyInterstitialText(text);
    expect(c.onInterstitial).toBe(true);
    expect(c.verificationPassed).toBe(true);
  });

  it("still-challenging interstitial: onInterstitial, NOT passed", () => {
    const c = classifyInterstitialText("Just a moment... Checking your browser before accessing");
    expect(c.onInterstitial).toBe(true);
    expect(c.verificationPassed).toBe(false);
  });

  it("a real signup page: neither", () => {
    const c = classifyInterstitialText("Create your account — Acme Dashboard. Sign up with Google");
    expect(c.onInterstitial).toBe(false);
    expect(c.verificationPassed).toBe(false);
  });

  it("'verifying you are human' / 'attention required' variants count as interstitial", () => {
    expect(classifyInterstitialText("Verifying you are human").onInterstitial).toBe(true);
    expect(classifyInterstitialText("Attention Required! | Cloudflare").onInterstitial).toBe(true);
  });

  it("'you are verified' counts as passed", () => {
    expect(classifyInterstitialText("Success! You are now verified").verificationPassed).toBe(true);
  });
});
