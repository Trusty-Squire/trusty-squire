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

// Canonical service slug from a HOSTNAME: the registrable domain's MAIN label.
// "resend.com" → "resend", "console.neon.tech" → "neon", "app.x.com" → "x".
// Feeding the full host to canonicalizeServiceSlug dashed the dot ("resend-com"),
// fragmenting the namespace from the clean agent/housekeeper slugs so new skills
// never superseded old ones and the slug lookup missed them. Used by BOTH the
// hint lookup (serviceSlugFromUrl) and the producer so a skill lands under the
// SAME slug the next provision reads.
export function serviceSlugFromHost(host: string): string {
  const clean = host.trim().toLowerCase().replace(/^www\./, "");
  const parts = clean.split(".").filter((p) => p.length > 0);
  const main = parts.length >= 2 ? parts[parts.length - 2]! : (parts[0] ?? clean);
  return canonicalizeServiceSlug(main);
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
