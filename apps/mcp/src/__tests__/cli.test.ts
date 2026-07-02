// Covers parseArgs (the --proxy-url / --provider / --skip-browser flags).
//
// The 0.5.1 install flow does not have a separate runLoginStage —
// the bot's Chrome IS where the user signs in to confirm the install,
// so the provider session lands in the profile as a side effect of
// the install confirm itself.

import { describe, expect, it, vi } from "vitest";
import { parseArgs, applyInstallPreferences } from "../install/cli.js";
import { normalizeProxyUrl } from "../install/proxy-url.js";
import type { SessionData } from "../session.js";

describe("applyInstallPreferences (fresh interactive consent must win)", () => {
  const base: SessionData = {
    api_base_url: "https://x",
    saved_at: "t",
    consent_operator_inbox_otp: true, // the user just answered YES in the CLI
    consent_skillify_telemetry: true,
  };
  const stalePrefs = { registry_enabled: false, consent_operator_inbox_otp: false };

  it("interactive (applyServerPrefs=false): keeps the local consent, ignores stale server prefs", () => {
    const out = applyInstallPreferences(base, stalePrefs, false);
    expect(out.consent_operator_inbox_otp).toBe(true);
    expect(out.consent_skillify_telemetry).toBe(true);
  });
  it("non-interactive (applyServerPrefs=true): inherits the server prefs", () => {
    const out = applyInstallPreferences(base, stalePrefs, true);
    expect(out.consent_operator_inbox_otp).toBe(false);
    expect(out.consent_skillify_telemetry).toBe(false);
  });
  it("undefined server prefs → baseSession unchanged either way", () => {
    expect(applyInstallPreferences(base, undefined, true).consent_operator_inbox_otp).toBe(true);
  });
});

describe("parseArgs --proxy-url", () => {
  it("parses --proxy-url into proxyUrl", () => {
    expect(
      parseArgs(["connect", "--proxy-url=socks5://127.0.0.1:1080"]).proxyUrl,
    ).toBe("socks5://127.0.0.1:1080");
  });

  it("leaves proxyUrl undefined when the flag is absent", () => {
    expect(parseArgs(["connect"]).proxyUrl).toBeUndefined();
  });

  it("treats an empty --proxy-url= as unset", () => {
    expect(parseArgs(["connect", "--proxy-url="]).proxyUrl).toBeUndefined();
  });

  it("parses --proxy-url alongside --target", () => {
    const a = parseArgs([
      "connect",
      "--target=claude-code",
      "--proxy-url=http://user:pass@host:8080",
    ]);
    expect(a.target).toBe("claude-code");
    expect(a.proxyUrl).toBe("http://user:pass@host:8080");
  });

  it("rejects whitespace/control characters in proxy URLs", () => {
    expect(normalizeProxyUrl("http://host:8080\nBAD=1")).toBeUndefined();
  });

  it("keeps valid socks5 proxy URLs", () => {
    expect(normalizeProxyUrl(" socks5://127.0.0.1:1080 ")).toBe(
      "socks5://127.0.0.1:1080",
    );
  });
});

describe("parseArgs --provider / --skip-browser", () => {
  it("parses google and github", () => {
    expect(parseArgs(["connect", "--provider=google"]).providerArg).toBe("google");
    expect(parseArgs(["connect", "--provider=github"]).providerArg).toBe("github");
  });

  it("ignores an unrecognized --provider value", () => {
    expect(parseArgs(["connect", "--provider=apple"]).providerArg).toBeUndefined();
    // `both` was a 0.5.0 option; in 0.5.1 the user picks the provider
    // inside the trustysquire confirm page, so this is silently dropped.
    expect(parseArgs(["connect", "--provider=both"]).providerArg).toBeUndefined();
  });

  it("defaults skipBrowser false and sets it with --skip-browser", () => {
    expect(parseArgs(["connect"]).skipBrowser).toBe(false);
    expect(parseArgs(["connect", "--skip-browser"]).skipBrowser).toBe(true);
  });

  it("parses --force-relogin for account switching", () => {
    expect(parseArgs(["connect"]).forceRelogin).toBe(false);
    expect(parseArgs(["connect", "--force-relogin"]).forceRelogin).toBe(true);
  });
});

describe("parseArgs registry", () => {
  it("defaults registry participation on", () => {
    expect(parseArgs(["connect"]).noRegistry).toBe(false);
  });

  it("keeps the legacy --no-registry flag as an explicit off switch", () => {
    const args = parseArgs(["connect", "--no-registry"]);
    expect(args.noRegistry).toBe(true);
    expect(args.registryConfigured).toBe(true);
  });

  it("rejects deprecated registry flags", () => {
    expectDeprecatedExit(() => parseArgs(["connect", "--registry"]));
    expectDeprecatedExit(() =>
      parseArgs(["connect", "--registry-url=https://staging.registry.test"]),
    );
  });
});

describe("parseArgs deprecated flags", () => {
  it("rejects the removed install alias", () => {
    expectDeprecatedExit(() => parseArgs(["install"]));
  });

  it("rejects removed compatibility flags", () => {
    expectDeprecatedExit(() => parseArgs(["connect", "--skip-login"]));
    expectDeprecatedExit(() => parseArgs(["connect", "--skip-secondary"]));
  });
});

describe("parseArgs --force-relogin", () => {
  it("supports the full-profile form", () => {
    const args = parseArgs(["connect", "--force-relogin"]);
    expect(args.forceRelogin).toBe(true);
    expect(args.forceReloginProvider).toBeUndefined();
  });

  it("supports provider-scoped relogin", () => {
    const args = parseArgs(["connect", "--force-relogin=github"]);
    expect(args.forceRelogin).toBe(true);
    expect(args.forceReloginProvider).toBe("github");
  });
});

function expectDeprecatedExit(fn: () => unknown): void {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const exit = vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
    throw new Error(`exit:${code}`);
  });
  try {
    expect(fn).toThrow("exit:64");
    expect(error).toHaveBeenCalledWith(expect.stringContaining("[trusty-squire]"));
  } finally {
    exit.mockRestore();
    error.mockRestore();
  }
}
