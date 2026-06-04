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

### A0 — Four-walls measurement sweep + GSI/FedCM support [2026-06-03]
Drove groq/northflank/codesandbox/plausible against the residential exit
(patchright + SK-Broadband SOCKS); each "wall" was MEASURED, not guessed.
Shipped commits 555aec8, 2743669, f680ce4, a7071b1, 95a7501 (+ GSI WIP).
See memory `project-four-walls-measured-jun03`. Harnesses:
`/tmp/oauth-probe.mjs` (OAuth network capture), `/tmp/cf-measure.mjs`
(CF clearance + config bisection), `/tmp/hydrate-measure.mjs` (SPA ws probe).

- **groq → GREEN ✅** (validated: ok, api_key, skill promoted). Was Stytch
  B2B async org-provisioning ("Creating your organization" ~5-7s) being
  interrupted by a URL-only settle-wait + the rc.20 re-OAuth retry. Fix:
  `isAuthProcessingText` settle-wait (24s). NOT anti-bot — the OAuth network
  probe is what distinguished an interrupted async step from a rejection.
- **plausible → bot-capable** (captcha WALL BEATEN: hCaptcha via 2Captcha,
  validated; + subject-matcher + code-entry fixes). Only gated by plausible
  INTERMITTENTLY withholding the verification email (service-side anti-abuse).
- **codesandbox → stochastic Cloudflare** risk gate. Measured: a minimal
  browser config clears CF in ~12s but the bot's config sits near CF's
  threshold; no deterministic config fix (stale-cookie theory disproven).
