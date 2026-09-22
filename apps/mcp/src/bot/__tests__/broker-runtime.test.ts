import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type * as ProfileModule from "../profile.js";
const state = vi.hoisted(() => ({
  start: vi.fn(),
  close: vi.fn(),
  release: vi.fn(),
  attach: vi.fn(),
  guard: vi.fn(),
  connected: true,
  constructed: [] as Array<{ profileDir: string; proxyUrl?: string }>,
}));
vi.mock("../browser.js", () => ({
  BrowserController: class {
    start = state.start;
    close = state.close;
    forceCloseOwnedProcessTree = state.close;
    isConnected = () => state.connected;
    static attachSessionPage = state.attach;
    constructor(settings: { profileDir: string; proxyUrl?: string }) {
      state.constructed.push(settings);
    }
  },
}));
vi.mock("../profile.js", async (importActual) => ({
  ...(await importActual<typeof ProfileModule>()),
  profilePathIdentity: (path: string) => path,
  CHROME_PROFILE_DIR: "/unused",
  waitForProfileFree: async () => true,
  acquireProfileOperationGuard: state.guard,
}));
import { BrokerRuntime } from "../broker/runtime.js";
import { BrokerRefusal } from "../broker/refusal.js";
import { ProfileBusyError, PROFILE_BUSY_MESSAGE } from "../profile.js";
import { withBrokerAdmission } from "../broker/admission-context.js";
import { readBrokerAccountBinding } from "../broker/account-binding.js";
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ts-broker-runtime-"));
  vi.clearAllMocks();
  state.start.mockResolvedValue(undefined);
  state.close.mockResolvedValue("closed");
  state.guard.mockReturnValue({ release: state.release });
  state.connected = true;
  state.constructed.length = 0;
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
it("shares a physical launch, serializes duplicate tab release, and retains sibling custody", async () => {
  let finish!: (state: string) => void;
  const closeFirst = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  );
  const first = { closeOwnPagesOnly: closeFirst };
  const second = { closeOwnPagesOnly: vi.fn(async () => "closed") };
  state.attach.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
  const runtime = new BrokerRuntime();
  await Promise.all([runtime.acquire({ profileDir: root }), runtime.acquire({ profileDir: root })]);
  expect(state.start).toHaveBeenCalledTimes(1);
  const a = runtime.release(first as never);
  const b = runtime.release(first as never);
  expect(closeFirst).toHaveBeenCalledTimes(1);
  finish("closed");
  await Promise.all([a, b]);
  expect(await runtime.close()).toBe(false);
  expect(state.close).not.toHaveBeenCalled();
  expect(state.release).not.toHaveBeenCalled();
  await runtime.release(second as never);
  expect(await runtime.close()).toBe(true);
  expect(state.release).toHaveBeenCalledTimes(1);
});
it("does not classify a physical launch as lost before it finishes connecting", async () => {
  let finishStart!: () => void;
  state.connected = false;
  state.start.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finishStart = resolve;
      }),
  );
  const browser = { closeOwnPagesOnly: vi.fn(async () => "closed") };
  state.attach.mockResolvedValue(browser);
  const runtime = new BrokerRuntime();

  const acquiring = runtime.acquire({ profileDir: root });
  await vi.waitFor(() => expect(state.start).toHaveBeenCalledOnce());
  expect(runtime.browserLost()).toBe(false);

  state.connected = true;
  finishStart();
  const acquired = await acquiring;
  expect(runtime.browserLost()).toBe(false);

  state.connected = false;
  expect(runtime.browserLost()).toBe(true);

  await runtime.release(acquired.browser);
  expect(await runtime.close()).toBe(true);
});
it("keeps an uncertain failed admission until its own tab cleanup succeeds", async () => {
  const closePage = vi.fn().mockResolvedValueOnce("unknown").mockResolvedValue("closed");
  state.attach.mockResolvedValue({ closeOwnPagesOnly: closePage });
  const runtime = new BrokerRuntime();
  await withBrokerAdmission({ sessionId: "admission" }, async () => {
    await runtime.acquire({ profileDir: root });
  });
  await expect(runtime.cleanupAdmission("admission")).rejects.toThrow("quarantined");
  expect(state.release).not.toHaveBeenCalled();
  expect(await runtime.cleanupAdmission("admission")).toBe(true);
  expect(await runtime.close()).toBe(true);
});
it("releases orphan tab bookkeeping without closing the owner browser", async () => {
  const closePage = vi.fn(async () => "unknown");
  const browser = { closeOwnPagesOnly: closePage };
  state.attach.mockResolvedValue(browser);
  const runtime = new BrokerRuntime();
  const acquired = await withBrokerAdmission(
    { sessionId: "admission" },
    async () => await runtime.acquire({ profileDir: root }),
  );

  await runtime.orphan(acquired.browser);

  expect(closePage).not.toHaveBeenCalled();
  expect(await runtime.close()).toBe(true);
  expect(state.close).toHaveBeenCalledOnce();
});
it("bounds a hung physical launch and retains an unproven process lease", async () => {
  state.start.mockImplementation(() => new Promise(() => undefined));
  state.close.mockResolvedValue("unknown");
  vi.stubEnv("BOT_START_TIMEOUT_MS", "10");
  const runtime = new BrokerRuntime();
  await expect(runtime.acquire({ profileDir: root })).rejects.toThrow("launch timed out");
  expect(state.close).toHaveBeenCalledWith({ cancelStart: true });
  expect(state.release).not.toHaveBeenCalled();
  expect(await runtime.close()).toBe(false);
  state.close.mockResolvedValue("closed");
  expect(await runtime.close()).toBe(true);
  expect(state.release).toHaveBeenCalledTimes(1);
});
it("refuses another account on a previously enrolled profile before launching", async () => {
  const first = new BrokerRuntime();
  state.attach.mockResolvedValue({ closeOwnPagesOnly: async () => "closed" });
  const { browser } = await first.acquire({ profileDir: root }, "account");
  await first.release(browser);
  await first.close();
  const second = new BrokerRuntime();
  await expect(second.acquire({ profileDir: root }, "other-account")).rejects.toThrow(
    "different account",
  );
  expect(state.start).toHaveBeenCalledTimes(1);
});

