import { SERVICE_CONTENT_A } from "./service-content-a";
import { SERVICE_CONTENT_B } from "./service-content-b";
import {
  PUBLISHED_SERVICE_DETAILS,
  PUBLISHED_SERVICE_SLUGS,
  type PublishedServiceSlug,
} from "./service-pages";
import type {
  PublishedServicePage,
  RegistryCredential,
  RegistryStep,
  ServiceFaq,
  ServicePageContent,
} from "./service-types";

const EXPECTED_ACTIVE_COUNT = 82;
export const REGISTRY_VERIFIED_ON = "2026-07-15";

function assertCatalog(services: readonly ServicePageContent[]): void {
  const slugs = new Set<string>();
  for (const service of services) {
    if (service.registry.status !== "active") {
      throw new Error(`Refusing to publish inactive service: ${service.registry.service}`);
    }
    if (slugs.has(service.registry.service)) {
      throw new Error(`Duplicate service page: ${service.registry.service}`);
    }
    if (service.registry.credentials.length === 0 || service.registry.steps.length === 0) {
      throw new Error(`Incomplete registry snapshot: ${service.registry.service}`);
    }
    if (service.faqs !== undefined && (service.faqs.length < 3 || service.faqs.length > 5)) {
      throw new Error(`Service FAQs must contain 3 to 5 items: ${service.registry.service}`);
    }
    slugs.add(service.registry.service);
  }

  if (services.length !== EXPECTED_ACTIVE_COUNT) {
    throw new Error(
      `Expected ${EXPECTED_ACTIVE_COUNT} active service pages, received ${services.length}`,
    );
  }

  for (const service of services) {
    for (const related of service.related) {
      if (!slugs.has(related)) {
        throw new Error(`Unknown related service ${related} on ${service.registry.service}`);
      }
    }
  }
}

export const SERVICES: readonly ServicePageContent[] = [
  ...SERVICE_CONTENT_A,
  ...SERVICE_CONTENT_B,
].sort((a, b) => a.name.localeCompare(b.name));

assertCatalog(SERVICES);

export const SERVICE_BY_SLUG = new Map(
  SERVICES.map((service) => [service.registry.service, service] as const),
);

export const SERVICE_PAGE_SAMPLE_SLUGS = PUBLISHED_SERVICE_SLUGS;

export const SERVICE_PAGE_SAMPLES: readonly PublishedServicePage[] = SERVICE_PAGE_SAMPLE_SLUGS.map(
  (slug) => {
    const service = SERVICE_BY_SLUG.get(slug);
    if (service === undefined) throw new Error(`Missing service-page sample: ${slug}`);
    const published = PUBLISHED_SERVICE_DETAILS[slug];
    const recordedSteps = new Set(service.registry.steps.map((step) => step.summary));
    for (const evidence of published.signupEvidence) {
      if (!recordedSteps.has(evidence)) {
        throw new Error(`Signup evidence is not in the ${slug} registry record: ${evidence}`);
      }
    }
    if (service.dataQuality?.some((note) => note.startsWith("Content eligibility: review."))) {
      throw new Error(`Refusing to publish review-gated service: ${slug}`);
    }
    return { ...service, published };
  },
);

const SERVICE_PAGE_SAMPLE_SET = new Set<string>(SERVICE_PAGE_SAMPLE_SLUGS);
const SERVICE_PAGE_BY_SLUG = new Map(
  SERVICE_PAGE_SAMPLES.map((service) => [service.registry.service, service] as const),
);

for (const service of SERVICE_PAGE_SAMPLES) {
  for (const related of service.published.relatedSampleSlugs) {
    if (related === service.registry.service || !SERVICE_PAGE_SAMPLE_SET.has(related)) {
      throw new Error(
        `Invalid published related service ${related} on ${service.registry.service}`,
      );
    }
  }
}

export function hasServicePage(slug: string): boolean {
  return SERVICE_PAGE_SAMPLE_SET.has(slug);
}

export function getService(slug: string): ServicePageContent | undefined {
  return SERVICE_BY_SLUG.get(slug);
}

export function getServicePage(slug: string): PublishedServicePage | undefined {
  return SERVICE_PAGE_BY_SLUG.get(slug);
}

export function getRelatedServices(service: PublishedServicePage): PublishedServicePage[] {
  return service.published.relatedSampleSlugs.map((slug) => {
    const related = SERVICE_PAGE_BY_SLUG.get(slug);
    if (related === undefined) {
      throw new Error(`Missing published related service ${slug} on ${service.registry.service}`);
    }
    return related;
  });
}

export function publicCredentialDescription(
  service: PublishedServicePage,
  credential: RegistryCredential,
  index: number,
): string {
  const override = service.published.credentialPublicDescriptions?.[index];
  if (override !== undefined) return override;
  const visibility =
    credential.visibility === "show_once_at_creation" ? " It is shown once at creation." : "";
  return `${credential.env_var_suggestion} is a ${credential.shape_hint} ${credential.type} validated at ${credential.post_extract_validator.min_length} to ${credential.post_extract_validator.max_length} characters.${visibility}`;
}

export function getServiceFaqs(service: PublishedServicePage): readonly ServiceFaq[] {
  const provider = service.registry.oauth_provider;
  const credentialSummary = service.registry.credentials
    .map((credential, index) => publicCredentialDescription(service, credential, index))
    .join(" ");
  const evidence = service.published.signupEvidence.join(" ");
  const signupAnswer =
    service.published.signupMode === "email"
      ? `Yes, for the reviewed email flow. ${evidence} A hard CAPTCHA, payment, phone requirement, or human-only decision still stops the run for you.`
      : `For a new account, the reviewed skill uses ${provider ?? "federated"} sign-in as the provider's signup path; for an existing identity, the same path signs in instead. ${evidence} A hard CAPTCHA, payment, phone requirement, or human-only decision still stops the run for you.`;

  return [
    {
      question: `How do I use the ${service.name} API key without .env?`,
      answer: `Ask your coding agent: “${service.published.prompt}” Trusty Squire captures the provider credential directly into its write-only vault instead of returning it for an .env file. ${credentialSummary}`,
    },
    {
      question: `Can Trusty Squire automate ${service.name} signup?`,
      answer: signupAnswer,
    },
    {
      question: `How does ${service.name} MCP provisioning keep the API key private?`,
      answer: `Trusty Squire is the MCP server between your coding agent and the vault. It stores the captured ${service.name} credential as a write-only value, then returns a reference or scoped egress grant instead of the raw provider key. The backend grant can call only its configured provider host and remains revocable and auditable.`,
    },
    {
      question: `What can I do with the generated ${service.name} credential?`,
      answer: service.published.credentialUse,
    },
    {
      question: `What should I verify before using ${service.name} in production?`,
      answer: service.published.limits,
    },
  ];
}

export function describeRegistryStep(step: RegistryStep): string {
  return step.summary;
}

export function appAccessSnippet(service: PublishedServicePage): string {
  return (
    `// One-time Vault policy: make ${service.published.integration.apiHost}\n` +
    `// the primary allowed host. Off-allowlist requests are refused.\n\n` +
    `// Then ask your agent to create a scoped grant:\n` +
    `grant_app_access({\n` +
    `  service: "${service.registry.service}",\n` +
    `  rate_limit_per_hour: 100\n` +
    `})\n\n` +
    `// Inject the returned fields from backend-only secret storage:\n` +
    `// SQUIRE_EGRESS_BASE_URL=<returned base_url>\n` +
    `// SQUIRE_EGRESS_TOKEN=<returned token>\n\n` +
    service.published.integration.requestSnippet
  );
}

export type { PublishedServiceSlug };
