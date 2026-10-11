import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "playwright";
import { WebSocket } from "ws";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserController } from "../browser.js";
import {
  LiveShare,
  shareOperateSession,
  withAgentShareControl,
  yieldOperateDriveToHuman,
} from "../live-share.js";
import {
  finishProvisionSession,
  paymentSession,
  startHarnessProvisionSession,
} from "../provision-session.js";

let fixture: Server | undefined;
let browser: Browser | undefined;
let sessionId: string | undefined;
let secondSessionId: string | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  if (sessionId !== undefined) await finishProvisionSession(sessionId).catch(() => undefined);
  if (secondSessionId !== undefined)
    await finishProvisionSession(secondSessionId).catch(() => undefined);
  sessionId = undefined;
  secondSessionId = undefined;
  await browser?.close();
  browser = undefined;
  if (fixture !== undefined) await new Promise<void>((resolve) => fixture!.close(() => resolve()));
  fixture = undefined;
});

function waitForMessage(socket: WebSocket, match: (message: Record<string, unknown>) => boolean) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("live view message timed out")), 10_000);
    const onMessage = (raw: Buffer) => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (!match(message)) return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve(message);
    };
    socket.on("message", onMessage);
  });
}

describe("operate live share", () => {
  it("does not send waiting input to a page the agent replaced", async () => {
    fixture = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html");
      response.end('<!doctype html><input id="answer" autofocus>');
    });
    await new Promise<void>((resolve) => fixture!.listen(0, "127.0.0.1", resolve));
    const fixtureUrl = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}/`;
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const oldPage = await context.newPage();
    const controller = BrowserController.fromHarnessPage(oldPage);
    const started = await startHarnessProvisionSession({
      serviceUrl: fixtureUrl,
      browser: controller,
      initialObservation: "drive",
    });
    sessionId = started.session_id;
    const session = paymentSession(sessionId);
    await oldPage.locator("#answer").focus();
    const shared = await shareOperateSession(session, async (port) => ({
      url: `http://127.0.0.1:${port}`,
      close: async () => undefined,
    }));
    const socket = new WebSocket(new URL("stream", shared.url));
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    await waitForMessage(socket, (message) => message.type === "frame");

    let finishAgent!: () => void;
    let agentEntered!: () => void;
    const entered = new Promise<void>((resolve) => { agentEntered = resolve; });
    const finish = new Promise<void>((resolve) => { finishAgent = resolve; });
    const action = withAgentShareControl(session, async () => {
      agentEntered();
      await finish;
    });
    await entered;
    socket.send(JSON.stringify({ type: "text", text: "stale input" }));
    await expect.poll(() => shareOperateSession(session).then((value) => value.control)).toBe("human");
    const newPage = await oldPage.context().newPage();
    await newPage.goto(fixtureUrl);
    await newPage.locator("#answer").focus();
    controller.page = newPage;
    const nextFrame = waitForMessage(socket, (message) => message.type === "frame");
    finishAgent();
    await action;
    await nextFrame;
    socket.send(JSON.stringify({ type: "text", text: "current input" }));
    await expect.poll(() => newPage.locator("#answer").inputValue()).toBe("current input");
    expect(await oldPage.locator("#answer").inputValue()).toBe("");
    socket.close();
  }, 60_000);

  it("keeps old input ahead of agent actions and replacement shares", async () => {
    fixture = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html");
      response.end('<!doctype html><input id="answer" autofocus>');
    });
    await new Promise<void>((resolve) => fixture!.listen(0, "127.0.0.1", resolve));
    const fixtureUrl = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}/`;
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const context = page.context();
    const originalSession = context.newCDPSession.bind(context);
    let inputStarted!: () => void;
    let finishInput!: () => void;
    const startedInput = new Promise<void>((resolve) => { inputStarted = resolve; });
    const inputGate = new Promise<void>((resolve) => { finishInput = resolve; });
    context.newCDPSession = async (target) => {
      const cdp = await originalSession(target);
      const send = cdp.send.bind(cdp);
      cdp.send = (async (method: string, params?: object) => {
        if (method === "Input.insertText") {
          inputStarted();
          await inputGate;
        }
        return await Reflect.apply(send, cdp, [method, params]);
      }) as typeof cdp.send;
      return cdp;
    };
    const controller = BrowserController.fromHarnessPage(page);
    const started = await startHarnessProvisionSession({
      serviceUrl: fixtureUrl,
      browser: controller,
      initialObservation: "drive",
    });
    sessionId = started.session_id;
    const session = paymentSession(sessionId);
    let liveShare!: LiveShare;
    const originalStart = LiveShare.prototype.start;
    const startSpy = vi.spyOn(LiveShare.prototype, "start").mockImplementation(function (this: LiveShare, tunnelFactory) {
      liveShare = this;
      return originalStart.call(this, tunnelFactory);
    });
    const localTunnel = async (port: number) => ({
      url: `http://127.0.0.1:${port}`,
      close: async () => undefined,
    });
    const shared = await shareOperateSession(session, localTunnel);
    startSpy.mockRestore();
    const socket = new WebSocket(new URL("stream", shared.url));
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    await waitForMessage(socket, (message) => message.type === "frame");
    socket.send(JSON.stringify({ type: "text", text: "from human" }));
    await startedInput;
    let agentRan = false;
    const agent = withAgentShareControl(session, async () => {
      agentRan = true;
    });
    socket.close();
    await new Promise<void>((resolve) => socket.once("close", resolve));
    expect(agentRan).toBe(false);
    liveShare.stop();
    let replacementFinished = false;
    let nextAgentRan = false;
    const replacement = shareOperateSession(session, localTunnel).then((value) => {
      replacementFinished = true;
      return value;
    });
    const competingReplacement = shareOperateSession(session, localTunnel);
    const nextAgent = withAgentShareControl(session, async () => {
      nextAgentRan = true;
    });
    try {
      await Promise.resolve();
      expect(replacementFinished).toBe(false);
      expect(nextAgentRan).toBe(false);
    } finally {
      finishInput();
    }
    const [, , renewed, competing] = await Promise.all([agent, nextAgent, replacement, competingReplacement]);
    expect(await page.locator("#answer").inputValue()).toBe("from human");
    expect(agentRan).toBe(true);
    expect(nextAgentRan).toBe(true);
    expect(replacementFinished).toBe(true);
    expect(competing.url).toBe(renewed.url);
  }, 60_000);

  it("streams one session, hands control to input, resumes on disconnect, and dies with the session", async () => {
    fixture = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html");
      response.end(
        '<!doctype html><title>Owned tab</title><input autofocus id="answer" /><button id="click" onclick="this.dataset.count=String(Number(this.dataset.count||0)+1)">Click</button><div id="marker"></div>',
      );
    });
    await new Promise<void>((resolve) => fixture!.listen(0, "127.0.0.1", resolve));
    const fixtureUrl = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}/`;
    browser = await chromium.launch({ headless: true });
    const page: Page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    const controller = BrowserController.fromHarnessPage(page);
    const started = await startHarnessProvisionSession({
      serviceUrl: fixtureUrl,
      browser: controller,
      initialObservation: "drive",
    });
    sessionId = started.session_id;
    const session = paymentSession(sessionId);
    await page.locator("#answer").focus();

    const shared = await shareOperateSession(session, async (port) => ({
      url: `http://127.0.0.1:${port}`,
      close: async () => undefined,
    }));
    expect(shared.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/s\/[A-Za-z0-9_-]{43}\/$/);
    expect((await fetch(shared.url)).status).toBe(200);
    expect((await fetch(new URL("/s/invalid/", shared.url))).status).toBe(404);

    const socket = new WebSocket(new URL("stream", shared.url));
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    const frame = await waitForMessage(socket, (message) => message.type === "frame");
    expect(typeof frame.data).toBe("string");
    const image = await sharp(Buffer.from(frame.data as string, "base64")).metadata();
    expect(image.width).toBeGreaterThan(0);
    expect(image.height).toBeGreaterThan(0);
    const human = waitForMessage(
      socket,
      (message) => message.type === "control" && message.state === "human",
    );
    socket.send(JSON.stringify({ type: "text", text: "from human" }));
    await human;
    await page.waitForFunction(
      () => (document.querySelector("#answer") as HTMLInputElement).value === "from human",
    );
    expect((await shareOperateSession(session)).control).toBe("human");

    // The system-browser link can open while the embedded viewer remains open.
    const second = new WebSocket(new URL("stream", shared.url));
    await new Promise<void>((resolve, reject) => {
      second.once("open", resolve);
      second.once("error", reject);
    });
    const box = await page.locator("#click").boundingBox();
    if (box === null || image.width === undefined || image.height === undefined)
      throw new Error("button unavailable");
    const x = (box.x + box.width / 2) / image.width;
    const y = (box.y + box.height / 2) / image.height;
    second.send(JSON.stringify({ type: "pointer", phase: "down", x, y }));
    second.send(JSON.stringify({ type: "pointer", phase: "up", x, y }));
    await page.waitForFunction(
      () => document.querySelector("#click")?.getAttribute("data-count") === "1",
    );
    second.send(JSON.stringify({ type: "touch", phase: "start", x, y }));
    second.send(JSON.stringify({ type: "touch", phase: "end", x, y }));
    await page.waitForFunction(
      () => document.querySelector("#click")?.getAttribute("data-count") === "2",
    );

    let agentRan = false;
    const agent = withAgentShareControl(session, async () => {
      agentRan = true;
      await page.locator("#marker").evaluate((node) => {
        node.textContent = "agent resumed";
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(agentRan).toBe(false);
    socket.close();
    await new Promise<void>((resolve) => socket.once("close", () => resolve()));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(agentRan).toBe(false);
    second.close();
    await new Promise<void>((resolve) => second.once("close", () => resolve()));
    await agent;
    expect(agentRan).toBe(true);

    // A long drive yields its browser turn between steps, then continues after
    // the human closes the viewer rather than racing the human's input.
    const third = new WebSocket(new URL("stream", shared.url));
    await new Promise<void>((resolve, reject) => {
      third.once("open", resolve);
      third.once("error", reject);
    });
    await waitForMessage(third, (message) => message.type === "frame");
    let enterAgent!: () => void;
    let allowCheckpoint!: () => void;
    const entered = new Promise<void>((resolve) => {
      enterAgent = resolve;
    });
    const checkpoint = new Promise<void>((resolve) => {
      allowCheckpoint = resolve;
    });
    let resumed = false;
    const running = withAgentShareControl(session, async () => {
      enterAgent();
      await checkpoint;
      await yieldOperateDriveToHuman(session);
      resumed = true;
    });
    await entered;
    const taken = waitForMessage(
      third,
      (message) => message.type === "control" && message.state === "human",
    );
    third.send(JSON.stringify({ type: "key", key: "Tab" }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(resumed).toBe(false);
    allowCheckpoint();
    await taken;
    expect(resumed).toBe(false);
    third.close();
    await new Promise<void>((resolve) => third.once("close", () => resolve()));
    await running;
    expect(resumed).toBe(true);

    // Exercise the served canvas client, not only the raw WebSocket protocol.
    const viewerPage = await browser.newPage();
    await viewerPage.goto(shared.url);
    await viewerPage.waitForFunction(() => {
      const canvas = document.querySelector("canvas");
      return canvas instanceof HTMLCanvasElement && canvas.width === 800 && canvas.height === 600;
    });
    if (process.env.OPERATE_SHARE_EVIDENCE_SCREENSHOT)
      await viewerPage.screenshot({ path: process.env.OPERATE_SHARE_EVIDENCE_SCREENSHOT });
    const canvasBox = await viewerPage.locator("canvas").boundingBox();
    if (canvasBox === null) throw new Error("viewer canvas unavailable");
    await viewerPage.mouse.click(
      canvasBox.x + x * canvasBox.width,
      canvasBox.y + y * canvasBox.height,
    );
    await page.waitForFunction(
      () => document.querySelector("#click")?.getAttribute("data-count") === "3",
    );
    await viewerPage.close();

    await finishProvisionSession(sessionId);
    sessionId = undefined;
    await expect(fetch(shared.url)).rejects.toThrow();
  }, 60_000);

  it("gives concurrent sessions different tokens and streams only their own page pixels", async () => {
    fixture = createServer((request, response) => {
      const color = request.url === "/red" ? "red" : request.url === "/green" ? "lime" : "blue";
      response.setHeader("Content-Type", "text/html");
      response.end(
        `<!doctype html><style>html,body{margin:0;background:${color}}</style><title>${color}</title>`,
      );
    });
    await new Promise<void>((resolve) => fixture!.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}`;
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 400, height: 300 } });
    const redPage = await context.newPage();
    const bluePage = await context.newPage();
    const redController = BrowserController.fromHarnessPage(redPage);
    const red = await startHarnessProvisionSession({
      serviceUrl: `${base}/red`,
      browser: redController,
      initialObservation: "drive",
    });
    sessionId = red.session_id;
    const blue = await startHarnessProvisionSession({
      serviceUrl: `${base}/blue`,
      browser: BrowserController.fromHarnessPage(bluePage),
      initialObservation: "drive",
    });
    secondSessionId = blue.session_id;
    const localTunnel = async (port: number) => ({
      url: `http://127.0.0.1:${port}`,
      close: async () => undefined,
    });
    const redShare = await shareOperateSession(paymentSession(sessionId), localTunnel);
    const blueShare = await shareOperateSession(paymentSession(secondSessionId), localTunnel);
    expect(redShare.url).not.toBe(blueShare.url);
    const redSocket = new WebSocket(new URL("stream", redShare.url));
    const blueSocket = new WebSocket(new URL("stream", blueShare.url));
    try {
      const [redFrame, blueFrame] = await Promise.all([
        waitForMessage(redSocket, (message) => message.type === "frame").catch(() => {
          throw new Error("red frame timed out");
        }),
        waitForMessage(blueSocket, (message) => message.type === "frame").catch(() => {
          throw new Error("blue frame timed out");
        }),
      ]);
      const sample = async (frame: Record<string, unknown>) => {
        const { data, info } = await sharp(Buffer.from(frame.data as string, "base64"))
          .raw()
          .toBuffer({ resolveWithObject: true });
        const offset =
          (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * info.channels;
        return [data[offset], data[offset + 1], data[offset + 2]];
      };
      const redPixel = await sample(redFrame);
      const bluePixel = await sample(blueFrame);
      expect(redPixel[0]).toBeGreaterThan(200);
      expect(redPixel[2]).toBeLessThan(80);
      expect(bluePixel[2]).toBeGreaterThan(100);
      expect(bluePixel[0]).toBeLessThan(80);

      const greenPage = await context.newPage();
      await greenPage.goto(`${base}/green`);
      const blank = waitForMessage(redSocket, (message) => message.type === "blank");
      redController.page = greenPage;
      await blank;
      const greenFrame = await waitForMessage(redSocket, (message) => message.type === "frame");
      const greenPixel = await sample(greenFrame);
      expect(greenPixel[1]).toBeGreaterThan(200);
      expect(greenPixel[0]).toBeLessThan(80);
    } finally {
      redSocket.close();
      blueSocket.close();
    }
  }, 60_000);
});