it("serves a profile no account has claimed yet, and binds it on the first account-acting open", async () => {
  const runtime = new BrokerRuntime();
  state.attach.mockResolvedValue({ closeOwnPagesOnly: async () => "closed" });
  // The enrollment ceremony names no account: it creates one rather than
  // acting as one, so it must reach the browser on an unclaimed profile.
  const { browser } = await runtime.acquire({ profileDir: root });
  expect(await readBrokerAccountBinding(root)).toBeNull();
  await runtime.release(browser);
  await runtime.acquire({ profileDir: root }, "account");
  expect(await readBrokerAccountBinding(root)).toBe("account");
});

it("recycles a differing proxy in-band when no other session is active", async () => {
  state.attach.mockResolvedValue({ closeOwnPagesOnly: vi.fn(async () => "closed") });
  const runtime = new BrokerRuntime();
  const first = await runtime.acquire({ profileDir: root });
  expect(state.start).toHaveBeenCalledTimes(1);
  expect(state.constructed[0]).toEqual({ profileDir: root });
  await runtime.release(first.browser);

  const second = await runtime.acquire({
    profileDir: root,
    proxyUrl: "http://proxy.test:8080",
  });

  // Clean in-band recycle: the previous Chrome was closed through the ordinary
  // owner-close path, then a fresh identity launched with the requested proxy.
  // No broker-process kill, and the persistent profile directory is preserved.
  expect(state.close).toHaveBeenCalledTimes(1);
  expect(state.start).toHaveBeenCalledTimes(2);
  expect(state.constructed[1]).toEqual({ profileDir: root, proxyUrl: "http://proxy.test:8080" });
  expect(second.profileDir).toBe(root);

  await runtime.release(second.browser);
  expect(await runtime.close()).toBe(true);
});

it("refuses a differing proxy while another session is active on the shared profile", async () => {
  state.attach.mockResolvedValue({ closeOwnPagesOnly: vi.fn(async () => "closed") });
  const runtime = new BrokerRuntime();
  const first = await runtime.acquire({ profileDir: root });

  await expect(
    runtime.acquire({ profileDir: root, proxyUrl: "http://proxy.test:8080" }),
  ).rejects.toThrow(/proxy or identity change requires no other active sessions/);

  // The live Chrome was neither killed nor relaunched for the refused request.
  expect(state.close).not.toHaveBeenCalled();
  expect(state.start).toHaveBeenCalledTimes(1);
  expect(runtime.activeSessionCount()).toBe(1);

  await runtime.release(first.browser);
  expect(await runtime.close()).toBe(true);
});

