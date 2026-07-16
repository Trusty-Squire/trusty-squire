import { describe, expect, it } from "vitest";
import {
  articleJsonLd,
  breadcrumbJsonLd,
  faqPageJsonLd,
  howToJsonLd,
  softwareApplicationJsonLd,
} from "./structured-data";

describe("structured data", () => {
  it("maps visible FAQs to FAQPage questions and answers", () => {
    const schema = faqPageJsonLd([
      { question: "Where is the key stored?", answer: "In the write-only vault." },
    ]);

    expect(schema).toMatchObject({
      "@type": "FAQPage",
      mainEntity: [
        {
          "@type": "Question",
          name: "Where is the key stored?",
          acceptedAnswer: { "@type": "Answer", text: "In the write-only vault." },
        },
      ],
    });
  });

  it("builds ordered absolute breadcrumbs", () => {
    const schema = breadcrumbJsonLd([
      { name: "Home", path: "/" },
      { name: "Services", path: "/services" },
    ]);

    expect(schema.itemListElement).toEqual([
      expect.objectContaining({ position: 1, item: "https://trustysquire.ai/" }),
      expect.objectContaining({
        position: 2,
        item: "https://trustysquire.ai/services",
      }),
    ]);
  });

  it("emits article and how-to URLs on the canonical origin", () => {
    expect(
      articleJsonLd({ title: "A guide", description: "Guide copy", path: "/guides/a" }),
    ).toMatchObject({ "@type": "Article", url: "https://trustysquire.ai/guides/a" });
    expect(
      howToJsonLd({
        title: "A guide",
        description: "Guide copy",
        path: "/guides/a",
        steps: [{ name: "Install", text: "Run the connect command." }],
      }),
    ).toMatchObject({
      "@type": "HowTo",
      step: [{ "@type": "HowToStep", position: 1, name: "Install" }],
    });
  });

  it("describes the product as developer software with a free offer", () => {
    expect(softwareApplicationJsonLd).toMatchObject({
      "@type": "SoftwareApplication",
      applicationCategory: "DeveloperApplication",
      offers: { price: "0", priceCurrency: "USD" },
    });
  });
});