- **northflank → a 3-layer onion, not yet green.** Peeled by measurement:
  1. Google auth is GSI/One-Tap (FedCM, no redirect) — built GSI/FedCM
     support (below) but northflank's Google is *on-demand One-Tap*, not a
     static gsi/button, so it doesn't surface as a clickable affordance.
  2. Provider preference led with Google over the github pin → fixed
     (72192c1: lead with a warm pin). Plus `login` now routes through the
     proxy (a7071b1 — the "github-login-marker-lies" root cause: session was
     made from the datacenter IP, used from residential → killed) + drops
     --enable-automation (95a7501). GitHub session now persists.
  3. Logo-only OAuth buttons — FIXED + VALIDATED (651eed8). northflank's
     GitHub/GitLab/Bitbucket buttons are `<button><svg><title>GitHub</title>`,
     whose title LEAKS into textContent ("GitHubGitHub", doubled — also
     defeats `\bgithub\b`). findOAuthButton now matches a logo button whose
     visible text is nothing-but-the-provider-name + iconLabel names it. The
     bot now finds + drives northflank's GitHub button. (SPA is ws-gated
     ~15s; OAuth scan is hydration-aware, 4cbaf3d.)
  4. **REMAINING BLOCKER (human gate, not a bot gap):** GitHub forces a
     one-time "Verify 2FA now" re-verification on the /authorize flow that
     the bot fast-aborts (needs the operator's authenticator).
     - **Google path is a DEAD END (corrected diagnosis).** northflank has a
       `<button>Google</button>`, but MEASURED (warm session + CDP FedCm
       enabled + real click): NO FedCM dialog, NO popup, NO navigation —
       clicking it does nothing observable, and `google.accounts.id` never
       loads. So the earlier "GSI/One-Tap" read was wrong; the button is
       inert to automation and the bot's old "signed in via Google" was a
       false positive (no-op click → /signup `not_provider` misread). The GSI
       driver has nothing to catch here. (FedCm follow-ups in the GSI block
       remain valid for a *real* gsi/button or One-Tap service, just not
       northflank.)
     - **GitHub path — fully driven now, stops at install-time 2FA (DEFINITIVE).**
       With the login 2FA cleared + warm session, the bot finds the logo
       button, drives OAuth, the session is VALID (snapshot shows
       `"login":"lunchboxfortwo"`), and it reaches northflank's GitHub APP
       install page (/apps/northflank-cloud-build-run/installations/select_target).
       There GitHub demands a FRESH "Verify two-factor authentication" sudo
       prompt for the install — separate from the login 2FA, re-armed per
       sensitive action — which the bot cannot enter. classifyGitHubAuthState
       now reads GitHub-App install pages as consent (9ae5313), but the 2FA
       challenge (correctly) takes precedence.
     So every northflank path is a NON-bot wall: Google=inert button,
     GitHub=install-time sudo-2FA (human), GitLab/Bitbucket=no session,
     email=recaptcha+withheld verification. **northflank = needs-human.** Every
     bot-capability layer (logo detection, pin order, login-proxy, GSI driver,
     hydration scan, App-install classification) is now fixed; only the
     GitHub sudo-2FA gate remains, and it is outside the bot's control. A
     future "pause-for-human-2FA mid-signup (noVNC)" feature could clear it.
  - **Follow-up bug:** logged-in-providers.json got out of sync (github
     session live in cookies but absent from the marker → loggedInProviders()
     returned ["google"], so the pin-respecting order fell back to google).
     Corrected manually this session. loggedInProviders() should be
     cookie-backed (or markProviderLoggedIn made resilient to overwrite) so a
     warm session is never invisible.

  **GSI/FedCM support — SHIPPED (commit 4969584):**
  `BrowserController.hasGoogleGsiAffordance()` + `tryGoogleGsiLogin()` (CDP
  `FedCm.enable` → auto-`selectAccount` on `FedCm.dialogShown`, popup-variant
  fallback); wired into `runOAuthFlow`. CDP FedCm verified in patchright 1.60.
  - TODO for a true static-GSI service: handle the FedCm "ConfirmIdpLogin"
    dialog + the "Continue as" confirm button (`FedCm.clickDialogButton`) if
    `selectAccount` alone doesn't finalize; trigger One-Tap via
    `google.accounts.id.prompt()` for the on-demand variant; unit coverage.

### A0.1 — Full harvest sweep results + the new frontier [2026-06-04]
Re-ran the 75-task curated queue (northflank dropped) on the latest build to
measure the aggregate lift from the session's OAuth fixes. Log:
`~/.trusty-squire/logs/harvest-sweep-20260603-230052.log`.

**Result: 18 ok (24%) · 13 skills promoted · but 58/75 (77%) AUTHENTICATED.**
Only 5 services failed at the auth/login layer — the OAuth fixes (Google
account-chooser, async-session settle, dead-route, logo-button, pin/cookie
sessions) clearly worked. The bottleneck SHIFTED to post-OAuth navigation.
Passes: ipinfo resend sentry neon together baseten convex redis-cloud chroma
mailtrap brevo algolia e2b svix apify firecrawl elevenlabs modal.

**ACTIVE NOW — planner-navigation work (A2 below): 20 services authenticated
but the planner couldn't reach/extract the key.** Three generalizable prompt
themes (corpus-driven, NOT per-service): A) create-the-first-resource
(org/project/cluster) when no key is visible — axiom, kinde, meilisearch,
qdrant, render, workos; B) locate key in-UI + 404-recovery, stop guessing
key URLs — grafana-cloud, typesense, ipdata, last9, circleci, hookdeck,
cockroachdb, betterstack-uptime; C) finish onboarding form-fill — imagekit,
statsig, loops. (Also hatchet, typeform, xata.) Pairs with
[[feedback-generalize-not-per-service]] + [[project-planner-generalization-plan]].
- **VALIDATION round 1 (f3b4909):** re-ran the 21 nav corpus → +5 converted
  (render, qdrant, workos = create-resource theme A; statsig = pre-filled C;
  hookdeck). Themes work + generalize (A helps any create-first-resource
  service). Remaining 16 are progressively bespoke: multi-step onboarding
  wizards (axiom), complex key-creation forms (grafana access-policy), no
  obvious key path (last9), email-verify (typesense/ipdata), github-only
  (circleci), timeouts (kinde). Next round = diminishing returns / more
  per-service shaped — weigh against the SESSION-wall (15) frontier.


