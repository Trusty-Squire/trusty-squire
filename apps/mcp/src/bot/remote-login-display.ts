// Login-only virtual display + noVNC bridge.
//
// Interactive login and headed operator sessions share this Xvfb lifecycle.
// Only login exposes the display over VNC/noVNC; operator Chrome uses the
// private display directly and tears it down with its browser session.

import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
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
import {
  ownerTrackedHelperState,
  releaseOwnerTrackedHelper,
  signalOwnerTrackedHelper,
  spawnOwnerTrackedHelper,
  waitForOwnerTrackedHelperExit,
} from "./owner-process-reaper.js";

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

// Helper stderr is piped but nothing else reads it. Drain it into a bounded
// tail so a helper death reports WHY (a websockify EADDRINUSE traceback, an
// x11vnc auth refusal) instead of a bare exit code — and so a chatty helper
// can never wedge on a full pipe buffer.
const HELPER_STDERR_TAIL_BYTES = 2_000;
const helperStderrTails = new WeakMap<ChildProcess, { text: string }>();

function captureHelperStderr(child: ChildProcess): ChildProcess {
  const stderr = child.stderr;
  if (stderr === null || stderr === undefined) return child;
  const tail = { text: "" };
  helperStderrTails.set(child, tail);
  stderr.on("data", (chunk: Buffer) => {
    tail.text = (tail.text + chunk.toString()).slice(-HELPER_STDERR_TAIL_BYTES);
  });
  return child;
}

export function helperStderrTail(child: ChildProcess): string {
  return helperStderrTails.get(child)?.text.trim() ?? "";
}

function withHelperStderr(message: string, child: ChildProcess): string {
  const tail = helperStderrTail(child);
  return tail === "" ? message : `${message}\n${tail}`;
}

// `exit` can beat the stderr pipe's final `data`, so give the tail a bounded
// moment to land before a failure message is composed from it.
function helperExitError(child: ChildProcess, message: string): Promise<Error> {
  const stderr = child.stderr;
  if (stderr === null || stderr === undefined || stderr.readableEnded || stderr.destroyed) {
    return Promise.resolve(new Error(withHelperStderr(message, child)));
  }
  return new Promise((settle) => {
    const done = (): void => {
      clearTimeout(timer);
      stderr.removeListener("end", done);
      stderr.removeListener("close", done);
      settle(new Error(withHelperStderr(message, child)));
    };
    const timer = setTimeout(done, 250);
    stderr.once("end", done);
    stderr.once("close", done);
  });
}

// True when 127.0.0.1:port can still be bound. websockify's readiness probe is
// a plain connect, so a squatter already listening on the configured port looks
// "ready" while websockify itself is dying on EADDRINUSE — preflight instead.
export function loginPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

export function describeLoginPortHolder(
  port: number,
  runCommand: (command: string, args: string[]) => string | null = runListeningSocketQuery,
): string | null {
  const output = runCommand("ss", ["-ltnp"]);
  if (output === null) return null;
  const localAddress = new RegExp(`(?:^|\\s)\\S*:${port}(?=\\s|$)`);
  for (const line of output.split("\n")) {
    if (!localAddress.test(line)) continue;
    const users = line.match(/users:\(\((.*)\)\)\s*$/);
    return users?.[1] ?? line.trim();
  }
  return null;
}

function runListeningSocketQuery(command: string, args: string[]): string | null {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
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
  // Optional under a named tunnel, but resolve it anyway: it is what the
  // quick-tunnel fallback needs if the tunnel's fixed local port is occupied.
  const cloudflared = resolved.get("cloudflared") ?? resolveLoginBinary("cloudflared");
  return {
    xvfb: resolved.get("Xvfb")!,
    x11vnc: resolved.get("x11vnc")!,
    websockify: resolved.get("websockify")!,
    ...(cloudflared === null ? {} : { cloudflared }),
  };
}

export type LoginTunnelPlan =
  | { mode: "named"; hostname: string; port: number }
  | { mode: "quick"; cloudflared: string; fallbackNotice?: string };

