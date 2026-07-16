import { describe, expect, it } from "vitest";
import { generateMetadata, generateStaticParams } from "../[service]/page";
import { SERVICE_CONTENT_A } from "../service-content-a";
import {
  appAccessSnippet,
  getRelatedServices,
  getService,
  getServiceFaqs,
  getServicePage,
  publicCredentialDescription,
  SERVICES,
  SERVICE_PAGE_SAMPLE_SLUGS,
  SERVICE_PAGE_SAMPLES,
} from "../service-content";

const EXPECTED_A_SLUGS = [
  "activeloop",
  "ai21",
  "algolia",
  "anthropic-api",
  "apify",
  "assemblyai",
  "axiom",
  "baseten",
  "braintrust",
  "brevo",
  "cartesia",
  "cerebras",
  "chroma",
  "clerk",
  "cloud66",
  "codesandbox",
  "cohere",
  "convex",
  "daytona",
  "deepinfra",
  "deepseek",
  "e2b",
  "electric-sql",
  "elevenlabs",
  "falai",
  "fireworks-ai",
  "fly-io",
  "friendliai",
  "gladia",
  "groq",
  "helicone",
  "honeycomb",
  "hookdeck",
  "hyperbolic",
  "ideogram",
  "imagekit",
  "ipinfo",
] as const;

describe("service page catalog", () => {
  it("contains the exact active A through I service set", () => {
    expect(SERVICE_CONTENT_A.map((service) => service.registry.service).sort()).toEqual(
      EXPECTED_A_SLUGS,
    );
  });

  it("tracks 82 unique active services and publishes only five reviewed samples", () => {
    const slugs = SERVICES.map((service) => service.registry.service);
    expect(slugs).toHaveLength(82);
    expect(new Set(slugs).size).toBe(82);
    expect(SERVICES.every((service) => service.registry.status === "active")).toBe(true);
    expect(SERVICE_PAGE_SAMPLES).toHaveLength(5);
    expect(SERVICE_PAGE_SAMPLE_SLUGS).toEqual([
      "braintrust",
      "cerebras",
      "clerk",
      "deepinfra",
      "zilliz",
    ]);
    expect(generateStaticParams()).toEqual(
      SERVICE_PAGE_SAMPLES.map((service) => ({ service: service.registry.service })),
    );
    expect(generateStaticParams()).not.toContainEqual({ service: "sentry" });
    expect(getService("not-an-active-service")).toBeUndefined();
  });

  it("keeps every public page useful and internally linked", () => {
    for (const service of SERVICES) {
      expect(service.summary.length).toBeGreaterThan(40);
      expect(service.metaDescription.length).toBeGreaterThan(80);
      expect(service.prompt).toContain(service.name);
      expect(service.useCases.length).toBeGreaterThanOrEqual(2);
      expect(service.registry.source_step_count).toBeGreaterThanOrEqual(
        service.registry.steps.length,
      );
      expect(service.registry.steps.length).toBeGreaterThan(0);
      expect(service.registry.credentials.length).toBeGreaterThan(0);
      expect(new URL(service.publicSignupUrl).protocol).toBe("https:");
      for (const related of service.related) expect(getService(related)).toBeDefined();
    }
    for (const service of SERVICE_PAGE_SAMPLES) {
      const faqs = getServiceFaqs(service);
      expect(faqs.length).toBeGreaterThanOrEqual(3);
      expect(faqs.length).toBeLessThanOrEqual(5);
      const questions = faqs.map((faq) => faq.question.toLowerCase()).join(" ");
      expect(questions).toContain(`${service.name.toLowerCase()} api key without .env`);
      expect(questions).toContain(`automate ${service.name.toLowerCase()} signup`);
      expect(questions).toContain(`${service.name.toLowerCase()} mcp`);
      expect(faqs.at(-1)?.answer).toBe(service.published.limits);
      expect(service.published.intro).toHaveLength(2);
      expect(service.published.prompt).toContain(service.name);
      expect(service.published.prompt).toContain(service.published.integration.apiHost);
      expect(new URL(service.published.integration.docsUrl).protocol).toBe("https:");
      expect(getRelatedServices(service)).toHaveLength(4);
      for (const evidence of service.published.signupEvidence) {
        expect(service.registry.steps.map((step) => step.summary)).toContain(evidence);
      }
    }
    expect(getServicePage("anthropic-api")).toBeUndefined();

    const clerk = getServicePage("clerk");
    expect(clerk).toBeDefined();
    const clerkCredential = clerk?.registry.credentials[0];
    expect(clerkCredential).toBeDefined();
    if (clerk !== undefined && clerkCredential !== undefined) {
      const description = publicCredentialDescription(clerk, clerkCredential, 0);
      expect(description).toContain("Development instances use sk_test_");
      expect(description).toContain("production instances use sk_live_");
      expect(
        getServiceFaqs(clerk)
          .map((faq) => faq.answer)
          .join(" "),
      ).not.toContain("prefix:sk_live");
    }
  });

  it("strips captured account, project, DOM, and literal-secret data from the public snapshot", () => {
    const publicKeys = new Set<string>();
    const collectKeys = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const item of value) collectKeys(item);
        return;
      }
      if (value === null || typeof value !== "object") return;
      for (const [key, item] of Object.entries(value)) {
        publicKeys.add(key);
        collectKeys(item);
      }
    };
    collectKeys(SERVICES);
    for (const privateRegistryField of [
      "signup_url",
      "dom_hint",
      "text_match",
      "near_text_hint",
      "href_hint",
      "value_template",
      "provenance",
    ]) {
      expect(publicKeys).not.toContain(privateRegistryField);
    }
    for (const service of SERVICES) {
      const publicUrl = new URL(service.publicSignupUrl);
      expect(publicUrl.username).toBe("");
      expect(publicUrl.password).toBe("");
      expect(publicUrl.search).toBe("");
      expect(publicUrl.hash).toBe("");
    }
  });

  it("uses scoped egress placeholders without embedding a provider credential", () => {
    for (const service of SERVICE_PAGE_SAMPLES) {
      const snippet = appAccessSnippet(service);
      expect(snippet).toContain(`service: "${service.registry.service}"`);
      expect(snippet).toContain("grant_app_access");
      expect(snippet).toContain("SQUIRE_EGRESS_BASE_URL");
      expect(snippet).toContain("SQUIRE_EGRESS_TOKEN");
      expect(snippet).toContain(service.published.integration.apiHost);
      expect(snippet).not.toContain("/provider/path");
      for (const credential of service.registry.credentials) {
        expect(snippet).not.toContain(credential.env_var_suggestion);
      }
    }
  });

  it("generates exact branded metadata for a service route", async () => {
    const metadata = await generateMetadata({
      params: Promise.resolve({ service: "deepinfra" }),
    });
    expect(metadata.title).toEqual({
      absolute:
        "Let Claude Code sign up for DeepInfra and store the API key safely — Trusty Squire",
    });
    expect(metadata.alternates).toEqual({
      canonical: "https://trustysquire.ai/services/deepinfra",
    });
  });
});
