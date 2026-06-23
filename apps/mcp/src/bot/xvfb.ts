// xvfb.ts — spawn a minimal Xvfb instance so the universal signup bot
// can run Chrome with `headless: false` on a headless host. Modern
// SaaS signups (Cloudflare/Stytch, Clerk, Auth0) detect Chromium's
// true-headless mode via JS fingerprints (missing window.chrome, the
// `Headless` UA token, the way headless renders fonts/canvas) and gate
// their forms behind the check. Running against Xvfb gives Chrome a
// real display surface to draw to, defeating the gate. The user never
// sees the display — it exists only so Chrome can render.
//
// Distinct from runHeadlessChrome in google-login.ts: that one also
// runs x11vnc + websockify + cloudflared so the user can watch Chrome
// remotely (needed for login). Signups don't need a viewer — just a
// display. So this helper is intentionally minimal.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface XvfbRig {
  display: string;
  stop: () => void;
}

export function xvfbAvailable(): boolean {
  return binaryOnPath("Xvfb");
}

const SHARED_DISPLAY = process.env.UNIVERSAL_BOT_XVFB_DISPLAY ?? ":198";
const LOCK_DIR = join(tmpdir(), "trusty-squire-xvfb.lock");
const PID_FILE = join(tmpdir(), "trusty-squire-xvfb.pid");

function binaryOnPath(bin: string): boolean {
  const paths = (process.env.PATH ?? "").split(":");
  return paths.some((p) => p.length > 0 && existsSync(join(p, bin)));
}

export function displaySocketPath(display: string): string {
  return `/tmp/.X11-unix/X${display.replace(/^:/, "")}`;
}

export function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readSharedPid(): number | null {
  try {
    const raw = readFileSync(PID_FILE, "utf8").trim();
    const pid = Number(raw);
    return pidAlive(pid) ? pid : null;
  } catch {
    return null;
  }
}

export function displayResponds(display: string): boolean {
  const res = spawnSync("xdpyinfo", ["-display", display], {
    encoding: "utf8",
    timeout: 2_000,
    stdio: "ignore",
  });
  return res.status === 0;
}

async function withXvfbStartupLock<T>(fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      mkdirSync(LOCK_DIR);
      break;
    } catch (err) {
      if (Date.now() > deadline) {
        throw new Error(
          `Timed out waiting for shared Xvfb startup lock at ${LOCK_DIR}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(LOCK_DIR, { recursive: true, force: true });
  }
}

async function waitForDisplay(display: string, deadlineMs: number): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (displayResponds(display)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

// Start a minimal Xvfb instance at 1920x1080x24. Resolves when the
// display socket appears (Xvfb prints nothing useful on stdout, so we
// poll for /tmp/.X11-unix/X<n>). Rejects after 5s if the socket
// doesn't appear — usually means Xvfb crashed (missing fonts etc.).
export async function startXvfb(opts?: {
  width?: number;
  height?: number;
}): Promise<XvfbRig> {
  // 1920×1080 is the most common real desktop resolution. The old
  // 1280×720 default doubled as Playwright's emulated-device viewport
  // default, so with `viewport: null` the page would have read back the
  // exact Playwright default — an anti-bot tell. A stock 1080p display
  // reads as an ordinary laptop/desktop.
  const width = opts?.width ?? 1920;
  const height = opts?.height ?? 1080;
  const display = SHARED_DISPLAY;
  const socketPath = displaySocketPath(display);

  return withXvfbStartupLock(async () => {
    if (displayResponds(display)) {
      return {
        display,
        stop: () => undefined,
      };
    }

    const existingPid = readSharedPid();
    if (existingPid !== null) {
      try {
        process.kill(existingPid, "SIGTERM");
      } catch {
        // already dead
      }
    }
    if (existsSync(socketPath)) {
      rmSync(socketPath, { force: true });
    }
    rmSync(PID_FILE, { force: true });

    const proc = spawn(
      "Xvfb",
      [display, "-screen", "0", `${width}x${height}x24`, "-ac"],
      { detached: true, stdio: "ignore" },
    );
    proc.unref();
    if (proc.pid !== undefined) {
      writeFileSync(PID_FILE, `${proc.pid}\n`);
    }

    if (await waitForDisplay(display, 5000)) {
      return {
        display,
        stop: () => undefined,
      };
    }

    try {
      proc.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    rmSync(PID_FILE, { force: true });
    throw new Error(
      `Xvfb at ${display} did not start within 5s (display did not respond; socket ${socketPath}) — ` +
        `check that the xvfb package is installed and /tmp/.X11-unix is writable`,
    );
  });
}
