// Login-only virtual display + noVNC bridge.
//
// This module is deliberately not used by BrowserController. Automated operator
// sessions stay on Chrome's new-headless path; only interactive login/connect
// calls start this stack, and every process is torn down with that login.

import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import boxen from "boxen";
import chalk from "chalk";
import {
  isSelfManagedChromeTerminationSignalExitEnabled,
  setSelfManagedChromeTerminationSignalExitEnabled,
} from "./browser.js";

const LOGIN_WIDTH = Number(process.env.BOT_NOVNC_W) || 720;
const LOGIN_HEIGHT = Number(process.env.BOT_NOVNC_H) || 1280;
const NOVNC_INSTALL_DIR = "/usr/share/novnc";

export interface RemoteLoginRig {
  display?: string;
  width: number;
  height: number;
  procs: ChildProcess[];
  binaries: RemoteLoginBinaries;
  privateDir?: string;
  authFile?: string;
  webDir?: string;
  passFile?: string;
  vncPassword?: string;
}

export interface RemoteLoginBinaries {
  xvfb: string;
  x11vnc: string;
  websockify: string;
  cloudflared?: string;
}

function loginAssetPath(name: string): string {
  return fileURLToPath(new URL(`../../assets/login/${name}`, import.meta.url));
}

function encodeXauthorityField(value: Buffer): Buffer {
  const length = Buffer.allocUnsafe(2);
  length.writeUInt16BE(value.length);
  return Buffer.concat([length, value]);
}

function createRemoteLoginXauthority(privateDir: string): string {
  const familyWild = Buffer.allocUnsafe(2);
  familyWild.writeUInt16BE(0xffff);
  const authFile = join(privateDir, "xauthority");
  const contents = Buffer.concat([
    familyWild,
    encodeXauthorityField(Buffer.alloc(0)),
    encodeXauthorityField(Buffer.alloc(0)),
    encodeXauthorityField(Buffer.from("MIT-MAGIC-COOKIE-1", "ascii")),
    encodeXauthorityField(randomBytes(16)),
  ]);
  writeFileSync(authFile, contents, { flag: "wx", mode: 0o600 });
  chmodSync(authFile, 0o600);
  return authFile;
}

function createRemoteLoginSecrets(rig: RemoteLoginRig): void {
  const privateDir = mkdtempSync(join(tmpdir(), "tsq-login-"));
  chmodSync(privateDir, 0o700);
  rig.privateDir = privateDir;
  try {
    rig.authFile = createRemoteLoginXauthority(privateDir);
    rig.vncPassword = generateVncPassword();
    rig.passFile = join(privateDir, "vnc.pass");
    writeFileSync(rig.passFile, rig.vncPassword, { flag: "wx", mode: 0o600 });
    chmodSync(rig.passFile, 0o600);
  } catch (error) {
    rmSync(privateDir, { recursive: true, force: true });
    delete rig.privateDir;
    delete rig.authFile;
    delete rig.passFile;
    delete rig.vncPassword;
    throw error;
  }
}

export function remoteLoginEnvironment(
  rig: RemoteLoginRig,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  if (rig.display === undefined || rig.authFile === undefined) {
    throw new Error("remote login display authorization is not ready");
  }
  return { ...baseEnv, DISPLAY: rig.display, XAUTHORITY: rig.authFile };
}

export function findFreeLoginPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("could not resolve a free port"));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

const STANDARD_BIN_DIRS = [
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/local/sbin",
  "/usr/sbin",
  "/sbin",
] as const;

