import type { Page } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserController } from "../browser.js";
import { shareOperateSession, stopOperateShare } from "../live-share.js";
import { createSession, type Session } from "../session/model.js";

let session: Session | undefined;

afterEach(() => {
  if (session !== undefined) stopOperateShare(session);
  session = undefined;
  vi.useRealTimers();
});

function startSession(): Session {
  vi.useFakeTimers();
  const page = { isClosed: () => false } as Page;
  session = createSession({
    id: "share-lifetime-test",
    browser: { page } as BrowserController,
    allowedHosts: [],
    startUrl: "https://example.com/",
    consentInboxRead: false,
    userEmail: null,
  });
  return session;
}

const localTunnel = async (port: number) => ({
  url: `http://127.0.0.1:${port}`,
  close: async () => undefined,
});

describe("live-share session lifetime", () => {
  it("keeps the original link alive past two ten-minute windows without re-sharing", async () => {
    const active = startSession();
    const shared = await shareOperateSession(active, localTunnel);
    await vi.advanceTimersByTimeAsync(21 * 60_000);
    expect((await fetch(shared.url)).status).toBe(200);
    const renewed = await shareOperateSession(active, localTunnel);
    expect(renewed.url === shared.url).toBe(true);
    expect(Date.parse(renewed.expires_at)).toBeGreaterThan(Date.now());
  });

  it("renews expires_at on repeated operate_share without changing the link", async () => {
    const active = startSession();
    const shared = await shareOperateSession(active, localTunnel);
    await vi.advanceTimersByTimeAsync(60_000);
    const renewed = await shareOperateSession(active, localTunnel);
    expect(renewed.url === shared.url).toBe(true);
    expect(Date.parse(renewed.expires_at)).toBeGreaterThan(Date.parse(shared.expires_at));
  });

  it("invalidates the link on explicit stop and refuses a closing session", async () => {
    const active = startSession();
    const shared = await shareOperateSession(active, localTunnel);
    stopOperateShare(active);
    await expect(fetch(shared.url)).rejects.toThrow();
    active.closing = true;
    await expect(shareOperateSession(active, localTunnel)).rejects.toThrow("closed");
  });
});
