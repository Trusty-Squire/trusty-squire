# TODOS

Open work only. Completed items live in the git history (see
`git log --grep TODOS` or the file's history for the full archive).

Sections are ordered by priority within each tier; **gated** items
are isolated at the bottom so the actionable list stays scannable.

---

## Tier 1 — ship next (ungated, clear payoff)

### F12 — User-relayed SMS verification [P1, ~half day]
Vercel / MailerSend / Twilio / similar all gate API tokens behind
a phone-number entry + SMS-code wall. Bot can't be SMS
infrastructure (carrier-lookup rejects every VoIP number).

Fix: relay loop with two new MCP tools.
1. Bot detects phone-entry → returns `phone_verification_required` +
   `phone_entry_url` (noVNC if headless) + `run_id`.
2. Host LLM asks user for their phone number.
3. New `provide_phone_number(run_id, phone)` types it into the form
   via the existing bot session.
4. Bot waits for SMS-code field → returns `phone_code_required`.
5. User reads SMS off their real phone.
6. New `provide_sms_code(run_id, code)` types it + clicks verify.

Doesn't touch the security boundary — user's phone is the gate.
Unblocks ~3 services in the queue today; many more in the Phase 5
expansion pool.

### G16 — Dedicated Cloudflare named tunnel for noVNC [P2, ~2 hours]
Replaces the random `*.trycloudflare.com` cold-start. The cloudflared
tunnel URL today is an 80-char random-words subdomain — long, slow
(~5-10s allocation), and unreadable on a phone. A named tunnel
(`cloudflared tunnel run <name>`) bound to `vnc.trustysquire.ai` keeps
the routing pre-allocated on Cloudflare's edge — startup is ~1s,
URL is short and branded, teardown is clean disconnect. Free tier,
no usage cost.

**Supersedes G15** (the original short-URL-shortener proposal —
G16 makes that unnecessary because the named tunnel's hostname is
already short).

Implementation:
- Cloudflare account: provision named tunnel `noVNC`, get tunnel
  token, store on the user's box.
- DNS: bind `vnc.trustysquire.ai` to the tunnel via Cloudflare API.
- google-login.ts: replace `cloudflared tunnel --url <local>` with
  `cloudflared tunnel run <name>`; URL becomes
  `vnc.trustysquire.ai/?password=…`.
- Operator setup is one-time (the tunnel-token belongs in
  `~/.config/trusty-squire/harvester.env`).

Recommendation: shared hostname for all users (simpler ops; the
password fragment keeps each session private). Per-machine tunnels
overkill for our volume.

---

## Tier 2 — known good, no time pressure

### F7 — Multi-step / inline-code flows [P2]
Mistral (email-first multi-step) and DeepSeek (inline verification
code typed into the page) violate the bot's single-page → submit →
email-link assumption. Plan a redesign of the form-step state
machine to accept either shape.

### F8 — Verification-link extraction [P2]
Neon's verification email arrives but has no usable link the bot
can extract — HTML-email button-link parsing.

### F9 — Search fallback [P2]
Validic-class long-tail services hit the brittle `findSignupLink`
search-results fallback. Either codify in a known-services map
(see P1.1 strategic) or teach the fallback to click CTAs.

### Harvester subagent Phase 3 — dry-run [from today's design doc]
Build `tools/harvester-subagent/` per
`docs/DESIGN-harvester-subagent.md`. Claude Code headless +
PreToolUse hook gating Edit/Write/Bash; reads structured
failure-report.json; proposes fixes as markdown diffs to disk
(NOT real PRs). Eval suite (~10 curated fixtures + reference
diffs) grades each prompt iteration. Gated on Phase 1+2 having
run 24/7 for a few days with actual failure data accumulated.

### Harvester subagent Phase 4 — real draft PRs [strategic]
After Phase 3 dry-run hits ≥70% acceptance over 4 weeks: promote
to real draft PRs against staging, cap of 3 open, rejected-fix
memory, auto-resume harvester after fix-rc publishes.

### Harvester subagent Phase 5 — scale + multi-machine [strategic]
services.yaml 15 → 200. Route Cloudflare-protected services to a
Mac-based harvester (real GPU). Central queue coordination via
registry (not FS state).

### services.yaml +10 expansion [~1 hour data curation]
Bring the queue from 15 → 25 with confident Google-OAuth additions:
Cohere, Fireworks, Google AI Studio, Perplexity, Netlify, Loops,
Axiom, Better Stack, Qdrant, Highlight. Worth doing after a few
days of observation at 15 to confirm the existing entries don't
need attention first.

### AB2–AB6 — Anti-bot hardening, items 2–6 [strategic, sequenced]
Full plan: `docs/DESIGN-antibot-hardening.md`. **Slice 1 (telemetry
gap + CDP `Runtime.enable` patch) is locked + implementing** — close
the discover-path `ProvisionEvent` gap and land the flag-gated
`rebrowser-playwright` fix so the bot stops leaking automation on the
CDP control channel. Items 2–6 are the deferred fingerprint/network/
behavior layers; **sequence each after Slice 1's A/B baseline reads
out** so every change is measured against block-rate, not vibes:
- **AB2** — real Chrome channel + real GPU host (off Xvfb/SwiftShader
  WebGL tell).
- **AB3** — network coherence (residential SOCKS passthrough, avoid
  `unknown` ASN, geo/timezone/Accept-Language alignment — a bare proxy
  field-tested as *not* enough).
- **AB4** — warm persistent profile + logged-in Google identity (the
  reCAPTCHA-v3 reputation lever).
- **AB5** — behavior depth: pre-widget scroll/dwell/mouse before the
  signup widget (v3 scores the whole session, not just the form).
- **AB6** — pick battles: classify by challenge hardness, route
  unwinnable max-Turnstile signups (e.g. Cloudflare dashboard) to a
  manual path instead of burning bot runs + LLM calls on a 0% prospect.

---

## Tier 3 — eventually

### T3.4 — Module A v1: reCAPTCHA v2 static-grid solver [large]
Per the rejected-spike design. Heavy LLM cost; the Tier-1 +
proxy combo handles most signups without it.

### G14 — Harden the noVNC password handoff [P3]
`x11vnc -passwd <plaintext>` is readable via `ps`. Pre-existing,
narrow attack surface (`-localhost` only). Fix: write to a 0600
file, use `-passwdfile`.

### M3 — Read verification mail from user's own Gmail [P3]
The bot's chrome profile is logged into the user's Google, so the
profile is also logged into Gmail. For services that withhold
verification mail to fresh-MX domains, drive Gmail in the same
profile to read the link. Supersedes M1's SES revival entirely.

### G2 — API-side identity model (Tier 0 → Tier 1 funnel) [deferred]
What's left of the OAuth-first work API-side: replace anonymous
machine token with OAuth identity, build identified conversion
funnel. Deferred per the original plan as a fast-follow.

---

## Tier 4 — strategic / multi-week (P-roadmap)

Detailed plans live in the older TODOS history; one-liner summary
each.

- **P3 — Agent reads the vault** [keystone] — close the loop:
  agents fetch existing keys instead of re-provisioning.
- **P4 — Vouchflow secures the vault** — harden P3's new read
  surface before traffic. Coupled to P3.
- **P2 — Provision SaaS directly from the vault UI** — web entry
  point + paired-CLI dispatch (decided 2026-05-19).
- **P1 / P1.1 — Skillify signups → adapters + living service-URL
  registry** — captured runs → native adapters + central
  signup-URL map. Already partially shipped via the skill
  registry; the codegen → review → land cycle is the open half.
- **P1.2 — Composio fallback for connect-existing-account** —
  TS's bot is "create new account"; for users who already have a
  service account, route through Composio's OAuth flow instead
  (or Nango / Pipedream / Paragon / our own OAuth-app registrations).
  Composio has 100+ services pre-registered. Vault stores both
  API keys (TS-path) AND OAuth refresh tokens (Composio-path)
  under the same per-service slug; agent doesn't care which. Adds
  parity-or-better coverage immediately for existing accounts.
  Note: requires a second credential model in the vault + per-
  user Composio account UX + decision logic ("does user already
  have an account on this service?"). Surfaced 2026-05-25 from
  the OpenHuman / Composio screenshot review.
- **P5 — Stripe billing for Trusty Squire subscriptions** —
  monetization, independent.
- **P6 — Paid-SaaS via Stripe Issuing + mandate tab** — heaviest,
  longest external lead time (Stripe Issuing approval).

---

## Blocked / waiting

### G4 — Capture pass for the 8 handshake-needed services [BLOCKED]
Needs a residential IP + headed browser to capture post-OAuth
state for the 7 services that get challenge-gated from the
headless datacenter box. Unblocking is operator action: do the
captures from a personal machine, then promote.

### VOUCHFLOW_READ_KEY env on `trusty-squire-api` [GATED]
Wait until the revocation/introspection feature lands (no current
caller). Set with rotated key at that point.

### M2.1 — SES production-access approval [WAITING — AWS auto-review]
Submitted via `put-account-details` 2026-05-20. AWS review
usually completes within 24h. Inbound works fine in sandbox so
this isn't blocking; production unlocks outbound from
`noreply@trustysquire.com`.

### H1 / H2 / H3 — Concurrency [DEFERRED until concurrency is real]
Bot is single-flight. Specific races identified
(`recordPrewarmSuccess` shared-file write, MACHINE_TOKEN_QUOTA +
LLM rate-limit check-then-act). Fix when concurrency becomes a
real product surface, not before.

---

## Notes for the harvester operator

These aren't TODOs — operational reminders.

- **`sudo loginctl enable-linger lunchbox`** keeps the systemd user
  timers running across logout. One-time setup on a new dev box.
- **`TRUSTY_SQUIRE_REGISTRY_URL=https://registry.trustysquire.ai`**
  in `~/.config/trusty-squire/harvester.env` is required for the
  harvester's auto-promote step to actually publish captured skills
  to the registry. Without it: signups succeed but skills don't ship.
- **Per-service ToS audit checklist** before scaling above 50 services
  (mentioned in `docs/DESIGN-harvester-subagent.md` as TODO; revisit
  before Phase 5).
- **Dedicated GitHub App** for the harvester subagent identity
  (vs the user-account PAT). Revisit before Phase 4 (when the
  subagent starts opening real PRs).
