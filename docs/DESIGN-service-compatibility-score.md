# Service Compatibility Score — Design Doc

**Status:** Draft → in implementation
**Scope:** 0.8.x — additive to the Skill Promoter + closed-loop registry work
**Premise:** When an agent calls `provision_any_service` for a SaaS we've repeatedly failed to sign up to, the MCP should advise an alternate service in the same category that's known to work — instead of silently launching the bot and reproducing the same failure.

---

## TL;DR

Today the bot has no memory across runs for the question "does this service work?". The registry tracks SKILLS (succeeded → promoted) and FAILURE records (one row per failure) but no unified per-service health signal. The MCP can't tell agents "Vercel keeps failing, try Render" because nothing computes "keeps failing."

**Design:**
1. New `ProvisionAttempt` table in the registry — one row per universal-bot outcome (success OR failure).
2. Per-service `compat_score` derived as the time-decayed net of successes minus failures.
3. Four-state classification from `compat_score` × `has_active_skill`:
   - `skill-active` — promoted skill exists; signup is fast + solver-free
   - `working` — score > 0, no skill yet
   - `struggling` — score in `[-2, 0]`
   - `hard-block` — score < -2
4. `GET /v1/services/:slug/health` returns the score, state, and category-peer alternates.
5. MCP preflight in `provision_any_service` queries that endpoint. On `hard-block`, the tool response carries a `recommendation` field with category-peer alternates that have working skills. **Recommendation only — not a gate.** Agents that have a hard reason ("we deploy on Vercel") still proceed.

**Key tradeoff:** continuous score handles recovery naturally (Render unblocked when SES landed → score climbed back). A binary blacklist would have stayed dead.

---

## Schema

### `ProvisionAttempt` (new)

```prisma
model ProvisionAttempt {
  id           String   @id @default(cuid())
  service      String                              // canonical slug (registry style: anthropic-api, together-ai)
  status       String                              // "success" | "failed"
  failureKind  String?                             // verification_not_sent | captcha_blocked | oauth_required | …
  signupUrl    String?                             // captured at run time, not from a static yaml
  artifactsUri String?                             // s3://…/<attemptId>/ — populated by sibling task #45
  occurredAt   DateTime @default(now())

  @@index([service, occurredAt(sort: Desc)])
}
```

`UniversalBotFailureRecord` (existing) stays for now — its failure-class telemetry is still consumed elsewhere. A later cleanup can fold its fields into `ProvisionAttempt` or vice versa; not in scope for #44.

### Score derivation (no extra column — computed)

```ts
function compatScore(attempts: ProvisionAttempt[], halfLifeDays = 14): number {
  const now = Date.now();
  const H = halfLifeDays * 86400_000;
  let score = 0;
  for (const a of attempts) {
    const age = now - a.occurredAt.getTime();
    const weight = Math.pow(0.5, age / H);
    score += a.status === "success" ? weight : -weight;
  }
  return score;
}
```

Half-life 14 days, tunable via `COMPAT_HALF_LIFE_DAYS`. Failures from a month ago count ~0.25; failures today count 1.0. Same for successes — a service that worked once a year ago doesn't whitewash three recent failures.

### Classification

| `has_active_skill` | `compat_score` | state |
|---|---|---|
| true | any | `skill-active` |
| false | > 0 | `working` |
| false | -2..0 | `struggling` |
| false | < -2 | `hard-block` |

Thresholds tunable via `COMPAT_HARD_BLOCK_THRESHOLD` (default -2) and `COMPAT_STRUGGLING_THRESHOLD` (default 0).

---

## API surface

### Registry: `GET /v1/services/:slug/health`

