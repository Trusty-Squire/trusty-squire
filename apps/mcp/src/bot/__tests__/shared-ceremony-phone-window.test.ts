import type { Page } from "playwright";
import type * as ProfileModule from "../profile.js";
import type * as OwnerProcessReaperModule from "../owner-process-reaper.js";
import type * as RemoteLoginDisplayModule from "../remote-login-display.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resizeCeremonyWindow, PHONE_CEREMONY_CLIP } from "../ceremony-window.js";

const fixture = vi.hoisted(() => ({
  clip: undefined as unknown,
  events: [] as string[],
  attachFails: false,
}));

vi.mock("../profile.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ProfileModule>()),
  currentProfileHolderPid: () => 12345,
}));
vi.mock("../owner-process-reaper.js", async (importOriginal) => ({
  ...(await importOriginal<typeof OwnerProcessReaperModule>()),
  ownerTrackedBrowserDisplay: () => ({
    display: ":88",
    authFile: "/tmp/tsq-login-phone-fixture/xauthority",
  }),
}));
vi.mock("../remote-login-display.js", async (importOriginal) => ({
  ...(await importOriginal<typeof RemoteLoginDisplayModule>()),
  createRemoteLoginRig: () => ({
    width: 720,
    height: 1280,
    procs: [],
    binaries: { xvfb: "unused", x11vnc: "unused", websockify: "unused" },
  }),
  createRemoteLoginVncSecrets: () => undefined,
  registerRemoteLoginRigCleanup: () => () => undefined,
  exposeRemoteLoginDisplay: async (_rig: unknown, clip: unknown) => {
    fixture.clip = clip;
    if (fixture.attachFails) throw new Error("attach failed");
    return "https://fixture.invalid/#p=secret";
  },
  teardownRemoteLoginRig: async () => {
    fixture.events.push("teardown");
  },
}));

import { exposeSharedBrokerCeremonyDisplay } from "../google-login.js";

afterEach(() => {
  fixture.clip = undefined;
  fixture.events = [];
  fixture.attachFails = false;
  vi.unstubAllEnvs();
});

describe("shared broker phone ceremony", () => {
  it("sets phone window bounds over the ceremony tab's CDP connection and restores the old bounds", async () => {
    const original = { left: 36, top: 44, width: 1280, height: 1024, windowState: "normal" };
    const windowCommands: Array<{ method: string; params: unknown }> = [];
    const windowSession = {
      send: vi.fn(async (method: string, params: unknown) => {
        windowCommands.push({ method, params });
        if (method === "Browser.getWindowForTarget") return { windowId: 7, bounds: original };
        if (method === "Browser.getWindowBounds")
          return { bounds: { left: 0, top: 0, width: 501, height: 932 } };
        return undefined;
      }),
      detach: vi.fn(async () => undefined),
    };
    const targetSession = {
      send: vi.fn(async () => ({ targetInfo: { targetId: "ceremony-tab" } })),
      detach: vi.fn(async () => undefined),
    };
    const page = {
      context: () => ({
        browser: () => ({ newBrowserCDPSession: async () => windowSession }),
        newCDPSession: async () => targetSession,
      }),
    } as unknown as Page;

    const resized = await resizeCeremonyWindow(page);
    // Chrome can clamp a requested size; stream what it actually rendered.
    expect(resized.clip).toEqual({ left: 0, top: 0, width: 501, height: 932 });
    expect(windowCommands).toEqual([
      { method: "Browser.getWindowForTarget", params: { targetId: "ceremony-tab" } },
      {
        method: "Browser.setWindowBounds",
        params: { windowId: 7, bounds: { windowState: "normal", ...PHONE_CEREMONY_CLIP } },
      },
      { method: "Browser.getWindowBounds", params: { windowId: 7 } },
    ]);
    await resized.restore();
    await resized.restore();
    expect(windowCommands.at(-1)).toEqual({
      method: "Browser.setWindowBounds",
      params: { windowId: 7, bounds: original },
    });
    expect(windowSession.detach).toHaveBeenCalledTimes(1);
  });

  it("normalizes a maximized window before sizing it and restores its state", async () => {
    const calls: unknown[] = [];
    const cdp = {
      send: vi.fn(async (method: string, params: unknown) => {
        if (method === "Browser.getWindowForTarget")
          return { windowId: 9, bounds: { windowState: "maximized" } };
        if (method === "Browser.getWindowBounds")
          return { bounds: { left: 0, top: 0, width: 500, height: 932 } };
        calls.push(params);
        return undefined;
      }),
      detach: vi.fn(async () => undefined),
    };
    const page = {
      context: () => ({
        browser: () => ({ newBrowserCDPSession: async () => cdp }),
        newCDPSession: async () => ({
          send: async () => ({ targetInfo: { targetId: "ceremony-tab" } }),
          detach: async () => undefined,
        }),
      }),
    } as unknown as Page;

    const resized = await resizeCeremonyWindow(page);
    await resized.restore();
    expect(calls).toEqual([
      { windowId: 9, bounds: { windowState: "normal" } },
      { windowId: 9, bounds: { windowState: "normal", ...PHONE_CEREMONY_CLIP } },
      { windowId: 9, bounds: { windowState: "maximized" } },
    ]);
  });

  it("passes the phone rectangle to noVNC and restores after the exposure stops", async () => {
    vi.stubEnv("DISPLAY", "");
    const exposure = await exposeSharedBrokerCeremonyDisplay("/unused/profile", undefined, {
      showPhone: async () => {
        fixture.events.push("resize");
        return PHONE_CEREMONY_CLIP;
      },
      restore: async () => {
        fixture.events.push("restore");
      },
    });
    expect(exposure.kind).toBe("exposed");
    expect(fixture.clip).toEqual({ left: 0, top: 0, width: 500, height: 932 });
    if (exposure.kind === "exposed") await exposure.stop();
    expect(fixture.events).toEqual(["resize", "teardown", "restore"]);
  });

  it("restores the broker window if the noVNC attach fails", async () => {
    vi.stubEnv("DISPLAY", "");
    fixture.attachFails = true;
    const exposure = await exposeSharedBrokerCeremonyDisplay("/unused/profile", undefined, {
      showPhone: async () => {
        fixture.events.push("resize");
        return PHONE_CEREMONY_CLIP;
      },
      restore: async () => {
        fixture.events.push("restore");
      },
    });
    expect(exposure.kind).toBe("unshowable");
    expect(fixture.events).toEqual(["resize", "teardown", "restore"]);
  });
});
