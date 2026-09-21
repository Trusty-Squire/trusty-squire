// `hasDisplay` reads the host's shape; `hostDisplayAcceptsConnections` asks
// the named X display whether it is still there. A long-lived daemon outlives
// the X session that handed it a DISPLAY, and a headed launch against a dead
// one dies with "Missing X server or $DISPLAY" — so the launch decision has to
// be the live answer, while a screen that IS live must never be mistaken for a
// headless host and pushed onto an Xvfb.

import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:net";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import {
  displayProbeSocket,
  hasDisplay,
  hostDisplayAcceptsConnections,
  X11_SOCKET_DIR,
} from "../display-env.js";

const listening: Server[] = [];
const sockets: string[] = [];

afterEach(async () => {
  for (const server of listening.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const path of sockets.splice(0)) rmSync(path, { force: true });
});

// A display number nothing on this machine serves, so the probe has a real
// absent display to answer about.
function freeDisplayNumber(): number {
  for (let candidate = 4200; candidate < 4300; candidate += 1) {
    if (!existsSync(`${X11_SOCKET_DIR}/X${candidate}`)) return candidate;
  }
  throw new Error("no free X display number for the probe fixture");
}

async function serveDisplay(display: number): Promise<void> {
  mkdirSync(X11_SOCKET_DIR, { recursive: true });
  const path = `${X11_SOCKET_DIR}/X${display}`;
  const server = createServer((socket) => socket.end());
  listening.push(server);
  sockets.push(path);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
}

describe("display probe socket", () => {
  it("maps local display spellings to their X socket", () => {
    expect(displayProbeSocket(":0")).toBe(`${X11_SOCKET_DIR}/X0`);
    expect(displayProbeSocket(":12.0")).toBe(`${X11_SOCKET_DIR}/X12`);
    expect(displayProbeSocket("unix:3")).toBe(`${X11_SOCKET_DIR}/X3`);
  });

  it("names no socket for a remote or absent display", () => {
    expect(displayProbeSocket("somehost:0")).toBeNull();
    expect(displayProbeSocket(undefined)).toBeNull();
  });
});

describe("live display detection", () => {
  it("accepts a display that is actually serving", async () => {
    const display = freeDisplayNumber();
    await serveDisplay(display);
    const env = { DISPLAY: `:${display}`, XDG_SESSION_TYPE: "x11" };
    expect(hasDisplay("linux", env)).toBe(true);
    await expect(hostDisplayAcceptsConnections("linux", env)).resolves.toBe(true);
  });

  it("refuses a DISPLAY whose X session is gone", async () => {
    const env = { DISPLAY: `:${freeDisplayNumber()}`, XDG_SESSION_TYPE: "x11" };
    // The env still says "this host has a screen" — only asking the display
    // itself separates a live session from one that ended under a daemon.
    expect(hasDisplay("linux", env)).toBe(true);
    await expect(hostDisplayAcceptsConnections("linux", env)).resolves.toBe(false);
  });

  it("keeps a remote display spelling usable rather than reading it as headless", async () => {
    const env = { DISPLAY: "somehost:0", XDG_SESSION_TYPE: "x11" };
    await expect(hostDisplayAcceptsConnections("linux", env)).resolves.toBe(true);
  });

  it("answers for native windowing without probing, and for no DISPLAY at all", async () => {
    await expect(hostDisplayAcceptsConnections("darwin", {})).resolves.toBe(true);
    await expect(hostDisplayAcceptsConnections("win32", {})).resolves.toBe(true);
    await expect(hostDisplayAcceptsConnections("linux", {})).resolves.toBe(false);
  });
});
