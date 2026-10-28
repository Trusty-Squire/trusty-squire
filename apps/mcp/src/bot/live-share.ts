import { randomBytes } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import type { CDPSession, Frame, Page } from "playwright";
import { WebSocket, WebSocketServer } from "ws";
import type { Session } from "./session/model.js";
import { startQuickViewTunnel } from "./remote-login-display.js";

const SHARE_LIFETIME_MS = 10 * 60_000;
const MAX_INPUT_BYTES = 4_096;
const MAX_DIALOG_INPUT_BYTES = 20_000;
const viewerHtml = readFileSync(
  new URL("../../assets/operate/share.html", import.meta.url),
  "utf8",
);
type Tunnel = { url: string; close: () => Promise<void>; alive?: () => boolean };
type TunnelFactory = (port: number) => Promise<Tunnel>;

const shares = new WeakMap<Session, LiveShare>();
type ShareDetails = { url: string; expires_at: string; control: "agent" | "human" };
const pendingShares = new WeakMap<Session, Promise<ShareDetails>>();
const agentTurn = new AsyncLocalStorage<LiveShare>();

type ShareGateway = {
  server: Server;
  tunnel: Tunnel;
  tunnelFactory: TunnelFactory;
  shares: Map<string, LiveShare>;
};
let gatewayStartup: Promise<ShareGateway> | null = null;

