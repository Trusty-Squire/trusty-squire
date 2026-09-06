import { describe, expect, it, vi } from "vitest";
import {
  IdentityRuntime,
  IncompatibleIdentityRuntimeSettingsError,
  type IdentityRuntimeCloseable,
} from "../identity-runtime.js";

interface FakeSettings {
  profileDir: string;
  proxyUrl?: string;
}

class FakeChrome implements IdentityRuntimeCloseable {
  closed = false;
  // Simulates state that must never survive across sequential sessions when
  // the runtime relaunches: a page reference, an event listener, a route, and
  // a payment/checkout scratch value.
  page: { id: number } | null = null;
  listeners = new Set<string>();
  routes = new Set<string>();
  checkoutBaseline: string | null = null;

  async close(): Promise<"closed"> {
    this.closed = true;
    return "closed";
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("IdentityRuntime", () => {
  it("single-flights concurrent acquires into exactly one launch", async () => {
    const launched: FakeChrome[] = [];
    const gate = deferred<void>();
    const launch = vi.fn(async (_settings: FakeSettings) => {
      await gate.promise;
      const chrome = new FakeChrome();
      launched.push(chrome);
      return chrome;
    });
    const runtime = new IdentityRuntime<FakeChrome, FakeSettings>();
    const settings: FakeSettings = { profileDir: "/p" };

    const a = runtime.acquire(settings, launch);
    const b = runtime.acquire(settings, launch);
    const c = runtime.acquire(settings, launch);
    gate.resolve();
    const [ra, rb, rc] = await Promise.all([a, b, c]);

    expect(launch).toHaveBeenCalledTimes(1);
    expect(launched).toHaveLength(1);
    expect(ra.handle).toBe(launched[0]);
    expect(rb.handle).toBe(launched[0]);
    expect(rc.handle).toBe(launched[0]);
    expect(runtime.currentEpoch()).toBe(1);
    expect(runtime.activeLeaseCount()).toBe(3);
    // Exactly one of the three should observe reused:false (the launcher);
    // the other two joined the same in-flight launch as reuses.
    expect([ra, rb, rc].filter((r) => !r.reused)).toHaveLength(1);
  });

  it("increments epoch on relaunch and makes a stale reference detectable", async () => {
    const runtime = new IdentityRuntime<FakeChrome, FakeSettings>();
    const settings: FakeSettings = { profileDir: "/p" };
    const first = await runtime.acquire(settings, async () => new FakeChrome());
    expect(first.epoch).toBe(1);
    expect(runtime.isEpochStale(first.epoch)).toBe(false);

    first.releaseTabs();
    runtime.forgetAfterShutdown();

    const second = await runtime.acquire(settings, async () => new FakeChrome());
    expect(second.epoch).toBe(2);
    expect(second.handle).not.toBe(first.handle);
    // The epoch captured from the first acquire is now stale.
    expect(runtime.isEpochStale(first.epoch)).toBe(true);
    expect(runtime.isEpochStale(second.epoch)).toBe(false);
  });

  it("Chrome survives an individual session finishing when tabs alone are released", async () => {
    const runtime = new IdentityRuntime<FakeChrome, FakeSettings>();
    const settings: FakeSettings = { profileDir: "/p" };
    const launch = vi.fn(async () => new FakeChrome());

    const session1 = await runtime.acquire(settings, launch);
    session1.releaseTabs(); // session finishes — must NOT close Chrome
    expect(session1.handle.closed).toBe(false);
    expect(runtime.isLive()).toBe(true);
    expect(runtime.activeLeaseCount()).toBe(0);

    // A second session reuses the still-alive Chrome without relaunching.
    const session2 = await runtime.acquire(settings, launch);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(session2.reused).toBe(true);
    expect(session2.handle).toBe(session1.handle);
    expect(session2.epoch).toBe(session1.epoch);
    expect(session1.handle.closed).toBe(false);
  });

  it("releaseTabs is idempotent and never touches the shared Chrome", async () => {
    const runtime = new IdentityRuntime<FakeChrome, FakeSettings>();
    const settings: FakeSettings = { profileDir: "/p" };
    const acquired = await runtime.acquire(settings, async () => new FakeChrome());
    acquired.releaseTabs();
    acquired.releaseTabs();
    acquired.releaseTabs();
    expect(runtime.activeLeaseCount()).toBe(0);
    expect(acquired.handle.closed).toBe(false);
  });

  it("rejects incompatible settings against a live runtime instead of mutating it", async () => {
    const runtime = new IdentityRuntime<FakeChrome, FakeSettings>();
    const launch = vi.fn(async () => new FakeChrome());
    const first = await runtime.acquire({ profileDir: "/p", proxyUrl: "http://proxy-a" }, launch);

    await expect(
      runtime.acquire({ profileDir: "/p", proxyUrl: "http://proxy-b" }, launch),
    ).rejects.toBeInstanceOf(IncompatibleIdentityRuntimeSettingsError);
    // The live identity is untouched by the rejected request.
    expect(launch).toHaveBeenCalledTimes(1);
    expect(runtime.currentEpoch()).toBe(1);
    expect(first.handle.closed).toBe(false);

    // The only sanctioned path to different settings: close, forget, relaunch.
    await first.handle.close();
    first.releaseTabs();
    runtime.forgetAfterShutdown();
    const second = await runtime.acquire({ profileDir: "/p", proxyUrl: "http://proxy-b" }, launch);
    expect(launch).toHaveBeenCalledTimes(2);
    expect(second.handle).not.toBe(first.handle);
    expect(second.epoch).toBe(2);
  });

  it("rejects incompatible settings against an in-flight launch, not just a live one", async () => {
    const runtime = new IdentityRuntime<FakeChrome, FakeSettings>();
    const gate = deferred<void>();
    const launch = vi.fn(async () => {
      await gate.promise;
      return new FakeChrome();
    });
    const pending = runtime.acquire({ profileDir: "/p", proxyUrl: "http://proxy-a" }, launch);
    await expect(
      runtime.acquire({ profileDir: "/p", proxyUrl: "http://proxy-b" }, launch),
    ).rejects.toBeInstanceOf(IncompatibleIdentityRuntimeSettingsError);
    gate.resolve();
    await pending;
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("relaunches cleanly with no carried-over state when reuse is not exercised (the production path)", async () => {
    const runtime = new IdentityRuntime<FakeChrome, FakeSettings>();
    const settings: FakeSettings = { profileDir: "/p" };

    const session1 = await runtime.acquire(settings, async () => new FakeChrome());
    session1.handle.page = { id: 1 };
    session1.handle.listeners.add("popup");
    session1.handle.routes.add("**/*");
    session1.handle.checkoutBaseline = "card-ending-4242";

    // Production's finish path: close the handle, then unconditionally
    // forget, so the very next acquire() is a genuine fresh launch.
    await session1.handle.close();
    session1.releaseTabs();
    runtime.forgetAfterShutdown();

    expect(runtime.isLive()).toBe(false);
    expect(runtime.activeLeaseCount()).toBe(0);

    const session2 = await runtime.acquire(settings, async () => new FakeChrome());
    expect(session2.reused).toBe(false);
    expect(session2.handle).not.toBe(session1.handle);
    // The fresh handle starts with none of session 1's state — nothing to
    // reset because nothing was carried forward.
    expect(session2.handle.page).toBeNull();
    expect(session2.handle.listeners.size).toBe(0);
    expect(session2.handle.routes.size).toBe(0);
    expect(session2.handle.checkoutBaseline).toBeNull();
    expect(session1.handle.closed).toBe(true);
  });

  it("forgetAfterShutdown is a safe no-op when nothing is live", () => {
    const runtime = new IdentityRuntime<FakeChrome, FakeSettings>();
    expect(() => {
      runtime.forgetAfterShutdown();
    }).not.toThrow();
    expect(runtime.isLive()).toBe(false);
    expect(runtime.currentEpoch()).toBe(0);
  });

  it("propagates a launch failure to every concurrent waiter and allows retry", async () => {
    const runtime = new IdentityRuntime<FakeChrome, FakeSettings>();
    const settings: FakeSettings = { profileDir: "/p" };
    const failing = vi.fn(async (): Promise<FakeChrome> => {
      throw new Error("chrome exited immediately");
    });
    const a = runtime.acquire(settings, failing);
    const b = runtime.acquire(settings, failing);
    await expect(a).rejects.toThrow("chrome exited immediately");
    await expect(b).rejects.toThrow("chrome exited immediately");
    expect(runtime.isLive()).toBe(false);
    expect(runtime.currentEpoch()).toBe(0);

    const ok = await runtime.acquire(settings, async () => new FakeChrome());
    expect(ok.epoch).toBe(1);
  });

  it("uses a custom settingsCompatible comparator when supplied", async () => {
    const runtime = new IdentityRuntime<FakeChrome, FakeSettings>({
      settingsCompatible: (live, requested) => live.profileDir === requested.profileDir,
    });
    const launch = vi.fn(async () => new FakeChrome());
    const first = await runtime.acquire({ profileDir: "/p", proxyUrl: "http://a" }, launch);
    // Differs only in the field the comparator ignores — treated as compatible.
    const second = await runtime.acquire({ profileDir: "/p", proxyUrl: "http://b" }, launch);
    expect(second.reused).toBe(true);
    expect(second.handle).toBe(first.handle);
    expect(launch).toHaveBeenCalledTimes(1);
  });
});
