# Trusty Squire SEO and GEO notes

## What changed

This branch turns the existing Next.js 16 App Router marketing site into a registry-backed discovery system without adding a second content stack. All public discovery pages are server-rendered or statically generated, use the existing Trusty Squire design system, and ship their meaningful copy in the initial HTML.

The work includes:

- A registry-driven `/services` hub, an 82-service content snapshot, and five initial static `/services/[service]` samples for review.
- Six problem-first guides under `/guides/[slug]`.
- Six buying-intent comparisons under `/compare/[slug]`.
- Canonicals, unique metadata, large Open Graph/Twitter cards, structured data, sitemap coverage, and crawler rules.
- `/llms.txt` and `/llms-full.txt`, generated from the same service, guide, and comparison data used by the HTML routes.
- A direct, outcome-first root README that is copied byte-for-byte into the npm package during `prepack`.
- A write-only-path hardening fix so stored `operate_extract` responses cannot return raw values, plus explicit scoped grant-token disclosure.
- A ready-to-paste awesome-mcp-servers entry in `docs/awesome-mcp-servers-entry.md`.

No analytics, ownership tags, credentials, deployment settings, or production deploys were changed.

## Stack and conventions

- Framework: Next.js 16 App Router, React 19, TypeScript.
- Site root: `apps/web/app`.
- Rendering: static generation for service, guide, comparison, sitemap, Open Graph, and LLM discovery routes.
- Metadata helper: `apps/web/app/lib/public-metadata.ts`.
- Structured-data helpers: `apps/web/app/lib/structured-data.ts` and `apps/web/app/components/JsonLd.tsx`.
- Styling: the existing dark editorial design tokens in `apps/web/app/globals.css`, plus route-local CSS modules.

`/integrations` already describes coding-agent clients, so provider pages use `/services/[service]` to avoid mixing agents and provider websites under the same hub.

## Registry source of truth

The authoritative registry is the Trusty Squire registry application:

- Public route: `GET https://registry.trustysquire.ai/skills?status=active&limit=500`
- Route implementation: `apps/registry/src/routes/skills.ts`
- Production persistence: `apps/registry/src/prisma-skill-store.ts`
- Shared skill schema: `packages/skill-schema/src/skill.ts`

The discovery snapshot was checked against the live registry on 2026-07-15 and contains 82 unique active services. The first published samples are Braintrust, Cerebras, Clerk, DeepInfra, and Zilliz Cloud. Each sample has explicit signup evidence tied to sanitized registry steps and a real provider request checked against official documentation. Public content lives in:

- `apps/web/app/services/service-types.ts`
- `apps/web/app/services/service-content-a.ts`
- `apps/web/app/services/service-content-b.ts`
- `apps/web/app/services/service-pages.ts`
- `apps/web/app/services/service-content.ts`

The checked-in data preserves the active service slug, skill ID, status, credential shape, validator, source action count, and sanitized step sequence. Provider-environment differences can use reviewed public overrides without rewriting the registry snapshot; Clerk, for example, distinguishes development and production key prefixes in public copy. Captured tenant names, account IDs, project IDs, session parameters, literal passwords, brittle selectors, and tenant-specific URLs are deliberately excluded from the public repo and rendered pages.

Run this before merging any registry or service-content change:

```bash
pnpm seo:verify-services
```

The command fetches the live active registry and fails on missing services, stale services, or changed skill IDs. The web tests also reject duplicate slugs, inactive records, incomplete credential data, invalid related links, unsafe public URLs, and route omissions.

## Routes and target queries

### Services

- Hub: `/services`
- Initial spokes: `/services/braintrust`, `/services/cerebras`, `/services/clerk`, `/services/deepinfra`, and `/services/zilliz`
- Primary pattern: `{service} api key claude code`
- Supporting patterns: `{service} mcp server`, `automate {service} signup`, `get {service} api key without .env`

Each published sample contains a service-specific outcome, the exact agent prompt, sanitized steps derived from the active skill, credential details, a backend grant/injection example, vault-boundary explanation, FAQ, related services, and problem/comparison links. The remaining active records stay in the extensible data file and drift check but are excluded from static params, the sitemap, and LLM detail links until their content and workflow pass review. This follows the requested five-page approval stage and avoids thin doorway pages.

### Problem and intent guides

- `/guides/keep-api-keys-out-of-ai-agent-context`
- `/guides/coding-agent-leaked-api-key-github`
- `/guides/mcp-credential-vault`
- `/guides/automate-signup-past-bot-detection`
- `/guides/coding-agent-create-account`
- `/guides/secure-api-key-storage-for-ai-agents`

Primary clusters: keeping API keys out of AI agent context, coding-agent secret leaks, MCP secrets management, signup bot detection, automatic account creation, and secure API key storage for agents.

### Comparisons

- `/compare/trusty-squire-vs-1password-mcp`
- `/compare/trusty-squire-vs-hashicorp-vault`
- `/compare/trusty-squire-vs-infisical-doppler`
- `/compare/best-mcp-credential-management`
- `/compare/best-api-key-storage-ai-agents`
- `/compare/1password-mcp-aws-secrets-manager-alternatives`

These pages target high-intent comparison and alternative queries. Product-scope claims were checked against official vendor documentation on 2026-07-15, linked inline, and should be rechecked before material updates or procurement claims.

## Technical SEO and GEO

- Canonical metadata on every indexable route.
- Unique title and description data for services, guides, and comparisons.
- Shared 1200×630 Open Graph image and `summary_large_image` Twitter cards.
- `SoftwareApplication` schema on the homepage.
- `FAQPage` wherever an FAQ is visible.
- `BreadcrumbList` on nested discovery pages.
- `HowTo` on procedural guides and `Article` on comparisons and blog articles.
- A generated sitemap containing every approved service sample, guide, comparison, integration, use case, blog article, and public policy page.
- A robots file that allows crawling so account routes' page-level `noindex` directives can be read, and points to the sitemap.
- Direct-answer “What is Trusty Squire?” copy on the homepage and in the LLM files.
- Sideways links between related services plus links back to hubs, guides, use cases, and comparisons.

## GitHub metadata proposal

Live GitHub metadata is intentionally unchanged until the content PR is reviewed.

Proposed repository description:

> MCP server that lets coding agents sign up for websites and stores API keys in a write-only vault — Claude Code, Codex, Cursor.

Proposed topics:

`mcp`, `mcp-server`, `claude-code`, `codex`, `cursor`, `ai-agents`, `credential-management`, `api-keys`, `browser-automation`, `secrets-management`

## Maintenance rules

1. The live active registry decides whether a service is eligible. Do not add a page from an external list.
2. Keep public provider URLs stable and sanitized. Never paste a captured registry URL directly into discovery data.
3. Add genuinely useful service copy, not noun-swapped filler. Keep the outcome, steps, credential notes, prompt, and related services specific.
4. Verify any provider API example against official documentation. If a real endpoint is not known, show the Trusty Squire grant/config contract without inventing a provider request.
5. Recheck competitor pages against their official docs and update the “checked” date when product scope changes.
6. Run web tests, typecheck, lint, build, and `pnpm seo:verify-services` before merging.

Organic discovery will still depend on crawling, indexing, backlinks, reputation, and time. This branch supplies the durable crawlable surface and factual entity signals; it does not promise rankings.
