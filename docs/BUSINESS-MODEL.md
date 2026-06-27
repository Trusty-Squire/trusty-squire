# Business model + positioning (locked 2026-06-27 via /plan-ceo-review)

The single source of truth for the README, the npm README, and the website.
Supersedes the old provisioning-volume model (free signup quota → 402).

## Who it's for (this sets the price)

**Developers using frontline AI coding agents who want to move at higher velocity
without worrying about leaked secrets.** This is the load-bearing decision: the
buyer is a *professional shipping software*, not a consumer protecting logins. So
the pricing comp is **developer tools** (Cursor $20, Copilot $10–39, Doppler
$21/seat, Infisical $18/identity) — **NOT 1Password** ($4, consumer). Pricing at
consumer levels would under-capture the value (a leaked key is a breach; a dev-hour
dwarfs the fee) and signal consumer-tier seriousness.

## Positioning

- **Tagline (hook):** *Never touch a signup form or paste an API key again.*
- **Value prop (the dev buyer):** *Move at the speed of your AI agent without
  worrying about leaked secrets.*
- **Explainer:** *Your squire does the click-work on any service you log into —
  signs you up, sets things up (OAuth, webhooks, projects), vaults the keys, gives
  your code scoped access, and rotates them.*
- **Defensible wedge (store-vs-act axis):** *Everyone else stores the keys you
  already have. Your squire gets them, sets them up, and rotates them.*
- **Rejected:** "credential control plane" (jargon).

### The three headline value props (feature these everywhere)

1. **Your agent handles signups & SaaS provisioning** — ask for a service, it
   creates the account and brings back the API key.
2. **No secret ever leaves the vault** — no more keys scattered across `.env`
   files and cloud secret stores; code uses them through an injecting proxy that
   never hands the raw value back, so there's nothing to leak.
3. **Operate anything behind a login** — complete complex tasks hidden behind
   auth walls with one prompt: wire up OAuth across consoles, configure webhooks,
   stand up projects. The secret never crosses into chat. (Rotation lives in the
   Pro tier below — a paid feature, not a headline pillar.)

Where we sit: Doppler/Infisical/Vault **store + sync** keys you hand them
($18–21/seat); Composio/Arcade **broker OAuth** for agent tool-calls; 1Password
stores **human passwords**. Trusty Squire is the only one that **acts** — acquires,
configures, and rotates by driving the actual service.

## The 7 operator use-cases

1. *"Sign me up for Resend and drop the API key in my vault."* — provisioning.
2. *"Add Google OAuth login to my app."* — multi-console operator task.
3. *"Give my deployed app a scoped, revocable OpenAI key — cap it at $20/mo."* — egress grant.
4. *"Rotate my Stripe key and update everywhere it's used."* — rotation.
5. *"Show me everything that touched my keys in the last 90 days."* — the ledger.
6. *"Something leaked — kill that key now."* — revoke a grant.
7. *"Stand up the same stack for a new project in 30 seconds."* — skill replay.

## Tiers

**Free / Pro.** Two self-serve plans — the only prices a user sees are $0 and $20.

| | Free | Pro |
|---|---|---|
| Provision (signup automation) | ✅ generous, cost-capped | ✅ |
| Operate (multi-step tasks behind a login) | ✅ | ✅ |
| Store keys (write-only vault) | ✅ | ✅ |
| Personal use via injecting proxy | ✅ | ✅ |
| Audit trail / ledger | 7-day | **365-day + export** |
| **Egress grants** (scoped, revocable, spend-capped key for a deployed app) | — | ✅ **generous fair-use** |
| **Rotation** (auto on covered services, growing; honest on the rest) | manual | ✅ **automated** |

**Price: $20/mo** (Cursor-band; the AI-coding-velocity buyer's reference price).

Production-scale egress beyond Pro's fair-use is handled as a direct, custom
conversation — usage-priced case-by-case, never self-serve metering, and not a
published tier today.

## Pro anchor (how to pitch $20)

*Move fast without leaking secrets — for the price of your AI editor.*
- **Shipped a real app → egress.** Scoped, revocable, spend-capped key your deployed
  code uses; the raw secret never leaves the vault.
- **Rotation is the emotional differentiator** — 1Password/Google don't even attempt
  it; we auto-rotate covered services (growing weekly) and are honest about the rest.
- **Audit** is the trust/compliance layer.
- **The line:** *$20 to acquire, secure, and rotate your keys — when Doppler charges
  $21/seat to only store them.*

## Unit economics (why $20 holds, and the invariant behind it)

The buyer-correct price gives the margin headroom the $4 anchor never could. Two
variable costs, each contained so they never run unbounded on the flat tier:

- **Rotation = frontier-model tokens.** A rotation on an *uncovered* service is a
  full frontier vision-planner run (10–20 steps, screenshot+DOM each) ≈ $0.20–$1+,
  and failures still cost. Contained by **central amortization**: build a rotation
  *skill* for a service ONCE (frontier, central, demand-prioritized), then every
  user's rotation is a **cheap replay** (~$0.01–0.10). Uncovered service → honest
  "manual steps, on the list" — we do NOT fire the frontier planner per-user on the
  flat tier. Per-user rotation cost stays bounded; $20 covers it with margin.
- **Egress = bandwidth + compute in the production hot path** (every request the
  deployed app makes routes through our proxy). Scales with traffic, unbounded.
  Contained by a **generous fair-use allotment** in Pro (sized so $20 covers cost
  at the cap; alert + grace + "talk to us", never hard-break prod) and routing
  **production-scale to a direct custom conversation** (usage-priced case-by-case,
  never self-serve metering).

**The invariant:** *a flat price bundles only BOUNDED per-user cost.* Every variable
cost is handled by fair-use (egress), central amortization (rotation skills), or a
custom conversation for production-scale — **never billed flat-and-unbounded, never
metered-and-scary.** No self-serve metering anywhere; the only prices a self-serve
user sees are $0 and $20.

**Free-tier defense:** free provisioning burns LLM with no revenue, but every signup
grows the skill registry → future provisioning becomes a cheap replay → free
cost-per-signup *falls* over time, while the same registry powers paid rotation. The
loss-leader amortizes itself and feeds the paid product. Free stays cost-capped as a
backstop.

## Implementation (build-to-launch-Pro)

Readiness: **egress GA, audit GA**; auto-rotation, egress fair-use metering (internal
counter, not user-facing), and the entitlement gating are the remaining build.

1. **Entitlements model** — generalize `subscription-status.ts` from "active lifts
   the signup quota" to `tier → {egress_fairuse, audit_retention_days, rotation, ...}`.
2. **Move the 402 from signup-count to the control-plane routes** — `grant_app_access`
   (egress beyond fair-use → upgrade prompt), audit-export, rotation check the
   entitlement. Provisioning goes free (cost-cap, not paywall).
3. **Stripe: add `tier` + the $20 Price ID** — Checkout/Portal/webhook already exist.
4. **Internal egress usage counter** — per-grant request/GB count to enforce fair-use
   + flag scale candidates for a custom conversation. NOT surfaced as a user meter.
5. **Migrate** — existing `active` subs → Pro; signup-quota logic → a free cost-cap.

## Brand vocabulary

The old knight-tier names (Hedge Knight / Tourney Knight / Banner / Lord) and the
`mandate`/spending-policy vocabulary are retired with the mandate-engine sunset.
User-facing tiers are plainly **Free / Pro**.