**DEFERRED — surface AFTER the planner changes land (separate frontiers):**
- **SESSION-wall (15)** — `oauth_session_not_persisted`: the SERVICE rejected
  the OAuth callback and bounced to login (the northflank anti-bot class, a
  session/fingerprint-layer problem, NOT planner): amplitude, baselime,
  browserbase, clerk, cloudinary, daytona, falai, growthbook, netlify, paddle,
  planetscale (github-only — needs the github session), plunk, replit,
  uploadcare, upstash. This is the next hard frontier after navigation.
- **GATE (7)** — billing/phone/2FA/email-verify, human-gated: anthropic,
  fathom, flagsmith, lambda-labs, sendgrid, temporal, weaviate.
- **CAPTCHA/anti-bot (3)**: codesandbox (stochastic CF), plausible (hCaptcha
  solved + email withheld), tally.
- **NO-key, mis-queued (2)** — no API key exists; DROP from the queue:
  stackblitz (online IDE), zeabur.
- **TRANSIENT (9)** — locator/proxy/timeout, likely pass on retry:
  betterstack-logs, cronitor, deepinfra, honeycomb, launchdarkly, perplexity,
  porter, scrapingbee, supabase. Re-run before treating as real failures.

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

### A5 — `oauth_onboarding_failed` [P1, dominant sub-cause FIXED 2026-06-02; rest open]
With the bot OAuth session refreshed, the 2026-06-02 re-run hit **0
`needs_login`** but `oauth_onboarding_failed` became the #1 failure.
Trail analysis (groq) showed the dominant sub-cause is a
**misclassification + thrash**, not onboarding navigation: the OAuth
callback DIDN'T persist (groq's `/authenticate` still showed a social
login screen), but the bot logged "signed in via Google", then the
vision planner correctly kept asking to log in while the bot stubbornly
overrode it ("already authenticated; skipping") — thrashing all 24
post-verify rounds and ending in a mislabeled `oauth_onboarding_failed`.

**Fixed:** `postVerifyLoop` now counts the planner's login-asks on an
OAuth run; a 2nd ask means the page is genuinely still a login screen, so
it throws `OAuthSessionNotPersistedError` → the call site returns the
correct `oauth_session_not_persisted`. Stops the 24-round LLM thrash and
classifies it right (these are anti-bot OAuth-callback rejections / G4
residential-capture candidates, not repairable onboarding bugs). The
existing `detectManualLoginFallback` gate only caught manual
email+password forms; this catches the social-login-bounce case.

**Still open (the genuinely onboarding-navigation cases):** services where
OAuth DID persist but the bot can't reach the API key (wrong/missing
fallback path, multi-step wizard, project-must-exist-first). Re-triage
the bucket after a re-run with this fix in — the residual
`oauth_onboarding_failed` count after reclassification is the real
navigation-improvement target. Related to F7 (multi-step flows).
Not deployed yet — batch with A4 on the next mcp republish.

### A6 — harvest-promoted skills don't replay clean [dominant cause FIXED 2026-06-02]
The first heal pass replayed the 20 harvest-auto-promoted skills. Honest
triage (it was NOT 20/20): **6 replayed clean** (apify, supabase, falai,
convex, neon×2); **8 were a one-off watcher artifact** — my re-run watcher
checked `systemctl is-active`, but a Type=oneshot service reports
`activating` while running, so it launched the re-run *during* the heal
pass → `verifier_error: profile held by another run` (not a skill issue);
**~6 genuine** brittle-extraction failures.

