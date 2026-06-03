// classifyInterstitialText — distinguish a still-blocking Cloudflare/
// Turnstile interstitial from one whose challenge already PASSED. The
// trap (codesandbox/lambda-labs): Cloudflare leaves the static "Just a
// moment / Performing security verification" copy on the page even after
// appending "Verification successful", so matching only the static copy
// reads a passed challenge as "still blocked" and the bot bails.

import { describe, expect, it } from "vitest";
import { classifyInterstitialText, stripCloudflareChallengeParams } from "../browser.js";

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

describe("stripCloudflareChallengeParams", () => {
  it("strips the one-shot challenge token (the codesandbox URL)", () => {
    // The exact shape from the real codesandbox trail.
    const got = stripCloudflareChallengeParams(
      "https://codesandbox.io/signin?__cf_chl_rt_tk=79TC6R6m1W0qegjdyYbRrgH9FdxOlCg_kVqi73rdGsU-1780517514-1.0.1.1-EoEO4gdDEFbm",
    );
    expect(got).toBe("https://codesandbox.io/signin");
  });

  it("strips every __cf_chl_* variant but preserves unrelated query params", () => {
    const got = stripCloudflareChallengeParams(
      "https://x.example/signup?plan=pro&__cf_chl_tk=aaa&ref=hn&__cf_chl_f_tk=bbb",
    );
    expect(got).toBe("https://x.example/signup?plan=pro&ref=hn");
  });

  it("returns null when there is no challenge token to strip (plain reload suffices)", () => {
    expect(stripCloudflareChallengeParams("https://x.example/signin?foo=1")).toBeNull();
    expect(stripCloudflareChallengeParams("https://x.example/signin")).toBeNull();
  });

  it("never throws on a malformed URL", () => {
    expect(stripCloudflareChallengeParams("not a url")).toBeNull();
  });
});
