import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "../version.js";
import {
  profileDeviceAnchor,
  profileDeviceIdentity,
  profilePathIdentity,
} from "../bot/profile-path.js";
import { readBrokerAccountBinding } from "../bot/broker/account-binding.js";
import {
  defaultBrokerSocket,
  liveUnixSocket,
  parseManagedBrokerShow,
  unitServesProfile,
} from "../bot/broker/discovery.js";
import { readBrokerUnitMarkerSync, writeBrokerUnitMarker } from "../bot/broker/managed-marker.js";
import { sharedMcpSocketPath } from "../bot/broker/mcp-socket-path.js";

function run(command: string, args: string[]): string {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      timeout: 15_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new Error(
      `Broker user service failed (${command} ${args.join(" ")}): ${error instanceof Error ? error.message : String(error)}. A working ${command} user manager is required; no direct broker fallback was attempted`,
    );
  }
}

/** npx caches can disappear. Preserve the package and its dependency tree. */
export function durableBrokerEntry(
  binPath = fileURLToPath(new URL("../bin.js", import.meta.url)),
): string {
  if (!/[/\\]_npx[/\\]/.test(binPath)) return binPath;
  const pkgRoot = dirname(dirname(binPath));
  const cacheModules = dirname(dirname(pkgRoot));
  const stableModules = join(homedir(), ".trusty-squire", "broker", VERSION, "node_modules");
  const stableBin = join(stableModules, "@trusty-squire", "mcp", "dist", "bin.js");
  if (existsSync(stableBin)) return stableBin;
  mkdirSync(dirname(dirname(stableModules)), { recursive: true, mode: 0o700 });
  const staging = mkdtempSync(join(dirname(dirname(stableModules)), ".install-"));
  try {
    cpSync(cacheModules, join(staging, "node_modules"), {
      recursive: true,
      verbatimSymlinks: true,
    });
    if (!existsSync(join(staging, "node_modules", "@trusty-squire", "mcp", "dist", "bin.js")))
      throw new Error("Could not preserve the broker package outside the npx cache");
    renameSync(staging, dirname(stableModules));
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return stableBin;
}

export function brokerServiceName(profileDir: string, home = homedir()): string {
  if (
    profileDeviceIdentity(profileDir) ===
    profileDeviceIdentity(join(home, ".trusty-squire", "chrome-profile"))
  )
    return "trusty-squire-broker";
  return `trusty-squire-broker-${createHash("sha256").update(profileDeviceIdentity(profileDir)).digest("hex").slice(0, 16)}`;
}

export interface BrokerServiceConfig {
  name: string;
  node: string;
  entry: string;
  environment: Record<string, string>;
}

function systemdQuote(value: string): string {
  return (
    '"' +
    value
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/%/g, "%%")
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r") +
    '"'
  );
}

export function renderSystemdBroker(config: BrokerServiceConfig): string {
  return `[Unit]\nDescription=Trusty Squire browser broker\n\n[Service]\nType=simple\nExecStart=${systemdQuote(config.node).replace(/\$/g, () => "$$")} ${systemdQuote(config.entry).replace(/\$/g, () => "$$")} broker\n${Object.entries(
    config.environment,
  )
    .map(([key, value]) => `Environment=${systemdQuote(`${key}=${value}`)}`)
    .join(
      "\n",
    )}\nRestart=always\nRestartSec=1\nKillSignal=SIGINT\nKillMode=mixed\nTimeoutStopSec=30\n\n[Install]\nWantedBy=default.target\n`;
}

