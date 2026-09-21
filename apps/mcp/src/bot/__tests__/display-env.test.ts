// `hasDisplay` reads the host's shape; `hostDisplayAcceptsConnections` asks
// the named X display whether it is still there. A long-lived daemon outlives
// the X session that handed it a DISPLAY, and a headed launch against a dead
// one dies with "Missing X server or $DISPLAY" — so the launch decision has to
// be the live answer, while a screen that IS live must never be mistaken for a
// headless host and pushed onto an Xvfb.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  displayProbeSocket,
  hasDisplay,
  hostDisplayAcceptsConnections,
  X11_SOCKET_DIR,
} from "../display-env.js";

// The fixture serves its displays out of its own directory: /tmp/.X11-unix is
// shared system state every X server on the box uses, and a crashed run must
// not leave sockets — or a directory it created with the wrong ownership —
// behind there.
let socketDir: string;
const listening: Server[] = [];

beforeEach(() => {
  socketDir = mkdtempSync(join(tmpdir(), "ts-display-probe-"));
});

afterEach(async () => {
  for (const server of listening.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(socketDir, { recursive: true, force: true });
});

async function serveDisplay(display: number): Promise<void> {
  const server = createServer((socket) => socket.end());
  listening.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(`${socketDir}/X${display}`, resolve);
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
    await serveDisplay(7);
    const env = { DISPLAY: ":7", XDG_SESSION_TYPE: "x11" };
    expect(hasDisplay("linux", env)).toBe(true);
    await expect(hostDisplayAcceptsConnections("linux", env, socketDir)).resolves.toBe(true);
  });

  it("refuses a DISPLAY whose X session is gone", async () => {
    const env = { DISPLAY: ":7", XDG_SESSION_TYPE: "x11" };
    // The env still says "this host has a screen" — only asking the display
    // itself separates a live session from one that ended under a daemon.
    expect(hasDisplay("linux", env)).toBe(true);
    await expect(hostDisplayAcceptsConnections("linux", env, socketDir)).resolves.toBe(false);
  });

  it("keeps a remote display spelling usable rather than reading it as headless", async () => {
    const env = { DISPLAY: "somehost:0", XDG_SESSION_TYPE: "x11" };
    await expect(hostDisplayAcceptsConnections("linux", env, socketDir)).resolves.toBe(true);
  });

  it("answers for native windowing without probing, and for no DISPLAY at all", async () => {
    await expect(hostDisplayAcceptsConnections("darwin", {}, socketDir)).resolves.toBe(true);
    await expect(hostDisplayAcceptsConnections("win32", {}, socketDir)).resolves.toBe(true);
    await expect(hostDisplayAcceptsConnections("linux", {}, socketDir)).resolves.toBe(false);
  });
});