export function resolveLoginBinary(
  binary: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const dirs = [...(env.PATH ?? "").split(delimiter), ...STANDARD_BIN_DIRS];
  for (const dir of dirs) {
    if (dir.length === 0) continue;
    const candidate = resolve(dir, binary);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

export function loginBinaryAvailable(binary: string): boolean {
  return resolveLoginBinary(binary) !== null;
}

function cloudflaredDebArch(): string {
  switch (process.arch) {
    case "arm64":
      return "arm64";
    case "arm":
      return "arm";
    case "ia32":
      return "386";
    default:
      return "amd64";
  }
}

export function remoteLoginInstallHint(missing: readonly string[]): string {
  const aptPackages = missing.flatMap((binary) => {
    if (binary === "Xvfb") return ["xvfb"];
    if (binary === "x11vnc") return ["x11vnc"];
    if (binary === "websockify") return ["novnc", "websockify"];
    return [];
  });
  const lines: string[] = [];
  if (aptPackages.length > 0) {
    lines.push(`On Debian/Ubuntu: sudo apt-get install -y ${aptPackages.join(" ")}`);
  }
  if (missing.includes("cloudflared")) {
    lines.push(
      "cloudflared is not in Debian/Ubuntu repos — install its package: " +
        `curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${cloudflaredDebArch()}.deb ` +
        "-o /tmp/cloudflared.deb && sudo dpkg -i /tmp/cloudflared.deb",
    );
  }
  return lines.join("\n");
}

function namedTunnelConfig(): { hostname: string; port: number } | null {
  const hostname = process.env.TS_LOGIN_PUBLIC_HOSTNAME?.trim();
  const rawPort = process.env.TS_LOGIN_LOCAL_PORT?.trim();
  if (hostname === undefined || hostname === "" || rawPort === undefined || rawPort === "") {
    return null;
  }
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`TS_LOGIN_LOCAL_PORT=${JSON.stringify(rawPort)} is not a valid port number`);
  }
  return { hostname, port };
}

function requireRemoteLoginBinaries(namedTunnel: boolean): RemoteLoginBinaries {
  const required = [
    "Xvfb",
    "x11vnc",
    "websockify",
    ...(namedTunnel ? [] : ["cloudflared"]),
  ] as const;
  const resolved = new Map(required.map((binary) => [binary, resolveLoginBinary(binary)]));
  const missing = required.filter((binary) => resolved.get(binary) === null);
  if (missing.length > 0) {
    throw new Error(
      `headless login needs these not-installed binaries: ${missing.join(", ")}.\n` +
        remoteLoginInstallHint(missing),
    );
  }
  if (!existsSync(NOVNC_INSTALL_DIR)) {
    throw new Error("noVNC web assets not found at /usr/share/novnc — install the `novnc` package");
  }
  return {
    xvfb: resolved.get("Xvfb")!,
    x11vnc: resolved.get("x11vnc")!,
    websockify: resolved.get("websockify")!,
    ...(namedTunnel ? {} : { cloudflared: resolved.get("cloudflared")! }),
  };
}

function spawnBackground(command: string, args: string[], env?: NodeJS.ProcessEnv): ChildProcess {
  return spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: env ?? process.env,
  });
}

function waitForTunnelUrl(cloudflared: ChildProcess, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let output = "";
    const finish = (error: Error | null, url?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cloudflared.removeListener("error", onError);
      cloudflared.removeListener("exit", onExit);
      cloudflared.stdout?.removeListener("data", scan);
      cloudflared.stderr?.removeListener("data", scan);
      if (error !== null) reject(error);
      else resolve(url!);
    };
    const onError = (error: Error): void =>
      finish(new Error(`cloudflared failed to spawn: ${error.message}`));
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void =>
      finish(
        new Error(
          `cloudflared exited before producing a URL (${code === null ? `signal ${signal ?? "unknown"}` : `code ${code}`})`,
        ),
      );
    const scan = (chunk: Buffer): void => {
      output += chunk.toString();
      const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (match !== null) {
        finish(null, match[0]);
      }
      if (output.length > 65_536) output = output.slice(-4_096);
    };
    const timer = setTimeout(
      () => finish(new Error("cloudflared did not produce a URL in time")),
      timeoutMs,
    );
    cloudflared.once("error", onError);
    cloudflared.once("exit", onExit);
    if (childExited(cloudflared)) {
      onExit(cloudflared.exitCode, cloudflared.signalCode);
      return;
    }
    cloudflared.stdout?.on("data", scan);
    cloudflared.stderr?.on("data", scan);
  });
}

