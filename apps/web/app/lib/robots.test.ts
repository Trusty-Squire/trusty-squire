import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("robots.txt", () => {
  it("allows crawlers to honor page-level noindex and points to the sitemap", async () => {
    const robots = await readFile(new URL("../../public/robots.txt", import.meta.url), "utf8");
    expect(robots).toContain("User-agent: *");
    expect(robots).toContain("Allow: /");
    expect(robots).not.toContain("Disallow:");
    expect(robots).toContain("Sitemap: https://trustysquire.ai/sitemap.xml");
  });
});
