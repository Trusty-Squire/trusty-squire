import { describe, expect, it } from "vitest";
import { compactToolResultText } from "../server.js";

describe("browser-use DOM wire encoding", () => {
  it("minifies each browser-use observation format", () => {
    for (const payload of [
      { format: "browser-use-dom", dom: "[@e:a]<button />\n\tContinue" },
      { format: "browser-use-control-query", safe_table: [["@e:a", "b"]] },
    ]) {
      const compact = compactToolResultText(payload);
      expect(JSON.parse(compact)).toEqual(payload);
      expect(compact).not.toContain("\n");
    }
    expect(compactToolResultText({ ok: true })).toContain("\n");
  });

  it("refuses an absent result before it can become an invalid MCP text block", () => {
    expect(() => compactToolResultText(undefined)).toThrow("no JSON-serializable result");
  });
});
