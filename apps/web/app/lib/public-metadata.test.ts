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
      card: "summary_large_image",
      title: "Website signup | Trusty Squire",
      description: "Let a coding agent complete the signup.",
    });
  });

  it("keeps an already-branded SEO title absolute", () => {
    const title = "Let Claude Code sign up for Clerk and store the API key safely — Trusty Squire";
    const metadata = publicMetadata(
      title,
      "Clerk setup without a plaintext key.",
      "/services/clerk",
      {
        absoluteTitle: true,
      },
    );

    expect(metadata.title).toEqual({ absolute: title });
    expect(metadata.openGraph).toMatchObject({ title });
    expect(metadata.twitter).toMatchObject({ title, card: "summary_large_image" });
  });

  it("marks blog metadata as an article", () => {
    const metadata = articleMetadata(
      "A post",
      "Post description",
      "/blog/a-post",
      "2026-07-02",
      "2026-07-15",
    );

    expect(metadata.openGraph).toMatchObject({
      type: "article",
      publishedTime: "2026-07-02",
      modifiedTime: "2026-07-15",
      url: "https://trustysquire.ai/blog/a-post",
    });
  });
});