function waitForXvfbDisplay(xvfb: ChildProcess, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const displayOutput = xvfb.stdio[3];
    if (
      displayOutput === undefined ||
      displayOutput === null ||
      typeof displayOutput.on !== "function"
    ) {
      reject(new Error("Xvfb display allocation pipe is unavailable"));
      return;
    }
    let settled = false;
    let output = "";
    const finish = (error: Error | null, display?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      xvfb.removeListener("error", onError);
      xvfb.removeListener("exit", onExit);
      displayOutput.removeListener("data", onData);
      if (error !== null) reject(error);
      else resolve(display!);
    };
    const onError = (error: Error): void =>
      finish(new Error(`Xvfb failed to spawn: ${error.message}`));
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void =>
      finish(
        new Error(
          `Xvfb exited before becoming ready (${code === null ? `signal ${signal ?? "unknown"}` : `code ${code}`})`,
        ),
      );
    const onData = (chunk: Buffer): void => {
      output += chunk.toString();
      const match = output.match(/^(\d+)\s/);
      if (match === null) return;
      const displayNumber = Number(match[1]);
      if (!Number.isInteger(displayNumber) || displayNumber < 0) {
        finish(new Error(`Xvfb returned an invalid display number: ${JSON.stringify(match[1])}`));
        return;
      }
      if (childExited(xvfb)) {
        onExit(xvfb.exitCode, xvfb.signalCode);
        return;
      }
      finish(null, `:${displayNumber}`);
    };
    const timer = setTimeout(
      () => finish(new Error("Xvfb did not allocate a display in time")),
      timeoutMs,
    );
    xvfb.once("error", onError);
    xvfb.once("exit", onExit);
    if (childExited(xvfb)) {
      onExit(xvfb.exitCode, xvfb.signalCode);
      return;
    }
    displayOutput.on("data", onData);
  });
}

function waitForListeningPort(
  child: ChildProcess,
  port: number,
  label: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    let settled = false;
    let retryTimer: NodeJS.Timeout | undefined;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      if (error !== undefined) reject(error);
      else resolve();
    };
    const onError = (error: Error): void =>
      finish(new Error(`${label} failed to spawn: ${error.message}`));
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void =>
      finish(
        new Error(
          `${label} exited before becoming ready (${code === null ? `signal ${signal ?? "unknown"}` : `code ${code}`})`,
        ),
      );
    const probe = (): void => {
      if (settled) return;
      if (childExited(child)) {
        onExit(child.exitCode, child.signalCode);
        return;
      }
      if (Date.now() >= deadline) {
        finish(new Error(`${label} did not listen on 127.0.0.1:${port} in time`));
        return;
      }
      const socket = createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        retryTimer = setTimeout(() => {
          if (childExited(child)) onExit(child.exitCode, child.signalCode);
          else finish();
        }, 100);
      });
      socket.once("error", () => {
        socket.destroy();
        retryTimer = setTimeout(probe, 50);
      });
    };
    child.once("error", onError);
    child.once("exit", onExit);
    probe();
  });
}

export function fallbackCloudflaredArgs(webPort: number): string[] {
  return ["tunnel", "--protocol", "http2", "--url", `http://127.0.0.1:${webPort}`];
}

function buildVncWebDir(): string {
  const webDir = mkdtempSync(join(tmpdir(), "ts-novnc-"));
  cpSync(NOVNC_INSTALL_DIR, webDir, { recursive: true });
  const requiredCoreAssets = [
    join(webDir, "core", "rfb.js"),
    join(webDir, "core", "input", "keysymdef.js"),
  ];
  if (requiredCoreAssets.some((path) => !existsSync(path))) {
    rmSync(webDir, { recursive: true, force: true });
    throw new Error(
      `noVNC core assets not found under ${NOVNC_INSTALL_DIR}/core — the installed novnc package has an unexpected layout`,
    );
  }
  const brandedPage = readFileSync(loginAssetPath("vnc.html"), "utf8");
  writeFileSync(join(webDir, "vnc.html"), brandedPage);
  writeFileSync(join(webDir, "index.html"), brandedPage);
  cpSync(loginAssetPath("vnc-input.js"), join(webDir, "vnc-input.js"));
  return webDir;
}

export function createRemoteLoginRig(): RemoteLoginRig {
  const namedTunnel = namedTunnelConfig();
  const binaries = requireRemoteLoginBinaries(namedTunnel !== null);
  return {
    width: LOGIN_WIDTH,
    height: LOGIN_HEIGHT,
    procs: [],
    binaries,
  };
}

export async function startRemoteLoginDisplay(rig: RemoteLoginRig): Promise<string> {
  try {
    createRemoteLoginSecrets(rig);
    const authFile = rig.authFile!;
    const xvfb = spawn(
      rig.binaries.xvfb,
      ["-screen", "0", `${rig.width}x${rig.height}x24`, "-auth", authFile, "-displayfd", "3"],
      {
        stdio: ["ignore", "pipe", "pipe", "pipe"],
        env: process.env,
      },
    );
    rig.procs.push(xvfb);
    rig.display = await waitForXvfbDisplay(xvfb, 5_000);
    return rig.display;
  } catch (error) {
    await teardownRemoteLoginRig(rig);
    throw error;
  }
}

export function generateVncPassword(): string {
  return randomBytes(6).toString("base64url");
}