// A named tunnel pins websockify to one fixed local port. When something else
// already holds it, degrade to the per-login quick tunnel (the manual
// `env -u TS_LOGIN_LOCAL_PORT -u TS_LOGIN_PUBLIC_HOSTNAME` workaround,
// automated) rather than letting websockify die on EADDRINUSE.
export function planLoginTunnel(input: {
  namedTunnel: { hostname: string; port: number } | null;
  namedPortAvailable: boolean;
  resolveCloudflared: () => string | null;
  describePortHolder: (port: number) => string | null;
}): LoginTunnelPlan {
  const { namedTunnel } = input;
  if (namedTunnel !== null && input.namedPortAvailable) {
    return { mode: "named", hostname: namedTunnel.hostname, port: namedTunnel.port };
  }
  const cloudflared = input.resolveCloudflared();
  if (namedTunnel === null) {
    if (cloudflared === null) {
      throw new Error("cloudflared was not resolved for the per-login quick tunnel");
    }
    return { mode: "quick", cloudflared };
  }
  const holder = input.describePortHolder(namedTunnel.port);
  const busy =
    `the configured login port 127.0.0.1:${namedTunnel.port} (TS_LOGIN_LOCAL_PORT) ` +
    `is already in use${holder === null ? "" : ` by ${holder}`}`;
  if (cloudflared === null) {
    throw new Error(
      `Remote login cannot start: ${busy}.\n` +
        "Free that port or point TS_LOGIN_LOCAL_PORT at a free one. A one-off " +
        "Cloudflare quick tunnel would work around it, but cloudflared is not installed.\n" +
        remoteLoginInstallHint(["cloudflared"]),
    );
  }
  return {
    mode: "quick",
    cloudflared,
    fallbackNotice: `${busy} — using a one-off Cloudflare tunnel for this sign-in instead.`,
  };
}

function spawnBackground(command: string, args: string[], env?: NodeJS.ProcessEnv): ChildProcess {
  return captureHelperStderr(
    spawnOwnerTrackedHelper(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: env ?? process.env,
    }),
  );
}

