import { EventEmitter } from "node:events";
import { createServer } from "node:net";
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

// CI does not install noVNC. Supply only the two core assets the login bridge
// validates so these process-lifecycle tests remain independent of that host
// package while exercising the real bridge setup.
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  const path = await import("node:path");
  return {
    ...fs,
    cpSync: (...args: Parameters<typeof fs.cpSync>) => {
      const [source, destination] = args;
      if (source !== "/usr/share/novnc") return fs.cpSync(...args);
      if (typeof destination !== "string") throw new Error("expected a string noVNC destination");
      fs.mkdirSync(path.join(destination, "core", "input"), { recursive: true });
      fs.writeFileSync(path.join(destination, "core", "rfb.js"), "");
      fs.writeFileSync(path.join(destination, "core", "input", "keysymdef.js"), "");
    },
  };
});

import {
  assertRemoteLoginRigLive,
  describeLoginPortHolder,
  exposeRemoteLoginDisplay,
  fallbackCloudflaredArgs,
  findFreeLoginPort,
  generateVncPassword,
  loginPortAvailable,
  planLoginTunnel,
  registerRemoteLoginRigCleanup,
  remoteLoginEnvironment,
  remoteLoginInstallHint,
  resolveLoginBinary,
  startRemoteLoginDisplay,
  teardownRemoteLoginRig,
  type RemoteLoginRig,
} from "../remote-login-display.js";
import { synchronizeSelfManagedChromeTerminationSignalHandlers } from "../browser.js";
import { spawnOwnerTrackedHelper } from "../owner-process-reaper.js";

