// Login-only virtual display + noVNC bridge.
//
// This module is deliberately not used by BrowserController. Automated operator
// sessions stay on Chrome's new-headless path; only interactive login/connect
// calls start this stack, and every process is torn down with that login.

import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  display: string;
  width: number;
  height: number;
  procs: ChildProcess[];
  webDir?: string;
  passFile?: string;
}

function loginAssetPath(name: string): string {
  return fileURLToPath(new URL(`../../assets/login/${name}`, import.meta.url));
}

function pickFreeDisplay(): string {
  for (let n = 99; n <= 120; n++) {
    if (!existsSync(`/tmp/.X11-unix/X${n}`)) return `:${n}`;
  }
  throw new Error("no free X display number in :99..:120");
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

export function loginBinaryAvailable(binary: string): boolean {
  const dirs = [...(process.env.PATH ?? "").split(":"), ...STANDARD_BIN_DIRS];
  return dirs.some((dir) => dir.length > 0 && existsSync(join(dir, binary)));
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

function requireRemoteLoginBinaries(namedTunnel: boolean): void {
  const required = [
    "Xvfb",
    "x11vnc",
    "websockify",
    ...(namedTunnel ? [] : ["cloudflared"]),
  ] as const;
  const missing = required.filter((binary) => !loginBinaryAvailable(binary));
  if (missing.length > 0) {
    throw new Error(
      `headless login needs these not-installed binaries: ${missing.join(", ")}.\n` +
        remoteLoginInstallHint(missing),
    );
  }
  if (!existsSync(NOVNC_INSTALL_DIR)) {
    throw new Error("noVNC web assets not found at /usr/share/novnc — install the `novnc` package");
  }
}

function spawnBackground(command: string, args: string[], env?: NodeJS.ProcessEnv): ChildProcess {
  const child = spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: env ?? process.env,
  });
  child.on("error", (error) =>
    console.error(`[login] ${command} failed to spawn: ${String(error)}`),
  );
  return child;
}

function waitForTunnelUrl(cloudflared: ChildProcess, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("cloudflared did not produce a URL in time")),
      timeoutMs,
    );
    let output = "";
    const scan = (chunk: Buffer): void => {
      output += chunk.toString();
      const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (match !== null) {
        clearTimeout(timer);
        resolve(match[0]);
      }
      if (output.length > 65_536) output = output.slice(-4_096);
    };
    cloudflared.stdout?.on("data", scan);
    cloudflared.stderr?.on("data", scan);
  });
}

export function fallbackCloudflaredArgs(webPort: number): string[] {
  return ["tunnel", "--protocol", "http2", "--url", `http://127.0.0.1:${webPort}`];
}

function buildVncWebDir(): string {
  const webDir = mkdtempSync(join(tmpdir(), "ts-novnc-"));
  cpSync(NOVNC_INSTALL_DIR, webDir, { recursive: true });
  if (!existsSync(join(webDir, "core", "rfb.js"))) {
    rmSync(webDir, { recursive: true, force: true });
    throw new Error(
      `noVNC core not found at ${NOVNC_INSTALL_DIR}/core/rfb.js — the installed novnc package has an unexpected layout`,
    );
  }
  const brandedPage = readFileSync(loginAssetPath("vnc.html"), "utf8");
  writeFileSync(join(webDir, "vnc.html"), brandedPage);
  writeFileSync(join(webDir, "index.html"), brandedPage);
  return webDir;
}

export function createRemoteLoginRig(): RemoteLoginRig {
  const namedTunnel = namedTunnelConfig();
  requireRemoteLoginBinaries(namedTunnel !== null);
  return {
    display: pickFreeDisplay(),
    width: LOGIN_WIDTH,
    height: LOGIN_HEIGHT,
    procs: [],
  };
}

export async function startRemoteLoginDisplay(rig: RemoteLoginRig): Promise<void> {
  try {
    rig.procs.push(
      spawnBackground("Xvfb", [
        rig.display,
        "-screen",
        "0",
        `${rig.width}x${rig.height}x24`,
        "-ac",
      ]),
    );
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  } catch (error) {
    await teardownRemoteLoginRig(rig);
    throw error;
  }
}

export async function exposeRemoteLoginDisplay(
  rig: RemoteLoginRig,
  label: string,
): Promise<string> {
  const namedTunnel = namedTunnelConfig();
  const vncPort = await findFreeLoginPort();
  const webPort = namedTunnel?.port ?? (await findFreeLoginPort());
  const password = randomBytes(4).toString("hex");

  const passFile = join(tmpdir(), `tsq-vnc-${process.pid}-${vncPort}.pass`);
  writeFileSync(passFile, password, { mode: 0o600 });
  chmodSync(passFile, 0o600);
  rig.passFile = passFile;
  rig.procs.push(
    spawnBackground("x11vnc", [
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
    ]),
  );
  await new Promise((resolve) => setTimeout(resolve, 1_500));

  rig.webDir = buildVncWebDir();
  rig.procs.push(
    spawnBackground("websockify", [
      `--web=${rig.webDir}`,
      `127.0.0.1:${webPort}`,
      `localhost:${vncPort}`,
    ]),
  );
  await new Promise((resolve) => setTimeout(resolve, 1_500));

  let publicUrl: string;
  if (namedTunnel !== null) {
    publicUrl = `https://${namedTunnel.hostname}/#p=${password}`;
  } else {
    const cloudflared = spawnBackground("cloudflared", fallbackCloudflaredArgs(webPort));
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
  if (rig.passFile !== undefined) rmSync(rig.passFile, { force: true });
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
    runtime.on("SIGTERM", onSigterm);
    runtime.on("SIGINT", onSigint);
    runtime.once("uncaughtException", onUncaughtException);
    runtime.once("unhandledRejection", onUnhandledRejection);
  }

  return (): void => {
    if (finishing) return;
    runtime.removeListener("exit", onExit);
    if (!ownsTerminationExit) return;
    runtime.removeListener("SIGTERM", onSigterm);
    runtime.removeListener("SIGINT", onSigint);
    runtime.removeListener("uncaughtException", onUncaughtException);
    runtime.removeListener("unhandledRejection", onUnhandledRejection);
    restoreSignalExit();
  };
}
