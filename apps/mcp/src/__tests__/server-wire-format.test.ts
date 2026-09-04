import { describe, expect, it } from "vitest";
import { compactToolResultText } from "../server.js";

describe("compact V2 wire encoding", () => {
  it("minifies only compact observation payloads", () => {
    const compact = compactToolResultText({
      format: "compact-v2",
      safe_table: [["@e:a", "b", "Continue"]],
    });
    expect(compact).toBe('{"format":"compact-v2","safe_table":[["@e:a","b","Continue"]]}');
    expect(compact).not.toContain("\n");
    expect(compactToolResultText({ ok: true })).toContain("\n");
  });
});
