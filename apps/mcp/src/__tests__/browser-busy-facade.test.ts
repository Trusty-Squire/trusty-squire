import { symlinkSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrokerRefusal } from "../bot/broker/refusal.js";
import { ProfileBusyError } from "../bot/profile.js";
import {
  BrowserBusy,
  BUSY_REFUSAL_LAYER,
  createBrowserFacade,
  mapBusyRefusal,
  type AcquiredTab,
  type BrowserBusyReason,
  type TabPage,
} from "../browser.js";

const page: TabPage = { goto: async () => undefined };

function expectBusy(error: unknown): BrowserBusy {
  expect(error).toBeInstanceOf(BrowserBusy);
  if (!(error instanceof BrowserBusy)) throw new Error("expected BrowserBusy");
  return error;
}

function stubAcquire(overrides: Partial<AcquiredTab> = {}): () => Promise<AcquiredTab> {
  return async () => ({
    page,
    release: async () => undefined,
    ...overrides,
  });
}

function idleInspect(busy?: {
  tabs?: BrowserBusyReason;
  profile?: BrowserBusyReason;
  maintenance?: BrowserBusyReason;
  custody?: BrowserBusyReason;
}) {
  return {
    tabs: () => busy?.tabs,
    profile: () => busy?.profile,
    maintenance: () => busy?.maintenance,
    custody: () => busy?.custody,
  };
}

describe("browserBusy / openTab — one layer at a time", () => {
  it("reports tabs and throws BrowserBusy with a holder action when only a tab family is held", async () => {
    const reason: BrowserBusyReason = {
      layer: "tabs",
      code: "stale_lease",
      holder: { purpose: "signup:vercel", sessionId: "sess-1" },
    };
    const facade = createBrowserFacade({
      inspect: idleInspect({ tabs: reason }),
      acquire: stubAcquire(),
    });
    await expect(facade.browserBusy({ profile: "default" })).resolves.toEqual({
      busy: true,
      reason,
    });
    await expect(facade.openTab({ profile: "default", purpose: "signup:other" })).rejects.toSatisfy(
      (error: unknown) => {
        const busy = expectBusy(error);
        expect(busy.reason).toEqual(reason);
        expect(busy.action()).toBe("Release the tab held for signup:vercel, then retry.");
        return true;
      },
    );
  });

  it("reports profile and throws BrowserBusy naming the holder pid when only the profile lease is held", async () => {
    const reason: BrowserBusyReason = {
      layer: "profile",
      code: "profile_busy",
      holder: { pid: 4242 },
    };
    const facade = createBrowserFacade({
      inspect: idleInspect({ profile: reason }),
      acquire: stubAcquire(),
    });
    await expect(facade.browserBusy({ profile: "/tmp/profile" })).resolves.toEqual({
      busy: true,
      reason,
    });
    await expect(
      facade.openTab({ profile: "/tmp/profile", purpose: "signup:vercel" }),
    ).rejects.toSatisfy((error: unknown) => {
      const busy = expectBusy(error);
      expect(busy.reason).toEqual(reason);
      expect(busy.action()).toBe(
        "Close the other process using this Chrome profile (pid 4242), then retry.",
      );
      return true;
    });
  });

  it("reports maintenance and throws BrowserBusy with a connect action when only the login window is owned", async () => {
    const reason: BrowserBusyReason = {
      layer: "maintenance",
      code: "maintenance",
      owner: "client-9",
    };
    const facade = createBrowserFacade({
      inspect: idleInspect({ maintenance: reason }),
      acquire: stubAcquire(),
    });
    await expect(facade.browserBusy({ profile: "default" })).resolves.toEqual({
      busy: true,
      reason,
    });
    await expect(facade.openTab({ profile: "default", purpose: "signup:vercel" })).rejects.toSatisfy(
      (error: unknown) => {
        const busy = expectBusy(error);
        expect(busy.reason).toEqual(reason);
        expect(busy.action()).toBe(
          "Finish the connect login window that owns maintenance, then retry.",
        );
        return true;
      },
    );
  });

  it("reports custody and throws BrowserBusy with a broker action when only the custody latch refuses", async () => {
    const reason: BrowserBusyReason = {
      layer: "custody",
      code: "broker_unavailable",
      detail: "no listener",
    };
    const facade = createBrowserFacade({
      inspect: idleInspect({ custody: reason }),
      acquire: stubAcquire(),
    });
    await expect(facade.browserBusy({ profile: "default" })).resolves.toEqual({
      busy: true,
      reason,
    });
    await expect(facade.openTab({ profile: "default", purpose: "signup:vercel" })).rejects.toSatisfy(
      (error: unknown) => {
        const busy = expectBusy(error);
        expect(busy.reason).toEqual(reason);
        expect(busy.action()).toBe("Start or reconnect the operator broker, then retry.");
        return true;
      },
    );
  });
});

