// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearInstallCompletionProviders,
  finishInstallCeremony,
  readInstallCompletionProviders,
  recordInstallCompletionProvider,
} from "./completion";

describe("install Finish", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.history.replaceState({}, "", "/install?token=setup");
  });

  it("records Finish on the same-origin install route and lands on the done page", async () => {
    const post = vi.fn<[string], Promise<unknown>>(async () => ({ ok: true }));
    const navigateDone = vi.fn();

    const recorded = finishInstallCeremony("set up/1", navigateDone, post);

    expect(navigateDone).not.toHaveBeenCalled();
    await expect(recorded).resolves.toBe(true);
    expect(navigateDone).toHaveBeenCalledOnce();
    expect(post).toHaveBeenCalledWith("/v1/mcp/install/set%20up%2F1/finish", undefined, expect.any(AbortSignal));
    // A relative path is same-origin: no loopback or cross-network request.
    expect(post.mock.calls[0]![0]).toMatch(/^\/v1\//);
  });

  it("retries a dropped Finish record before navigating", async () => {
    const post = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce({ ok: true });
    const navigateDone = vi.fn();
    const sleep = vi.fn(async () => undefined);

    const recorded = finishInstallCeremony("setup", navigateDone, post, sleep);

    expect(navigateDone).not.toHaveBeenCalled();
    await expect(recorded).resolves.toBe(true);
    expect(navigateDone).toHaveBeenCalledOnce();
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("gives up after bounded attempts without throwing", async () => {
    const post = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    const navigateDone = vi.fn();
    const recorded = finishInstallCeremony("setup", navigateDone, post, async () => undefined);
    await expect(recorded).resolves.toBe(false);
    expect(post).toHaveBeenCalledTimes(3);
    expect(navigateDone).not.toHaveBeenCalled();
    post.mockResolvedValueOnce({ ok: true });
    await expect(finishInstallCeremony("setup", navigateDone, post)).resolves.toBe(true);
    expect(navigateDone).toHaveBeenCalledOnce();
  });

  it("aborts stalled Finish attempts and allows a later retry", async () => {
    vi.useFakeTimers();
    try {
      const post = vi.fn((_path: string, _body?: unknown, signal?: AbortSignal) =>
        new Promise((_, reject) => signal!.addEventListener("abort", () => reject(new Error("aborted")))),
      );
      const navigateDone = vi.fn();
      const result = finishInstallCeremony("setup", navigateDone, post);
      await vi.advanceTimersByTimeAsync(17_000);
      await expect(result).resolves.toBe(false);
      expect(post).toHaveBeenCalledTimes(3);
      expect(post.mock.calls.every(([, , signal]) => signal!.aborted)).toBe(true);
      expect(navigateDone).not.toHaveBeenCalled();
      await expect(finishInstallCeremony("setup", navigateDone, async () => ({ ok: true }))).resolves.toBe(true);
      expect(navigateDone).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains earned Google completion across a later GitHub OAuth return", () => {
    recordInstallCompletionProvider("setup", "google");

    window.history.replaceState({}, "", "/install?token=setup&gh=1");
    expect(readInstallCompletionProviders("setup")).toEqual(["google"]);

    recordInstallCompletionProvider("setup", "github");
    expect(readInstallCompletionProviders("setup")).toEqual(["google", "github"]);
    expect(readInstallCompletionProviders("different-install")).toEqual([]);

    clearInstallCompletionProviders("setup");
    expect(readInstallCompletionProviders("setup")).toEqual([]);
  });
});
