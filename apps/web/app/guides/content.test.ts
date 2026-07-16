import { describe, expect, it } from "vitest";
import { generateMetadata, generateStaticParams } from "./[slug]/page";
import { GUIDES, GUIDE_SLUGS, getGuide } from "./content";

describe("guide discovery content", () => {
  it("publishes the six planned static guide routes", () => {
    expect(GUIDE_SLUGS).toHaveLength(6);
    expect(new Set(GUIDE_SLUGS).size).toBe(6);
    expect(generateStaticParams()).toEqual(GUIDE_SLUGS.map((slug) => ({ slug })));
    expect(getGuide("not-a-guide")).toBeUndefined();
  });

  it("keeps each guide substantial, sourced, linked, and schema-ready", () => {
    for (const slug of GUIDE_SLUGS) {
      const guide = GUIDES[slug];
      expect(guide.title.length).toBeGreaterThan(20);
      expect(guide.description.length).toBeGreaterThan(80);
      expect(guide.answer.length).toBeGreaterThanOrEqual(2);
      expect(guide.steps.length).toBeGreaterThanOrEqual(3);
      expect(guide.sections.length).toBeGreaterThanOrEqual(2);
      expect(guide.productFit.length).toBeGreaterThan(0);
      expect(guide.limits.length).toBeGreaterThan(0);
      expect(guide.faqs.length).toBeGreaterThanOrEqual(3);
      expect(guide.faqs.length).toBeLessThanOrEqual(5);
      expect(guide.related.length).toBeGreaterThanOrEqual(3);
      for (const related of guide.related) expect(related.href).toMatch(/^\//);
      for (const source of guide.sourceRefs) {
        expect(new URL(source.url).protocol).toBe("https:");
      }
    }
  });

  it("generates a unique canonical for a nested guide", async () => {
    const slug = "keep-api-keys-out-of-ai-agent-context";
    const metadata = await generateMetadata({ params: Promise.resolve({ slug }) });
    expect(metadata.title).toBe(GUIDES[slug].title);
    expect(metadata.alternates).toEqual({
      canonical: `https://trustysquire.ai/guides/${slug}`,
    });
  });
});
