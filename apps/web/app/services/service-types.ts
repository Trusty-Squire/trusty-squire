export type RegistryStepKind =
  | "navigate"
  | "click"
  | "click_oauth_button"
  | "fill"
  | "select"
  | "await_email_code"
  | "extract_labeled"
  | "extract_via_copy_button"
  | "extract_via_copy_button_named"
  | "extract_via_regex";

export interface RegistryStep {
  kind: RegistryStepKind;
  /** Public, sanitized description. Captured DOM labels, IDs, and literal values are omitted. */
  summary: string;
}

export interface RegistryCredential {
  name?: string;
  type: "api_key";
  shape_hint: string;
  env_var_suggestion: string;
  visibility?: string;
  post_extract_validator: {
    min_length: number;
    max_length: number;
  };
}

export interface ActiveRegistrySkill {
  service: string;
  version: string;
  skill_id: string;
  status: "active";
  oauth_provider: string | null;
  source_step_count: number;
  steps: readonly RegistryStep[];
  credentials: readonly RegistryCredential[];
}

export interface ServiceFaq {
  question: string;
  answer: string;
}

export interface ServicePageContent {
  registry: ActiveRegistrySkill;
  /** Human-readable product name. */
  name: string;
  category: string;
  /** One concise sentence used on the hub and near the page title. */
  summary: string;
  metaDescription: string;
  /** The exact natural-language request shown as the primary example. */
  prompt: string;
  /** Stable provider entry point. Captured tenant, user, app, and project paths are removed. */
  publicSignupUrl: string;
  /** What a developer can do after the credential is available. */
  outcome: string;
  useCases: readonly [string, string, ...string[]];
  /** Service-specific safety context. Shared vault guarantees are rendered separately. */
  vaultSafety: string;
  /** Optional overrides. The page supplies four data-derived FAQs when omitted. */
  faqs?: readonly ServiceFaq[];
  /** Active service slugs only. Invalid or unavailable slugs are filtered before rendering. */
  related: readonly [string, string, ...string[]];
  /** Registry quality notes for maintainers. These are never rendered as product claims. */
  dataQuality?: readonly string[];
}

export interface PublishedServiceDetails {
  /** How the reviewed registry flow creates a new provider account. */
  signupMode: "email" | "federated";
  /** Exact sanitized step summaries that support the signup claim. */
  signupEvidence: readonly [string, string, ...string[]];
  /** Two service-specific sentences used immediately below the H1. */
  intro: readonly [string, string];
  /** Outcome-first prompt shown verbatim to the developer. */
  prompt: string;
  /** What the captured credential can do, based on the provider's official API docs. */
  credentialUse: string;
  /** Public descriptions that override registry validator shapes when provider environments differ. */
  credentialPublicDescriptions?: readonly string[];
  /** Provider-specific setup details that remain outside the credential flow. */
  limits: string;
  integration: {
    apiHost: string;
    operation: string;
    docsLabel: string;
    docsUrl: string;
    /** A real provider request routed through the returned Trusty Squire base URL. */
    requestSnippet: string;
  };
  /** Curated sideways links; every slug must be another reviewed sample. */
  relatedSampleSlugs: readonly [string, string, string, string];
}

export type PublishedServicePage = ServicePageContent & {
  published: PublishedServiceDetails;
};

export function defineServices<const T extends readonly ServicePageContent[]>(services: T): T {
  return services;
}
