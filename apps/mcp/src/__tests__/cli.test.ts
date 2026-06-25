// Covers parseArgs (the --proxy-url / --provider / --skip-browser flags).
//
// The 0.5.1 install flow does not have a separate runLoginStage —
// the bot's Chrome IS where the user signs in to confirm the install,
// so the provider session lands in the profile as a side effect of
// the install confirm itself.

import { describe, expect, it, vi } from "vitest";
import { parseArgs } from "../install/cli.js";

describe("parseArgs --proxy-url", () => {
  it("parses --proxy-url into proxyUrl", () => {
    expect(
      parseArgs(["install", "--proxy-url=socks5://127.0.0.1:1080"]).proxyUrl,
    ).toBe("socks5://127.0.0.1:1080");
  });

  it("leaves proxyUrl undefined when the flag is absent", () => {
    expect(parseArgs(["install"]).proxyUrl).toBeUndefined();
  });

  it("treats an empty --proxy-url= as unset", () => {
    expect(parseArgs(["install", "--proxy-url="]).proxyUrl).toBeUndefined();
  });

  it("parses --proxy-url alongside --target", () => {
    const a = parseArgs([
      "install",
      "--target=claude-code",
      "--proxy-url=http://user:pass@host:8080",
    ]);
    expect(a.target).toBe("claude-code");
    expect(a.proxyUrl).toBe("http://user:pass@host:8080");
  });
});

describe("parseArgs --provider / --skip-browser", () => {
  it("parses google and github", () => {
    expect(parseArgs(["install", "--provider=google"]).providerArg).toBe("google");
    expect(parseArgs(["install", "--provider=github"]).providerArg).toBe("github");
  });

  it("ignores an unrecognized --provider value", () => {
    expect(parseArgs(["install", "--provider=apple"]).providerArg).toBeUndefined();
    // `both` was a 0.5.0 option; in 0.5.1 the user picks the provider
    // inside the trustysquire confirm page, so this is silently dropped.
    expect(parseArgs(["install", "--provider=both"]).providerArg).toBeUndefined();
  });

  it("defaults skipBrowser false and sets it with either spelling", () => {
    expect(parseArgs(["install"]).skipBrowser).toBe(false);
    expect(parseArgs(["install", "--skip-browser"]).skipBrowser).toBe(true);
    // --skip-login kept as a legacy alias for the 0.5.0 spelling.
    expect(parseArgs(["install", "--skip-login"]).skipBrowser).toBe(true);
  });

  it("parses --force-relogin for account switching", () => {
    expect(parseArgs(["install"]).forceRelogin).toBe(false);
    expect(parseArgs(["install", "--force-relogin"]).forceRelogin).toBe(true);
  });
});

describe("parseArgs registry", () => {
  it("does not accept a custom registry URL", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const args = parseArgs(["connect", "--registry-url=https://staging.registry.test"]);
      expect("registryUrl" in args).toBe(false);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("--registry-url is no longer supported"),
      );
    } finally {
      warn.mockRestore();
    }
  });
});