function processIsLive(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const closeParen = stat.lastIndexOf(")");
    return (
      closeParen >= 0 &&
      stat
        .slice(closeParen + 2)
        .trim()
        .split(/\s+/)[0] !== "Z"
    );
  } catch {
    return false;
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  if (!predicate()) throw new Error("condition did not become true");
}

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

  it("reaps a marked helper group after its original leader exits", async () => {
    if (process.platform !== "linux") return;
    const dir = mkdtempSync(join(tmpdir(), "ts-remote-login-group-"));
    const childFile = join(dir, "child.pid");
    const leader = spawnOwnerTrackedHelper(
      process.execPath,
      [
        "-e",
        `const { spawn } = require("node:child_process"); const { writeFileSync } = require("node:fs"); const child = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], { stdio: "ignore" }); child.unref(); writeFileSync(${JSON.stringify(childFile)}, String(child.pid));`,
      ],
      { stdio: "ignore" },
    );
    const leaderPid = leader.pid;
    if (leaderPid === undefined) throw new Error("helper leader did not expose a pid");
    let childPid = 0;
    const rig: RemoteLoginRig = {
      display: ":99",
      width: 720,
      height: 1280,
      procs: [leader],
      binaries: {
        xvfb: "/unused/Xvfb",
        x11vnc: "/unused/x11vnc",
        websockify: "/unused/websockify",
      },
    };
    try {
      await waitUntil(() => existsSync(childFile));
      childPid = Number(readFileSync(childFile, "utf8"));
      await waitUntil(() => leader.exitCode !== null || leader.signalCode !== null);
      expect(processIsLive(childPid)).toBe(true);

      await teardownRemoteLoginRig(rig, 50);
      await waitUntil(() => !processIsLive(childPid));

      expect(processIsLive(childPid)).toBe(false);
    } finally {
      try {
        process.kill(-leaderPid, "SIGKILL");
      } catch {}
      rmSync(dir, { recursive: true, force: true });
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

  it("gives a headed Chrome child a display when the parent has none", async () => {
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
      const parentEnv: NodeJS.ProcessEnv = { PATH: "/bin" };
      expect(parentEnv.DISPLAY).toBeUndefined();
      expect(remoteLoginEnvironment(rig, parentEnv)).toMatchObject({
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

  it("detects a login port already held by another listener", async () => {
    const free = await findFreeLoginPort();
    expect(await loginPortAvailable(free)).toBe(true);

    const squatter = createServer();
    await new Promise<void>((resolve) => squatter.listen(free, "127.0.0.1", resolve));
    try {
      expect(await loginPortAvailable(free)).toBe(false);
    } finally {
      await new Promise<void>((resolve) => squatter.close(() => resolve()));
    }
  });

  it("names the process holding a busy login port", () => {
    const ss = [
      "State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process",
      'LISTEN 0      4096       127.0.0.1:47823        0.0.0.0:*     users:(("docker-proxy",pid=1234,fd=4))',
      'LISTEN 0      4096       127.0.0.1:8080         0.0.0.0:*     users:(("node",pid=99,fd=20))',
    ].join("\n");

    expect(describeLoginPortHolder(47823, () => ss)).toBe('"docker-proxy",pid=1234,fd=4');
    expect(describeLoginPortHolder(47000, () => ss)).toBeNull();
    expect(describeLoginPortHolder(47823, () => null)).toBeNull();
  });

  it("keeps the named tunnel when its fixed local port is free", () => {
    const resolveCloudflared = vi.fn(() => "/usr/bin/cloudflared");
    expect(
      planLoginTunnel({
        namedTunnel: { hostname: "vnc.example.test", port: 47823 },
        namedPortAvailable: true,
        resolveCloudflared,
        describePortHolder: () => null,
      }),
    ).toEqual({ mode: "named", hostname: "vnc.example.test", port: 47823 });
    expect(resolveCloudflared).not.toHaveBeenCalled();
  });

  it("falls back to a quick tunnel when the fixed login port is taken", () => {
    const plan = planLoginTunnel({
      namedTunnel: { hostname: "vnc.example.test", port: 47823 },
      namedPortAvailable: false,
      resolveCloudflared: () => "/usr/bin/cloudflared",
      describePortHolder: () => '"docker-proxy",pid=1234,fd=4',
    });

    expect(plan.mode).toBe("quick");
    expect(plan).toMatchObject({ cloudflared: "/usr/bin/cloudflared" });
    expect(plan.mode === "quick" ? plan.fallbackNotice : "").toContain("127.0.0.1:47823");
    expect(plan.mode === "quick" ? plan.fallbackNotice : "").toContain("docker-proxy");
    expect(plan.mode === "quick" ? plan.fallbackNotice : "").toContain("one-off Cloudflare tunnel");
  });

  it("serves a one-off tunnel and tears down its helpers when the named port is occupied", async () => {
    const namedPort = await findFreeLoginPort();
    const squatter = createServer();
    const secrets = mkdtempSync(join(tmpdir(), "ts-remote-login-fallback-"));
    const x11vnc = fakeExecutable(`
const { createServer } = require("node:net");
const port = Number(process.argv[process.argv.indexOf("-rfbport") + 1]);
const server = createServer();
server.listen(port, "127.0.0.1");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`);
    const websockify = fakeExecutable(`
const { createServer } = require("node:net");
const target = process.argv.find((arg) => /^127\\.0\\.0\\.1:\\d+$/.test(arg));
const port = Number(target.slice(target.lastIndexOf(":") + 1));
const server = createServer();
server.listen(port, "127.0.0.1");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`);
    const cloudflared = fakeExecutable(`
process.stdout.write("https://fallback-proof.trycloudflare.com\\n");
setInterval(() => undefined, 1000);
`);
    const oldHostname = process.env.TS_LOGIN_PUBLIC_HOSTNAME;
    const oldPort = process.env.TS_LOGIN_LOCAL_PORT;
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const rig: RemoteLoginRig = {
      display: ":99",
      width: 720,
      height: 1280,
      privateDir: secrets,
      authFile: join(secrets, "Xauthority"),
      passFile: join(secrets, "vnc-password"),
      vncPassword: "test-password",
      procs: [],
      binaries: {
        xvfb: "/unused/Xvfb",
        x11vnc: x11vnc.path,
        websockify: websockify.path,
        cloudflared: cloudflared.path,
      },
    };
    writeFileSync(rig.authFile!, "test-xauthority", { mode: 0o600 });
    writeFileSync(rig.passFile!, rig.vncPassword!, { mode: 0o600 });
    try {
      await new Promise<void>((resolve) => squatter.listen(namedPort, "127.0.0.1", resolve));
      process.env.TS_LOGIN_PUBLIC_HOSTNAME = "vnc.example.test";
      process.env.TS_LOGIN_LOCAL_PORT = String(namedPort);

      await expect(exposeRemoteLoginDisplay(rig, "fallback proof")).resolves.toBe(
        "https://fallback-proof.trycloudflare.com/#p=test-password",
      );
      expect(log.mock.calls.flat().join("\n")).toContain("one-off Cloudflare tunnel");
      expect(rig.procs).toHaveLength(3);
      const helperPids = rig.procs.map((child) => child.pid).filter((pid): pid is number => pid !== undefined);

      await teardownRemoteLoginRig(rig, 50);
      expect(rig.webDir).toBeUndefined();
      await waitUntil(() => helperPids.every((pid) => !processIsLive(pid)));
      expect(helperPids.every((pid) => !processIsLive(pid))).toBe(true);
    } finally {
      await teardownRemoteLoginRig(rig, 50);
      await new Promise<void>((resolve) => squatter.close(() => resolve()));
      if (oldHostname === undefined) delete process.env.TS_LOGIN_PUBLIC_HOSTNAME;
      else process.env.TS_LOGIN_PUBLIC_HOSTNAME = oldHostname;
      if (oldPort === undefined) delete process.env.TS_LOGIN_LOCAL_PORT;
      else process.env.TS_LOGIN_LOCAL_PORT = oldPort;
      log.mockRestore();
      x11vnc.remove();
      websockify.remove();
      cloudflared.remove();
    }
  });

  it("names the busy port and its holder when no quick-tunnel fallback exists", () => {
    expect(() =>
      planLoginTunnel({
        namedTunnel: { hostname: "vnc.example.test", port: 47823 },
        namedPortAvailable: false,
        resolveCloudflared: () => null,
        describePortHolder: () => '"docker-proxy",pid=1234,fd=4',
      }),
    ).toThrow(/127\.0\.0\.1:47823 \(TS_LOGIN_LOCAL_PORT\) is already in use by "docker-proxy"/);
  });

  it("surfaces a helper's own stderr when it dies", async () => {
    const executable = fakeExecutable(`
process.stderr.write("OSError: [Errno 98] Address already in use\\n");
process.exit(1);
`);
    const rig = emptyRig(executable.path);
    try {
      await expect(startRemoteLoginDisplay(rig)).rejects.toThrow(
        /Xvfb exited before becoming ready \(code 1\)[\s\S]*Errno 98/,
      );
    } finally {
      executable.remove();
    }
  });

  it("reaps started login helpers and noVNC files after websockify reports its bind failure", async () => {
    const secrets = mkdtempSync(join(tmpdir(), "ts-remote-login-websockify-failure-"));
    const x11vncPidFile = join(secrets, "x11vnc.pid");
    const x11vnc = fakeExecutable(`
const { createServer } = require("node:net"); const { writeFileSync } = require("node:fs");
const port = Number(process.argv[process.argv.indexOf("-rfbport") + 1]);
const server = createServer();
server.listen(port, "127.0.0.1", () => writeFileSync(${JSON.stringify(x11vncPidFile)}, String(process.pid)));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`);
    const websockify = fakeExecutable(`
process.stderr.write("OSError: [Errno 98] Address already in use\\n");
process.exit(1);
`);
    const cloudflared = fakeExecutable("setInterval(() => undefined, 1000);");
    const oldHostname = process.env.TS_LOGIN_PUBLIC_HOSTNAME;
    const oldPort = process.env.TS_LOGIN_LOCAL_PORT;
    const rig: RemoteLoginRig = {
      display: ":99",
      width: 720,
      height: 1280,
      privateDir: secrets,
      authFile: join(secrets, "Xauthority"),
      passFile: join(secrets, "vnc-password"),
      vncPassword: "test-password",
      procs: [],
      binaries: {
        xvfb: "/unused/Xvfb",
        x11vnc: x11vnc.path,
        websockify: websockify.path,
        cloudflared: cloudflared.path,
      },
    };
    writeFileSync(rig.authFile!, "test-xauthority", { mode: 0o600 });
    writeFileSync(rig.passFile!, rig.vncPassword!, { mode: 0o600 });
    try {
      delete process.env.TS_LOGIN_PUBLIC_HOSTNAME;
      delete process.env.TS_LOGIN_LOCAL_PORT;

      await expect(exposeRemoteLoginDisplay(rig, "failure proof")).rejects.toThrow(
        /websockify exited before becoming ready \(code 1\)[\s\S]*Errno 98/,
      );
      const x11vncPid = Number(readFileSync(x11vncPidFile, "utf8"));
      await waitUntil(() => !processIsLive(x11vncPid));
      expect(rig.procs).toHaveLength(0);
      expect(rig.webDir).toBeUndefined();
      expect(processIsLive(x11vncPid)).toBe(false);
    } finally {
      await teardownRemoteLoginRig(rig, 50);
      if (oldHostname === undefined) delete process.env.TS_LOGIN_PUBLIC_HOSTNAME;
      else process.env.TS_LOGIN_PUBLIC_HOSTNAME = oldHostname;
      if (oldPort === undefined) delete process.env.TS_LOGIN_LOCAL_PORT;
      else process.env.TS_LOGIN_LOCAL_PORT = oldPort;
      x11vnc.remove();
      websockify.remove();
      cloudflared.remove();
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
