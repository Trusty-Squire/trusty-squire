import { describe, it, expect } from "vitest";
import {
  assertStagingPrerelease,
  computeNextRc,
  isPrerelease,
  ReleaseFenceError,
} from "../release-guard.js";

describe("isPrerelease", () => {
  it("recognizes -rc / -beta prereleases", () => {
    expect(isPrerelease("0.9.1-rc.1")).toBe(true);
    expect(isPrerelease("1.2.3-beta.4")).toBe(true);
  });
  it("rejects stable versions", () => {
    expect(isPrerelease("0.9.1")).toBe(false);
    expect(isPrerelease("1.0.0")).toBe(false);
  });
});

describe("computeNextRc", () => {
  it("opens a fresh rc line from a stable version", () => {
    expect(computeNextRc("0.9.0")).toBe("0.9.1-rc.1");
  });
  it("advances an existing rc", () => {
    expect(computeNextRc("0.9.1-rc.1")).toBe("0.9.1-rc.2");
    expect(computeNextRc("0.9.1-rc.9")).toBe("0.9.1-rc.10");
  });
  it("always yields a prerelease", () => {
    expect(isPrerelease(computeNextRc("0.9.0"))).toBe(true);
    expect(isPrerelease(computeNextRc("0.9.1-rc.3"))).toBe(true);
  });
  it("throws on an unparseable version", () => {
    expect(() => computeNextRc("garbage")).toThrow(ReleaseFenceError);
    expect(() => computeNextRc("0.9.1-beta.1")).toThrow(ReleaseFenceError);
  });
});

describe("assertStagingPrerelease", () => {
  it("accepts staging + a prerelease", () => {
    expect(() =>
      assertStagingPrerelease({ branch: "staging", version: "0.9.1-rc.1" }),
    ).not.toThrow();
  });
  it("hard-stops on main (the human-promote channel)", () => {
    expect(() =>
      assertStagingPrerelease({ branch: "main", version: "0.9.1-rc.1" }),
    ).toThrow(/may not push to main/);
  });
  it("rejects a stable version on staging", () => {
    expect(() =>
      assertStagingPrerelease({ branch: "staging", version: "0.9.1" }),
    ).toThrow(/requires a prerelease/);
  });
  it("rejects any other branch", () => {
    expect(() =>
      assertStagingPrerelease({ branch: "feature-x", version: "0.9.1-rc.1" }),
    ).toThrow(/only pushes to staging/);
  });
});
