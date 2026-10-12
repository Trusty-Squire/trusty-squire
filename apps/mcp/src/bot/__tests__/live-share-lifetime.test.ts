import { EventEmitter } from "node:events";
import type { Page } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { BrowserController } from "../browser.js";
import {
  LiveShare,
  shareOperateSession,
  stopOperateShare,
  stopOperateShareGateway,
  warmOperateShareGateway,
} from "../live-share.js";
import { createSession, type Session } from "../session/model.js";

let session: Session | undefined;

afterEach(async () => {
  if (session !== undefined) stopOperateShare(session);
  await stopOperateShareGateway();
  session = undefined;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function startSession(page = { isClosed: () => false } as Page): Session {
  vi.useFakeTimers();
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
  it("retries gateway preparation after a failed tunnel startup", async () => {
    const active = startSession();
    let attempts = 0;
    const factory = vi.fn(async (port: number) => {
      if (++attempts === 1) throw new Error("tunnel unavailable");
      return { url: `http://127.0.0.1:${port}`, close: async () => undefined };
    });
    await expect(warmOperateShareGateway(factory)).rejects.toThrow("tunnel unavailable");
    await warmOperateShareGateway(factory);
    const shared = await shareOperateSession(active);
    expect((await fetch(shared.url)).status).toBe(200);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("replaces a dead prepared tunnel before renewing a share", async () => {
    const active = startSession();
    let firstAlive = true;
    let generation = 0;
    const factory = vi.fn(async (port: number) => {
      const current = ++generation;
      return {
        url: `http://127.0.0.1:${port}`,
        close: async () => undefined,
        alive: () => current > 1 || firstAlive,
      };
    });
    await warmOperateShareGateway(factory);
    const first = await shareOperateSession(active);
    firstAlive = false;
    const second = await shareOperateSession(active);
    expect(second.url).not.toBe(first.url);
    expect(factory).toHaveBeenCalledTimes(2);
    expect((await fetch(second.url)).status).toBe(200);
  });

  it("delivers navigation to congested viewers while dropping only frames", async () => {
    const cdp = Object.assign(new EventEmitter(), {
      send: vi.fn(async () => undefined),
      detach: vi.fn(async () => undefined),
    });
    const mainFrame = {};
    let url = "https://example.com/start";
    const pageEvents = new EventEmitter();
    const page = Object.assign(pageEvents, {
      isClosed: () => false,
      url: () => url,
      mainFrame: () => mainFrame,
      context: () => ({ newCDPSession: async () => cdp }),
    }) as unknown as Page;
    const active = startSession(page);
    active.browser.maskOperatorOutput = (value) => value;
    const share = new LiveShare(active, page);
    const sharedUrl = await share.start(localTunnel);
    const sockets: WebSocket[] = [];
    const messages: Record<string, unknown>[][] = [];
    const nextMessage = (socket: WebSocket) =>
      new Promise<Record<string, unknown>>((resolve) => {
        socket.once("message", (raw) => resolve(JSON.parse(raw.toString())));
      });
    try {
      for (let index = 0; index < 2; index += 1) {
        const socket = new WebSocket(new URL("stream", sharedUrl));
        sockets.push(socket);
        const received: Record<string, unknown>[] = [];
        messages.push(received);
        const initialized = new Promise<void>((resolve) => {
          socket.on("message", (raw) => {
            const message = JSON.parse(raw.toString()) as Record<string, unknown>;
            received.push(message);
            if (message.type === "navigation") resolve();
          });
        });
        await initialized;
      }
      const viewer = [...share.webSockets.clients][0];
      if (viewer === undefined) throw new Error("Expected a connected server-side viewer");
      const buffered = vi.spyOn(viewer, "bufferedAmount", "get").mockReturnValue(1_000_001);
      const frame = (data: string) =>
        cdp.emit("Page.screencastFrame", {
          data,
          sessionId: 1,
          metadata: { deviceWidth: 800, deviceHeight: 600 },
        });
      const uncongestedSocket = sockets[1];
      if (uncongestedSocket === undefined) throw new Error("Expected a second viewer socket");
      const dropped = nextMessage(uncongestedSocket);
      frame("congested-frame");
      expect(await dropped).toEqual({ type: "frame", data: "congested-frame" });
      const navigations = sockets.map(nextMessage);
      url = "https://example.com/destination";
      pageEvents.emit("framenavigated", mainFrame);
      expect(await Promise.all(navigations)).toEqual([
        { type: "navigation", url, origin: "https://example.com" },
        { type: "navigation", url, origin: "https://example.com" },
      ]);
      buffered.mockReturnValue(0);
      const resumed = sockets.map(nextMessage);
      frame("resumed-frame");
      expect(await Promise.all(resumed)).toEqual([
        { type: "frame", data: "resumed-frame" },
        { type: "frame", data: "resumed-frame" },
      ]);
      expect(messages[0]).not.toContainEqual({ type: "frame", data: "congested-frame" });
      for (const received of messages)
        expect(
          received.filter((message) => message.type === "navigation" && message.url === url),
        ).toHaveLength(1);
    } finally {
      for (const socket of sockets) socket.terminate();
      share.stop();
    }
  });

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
