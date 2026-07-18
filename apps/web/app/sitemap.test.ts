import { describe, expect, it } from "vitest";
import { COMPARISON_ROUTES } from "./compare/content";
import { GUIDE_SLUGS } from "./guides/content";
import { SERVICES, SERVICE_PAGE_SAMPLES } from "./services/service-content";
import sitemap from "./sitemap";

describe("public sitemap", () => {
  const urls = sitemap().map((entry) => entry.url);

  it("includes every public discovery route", () => {
    expect(urls).toEqual(
      expect.arrayContaining([
        "https://trustysquire.ai/",
        "https://trustysquire.ai/start",
        "https://trustysquire.ai/use-cases",
        "https://trustysquire.ai/use-cases/website-signup",
        "https://trustysquire.ai/use-cases/sign-in-and-configure",
        "https://trustysquire.ai/use-cases/api-keys-without-env",
        "https://trustysquire.ai/integrations",
        "https://trustysquire.ai/integrations/claude-code",
        "https://trustysquire.ai/integrations/codex",
        "https://trustysquire.ai/integrations/cursor",
        "https://trustysquire.ai/integrations/opencode",
        "https://trustysquire.ai/services",
        "https://trustysquire.ai/guides",
        "https://trustysquire.ai/compare",
        "https://trustysquire.ai/blog",
        "https://trustysquire.ai/blog/frontier-commodities",
        "https://trustysquire.ai/blog/smarter-coding-agents-are-better-liars",
        "https://trustysquire.ai/blog/the-last-mile-is-a-signup-form",
        "https://trustysquire.ai/privacy",
        "https://trustysquire.ai/terms",
      ]),
    );
  });

  it("includes every generated service, guide, and comparison page", () => {
    for (const service of SERVICE_PAGE_SAMPLES) {
      expect(urls).toContain(`https://trustysquire.ai/services/${service.registry.service}`);
    }
    for (const slug of GUIDE_SLUGS) {
      expect(urls).toContain(`https://trustysquire.ai/guides/${slug}`);
    }
    for (const comparison of COMPARISON_ROUTES) {
      expect(urls).toContain(`https://trustysquire.ai/compare/${comparison.slug}`);
    }
  });

  it("does not index registry services before their detailed page passes review", () => {
    const sampleSlugs = new Set(SERVICE_PAGE_SAMPLES.map((service) => service.registry.service));
    for (const service of SERVICES) {
      if (sampleSlugs.has(service.registry.service)) continue;
      expect(urls).not.toContain(`https://trustysquire.ai/services/${service.registry.service}`);
    }
  });

  it("excludes account and application routes", () => {
    for (const path of ["login", "install", "vault", "agents", "billing"]) {
      expect(urls).not.toContain(`https://trustysquire.ai/${path}`);
    }
  });

  it("does not emit duplicate URLs", () => {
    expect(new Set(urls).size).toBe(urls.length);
  });

  it("uses the substantive revision date for updated articles", () => {
    const lastMile = sitemap().find(
      (entry) => entry.url === "https://trustysquire.ai/blog/the-last-mile-is-a-signup-form",
    );
    expect(lastMile?.lastModified).toBe("2026-07-15");
  });
});