export async function exposeRemoteLoginDisplay(
  rig: RemoteLoginRig,
  label: string,
): Promise<string> {
  if (rig.display === undefined) {
    throw new Error("remote login display has not been started");
  }
  const namedTunnel = namedTunnelConfig();
  const vncPort = await findFreeLoginPort();
  const webPort = namedTunnel?.port ?? (await findFreeLoginPort());
  const password = rig.vncPassword;
  const passFile = rig.passFile;
  if (password === undefined || passFile === undefined) {
    throw new Error("remote login VNC credentials are not ready");
  }
  const x11vnc = spawnBackground(
    rig.binaries.x11vnc,
    [
      "-display",
      rig.display,
      "-rfbport",
      String(vncPort),
      "-passwdfile",
      `rm:${passFile}`,
      "-localhost",
      "-forever",
      "-shared",
      "-noshm",
      "-quiet",
    ],
    remoteLoginEnvironment(rig),
  );
  rig.procs.push(x11vnc);
  await waitForListeningPort(x11vnc, vncPort, "x11vnc", 5_000);

  rig.webDir = buildVncWebDir();
  const websockify = spawnBackground(rig.binaries.websockify, [
    `--web=${rig.webDir}`,
    `127.0.0.1:${webPort}`,
    `localhost:${vncPort}`,
  ]);
  rig.procs.push(websockify);
  await waitForListeningPort(websockify, webPort, "websockify", 5_000);

  let publicUrl: string;
  if (namedTunnel !== null) {
    publicUrl = `https://${namedTunnel.hostname}/#p=${password}`;
  } else {
    const cloudflaredBinary = rig.binaries.cloudflared;
    if (cloudflaredBinary === undefined) {
      throw new Error("cloudflared was not resolved for the per-login quick tunnel");
    }
    const cloudflared = spawnBackground(cloudflaredBinary, fallbackCloudflaredArgs(webPort));
    rig.procs.push(cloudflared);
    const tunnelUrl = await waitForTunnelUrl(cloudflared, 30_000);
    publicUrl = `${tunnelUrl}/#p=${password}`;
  }

  printRemoteLoginBanner({ publicUrl, password, label });
  return publicUrl;
}

function printRemoteLoginBanner(opts: {
  publicUrl: string;
  password: string;
  label: string;
}): void {
  const width = Math.max(40, Math.min((process.stdout.columns ?? 80) - 2, 78));
  const styledUrl = process.stderr.isTTY
    ? `\x1b]8;;${opts.publicUrl}\x1b\\${chalk.hex("#cf3a52").underline(opts.publicUrl)}\x1b]8;;\x1b\\`
    : opts.publicUrl;
  const body =
    `Open this on any device, any network:\n\n` +
    `  ${styledUrl}\n\n` +
    `If asked for a VNC password:  ${chalk.bold(opts.password)}\n\n` +
    opts.label;
  console.error(
    "\n" +
      boxen(body, {
        title: "Sign in to Trusty Squire",
        titleAlignment: "left",
        padding: { top: 0, bottom: 0, left: 1, right: 1 },
        borderStyle: "single",
        borderColor: "#cf3a52",
        width,
      }) +
      "\n",
  );
}

const rigTeardowns = new WeakMap<RemoteLoginRig, Promise<void>>();

function childExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

export function assertRemoteLoginRigLive(rig: RemoteLoginRig): void {
  for (const child of rig.procs) {
    if (!childExited(child)) continue;
    const command = child.spawnfile || child.spawnargs[0] || "unknown-helper";
    const status =
      child.exitCode === null
        ? `signal ${child.signalCode ?? "unknown"}`
        : `code ${child.exitCode}`;
    throw new Error(`remote login helper ${basename(command)} exited (${status})`);
  }
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (childExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onExit = (): void => finish(true);
    const timer = setTimeout(() => finish(childExited(child)), timeoutMs);
    const finish = (exited: boolean): void => {
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      resolve(exited);
    };
    child.once("exit", onExit);
  });
}

function removeRigFiles(rig: RemoteLoginRig): void {
  if (rig.webDir !== undefined) rmSync(rig.webDir, { recursive: true, force: true });
  if (rig.privateDir !== undefined) rmSync(rig.privateDir, { recursive: true, force: true });
  delete rig.webDir;
  delete rig.privateDir;
  delete rig.passFile;
  delete rig.authFile;
  delete rig.vncPassword;
}

function releaseChildHandles(child: ChildProcess): void {
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.unref();
}

