import { describe, expect, it } from "vitest";
import { articleMetadata, publicMetadata } from "./public-metadata";

describe("public metadata", () => {
  it("builds a canonical URL and aligned social copy", () => {
    const metadata = publicMetadata(
      "Website signup",
      "Let a coding agent complete the signup.",
      "/use-cases/website-signup",
    );

    expect(metadata.alternates).toEqual({
      canonical: "https://trustysquire.ai/use-cases/website-signup",
    });
    expect(metadata.openGraph).toMatchObject({
      title: "Website signup | Trusty Squire",
      description: "Let a coding agent complete the signup.",
      url: "https://trustysquire.ai/use-cases/website-signup",
      type: "website",
    });
    expect(metadata.twitter).toMatchObject({
      card: "summary",
      title: "Website signup | Trusty Squire",
      description: "Let a coding agent complete the signup.",
    });
  });

  it("marks blog metadata as an article", () => {
    const metadata = articleMetadata("A post", "Post description", "/blog/a-post", "2026-07-02");

    expect(metadata.openGraph).toMatchObject({
      type: "article",
      publishedTime: "2026-07-02",
      url: "https://trustysquire.ai/blog/a-post",
    });
  });
});
