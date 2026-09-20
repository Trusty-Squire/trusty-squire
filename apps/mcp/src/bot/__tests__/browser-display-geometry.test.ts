import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Fs from "node:fs";
import type * as BrowserProcessRuntime from "../browser-process-runtime.js";
import type * as OperatorBrowserWatchdog from "../operator-browser-watchdog.js";
import type * as RemoteLoginDisplay from "../remote-login-display.js";
import type { PageDriver } from "../page-driver.js";

const displayState = vi.hoisted(() => ({ present: false }));
vi.mock("../display-env.js", () => ({
  hasDisplay: () => displayState.present,
}));

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof Fs>();
  const isHelper = (path: unknown) =>
    typeof path === "string" && /\/(Xvfb|x11vnc|websockify|cloudflared)$/.test(path);
  return {
    ...fs,
    statSync: (path: Parameters<typeof fs.statSync>[0]) =>
      isHelper(path) ? { isFile: () => true } : fs.statSync(path),
    accessSync: (path: Parameters<typeof fs.accessSync>[0], mode?: number) =>
      isHelper(path) ? undefined : fs.accessSync(path, mode),
    existsSync: (path: Parameters<typeof fs.existsSync>[0]) =>
      path === "/usr/share/novnc" || fs.existsSync(path),
  };
});

vi.mock("../browser-process-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof BrowserProcessRuntime>()),
  detectChromiumChannel: vi.fn().mockResolvedValue(null),
  getChromium: () => {
    throw new Error("chromium launch boundary");
  },
}));
vi.mock("../operator-browser-watchdog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof OperatorBrowserWatchdog>()),
  startGlobalOperatorBrowserProcessWatchdog: vi.fn(),
}));
vi.mock("../remote-login-display.js", async (importOriginal) => ({
  ...(await importOriginal<typeof RemoteLoginDisplay>()),
  // Stop at the process boundary after the real rig factory has run.
  startRemoteLoginDisplay: vi.fn().mockRejectedValue(new Error("display startup boundary")),
  teardownRemoteLoginRig: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  displayState.present = false;
  vi.stubEnv("BOT_CDP_ENDPOINT", "");
  vi.stubEnv("BOT_NOVNC_W", "");
  vi.stubEnv("BOT_NOVNC_H", "");
  vi.stubEnv("TS_LOGIN_PUBLIC_HOSTNAME", "");
  vi.stubEnv("TS_LOGIN_LOCAL_PORT", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("browser display geometry", () => {
  it("starts the operator display at the operator window size", async () => {
    const { BrowserProcessOwner } = await import("../browser-process-owner.js");
    const { startRemoteLoginDisplay } = await import("../remote-login-display.js");
    const owner = new BrowserProcessOwner(
      { profileDir: "." },
      {} as PageDriver,
      async () => undefined,
    );

    await expect(owner.start()).rejects.toThrow("display startup boundary");
    expect(startRemoteLoginDisplay).toHaveBeenCalledWith(
      expect.objectContaining({ width: 1280, height: 1024 }),
    );
  });

  it("keeps Phone Connect rigs at the portrait defaults", async () => {
    const { createRemoteLoginRig } = await import("../remote-login-display.js");
    expect(createRemoteLoginRig()).toMatchObject({ width: 720, height: 1280 });
  });

  it("does not start Xvfb when the machine already has a screen", async () => {
    displayState.present = true;
    const { BrowserProcessOwner } = await import("../browser-process-owner.js");
    const { startRemoteLoginDisplay } = await import("../remote-login-display.js");
    const owner = new BrowserProcessOwner(
      { profileDir: "." },
      {} as PageDriver,
      async () => undefined,
    );

    await expect(owner.start()).rejects.toThrow("chromium launch boundary");
    expect(startRemoteLoginDisplay).not.toHaveBeenCalled();
  });
});
