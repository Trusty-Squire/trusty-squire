import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  start: vi.fn(),
  close: vi.fn(),
  release: vi.fn(),
  attach: vi.fn(),
  guard: vi.fn(),
  connected: true,
}));
vi.mock("../browser.js", () => ({
  BrowserController: class {
    start = state.start;
    close = state.close;
    forceCloseOwnedProcessTree = state.close;
    isConnected = () => state.connected;
    enableBrokerRouting = async () => undefined;
    static attachSessionPage = state.attach;
  },
}));
vi.mock("../profile.js", () => ({
  profilePathIdentity: (path: string) => path,
  CHROME_PROFILE_DIR: "/unused",
  waitForProfileFree: async () => true,
  acquireProfileOperationGuard: state.guard,
}));
import { BrokerRuntime } from "../broker/runtime.js";
import { withBrokerAdmission } from "../broker/admission-context.js";
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ts-broker-runtime-"));
  vi.clearAllMocks();
  state.start.mockResolvedValue(undefined);
  state.close.mockResolvedValue("closed");
  state.guard.mockReturnValue({ release: state.release });
  state.connected = true;
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
  const runtime = new BrokerRuntime("account");
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
  const runtime = new BrokerRuntime("account");

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
  const runtime = new BrokerRuntime("account");
  await withBrokerAdmission({ sessionId: "admission", reserve: () => undefined }, async () => {
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
  const runtime = new BrokerRuntime("account");
  const acquired = await withBrokerAdmission(
    { sessionId: "admission", reserve: () => undefined },
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
  const runtime = new BrokerRuntime("account");
  await expect(runtime.acquire({ profileDir: root })).rejects.toThrow("launch timed out");
  expect(state.close).toHaveBeenCalledWith({ cancelStart: true });
  expect(state.release).not.toHaveBeenCalled();
  expect(await runtime.close()).toBe(false);
  state.close.mockResolvedValue("closed");
  expect(await runtime.close()).toBe(true);
  expect(state.release).toHaveBeenCalledTimes(1);
});
it("refuses another account on a previously enrolled profile before launching", async () => {
  const first = new BrokerRuntime("first-account");
  state.attach.mockResolvedValue({ closeOwnPagesOnly: async () => "closed" });
  const { browser } = await first.acquire({ profileDir: root });
  await first.release(browser);
  await first.close();
  const second = new BrokerRuntime("second-account");
  await expect(second.acquire({ profileDir: root })).rejects.toThrow("different account");
  expect(state.start).toHaveBeenCalledTimes(1);
});