function forceTeardownRemoteLoginRig(rig: RemoteLoginRig): void {
  for (const child of rig.procs) {
    try {
      if (!childExited(child)) child.kill("SIGKILL");
    } catch {
      // best-effort process-exit cleanup
    }
    releaseChildHandles(child);
  }
  removeRigFiles(rig);
}

export function teardownRemoteLoginRig(rig: RemoteLoginRig, graceMs = 1_000): Promise<void> {
  const existing = rigTeardowns.get(rig);
  if (existing !== undefined) return existing;
  const teardown = (async (): Promise<void> => {
    const running = rig.procs.filter((child) => !childExited(child));
    for (const child of running) {
      try {
        child.kill("SIGTERM");
      } catch {
        // best-effort
      }
    }
    await Promise.all(running.map((child) => waitForChildExit(child, graceMs)));
    const resistant = running.filter((child) => !childExited(child));
    for (const child of resistant) {
      try {
        child.kill("SIGKILL");
      } catch {
        // best-effort
      }
    }
    await Promise.all(resistant.map((child) => waitForChildExit(child, graceMs)));
    for (const child of rig.procs) releaseChildHandles(child);
    removeRigFiles(rig);
  })();
  rigTeardowns.set(rig, teardown);
  return teardown;
}

type LoginProcessRuntime = Pick<NodeJS.Process, "on" | "once" | "removeListener" | "exit">;

export interface LoginSignalExitCoordination {
  enabled(): boolean;
  set(enabled: boolean): void;
}

const signalExitCoordination: LoginSignalExitCoordination = {
  enabled: isSelfManagedChromeTerminationSignalExitEnabled,
  set: setSelfManagedChromeTerminationSignalExitEnabled,
};

export function registerRemoteLoginRigCleanup(
  rig: RemoteLoginRig,
  activeBrowserTeardown: () => (() => Promise<void>) | undefined,
  runtime: LoginProcessRuntime = process,
  signalExit: LoginSignalExitCoordination = signalExitCoordination,
): () => void {
  let finishing = false;
  let signalExitSuspended = false;
  const restoreSignalExit = (): void => {
    if (!signalExitSuspended) return;
    signalExitSuspended = false;
    signalExit.set(true);
  };
  const exitAfterCleanup = (code: number): void => {
    if (finishing) {
      forceTeardownRemoteLoginRig(rig);
      restoreSignalExit();
      runtime.exit(code);
      return;
    }
    finishing = true;
    const browserTeardown = activeBrowserTeardown();
    const closeBrowser = new Promise<void>((resolve) => {
      if (browserTeardown === undefined) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, 3_000);
      void browserTeardown()
        .catch(() => undefined)
        .finally(() => {
          clearTimeout(timer);
          resolve();
        });
    });
    void closeBrowser.finally(async () => {
      await teardownRemoteLoginRig(rig);
      restoreSignalExit();
      runtime.exit(code);
    });
  };
  const onExit = (): void => forceTeardownRemoteLoginRig(rig);
  const onSighup = (): void => exitAfterCleanup(129);
  const onSigterm = (): void => exitAfterCleanup(143);
  const onSigint = (): void => exitAfterCleanup(130);
  const onUncaughtException = (error: Error): void => {
    console.error("[login] uncaught exception; tearing down the login browser", error);
    exitAfterCleanup(1);
  };
  const onUnhandledRejection = (reason: unknown): void => {
    console.error("[login] unhandled rejection; tearing down the login browser", reason);
    exitAfterCleanup(1);
  };

  runtime.once("exit", onExit);
  const ownsTerminationExit = signalExit.enabled();
  if (ownsTerminationExit) {
    signalExit.set(false);
    signalExitSuspended = true;
    runtime.on("SIGHUP", onSighup);
    runtime.on("SIGTERM", onSigterm);
    runtime.on("SIGINT", onSigint);
    runtime.once("uncaughtException", onUncaughtException);
    runtime.once("unhandledRejection", onUnhandledRejection);
  }

  return (): void => {
    if (finishing) return;
    runtime.removeListener("exit", onExit);
    if (!ownsTerminationExit) return;
    runtime.removeListener("SIGHUP", onSighup);
    runtime.removeListener("SIGTERM", onSigterm);
    runtime.removeListener("SIGINT", onSigint);
    runtime.removeListener("uncaughtException", onUncaughtException);
    runtime.removeListener("unhandledRejection", onUnhandledRejection);
    restoreSignalExit();
  };
}
