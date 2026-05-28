// 0.8.0-rc.3 — the install CLI passes the bot's already-connected
// providers as a `?already=<csv>` query param so the trustysquire
// install page can render ✓ badges instead of inviting the user to
// re-sign-in. This file pins the encoding contract: stable ordering
// (so URLs are cache-keyable), dedup, no-op on empty input.

import { describe, expect, it } from "vitest";
import { appendAlreadyParam } from "../cli.js";

describe("appendAlreadyParam", () => {
  it("returns the URL unchanged when no providers are connected", () => {
    expect(appendAlreadyParam("https://example.com/install?token=abc", [])).toBe(
      "https://example.com/install?token=abc",
    );
  });

  it("appends ?already=<provider> for a single connected provider", () => {
    const out = appendAlreadyParam("https://example.com/install?token=abc", [
      "google",
    ]);
    expect(out).toBe("https://example.com/install?token=abc&already=google");
  });

  it("CSV-encodes multiple providers in stable (sorted) order", () => {
    // Stable order matters: same input → same URL → page render is
    // cacheable and tests are deterministic.
    const a = appendAlreadyParam("https://example.com/install", [
      "github",
      "google",
    ]);
    const b = appendAlreadyParam("https://example.com/install", [
      "google",
      "github",
    ]);
    expect(a).toBe(b);
    expect(a).toBe("https://example.com/install?already=github%2Cgoogle");
  });

  it("dedupes repeated providers", () => {
    const out = appendAlreadyParam("https://example.com/install", [
      "google",
      "google",
    ]);
    expect(out).toBe("https://example.com/install?already=google");
  });

  it("overwrites a stale `already` param rather than concatenating", () => {
    // If a previous run left `?already=` in the URL (shouldn't happen
    // because the API never sets it, but defensively): a second call
    // must not produce `already=A&already=B`.
    const out = appendAlreadyParam(
      "https://example.com/install?already=github",
      ["google"],
    );
    expect(out).toBe("https://example.com/install?already=google");
  });

  it("passes a malformed URL through untouched (rather than crashing the install)", () => {
    expect(appendAlreadyParam("not-a-url", ["google"])).toBe("not-a-url");
  });
});
