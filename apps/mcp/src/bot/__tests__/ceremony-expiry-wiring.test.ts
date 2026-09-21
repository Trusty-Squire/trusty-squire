// The rig-owned lifetime only helps a wedged ceremony if the run that stood
// the rig up actually hands its reporter to `registerRemoteLoginRigCleanup`.
// Both halves are covered elsewhere — the timer fires `onExpired` before
// exiting (remote-login-display.test.ts) and `reportCeremonyExpired` writes
// the terminal line (install-targets-e2e.test.ts) — so this pins the seam
// between them, which no other test reaches: the wedge is an eleven-minute
// timer on a run whose tunnel never came up.

import { describe, expect, it, vi } from "vitest";
import type { LoginRigCleanupOptions, RemoteLoginRig } from "../remote-login-display.js";

const rigStub: RemoteLoginRig = {
  display: ":99",
  width: 720,
  height: 1280,
  procs: [],
  binaries: {
    xvfb: "/unused/Xvfb",
    x11vnc: "/unused/x11vnc",
    websockify: "/unused/websockify",
    cloudflared: "/unused/cloudflared",
  },
};

const rigCleanup = vi.hoisted(() => ({
  options: undefined as LoginRigCleanupOptions | undefined,
}));

// The tunnel this run never gets. Held open so the assertions run in exactly
// the state the bound exists for: browser up, display unpublished.
const exposure = vi.hoisted(() => {
  let started: (() => void) | undefined;
  const reached = new Promise<void>((resolve) => {
    started = resolve;
  });
  return { reached, start: (): void => started?.() };
});

vi.mock("../remote-login-display.js", () => ({
  createRemoteLoginRig: vi.fn(() => rigStub),
  registerRemoteLoginRigCleanup: vi.fn(
    (_rig: RemoteLoginRig, _teardown: unknown, options: LoginRigCleanupOptions) => {
      rigCleanup.options = options;
      return (): void => undefined;
    },
  ),
  startRemoteLoginDisplay: vi.fn(async () => undefined),
  remoteLoginEnvironment: vi.fn(() => ({})),
  exposeRemoteLoginDisplay: vi.fn(async () => {
    exposure.start();
    return await new Promise<string>(() => undefined);
  }),
  teardownRemoteLoginRig: vi.fn(async () => undefined),
  assertRemoteLoginRigLive: vi.fn(),
  createRemoteLoginVncSecrets: vi.fn(),
}));

const { runRemoteLoginChrome } = await import("../google-login.js");

describe("ceremony expiry reporting is wired to the run that owns the rig", () => {
  it("hands the launched ceremony Chrome's pid to the expiry reporter", async () => {
    const onCeremonyExpired = vi.fn();
    void runRemoteLoginChrome(
      {
        profileDir: "/unused/profile",
        url: "https://example.test/install",
        deadline: Date.now() + 60_000,
        pollUntilDone: async () => false,
        bannerLabel: "Complete sign-in.",
        onCeremonyExpired,
      },
      {
        launchCeremonyBrowserContext: vi.fn(async () => ({
          identity: {
            host: "test-host",
            pid: 4242,
            start_time: "1",
            user_data_dir: "/unused/profile",
          },
          isRunning: () => true,
          teardown: async () => undefined,
          forceTeardown: async () => undefined,
        })),
      },
    );

    await exposure.reached;
    expect(rigCleanup.options?.onExpired).toBeTypeOf("function");
    rigCleanup.options?.onExpired?.();
    expect(onCeremonyExpired).toHaveBeenCalledWith(4242);
  });
});