function waitForTunnelUrl(cloudflared: ChildProcess, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let output = "";
    const finish = (error: Error | Promise<Error> | null, url?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cloudflared.removeListener("error", onError);
      cloudflared.removeListener("exit", onExit);
      cloudflared.stdout?.removeListener("data", scan);
      cloudflared.stderr?.removeListener("data", scan);
      if (error !== null) void Promise.resolve(error).then(reject);
      else resolve(url!);
    };
    const onError = (error: Error): void =>
      finish(new Error(`cloudflared failed to spawn: ${error.message}`));
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void =>
      finish(
        helperExitError(
          cloudflared,
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
    const finish = (error: Error | Promise<Error> | null, display?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      xvfb.removeListener("error", onError);
      xvfb.removeListener("exit", onExit);
      displayOutput.removeListener("data", onData);
      if (error !== null) void Promise.resolve(error).then(reject);
      else resolve(display!);
    };
    const onError = (error: Error): void =>
      finish(new Error(`Xvfb failed to spawn: ${error.message}`));
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void =>
      finish(
        helperExitError(
          xvfb,
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
    const finish = (error?: Error | Promise<Error>): void => {
      if (settled) return;
      settled = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      if (error !== undefined) void Promise.resolve(error).then(reject);
      else resolve();
    };
    const onError = (error: Error): void =>
      finish(new Error(`${label} failed to spawn: ${error.message}`));
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void =>
      finish(
        helperExitError(
          child,
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

export function createXvfbDisplayRig(): RemoteLoginRig {
  const xvfb = resolveLoginBinary("Xvfb");
  if (xvfb === null) {
    throw new Error(
      "headed Chrome needs Xvfb installed.\n" + remoteLoginInstallHint(["Xvfb"]),
    );
  }
  return {
    width: LOGIN_WIDTH,
    height: LOGIN_HEIGHT,
    procs: [],
    binaries: {
      xvfb,
      x11vnc: "",
      websockify: "",
    },
  };
}

export function createRemoteLoginRig(): RemoteLoginRig {
  const namedTunnel = namedTunnelConfig();
  const binaries = requireRemoteLoginBinaries(namedTunnel !== null);
  return {
    ...createXvfbDisplayRig(),
    binaries,
  };
}

export async function startRemoteLoginDisplay(rig: RemoteLoginRig): Promise<string> {
  try {
    createRemoteLoginSecrets(rig);
    const authFile = rig.authFile!;
    const xvfb = captureHelperStderr(
      spawnOwnerTrackedHelper(
        rig.binaries.xvfb,
        ["-screen", "0", `${rig.width}x${rig.height}x24`, "-auth", authFile, "-displayfd", "3"],
        {
          stdio: ["ignore", "pipe", "pipe", "pipe"],
          env: process.env,
        },
      ),
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
  const password = rig.vncPassword;
  const passFile = rig.passFile;
  if (password === undefined || passFile === undefined) {
    throw new Error("remote login VNC credentials are not ready");
  }
  const namedTunnel = namedTunnelConfig();
  const plan = planLoginTunnel({
    namedTunnel,
    namedPortAvailable: namedTunnel === null || (await loginPortAvailable(namedTunnel.port)),
    resolveCloudflared: () => rig.binaries.cloudflared ?? resolveLoginBinary("cloudflared"),
    describePortHolder: (port) => describeLoginPortHolder(port),
  });
  if (plan.mode === "quick" && plan.fallbackNotice !== undefined) {
    console.error(`\n[login] ${plan.fallbackNotice}\n`);
  }

  // Helpers this call started, so a failure part-way through reaps only them
  // and leaves the caller's ordered browser-then-display teardown intact.
  const started: ChildProcess[] = [];
  try {
    const vncPort = await findFreeLoginPort();
    const webPort = plan.mode === "named" ? plan.port : await findFreeLoginPort();
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
    started.push(x11vnc);
    await waitForListeningPort(x11vnc, vncPort, "x11vnc", 5_000);

    rig.webDir = buildVncWebDir();
    const websockify = spawnBackground(rig.binaries.websockify, [
      `--web=${rig.webDir}`,
      `127.0.0.1:${webPort}`,
      `localhost:${vncPort}`,
    ]);
    rig.procs.push(websockify);
    started.push(websockify);
    await waitForListeningPort(websockify, webPort, "websockify", 5_000);

    let publicUrl: string;
    if (plan.mode === "named") {
      publicUrl = `https://${plan.hostname}/#p=${password}`;
    } else {
      const cloudflared = spawnBackground(plan.cloudflared, fallbackCloudflaredArgs(webPort));
      rig.procs.push(cloudflared);
      started.push(cloudflared);
      const tunnelUrl = await waitForTunnelUrl(cloudflared, 30_000);
      publicUrl = `${tunnelUrl}/#p=${password}`;
    }

    printRemoteLoginBanner({ publicUrl, password, label });
    return publicUrl;
  } catch (error) {
    await teardownExposedLoginHelpers(rig, started);
    throw error;
  }
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
    throw new Error(
      withHelperStderr(`remote login helper ${basename(command)} exited (${status})`, child),
    );
  }
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
      signalOwnerTrackedHelper(child, "SIGKILL");
    } catch {
      // best-effort process-exit cleanup
    }
    releaseChildHandles(child);
  }
  removeRigFiles(rig);
}

async function terminateLoginHelpers(
  procs: readonly ChildProcess[],
  graceMs: number,
): Promise<void> {
  for (const child of procs) {
    try {
      signalOwnerTrackedHelper(child, "SIGTERM");
    } catch {
      // best-effort
    }
  }
  await Promise.all(procs.map((child) => waitForOwnerTrackedHelperExit(child, graceMs)));
  const resistant = procs.filter((child) => ownerTrackedHelperState(child) !== "stale");
  for (const child of resistant) {
    try {
      signalOwnerTrackedHelper(child, "SIGKILL");
    } catch {
      // best-effort
    }
  }
  await Promise.all(resistant.map((child) => waitForOwnerTrackedHelperExit(child, graceMs)));
  for (const child of procs) {
    releaseOwnerTrackedHelper(child);
    releaseChildHandles(child);
  }
}

// Failure part-way through exposing the display: reap the VNC/web/tunnel
// helpers and the noVNC copy so a retry starts clean, but leave Xvfb (and the
// browser drawing on it) to the caller's ordered teardown.
async function teardownExposedLoginHelpers(
  rig: RemoteLoginRig,
  started: readonly ChildProcess[],
): Promise<void> {
  await terminateLoginHelpers(started, 1_000);
  rig.procs = rig.procs.filter((child) => !started.includes(child));
  if (rig.webDir !== undefined) {
    rmSync(rig.webDir, { recursive: true, force: true });
    delete rig.webDir;
  }
}

export function teardownRemoteLoginRig(rig: RemoteLoginRig, graceMs = 1_000): Promise<void> {
  const existing = rigTeardowns.get(rig);
  if (existing !== undefined) return existing;
  const teardown = (async (): Promise<void> => {
    await terminateLoginHelpers(rig.procs, graceMs);
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
