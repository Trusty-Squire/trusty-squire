import { randomBytes } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { CDPSession, Page } from "playwright";
import { WebSocket, WebSocketServer } from "ws";
import type { Session } from "./session/model.js";
import { startQuickViewTunnel } from "./remote-login-display.js";

const SHARE_LIFETIME_MS = 10 * 60_000;
const MAX_INPUT_BYTES = 4_096;
const viewerHtml = readFileSync(
  new URL("../../assets/operate/share.html", import.meta.url),
  "utf8",
);
type Tunnel = { url: string; close: () => Promise<void> };
type TunnelFactory = (port: number) => Promise<Tunnel>;

const shares = new WeakMap<Session, LiveShare>();
const agentTurn = new AsyncLocalStorage<LiveShare>();

function isInput(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function coordinate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function waitForSignal(wakers: Set<() => void>, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const finish = (): void => {
      wakers.delete(wake);
      signal?.removeEventListener("abort", aborted);
    };
    const wake = (): void => {
      finish();
      resolve();
    };
    const aborted = (): void => {
      finish();
      reject(signal?.reason ?? new Error("operator_request_cancelled"));
    };
    wakers.add(wake);
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

function wakeAll(wakers: Set<() => void>): void {
  for (const wake of [...wakers]) wake();
}

export class LiveShare {
  readonly token = randomBytes(32).toString("base64url");
  readonly expiresAt = Date.now() + SHARE_LIFETIME_MS;
  readonly path = `/s/${this.token}/`;
  readonly server: Server;
  readonly webSockets = new WebSocketServer({ noServer: true, maxPayload: MAX_INPUT_BYTES });
  private tunnel: Tunnel | null = null;
  private readonly viewers = new Set<WebSocket>();
  private controlOwner: WebSocket | null = null;
  private cdp: CDPSession | null = null;
  private fallbackFrames: NodeJS.Timeout | null = null;
  private lastFrameAt = 0;
  private fallbackBusy = false;
  private streamStartup: Promise<void> | null = null;
  private expired = false;
  private readonly timer: NodeJS.Timeout;
  private humanWanted = false;
  private humanDriving = false;
  private activeAgentActions = 0;
  private readonly agentWaiters = new Set<() => void>();
  private readonly idleWaiters = new Set<() => void>();
  private frameWidth = 1;
  private frameHeight = 1;
  private inputTail: Promise<void> = Promise.resolve();
  private publicUrl: string | null = null;
  private readonly pagePoll: NodeJS.Timeout;
  private pageUnavailable = false;

  constructor(
    readonly session: Session,
    private page: Page,
  ) {
    this.server = createServer((request, response) => {
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Referrer-Policy", "no-referrer");
      response.setHeader("X-Content-Type-Options", "nosniff");
      if (this.expired || this.session.closing) {
        response.writeHead(410).end();
        return;
      }
      if (request.method !== "GET" || request.url !== this.path) {
        response.writeHead(404).end();
        return;
      }
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.writeHead(200).end(viewerHtml);
    });
    this.server.on("upgrade", (request, socket, head) => {
      if (this.expired || this.session.closing || request.url !== `${this.path}stream`) {
        socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      this.webSockets.handleUpgrade(request, socket, head, (viewer) => {
        this.viewers.add(viewer);
        this.webSockets.emit("connection", viewer, request);
        void this.attach(viewer);
      });
    });
    this.timer = setTimeout(() => this.stop(), SHARE_LIFETIME_MS);
    this.timer.unref();
    this.pagePoll = setInterval(() => this.refreshPage(), 250);
    this.pagePoll.unref();
  }

  async start(tunnelFactory: TunnelFactory): Promise<string> {
    try {
      await new Promise<void>((resolve, reject) => {
        this.server.once("error", reject);
        this.server.listen(0, "127.0.0.1", () => {
          this.server.removeListener("error", reject);
          resolve();
        });
      });
      const port = (this.server.address() as AddressInfo).port;
      const tunnel = await tunnelFactory(port);
      if (this.expired || this.session.closing) {
        await tunnel.close();
        throw new Error("operate session ended during share");
      }
      this.tunnel = tunnel;
      this.publicUrl = `${this.tunnel.url.replace(/\/$/, "")}${this.path}`;
      return this.publicUrl;
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  get controlState(): "agent" | "human" {
    return this.humanWanted ? "human" : "agent";
  }

  get activeUrl(): string | null {
    return this.expired ? null : this.publicUrl;
  }

  async withAgentAction<T>(action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    while (this.humanWanted) await waitForSignal(this.agentWaiters, signal);
    if (signal?.aborted) throw signal.reason;
    if (this.session.closing) throw new Error("operate session is closing");
    this.activeAgentActions += 1;
    try {
      return await agentTurn.run(this, action);
    } finally {
      this.activeAgentActions -= 1;
      if (this.activeAgentActions === 0) wakeAll(this.idleWaiters);
    }
  }

  /** A long operate_drive call releases its browser turn between steps. */
  async yieldAgentAction(signal?: AbortSignal): Promise<void> {
    if (!this.humanWanted) return;
    const ownedTurn = agentTurn.getStore() === this;
    if (ownedTurn) {
      this.activeAgentActions -= 1;
      if (this.activeAgentActions === 0) wakeAll(this.idleWaiters);
    }
    try {
      while (this.humanWanted) await waitForSignal(this.agentWaiters, signal);
      if (signal?.aborted) throw signal.reason;
      if (this.session.closing) throw new Error("operate session is closing");
    } finally {
      if (ownedTurn) this.activeAgentActions += 1;
    }
  }

  private async takeControl(viewer: WebSocket): Promise<boolean> {
    if (this.expired || !this.viewers.has(viewer) || this.session.closing) return false;
    this.controlOwner = viewer;
    this.humanWanted = true;
    while (this.activeAgentActions > 0 && this.controlOwner === viewer && this.viewers.has(viewer) && !this.expired)
      await waitForSignal(this.idleWaiters);
    if (this.expired || !this.viewers.has(viewer) || this.controlOwner !== viewer || this.session.closing) return false;
    if (!this.humanDriving) {
      this.humanDriving = true;
      this.broadcast({ type: "control", state: "human" });
    }
    return true;
  }

  private release(viewer: WebSocket): void {
    if (!this.viewers.delete(viewer)) return;
    wakeAll(this.idleWaiters);
    const pendingInput = this.inputTail;
    void pendingInput.then(() => {
      if (this.controlOwner === viewer) {
        this.controlOwner = null;
        this.humanWanted = false;
        this.humanDriving = false;
        this.broadcast({ type: "control", state: "agent" });
        wakeAll(this.agentWaiters);
        wakeAll(this.idleWaiters);
      }
      if (this.viewers.size === 0) this.stopStream();
    });
  }

  private stopStream(): void {
    if (this.fallbackFrames !== null) clearInterval(this.fallbackFrames);
    this.fallbackFrames = null;
    const cdp = this.cdp;
    this.cdp = null;
    if (cdp !== null) {
      void cdp.send("Page.stopScreencast").catch(() => undefined);
      void cdp.detach().catch(() => undefined);
    }
  }

  private refreshPage(): void {
    if (this.expired) return;
    const current = this.session.browser.page;
    if (current === null || current.isClosed()) {
      if (!this.pageUnavailable) this.broadcast({ type: "blank" });
      this.pageUnavailable = true;
      this.stopStream();
      return;
    }
    this.pageUnavailable = false;
    if (current === this.page) {
      if (this.viewers.size > 0 && this.cdp === null && this.streamStartup === null)
        this.streamStartup = this.startStream();
      return;
    }
    this.page = current;
    this.broadcast({ type: "blank" });
    this.stopStream();
    if (this.viewers.size > 0 && this.streamStartup === null) {
      this.streamStartup = this.startStream();
    }
  }

  private async attach(viewer: WebSocket): Promise<void> {
    viewer.on("close", () => this.release(viewer));
    viewer.on("error", () => this.release(viewer));
    viewer.on("message", (data) => {
      this.inputTail = this.inputTail
        .then(() => this.handleInput(viewer, data.toString()))
        .catch(() => viewer.close(1011));
    });
    viewer.send(JSON.stringify({ type: "control", state: this.humanWanted ? "human" : "agent" }));
    if (this.streamStartup !== null) return;
    this.streamStartup = this.startStream();
    await this.streamStartup;
  }

  private broadcast(message: Record<string, unknown>): void {
    const wire = JSON.stringify(message);
    for (const viewer of this.viewers)
      if (viewer.readyState === WebSocket.OPEN && viewer.bufferedAmount < 1_000_000)
        viewer.send(wire);
  }

  private async startStream(): Promise<void> {
    try {
      const page = this.page;
      if (page.isClosed() || this.session.browser.page !== page) return;
      const cdp = await page.context().newCDPSession(page);
      if (this.viewers.size === 0 || this.expired || page !== this.page) {
        await cdp.detach();
        return;
      }
      this.cdp = cdp;
      cdp.on("Page.screencastFrame", (frame) => {
        if (this.cdp !== cdp) return;
        this.lastFrameAt = Date.now();
        this.frameWidth = Math.max(1, frame.metadata.deviceWidth);
        this.frameHeight = Math.max(1, frame.metadata.deviceHeight);
        this.broadcast({ type: "frame", data: frame.data });
        void cdp
          .send("Page.screencastFrameAck", { sessionId: frame.sessionId })
          .catch(() => undefined);
      });
      await cdp.send("Page.startScreencast", { format: "jpeg", quality: 70, everyNthFrame: 2 });
      // Chromium can withhold screencast frames from a background tab. Capture
      // that same target directly so concurrent shares never switch the user's
      // foreground tab or silently freeze one another.
      this.fallbackFrames = setInterval(() => {
        if (Date.now() - this.lastFrameAt < 750 || this.fallbackBusy || this.cdp !== cdp) return;
        this.fallbackBusy = true;
        void (async () => {
          try {
            const metrics = await cdp.send("Page.getLayoutMetrics");
            this.frameWidth = Math.max(1, metrics.cssVisualViewport.clientWidth);
            this.frameHeight = Math.max(1, metrics.cssVisualViewport.clientHeight);
            const frame = await cdp.send("Page.captureScreenshot", {
              format: "jpeg",
              quality: 70,
              captureBeyondViewport: false,
              fromSurface: true,
            });
            if (this.cdp === cdp) this.broadcast({ type: "frame", data: frame.data });
          } catch {
            // A navigating target can briefly refuse a frame; the next tick retries.
          } finally {
            this.fallbackBusy = false;
          }
        })();
      }, 750);
      this.fallbackFrames.unref();
    } catch {
      for (const viewer of this.viewers) viewer.close(1011);
    } finally {
      this.streamStartup = null;
    }
  }

  private async handleInput(viewer: WebSocket, raw: string): Promise<void> {
    if (!this.viewers.has(viewer) || raw.length > MAX_INPUT_BYTES || this.cdp === null) return;
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (!isInput(message)) return;
    if (message.type === "pointer" && coordinate(message.x) && coordinate(message.y)) {
      if (!["move", "down", "up"].includes(String(message.phase))) return;
      const button = ["left", "middle", "right"].includes(String(message.button))
        ? (message.button as "left" | "middle" | "right")
        : "left";
      if (!(await this.takeControl(viewer))) return;
      const cdp = this.currentInputTarget();
      if (cdp === null) return;
      const type =
        message.phase === "down"
          ? "mousePressed"
          : message.phase === "up"
            ? "mouseReleased"
            : "mouseMoved";
      await cdp.send("Input.dispatchMouseEvent", {
        type,
        x: message.x * this.frameWidth,
        y: message.y * this.frameHeight,
        button: message.phase === "move" ? "none" : button,
        clickCount: message.phase === "move" ? 0 : 1,
      });
    } else if (
      message.type === "wheel" &&
      coordinate(message.x) &&
      coordinate(message.y) &&
      typeof message.delta_x === "number" &&
      typeof message.delta_y === "number" &&
      Number.isFinite(message.delta_x) &&
      Number.isFinite(message.delta_y)
    ) {
      if (!(await this.takeControl(viewer))) return;
      const cdp = this.currentInputTarget();
      if (cdp === null) return;
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: message.x * this.frameWidth,
        y: message.y * this.frameHeight,
        deltaX: Math.max(-2_000, Math.min(2_000, message.delta_x)),
        deltaY: Math.max(-2_000, Math.min(2_000, message.delta_y)),
      });
    } else if (message.type === "touch" && coordinate(message.x) && coordinate(message.y)) {
      if (!["start", "move", "end"].includes(String(message.phase))) return;
      if (!(await this.takeControl(viewer))) return;
      const cdp = this.currentInputTarget();
      if (cdp === null) return;
      await cdp.send("Input.dispatchTouchEvent", {
        type:
          message.phase === "start"
            ? "touchStart"
            : message.phase === "end"
              ? "touchEnd"
              : "touchMove",
        touchPoints:
          message.phase === "end"
            ? []
            : [{ x: message.x * this.frameWidth, y: message.y * this.frameHeight }],
      });
    } else if (
      message.type === "text" &&
      typeof message.text === "string" &&
      message.text.length <= 500
    ) {
      if (!(await this.takeControl(viewer))) return;
      const cdp = this.currentInputTarget();
      if (cdp === null) return;
      await cdp.send("Input.insertText", { text: message.text });
    } else if (message.type === "key" && typeof message.key === "string") {
      const key = message.key;
      const codes: Record<string, number> = {
        Backspace: 8,
        Tab: 9,
        Enter: 13,
        Escape: 27,
        ArrowLeft: 37,
        ArrowUp: 38,
        ArrowRight: 39,
        ArrowDown: 40,
        Delete: 46,
      };
      const letter = /^[a-z]$/i.test(key) ? key.toUpperCase().charCodeAt(0) : undefined;
      const code = codes[key] ?? letter;
      if (code === undefined || !(await this.takeControl(viewer))) return;
      const cdp = this.currentInputTarget();
      if (cdp === null) return;
      const modifiers =
        (message.alt === true ? 1 : 0) +
        (message.ctrl === true ? 2 : 0) +
        (message.meta === true ? 4 : 0) +
        (message.shift === true ? 8 : 0);
      await cdp.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key,
        windowsVirtualKeyCode: code,
        modifiers,
      });
      await cdp.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key,
        windowsVirtualKeyCode: code,
        modifiers,
      });
    }
  }

  private currentInputTarget(): CDPSession | null {
    if (this.session.browser.page !== this.page || this.page.isClosed()) {
      this.refreshPage();
      return null;
    }
    return this.cdp;
  }

  stop(): void {
    if (this.expired) return;
    this.expired = true;
    clearTimeout(this.timer);
    clearInterval(this.pagePoll);
    for (const viewer of [...this.viewers]) {
      viewer.close(1000, "share ended");
      this.release(viewer);
    }
    this.webSockets.close();
    if (this.server.listening) this.server.close();
    const tunnel = this.tunnel;
    this.tunnel = null;
    if (tunnel !== null) void tunnel.close().catch(() => undefined);
  }
}

