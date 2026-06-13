import { afterEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { resolveChannelBinary, selfLaunchEnabled } from "../browser.js";

// The self-launch path (spawn Chrome ourselves + connectOverCDP) is the
// Turnstile-safe launch. These cover the two pure decision helpers that gate
// it; the launch itself is exercised live (see STATE.md "Cloudflare-Turnstile
// wall" — the falsification matrix + the wired end-to-end token validation).

const SAVED = process.env.BOT_SELF_LAUNCH;
const SAVED_BIN = process.env.UNIVERSAL_BOT_CHROME_BINARY;

afterEach(() => {
  if (SAVED === undefined) delete process.env.BOT_SELF_LAUNCH;
  else process.env.BOT_SELF_LAUNCH = SAVED;
  if (SAVED_BIN === undefined) delete process.env.UNIVERSAL_BOT_CHROME_BINARY;
  else process.env.UNIVERSAL_BOT_CHROME_BINARY = SAVED_BIN;
});

describe("selfLaunchEnabled", () => {
  it("defaults ON when unset", () => {
    delete process.env.BOT_SELF_LAUNCH;
    expect(selfLaunchEnabled()).toBe(true);
  });

  it.each(["0", "false", "off"])("opts out with %s", (v) => {
    process.env.BOT_SELF_LAUNCH = v;
    expect(selfLaunchEnabled()).toBe(false);
  });

  it("stays ON for any other value", () => {
    process.env.BOT_SELF_LAUNCH = "1";
    expect(selfLaunchEnabled()).toBe(true);
  });
});

describe("resolveChannelBinary", () => {
  it("returns null for the bundled-chromium channel (null)", () => {
    delete process.env.UNIVERSAL_BOT_CHROME_BINARY;
    expect(resolveChannelBinary(null)).toBeNull();
  });

  it("returns null for an unknown channel", () => {
    delete process.env.UNIVERSAL_BOT_CHROME_BINARY;
    expect(resolveChannelBinary("not-a-real-channel")).toBeNull();
  });

  it("honors an explicit UNIVERSAL_BOT_CHROME_BINARY when it exists", () => {
    process.env.UNIVERSAL_BOT_CHROME_BINARY = process.execPath; // node binary always exists
    expect(resolveChannelBinary("chrome")).toBe(process.execPath);
  });

  it("rejects an explicit binary path that does not exist", () => {
    process.env.UNIVERSAL_BOT_CHROME_BINARY = "/nonexistent/path/to/chrome";
    expect(resolveChannelBinary("chrome")).toBeNull();
  });

  it("resolves the chrome channel to an on-disk path when Chrome is installed", () => {
    delete process.env.UNIVERSAL_BOT_CHROME_BINARY;
    const resolved = resolveChannelBinary("chrome");
    // Environment-dependent: assert consistency rather than presence.
    if (resolved !== null) expect(existsSync(resolved)).toBe(true);
  });
});
