import { describe, expect, it } from "vitest";
import { compactToolResultText } from "../server.js";

describe("browser-use DOM wire encoding", () => {
  it("minifies only compact observation payloads", () => {
    const compact = compactToolResultText({
      format: "browser-use-dom",
      dom: "[@e:a]<button />\n\tContinue",
    });
    expect(JSON.parse(compact)).toEqual({
      format: "browser-use-dom",
      dom: "[@e:a]<button />\n\tContinue",
    });
    expect(compact).not.toContain("\n");
    expect(compactToolResultText({ ok: true })).toContain("\n");
  });
});
