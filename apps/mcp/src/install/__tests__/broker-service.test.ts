import type * as ChildProcess from "node:child_process";
import type * as Discovery from "../../bot/broker/discovery.js";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  brokerServiceName,
  durableBrokerEntry,
  installBrokerService,
  renderLaunchdBroker,
  renderSystemdBroker,
  type BrokerServiceConfig,
} from "../broker-service.js";
import { liveUnixSocket } from "../../bot/broker/discovery.js";
import {
  brokerUnitMarkerPath,
  readBrokerUnitMarkerSync,
  writeBrokerUnitMarker,
} from "../../bot/broker/managed-marker.js";
import { profileDeviceAnchor } from "../../bot/profile-path.js";

vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof ChildProcess>()),
  execFileSync: vi.fn(),
}));
vi.mock("../../bot/broker/discovery.js", async (original) => ({
  ...(await original<typeof Discovery>()),
  liveUnixSocket: vi.fn(async () => true),
}));
const platform = process.platform;
const roots: string[] = [];
let profile: string;
beforeEach(async () => {
  profile = await mkdtemp(join(homedir(), "profile-"));
  roots.push(profile);
  vi.mocked(execFileSync).mockReset().mockReturnValue("");
  vi.mocked(liveUnixSocket).mockReset().mockResolvedValue(true);
  Object.defineProperty(process, "platform", { value: "linux" });
});
afterEach(async () => {
  Object.defineProperty(process, "platform", { value: platform });
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function fixture(): BrokerServiceConfig {
  return {
    name: "trusty-squire-broker-test",
    node: "/opt/Node space/node",
    entry: '/opt/MCP "package"/%$entry/bin.js',
    environment: {
      HOME: "/home/user & space",
      TRUSTY_SQUIRE_PROFILE_DIR: '/home/profile "a"',
      TRUSTY_SQUIRE_BROKER_UNIT: "1",
      DISPLAY: ":0",
    },
  };
}
it("renders literal paths and environment with restart and graceful shutdown", () => {
  const unit = renderSystemdBroker(fixture());
  expect(unit).toContain(
    'ExecStart="/opt/Node space/node" "/opt/MCP \\"package\\"/%%$$entry/bin.js" broker',
  );
  expect(unit).toContain('Environment="TRUSTY_SQUIRE_PROFILE_DIR=/home/profile \\"a\\""');
  expect(unit).toContain("StartLimitIntervalSec=60\nStartLimitBurst=6");
  expect(unit).toContain("Restart=on-failure\nRestartSec=5\nKillSignal=SIGINT\nKillMode=mixed");
  const plist = renderLaunchdBroker(fixture());
  expect(plist).toContain("<string>/opt/MCP &quot;package&quot;/%$entry/bin.js</string>");
  expect(plist).toContain("<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>");
  expect(plist).toContain("<key>ThrottleInterval</key><integer>5</integer>");
  expect(plist).toContain("<key>RunAtLoad</key><true/>");
  expect(plist).toContain("/home/user &amp; space");
});
it("registers Linux once, starts through systemctl, and probes both sockets", async () => {
  await installBrokerService(profile);
  const name = brokerServiceName(profile);
  const unitPath = join(process.env.XDG_CONFIG_HOME!, "systemd", "user", `${name}.service`);
  const unit = await readFile(unitPath, "utf8");
  expect(unit).toContain(" broker\n");
  expect(unit).not.toContain("_npx");
  expect(unit).toContain(`TRUSTY_SQUIRE_PROFILE_DIR=${profile}`);
  expect(execFileSync).toHaveBeenCalledWith(
    "systemctl",
    ["--user", "enable", "--now", `${name}.service`],
    expect.anything(),
  );
  expect(liveUnixSocket).toHaveBeenCalledTimes(2);
  const marker = readBrokerUnitMarkerSync(profile);
  expect(marker.kind).toBe("valid");
  vi.mocked(execFileSync).mockReturnValue(
    `Id=${name}.service\nActiveState=inactive\nEnvironment=TRUSTY_SQUIRE_PROFILE_DIR=${profile}\n`,
  );
  await installBrokerService(profile);
  expect(
    vi.mocked(execFileSync).mock.calls.filter((call) => call[1]?.includes("daemon-reload")),
  ).toHaveLength(1);
  expect(vi.mocked(execFileSync).mock.calls.some((call) => call[1]?.includes("restart"))).toBe(
    false,
  );
});
it("Reproduction BBC-CI3: accepts systemctl's empty fresh-install unit inventory", async () => {
  vi.mocked(execFileSync).mockImplementation((_command, args) => {
    if (args?.includes("list-unit-files"))
      throw Object.assign(new Error("Command failed: systemctl list-unit-files"), {
        status: 1,
        signal: null,
        stdout: "",
        stderr: "",
      });
    return "";
  });
  await installBrokerService(profile);
  expect(execFileSync).toHaveBeenCalledWith(
    "systemctl",
    ["--user", "enable", "--now", `${brokerServiceName(profile)}.service`],
    expect.anything(),
  );
});
it("refuses an empty-looking unit inventory when the manager reports an error", async () => {
  vi.mocked(execFileSync).mockImplementation((_command, args) => {
    if (args?.includes("list-unit-files"))
      throw Object.assign(new Error("user bus unavailable"), {
        status: 1,
        signal: null,
        stdout: "",
        stderr: "Failed to connect to bus",
      });
    return "";
  });
  await expect(installBrokerService(profile)).rejects.toThrow(/working systemctl user manager/);
  expect(liveUnixSocket).not.toHaveBeenCalled();
});
it("reuses an existing stopped Beeline unit and its custom socket without overwriting it", async () => {
  const socket = join(profile, "custom.sock");
  const unitPath = join(
    process.env.XDG_CONFIG_HOME!,
    "systemd",
    "user",
    "trusty-squire-broker.service",
  );
  await mkdir(dirname(unitPath), { recursive: true });
  await writeFile(unitPath, "# maintained by Beeline\n");
  vi.mocked(execFileSync).mockReturnValue(
    `Id=trusty-squire-broker.service\nActiveState=failed\nEnvironment="TRUSTY_SQUIRE_PROFILE_DIR=${profile}" "TRUSTY_SQUIRE_BROKER_SOCKET=${socket}"\n`,
  );
  await installBrokerService(profile);
  expect(execFileSync).toHaveBeenCalledWith(
    "systemctl",
    ["--user", "enable", "--now", "trusty-squire-broker.service"],
    expect.anything(),
  );
  expect(
    vi.mocked(execFileSync).mock.calls.some((call) => call[1]?.includes("daemon-reload")),
  ).toBe(false);
  expect(vi.mocked(execFileSync).mock.calls.some((call) => call[1]?.includes("restart"))).toBe(
    false,
  );
  expect(liveUnixSocket).toHaveBeenCalledWith(socket);
  expect(await readFile(unitPath, "utf8")).toBe("# maintained by Beeline\n");
});
it("Reproduction BBC-R1: replaces an installer-owned Linux entry on a version upgrade", async () => {
  const name = brokerServiceName(profile);
  const unitPath = join(process.env.XDG_CONFIG_HOME!, "systemd", "user", `${name}.service`);
  const oldEntry = join(
    homedir(),
    ".trusty-squire",
    "broker",
    "1.0.0",
    "node_modules",
    "@trusty-squire",
    "mcp",
    "dist",
    "bin.js",
  );
  await mkdir(dirname(unitPath), { recursive: true });
  await writeFile(
    unitPath,
    renderSystemdBroker({
      name,
      node: process.execPath,
      entry: oldEntry,
      environment: { HOME: homedir(), TRUSTY_SQUIRE_PROFILE_DIR: profile },
    }),
  );
  vi.mocked(execFileSync).mockReturnValue(
    `Id=${name}.service\nActiveState=active\nEnvironment=TRUSTY_SQUIRE_PROFILE_DIR=${profile}\n`,
  );
  await installBrokerService(profile);
  expect(await readFile(unitPath, "utf8")).not.toContain(oldEntry);
  expect(execFileSync).toHaveBeenCalledWith(
    "systemctl",
    ["--user", "restart", `${name}.service`],
    expect.anything(),
  );
});
it("Reproduction BBC-R1: reloads an installer-owned macOS entry on a version upgrade", async () => {
  Object.defineProperty(process, "platform", { value: "darwin" });
  const name = brokerServiceName(profile);
  const plistPath = join(homedir(), "Library", "LaunchAgents", `ai.trustysquire.${name}.plist`);
  await mkdir(dirname(plistPath), { recursive: true });
  await writeFile(
    plistPath,
    renderLaunchdBroker({
      name,
      node: process.execPath,
      entry: "/old-version/dist/bin.js",
      environment: { HOME: homedir(), TRUSTY_SQUIRE_PROFILE_DIR: profile },
    }),
  );
  let bootstraps = 0;
  vi.mocked(execFileSync).mockImplementation((_command, args) => {
    if (args?.includes("bootstrap") && ++bootstraps === 1)
      throw new Error("Bootstrap failed: 5: Input/output error");
    return "";
  });
  await installBrokerService(profile);
  expect(bootstraps).toBe(2);
  const domain = `gui/${process.getuid?.()}`;
  const target = `${domain}/ai.trustysquire.${name}`;
  expect(execFileSync).toHaveBeenCalledWith("launchctl", ["bootout", target], expect.anything());
  expect(execFileSync).toHaveBeenCalledWith(
    "launchctl",
    ["bootstrap", domain, plistPath],
    expect.anything(),
  );
  expect(execFileSync).toHaveBeenCalledWith(
    "launchctl",
    ["kickstart", "-k", target],
    expect.anything(),
  );
});
it("reuses an installed but unloaded service instead of overwriting its entry", async () => {
  const socket = join(profile, "unloaded.sock");
  vi.mocked(execFileSync).mockImplementation((_command, args) => {
    if (args?.includes("list-unit-files")) return "trusty-squire-broker.service disabled enabled\n";
    if (args?.includes("trusty-squire-broker.service") && args.includes("show"))
      return `Id=trusty-squire-broker.service\nActiveState=inactive\nEnvironment=TRUSTY_SQUIRE_PROFILE_DIR=${profile} TRUSTY_SQUIRE_BROKER_SOCKET=${socket}\n`;
    return "";
  });
  await installBrokerService(profile);
  expect(liveUnixSocket).toHaveBeenCalledWith(socket);
  expect(
    vi.mocked(execFileSync).mock.calls.some((call) => call[1]?.includes("daemon-reload")),
  ).toBe(false);
});
it("bounds macOS upgrade retries and reports a persistent bootstrap failure", async () => {
  Object.defineProperty(process, "platform", { value: "darwin" });
  const name = brokerServiceName(profile);
  const plist = join(homedir(), "Library", "LaunchAgents", `ai.trustysquire.${name}.plist`);
  await mkdir(dirname(plist), { recursive: true });
  await writeFile(
    plist,
    renderLaunchdBroker({
      name,
      node: process.execPath,
      entry: "/old-version/dist/bin.js",
      environment: { HOME: homedir(), TRUSTY_SQUIRE_PROFILE_DIR: profile },
    }),
  );
  vi.mocked(execFileSync).mockImplementation((_command, args) => {
    if (args?.includes("bootstrap")) throw new Error("Bootstrap failed: 5: Input/output error");
    return "";
  });
  vi.useFakeTimers();
  const result = expect(installBrokerService(profile)).rejects.toThrow(/Bootstrap failed: 5:/);
  await vi.waitFor(() =>
    expect(vi.mocked(execFileSync).mock.calls.some((call) => call[1]?.includes("bootstrap"))).toBe(
      true,
    ),
  );
  await vi.runAllTimersAsync();
  await result;
  expect(liveUnixSocket).not.toHaveBeenCalled();
  expect(vi.mocked(execFileSync).mock.calls.some((call) => call[1]?.includes("kickstart"))).toBe(
    false,
  );
});
it("recognizes a default-profile unit through its declared HOME", async () => {
  const home = join(profile, "unit-home");
  const target = join(home, ".trusty-squire", "chrome-profile");
  await mkdir(target, { recursive: true });
  const socket = join(profile, "home.sock");
  vi.mocked(execFileSync).mockReturnValue(
    `Id=trusty-squire-broker.service\nActiveState=inactive\nEnvironment="HOME=${home}" "TRUSTY_SQUIRE_BROKER_SOCKET=${socket}"\n`,
  );
  await installBrokerService(target);
  expect(execFileSync).toHaveBeenCalledWith(
    "systemctl",
    ["--user", "enable", "--now", "trusty-squire-broker.service"],
    expect.anything(),
  );
  expect(liveUnixSocket).toHaveBeenCalledWith(socket);
});
it("fails clearly on an unavailable manager without proceeding to startup", async () => {
  vi.mocked(execFileSync).mockImplementation(() => {
    throw new Error("user bus unavailable");
  });
  await expect(installBrokerService(profile)).rejects.toThrow(/working systemctl user manager/);
  expect(execFileSync).toHaveBeenCalledTimes(1);
  expect(liveUnixSocket).not.toHaveBeenCalled();
});
it("does not accept manager stdout as readiness proof", async () => {
  vi.useFakeTimers();
  vi.mocked(liveUnixSocket).mockResolvedValue(false);
  const result = expect(installBrokerService(profile)).rejects.toThrow(
    /Broker not running after user service startup/,
  );
  // File IO settles before fake timers can advance the readiness loop.
  await vi.waitFor(() => expect(liveUnixSocket).toHaveBeenCalled());
  await vi.runAllTimersAsync();
  await result;
});
it("registers and starts a macOS user agent, and avoids a duplicate bootstrap", async () => {
  Object.defineProperty(process, "platform", { value: "darwin" });
  vi.mocked(execFileSync).mockImplementation((_command, args) => {
    if (args?.includes("print")) throw new Error("not loaded");
    return "";
  });
  await installBrokerService(profile);
  const name = brokerServiceName(profile);
  const plistPath = join(homedir(), "Library", "LaunchAgents", `ai.trustysquire.${name}.plist`);
  expect(await readFile(plistPath, "utf8")).toContain("<key>SuccessfulExit</key><false/>");
  expect(execFileSync).toHaveBeenCalledWith(
    "launchctl",
    ["bootstrap", `gui/${process.getuid?.()}`, plistPath],
    expect.anything(),
  );
  expect(execFileSync).toHaveBeenCalledWith(
    "launchctl",
    ["kickstart", `gui/${process.getuid?.()}/ai.trustysquire.${name}`],
    expect.anything(),
  );
  vi.mocked(execFileSync).mockReturnValue("");
  await installBrokerService(profile);
  expect(
    vi.mocked(execFileSync).mock.calls.filter((call) => call[1]?.includes("bootstrap")),
  ).toHaveLength(1);
  expect(vi.mocked(execFileSync).mock.calls.some((call) => call[1]?.includes("bootout"))).toBe(
    false,
  );
});
it("preserves an externally maintained macOS agent", async () => {
  Object.defineProperty(process, "platform", { value: "darwin" });
  const name = brokerServiceName(profile);
  const plistPath = join(homedir(), "Library", "LaunchAgents", `ai.trustysquire.${name}.plist`);
  await mkdir(dirname(plistPath), { recursive: true });
  await writeFile(plistPath, "<!-- maintained by the host owner -->\n");
  await installBrokerService(profile);
  expect(await readFile(plistPath, "utf8")).toBe("<!-- maintained by the host owner -->\n");
  expect(
    vi
      .mocked(execFileSync)
      .mock.calls.some((call) => call[1]?.includes("bootout") || call[1]?.includes("-k")),
  ).toBe(false);
});
it("fails a macOS bootstrap without claiming readiness or directly starting a broker", async () => {
  Object.defineProperty(process, "platform", { value: "darwin" });
  vi.mocked(execFileSync).mockImplementation(() => {
    throw new Error("launchd unavailable");
  });
  await expect(installBrokerService(profile)).rejects.toThrow(/working launchctl user manager/);
  expect(liveUnixSocket).not.toHaveBeenCalled();
});
it("gives sibling profiles separate services and markers while aliases share one", async () => {
  const a = join(profile, "a"),
    b = join(profile, "b"),
    alias = join(profile, "alias");
  await mkdir(a);
  await mkdir(b);
  await symlink(a, alias);
  expect(brokerServiceName(alias)).toBe(brokerServiceName(a));
  expect(brokerServiceName(a)).not.toBe(brokerServiceName(b));
  await installBrokerService(a);
  await installBrokerService(b);
  expect(brokerUnitMarkerPath(a)).not.toBe(brokerUnitMarkerPath(b));
  expect(readBrokerUnitMarkerSync(a).kind).toBe("valid");
  expect(readBrokerUnitMarkerSync(b).kind).toBe("valid");
});
it("refuses a foreign marker before invoking a manager", async () => {
  const anchor = profileDeviceAnchor(profile)!;
  await writeBrokerUnitMarker(profile, {
    version: 1,
    socket: join(profile, "b.sock"),
    profile: { ...anchor, name: "foreign" },
    accountBinding: null,
  });
  await expect(installBrokerService(profile)).rejects.toThrow(/another profile/);
  expect(execFileSync).not.toHaveBeenCalled();
});
it("preserves npx dependencies outside the cache and works after cache removal", async () => {
  const root = await mkdtemp(join(homedir(), "cache-test-"));
  roots.push(root);
  const modules = join(root, "_npx", "abc", "node_modules");
  const bin = join(modules, "@trusty-squire", "mcp", "dist", "bin.js");
  await mkdir(dirname(bin), { recursive: true });
  await writeFile(bin, 'import "test-dependency";\n');
  await writeFile(join(dirname(dirname(bin)), "package.json"), '{"type":"module"}\n');
  await mkdir(join(modules, "test-dependency"));
  await writeFile(
    join(modules, "test-dependency", "index.js"),
    'console.log("durable dependency loaded"); module.exports = {};\n',
  );
  await mkdir(join(modules, ".bin"));
  await symlink("../missing", join(modules, ".bin", "dangling"));
  const stable = durableBrokerEntry(bin);
  expect(stable).not.toContain("_npx");
  expect(durableBrokerEntry(bin)).toBe(stable);
  await rm(join(root, "_npx"), { recursive: true });
  const result = spawnSync(process.execPath, [stable], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("durable dependency loaded");
  expect(await readFile(stable, "utf8")).toContain('import "test-dependency"');
  expect(
    await readFile(
      join(dirname(dirname(dirname(dirname(stable)))), "test-dependency", "index.js"),
      "utf8",
    ),
  ).toContain("module.exports");
});
