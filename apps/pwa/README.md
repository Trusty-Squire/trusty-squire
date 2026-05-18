# @trusty-squire/pwa

User-facing PWA for Trusty Squire. Account signup, mandate signing,
MCP install, dashboard, ledger, policy editor.

## Stack

- **Next.js 15** App Router, Server Components where the work is static.
- **Tailwind v4** with dark-first theme tokens (`--color-bg`, `-surface`,
  `-text`, `-accent`, …). One `@theme` block in `globals.css` is the
  single source of truth — see `DESIGN.md`.
- **Vouchflow Web SDK** (`@vouchflow/web@0.2.1`) for all WebAuthn
  ceremonies — login, account register, mandate signing, pairing.
- **Vitest + Testing Library** for component tests, **Playwright** for
  end-to-end flows.

## Running

```bash
pnpm dev          # http://localhost:3002
pnpm test         # component tests
pnpm test:e2e     # Playwright (auto-starts dev server in stub mode)
pnpm typecheck
```

## Environment

| Variable | Effect |
| --- | --- |
| `NEXT_PUBLIC_API_BASE` | Base URL of `apps/api`. Default `http://localhost:3000`. |
| `NEXT_PUBLIC_VOUCHFLOW_API_KEY` | Vouchflow API key (sandbox or live). |
| `NEXT_PUBLIC_VOUCHFLOW_ENV` | `sandbox` (default) or `production`. |
| `NEXT_PUBLIC_VOUCHFLOW_MODE` | `live` (default) or `stub`. Stub mode short-circuits Vouchflow with deterministic fake bundles — used by Playwright. |

## Test-mode mock API

`src/app/api/test-mock/v1/[...path]` returns canned responses for
`/v1/accounts`, `/v1/mandates`, `/v1/subscriptions`, `/v1/usage`,
`/v1/ledger`, `/v1/mcp/pair/:token/(status|claim)`. Only used by
Playwright (config sets `NEXT_PUBLIC_API_BASE` to the mock prefix).

## Routes

- `/` — landing
- `/signup`, `/signup/passkey`, `/signup/policy`, `/signup/sign`, `/signup/connect` — five-step onboarding
- `/login` — passkey sign-in
- `/pair?token=<one-time>` — MCP install confirmation
- `/dashboard`, `/ledger`, `/subscriptions`, `/policy`, `/settings` — authenticated app shell

## Production polish (chunk 13)

- **Icons:** real PNGs (192, 512, 512-maskable, 180 apple-touch) rasterized from `logo.svg` via `scripts/rasterize-icons.ts` (`pnpm rasterize-icons`). Committed under `public/icons/`.
- **Service worker:** hand-rolled `public/sw.js`. Precaches shell + brand assets; stale-while-revalidate for static assets; never caches `/v1/*` or `/auth/*`. Version bump in `SHELL_VERSION`/`RUNTIME_VERSION` purges old caches on activate.
- **SW registration:** `src/lib/sw-register.ts` registers in production only (localhost is skipped). New-version events trigger `SKIP_WAITING` so users get the update on next navigation.
- **Fonts:** Inter self-hosted via `next/font/google` (downloaded at build time, served from `/_next/static/media/`). One family, body and headings. Zero runtime CDN.
- **Bundle:** Vouchflow Web SDK lives in route-split chunk `960-*.js` (~24 kB minified, ~6 kB gzip). Loaded only on `/signup/*`, `/login`, `/pair`, `/policy`. Dashboard, ledger, subscriptions, settings never pull it.

### Lighthouse (local audit against `pnpm build && pnpm start`)

| Route | Performance | Accessibility | Best Practices | SEO |
| --- | --- | --- | --- | --- |
| `/` | 100 | 100 | 100 | 100 |
| `/signup` | 100 | 100 | 100 | 100 |
| `/dashboard` | 99 | 100 | 96 | 100 |
| `/policy` | 99 | 100 | 96 | 100 |

The 4-point Best Practices delta on `/dashboard` and `/policy` is from `errors-in-console` — the api-client logs `net::ERR_CONNECTION_REFUSED` when audited without `apps/api` running. Production with the API alongside has zero console errors.