```json
{
  "service": "vercel",
  "state": "hard-block",
  "compat_score": -3.2,
  "has_active_skill": false,
  "successful_count": 1,
  "failed_count": 4,
  "last_attempt_at": "2026-05-26T14:33:10Z",
  "thresholds": { "hard_block": -2, "struggling": 0, "half_life_days": 14 },
  "category": "app-hosting",
  "alternates": [
    { "slug": "render", "state": "skill-active", "compat_score": 4.1 },
    { "slug": "railway", "state": "skill-active", "compat_score": 2.3 },
    { "slug": "fly", "state": "working", "compat_score": 1.0 }
  ]
}
```

`alternates` populated only when state is `hard-block`. Sorted by score desc, `skill-active` first.

### Registry: `POST /v1/services/:slug/attempts`

```json
{
  "status": "success" | "failed",
  "failureKind": "verification_not_sent",   // optional
  "signupUrl": "https://vercel.com/signup"  // optional
}
```

Inserts one `ProvisionAttempt` row. Auth: bot's machine token. The bot calls this on every universal-bot completion regardless of outcome.

### MCP: `provision_any_service` preflight

Before launching the bot:

1. Query `/v1/services/<slug>/health`.
2. If state is `hard-block`, fold into the eventual tool response:

```json
{
  "status": "...",   // whatever the bot returns
  "recommendation": {
    "reason": "trusty-squire's signup bot has failed on vercel in 4 of the last 5 attempts",
    "alternates": [
      { "slug": "render", "name": "Render", "has_active_skill": true },
      { "slug": "railway", "name": "Railway", "has_active_skill": true }
    ]
  }
}
```

The bot **still runs** — `recommendation` is informational. Agents can use it or ignore it.

---

## Category map

`apps/mcp/src/data/service-categories.yaml` — flat list of `{ slug, category }` entries. ~80 services across 18 categories. **Slug = registry canonical** (`anthropic-api`, `together-ai`, …); harvester YAML's legacy slugs get aliased in a small adapter.

Lives in the MCP package (shipped with each install) — simpler than a registry-served endpoint, and the map only changes when we add categories. Future revision can move it server-side if hot-updates matter.

---

## Open decisions — pre-committed

1. **Slug canonicalization** → registry style (`anthropic-api`, `together-ai`). Adapter table in `service-categories.yaml` translates harvester slugs.
2. **Category map location** → bundled in `apps/mcp/src/data/`, loaded once at startup.
3. **Half-life** → 14 days, env-tunable.
4. **Recommendation UX** → structured JSON in the tool response only; no console log.
5. **Bot reporting hook** → universal bot's existing completion path adds one POST to `/v1/services/<slug>/attempts`. Auto-promote stays separate (success path) and the failure-record poster also stays — both can be deduplicated later.

---

## Tests

- `apps/mcp/src/data/__tests__/service-categories.test.ts` — lookup by slug, category peers.
- `apps/registry-api/src/routes/__tests__/services-health.test.ts` — `compatScore` math + classification + alternates ordering.
- `apps/mcp/src/tools/__tests__/provision-any-recommendation.test.ts` — preflight surfaces recommendation only when state is `hard-block`.

---

## Out of scope (split into siblings)

- **#45 — Operator-debuggable failure capture artifacts.** S3-uploaded screenshots + trail per failed attempt. Populates `ProvisionAttempt.artifactsUri`. Immediate follow-on.
- **Ad-placement weighting on `alternates`.** Sponsored ordering when commercial peers exist in a category. v2.
- **Folding `UniversalBotFailureRecord` into `ProvisionAttempt`.** Schema cleanup, separate refactor.
- **Hot-reload of `service-categories.yaml` from the registry.** Only matters if the map churns; today it doesn't.

---

## Rollout plan

1. Prisma migration for `ProvisionAttempt` — additive, no breaking changes.
2. New registry routes (`GET /health`, `POST /attempts`).
3. Bot-side hook in universal bot's completion path.
4. MCP-side preflight in `provision_any_service`.
5. Category yaml + loader.
6. Tests at each layer.
7. Live validation: trigger a couple of hard-block scenarios on services we know fail (Cloudflare, MailerSend phone-gate), verify the recommendation appears with valid alternates.
