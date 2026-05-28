# registry

Adapter manifest registry. Decouples adapter releases from runtime releases; provides kill-switch (`disabled_at`) without redeploying the runtime.

```
publish CLI ──→ Postgres (trusty_squire_registry) ──→ HTTP ──→ runtime's RegistryClient
```

## Local dev

```bash
pnpm --filter @trusty-squire/registry dev
# Listens on :3001 by default. Override with REGISTRY_API_PORT.
```

The dev server uses the in-memory store (anything you publish via the CLI lands in Postgres but the running dev server boots fresh in-memory). Production wires the Prisma store at boot.

Endpoints:
- `GET /adapters/:service/:version` — fetch a signed manifest (200, 404, 410)
- `GET /adapters/:service/versions` — list all versions for a service, semver descending
- `GET /adapters?category=<cat>` — directory of latest non-disabled manifests
- `GET /health` — liveness probe

## Publishing an adapter

```bash
# 1. Generate a signing keypair (one-off; commit the public key, never the private)
node -e "const c=require('crypto');const{privateKey,publicKey}=c.generateKeyPairSync('ed25519');console.log('private:',privateKey.export({format:'der',type:'pkcs8'}).toString('base64url'));console.log('public:',publicKey.export({format:'der',type:'spki'}).toString('base64url'));"

# 2. Set the private key in your env (NEVER in committed env files)
export ADAPTER_SIGNING_PRIVATE_KEY=<base64url-pkcs8>

# 3. Publish
pnpm registry:publish resend
```

The CLI:
1. Loads `packages/adapters/<name>/src/index.ts` (default export must be the `AdapterManifest`).
2. Validates against the Zod schema + structural rules (step-id uniqueness, network capability covers every URL host, `vault_writes` covers every extracted credential, `payment.max_authorize_cents` ≥ most expensive plan, semver).
3. Signs the canonical JSON bytes with Ed25519 and stamps `signed_by`.
4. Inserts into `AdapterManifestRecord`. Re-publishing the same `(service, version)` is a hard error (use a new version).

## Validation rules

| Rule | Reason |
|---|---|
| Zod-schema-valid | Catches shape errors with clear paths |
| Step IDs unique within each flow | Prevents ambiguous `${steps.x.body.id}` interpolation |
| URL host (after stripping `${...}`) in `network.allowed_domains` | Catches manifest mistakes the runtime would reject at execute time anyway |
| `vault_writes` declares every extracted credential type | Adapter convention: `expect.extract` keys named `api_key`/`oauth_token`/etc. must have a matching capability declaration |
| `payment.max_authorize_cents ≥ max plan price` | The adapter can't sign up the user for a plan that exceeds its declared payment cap |
| Version is valid semver | The runtime requests pin a version; "latest" is not supported |
| `default_plan` exists in `plans` | Sanity |

## Caching

- Server-side: per-worker in-memory map, 1h TTL. Disabled records cache too (the kill-switch isn't expected to flip more than once an hour).
- Response: `Cache-Control: public, max-age=3600, immutable` on successful manifest fetches. Manifests are immutable per `(service, version)`; disabling flips the response status code (200 → 410) which cache layers respect.

## Kill-switch

To disable a published version:

```sql
UPDATE "AdapterManifestRecord"
SET disabled_at = now(), disabled_reason = 'CVE-XYZ'
WHERE service = 'resend' AND version = '0.1.0';
```

Subsequent fetches return `410 Gone` with `disabled_reason`. In-memory caches will surface the change after the 1h TTL — pair with a deploy if urgency is needed.

## What this service does NOT do

- **Verify the runtime's signature** when serving — the runtime's `RegistryClient` has a `// TODO` for verification (deferred per chunk-9 spec).
- **Adapter migrations** — schema field exists; logic later.
- **Community submission** — manual publish only.
- **Health checks / telemetry beyond `/health`**.