function xml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function renderLaunchdBroker(config: BrokerServiceConfig): string {
  const home = config.environment.HOME!;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>ai.trustysquire.${xml(config.name)}</string>\n<key>ProgramArguments</key><array>${[config.node, config.entry, "broker"].map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>\n<key>EnvironmentVariables</key><dict>${Object.entries(
    config.environment,
  )
    .map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`)
    .join(
      "",
    )}</dict>\n<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><true/>\n<key>ExitTimeOut</key><integer>30</integer>\n<key>StandardOutPath</key><string>${xml(join(home, ".trusty-squire", `${config.name}.log`))}</string>\n<key>StandardErrorPath</key><string>${xml(join(home, ".trusty-squire", `${config.name}.log`))}</string>\n</dict></plist>\n`;
}

/** Register/start through the OS manager, then independently read both listeners. */
export async function installBrokerService(profileDir: string): Promise<void> {
  if (process.platform !== "linux" && process.platform !== "darwin")
    throw new Error(
      "Broker user services require Linux systemd or macOS launchd; no broker was started",
    );
  const home = homedir();
  const profile = profilePathIdentity(profileDir);
  const anchor = profileDeviceAnchor(profile);
  if (anchor === null) throw new Error("Cannot determine the broker profile identity");
  const marker = readBrokerUnitMarkerSync(profile);
  if (marker.kind === "invalid")
    throw new Error("Invalid broker service marker; repair it before installing the service");
  if (
    marker.kind === "valid" &&
    (marker.marker.profile.dev !== anchor.dev ||
      marker.marker.profile.ino !== anchor.ino ||
      marker.marker.profile.name !== anchor.name)
  )
    throw new Error("Broker service marker belongs to another profile");
  let name = brokerServiceName(profile, home);
  let socket = marker.kind === "valid" ? marker.marker.socket : defaultBrokerSocket(profile);
  let existing = false;
  if (process.platform === "linux") {
    const units = parseManagedBrokerShow(
      run("systemctl", [
        "--user",
        "show",
        "--type=service",
        "--all",
        "--no-pager",
        "-p",
        "Id",
        "-p",
        "ActiveState",
        "-p",
        "Environment",
        "-p",
        "ExecStart",
      ]),
    );
    // Inactive units can be unloaded from the manager's live inventory.
    const registered = run("systemctl", [
      "--user",
      "list-unit-files",
      "trusty-squire-broker*.service",
      "--no-legend",
      "--no-pager",
    ])
      .split("\n")
      .map((line) => line.trim().split(/\s+/)[0] ?? "")
      .filter((id) => /^trusty-squire-broker\S*\.service$/.test(id) && !id.includes("@."));
    if (registered.length) {
      const loaded = parseManagedBrokerShow(
        run("systemctl", [
          "--user",
          "show",
          ...registered,
          "--no-pager",
          "-p",
          "Id",
          "-p",
          "ActiveState",
          "-p",
          "Environment",
          "-p",
          "ExecStart",
        ]),
      );
      for (const unit of loaded) if (!units.some((prior) => prior.id === unit.id)) units.push(unit);
    }
    const matches = units.filter((unit) => unitServesProfile(unit, profile));
    if (matches.length > 1)
      throw new Error(
        "Multiple broker user services serve this profile; repair the service configuration before installing",
      );
    const unit = matches[0];
    if (unit) {
      name = unit.id.replace(/\.service$/, "");
      socket = unit.environment.TRUSTY_SQUIRE_BROKER_SOCKET?.trim() || socket;
      existing = true;
    }
  }
  await mkdir(dirname(socket), { recursive: true, mode: 0o700 });
  await mkdir(join(home, ".trusty-squire"), { recursive: true, mode: 0o700 });
  const environment: Record<string, string> = {
    HOME: home,
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    TRUSTY_SQUIRE_PROFILE_DIR: profile,
    TRUSTY_SQUIRE_BROKER_SOCKET: socket,
    TRUSTY_SQUIRE_BROKER_UNIT: "1",
  };
  for (const key of [
    "DISPLAY",
    "XAUTHORITY",
    "WAYLAND_DISPLAY",
    "XDG_RUNTIME_DIR",
    "XDG_CONFIG_HOME",
    "PLAYWRIGHT_BROWSERS_PATH",
    "TRUSTY_SQUIRE_API_BASE",
    "ADAPTER_REGISTRY_URL",
  ]) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  const config: BrokerServiceConfig = {
    name,
    node: realpathSync(process.execPath),
    entry: existing ? "" : durableBrokerEntry(),
    environment,
  };
  await writeBrokerUnitMarker(profile, {
    version: 1,
    socket,
    profile: anchor,
    accountBinding: await readBrokerAccountBinding(profile),
  });
  if (process.platform === "linux") {
    if (!existing) {
      const unitsDir = join(
        process.env.XDG_CONFIG_HOME ?? join(home, ".config"),
        "systemd",
        "user",
      );
      await mkdir(unitsDir, { recursive: true, mode: 0o700 });
      await writeFile(join(unitsDir, `${name}.service`), renderSystemdBroker(config), {
        mode: 0o600,
      });
      run("systemctl", ["--user", "daemon-reload"]);
    }
    run("systemctl", ["--user", "enable", "--now", `${name}.service`]);
  } else {
    const agents = join(home, "Library", "LaunchAgents");
    await mkdir(agents, { recursive: true, mode: 0o700 });
    const plist = join(agents, `ai.trustysquire.${name}.plist`);
    await writeFile(plist, renderLaunchdBroker(config), { mode: 0o600 });
    const domain = `gui/${process.getuid?.()}`;
    const target = `${domain}/ai.trustysquire.${name}`;
    let loaded = false;
    try {
      execFileSync("launchctl", ["print", target], { timeout: 5_000, stdio: "ignore" });
      loaded = true;
    } catch {
      /* bootstrap reports manager errors */
    }
    if (!loaded) run("launchctl", ["bootstrap", domain, plist]);
    run("launchctl", ["enable", target]);
    run("launchctl", ["kickstart", target]);
  }
  const deadline = Date.now() + 10_000;
  let delay = 100;
  do {
    if (
      (await liveUnixSocket(socket)) &&
      (await liveUnixSocket(sharedMcpSocketPath(home, profile)))
    )
      return;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(delay, Math.max(0, deadline - Date.now()))),
    );
    delay = Math.min(delay * 2, 1_000);
  } while (Date.now() < deadline);
  throw new Error(
    `Broker not running after user service startup (${name}); inspect the service manager logs. No client broker fallback was attempted`,
  );
}
