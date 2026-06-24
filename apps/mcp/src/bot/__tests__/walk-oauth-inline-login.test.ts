// walkOAuthConsent must DRIVE an inline sign-in instead of bailing
// `needs_login` when it lands on a Google identifier/login page AND a
// credential-backed driveOAuthLogin callback is available — the freshly-created
// verifier robot lands on the identifier page the first time a relying party
// requests OAuth, and the discover bot would just type the password. Without
// the callback (live-user router), the identifier page stays terminal.

import { describe, expect, it, vi } from "vitest";
import type { BrowserController } from "../browser.js";
import { walkOAuthConsent } from "../replay-skill.js";

// Minimal BrowserController stub: a scripted URL sequence + a no-op consent
// page. `advance()` steps to the next URL — the success path calls it from the
// inline-login callback, modelling the page navigating off the identifier
// screen once the credential is typed through.
function stubBrowser(urls: string[]): {
  browser: BrowserController;
  advance: () => void;
} {
  let i = 0;
  const browser = {
    oauthPageClosed: () => false,
    currentUrl: () => urls[Math.min(i, urls.length - 1)] ?? "about:blank",
    async extractText() {
      return "";
    },
    async wait() {
      /* no-op */
    },
  } as unknown as BrowserController;
  return {
    browser,
    advance: () => {
      i = Math.min(i + 1, urls.length - 1);
    },
  };
}

describe("walkOAuthConsent — inline login drive", () => {
  it("bails needs_login on the identifier page when no credential callback is wired", async () => {
    const { browser } = stubBrowser([
      "https://accounts.google.com/v3/signin/identifier?flow=x",
    ]);
    const result = await walkOAuthConsent(browser, "google");
    expect(result).toBe("needs_login");
  });

  it("drives the sign-in and continues the walk when a callback is provided", async () => {
    // identifier page first; once the inline login 'progresses', the next loop
    // read sees the relying party (not_provider) → walk returns ok.
    const { browser, advance } = stubBrowser([
      "https://accounts.google.com/v3/signin/identifier?flow=x",
      "https://meilisearch.com/callback?code=abc",
    ]);
    const drive = vi.fn(async () => {
      advance(); // typing the credential through navigates off identifier
      return true;
    });
    const result = await walkOAuthConsent(browser, "google", drive);
    expect(drive).toHaveBeenCalledTimes(1);
    expect(drive).toHaveBeenCalledWith("google");
    expect(result).toBe("ok");
  });

  it("falls through to needs_login when the inline login does not clear the page", async () => {
    const { browser } = stubBrowser([
      "https://accounts.google.com/v3/signin/identifier?flow=x",
    ]);
    const drive = vi.fn(async () => false); // wrong password / 2SV wall
    const result = await walkOAuthConsent(browser, "google", drive);
    expect(drive).toHaveBeenCalledTimes(1);
    expect(result).toBe("needs_login");
  });

  it("drives the login at most once even across multiple identifier reads", async () => {
    // Stays on identifier the whole time; drive returns true but the page never
    // actually clears → the one-shot guard must NOT re-drive every iteration.
    const { browser } = stubBrowser([
      "https://accounts.google.com/v3/signin/identifier?flow=x",
    ]);
    const drive = vi.fn(async () => true);
    const result = await walkOAuthConsent(browser, "google", drive);
    expect(drive).toHaveBeenCalledTimes(1);
    expect(result).toBe("needs_login");
  });
});
