import type { MetadataRoute } from "next";
import { POSTS } from "./blog/posts";
import { COMPARISON_ROUTES } from "./compare/content";
import { GUIDE_SLUGS } from "./guides/content";
import { SERVICE_PAGE_SAMPLES } from "./services/service-content";

const SITE_URL = "https://trustysquire.ai";
const DISCOVERY_UPDATED = "2026-07-15T00:00:00.000Z";
const BLOG_UPDATED = POSTS.reduce((latest, post) => {
  const updated = post.modifiedIso ?? post.iso;
  return updated > latest ? updated : latest;
}, "");

const PUBLIC_ROUTES: MetadataRoute.Sitemap = [
  {
    url: `${SITE_URL}/`,
    lastModified: DISCOVERY_UPDATED,
    changeFrequency: "weekly",
    priority: 1,
  },
  {
    url: `${SITE_URL}/start`,
    lastModified: DISCOVERY_UPDATED,
    changeFrequency: "monthly",
    priority: 0.9,
  },
  {
    url: `${SITE_URL}/use-cases`,
    lastModified: DISCOVERY_UPDATED,
    changeFrequency: "monthly",
    priority: 0.9,
  },
  ...[
    "/use-cases/website-signup",
    "/use-cases/sign-in-and-configure",
    "/use-cases/api-keys-without-env",
  ].map((path) => ({
    url: `${SITE_URL}${path}`,
    lastModified: DISCOVERY_UPDATED,
    changeFrequency: "monthly" as const,
    priority: 0.8,
  })),
  {
    url: `${SITE_URL}/integrations`,
    lastModified: DISCOVERY_UPDATED,
    changeFrequency: "monthly",
    priority: 0.9,
  },
  ...["/integrations/claude-code", "/integrations/codex", "/integrations/cursor"].map((path) => ({
    url: `${SITE_URL}${path}`,
    lastModified: DISCOVERY_UPDATED,
    changeFrequency: "monthly" as const,
    priority: 0.8,
  })),
  {
    url: `${SITE_URL}/services`,
    lastModified: DISCOVERY_UPDATED,
    changeFrequency: "weekly",
    priority: 0.95,
  },
  ...SERVICE_PAGE_SAMPLES.map((service) => ({
    url: `${SITE_URL}/services/${service.registry.service}`,
    lastModified: DISCOVERY_UPDATED,
    changeFrequency: "monthly" as const,
    priority: 0.75,
  })),
  {
    url: `${SITE_URL}/guides`,
    lastModified: DISCOVERY_UPDATED,
    changeFrequency: "monthly",
    priority: 0.9,
  },
  ...GUIDE_SLUGS.map((slug) => ({
    url: `${SITE_URL}/guides/${slug}`,
    lastModified: DISCOVERY_UPDATED,
    changeFrequency: "monthly" as const,
    priority: 0.8,
  })),
  {
    url: `${SITE_URL}/compare`,
    lastModified: DISCOVERY_UPDATED,
    changeFrequency: "monthly",
    priority: 0.85,
  },
  ...COMPARISON_ROUTES.map((comparison) => ({
    url: `${SITE_URL}/compare/${comparison.slug}`,
    lastModified: DISCOVERY_UPDATED,
    changeFrequency: "monthly" as const,
    priority: 0.75,
  })),
  {
    url: `${SITE_URL}/blog`,
    lastModified: BLOG_UPDATED || DISCOVERY_UPDATED,
    changeFrequency: "weekly",
    priority: 0.7,
  },
  ...POSTS.map((post) => ({
    url: `${SITE_URL}/blog/${post.slug}`,
    lastModified: post.modifiedIso ?? post.iso,
    changeFrequency: "yearly" as const,
    priority: 0.6,
  })),
  {
    url: `${SITE_URL}/privacy`,
    lastModified: DISCOVERY_UPDATED,
    changeFrequency: "yearly",
    priority: 0.2,
  },
  {
    url: `${SITE_URL}/terms`,
    lastModified: DISCOVERY_UPDATED,
    changeFrequency: "yearly",
    priority: 0.2,
  },
];

export default function sitemap(): MetadataRoute.Sitemap {
  return PUBLIC_ROUTES;
}
