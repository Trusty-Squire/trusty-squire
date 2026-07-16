import { describe, expect, it } from "vitest";
import { generateMetadata, generateStaticParams } from "./[slug]/page";
import { COMPARISONS, COMPARISON_SLUGS, getComparison } from "./content";

describe("comparison discovery content", () => {
  it("publishes the six planned static comparison routes", () => {
    expect(COMPARISON_SLUGS).toHaveLength(6);
    expect(new Set(COMPARISON_SLUGS).size).toBe(6);
    expect(generateStaticParams()).toEqual(COMPARISON_SLUGS.map((slug) => ({ slug })));
    expect(getComparison("not-a-comparison")).toBeUndefined();
  });

  it("keeps tables well-formed and claims backed by official links", () => {
    for (const slug of COMPARISON_SLUGS) {
      const comparison = COMPARISONS[slug];
      expect(comparison.description.length).toBeGreaterThan(80);
      expect(comparison.answer.length).toBeGreaterThanOrEqual(2);
      expect(comparison.columns.length).toBeGreaterThanOrEqual(3);
      expect(comparison.rows.length).toBeGreaterThanOrEqual(4);
      for (const row of comparison.rows) {
        expect(row.values).toHaveLength(comparison.columns.length - 1);
      }
      expect(comparison.sections.length).toBeGreaterThanOrEqual(2);
      expect(comparison.faqs.length).toBeGreaterThanOrEqual(3);
      expect(comparison.faqs.length).toBeLessThanOrEqual(5);
      expect(comparison.sourceRefs.length).toBeGreaterThanOrEqual(2);
      for (const source of comparison.sourceRefs) {
        expect(new URL(source.url).protocol).toBe("https:");
      }
      for (const related of comparison.related) expect(related.href).toMatch(/^\//);
    }
  });

  it("generates a canonical without duplicating the brand", async () => {
    const slug = "trusty-squire-vs-1password-mcp";
    const metadata = await generateMetadata({ params: Promise.resolve({ slug }) });
    expect(metadata.title).toEqual({ absolute: COMPARISONS[slug].title });
    expect(metadata.alternates).toEqual({
      canonical: `https://trustysquire.ai/compare/${slug}`,
    });
  });
});