describe("busy refusal mapping", () => {
  it("maps each not-now wire code onto exactly one layer", () => {
    expect(BUSY_REFUSAL_LAYER).toEqual({
      stale_lease: "tabs",
      profile_busy: "profile",
      maintenance: "maintenance",
      broker_unavailable: "custody",
      incompatible_runtime: "custody",
      launch_timeout: "custody",
    });
  });

  it("wraps each not-now BrokerRefusal from acquire as that layer's BrowserBusy", async () => {
    const cases: Array<{ code: keyof typeof BUSY_REFUSAL_LAYER; layer: BrowserBusyReason["layer"] }> =
      [
        { code: "stale_lease", layer: "tabs" },
        { code: "profile_busy", layer: "profile" },
        { code: "maintenance", layer: "maintenance" },
        { code: "broker_unavailable", layer: "custody" },
        { code: "incompatible_runtime", layer: "custody" },
        { code: "launch_timeout", layer: "custody" },
      ];
    for (const { code, layer } of cases) {
      const facade = createBrowserFacade({
        inspect: idleInspect(),
        acquire: async () => {
          throw new BrokerRefusal(code, `${code} from wire`);
        },
      });
      await expect(
        facade.openTab({ profile: "default", purpose: "signup:vercel" }),
      ).rejects.toSatisfy((error: unknown) => {
        const busy = expectBusy(error);
        expect(busy.reason.layer).toBe(layer);
        expect(busy.reason.code).toBe(code);
        expect(busy.action().length).toBeGreaterThan(0);
        return true;
      });
    }
  });

  it("maps ProfileBusyError onto the profile layer and leaves other refusals unmapped", () => {
    const mapped = mapBusyRefusal(new ProfileBusyError("profile held"));
    expect(mapped).toBeInstanceOf(BrowserBusy);
    expect(mapped?.reason.layer).toBe("profile");
    expect(mapBusyRefusal(new BrokerRefusal("unauthorized", "no"))).toBeUndefined();
  });
});

describe("deadlines — never a fixed-interval sleep", () => {
  it("resolves inspect and a busy openTab without waiting out a deadline or poll", async () => {
    vi.useFakeTimers();
    try {
      const reason: BrowserBusyReason = {
        layer: "maintenance",
        code: "maintenance",
        owner: "connect",
      };
      const facade = createBrowserFacade({
        inspect: idleInspect({ maintenance: reason }),
        acquire: stubAcquire(),
      });
      await expect(facade.browserBusy({ profile: "default" })).resolves.toEqual({
        busy: true,
        reason,
      });
      await expect(
        facade.openTab({ profile: "default", purpose: "x", deadlineMs: 60_000 }),
      ).rejects.toBeInstanceOf(BrowserBusy);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts a hanging acquire at the deadline instead of waiting unbounded", async () => {
    const abortRegistered = vi.fn();
    let sawAbort = false;
    const facade = createBrowserFacade({
      inspect: idleInspect(),
      abortRegistered,
      acquire: ({ signal }) =>
        new Promise((_resolve, reject) => {
          const watchdog = setTimeout(() => reject(new Error("acquire was not aborted")), 2_000);
          signal.addEventListener(
            "abort",
            () => {
              sawAbort = true;
              clearTimeout(watchdog);
              reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
            },
            { once: true },
          );
        }),
    });
    const started = Date.now();
    await expect(
      facade.openTab({ profile: "default", purpose: "signup:vercel", deadlineMs: 40 }),
    ).rejects.toSatisfy((error: unknown) => {
      const busy = expectBusy(error);
      expect(busy.reason).toMatchObject({ layer: "custody", code: "launch_timeout" });
      expect(busy.action()).toBe(
        "Retry the launch; the previous attempt was aborted at its deadline.",
      );
      return true;
    });
    expect(sawAbort).toBe(true);
    expect(abortRegistered).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("end-to-end on a real profile", () => {
  let profile: string | undefined;
  afterEach(async () => {
    if (profile !== undefined) await rm(profile, { recursive: true, force: true });
  });

  it("names the holder and its purpose when a second acquisition hits an open tab", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ts-browser-busy-"));
    profile = dir;
    const facade = createBrowserFacade({
      inspect: {
        profile: async () => undefined,
        maintenance: () => undefined,
        custody: () => undefined,
      },
      acquire: stubAcquire(),
    });
    const tab = await facade.openTab({ profile: dir, purpose: "signup:vercel" });
    expect(tab.purpose).toBe("signup:vercel");
    expect(await facade.browserBusy({ profile: dir })).toEqual({
      busy: true,
      reason: {
        layer: "tabs",
        code: "stale_lease",
        holder: { purpose: "signup:vercel" },
      },
    });
    await expect(facade.openTab({ profile: dir, purpose: "signup:other" })).rejects.toSatisfy(
      (error: unknown) => {
        const busy = expectBusy(error);
        expect(busy.reason).toEqual({
          layer: "tabs",
          code: "stale_lease",
          holder: { purpose: "signup:vercel" },
        });
        expect(busy.action()).toBe("Release the tab held for signup:vercel, then retry.");
        return true;
      },
    );
    await tab.release();
    await expect(facade.browserBusy({ profile: dir })).resolves.toEqual({ busy: false });
  });

  it("default profile inspect reports only the SingletonLock holder", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ts-browser-busy-lock-"));
    profile = dir;
    symlinkSync(`${hostname()}-${process.pid}`, join(dir, "SingletonLock"));
    const facade = createBrowserFacade({
      inspect: {
        tabs: () => undefined,
        maintenance: () => undefined,
        custody: () => undefined,
      },
      acquire: stubAcquire(),
    });
    const status = await facade.browserBusy({ profile: dir });
    expect(status.busy).toBe(true);
    if (!status.busy) throw new Error("expected profile busy");
    expect(status.reason.layer).toBe("profile");
    expect(status.reason.code).toBe("profile_busy");
    if (status.reason.layer !== "profile") throw new Error("expected profile reason");
    expect(status.reason.holder?.pid).toBe(process.pid);
    await expect(facade.openTab({ profile: dir, purpose: "signup:vercel" })).rejects.toBeInstanceOf(
      BrowserBusy,
    );
  });
});
