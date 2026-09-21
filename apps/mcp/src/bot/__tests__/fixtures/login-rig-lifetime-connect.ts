// Stand-in for a detached `connect` that has stood up the ceremony helpers
// and then sits — the never-polled / wedged-before-poll case. The rig-owned
// lifetime must reap those helpers even if this process is still alive.

import { writeFileSync } from "node:fs";
import { registerRemoteLoginRigCleanup, type RemoteLoginRig } from "../../remote-login-display.js";
import { spawnOwnerTrackedHelper } from "../../owner-process-reaper.js";

const statusPath = process.argv[2];
if (statusPath === undefined || statusPath.length === 0) process.exit(2);

// The production lifetime is a constant, so the short one this repro needs is
// the fixture's own knob — read here and handed in, never read by the bound.
const lifetimeMs = Number(process.env.LOGIN_RIG_FIXTURE_LIFETIME_MS);
if (!Number.isFinite(lifetimeMs) || lifetimeMs <= 0) process.exit(2);

const helpers = ["xvfb", "x11vnc", "websockify", "cloudflared"].map((role) => {
  const child = spawnOwnerTrackedHelper(
    process.execPath,
    ["-e", "setInterval(() => undefined, 1000)"],
    { stdio: "ignore" },
  );
  if (child.pid === undefined) throw new Error(`${role} helper did not expose a pid`);
  return { role, pid: child.pid, child };
});

const rig: RemoteLoginRig = {
  display: ":99",
  width: 720,
  height: 1280,
  procs: helpers.map((helper) => helper.child),
  binaries: {
    xvfb: "/unused/Xvfb",
    x11vnc: "/unused/x11vnc",
    websockify: "/unused/websockify",
    cloudflared: "/unused/cloudflared",
  },
};

registerRemoteLoginRigCleanup(rig, () => undefined, { lifetimeMs });

writeFileSync(
  statusPath,
  `${JSON.stringify({
    connect: process.pid,
    helpers: helpers.map((helper) => ({ role: helper.role, pid: helper.pid })),
  })}\n`,
);

setInterval(() => undefined, 1000);