export async function shareOperateSession(
  session: Session,
  tunnelFactory: TunnelFactory = startQuickViewTunnel,
): Promise<{ url: string; expires_at: string; control: "agent" | "human" }> {
  const page = session.browser.page;
  if (page === null || page.isClosed() || session.closing)
    throw new Error("operate session is closed");
  const old = shares.get(session);
  const existingUrl = old?.activeUrl;
  if (old !== undefined && existingUrl !== null && existingUrl !== undefined)
    return {
      url: existingUrl,
      expires_at: new Date(old.expiresAt).toISOString(),
      control: old.controlState,
    };
  old?.stop();
  const share = new LiveShare(session, page);
  shares.set(session, share);
  try {
    const url = await share.start(tunnelFactory);
    return {
      url,
      expires_at: new Date(share.expiresAt).toISOString(),
      control: share.controlState,
    };
  } catch (error) {
    if (shares.get(session) === share) shares.delete(session);
    throw error;
  }
}

export async function withAgentShareControl<T>(
  session: Session,
  action: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const share = shares.get(session);
  return share === undefined ? await action() : await share.withAgentAction(action, signal);
}

export async function yieldOperateDriveToHuman(
  session: Session,
  signal?: AbortSignal,
): Promise<void> {
  await shares.get(session)?.yieldAgentAction(signal);
}

export function stopOperateShare(session: Session): void {
  const share = shares.get(session);
  shares.delete(session);
  share?.stop();
}
