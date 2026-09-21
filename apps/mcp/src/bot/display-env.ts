// Whether this process already has a user-visible screen. Xvfb and the
// noVNC login rig exist only when this is false.

import { connect } from "node:net";

// macOS (Aqua) and Windows (Win32) draw windows themselves: there is no X
// display to name and no Xvfb to stand in for one.
export function drawsWindowsNatively(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "darwin" || platform === "win32";
}

export function hasDisplay(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  // Native windowing always has a screen; Linux needs an existing
  // user-visible X display.
  if (drawsWindowsNatively(platform)) return true;
  if (typeof env.DISPLAY !== "string" || env.DISPLAY.trim().length === 0) return false;
  if (
    (typeof env.SSH_CONNECTION === "string" && env.SSH_CONNECTION.trim().length > 0) ||
    (typeof env.SSH_TTY === "string" && env.SSH_TTY.trim().length > 0) ||
    env.XDG_SESSION_TYPE?.trim().toLowerCase() === "tty"
  ) {
    return false;
  }
  return true;
}

// The local socket an X display number is served on. A remote or TCP spelling
// (`host:0`) names no local socket and yields null — there is nothing cheap to
// probe there, and a launch decision must not read that as "no screen".
export function displayProbeSocket(
  display: string | undefined,
  socketDir: string = X11_SOCKET_DIR,
): string | null {
  const local = /^(?:unix)?:(\d+)(?:\.\d+)?$/.exec(display?.trim() ?? "");
  return local === null ? null : `${socketDir}/X${local[1]}`;
}

export const X11_SOCKET_DIR = "/tmp/.X11-unix";

const DISPLAY_PROBE_TIMEOUT_MS = 250;

// The env shape says a screen was there when this process started; a
// long-lived daemon outlives the X session that gave it that DISPLAY (logout,
// Xorg restart), and a headed launch against a dead display dies with
// "Missing X server or $DISPLAY". Ask the display itself whether it still
// answers, so the caller can fall back to a rig instead.
export async function hostDisplayAcceptsConnections(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  socketDir: string = X11_SOCKET_DIR,
): Promise<boolean> {
  if (!hasDisplay(platform, env)) return false;
  if (drawsWindowsNatively(platform)) return true;
  const socket = displayProbeSocket(env.DISPLAY, socketDir);
  if (socket === null) return true;
  return await new Promise<boolean>((resolve) => {
    const probe = connect({ path: socket });
    const settle = (live: boolean): void => {
      probe.destroy();
      resolve(live);
    };
    probe.setTimeout(DISPLAY_PROBE_TIMEOUT_MS, () => settle(false));
    probe.once("connect", () => settle(true));
    probe.once("error", () => settle(false));
  });
}
