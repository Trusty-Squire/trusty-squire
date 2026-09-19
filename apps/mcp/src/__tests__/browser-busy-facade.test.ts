import { createServer, type Server } from "node:net";
import { lstatSync, symlinkSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { brokerSocketPath } from "../bot/broker/discovery.js";
import { BrokerRefusal } from "../bot/broker/refusal.js";
import {
  CHROME_PROFILE_DIR,
  ProfileBusyError,
  profilePathIdentity,
  PROFILE_BUSY_MESSAGE,
} from "../bot/profile.js";
import {
  BrowserBusy,
  createBrowserFacade,
  openTab,
  UnservableProfileError,
  type AcquiredTab,
  type TabPage,
} from "../browser-busy.js";

const page: TabPage = { goto: async () => undefined };

/** The one physical profile the broker serves, read from its own owner. */
function servedProfile(): string {
  return profilePathIdentity(CHROME_PROFILE_DIR);
}

function refusingFacade(error: unknown) {
  return createBrowserFacade({
    acquire: async () => {
      throw error;
    },
  });
}

function expectBusy(error: unknown): BrowserBusy {
  expect(error).toBeInstanceOf(BrowserBusy);
  if (!(error instanceof BrowserBusy)) throw new Error("expected BrowserBusy");
  return error;
}

function stubAcquire(overrides: Partial<AcquiredTab> = {}): () => Promise<AcquiredTab> {
  return async () => ({ page, release: async () => undefined, ...overrides });
}

describe("busy refusal mapping", () => {
  it("wraps each not-now BrokerRefusal from acquire as that layer's BrowserBusy", async () => {
    const cases = [
      { code: "profile_busy", layer: "profile" },
      { code: "maintenance", layer: "maintenance" },
      { code: "broker_unavailable", layer: "custody" },
      { code: "incompatible_runtime", layer: "custody" },
      { code: "launch_timeout", layer: "custody" },
    ];
    for (const { code, layer } of cases) {
      const facade = refusingFacade(new BrokerRefusal(code, `${code} from wire`));
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

  it("hands a permanent refusal back whole rather than calling it retry-later", async () => {
    // Each of these is "not yours, gone, or a standing configuration choice".
    // A retry can never clear one, so none may arrive as a busy layer with an
    // .action() telling the caller to try again.
    const refusals = [
      new BrokerRefusal("stale_lease", "Session is not owned by this connection"),
      new BrokerRefusal("cancelled", "Caller cancelled the request"),
      new BrokerRefusal("unauthorized", "Connect before using the broker"),
      new BrokerRefusal("external_browser", "BOT_CDP_ENDPOINT names an external Chrome"),
    ];
    for (const refusal of refusals) {
      await expect(
        refusingFacade(refusal).openTab({ profile: "default", purpose: "signup:vercel" }),
      ).rejects.toSatisfy((error: unknown) => {
        expect(error).toBe(refusal);
        expect(error).not.toBeInstanceOf(BrowserBusy);
        return true;
      });
    }
  });

  it("keeps the profile layer's own message when a ProfileBusyError surfaces", async () => {
    const facade = refusingFacade(new ProfileBusyError(PROFILE_BUSY_MESSAGE));
    await expect(
      facade.openTab({ profile: "default", purpose: "signup:vercel" }),
    ).rejects.toSatisfy((error: unknown) => {
      const busy = expectBusy(error);
      expect(busy.message).toBe(PROFILE_BUSY_MESSAGE);
      expect(busy.reason.layer).toBe("profile");
      expect(busy.action()).toBe("Close the other process using this Chrome profile, then retry.");
      return true;
    });
  });
});

describe("a profile this installation does not serve", () => {
  it("is a permanent configuration failure, not a busy layer to retry", async () => {
    const other = await mkdtemp(join(tmpdir(), "ts-browser-busy-other-"));
    try {
      let acquired = false;
      const facade = createBrowserFacade({
        acquire: async () => {
          acquired = true;
          return { page, release: async () => undefined };
        },
      });
      await expect(facade.openTab({ profile: other, purpose: "signup:vercel" })).rejects.toSatisfy(
        (error: unknown) => {
          expect(error).toBeInstanceOf(UnservableProfileError);
          expect(error).not.toBeInstanceOf(BrowserBusy);
          if (!(error instanceof UnservableProfileError)) throw new Error("expected refusal");
          expect(error.served).toBe(servedProfile());
          expect(error.message).toContain(servedProfile());
          return true;
        },
      );
      expect(acquired).toBe(false);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it("reaches the broker for the profile it does serve", async () => {
    // No broker is running under the sandboxed profile, so the default wire
    // acquire must get as far as the broker and fail there, not at a guard.
    await expect(
      openTab({ profile: "default", purpose: "signup:vercel" }),
    ).rejects.not.toBeInstanceOf(UnservableProfileError);
  });
});

describe("acquiring a tab — the broker owns the launch budget", () => {
  it("does not call a slow cold launch busy", async () => {
    // The broker races Chrome start against BOT_START_TIMEOUT_MS (10 min by
    // default) and reports launch_timeout itself. A façade deadline shorter
    // than that turned a healthy cold start into BrowserBusy(launch_timeout)
    // with a retry that re-enters the same cold path.
    vi.useFakeTimers();
    try {
      const facade = createBrowserFacade({
        acquire: async () =>
          await new Promise<AcquiredTab>((resolve) => {
            setTimeout(() => resolve({ page, release: async () => undefined }), 120_000);
          }),
      });
      const opening = facade.openTab({ profile: "default", purpose: "signup:vercel" });
      await vi.advanceTimersByTimeAsync(120_000);
      const tab = await opening;
      expect(tab.purpose).toBe("signup:vercel");
    } finally {
      vi.useRealTimers();
    }
  });

  it("carries the caller's signal into the acquire so cancellation reaches the wire", async () => {
    const caller = new AbortController();
    const cancelled = new Error("caller changed its mind");
    let received: AbortSignal | undefined;
    const facade = createBrowserFacade({
      acquire: async ({ signal }) => {
        received = signal;
        return await new Promise<AcquiredTab>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason as Error), { once: true });
        });
      },
    });
    const started = Date.now();
    setTimeout(() => caller.abort(cancelled), 20);
    await expect(
      facade.openTab({ profile: "default", purpose: "signup:vercel", signal: caller.signal }),
    ).rejects.toBe(cancelled);
    expect(received).toBe(caller.signal);
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

describe("a page instruction is bounded and abortable", () => {
  async function tabWithHangingGoto(): Promise<{
    goto: (
      url: string,
      options?: { deadlineMs?: number; signal?: AbortSignal },
    ) => Promise<unknown>;
    aborted: () => boolean;
    release: () => Promise<void>;
  }> {
    let sawAbort = false;
    const facade = createBrowserFacade({
      acquire: async () => ({
        page: {
          goto: async (_url: string, options: { signal?: AbortSignal } = {}) =>
            await new Promise((_resolve, reject) => {
              options.signal?.addEventListener(
                "abort",
                () => {
                  sawAbort = true;
                  reject(options.signal?.reason as Error);
                },
                { once: true },
              );
            }),
        },
        release: async () => undefined,
      }),
    });
    const tab = await facade.openTab({ profile: "default", purpose: "signup:vercel" });
    return {
      goto: (url, options) => tab.page.goto(url, options),
      aborted: () => sawAbort,
      release: () => tab.release(),
    };
  }

  it("rejects a wedged navigate at its deadline instead of pending forever", async () => {
    const tab = await tabWithHangingGoto();
    const started = Date.now();
    await expect(tab.goto("https://example.com", { deadlineMs: 40 })).rejects.toThrow(
      /did not settle within 40ms/,
    );
    expect(tab.aborted()).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
    // A wedged page instruction is not one of the busy layers.
    await expect(tab.goto("https://example.com", { deadlineMs: 40 })).rejects.not.toBeInstanceOf(
      BrowserBusy,
    );
  });

  it("settles a navigate on the caller's own signal", async () => {
    const tab = await tabWithHangingGoto();
    const caller = new AbortController();
    const cancelled = new Error("caller gave up on the navigate");
    setTimeout(() => caller.abort(cancelled), 20);
    await expect(
      tab.goto("https://example.com", { deadlineMs: 30_000, signal: caller.signal }),
    ).rejects.toBe(cancelled);
  });

  it("releases without waiting on a wedged navigate", async () => {
    const tab = await tabWithHangingGoto();
    const inFlight = new AbortController();
    const wedged = tab
      .goto("https://example.com", { deadlineMs: 30_000, signal: inFlight.signal })
      .catch(() => undefined);
    const started = Date.now();
    await tab.release();
    expect(Date.now() - started).toBeLessThan(1_000);
    inFlight.abort(new Error("test teardown"));
    await wedged;
  });
});

describe("browserBusy — a strictly read-only fold of the served profile", () => {
  const sockets: Server[] = [];
  let profile: string;
  let configuredSocket: string | undefined;

  beforeEach(async () => {
    // The sandboxed profile owns this file's socket path; a globally
    // configured override would point the probe at a real broker.
    configuredSocket = process.env.TRUSTY_SQUIRE_BROKER_SOCKET;
    delete process.env.TRUSTY_SQUIRE_BROKER_SOCKET;
    profile = servedProfile();
    await mkdir(profile, { recursive: true });
  });

  afterEach(async () => {
    for (const server of sockets.splice(0))
      await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(profile, { recursive: true, force: true });
    if (configuredSocket === undefined) delete process.env.TRUSTY_SQUIRE_BROKER_SOCKET;
    else process.env.TRUSTY_SQUIRE_BROKER_SOCKET = configuredSocket;
  });

  async function listenAsBroker(): Promise<void> {
    const path = brokerSocketPath();
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const server = createServer(() => undefined);
    sockets.push(server);
    await new Promise<void>((resolve) => server.listen(path, resolve));
  }

  it("reports the live lock holder when nothing brokers the profile", async () => {
    symlinkSync(`${hostname()}-${process.pid}`, join(profile, "SingletonLock"));
    const status = await createBrowserFacade().browserBusy();
    expect(status).toEqual({
      busy: true,
      reason: {
        layer: "profile",
        code: "profile_busy",
        holder: { pid: process.pid, host: hostname() },
      },
    });
    if (!status.busy) throw new Error("expected busy");
    expect(new BrowserBusy(status.reason).action()).toBe(
      `Close the other process using this Chrome profile (pid ${process.pid}), then retry.`,
    );
  });

  it("does not call a live broker's own Chrome a foreign process to close", async () => {
    symlinkSync(`${hostname()}-${process.pid}`, join(profile, "SingletonLock"));
    await listenAsBroker();
    await expect(createBrowserFacade().browserBusy()).resolves.toEqual({ busy: false });
  });

  it("never repairs a reclaimable lock while reading", async () => {
    const lock = join(profile, "SingletonLock");
    // A dead pid on this host. The old fold reclaimed the lock — and awaited
    // the orphan-owner sweep, which SIGTERMs/SIGKILLs process trees — as a
    // side effect of answering a status question.
    symlinkSync(`${hostname()}-21474836`, lock);
    await expect(createBrowserFacade().browserBusy()).resolves.toEqual({ busy: false });
    expect(lstatSync(lock).isSymbolicLink()).toBe(true);
  });

  it("reads free when no lock and no broker answer", async () => {
    await expect(createBrowserFacade().browserBusy()).resolves.toEqual({ busy: false });
  });
});
