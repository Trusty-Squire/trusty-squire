// T44 — service-category map. Inlined as a TypeScript constant
// (instead of a yaml-at-runtime read) so the data ships in the
// compiled tarball without a separate file-copy step in the build,
// and there's no production-vs-dev path discrepancy. The yaml at
// service-categories.yaml is the human-editable source of truth —
// regenerate this file from it via `pnpm gen:service-categories`
// when adding services.
//
// Slug = registry canonical (anthropic-api, together-ai, …). Agent-
// provided service strings that don't match here just don't get a
// category-peer recommendation — soft hint, not an error.

export interface ServiceCategoryEntry {
  slug: string;
  category: string;
}

// Categories — keep stable; downstream queries reference these names.
export const SERVICE_CATEGORIES: readonly ServiceCategoryEntry[] = [
  // Email — transactional + marketing
  { slug: "resend",             category: "email-transactional" },
  { slug: "postmark",           category: "email-transactional" },
  { slug: "mailgun",            category: "email-transactional" },
  { slug: "sendgrid",           category: "email-transactional" },
  { slug: "brevo",              category: "email-transactional" },
  { slug: "mailtrap",           category: "email-transactional" },
  { slug: "loops",              category: "email-transactional" },
  { slug: "plunk",              category: "email-transactional" },
  { slug: "mailersend",         category: "email-transactional" },

  // LLM API (chat / completion / embedding endpoints)
  { slug: "openrouter",         category: "llm-api" },
  { slug: "anthropic-api",      category: "llm-api" },
  { slug: "deepinfra",          category: "llm-api" },
  { slug: "replicate",          category: "llm-api" },
  { slug: "together-ai",        category: "llm-api" },
  { slug: "groq",               category: "llm-api" },
  { slug: "fireworks",          category: "llm-api" },
  { slug: "mistral",            category: "llm-api" },
  { slug: "perplexity",         category: "llm-api" },
  { slug: "cohere",             category: "llm-api" },
  { slug: "hyperbolic",         category: "llm-api" },
  { slug: "baseten",            category: "llm-api" },

  // Vector DB
  { slug: "pinecone",           category: "vector-db" },
  { slug: "weaviate",           category: "vector-db" },
  { slug: "qdrant",             category: "vector-db" },
  { slug: "chroma",             category: "vector-db" },

  // Managed relational + KV databases
  { slug: "planetscale",        category: "managed-db" },
  { slug: "supabase",           category: "managed-db" },
  { slug: "neon",               category: "managed-db" },
  { slug: "turso",              category: "managed-db" },
  { slug: "xata",               category: "managed-db" },
  { slug: "convex",             category: "managed-db" },
  { slug: "upstash",            category: "managed-db" },
  { slug: "redis-cloud",        category: "managed-db" },
  { slug: "cockroachdb",        category: "managed-db" },

  // Application hosting / PaaS
  { slug: "railway",            category: "app-hosting" },
  { slug: "porter",             category: "app-hosting" },
  { slug: "zeabur",             category: "app-hosting" },
  { slug: "render",             category: "app-hosting" },
  { slug: "vercel",             category: "app-hosting" },
  { slug: "netlify",            category: "app-hosting" },
  { slug: "fly",                category: "app-hosting" },
  { slug: "northflank",         category: "app-hosting" },
  { slug: "digitalocean",       category: "app-hosting" },

  // Error tracking / observability / logging
  { slug: "sentry",             category: "error-tracking" },
  { slug: "highlight",          category: "error-tracking" },
  { slug: "axiom",              category: "error-tracking" },
  { slug: "honeycomb",          category: "error-tracking" },
  { slug: "baselime",           category: "error-tracking" },
  { slug: "last9",              category: "error-tracking" },
  { slug: "betterstack-logs",   category: "error-tracking" },
  { slug: "grafana-cloud",      category: "error-tracking" },

  // Product analytics
  { slug: "posthog",            category: "product-analytics" },
  { slug: "mixpanel",           category: "product-analytics" },
  { slug: "amplitude",          category: "product-analytics" },
  { slug: "plausible",          category: "product-analytics" },
  { slug: "fathom",             category: "product-analytics" },

  // Image / video CDN + transformation
  { slug: "cloudinary",         category: "image-media-cdn" },
  { slug: "uploadcare",         category: "image-media-cdn" },
  { slug: "imagekit",           category: "image-media-cdn" },

  // Search-as-a-service
  { slug: "algolia",            category: "search" },
  { slug: "meilisearch",        category: "search" },
  { slug: "typesense",          category: "search" },

  // Auth / identity / SSO
  { slug: "clerk",              category: "auth-identity" },
  { slug: "stytch",             category: "auth-identity" },
  { slug: "workos",             category: "auth-identity" },
  { slug: "kinde",              category: "auth-identity" },

  // Feature flags / experimentation
  { slug: "launchdarkly",       category: "feature-flags" },
  { slug: "statsig",            category: "feature-flags" },
  { slug: "growthbook",         category: "feature-flags" },
  { slug: "flagsmith",          category: "feature-flags" },

  // Background jobs / workflows / webhooks
  { slug: "inngest",            category: "background-jobs" },
  { slug: "temporal",           category: "background-jobs" },
  { slug: "hatchet",            category: "background-jobs" },
  { slug: "trigger",            category: "background-jobs" },
  { slug: "hookdeck",           category: "background-jobs" },
  { slug: "svix",               category: "background-jobs" },

  // Forms
  { slug: "tally",              category: "forms" },
  { slug: "typeform",           category: "forms" },

  // Scraping / browser-as-a-service
  { slug: "apify",              category: "scraping" },
  { slug: "firecrawl",          category: "scraping" },
  { slug: "scrapingbee",        category: "scraping" },
  { slug: "browserbase",        category: "scraping" },

  // Geo / IP intelligence
  { slug: "ipinfo",             category: "geo-ip" },
  { slug: "ipdata",             category: "geo-ip" },

  // Uptime / availability monitoring
  { slug: "betterstack-uptime", category: "uptime" },
  { slug: "cronitor",           category: "uptime" },

  // Dev environments / sandboxes
  { slug: "e2b",                category: "dev-environments" },
  { slug: "daytona",            category: "dev-environments" },
  { slug: "replit",             category: "dev-environments" },
  { slug: "codesandbox",        category: "dev-environments" },
  { slug: "stackblitz",         category: "dev-environments" },

  // Comms — SMS / voice
  { slug: "twilio",             category: "comms" },
];

const BY_SLUG: Map<string, string> = new Map(
  SERVICE_CATEGORIES.map((e) => [e.slug.toLowerCase(), e.category]),
);

const BY_CATEGORY: Map<string, string[]> = (() => {
  const m = new Map<string, string[]>();
  for (const e of SERVICE_CATEGORIES) {
    const arr = m.get(e.category) ?? [];
    arr.push(e.slug.toLowerCase());
    m.set(e.category, arr);
  }
  return m;
})();

/** Return the category for `slug`, or null if unknown. */
export function categoryFor(slug: string): string | null {
  return BY_SLUG.get(slug.toLowerCase()) ?? null;
}

/** Category-peer slugs for `slug`, EXCLUDING `slug` itself.
 *  Empty array when the slug is unknown or its category has no peers. */
export function categoryPeersOf(slug: string): string[] {
  const lc = slug.toLowerCase();
  const cat = BY_SLUG.get(lc);
  if (cat === undefined) return [];
  const peers = BY_CATEGORY.get(cat) ?? [];
  return peers.filter((p) => p !== lc);
}
