# TODOS

Open work only. Completed items live in the git history (see
`git log --grep TODOS` or the file's history for the full archive).

Sections are ordered by priority within each tier; **gated** items
are isolated at the bottom so the actionable list stays scannable.

---

## Tier 0 — active now (this session, 2026-06-02)

The closed-loop hardening + telemetry-fix session shipped rc.1→rc.5
(npm `next` = `0.8.14-rc.5`) and merged PRs #108–#115. Slice 1 of the
anti-bot plan is **done**, not pending (see AB note below). What's
live and what's immediately next:

### A1 — Housekeeper harvest RUNNING [in-flight]
Launched 2026-06-02 over **75 services** from the queue that have no
active skill and aren't wall-blocked (excludes the 3 hard walls:
openai, clerk, mixpanel; excludes skip-status + already-skilled).
Free LLM tier (`UNIVERSAL_BOT_LLM_TIER=free`), auto-promote default-on
— every bot success synthesizes + signs + publishes a skill.
- Detached run: `nohup bash /tmp/harvest-run.sh` → `~/harvest-discover.log`.
- Monitor: `tail -f ~/harvest-discover.log`. Stop: `pkill -f 'bin.js housekeeper'`.
- ~10h batch (≈75 real signups). Outcomes post to the registry as
  ProvisionEvents (the 120-char `failure_kind` truncation fix means
  they now actually land — previously 400'd).
- **Next:** once it drains, read the ProvisionEvent outcomes and
  triage the failure-kind histogram → feeds A2 + the harvester-subagent
  failure corpus.

### A2 — Closed-loop skill remediation [SHIPPED 2026-06-02]
**Done end-to-end (T1–T10). PR #116 merged to main; registry deployed
(v18, both migrations applied); mcp 0.8.14 + skill-schema 0.1.1 on npm
`latest`; systemd timer installed + enabled.** Design:
`docs/DESIGN-closed-loop-remediation.md`. T4 classifier (demote only on
rot), T5 demotion→rediscovery, T6 `/admin/needs-human` + T8 CLI, T7
`--mode=heal` + digest, T9 timer, T10 heartbeat + admin status panel.

**Two small loose ends:**
- The heal timer is enabled but **not yet `start`ed** — held to avoid a
  Chrome-profile collision with the A1 harvest. Once the harvest
  finishes: `systemctl --user start trusty-squire-heal.timer` (or it
  auto-starts on next boot).
- CI registry auto-deploy was flaky on the Fly release_command timeout;
  fixed with `--wait-timeout 600` in `release-registry.yml` (the manual
  deploy already shipped v18). `FLY_API_TOKEN` is fine (red herring).

**Deferred sub-items (design NOT-in-scope), now the natural fast-follows:**
prod-path (non-verifier) demotion classifier on `consecutive_failures`
(same treatment as T4); bounded-N rediscovery counter (walls already
quarantine; non-wall re-loops only surface in the digest/worklist today);
event-driven demotion-webhook listener; mutable "mark resolved" worklist.

### A5 — `oauth_onboarding_failed`: the new #1 bot failure [P1, fresh from the harvest]
With the bot OAuth session refreshed, the 2026-06-02 re-run hit **0
`needs_login`** — but `oauth_onboarding_failed` became the dominant
failure (~9 of the first 40): the bot signs in via Google fine and the
account is created, but it can't navigate the **post-signup onboarding**
to reach/extract the API key. These are near-misses (accounts exist), so
the payoff is high. Audit the post-OAuth onboarding loop in the bot
(`agent.ts` onboarding navigation + extraction) against a few of the
failing services (groq, etc.); likely needs better "where's the API key"
navigation/heuristics or a per-service onboarding hint. Related to F7
(multi-step flows).

### A3 — Anti-bot A/B: source a service that actually triggers a wall [P1, blocked on sourcing]
The A/B harness is **code-complete** (baseline vs `cdp_hardened`
stealth profile, `stealth_profile` column on CaptchaEvent, invisible-
Turnstile recording, shadow-DOM widget detection). It is blocked on
*input*: no queue service currently presents a detectable invisible
Turnstile / reCAPTCHA-v3 *on a form path* the bot reaches. Resend
dropped its Turnstile; the rest OAuth past it. Need to find/confirm a
service that renders a scoreable challenge on the form, then run the
A/B for a concrete block-rate delta. Until then AB2–AB6 stay deferred
(they sequence after this baseline reads out).

### A4 — `findCaptchaWidget` shadow-DOM solve-path parity [P2, ~1 hour]
`detectCaptchaVariant` was fixed this session to see modern shadow-DOM
Turnstile (iframe-in-shadow-root). The *solve* path (`findCaptchaWidget`
click-and-wait position lookup) likely still uses the same pre-shadow
querySelector and would fail to locate the checkbox on a visible
shadow-DOM Turnstile. Audit + apply the same iframe-URL/shadow-pierce
detection so detection and solving agree.

> Vouchflow P4 (device-attestation gating the vault) is **explicitly
> skipped for now** per operator call 2026-06-02 — it's wired but
> enforces nothing (see Tier 4 P4 + the `vouchflow-wired-but-not-
> enforcing` memory). Not in this session's scope.

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

### services.yaml curation pass [~1 hour data curation]
The queue is now ~101 services (`tools/housekeeper-services.yaml`).
The active harvest (Tier 0 A1) covers the 75 with no active skill and
no wall. Curation work that remains: prune entries that prove
permanently wall-blocked from the headless box (route to G4's
residential-capture path instead), and confirm `oauth_provider` /
`signup_url` accuracy for the long tail as failure data accumulates.

### AB2–AB6 — Anti-bot hardening, items 2–6 [strategic, sequenced]
Full plan: `docs/DESIGN-antibot-hardening.md`. **Slice 1 SHIPPED
(rc.1–rc.5, PRs #108/#110/#112):** discover-path `ProvisionEvent` gap
closed (+ the 120-char `failure_kind` truncation fix that was the real
"only ~2 rows ever" cause), the flag-gated `rebrowser-playwright` CDP
`Runtime.enable` patch landed in `addBinding` mode (full
`alwaysIsolated` isolation proved non-viable — it crashes the bot's
own locator/title utility-context ops; documented in the design doc),
plus invisible-Turnstile recording + shadow-DOM widget detection. The
A/B that measures Slice 1's block-rate delta is **blocked on service
sourcing** — see Tier 0 A3. Items 2–6 are the deferred fingerprint/
network/behavior layers; **sequence each after the A/B baseline reads
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
