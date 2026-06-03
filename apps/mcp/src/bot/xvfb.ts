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

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface XvfbRig {
  display: string;
  stop: () => void;
}

export function xvfbAvailable(): boolean {
  return binaryOnPath("Xvfb");
}

// First :N (200..220) whose X socket is free. The login flow uses
// :99..:120 — we sit above that to reduce the chance of collision if
// a login and a signup happen to overlap on the same box.
function pickFreeDisplay(): string {
  for (let n = 200; n <= 220; n++) {
    if (!existsSync(`/tmp/.X11-unix/X${n}`)) return `:${n}`;
  }
  throw new Error("no free X display number in :200..:220");
}

function binaryOnPath(bin: string): boolean {
  const paths = (process.env.PATH ?? "").split(":");
  return paths.some((p) => p.length > 0 && existsSync(join(p, bin)));
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
  const display = pickFreeDisplay();
  const displayNum = display.slice(1);

  const proc = spawn(
    "Xvfb",
    [display, "-screen", "0", `${width}x${height}x24`, "-ac"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  proc.unref();

  // Poll for the X socket to appear — Xvfb is "ready" once it's
  // listening on /tmp/.X11-unix/X<n>. Max 5s.
  const socketPath = `/tmp/.X11-unix/X${displayNum}`;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (existsSync(socketPath)) {
      return {
        display,
        stop: () => {
          try {
            proc.kill("SIGTERM");
          } catch {
            // already dead
          }
        },
      };
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  // Did not come up — kill the process and surface what went wrong.
  try {
    proc.kill("SIGTERM");
  } catch {
    /* ignore */
  }
  throw new Error(
    `Xvfb at ${display} did not start within 5s (socket ${socketPath} never appeared) — ` +
      `check that the xvfb package is installed and /tmp/.X11-unix is writable`,
  );
}
