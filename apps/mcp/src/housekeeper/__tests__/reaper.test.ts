import { describe, expect, it } from "vitest";
import {
  ceilingFor,
  classifyHousekeeperRun,
  isHousekeeper,
  reapStaleHousekeepers,
} from "../reaper.js";

// The reaper is the external backstop the in-process signup-lock watchdog can't
// be: it kills stale sibling housekeeper runs (old dist / hung-in-teardown /
// blocked-loop) that the watchdog leaves behind. These cover the classification
// the kill decision turns on; the /proc scan itself is exercised live.

describe("isHousekeeper", () => {
  it("matches a real housekeeper invocation", () => {
    expect(isHousekeeper("node apps/mcp/dist/bin.js housekeeper --mode=discover --service=exa")).toBe(true);
    expect(isHousekeeper("node /home/x/proj-ts/apps/mcp/dist/bin.js housekeeper --mode=heal --once")).toBe(true);
    expect(isHousekeeper("node apps/mcp/dist/bin.js housekeeper autoloop --agent=codex")).toBe(true);
  });

  it("does NOT match the MCP server or unrelated node processes", () => {
    expect(isHousekeeper("node apps/mcp/dist/bin.js server")).toBe(false);
    expect(isHousekeeper("node some/other/script.js")).toBe(false);
    expect(isHousekeeper("/usr/bin/google-chrome --headless")).toBe(false);
    expect(isHousekeeper("node script.js --message='housekeeper autoloop'")).toBe(false);
  });

  it("does NOT match a non-node process that merely mentions housekeeper", () => {
    expect(isHousekeeper("grep housekeeper cli.ts")).toBe(false);
  });
});

describe("classifyHousekeeperRun", () => {
  it("classifies autoloop and heal as long-running", () => {
    expect(classifyHousekeeperRun("node apps/mcp/dist/bin.js housekeeper autoloop --agent=codex")).toEqual({
      kind: "long",
      ceilingS: 4 * 60 * 60,
    });
    expect(classifyHousekeeperRun("node apps/mcp/dist/bin.js housekeeper --mode=heal --once")).toEqual({
      kind: "long",
      ceilingS: 4 * 60 * 60,
    });
  });

  it("classifies service/discover invocations as single runs", () => {
    expect(classifyHousekeeperRun("node apps/mcp/dist/bin.js housekeeper --service=kinde --once")).toEqual({
      kind: "single",
      ceilingS: 25 * 60,
    });
    expect(classifyHousekeeperRun("node apps/mcp/dist/bin.js housekeeper --mode=discover --service=exa")).toEqual({
      kind: "single",
      ceilingS: 25 * 60,
    });
  });

  it("returns null for text that only mentions housekeeper", () => {
    expect(classifyHousekeeperRun("node script.js --message='housekeeper autoloop'")).toBeNull();
  });
});

describe("ceilingFor", () => {
  it("gives a heal pass the loose 4h backstop", () => {
    expect(ceilingFor("node bin.js housekeeper --mode=heal --once")).toBe(4 * 60 * 60);
  });

  it("gives autoloop the loose 4h backstop so child reapers do not kill their parent", () => {
    expect(ceilingFor("node apps/mcp/dist/bin.js housekeeper autoloop --agent=codex")).toBe(4 * 60 * 60);
  });

  it("gives a single-service / discover run the tight 25min ceiling", () => {
    expect(ceilingFor("node bin.js housekeeper --mode=discover --service=exa")).toBe(25 * 60);
    expect(ceilingFor("node bin.js housekeeper --mode=verify")).toBe(25 * 60);
  });
});

describe("reapStaleHousekeepers", () => {
  it("never kills self and returns a result without throwing", () => {
    // Live scan of the test runner's own /proc. Must not reap this very process
    // (it's a node process but not a housekeeper), and must return cleanly.
    const before = process.pid;
    const res = reapStaleHousekeepers(() => {});
    expect(typeof res.scanned).toBe("number");
    expect(Array.isArray(res.reaped)).toBe(true);
    // self must never appear in the reaped set
    expect(res.reaped.find((r) => r.pid === before)).toBeUndefined();
  });
});
