// Canonical service slugs shared by the MCP worker and registry.
//
// Keep this list narrow: aliases are for known historical duplicate slugs with
// registry evidence, not for fuzzy product-name matching.

const SERVICE_SLUG_ALIASES: Readonly<Record<string, string>> = {
  anthropic: "anthropic-api",
  fireworks: "fireworks-ai",
  fly: "fly-io",
  together: "together-ai",
};

function normalizeServiceSlug(slug: string): string {
  return slug.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function canonicalizeServiceSlug(slug: string): string {
  const normalized = normalizeServiceSlug(slug);
  return SERVICE_SLUG_ALIASES[normalized] ?? normalized;
}

export function equivalentServiceSlugs(slug: string): string[] {
  const canonical = canonicalizeServiceSlug(slug);
  const out = new Set<string>([canonical]);
  for (const [alias, target] of Object.entries(SERVICE_SLUG_ALIASES)) {
    if (target === canonical) out.add(alias);
  }
  return [...out];
}

export function serviceSlugLookupOrder(slug: string): string[] {
  const normalized = normalizeServiceSlug(slug);
  const canonical = canonicalizeServiceSlug(normalized);
  return [...new Set([canonical, normalized])];
}
