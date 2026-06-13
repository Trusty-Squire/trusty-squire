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

## Local proxy front-door for CLI loop runtimes (Castellan / `ser`) — v0.3 candidate

A neighboring project (Castellan's `ser`, a standing-loop CLI runtime) surfaced a
use case the cloud egress endpoint above serves awkwardly: a **loop runtime
running on the same machine as the Squire MCP** that needs to make LLM calls every
iteration without ever holding the provider key. `ser` already honors
`OPENROUTER_BASE_URL`, so the integration is `squire proxy openrouter →
http://127.0.0.1:PORT/v1`: point the runtime at a localhost shim, and it never sees
a credential.

**This directly answers the "vending is brittle" objection.** We previously balked
at vending/rotating provider keys to a consumer because rotation is fragile. The
proxy sidesteps it entirely: the runtime holds **no credential**, so there is
nothing to vend or rotate at the consumer. The key stays in Squire; the runtime
holds at most a downgraded, revocable `EgressGrant` token.

**The reframe that promotes the deferred sidecar.** The "Deferred" section below
parks the local sidecar as anti-vibecoder because it "adds an install step." That
objection **evaporates for a CLI runtime**: the Squire MCP is already installed on
that machine, so `squire proxy` is zero marginal install. The thing we deferred is
the *natural* fit for this consumer class.

### The one architecture decision (with the honest tradeoff)

"Injected at the boundary" has two non-equivalent realizations:

- **A. Local shim, SERVER-SIDE injection** — `ser → localhost shim → Squire API →
  provider`. The shim is a dumb forwarder that attaches the `EgressGrant` token;
  the real key is injected at the API (exactly `/v1/llm/chat` today). Key never
  materializes locally (invariant held). Cost: one extra hop
  (localhost→Fly→provider) and the loop's hot path now depends on Squire API
  uptime — if Fly is down, the loop's LLM calls fail, and there is **no clean
  fallback** (a fallback would have to hold the key). For an LLM loop the hop is
  negligible against token-generation latency; the availability coupling is the
  real cost and must be accepted on purpose.
- **B. Local sidecar, LOCAL injection** — the proxy holds the decrypted key in RAM
  (fetched once at start) and injects on localhost; provider call goes direct, zero
  added hop. This **materializes the key locally** — a real downgrade of the
  write-only-vault model. Justified only by latency-critical paths (voice). Stays
  the deferred power tier.

**Decision: A for v0.3.** LLM loops are not latency-critical at the network layer,
and keeping the key server-side is the whole point. B remains deferred for voice.

### v0.3 milestones (this front-door specifically)

1. **Streaming egress route** — generalize `/v1/llm/chat` into a transparent,
   **zero-buffer** SSE/chunked pass-through (`/v1/egress/*`): machine-token *or*
   `EgressGrant`-token auth, server-side injection per `auth_shape`, allowed-hosts
   enforced, reusing the rate-limit tracker + `LLMUsageEvent` metering. The
   non-buffering stream is the principal engineering risk (note: `HttpProxyExecutor`
   today buffers with a 10KB cap + JSON/text-only allowlist — it is NOT reusable for
   streaming; this path is a new build). For a fixed provider (OpenRouter) the
   upstream host is hard-coded, so the SSRF surface is trivial vs the general case.
2. **`squire proxy <service>` CLI subcommand** — loopback-only (127.0.0.1, never
   0.0.0.0) HTTP server speaking the provider's native wire format, forwarding to
   (1) with a minted `EgressGrant` token (not the machine token — so the runtime's
   blast radius is one revocable, capped grant). Prints
   `export OPENROUTER_BASE_URL=http://127.0.0.1:PORT/v1`.
3. **Per-loop metering** — runtime (or proxy) sets `X-Squire-Loop-Id`; API tags each
   `LLMUsageEvent`; dashboard groups spend by loop and enforces `spend_cap_usd`
   (429 on breach). This is the control-substrate payoff.
4. **Generalize past OpenRouter** — wire the `EgressGrant` + `auth_shape` recipe
   table (ElevenLabs / Anthropic / query-param providers) so the local front-door
   rejoins the full design above.

**Sequencing:** v0.3 candidate, alongside the standing-loop runtime, AFTER the
current closed-loop stabilization. Not built now.

### Eng-review findings (2026-06-12) — resolve before build

Two **blocking** holes and several strong-recommends, from a `/plan-eng-review`
pass on this section:

- **[BLOCKING] The loopback shim endpoint is unauthenticated.** "ser holds no
  credential + the shim holds the token" makes `http://127.0.0.1:PORT/v1` a local
  spend endpoint any process on the box can hit (loopback ≠ private on a multi-user
  host). Fix: **ser holds the `EgressGrant` token** (the *downgraded, capped,
  revocable* token — NOT the provider key; that's the real "holds no credential"
  claim) and presents it to the shim; or bind a **unix domain socket with 0600
  perms** instead of TCP loopback. Relax the "ser holds literally nothing" wording
  accordingly.
- **[BLOCKING] Cap semantics: per-grant vs per-loop.** `X-Squire-Loop-Id` is a
  client header — forgeable. It works for **attribution** (per-grant cap, header is
  a dashboard tag) but NOT for **enforcement** (per-loop cap — a loop rotates its id
  to evade). If the cap is per-loop, mint **one `EgressGrant` per loop** (id + cap
  server-side) and drop the header. Recommendation: start **per-grant**.
- **[STRONG] Streaming defeats the response-size cap + inverts timeouts.**
  `HttpProxyExecutor`'s `maxResponseBytes` pre/mid-stream check and 5s body timeout
  do not survive a pass-through. Add a **byte-ceiling that kills the stream at N MB**
  + an **idle-timeout** (no bytes for ~30s), replacing the total-body timeout. Cost
  metering also becomes a **streaming parse** — `usage` arrives only in the final
  SSE chunk (needs `stream_options.include_usage`), so "metering for free" isn't
  free on the streaming path.
- **[STRONG] Error wire-format translation is load-bearing for "drop-in."** When the
  cap/rate-limit trips, the shim must emit **OpenAI/OpenRouter-compatible error
  JSON**, not a raw Squire 402/429 — otherwise the SDK's error handling breaks
  mid-loop.
- **[NAME IT] Arch A means Squire (Fly) sees every prompt + completion in
  plaintext.** Sold as metering; it's also full-traffic visibility. Desirable for the
  enterprise audit story, but state it as a trust property, not a free win.
- **[NAME IT] Availability + volume coupling.** A standing loop is *unbounded*
  volume, unlike `/v1/llm/chat`'s bounded ≤15-calls/signup precedent. Every token
  traverses Fly → real bandwidth bill + a new scaling axis (N concurrent multi-minute
  streams vs. the 4-in-flight buffered-call cap). Cost it before this is a product
  feature vs. operator-only.
- **[MISSING] Model allowlist.** An unbounded loop on the operator's OpenRouter key
  can pick expensive models. Scope allowed models on the grant, or rely solely on
  `spend_cap_usd` — decide which.

**Revised milestone order (M1 was prematurely generic):** (1) **OpenRouter-only**
streaming passthrough — fixed host = no SSRF, no `auth_shape` registry; reuse
`/v1/llm/chat`'s injection — **with metering folded in**; (2) `squire proxy` CLI
shim (shim-auth resolved per the blocking item); (3) **generalize** — build the
generic `/v1/egress/*` + `EgressGrant` + `auth_shape` + SSRF pin/allowlist once a
second provider justifies the heavy machinery.

## Open questions

- **WebSocket providers** (ElevenLabs streaming TTS): WS pass-through with
  header rewrite at upgrade time — confirm the proxy framework supports it
  before promising real-time TTS.
- **Token lifetime:** long-lived (baked into a deployed server) vs refreshed.
  Long-lived + revocable + capped is the vibecoder-friendly default; refresh is
  a power-tier (a refresh daemon = config = the thing we're avoiding).
- **Base-URL-override coverage:** enumerate which launch-provider SDKs honor a
  base-URL override (drop-in) vs hardcode the host (needs fallback).
