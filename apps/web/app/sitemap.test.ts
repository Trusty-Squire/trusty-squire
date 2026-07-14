import { describe, expect, it } from "vitest";
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
        "https://trustysquire.ai/blog",
        "https://trustysquire.ai/blog/smarter-coding-agents-are-better-liars",
        "https://trustysquire.ai/blog/the-last-mile-is-a-signup-form",
        "https://trustysquire.ai/privacy",
        "https://trustysquire.ai/terms",
      ]),
    );
  });

  it("excludes account and application routes", () => {
    for (const path of ["login", "install", "vault", "agents", "billing"]) {
      expect(urls).not.toContain(`https://trustysquire.ai/${path}`);
    }
  });

  it("does not emit duplicate URLs", () => {
    expect(new Set(urls).size).toBe(urls.length);
  });
});
