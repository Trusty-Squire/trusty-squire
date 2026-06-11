# DESIGN — Egress Grants (use_credential, but the deployed app can call it too)

**Status:** proposed / roadmap. No code yet.
**One-liner:** let an app the agent *deployed* make authenticated provider
calls through Squire's injecting proxy — using a scoped, revocable token the
agent mints in one step — so the raw provider key still never leaves Squire.

## The problem: the vault secures one axis, not two

Squire's credential primitive today is **agent-initiated and request-scoped**:
`use_credential` is an MCP tool the agent calls; the API injects the real
secret into one outbound HTTPS call to the credential's `allowed_hosts` and
returns only the response. The secret never crosses into the agent. Airtight —
for *"the agent makes a call."*

It does **not** model a **standing workload identity**: a long-running app the
agent provisions and deploys (a voice server, a cron worker, a backend) that
must itself make authenticated calls at runtime, per request, forever. That app
can't call `use_credential` (it isn't the agent and can't auth to Squire), and
the agent can't hand it the key (write-only, by design). Classic secret-zero
wall.

Said precisely: **Squire secures the secret along the *agent* axis. A deployed
app needs it secured along the *workload* axis too.**

## The reframe that makes this honest

We are **not** "keeping the secret off the workload." The app needs *some*
bearer to make calls — that's unavoidable. What we do is **downgrade the
secret**: the app stops holding a god-key (the full provider account: unscoped,
unrevocable without rotating everywhere, unaudited) and instead holds a
**leashed capability** — scoped to one service + host set, rate- and
spend-capped, instantly revocable, audited per call. The real provider key
lives only inside Squire.

The pitch is therefore **not** "magic, no secret anywhere" (false, and invites
a hole-poke). It's "**the thing the app holds is strictly safer than the key it
replaces.**"

## Prior art in this repo — we already shipped ~80% of it

`apps/api/src/routes/llm.ts` (`POST /v1/llm/chat`) is this exact pattern, for
one hard-coded provider:

- auth by **machine token** (`authorizeMachineOrAdmin`),
- **per-token rolling rate limit** (429 on runaway),
- server-side injection of `Authorization: Bearer ${OPENROUTER_API_KEY}`,
- forward to OpenRouter, return the reply — **key never exposed.**

That route deliberately keeps a bespoke wire format and notes (line ~18) it
stays "boring so it can't accidentally become a general-purpose endpoint."
**Egress Grants is the conscious inversion of that stance:** a *general-purpose*
streaming pass-through for any vaulted credential. So this isn't new
machinery — it's `/v1/llm/chat` generalized from (one provider, bespoke shape)
to (any credential, transparent pass-through).

## Design (v1)

### 1. New object: `EgressGrant`

A child of an existing vault credential.

```
EgressGrant {
  id               // "g_<opaque>" — appears in the egress URL
  account_id       // inherits the vault's account scoping
  credential_ref   // the vault credential to inject (its allowed_hosts are inherited)
  token_hash       // hash of the egress token (never stored in clear)
  rate_limit       // calls/hour — mandatory, reuses the LLM tracker
  spend_cap_usd    // optional hard ceiling; null = rate-limit only
  created_at
  revoked_at       // set = instant kill, no key rotation needed
}
```

`allowed_hosts` is **inherited from the credential**, not re-specified — the
grant can never widen the credential's reach, only point at it.

### 2. One MCP tool the agent calls once, at deploy time

```
grant_app_access(service: "ElevenLabs", hosts?: [...])
  → { base_url: "https://egress.trustysquire.ai/g_<id>",
      token:    "sqr_egress_<...>" }
```

Returns a **non-secret-shaped, revocable** token — not the provider key. The
grant id is in the URL (identifies the binding + upstream host); the token
authenticates the caller.

### 3. The egress endpoint (the one real build)

`<base_url>/*` → look up `g_<id>` → grant → credential → **inject the real key
per the service's auth shape** → stream to the upstream host (validated against
the inherited `allowed_hosts`). It is `/v1/llm/chat` with the bespoke shape
removed and streaming added.

**Hard requirement: true streaming pass-through.** The motivating workload is
real-time voice (STT/TTS on the latency budget). The proxy MUST support chunked
+ SSE + multipart (audio upload) + WebSocket upgrade, with **zero buffering.**
This is the principal *engineering* risk of the whole feature — not the design,
the plumbing. A naive buffering proxy makes a voice app stutter.

### 4. Injection-recipe registry (Squire-owned config, NOT user config)

