import { createHash, randomUUID } from "node:crypto";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { profilePathIdentity } from "./profile.js";

const run = promisify(execFile);
type LinuxContainment = { scope: boolean; setpriv: boolean };
let detected: LinuxContainment | undefined;

/** Probe a real disposable scope once. A missing user bus is common in
 * containers and SSH sessions even when systemd-run is installed. */
function linuxContainment(): LinuxContainment {
  if (detected !== undefined) return detected;
  const setpriv = spawnSync("setpriv", ["--version"], {
    stdio: "ignore", timeout: 1_500,
  }).status === 0;
  const probeUnit = `trusty-squire-probe-${process.pid}-${randomUUID().slice(0, 8)}.scope`;
  const scope = setpriv && spawnSync("systemd-run", [
    "--user", "--scope", "--collect", "--quiet", "--unit", probeUnit, "/bin/true",
  ], { stdio: "ignore", timeout: 3_000 }).status === 0;
  detected = { scope, setpriv };
  process.stderr.write(`[browser-broker] Chrome containment=${scope ? "systemd-scope" : "process-group"}` +
    `${!scope && !setpriv ? " (setpriv unavailable)" : ""}\n`);
  return detected;
}

export function linuxBrowserUsesScope(): boolean {
  return process.platform === "linux" && linuxContainment().scope;
}

export function linuxBrowserHasSetpriv(): boolean {
  return process.platform === "linux" && linuxContainment().setpriv;
}

/** One named user scope per physical profile. systemd moves Chrome into the
 * cgroup before exec, so renderers inherit it from their first fork. */
export function browserScopeUnit(profileDir: string): string {
  const key = createHash("sha256").update(profilePathIdentity(profileDir)).digest("hex").slice(0, 24);
  return `trusty-squire-chrome-${key}.scope`;
}

export function scopedChromeCommand(profileDir: string, binary: string, args: readonly string[]): {
  command: string;
  args: string[];
} {
  if (process.platform !== "linux") return { command: binary, args: [...args] };
  const mode = linuxContainment();
  if (mode.scope) return { command: "setpriv", args: [
      "--pdeathsig", "INT", "systemd-run", "--user", "--scope", "--collect",
      "--unit", browserScopeUnit(profileDir), binary, ...args,
    ] };
  return mode.setpriv
    ? { command: "setpriv", args: ["--pdeathsig", "INT", binary, ...args] }
    : { command: binary, args: [...args] };
}

async function scopeState(unit: string): Promise<{ active: boolean; cgroup: string }> {
  const { stdout } = await run("systemctl", ["--user", "show", unit, "-p", "ActiveState", "-p", "ControlGroup"]);
  const state = /^ActiveState=(.+)$/m.exec(stdout)?.[1] ?? "inactive";
  const cgroup = /^ControlGroup=(.*)$/m.exec(stdout)?.[1] ?? "";
  return { active: state !== "inactive" && state !== "failed", cgroup };
}

async function scopePopulated(unit: string): Promise<boolean> {
  const state = await scopeState(unit);
  if (!state.cgroup) return state.active;
  try {
    const { readFile } = await import("node:fs/promises");
    const events = await readFile(`/sys/fs/cgroup${state.cgroup}/cgroup.events`, "utf8");
    return /^populated 1$/m.test(events);
  } catch { return true; }
}

async function signal(unit: string, value: "SIGINT" | "SIGKILL"): Promise<void> {
  await run("systemctl", ["--user", "kill", "--kill-whom=all", `--signal=${value}`, unit]).catch(() => undefined);
}

/** SIGINT flushes Chrome's cookie store. Any remaining process after the
 * bounded grace is killed through cgroup membership, including reparented
 * renderers. This is also the new broker's crash recovery step. */
export async function stopBrowserScope(profileDir: string, graceMs = 2_000): Promise<void> {
  if (!linuxBrowserUsesScope()) return;
  const unit = browserScopeUnit(profileDir);
  if (!(await scopePopulated(unit))) return;
  await signal(unit, "SIGINT");
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!(await scopePopulated(unit))) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await signal(unit, "SIGKILL");
  const killDeadline = Date.now() + 2_000;
  while (Date.now() < killDeadline) {
    if (!(await scopePopulated(unit))) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Browser scope ${unit} did not empty`);
}

export async function browserScopeIsEmpty(profileDir: string): Promise<boolean> {
  if (!linuxBrowserUsesScope()) return true;
  return !(await scopePopulated(browserScopeUnit(profileDir)));
}
