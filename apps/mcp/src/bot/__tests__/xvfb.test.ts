import { describe, expect, it } from "vitest";
import { displayResponds, displaySocketPath, pidAlive } from "../xvfb.js";

describe("xvfb helpers", () => {
  it("maps display names to X socket paths", () => {
    expect(displaySocketPath(":198")).toBe("/tmp/.X11-unix/X198");
    expect(displaySocketPath("198")).toBe("/tmp/.X11-unix/X198");
  });

  it("treats the current process as alive and invalid pids as dead", () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(0)).toBe(false);
    expect(pidAlive(-1)).toBe(false);
  });

  it("reports invalid displays as not responding", () => {
    expect(displayResponds(":65534")).toBe(false);
  });
});