"Send the token in the auth header" only works if every provider used
`Authorization: Bearer`. They don't:

- ElevenLabs → `xi-api-key: <key>`
- Anthropic → `x-api-key: <key>`
- some → `?key=<key>` query param
- most LLM APIs → `Authorization: Bearer <key>`

So the app always does the **same dumb thing** — one standard header,
`Authorization: Bearer <egress_token>` — and Squire **strips it and rewrites to
the provider's real auth shape.** Add an `auth_shape` field on the credential
(default `bearer`; also `header:<name>`, `query:<param>`). Squire maintains a
small recipe table; most providers default cleanly. **This is config the
product owns, never the vibecoder.**

### 5. Scope granularity — `credential + host` for v1

Skip operation-level scoping ("Groq transcriptions but not chat") in v1 — it
needs per-provider route maps. Host-level scoping is **free** (the credential
already has `allowed_hosts`). Operation-level is a v2 once demand is real.

## The integration change — two env vars, stock SDK

At deploy, the agent writes **two env vars instead of the raw key** (see ELI5
below for the before/after):

```
ELEVENLABS_BASE_URL = https://egress.trustysquire.ai/g_<id>
ELEVENLABS_API_KEY  = sqr_egress_<...>
```

Works drop-in with **any SDK that honors a base-URL override** (most LLM/voice
SDKs do). **Caveat to document:** SDKs that hardcode the host can't be
rebased — for those, fall back to `use_credential` (agent-axis) or deploy-time
env injection. The vibecoder configures nothing; they pasted the key once.

## Why it's a product win, not just my-use-case

This turns the vault from a *secret store* into a **credential control plane:**

- **Instant revoke** — kill one app's access without rotating the key or
  touching any other app.
- **Transparent rotation** — rotate the provider key in Squire; every deployed
  app keeps working, zero redeploys. (Nobody does this well; it may be the
  single strongest feature here.)
- **Per-workload audit + spend caps** — every call flows through Squire, so a
  per-call ledger and a hard $ ceiling per grant come for free. *"Charles spent
  $4.10 on ElevenLabs this week, capped at $20"* is a dashboard line vibecoders
  would pay for.

"The agent provisions capability; the secret never leaves Squire" now extends
from *the agent* to *anything the agent deploys* — with zero user config.

## Security posture (mandatory, not optional)

- The egress token is **backend-only by construction.** It must NEVER reach a
  browser/frontend — a leaked token = metered spend until revoked. The tool's
  docstring must say so, so an agent doesn't helpfully drop it in client code.
- **Rate-limit + spend-cap are mandatory-on per grant** — they're what bound a
  leak to an annoyance instead of a bill shock.
- Token is a bearer secret, but a *downgraded* one: scoped, capped, revocable,
  audited. Strictly less dangerous than the raw key it replaces.

## Deferred — explicitly NOT the default

Power tiers, added only when a specific customer's latency or threat model
forces them:

- **Local sidecar** — for latency-critical hot paths; injection on localhost,
  no network hop. Adds an install step → anti-vibecoder by default.
- **Attestation binding** (instance-identity / SPIFFE / TPM) — removes even the
  token from the agent's hands; secret-zero disappears. Premium tier.
- **Ephemeral credential vending** (STS-AssumeRole / OAuth token exchange) —
  lowest blast radius, but only for providers that mint sub-credentials. Flat
  API-key providers (Groq, ElevenLabs) can't, so it doesn't generalize.

## v1 scope cut / milestones

1. `EgressGrant` model + `grant_app_access` MCP tool (mint/return base_url +
   token).
2. Generic streaming egress endpoint (SSE + multipart first; WS second).
3. `auth_shape` field + recipe table for the launch providers
   (bearer / `xi-api-key` / `x-api-key` / query).
4. Mandatory per-grant rate-limit (reuse the LLM usage tracker) + revoke path.
5. Spend cap + per-grant audit ledger (the control-plane payoff).
6. Dashboard: list grants, per-grant spend, one-click revoke.

## Open questions

- **WebSocket providers** (ElevenLabs streaming TTS): WS pass-through with
  header rewrite at upgrade time — confirm the proxy framework supports it
  before promising real-time TTS.
- **Token lifetime:** long-lived (baked into a deployed server) vs refreshed.
  Long-lived + revocable + capped is the vibecoder-friendly default; refresh is
  a power-tier (a refresh daemon = config = the thing we're avoiding).
- **Base-URL-override coverage:** enumerate which launch-provider SDKs honor a
  base-URL override (drop-in) vs hardcode the host (needs fallback).
