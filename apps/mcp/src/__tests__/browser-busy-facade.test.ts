import { createServer, type Server } from "node:net";
import { lstatSync, symlinkSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultBrokerSocket } from "../bot/broker/discovery.js";
import { BrokerRefusal } from "../bot/broker/refusal.js";
import { ProfileBusyError, PROFILE_BUSY_MESSAGE } from "../bot/profile.js";
import {
  BrowserBusy,
  BUSY_REFUSAL_LAYER,
  createBrowserFacade,
  mapBusyRefusal,
  openTab,
  resolveBrowserProfile,
  type AcquiredTab,
  type TabPage,
} from "../browser-busy.js";

const page: TabPage = { goto: async () => undefined };

function expectBusy(error: unknown): BrowserBusy {
  expect(error).toBeInstanceOf(BrowserBusy);
  if (!(error instanceof BrowserBusy)) throw new Error("expected BrowserBusy");
  return error;
}

function stubAcquire(overrides: Partial<AcquiredTab> = {}): () => Promise<AcquiredTab> {
  return async () => ({ page, release: async () => undefined, ...overrides });
}

describe("busy refusal mapping", () => {
  it("maps each not-now wire code onto exactly one layer", () => {
    expect(BUSY_REFUSAL_LAYER).toEqual({
      profile_busy: "profile",
      maintenance: "maintenance",
      broker_unavailable: "custody",
      incompatible_runtime: "custody",
      launch_timeout: "custody",
    });
  });

  it("wraps each not-now BrokerRefusal from acquire as that layer's BrowserBusy", async () => {
    const cases: Array<{ code: keyof typeof BUSY_REFUSAL_LAYER; layer: string }> = [
      { code: "profile_busy", layer: "profile" },
      { code: "maintenance", layer: "maintenance" },
      { code: "broker_unavailable", layer: "custody" },
      { code: "incompatible_runtime", layer: "custody" },
      { code: "launch_timeout", layer: "custody" },
    ];
    for (const { code, layer } of cases) {
      const facade = createBrowserFacade({
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
        expect(busy.message).toBe(`${code} from wire`);
        expect(busy.action().length).toBeGreaterThan(0);
        return true;
      });
    }
  });

  it("leaves a permanent failure unmapped rather than calling it retry-later", () => {
    // stale_lease means "not yours, or gone" — a retry can never clear it.
    expect(
      mapBusyRefusal(new BrokerRefusal("stale_lease", "Session is not owned")),
    ).toBeUndefined();
    expect(mapBusyRefusal(new BrokerRefusal("cancelled", "no"))).toBeUndefined();
    expect(mapBusyRefusal(new BrokerRefusal("unauthorized", "no"))).toBeUndefined();
  });

  it("passes a permanent refusal from acquire through untouched", async () => {
    const refusal = new BrokerRefusal("stale_lease", "Session is not owned by this connection");
    const facade = createBrowserFacade({
      acquire: async () => {
        throw refusal;
      },
    });
    await expect(facade.openTab({ profile: "default", purpose: "x" })).rejects.toBe(refusal);
  });

  it("keeps the profile layer's own message when a ProfileBusyError is mapped", () => {
    const mapped = mapBusyRefusal(new ProfileBusyError(PROFILE_BUSY_MESSAGE));
    expect(mapped).toBeInstanceOf(BrowserBusy);
    expect(mapped?.message).toBe(PROFILE_BUSY_MESSAGE);
    expect(mapped?.reason.layer).toBe("profile");
    expect(mapped?.action()).toBe("Close the other process using this Chrome profile, then retry.");
  });
});

