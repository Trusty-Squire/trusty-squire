// Covers parseArgs (the --proxy-url / --provider / --skip-login flags)
// and runLoginStage — the non-fatal OAuth login stage folded into
// `install`.

import { describe, expect, it, vi } from "vitest";
import { parseArgs, runLoginStage } from "../install/cli.js";
import type { LoginResult } from "../bot/google-login.js";

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

describe("parseArgs --provider / --skip-login", () => {
  it("parses each valid --provider value", () => {
    expect(parseArgs(["install", "--provider=google"]).providerArg).toBe("google");
    expect(parseArgs(["install", "--provider=github"]).providerArg).toBe("github");
    expect(parseArgs(["install", "--provider=both"]).providerArg).toBe("both");
  });

  it("ignores an unrecognized --provider value", () => {
    expect(parseArgs(["install", "--provider=apple"]).providerArg).toBeUndefined();
  });

  it("defaults skipLogin false and sets it with --skip-login", () => {
    expect(parseArgs(["install"]).skipLogin).toBe(false);
    expect(parseArgs(["install", "--skip-login"]).skipLogin).toBe(true);
  });
});

describe("runLoginStage — non-fatal contract", () => {
  it("skips the login entirely under --skip-login", async () => {
    const login = vi.fn<(opts: { provider: string }) => Promise<LoginResult>>();
    await runLoginStage(parseArgs(["install", "--skip-login"]), login);
    expect(login).not.toHaveBeenCalled();
  });

  it("does not throw when the login errors", async () => {
    const login = vi.fn(async () => ({ status: "error", detail: "no display" }) as LoginResult);
    await expect(
      runLoginStage(parseArgs(["install", "--provider=google"]), login),
    ).resolves.toBeUndefined();
    expect(login).toHaveBeenCalledTimes(1);
  });

  it("does not throw when the login itself rejects", async () => {
    const login = vi.fn(async () => {
      throw new Error("xvfb missing");
    });
    await expect(
      runLoginStage(parseArgs(["install", "--provider=google"]), login),
    ).resolves.toBeUndefined();
  });

  it("does not throw on a login timeout", async () => {
    const login = vi.fn(async () => ({ status: "timeout" }) as LoginResult);
    await expect(
      runLoginStage(parseArgs(["install", "--provider=google"]), login),
    ).resolves.toBeUndefined();
  });

  it("connects both providers in order under --provider=both", async () => {
    const seen: string[] = [];
    const login = vi.fn(async (o: { provider: string }) => {
      seen.push(o.provider);
      return { status: "logged_in" } as LoginResult;
    });
    await runLoginStage(parseArgs(["install", "--provider=both"]), login);
    expect(seen).toEqual(["google", "github"]);
  });

  it("defaults to Google with no --provider and no TTY", async () => {
    // vitest runs with no TTY on stdin → resolveLoginProviders must
    // default to Google rather than block on a prompt.
    const login = vi.fn<(opts: { provider: string }) => Promise<LoginResult>>(
      async () => ({ status: "already_valid" }) as LoginResult,
    );
    await runLoginStage(parseArgs(["install"]), login);
    expect(login).toHaveBeenCalledTimes(1);
    expect(login.mock.calls[0]?.[0]?.provider).toBe("google");
  });
});