function shareForRequest(gateway: ShareGateway, request: IncomingMessage): LiveShare | undefined {
  const path = request.url?.match(/^\/s\/[A-Za-z0-9_-]{43}\//)?.[0];
  return path === undefined ? undefined : gateway.shares.get(path);
}

async function createShareGateway(tunnelFactory: TunnelFactory): Promise<ShareGateway> {
  const shares = new Map<string, LiveShare>();
  const gateway = { shares, tunnelFactory } as ShareGateway;
  const readyPath = `/ready/${randomBytes(32).toString("base64url")}`;
  const server = createServer((request, response: ServerResponse) => {
    if (request.method === "GET" && request.url === readyPath) {
      response.writeHead(204).end();
      return;
    }
    const share = shareForRequest(gateway, request);
    if (share === undefined) {
      response.writeHead(404).end();
      return;
    }
    share.server.emit("request", request, response);
  });
  gateway.server = server;
  server.on("upgrade", (request, socket: Duplex, head) => {
    const share = shareForRequest(gateway, request);
    if (share === undefined) {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }
    share.server.emit("upgrade", request, socket, head);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    const tunnel = await tunnelFactory((server.address() as AddressInfo).port);
    gateway.tunnel = tunnel;
    // A printed quick-tunnel URL precedes DNS and edge-route readiness. Prove
    // the route reaches this gateway before declaring idle preparation done.
    const deadline = Date.now() + 30_000;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(new URL(readyPath, tunnel.url), {
          signal: AbortSignal.timeout(Math.min(2_000, deadline - Date.now())),
          redirect: "error",
        });
        await response.body?.cancel();
        if (response.status === 204) return gateway;
        lastError = new Error(`share gateway returned ${response.status}`);
      } catch (error) {
        lastError = error;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("share gateway public route did not become ready", { cause: lastError });
  } catch (error) {
    await gateway.tunnel?.close();
    server.close();
    throw error;
  }
}

/** Start the public route while the broker is idle, before a share needs its URL. */
export async function warmOperateShareGateway(
  tunnelFactory: TunnelFactory = startQuickViewTunnel,
): Promise<void> {
  const previous = gatewayStartup;
  let nextFactory = tunnelFactory;
  if (previous !== null) {
    const gateway = await previous;
    if (gateway.tunnel.alive?.() !== false) return;
    nextFactory = gateway.tunnelFactory;
    if (gatewayStartup === previous) {
      gatewayStartup = null;
      for (const share of gateway.shares.values()) share.stop();
      await gateway.tunnel.close();
      await new Promise<void>((resolve) => gateway.server.close(() => resolve()));
    }
  }
  if (gatewayStartup === null) {
    const starting = createShareGateway(nextFactory);
    gatewayStartup = starting;
    void starting.catch(() => {
      if (gatewayStartup === starting) gatewayStartup = null;
    });
  }
  await gatewayStartup;
}

export async function stopOperateShareGateway(): Promise<void> {
  const starting = gatewayStartup;
  gatewayStartup = null;
  if (starting === null) return;
  const gateway = await starting.catch(() => null);
  if (gateway === null) return;
  for (const share of gateway.shares.values()) share.stop();
  await gateway.tunnel.close();
  await new Promise<void>((resolve) => gateway.server.close(() => resolve()));
}

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
  expiresAt = Date.now() + SHARE_LIFETIME_MS;
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
  private timer: NodeJS.Timeout | null = null;
  private navigationCleanup: (() => void) | null = null;
  private humanWanted = false;
  private humanDriving = false;
  private activeAgentActions = 0;
  private readonly agentWaiters = new Set<() => void>();
  private readonly idleWaiters = new Set<() => void>();
  private frameWidth = 1;
  private frameHeight = 1;
  private inputTail: Promise<void> = Promise.resolve();
  private publicUrl: string | null = null;
  private gateway: ShareGateway | null = null;
  private readonly pagePoll: NodeJS.Timeout;
  private pageUnavailable = false;
  private dialogCleanup: (() => void) | null = null;

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
    this.dialogCleanup =
      this.session.browser.nativeDialogs?.subscribe(() => this.broadcastDialogs()) ?? null;
    this.renew();
    this.pagePoll = setInterval(() => this.refreshPage(), 250);
    this.pagePoll.unref();
  }

  async start(tunnelFactory: TunnelFactory): Promise<string> {
    try {
      if (tunnelFactory === startQuickViewTunnel) {
        await warmOperateShareGateway();
        const gateway = await gatewayStartup;
        if (gateway === null || this.expired || this.session.closing)
          throw new Error("operate session ended during share");
        this.gateway = gateway;
        gateway.shares.set(this.path, this);
        this.publicUrl = `${gateway.tunnel.url.replace(/\/$/, "")}${this.path}`;
        return this.publicUrl;
      }
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
    return this.expired || this.gateway?.tunnel.alive?.() === false ? null : this.publicUrl;
  }

  /** The compatibility expiry rolls forward for the owning session's lifetime. */
  renew(): void {
    if (this.expired) return;
    if (this.session.closing) {
      this.stop();
      return;
    }
    if (this.timer !== null) clearTimeout(this.timer);
    this.expiresAt = Date.now() + SHARE_LIFETIME_MS;
    this.timer = setTimeout(() => this.renew(), SHARE_LIFETIME_MS);
    this.timer.unref();
  }

  async waitForInputToSettle(): Promise<void> {
    await this.inputTail;
    while (this.humanWanted) await waitForSignal(this.agentWaiters);
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
    while (
      this.activeAgentActions > 0 &&
      this.controlOwner === viewer &&
      this.viewers.has(viewer) &&
      !this.expired
    )
      await waitForSignal(this.idleWaiters);
    if (
      this.expired ||
      !this.viewers.has(viewer) ||
      this.controlOwner !== viewer ||
      this.session.closing
    )
      return false;
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
    this.navigationCleanup?.();
    this.navigationCleanup = null;
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
    if (this.page.isClosed() && this.session.browser.page === this.page)
      this.session.browser.returnFromClosedPopup?.(this.page);
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

  private broadcastDialogs(): void {
    this.broadcast(
      this.session.browser.maskOperatorOutput({
        type: "native_dialogs",
        dialogs: this.session.browser.nativeDialogEvidence?.() ?? [],
        notices: this.session.browser.nativeDialogs?.timeoutNotices() ?? [],
      }),
    );
  }

  private async attach(viewer: WebSocket): Promise<void> {
    this.broadcastDialogs();
    viewer.on("close", () => this.release(viewer));
    viewer.on("error", () => this.release(viewer));
    viewer.on("message", (data) => {
      const raw = data.toString();
      if (raw.length <= MAX_DIALOG_INPUT_BYTES) {
        try {
          const message: unknown = JSON.parse(raw);
          if (isInput(message) && message.type === "native_dialog") {
            void this.answerDialog(viewer, message).catch(() => this.broadcastDialogs());
            return;
          }
        } catch {
          return;
        }
      }
      this.inputTail = this.inputTail
        .then(() => this.handleInput(viewer, data.toString()))
        .catch(() => viewer.close(1011));
    });
    viewer.send(JSON.stringify({ type: "control", state: this.humanWanted ? "human" : "agent" }));
    if (this.cdp !== null) {
      viewer.send(JSON.stringify(this.navigationMessage(this.page)));
      return;
    }
    if (this.streamStartup !== null) return;
    this.streamStartup = this.startStream();
    await this.streamStartup;
  }

  private broadcast(message: Record<string, unknown>): void {
    const wire = JSON.stringify(message);
    for (const viewer of this.viewers)
      if (
        viewer.readyState === WebSocket.OPEN &&
        (message.type !== "frame" || viewer.bufferedAmount < 1_000_000)
      )
        viewer.send(wire);
  }

  private navigationMessage(page: Page): Record<string, unknown> {
    const url = page.url();
    return this.session.browser.maskOperatorOutput({
      type: "navigation",
      url,
      origin: new URL(url).origin,
    });
  }

  private async startStream(): Promise<void> {
    try {
      const page = this.page;
      if (page.isClosed() || this.session.browser.page !== page) return;
      const cdp = await page.context().newCDPSession(page);
      if (
        this.viewers.size === 0 ||
        this.expired ||
        page !== this.page ||
        this.session.browser.page !== page
      ) {
        await cdp.detach();
        return;
      }
      this.cdp = cdp;
      const reportNavigation = (): void => {
        if (
          this.expired ||
          this.cdp !== cdp ||
          this.session.browser.page !== page ||
          this.session.closing
        )
          return;
        this.broadcast(this.navigationMessage(page));
      };
      const onNavigation = (frame: Frame): void => {
        if (frame === page.mainFrame()) reportNavigation();
      };
      const onPopup = (popup: Page): void => {
        // OwnedPages records creation-time lineage before this listener runs.
        // Human input bypasses agent action adoption, so follow its popup here.
        if (
          this.expired ||
          this.session.closing ||
          !this.humanDriving ||
          this.activeAgentActions > 0 ||
          this.cdp !== cdp
        )
          return;
        if (this.session.browser.followOpenedPopup(page, popup)) this.refreshPage();
      };
      page.on("framenavigated", onNavigation);
      page.on("popup", onPopup);
      this.navigationCleanup = () => {
        page.off("framenavigated", onNavigation);
        page.off("popup", onPopup);
      };
      reportNavigation();
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
      if (this.cdp !== cdp || this.expired) return;
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

  private async answerDialog(viewer: WebSocket, message: Record<string, unknown>): Promise<void> {
    if (
      !this.viewers.has(viewer) ||
      this.expired ||
      this.session.closing ||
      typeof message.id !== "string" ||
      (message.action !== "accept" && message.action !== "dismiss") ||
      (message.text !== undefined &&
        (typeof message.text !== "string" || message.text.length > 4096))
    )
      return;
    // A pointer up can itself be waiting for this dialog; it must not own the reply queue.
    if (!(await this.takeControl(viewer))) return;
    const { withProvisionSessionCall } = await import("./session/lifecycle.js");
    const { id, action, text } = message;
    await withProvisionSessionCall(this.session.id, async () => {
      if (!this.viewers.has(viewer) || this.expired) return;
      await this.session.browser.nativeDialogs.answer(id, action, text);
    });
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
      // Canvas clients such as noVNC consume key events rather than DOM edits.
      // Iterate code points so a non-BMP character stays a single key.
      for (const character of message.text.replace(/\r\n/g, "\n")) {
        const enter = character === "\n" || character === "\r";
        const key = enter ? "Enter" : character;
        const text = enter ? "\r" : character;
        const keyCode = enter ? { windowsVirtualKeyCode: 13 } : {};
        try {
          await cdp.send("Input.dispatchKeyEvent", {
            type: "keyDown",
            key,
            text,
            unmodifiedText: text,
            ...keyCode,
          });
        } catch {
          // A rejected key must not discard the remainder of a paste.
          await cdp.send("Input.insertText", { text: character });
          continue;
        }
        await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, ...keyCode });
      }
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
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    clearInterval(this.pagePoll);
    this.dialogCleanup?.();
    this.dialogCleanup = null;
    this.navigationCleanup?.();
    this.navigationCleanup = null;
    if (this.viewers.size === 0) this.stopStream();
    for (const viewer of [...this.viewers]) {
      viewer.close(1000, "share ended");
      this.release(viewer);
    }
    this.webSockets.close();
    this.gateway?.shares.delete(this.path);
    this.gateway = null;
    if (this.server.listening) this.server.close();
    const tunnel = this.tunnel;
    this.tunnel = null;
    if (tunnel !== null) void tunnel.close().catch(() => undefined);
  }
}

export async function shareOperateSession(
  session: Session,
  tunnelFactory: TunnelFactory = startQuickViewTunnel,
): Promise<ShareDetails> {
  const pending = pendingShares.get(session);
  if (pending !== undefined) return await pending;
  const starting = (async (): Promise<ShareDetails> => {
    const page = session.browser.page;
    if (page === null || page.isClosed() || session.closing)
      throw new Error("operate session is closed");
    const old = shares.get(session);
    const existingUrl = old?.activeUrl;
    if (old !== undefined && existingUrl !== null && existingUrl !== undefined) {
      old.renew();
      return {
        url: existingUrl,
        expires_at: new Date(old.expiresAt).toISOString(),
        control: old.controlState,
      };
    }
    old?.stop();
    await old?.waitForInputToSettle();
    if (session.closing || session.browser.page === null || session.browser.page.isClosed())
      throw new Error("operate session is closed");
    const share = new LiveShare(session, session.browser.page);
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
  })();
  pendingShares.set(session, starting);
  try {
    return await starting;
  } finally {
    if (pendingShares.get(session) === starting) pendingShares.delete(session);
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