describe("deadlines and cancellation — never a fixed-interval sleep", () => {
  it("aborts a hanging acquire at the deadline instead of waiting unbounded", async () => {
    let sawAbort = false;
    const facade = createBrowserFacade({
      acquire: async ({ signal }) =>
        await new Promise<AcquiredTab>((_resolve, reject) => {
          const watchdog = setTimeout(() => reject(new Error("acquire was not aborted")), 2_000);
          signal.addEventListener(
            "abort",
            () => {
              sawAbort = true;
              clearTimeout(watchdog);
              reject(signal.reason as Error);
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
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("settles on the caller's abort instead of hanging to the deadline", async () => {
    const caller = new AbortController();
    const cancelled = new Error("caller changed its mind");
    const facade = createBrowserFacade({
      // An acquire that ignores the signal entirely: the façade must still settle.
      acquire: async () => await new Promise<AcquiredTab>(() => undefined),
    });
    const started = Date.now();
    setTimeout(() => caller.abort(cancelled), 20);
    await expect(
      facade.openTab({
        profile: "default",
        purpose: "signup:vercel",
        deadlineMs: 30_000,
        signal: caller.signal,
      }),
    ).rejects.toBe(cancelled);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("returns a released tab without arming anything the next open must wait on", async () => {
    let releases = 0;
    const facade = createBrowserFacade({
      acquire: stubAcquire({
        release: async () => {
          releases += 1;
        },
      }),
    });
    const first = await facade.openTab({ profile: "default", purpose: "signup:vercel" });
    expect(first.purpose).toBe("signup:vercel");
    // A live broker multiplexes tab families: a second open is not refused
    // just because the first is still held.
    const second = await facade.openTab({ profile: "default", purpose: "signup:other" });
    await first.release();
    await first.release();
    await second.release();
    expect(releases).toBe(2);
  });
});

describe("browserBusy — a strictly read-only fold", () => {
  const sockets: Server[] = [];
  const profiles: string[] = [];
  let configuredSocket: string | undefined;

  beforeEach(() => {
    configuredSocket = process.env.TRUSTY_SQUIRE_BROKER_SOCKET;
    delete process.env.TRUSTY_SQUIRE_BROKER_SOCKET;
  });

  afterEach(async () => {
    if (configuredSocket === undefined) delete process.env.TRUSTY_SQUIRE_BROKER_SOCKET;
    else process.env.TRUSTY_SQUIRE_BROKER_SOCKET = configuredSocket;
    for (const server of sockets.splice(0))
      await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const dir of profiles.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  async function newProfile(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "ts-browser-busy-"));
    profiles.push(dir);
    return dir;
  }

  async function listenAsBroker(profile: string): Promise<void> {
    const path = defaultBrokerSocket(resolveBrowserProfile(profile));
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const server = createServer(() => undefined);
    sockets.push(server);
    await new Promise<void>((resolve) => server.listen(path, resolve));
  }

  it("reports the live lock holder when nothing brokers the profile", async () => {
    const dir = await newProfile();
    symlinkSync(`${hostname()}-${process.pid}`, join(dir, "SingletonLock"));
    const status = await createBrowserFacade().browserBusy({ profile: dir });
    expect(status).toEqual({
      busy: true,
      reason: {
        layer: "profile",
        code: "profile_busy",
        holder: { pid: process.pid, host: hostname() },
      },
    });
    if (!status.busy) throw new Error("expected busy");
    expect(status.reason.layer).toBe("profile");
    expect(new BrowserBusy(status.reason).action()).toBe(
      `Close the other process using this Chrome profile (pid ${process.pid}), then retry.`,
    );
  });

  it("does not call a live broker's own Chrome a foreign process to close", async () => {
    const dir = await newProfile();
    symlinkSync(`${hostname()}-${process.pid}`, join(dir, "SingletonLock"));
    await listenAsBroker(dir);
    await expect(createBrowserFacade().browserBusy({ profile: dir })).resolves.toEqual({
      busy: false,
    });
  });

  it("never repairs a reclaimable lock while reading", async () => {
    const dir = await newProfile();
    const lock = join(dir, "SingletonLock");
    // A dead pid on this host. The old fold reclaimed the lock — and awaited
    // the orphan-owner sweep, which SIGTERMs/SIGKILLs process trees — as a
    // side effect of answering a status question.
    symlinkSync(`${hostname()}-21474836`, lock);
    await expect(createBrowserFacade().browserBusy({ profile: dir })).resolves.toEqual({
      busy: false,
    });
    expect(lstatSync(lock).isSymbolicLink()).toBe(true);
  });

  it("reads free when no lock and no broker answer", async () => {
    const dir = await newProfile();
    await expect(createBrowserFacade().browserBusy({ profile: dir })).resolves.toEqual({
      busy: false,
    });
  });
});

describe("openTab reaches the broker, not an in-process latch", () => {
  it("refuses a profile the single-profile broker cannot serve", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ts-browser-busy-other-"));
    try {
      await expect(openTab({ profile: dir, purpose: "signup:vercel" })).rejects.toSatisfy(
        (error: unknown) => {
          const busy = expectBusy(error);
          expect(busy.reason).toMatchObject({ layer: "custody", code: "incompatible_runtime" });
          expect(busy.action()).toBe(
            "Finish the sessions that pin this browser identity, then retry.",
          );
          return true;
        },
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
