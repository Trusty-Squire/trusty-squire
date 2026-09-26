/** Compatibility surface for local display helpers. Browser custody is the
 * broker's kernel flock and browser scope; no owner manifests or worker exist. */
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import type { ProfileCloseState, ProfileProcessIdentity, ProcessIdentityState } from "./profile.js";
import { browserScopeIsEmpty, stopBrowserScope } from "./browser-scope.js";

interface Display { display: string; authFile: string }
const displays = new Map<string, Display>();

export function trackOwnerProcess(_identity: ProfileProcessIdentity): void {}
export function untrackOwnerProcess(_identity: ProfileProcessIdentity): void {}
export function trackOwnerBrowserLaunch(
  marker: string,
  _profileDir: string,
  runtime: { env?: NodeJS.ProcessEnv } = {},
): void {
  const env = runtime.env;
  if (env?.DISPLAY && env.XAUTHORITY)
    displays.set(marker, { display: env.DISPLAY, authFile: env.XAUTHORITY });
}
export function ownerTrackedBrowserDisplay(_profileDir: string, _holderPid: number): Display | null {
  return null; // The live browser's display is found from its process tree.
}
export function bindOwnerBrowserLaunch(_marker: string, _identity: ProfileProcessIdentity): boolean {
  return true;
}
export function markOwnerBrowserLaunchTerminal(_marker: string): void {}
export function untrackOwnerBrowserLaunch(marker: string): void { displays.delete(marker); }
export function reconcileOwnerBrowserLaunchAfterLeaderExit(marker: string, _profileDir: string): void {
  displays.delete(marker);
}
export async function terminateOwnerBrowserLaunch(
  _marker: string,
  profileDir: string,
): Promise<boolean> {
  if (process.platform !== "linux") return true;
  await stopBrowserScope(profileDir);
  return await browserScopeIsEmpty(profileDir);
}

/** Helpers are direct children with kernel parent-death signaling on Linux. */
export function spawnOwnerTrackedHelper(
  command: string,
  args: readonly string[],
  options: SpawnOptions = {},
  runtime: { spawn?: typeof spawn } = {},
): ChildProcess {
  const usePdeath = process.platform === "linux";
  return (runtime.spawn ?? spawn)(usePdeath ? "setpriv" : command,
    usePdeath ? ["--pdeathsig", "KILL", command, ...args] : [...args], {
      ...options,
      detached: process.platform === "darwin" ? true : options.detached,
    });
}
export function signalOwnerTrackedHelper(child: ChildProcess, signal: NodeJS.Signals): boolean {
  try { return child.kill(signal); } catch { return false; }
}
export function ownerTrackedHelperState(child: ChildProcess): ProcessIdentityState {
  return child.exitCode !== null || child.signalCode !== null ? "stale" : "matching";
}
export async function waitForOwnerTrackedHelperExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (ownerTrackedHelperState(child) !== "stale" && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 25));
  return ownerTrackedHelperState(child) === "stale";
}
export function releaseOwnerTrackedHelper(child: ChildProcess): boolean {
  return ownerTrackedHelperState(child) === "stale";
}
export async function sweepOrphanedOwnerProcesses(): Promise<number> { return 0; }

export function stopOwnerProcessReaper(): void {}
