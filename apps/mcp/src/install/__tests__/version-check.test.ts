// Regression: `npx …/mcp connect` silently reused a stale local copy and pinned
// the host config to it (a months-old operator kept running after "install 39").
// isBehind is the decision that triggers the self-heal re-exec — it must flag a
// behind version and NOT nag when up-to-date or ahead on a prerelease.

import { describe, it, expect } from "vitest";
import { isBehind, parseVersion, isPublishedInstall } from "../version-check.js";

describe("parseVersion", () => {
  it("parses release and prerelease", () => {
    expect(parseVersion("1.0.39")).toEqual({ nums: [1, 0, 39], pre: null });
    expect(parseVersion("1.0.39-rc.1")).toEqual({ nums: [1, 0, 39], pre: "rc.1" });
  });
  it("returns null for non-semver (dev builds, garbage)", () => {
    expect(parseVersion("dev")).toBeNull();
    expect(parseVersion("1.0")).toBeNull();
    expect(parseVersion("")).toBeNull();
  });
});

describe("isBehind", () => {
  it("flags an older release as behind (the 1.0.35 → 1.0.39 case)", () => {
    expect(isBehind("1.0.35", "1.0.39")).toBe(true);
    expect(isBehind("1.0.39", "1.1.0")).toBe(true);
    expect(isBehind("0.9.9", "1.0.0")).toBe(true);
  });

  it("does not flag the current or a newer version", () => {
    expect(isBehind("1.0.39", "1.0.39")).toBe(false);
    expect(isBehind("1.1.0", "1.0.39")).toBe(false);
  });

  it("treats a prerelease as behind its matching release", () => {
    expect(isBehind("1.0.39-rc.1", "1.0.39")).toBe(true);
  });

  it("does NOT flag a prerelease AHEAD of latest (user on `next`)", () => {
    // 1.0.40-rc.1 > 1.0.39 — a `next` user must not be nagged down to `latest`.
    expect(isBehind("1.0.40-rc.1", "1.0.39")).toBe(false);
  });

  it("orders prerelease identifiers numerically (rc.2 < rc.10)", () => {
    expect(isBehind("1.0.0-rc.2", "1.0.0-rc.10")).toBe(true);
    expect(isBehind("1.0.0-rc.10", "1.0.0-rc.2")).toBe(false);
  });

  it("never flags when a version is unparseable (dev checkout safety)", () => {
    expect(isBehind("dev", "1.0.39")).toBe(false);
    expect(isBehind("1.0.35", "garbage")).toBe(false);
  });
});

describe("isPublishedInstall — only self-heal from a real published copy", () => {
  it("true for a global node_modules install", () => {
    expect(
      isPublishedInstall("file:///home/u/.nvm/versions/node/v20/lib/node_modules/@trusty-squire/mcp/dist/bin.js"),
    ).toBe(true);
  });
  it("true for an npx cache copy", () => {
    expect(
      isPublishedInstall("file:///home/u/.npm/_npx/abc123/node_modules/@trusty-squire/mcp/dist/bin.js"),
    ).toBe(true);
  });
  it("false for a source checkout (never re-exec over a dev build)", () => {
    expect(isPublishedInstall("file:///home/u/proj-ts/apps/mcp/dist/bin.js")).toBe(false);
  });
});
