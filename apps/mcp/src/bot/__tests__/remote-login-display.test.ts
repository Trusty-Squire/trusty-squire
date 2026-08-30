import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  fallbackCloudflaredArgs,
  registerRemoteLoginRigCleanup,
  remoteLoginInstallHint,
  resolveLoginBinary,
  startRemoteLoginDisplay,
  teardownRemoteLoginRig,
  type RemoteLoginRig,
} from "../remote-login-display.js";

function fakeProcess(name: string, ignoreSigterm = false): ChildProcess {
  const child = Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    stdout: { destroy: vi.fn() },
    stderr: { destroy: vi.fn() },
    unref: vi.fn(),
    spawnargs: [name],
    kill: vi.fn(),
  });
  child.kill.mockImplementation((signal: NodeJS.Signals = "SIGTERM") => {
    if (ignoreSigterm && signal === "SIGTERM") return true;
    child.exitCode = 0;
    child.signalCode = signal;
    queueMicrotask(() => child.emit("exit", null, signal));
    return true;
  });
  return child as unknown as ChildProcess;
}

function rigWithProcesses(ignoreSigterm = false): {
  rig: RemoteLoginRig;
  processes: ChildProcess[];
} {
  const processes = ["Xvfb", "x11vnc", "websockify", "cloudflared"].map((name) =>
    fakeProcess(name, ignoreSigterm),
  );
  return {
    rig: {
      display: ":99",
      width: 720,
      height: 1280,
      procs: processes,
      binaries: {
        xvfb: "/usr/bin/Xvfb",
        x11vnc: "/usr/bin/x11vnc",
        websockify: "/usr/bin/websockify",
        cloudflared: "/usr/bin/cloudflared",
      },
    },
    processes,
  };
}

function fakeExecutable(body: string): { path: string; remove(): void } {
  const dir = mkdtempSync(join(tmpdir(), "ts-remote-login-test-"));
  const path = join(dir, "fake-binary");
  writeFileSync(path, `#!${process.execPath}\n${body}\n`, { mode: 0o700 });
  chmodSync(path, 0o700);
  return { path, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

function emptyRig(xvfb: string): RemoteLoginRig {
  return {
    width: 720,
    height: 1280,
    procs: [],
    binaries: {
      xvfb,
      x11vnc: "/unused/x11vnc",
      websockify: "/unused/websockify",
    },
  };
}

describe("remote interactive login display", () => {
  it("tears down every per-login process exactly once", async () => {
    const { rig, processes } = rigWithProcesses();

    await teardownRemoteLoginRig(rig, 1);
    await teardownRemoteLoginRig(rig, 1);

    for (const child of processes) {
      expect(child.kill).toHaveBeenCalledOnce();
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(child.stdout?.destroy).toHaveBeenCalledOnce();
      expect(child.stderr?.destroy).toHaveBeenCalledOnce();
      expect(child.unref).toHaveBeenCalledOnce();
    }
  });

  it("escalates to SIGKILL when a login process ignores SIGTERM", async () => {
    const { rig, processes } = rigWithProcesses(true);

    await teardownRemoteLoginRig(rig, 1);

    for (const child of processes) {
      expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
      expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
    }
  });

  it("uses HTTP/2 for the ephemeral Cloudflare tunnel", () => {
    expect(fallbackCloudflaredArgs(4567)).toEqual([
      "tunnel",
      "--protocol",
      "http2",
      "--url",
      "http://127.0.0.1:4567",
    ]);
  });

  it("launches the resolved Xvfb and uses its atomic display allocation", async () => {
    const executable = fakeExecutable(`
const fs = require("node:fs");
const flag = process.argv.indexOf("-displayfd");
if (flag < 0) process.exit(21);
fs.writeSync(Number(process.argv[flag + 1]), "117\\n");
setInterval(() => undefined, 1000);
`);
    const rig = emptyRig(executable.path);
    try {
      await expect(startRemoteLoginDisplay(rig)).resolves.toBe(":117");
      expect(rig.display).toBe(":117");
      expect(rig.procs).toHaveLength(1);
    } finally {
      await teardownRemoteLoginRig(rig, 10);
      executable.remove();
    }
  });

  it("rejects when Xvfb exits before allocating its display", async () => {
    const executable = fakeExecutable("process.exit(23);");
    const rig = emptyRig(executable.path);
    try {
      await expect(startRemoteLoginDisplay(rig)).rejects.toThrow(
        "Xvfb exited before becoming ready (code 23)",
      );
    } finally {
      executable.remove();
    }
  });

  it("resolves an executable to the absolute path that will be spawned", () => {
    const executable = fakeExecutable("setInterval(() => undefined, 1000);");
    try {
      expect(
        resolveLoginBinary("fake-binary", {
          PATH: executable.path.replace(/\/[^/]+$/, ""),
        }),
      ).toBe(executable.path);
    } finally {
      executable.remove();
    }
  });

  it("provides actionable installation guidance for the login-only stack", () => {
    expect(remoteLoginInstallHint(["Xvfb", "x11vnc", "websockify"])).toContain(
      "sudo apt-get install -y xvfb x11vnc novnc websockify",
    );
    expect(remoteLoginInstallHint(["cloudflared"])).toContain(
      "github.com/cloudflare/cloudflared/releases/latest/download",
    );
  });

  it("lets the central server shutdown own signals while retaining an exit backstop", () => {
    const { rig } = rigWithProcesses();
    const handlers = new Map<string, (...args: never[]) => void>();
    const runtime = {
      on: vi.fn((event: string, listener: (...args: never[]) => void) => {
        handlers.set(event, listener);
        return runtime;
      }),
      once: vi.fn((event: string, listener: (...args: never[]) => void) => {
        handlers.set(event, listener);
        return runtime;
      }),
      removeListener: vi.fn((event: string) => {
        handlers.delete(event);
        return runtime;
      }),
      exit: vi.fn(),
    } as unknown as Parameters<typeof registerRemoteLoginRigCleanup>[2];
    const set = vi.fn();

    const remove = registerRemoteLoginRigCleanup(rig, () => undefined, runtime, {
      enabled: () => false,
      set,
    });

    expect(handlers.has("exit")).toBe(true);
    for (const event of ["SIGTERM", "SIGINT", "uncaughtException", "unhandledRejection"]) {
      expect(handlers.has(event)).toBe(false);
    }
    expect(set).not.toHaveBeenCalled();
    remove();
    expect(handlers.size).toBe(0);
  });
});
