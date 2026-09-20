// Whether this process already has a user-visible screen. Xvfb and the
// noVNC login rig exist only when this is false.

export function hasDisplay(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  // macOS (Aqua) and Windows (Win32) have native windowing; Linux needs
  // an existing user-visible X display.
  if (platform === "darwin" || platform === "win32") return true;
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
