import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  assertRemoteLoginRigLive,
  fallbackCloudflaredArgs,
  generateVncPassword,
  registerRemoteLoginRigCleanup,
  remoteLoginEnvironment,
  remoteLoginInstallHint,
  resolveLoginBinary,
  startRemoteLoginDisplay,
  teardownRemoteLoginRig,
  type RemoteLoginRig,
} from "../remote-login-display.js";
import { synchronizeSelfManagedChromeTerminationSignalHandlers } from "../browser.js";

function fakeProcess(name: string, ignoreSigterm = false): ChildProcess {
  const child = Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    stdout: { destroy: vi.fn() },
    stderr: { destroy: vi.fn() },
    unref: vi.fn(),
    spawnfile: name,
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

function decodeXauthority(path: string): {
  family: number;
  address: Buffer;
  display: Buffer;
  protocol: Buffer;
  credential: Buffer;
} {
  const contents = readFileSync(path);
  let offset = 0;
  const family = contents.readUInt16BE(offset);
  offset += 2;
  const field = (): Buffer => {
    const length = contents.readUInt16BE(offset);
    offset += 2;
    const value = contents.subarray(offset, offset + length);
    offset += length;
    return value;
  };
  return {
    family,
    address: field(),
    display: field(),
    protocol: field(),
    credential: field(),
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
if (!/^v1:/.test(process.env.TRUSTY_SQUIRE_OWNER_HELPER_MARKER || "")) process.exit(24);
if (process.argv.includes("-ac")) process.exit(20);
const authFlag = process.argv.indexOf("-auth");
if (authFlag < 0 || !fs.existsSync(process.argv[authFlag + 1])) process.exit(22);
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
      expect(rig.privateDir).toBeDefined();
      expect(rig.authFile).toBeDefined();
      expect(rig.passFile).toBeDefined();
      expect(rig.vncPassword).toBeDefined();
      expect(statSync(rig.privateDir!).mode & 0o777).toBe(0o700);
      expect(statSync(rig.authFile!).mode & 0o777).toBe(0o600);
      expect(statSync(rig.passFile!).mode & 0o777).toBe(0o600);
      expect(readFileSync(rig.passFile!, "utf8")).toBe(rig.vncPassword);
      expect(remoteLoginEnvironment(rig, { PATH: "/bin" })).toMatchObject({
        DISPLAY: ":117",
        XAUTHORITY: rig.authFile,
      });
      const authority = decodeXauthority(rig.authFile!);
      expect(authority.family).toBe(0xffff);
      expect(authority.address).toHaveLength(0);
      expect(authority.display).toHaveLength(0);
      expect(authority.protocol.toString("ascii")).toBe("MIT-MAGIC-COOKIE-1");
      expect(authority.credential).toHaveLength(16);
      const privateDir = rig.privateDir!;
      const authFile = rig.authFile!;
      const passFile = rig.passFile!;
      await teardownRemoteLoginRig(rig, 10);
      expect(existsSync(privateDir)).toBe(false);
      expect(existsSync(authFile)).toBe(false);
      expect(existsSync(passFile)).toBe(false);
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

  it("generates maximum-length URL-safe VNC passwords beyond hexadecimal", () => {
    const passwords = Array.from({ length: 64 }, () => generateVncPassword());
    expect(passwords.every((password) => /^[A-Za-z0-9_-]{8}$/.test(password))).toBe(true);
    expect(passwords.some((password) => /[^0-9a-f]/.test(password))).toBe(true);
  });

  it("reports helper failure after initial readiness", () => {
    const { rig, processes } = rigWithProcesses();
    Object.assign(processes[2]!, { exitCode: 17 });

    expect(() => assertRemoteLoginRigLive(rig)).toThrow(
      "remote login helper websockify exited (code 17)",
    );
  });

  it("maps non-Latin mobile input through the noVNC keysym lookup", async () => {
    const moduleUrl = new URL("../../../assets/login/vnc-input.js", import.meta.url);
    const input = (await import(moduleUrl.href)) as {
      sendTextAsKeysyms(
        rfb: { sendKey: (keysym: number, code: null, down: boolean) => void },
        value: string,
        keysyms: { lookup: (codePoint: number) => number },
      ): void;
    };
    const rfb = { sendKey: vi.fn() };
    const keysyms = { lookup: vi.fn((codePoint: number) => 0x01000000 | codePoint) };

    input.sendTextAsKeysyms(rfb, "你😀", keysyms);

    expect(keysyms.lookup.mock.calls).toEqual([[0x4f60], [0x1f600]]);
    expect(rfb.sendKey.mock.calls).toEqual([
      [0x01004f60, null, true],
      [0x01004f60, null, false],
      [0x0101f600, null, true],
      [0x0101f600, null, false],
    ]);
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
    } as unknown as NonNullable<Parameters<typeof registerRemoteLoginRigCleanup>[2]>;
    const set = vi.fn();

    const remove = registerRemoteLoginRigCleanup(rig, () => undefined, runtime, {
      enabled: () => false,
      set,
    });

    expect(handlers.has("exit")).toBe(true);
    for (const event of [
      "SIGHUP",
      "SIGTERM",
      "SIGINT",
      "uncaughtException",
      "unhandledRejection",
    ]) {
      expect(handlers.has(event)).toBe(false);
    }
    expect(set).not.toHaveBeenCalled();
    remove();
    expect(handlers.size).toBe(0);
  });

  it("suspends every self-managed Chrome termination signal together", () => {
    const runtime = new EventEmitter();

    synchronizeSelfManagedChromeTerminationSignalHandlers(
      true,
      runtime as unknown as Pick<NodeJS.Process, "once" | "removeListener">,
    );
    expect(runtime.listenerCount("SIGHUP")).toBe(1);
    expect(runtime.listenerCount("SIGTERM")).toBe(1);
    expect(runtime.listenerCount("SIGINT")).toBe(1);

    synchronizeSelfManagedChromeTerminationSignalHandlers(
      false,
      runtime as unknown as Pick<NodeJS.Process, "once" | "removeListener">,
    );
    expect(runtime.listenerCount("SIGHUP")).toBe(0);
    expect(runtime.listenerCount("SIGTERM")).toBe(0);
    expect(runtime.listenerCount("SIGINT")).toBe(0);
  });

  it("tears down the login rig before exiting on SSH hangup", async () => {
    const { rig, processes } = rigWithProcesses();
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
    } as unknown as NonNullable<Parameters<typeof registerRemoteLoginRigCleanup>[2]>;
    const set = vi.fn();

    registerRemoteLoginRigCleanup(rig, () => undefined, runtime, {
      enabled: () => true,
      set,
    });
    handlers.get("SIGHUP")!();

    await vi.waitFor(() => expect(runtime.exit).toHaveBeenCalledWith(129));
    for (const child of processes) {
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    }
    expect(set).toHaveBeenNthCalledWith(1, false);
    expect(set).toHaveBeenLastCalledWith(true);
  });
});
