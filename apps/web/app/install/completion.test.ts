// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearInstallCompletionUrl,
  installCompletionAcknowledgementUrl,
  installCompletionProviderUrl,
  normalizeInstallCompletionUrl,
  readInstallCompletionProviders,
  readInstallCompletionUrl,
  recordInstallCompletionProvider,
} from "./completion";

describe("install completion callback validation", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.history.replaceState({}, "", "/install?token=setup");
  });

  it("accepts only the per-run Trusty Squire loopback callback shape", () => {
    const callback =
      "http://127.0.0.1:49152/.well-known/trusty-squire/install-complete/" + "a".repeat(48);
    expect(normalizeInstallCompletionUrl(callback)).toBe(callback);
  });

  it("adds only providers completed in this install ceremony", () => {
    const callback =
      "http://127.0.0.1:49152/.well-known/trusty-squire/install-complete/" + "e".repeat(48);
    const completed = installCompletionProviderUrl(callback, ["google", "github"]);
    const url = new URL(completed!);

    expect(url.searchParams.getAll("provider")).toEqual(["google", "github"]);
    expect(url.pathname).toBe(new URL(callback).pathname);
  });

  it.each([
    "https://127.0.0.1:49152/.well-known/trusty-squire/install-complete/" + "a".repeat(48),
    "http://localhost:49152/.well-known/trusty-squire/install-complete/" + "a".repeat(48),
    "http://127.0.0.1:80/.well-known/trusty-squire/install-complete/" + "a".repeat(48),
    "http://127.0.0.1:49152/delete-everything",
    "http://127.0.0.1:49152/.well-known/trusty-squire/install-complete/" +
      "a".repeat(48) +
      "?extra=1",
  ])("rejects unsafe callback URL %s", (callback) => {
    expect(normalizeInstallCompletionUrl(callback)).toBeNull();
  });

  it("retains the per-run callback across Google and GitHub OAuth returns", () => {
    const callback =
      "http://127.0.0.1:49152/.well-known/trusty-squire/install-complete/" + "b".repeat(48);
    window.history.replaceState(
      {},
      "",
      `/install?token=setup#ts_install_complete=${encodeURIComponent(callback)}`,
    );
    expect(readInstallCompletionUrl("setup")).toBe(callback);

    window.history.replaceState({}, "", "/install?token=setup&claim=1");
    expect(readInstallCompletionUrl("setup")).toBe(callback);
    window.history.replaceState({}, "", "/install?token=setup&gh=1");
    expect(readInstallCompletionUrl("setup")).toBe(callback);

    clearInstallCompletionUrl("setup");
    expect(readInstallCompletionUrl("setup")).toBeNull();
  });

  it("retains earned Google completion across a later GitHub OAuth return", () => {
    recordInstallCompletionProvider("setup", "google");

    window.history.replaceState({}, "", "/install?token=setup&gh=1");
    expect(readInstallCompletionProviders("setup")).toEqual(["google"]);

    recordInstallCompletionProvider("setup", "github");
    expect(readInstallCompletionProviders("setup")).toEqual(["google", "github"]);
    expect(readInstallCompletionProviders("different-install")).toEqual([]);

    clearInstallCompletionUrl("setup");
    expect(readInstallCompletionProviders("setup")).toEqual([]);
  });

  it("does not advertise callback support when the callback cannot survive OAuth", () => {
    const callback =
      "http://127.0.0.1:49152/.well-known/trusty-squire/install-complete/" + "d".repeat(48);
    window.history.replaceState(
      {},
      "",
      `/install?token=setup#ts_install_complete=${encodeURIComponent(callback)}`,
    );
    const setItem = vi.spyOn(window.sessionStorage, "setItem").mockImplementation(() => {
      throw new DOMException("storage disabled", "SecurityError");
    });
    try {
      expect(readInstallCompletionUrl("setup")).toBeNull();
    } finally {
      setItem.mockRestore();
    }
  });

  it("acknowledges callback support once and retains it across OAuth returns", () => {
    const callback =
      "http://127.0.0.1:49152/.well-known/trusty-squire/install-complete/" + "c".repeat(48);
    expect(installCompletionAcknowledgementUrl("setup", callback)).toBe(`${callback}/ack`);

    window.history.replaceState({}, "", "/install?token=setup#ts_install_complete_ack=1");
    expect(installCompletionAcknowledgementUrl("setup", callback)).toBeNull();

    window.history.replaceState({}, "", "/install?token=setup&claim=1");
    expect(installCompletionAcknowledgementUrl("setup", callback)).toBeNull();
  });
});