it("refuses to recycle when the previous browser does not close", async () => {
  state.attach.mockResolvedValue({ closeOwnPagesOnly: vi.fn(async () => "closed") });
  const runtime = new BrokerRuntime();
  const first = await runtime.acquire({ profileDir: root });
  await runtime.release(first.browser);
  state.close.mockResolvedValue("unknown");

  await expect(
    runtime.acquire({ profileDir: root, proxyUrl: "http://proxy.test:8080" }),
  ).rejects.toThrow(/did not close/);
  expect(state.start).toHaveBeenCalledTimes(1);
});

it("refuses the recycled start when a close drains the cell mid-recycle", async () => {
  state.attach.mockResolvedValue({ closeOwnPagesOnly: vi.fn(async () => "closed") });
  const runtime = new BrokerRuntime();
  const first = await runtime.acquire({ profileDir: root });
  await runtime.release(first.browser);
  let closed!: (state: string) => void;
  state.close.mockImplementationOnce(
    () =>
      new Promise<string>((resolve) => {
        closed = resolve;
      }),
  );

  const recycled = runtime.acquire({ profileDir: root, proxyUrl: "http://proxy.test:8080" });
  await Promise.resolve();
  const maintenance = runtime.close();
  closed("closed");

  expect(await maintenance).toBe(true);
  await expect(recycled).rejects.toThrow(/draining/);
  // The drained cell must not be handed a fresh Chrome behind the close's back.
  expect(state.start).toHaveBeenCalledTimes(1);
});

it("persists every concurrent terminal hook before releasing target custody", async () => {
  let close!: (state: string) => void;
  const browser = {
    closeOwnPagesOnly: vi.fn(
      () =>
        new Promise<string>((resolve) => {
          close = resolve;
        }),
    ),
  };
  state.attach.mockResolvedValue(browser);
  const runtime = new BrokerRuntime();
  await runtime.acquire({ profileDir: root });
  const first = runtime.release(browser as never);
  const persisted = vi.fn(async () => {
    expect(await runtime.close()).toBe(false);
    expect(state.release).not.toHaveBeenCalled();
  });
  const second = runtime.release(browser as never, persisted);
  close("closed");
  await Promise.all([first, second]);
  expect(persisted).toHaveBeenCalledOnce();
  expect(await runtime.close()).toBe(true);
});

it("retains target custody when terminal persistence fails and refuses orphan closure proof", async () => {
  const browser = { closeOwnPagesOnly: vi.fn(async () => "closed") };
  state.attach.mockResolvedValue(browser);
  const runtime = new BrokerRuntime();
  await runtime.acquire({ profileDir: root });
  await expect(
    runtime.release(browser as never, async () => {
      throw new Error("disk unavailable");
    }),
  ).rejects.toThrow("disk unavailable");
  expect(await runtime.close()).toBe(false);
  const persisted = vi.fn(async () => undefined);
  await runtime.release(browser as never, persisted);
  expect(persisted).toHaveBeenCalledOnce();
  await expect(runtime.release({} as never, persisted)).rejects.toThrow(
    "No retained closure proof",
  );
  expect(persisted).toHaveBeenCalledOnce();
  expect(await runtime.close()).toBe(true);
});

it("refuses a held profile lease under the profile-busy code, not a generic failure", async () => {
  // A plain ProfileBusyError serializes onto the wire as
  // broker_execution_failed, which no caller can map to the profile layer.
  // The `connect` ceremony holding this same lease is the common real case.
  state.guard.mockImplementation(() => {
    throw new ProfileBusyError(PROFILE_BUSY_MESSAGE);
  });
  const runtime = new BrokerRuntime();
  await expect(runtime.acquire({ profileDir: root })).rejects.toSatisfy((error: unknown) => {
    expect(error).toBeInstanceOf(BrokerRefusal);
    expect((error as BrokerRefusal).code).toBe("profile_busy");
    expect((error as Error).message).toBe(PROFILE_BUSY_MESSAGE);
    return true;
  });
  expect(state.constructed).toHaveLength(0);
});
