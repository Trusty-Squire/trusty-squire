import { afterEach, describe, expect, it } from "vitest";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveChannelBinary, waitForOwnedDevtoolsEndpoint } from "../browser.js";

// The self-launch path (spawn Chrome ourselves + connectOverCDP) is the
// Turnstile-safe launch, and it is not optional: there is no flag that turns
// it off. These cover the pure decision helper that resolves the binary; the
// launch itself is exercised live (see STATE.md "Cloudflare-Turnstile wall" —
// the falsification matrix + the wired end-to-end token validation).

const SAVED_BIN = process.env.UNIVERSAL_BOT_CHROME_BINARY;

afterEach(() => {
  if (SAVED_BIN === undefined) delete process.env.UNIVERSAL_BOT_CHROME_BINARY;
  else process.env.UNIVERSAL_BOT_CHROME_BINARY = SAVED_BIN;
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

describe("owned self-launch DevTools endpoint", () => {
  it("waits for the browser endpoint published inside its own profile", async () => {
    const profileDir = mkdtempSync(join(tmpdir(), "ts-owned-devtools-"));
    const browserPath = "/devtools/browser/owned-browser";
    const child = { exitCode: null, signalCode: null } as ChildProcess;
    try {
      writeFileSync(join(profileDir, "DevToolsActivePort"), "9222\ninvalid-browser-path\n");
      const endpoint = waitForOwnedDevtoolsEndpoint(profileDir, 1_000, child);
      setTimeout(() => {
        writeFileSync(join(profileDir, "DevToolsActivePort"), `39123\n${browserPath}\n`);
      }, 25);
      await expect(endpoint).resolves.toBe(`ws://127.0.0.1:39123${browserPath}`);
    } finally {
      rmSync(profileDir, { recursive: true, force: true });
    }
  });
});
