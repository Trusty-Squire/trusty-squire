import { describe, expect, it } from "vitest";
import { GET as getFull } from "../llms-full.txt/route";
import { GET as getConcise } from "../llms.txt/route";

describe("LLM route responses", () => {
  it("serves the concise file as cacheable plain text", async () => {
    const response = getConcise();
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("cache-control")).toContain("s-maxage=86400");
    expect(await response.text()).toContain("npx @trusty-squire/mcp connect");
  });

  it("serves the full entity inventory as plain text", async () => {
    const response = getFull();
    const body = await response.text();
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(body).toContain("## Active registry-backed services");
    expect(body).toContain("## Guides");
    expect(body).toContain("## Comparisons");
  });
});
