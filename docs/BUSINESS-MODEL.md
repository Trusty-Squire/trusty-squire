# Business model + positioning (locked 2026-06-27 via /plan-ceo-review)

The single source of truth for the README, the npm README, and the website.
Supersedes the old provisioning-volume model (free signup quota → 402).

## Positioning

- **Tagline:** *Never touch a signup form or paste an API key again.*
- **Explainer (right under the tagline):** *Your squire does the click-work on
  any service you log into — signs you up, sets things up (OAuth, webhooks,
  projects), vaults the keys, gives your code scoped access, and rotates them.*
- **Defensible wedge (store-vs-act axis):** *Everyone else stores the keys you
  already have. Your squire gets them, sets them up, and rotates them — for the
  price of a password manager, not a platform-engineering seat.*
- **Rejected:** "credential control plane" (engineer jargon; normies don't parse it).

Where we sit: Doppler/Infisical/Vault **store + sync** keys you hand them
($18–21/seat); Composio/Arcade **broker OAuth** for agent tool-calls (dev-infra);
1Password stores **human passwords**. Trusty Squire is the only one that **acts** —
acquires, configures, and rotates by driving the actual service — at consumer pricing.

## The 7 operator use-cases (the laundry list)

1. *"Sign me up for Resend and drop the API key in my vault."* — provisioning.
2. *"Add Google OAuth login to my app."* — multi-console operator task (GCP →
   Playground, sealed secret transfer).
3. *"Give my deployed app a scoped, revocable OpenAI key — cap it at $20/mo."* — egress grant.
4. *"Rotate my Stripe key and update everywhere it's used."* — rotation.
5. *"Show me everything that touched my keys in the last 90 days."* — the ledger.
6. *"Something leaked — kill that key now."* — revoke a grant.
7. *"Stand up the same stack for a new project in 30 seconds."* — skill replay.

## Tiers

Free / Pro now. **Enterprise later** (org control plane: shared vault, seats,
SSO, device attestation, org-scale revoke — built only when it's real).

| | Free | Pro |
|---|---|---|
| Provision (signup automation) | ✅ generous, cost-capped | ✅ |
| Store keys (write-only vault) | ✅ | ✅ |
| Personal use via injecting proxy | ✅ | ✅ |
| Audit trail / ledger | 7-day | **365-day + export** |
| **Egress grants** (scoped, revocable, spend-capped key for a *deployed* app) | — | ✅ |
| **Rotation** (best-attempt, failures reported honestly) | manual | ✅ **automated, 100 attempts/mo** |

**Price: $3.99/mo billed annually · $4.99 month-to-month** (mirrors 1Password
Individual exactly, post-March-2026).

## Pro anchor (how to pitch the $3.99)

Segment-dependent, same bundle:
- **Shipped a real app → egress is the killer.** Scoped, revocable, spend-capped
  key your deployed code uses; the raw secret never leaves the vault. Production
  infra, GA, ~zero marginal cost.
- **Pre-ship → rotation + audit are the hooks.** Rotation is the *emotional*
  differentiator (1Password/Google don't even attempt it) and improves weekly as
  the skill registry grows; audit is the trust/compliance layer.
- **The line:** *scoped keys for your deployed app, a full audit trail, and
  rotation that actually tries — for $4, when Doppler charges $21 to do less.*

## Unit economics (why $3.99 holds)

- Egress (proxy, no LLM) and audit (storage) have **~zero marginal cost** — safe
  to bundle uncapped.
- The only cost driver is **rotation attempts**: a skill-cached rotation is a
  ~$0.0006 replay; only a no-skill *planner* rotation burns real LLM (~$0.01–0.05).
  The **100 attempts/mo cap** bounds the tail; normal users cost cents.
- **The real risk is the free tier** (provisioning burns LLM, no revenue). Defense:
  every free signup grows the skill registry → future provisioning becomes a cheap
  replay → free cost-per-signup *falls* over time, while the same registry powers
  paid rotation. The loss-leader amortizes itself and feeds the paid product.
  Keep the free cost-cap as the backstop.

## Implementation (build-to-launch-Pro)

Readiness: **egress GA, audit GA**; auto-rotation + the entitlement gating are the
remaining build.

1. **Entitlements model** — generalize `subscription-status.ts` from "active lifts
   the signup quota" to `tier → {egress, audit_retention_days, rotation_cap, ...}`.
   One `entitlements.ts`, consulted at each gated route.
2. **Move the 402 from signup-count to the control-plane routes** — `grant_app_access`
   (egress), audit-export, rotation-schedule check the entitlement and reuse the
   existing `402 + cta_billing_url` pattern. Provisioning goes free (cost-cap, not paywall).
3. **Stripe: add `tier` + per-tier Price IDs** — Checkout/Portal/webhook already
   exist; the webhook sets `tier` instead of the `subscription_status` boolean.
4. **Migrate** — existing `active` subs → Pro; signup-quota logic → a free cost-cap.

## Brand vocabulary

The old knight-tier names (Hedge Knight / Tourney Knight / Banner / Lord) and the
`mandate`/spending-policy vocabulary are retired with the mandate-engine sunset.
User-facing tiers are plainly **Free / Pro / Enterprise**.
