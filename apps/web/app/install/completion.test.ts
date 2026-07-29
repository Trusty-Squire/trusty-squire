// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from "vitest";
import {
  clearInstallCompletionUrl,
  normalizeInstallCompletionUrl,
  readInstallCompletionUrl,
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
      "http://127.0.0.1:49152/.well-known/trusty-squire/install-complete/" +
      "b".repeat(48);
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
});
