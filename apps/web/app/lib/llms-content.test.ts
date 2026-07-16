import { describe, expect, it } from "vitest";
import { COMPARISON_ROUTES } from "../compare/content";
import { GUIDE_SLUGS } from "../guides/content";
import { SERVICES, SERVICE_PAGE_SAMPLES } from "../services/service-content";
import { buildLlmsFullTxt, buildLlmsTxt } from "./llms-content";

describe("LLM discovery files", () => {
  function serviceLines(content: string): string[] {
    const serviceSection = content
      .split("## Active registry-backed services\n", 2)[1]
      ?.split("\n## Guides\n", 1)[0];
    if (serviceSection === undefined) throw new Error("Missing active service section");
    return serviceSection.split("\n").filter((line) => line.startsWith("- "));
  }

  it("states the product, install command, trust boundary, and honest limit", () => {
    const content = buildLlmsTxt();
    expect(content).toContain("Trusty Squire is an MCP server");
    expect(content).toContain("npx @trusty-squire/mcp connect");
    expect(content).toContain("write-only vault");
    expect(content).toContain("hard CAPTCHA");
    expect(content).toContain("can enter agent context");
    for (const service of SERVICE_PAGE_SAMPLES) {
      expect(content).toContain(`/services/${service.registry.service}`);
    }
  });

  it("includes every generated service, guide, and comparison route", () => {
    const content = buildLlmsFullTxt();
    for (const service of SERVICES) expect(content).toContain(service.name);
    for (const service of SERVICE_PAGE_SAMPLES) {
      expect(content).toContain(`/services/${service.registry.service}`);
    }
    for (const slug of GUIDE_SLUGS) expect(content).toContain(`/guides/${slug}`);
    for (const comparison of COMPARISON_ROUTES) {
      expect(content).toContain(`/compare/${comparison.slug}`);
    }
  });

  it("limits prose and detail links to reviewed service-page samples", () => {
    const content = buildLlmsFullTxt();
    const lines = serviceLines(content);
    const publishedSlugs = new Set(SERVICE_PAGE_SAMPLES.map((service) => service.registry.service));

    expect(lines).toHaveLength(SERVICES.length);
    for (const service of SERVICES) {
      const line = lines.find((candidate) =>
        candidate.startsWith(
          publishedSlugs.has(service.registry.service)
            ? `- [${service.name}]`
            : `- ${service.name} `,
        ),
      );
      expect(line).toBeDefined();

      if (publishedSlugs.has(service.registry.service)) {
        expect(line).toBe(
          `- [${service.name}](https://trustysquire.ai/services/${service.registry.service}): ${service.summary}`,
        );
      } else {
        expect(line).toBe(`- ${service.name} (status: ${service.registry.status})`);
        expect(line).not.toContain(`/services/${service.registry.service}`);
        expect(line).not.toContain(service.summary);
      }
    }
  });

  it("does not expose private registry detail for unpublished services", () => {
    const lines = serviceLines(buildLlmsFullTxt());
    const publishedSlugs = new Set(SERVICE_PAGE_SAMPLES.map((service) => service.registry.service));

    for (const service of SERVICES) {
      if (publishedSlugs.has(service.registry.service)) continue;
      const line = lines.find(
        (candidate) => candidate === `- ${service.name} (status: ${service.registry.status})`,
      );
      if (line === undefined) throw new Error(`Missing unpublished service row: ${service.name}`);
      expect(line).not.toContain(service.registry.skill_id);
      expect(line).not.toContain(service.publicSignupUrl);
      expect(line).not.toContain(service.prompt);
      expect(line).not.toContain(service.outcome);
    }

    const section = lines.join("\n");
    for (const privateField of [
      "signup_url",
      "dom_hint",
      "text_match",
      "near_text_hint",
      "href_hint",
      "value_template",
      "provenance",
    ]) {
      expect(section).not.toContain(privateField);
    }
  });
});
