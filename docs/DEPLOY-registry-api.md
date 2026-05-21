# Deploying `registry-api` to Fly.io

The registry-api is the Skill Promoter backend — it stores the
Tier-2 Learned Skills the MCP router serves before falling through
to the universal bot.

This doc is the first-time setup runbook plus the deploy-update
checklist. Routine deploys after first-time setup are one command:
`fly deploy` from the app directory.

## Architecture

```
┌─────────────────────┐         ┌──────────────────────────┐
│ trusty-squire MCP   │◀────────│ registry-api             │
│ (router phase)      │  HTTPS  │ trusty-squire-registry   │
└─────────────────────┘         │ (this app)               │
        │                       │                          │
        │ falls open            │  ┌────────────────────┐  │
        │ on any failure        │  │ Postgres (Fly      │  │
        ▼                       │  │ managed)           │  │
┌─────────────────────┐         │  └────────────────────┘  │
│ universal bot       │         └──────────────────────────┘
└─────────────────────┘
```

The registry is **operator-facing**, not user-facing. It can
auto-stop on idle without affecting signups — the router fails
open. A 1-2 second cold start on the first signup of the day is
absorbed by the existing 30-90s end-to-end signup timeline.

## First-time setup

You'll need:

- `fly` CLI authenticated (`fly auth login`)
- A Postgres database (managed Fly Postgres, Neon, Supabase, etc.)
- An Ed25519 signing keypair for skill provenance

### 1. Generate the Ed25519 signing key

The registry signs every skill envelope as it stores it. The
private key is held by registry-api only; the public key gets
distributed to anyone verifying skills.

```bash
# Generate the keypair as base64url PKCS8 / SPKI strings.
node --eval='
  const { generateKeyPairSync } = require("crypto");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const priv = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64url");
  const pub  = publicKey.export({ type: "spki",  format: "der" }).toString("base64url");
  console.log("ADAPTER_SIGNING_PRIVATE_KEY=" + priv);
  console.log("ADAPTER_SIGNING_PUBLIC_KEY=" + pub);
'
```

Save **both** values somewhere safe. The public key isn't a
secret — it's how anyone verifies a skill signature. The private
key is the only thing standing between an attacker and the
ability to publish forged skills.

### 2. Provision Postgres

If you're using Fly's managed Postgres:

```bash
fly postgres create --name trusty-squire-registry-db --region iad
fly postgres attach --app trusty-squire-registry trusty-squire-registry-db
# That attach sets REGISTRY_DATABASE_URL automatically. Verify:
fly secrets list --app trusty-squire-registry
```

If you're using an external Postgres (Neon, Supabase, etc.), set
the URL manually:

```bash
fly secrets set --app trusty-squire-registry \
  REGISTRY_DATABASE_URL='postgresql://user:pass@host:5432/dbname?sslmode=require'
```

### 3. Create the Fly app

```bash
cd apps/registry-api
fly launch --no-deploy --copy-config --name trusty-squire-registry --region iad
```

`--no-deploy` lets us set secrets before the first deploy hits.
`--copy-config` reuses the committed `fly.toml`.

### 4. Inject secrets

```bash
fly secrets set --app trusty-squire-registry \
  ADAPTER_SIGNING_PRIVATE_KEY='<base64url-from-step-1>'

# Optional — wire the demotion webhook if you have an ops dashboard:
fly secrets set --app trusty-squire-registry \
  TRUSTY_SQUIRE_DEMOTION_WEBHOOK_URL='https://ops.example.com/webhooks/skill-demoted'
```

### 5. Deploy

```bash
cd apps/registry-api
fly deploy
```

The `release_command` in fly.toml runs `prisma migrate deploy`
before fly swaps in the new machines. Watch:

```bash
fly logs --app trusty-squire-registry
```

You should see:

1. `Running release_command: ...prisma migrate deploy...`
2. `Applying migration 20260520120000_skill_records`
3. `Applying migration 20260522000000_skill_captures`
4. `Server listening at http://0.0.0.0:8080`

### 6. Verify

```bash
# Health check (should return {"ok":true})
curl https://trusty-squire-registry.fly.dev/health

# List skills (should return {"ok":true,"skills":[]})
curl https://trusty-squire-registry.fly.dev/skills
```

### 7. Wire the MCP

Tell the MCP installs about the new registry:

```bash
# On any machine running the MCP:
export TRUSTY_SQUIRE_REGISTRY_URL=https://trusty-squire-registry.fly.dev
```

For permanent installs, add it to the user's shell rc or the
MCP config the install CLI writes.

### 8. Smoke-test the CLI

```bash
npx @trusty-squire/mcp skill list
# Should print "(no skills)" and exit 0.

npx @trusty-squire/mcp skill list --json
# Should print {"ok":true,"skills":[]} and exit 0.

npx @trusty-squire/mcp skill show 01HZZZNONEXISTENTSKILLID0X
# Should print "error: skill_not_found" and exit 67.
```

## Routine deploys

Once first-time setup is done:

```bash
cd apps/registry-api
fly deploy
```

That's it. The `release_command` handles migrations; the rolling
deploy handles zero-downtime swap.

## Disaster recovery

### Restore from backup

Fly's managed Postgres takes daily snapshots. To restore:

```bash
fly postgres backup list --app trusty-squire-registry-db
fly postgres backup restore <backup-id>
```

### Rotate the signing key

```bash
# 1. Generate a new keypair (see step 1).
# 2. Decide whether to:
#    a) Hard rotate — all existing skills become "unverifiable" until
#       re-signed. Use after a key compromise.
#    b) Soft rotate — verify against both old and new pubkeys until
#       all skills are re-signed. Future enhancement; not implemented.

fly secrets set --app trusty-squire-registry \
  ADAPTER_SIGNING_PRIVATE_KEY='<new-base64url>'

# 3. Force a redeploy so the new key is picked up:
fly deploy --strategy=immediate
```

The fly.toml docstring is the source of truth for env-var contracts;
this doc is the human-readable runbook on top of it.
