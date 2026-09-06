import type * as Reaper from "../owner-process-reaper.js";
import type * as Runtime from "../browser-process-runtime.js";
import type * as Profile from "../profile.js";
import { EventEmitter } from "node:events";
import type { Browser, BrowserContext, Page } from "playwright";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserController } from "../browser.js";
import type { BrowserProcessOwner } from "../browser-process-owner.js";
import type { OwnedChromeProcessTreeProof } from "../browser-process-runtime.js";
import type { PageDriver } from "../page-driver.js";
import type { ProfileProcessIdentity } from "../profile.js";

const h = vi.hoisted(() => ({ events: [] as string[], markerClosed: true }));
vi.mock("../owner-process-reaper.js", async (original) => ({
  ...(await original<typeof Reaper>()),
  markOwnerBrowserLaunchTerminal: () => h.events.push("terminal"),
  terminateOwnerBrowserLaunch: async () => {
    h.events.push("orphan-cleanup");
    return h.markerClosed;
  },
  untrackOwnerBrowserLaunch: () => h.events.push("untrack-launch"),
}));
vi.mock("../browser-process-runtime.js", async (original) => ({
  ...(await original<typeof Runtime>()),
  signalOwnedChromeProcessTree: (_identity: unknown, _group: boolean, signal: string) => {
    h.events.push(signal);
    return true;
  },
  ownedChromeProcessTreeState: () => "stale",
  releaseOwnedChromeProcessTree: () => h.events.push("release-proof"),
}));
vi.mock("../profile.js", async (original) => ({
  ...(await original<typeof Profile>()),
  closeProfileWithProof: async (opts: { close(): Promise<void> }) => {
    await opts.close();
    return "closed";
  },
}));

// The fixture supplies only the Playwright transport methods exercised by close.
// Private custody is seeded so these tests cannot launch or signal real Chrome.
function fixture() {
  const controller = new BrowserController({ profileDir: "/unused/boundary-profile" });
  const { processOwner: owner, pageDriver: pages } = controller as unknown as {
    processOwner: BrowserProcessOwner;
    pageDriver: PageDriver;
  };
  const custody = owner as unknown as {
    cdpBrowser: Browser;
    ownerLaunchTracked: boolean;
    ownedChromeProcessTreeProof: OwnedChromeProcessTreeProof;
    startBrowser(): Promise<void>;
    startLaunchCommitted: boolean;
  };
  const emitter = new EventEmitter();
  const page = Object.assign(emitter, {
    isClosed: () => false,
    close: vi.fn(async () => {
      h.events.push("page-close");
    }),
  }) as unknown as Page;
  const context = {
    close: vi.fn(async () => {
      h.events.push("context-close");
    }),
  } as unknown as BrowserContext;
  const browser = {
    isConnected: () => true,
    close: vi.fn(async () => {
      h.events.push("transport-close");
    }),
  } as unknown as Browser;
  const identity: ProfileProcessIdentity = {
    host: "fixture",
    pid: 999999999,
    start_time: "fixture",
    user_data_dir: "/unused/boundary-profile",
  };
  pages.page = page;
  pages.primaryPage = page;
  pages.trackOpenedTabs(page);
  owner.context = context;
  custody.cdpBrowser = browser;
  custody.ownerLaunchTracked = true;
  custody.ownedChromeProcessTreeProof = { identity, processGroup: true, members: [] };
  const dispose = pages.disposeRegistrations.bind(pages);
  vi.spyOn(pages, "disposeRegistrations").mockImplementation(() => {
    h.events.push("dispose-pages");
    dispose();
  });
  return { controller, owner, pages, custody, page, context, browser, emitter };
}

beforeEach(() => {
  h.events = [];
  h.markerClosed = true;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("exclusive process/page boundary through BrowserController", () => {
  it("disposes page registration without terminating process custody", () => {
    const { controller, pages, page, emitter } = fixture();
    pages.disposeRegistrations();
    expect(pages.ownedPages.has(page)).toBe(false);
    expect(emitter.listenerCount("popup")).toBe(0);
    expect(emitter.listenerCount("domcontentloaded")).toBe(0);
    expect(controller.isConnected()).toBe(true);
    expect(h.events).toEqual(["dispose-pages"]);
  });

  it("preserves disposal, terminal marking, SIGTERM, page/context/transport close, proof and orphan cleanup order", async () => {
    const { controller, pages } = fixture();
    await expect(controller.close()).resolves.toBe("closed");
    expect(h.events).toEqual([
      "dispose-pages",
      "terminal",
      "SIGTERM",
      "page-close",
      "context-close",
      "transport-close",
      "release-proof",
      "orphan-cleanup",
      "untrack-launch",
    ]);
    expect(pages.page).toBeNull();
    expect(pages.primaryPage).toBeNull();
    expect(controller.isConnected()).toBe(false);
    await controller.close();
    expect(h.events.filter((event) => event === "orphan-cleanup")).toHaveLength(1);
  });

  it("still checks orphan custody after a page close rejects and retains an unproven launch", async () => {
    const { controller, page } = fixture();
    vi.mocked(page.close).mockRejectedValue(new Error("CDP target closed"));
    h.markerClosed = false;
    await expect(controller.close()).resolves.toBe("force_closed_unproven");
    expect(h.events).toContain("context-close");
    expect(h.events).toContain("transport-close");
    expect(h.events).toContain("orphan-cleanup");
    expect(h.events).not.toContain("untrack-launch");
  });

  it("closes a late attached context after cancellation without reacquiring disposed pages", async () => {
    vi.stubEnv("BOT_CDP_ENDPOINT", "http://fixture.invalid"); // no local watchdog
    const { controller, owner, pages, custody } = fixture();
    let releaseStart: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    custody.startBrowser = async () => {
      custody.startLaunchCommitted = true;
      await gate;
      owner.context = {
        close: async () => {
          h.events.push("late-context-close");
        },
      } as unknown as BrowserContext;
    };
    const starting = controller.start().catch((error: unknown) => error);
    await expect(controller.close({ cancelStart: true })).resolves.toBe("closed");
    releaseStart();
    await expect(starting).resolves.toMatchObject({ message: "BrowserController start cancelled" });
    await controller.waitForCancelledStartQuiescence();
    expect(h.events.indexOf("late-context-close")).toBeGreaterThan(
      h.events.indexOf("orphan-cleanup"),
    );
    expect(h.events.filter((event) => event === "orphan-cleanup")).toHaveLength(1);
    expect(pages.ownedPages.live()).toEqual([]);
    expect(pages.page).toBeNull();
    expect(owner.context).toBeNull();
  });
});