**Fixed (A6 — the dominant ~4):** posthog/brevo/statsig captured a
uuid-shaped onboarding-page value (e.g. PostHog's project_id) as a second
required credential next to the real copy-button key → replay hard-failed
on a fresh account. `dropSpuriousUuidExtract` drops the uuid_token regex
extract when a copy-button extract co-exists. Go-forward; already-published
broken skills re-synthesize via demote→rediscover.

**Still open (per-service):** render — extraction anchored on "1Password"
(wrong element; the validator correctly rejected it). hookdeck — captured a
state-dependent "Create Project" step only valid on a first-time account.
The closed loop surfaces these without thrashing (single failures don't
demote). Batch the A6 fix with A4/A5 on the next mcp bump (0.8.16).

### A3 — Anti-bot: fingerprint FIXED (patchright); IP is the remaining blocker [P1]
**The CDP-fingerprint half is solved + shipped (commit 2485b38).** The
hardened launcher is now **patchright** — verified ALL-GREEN against the
rebrowser bot-detector through the real `BrowserController` path
(`mainWorldExecution`/`navigatorWebdriver`/`viewport`/`runtimeEnableLeak`
all clean). `Runtime.enable` never leaked; that premise was a ghost (see
the doc banner + [[project-antibot-runtime-enable-ghost]]).

**Full-flow A/B on a datacenter IP (2026-06-03, `BOT_CDP_HARDENED=1`,
4 wall services):** plausible still `captcha_blocked` (reCAPTCHA flagged
the session), tally still `anti_bot_blocked` (Cloudflare risk-score) —
**so the clean browser alone does NOT beat reCAPTCHA-v3/Cloudflare on a
datacenter IP. The IP is now the blocker** (the doc was wrong in the
OTHER direction too: it claimed IP doesn't matter). **codesandbox showed
`"Verification successful"`** in the Cloudflare interstitial — the clean
browser PASSED, but the bot's interstitial-handler didn't detect the
cleared state and timed out → a fixable **bot bug**, not a wall.

**Next, in order:**
1. **The never-run experiment: clean browser + residential IP together.**
   Both halves have only ever been tested separately (and the proxy test
   used a dirty browser). Revive a residential endpoint (Tellskill Mac or
   a cheap residential proxy), set `UNIVERSAL_BOT_PROXY_URL` +
   `BOT_CDP_HARDENED=1`, re-run this A/B. This is the decisive test.
2. ~~Fix the codesandbox-class interstitial bug~~ **DONE (commit e60291a)**
   — `classifyInterstitialText` now recognizes the Cloudflare
   `"Verification successful"` state (separate from the static challenge
   copy) and waits patiently through the stuck redirect instead of timing
   out as `anti_bot_blocked`.
3. Make `BOT_CDP_HARDENED=1` the default once (1) confirms a conversion
   lift (it ships dark today — flag-gated off).
Harness to reuse for any future measurement: `/tmp/cdp-detect`.

### A4 — `findCaptchaWidget` shadow-DOM solve-path parity [DONE 2026-06-02]
Audited: the hypothesis was partly wrong. `findCaptchaWidget` uses
Playwright `page.locator` (NOT the `document.querySelector` that
`detectCaptchaVariant` uses), and Playwright pierces OPEN shadow roots —
so the solve path was already shadow-aware for the common case, plus
Phase 2 anchors on the light-DOM `cf-turnstile-response` input. The real
gap: the solve path checked iframe + response-input but NOT the
`.cf-turnstile` host div directly — the exact extra check the detection
fix added. Closed it: added `.cf-turnstile` + `#clerk-captcha` host-div
fallbacks to Phase 1 (preferred order keeps the iframe first when
present), so detection and solving now agree on the closed-shadow case.
Not deployed yet — batch with A5 on the next mcp republish.

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

## Impossible-class signups — tackle NEXT (G4 / residential IP / manual)
From the 2026-06-03 fan-out re-run; confirmed not bot-code-fixable in the
current egress (datacenter IP). Revisit with a residential proxy (G4) or
manual capture:
- **Captcha walls:** cronitor, plausible
- **Anti-bot gateways:** codesandbox, tally
- **OAuth-loop / anti-bot OAuth-callback rejection:** cockroachdb,
  growthbook, plunk, uploadcare
- **Non-basic OAuth scope (needs operator review):** inngest
These were EXCLUDED from the step-3 fan-out (every other failing service
is being fixed). Tackle this list once a residential egress path exists.

**More walls confirmed by the step-3 subagents (read the actual page
snapshots, 2026-06-03) — also EXCLUDED from the first re-run:**
- **Hard verification gates (need F12 SMS-relay / human):** sendgrid
  (SMS/phone MFA), circleci (authenticator-app TOTP), betterstack-uptime +
  betterstack-logs (magic-link gated behind invisible reCAPTCHA — the
  submit button stays disabled until the captcha token populates; NOT
  billing, despite an earlier mislabel).
- **Credit-card billing gate — ONLY mailgun (verified, 2026-06-03).** Its
  signup form (`signup.mailgun.com/new/signup`) renders "Add payment info
  now" (pre-checked) + "Cardholder Name" + "Billing Address (line 1/2)" +
  City/State/Country/Currency, and `#submit-button` stays **disabled**
  until a valid card (in a Stripe iframe the bot can't fill) is entered.
  Possible future fix: try UNCHECKING "Add payment info now" to defer the
  card — uncertain Mailgun still allows a no-card free signup.

**Re-ADDED to the active set after URL curation (2026-06-03, commits
69b0bdc + caa32bc) — were mislabeled "dead/disabled":**
- 7 stale signup URLs fixed in `tools/housekeeper-services.yaml` (daytona,
  loops, temporal, typesense, workos, baselime, hatchet) + highlight
  (URL was already correct; the "workspaces disabled" snapshot was an
  existing-workspace state on the shared identity, now handled by the
  already-account mint path). Re-test wave: `/tmp/harvest-rerun4-urls.yaml`.

**Inbox infra, NOT bot code (`verification_not_sent`):** the re-run with
the raised 120s probe floor still finds no mail (browserbase waited the
full 120s, none arrived). Root cause is the `@trustysquire.ai` catch-all →
IMAP mailbox delivery, not probe timing. Operator action: verify
`GMAIL_USER`/`WORKSPACE_IMAP_*` on `trusty-squire-api` points at the
mailbox the catch-all actually delivers to (see the inbox-agent diagnosis).

## Remaining-buckets sweep (2026-06-03) — status after the rerun3 triage
The 24 rerun3 failures were triaged into buckets (see
[[project-planner-generalization-plan]] memory). Progress:
- **PLANNER-NAV (6):** Cloudinary prompt de-contamination (proven) + the
  deterministic wizard-loop breaker (live-verified on axiom). Done.
- **INTERSTITIAL (1: lambda-labs + the codesandbox class):** FIXED
  (commit e60291a) — the bot now recognizes a PASSED Cloudflare challenge
  ('Verification successful') instead of bailing on the static copy. Matters
  now that patchright actually passes the challenge.
- **INFRA-inbox (4: fathom/postmark/elevenlabs/browserbase):** FIXED +
  VERIFIED end-to-end (2026-06-03). The workspace IMAP poller was pointed at
  a mailbox that authenticated but didn't receive the trustysquire.ai
  catch-all, AND the app password was stale. Fixed by setting
  `WORKSPACE_IMAP_USER=lunchbox@trustysquire.ai` + a FRESH app password (made
  after enabling IMAP on that Workspace account) on `trusty-squire-api`.
  Verified: a test email to `<rand>@trustysquire.ai` → catch-all →
  lunchbox@trustysquire.ai mailbox → IMAP poll returned `found`. The 4
  verification_not_sent services should now pass. Commit 3a751b0 added a
  `mailbox_domain_mismatch` diagnostic so this class of misconfig surfaces
  in the bot trail instead of a silent "no mail" next time.
- **AUTH-WALL (8: groq/xata/ipdata/stripe/stytch/weaviate/northflank/
  launchdarkly):** OAuth never completed. NEXT: re-test with
  `BOT_CDP_HARDENED=1` (patchright) — the clean fingerprint may now clear
  some of these (the datacenter-IP block from the A/B is the open variable).
  xata is a Keycloak `first-broker-login` account-LINK gate (different — the
  bot may be able to click "link account"); worth a focused look.
- **SSO/2FA (4: last9/qdrant/redis-cloud/grafana-cloud):** qdrant → GitHub
  2FA (wall, needs TOTP); last9 → already-signed-in (already-account mint may
  cover it); redis-cloud/grafana-cloud → SSO. Mostly walls.
