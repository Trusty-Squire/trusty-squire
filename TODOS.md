# TODOS

Open work only. Completed items live in the git history (see
`git log --grep TODOS` or the file's history for the full archive).

Sections are ordered by priority within each tier; **gated** items
are isolated at the bottom so the actionable list stays scannable.

---

## Where we are (2026-06-07, `@trusty-squire/mcp@0.9.3`)

**0.9.1 → 0.9.3 shipped to `latest`** since the 0.9.0 note below: housekeeper
inter-run pacing (cooldown + adaptive backoff + per-IP daily cap, after a live
run burned a residential exit); AB6 routing known-unwinnable services to manual;
vault capture-seeded `allowed_hosts` + `use_credential` query-param auth; the
`nav_timeout` classifier; **verify drives the OAuth consent handshake
deterministically** instead of bailing to `needs_login`; and **the verify
false-rot fix** — replay against an already-registered operator account no
longer demotes a healthy signup-with-onboarding skill (returning-user
divergence → transient `account_already_registered`). Registry-side: by-id
returns live status, and promotion now collapses stale demoted/pending rows so
the skill list stays clean (the duplicate clutter is gone). This consolidates
the former `todos.md` (a stale 2026-05-30 triage snapshot, now deleted — its
items are either shipped, in git history, or carried below).

**0.9.0 shipped to `latest`** — the post-OAuth navigation work: a deterministic
planner (temp 0), the **create-over-extract N1 wall broken** (live-validated:
netlify + baseten reach a key, baseten was the eval's sealed holdout), the
offline eval harness, `failure_stage`, and layered R3 redaction. Plus G14 (VNC
passwdfile) and AB6 (route known-unwinnable services to manual before the run).



**The anti-bot frontier is settled: we are NOT detected.** Measured this
session with the real `BrowserController` (patchright hardened + SK-Broadband
residential SOCKS): the session scores **reCAPTCHA v3 = 1.0**. The long-open
"clean browser + residential IP together" experiment (old A3 item 1) has now
been run, and the answer kills the "IP is the blocker" theory — every "wall"
decomposed into our own handling bugs or a service-specific quirk, the large
majority now fixed in 0.8.17:

- invisible-reCAPTCHA handling (don't "solve" it — mint its token via the
  enumerated widget id), Tier-3 2Captcha for visible v2
- self-healing signup-URL resolver (HTTP probe + landing-page CTA, anchored on
  the hint's registered domain) — stale `signup_url`s now self-heal
- post-OAuth recovery: in-page signup-CTA, Google account-chooser in the
  post-verify loop, adaptive hydration patience on OAuth-callback routes,
  GSI/FedCM One-Tap (incl. `ConfirmIdpLogin` + `prompt()`)
- consent-from-DOM (the `part=` URL that hides scopes), required-TOS checkbox,
  multi-step signup continuation, **demo/sandbox-escape**
- email verification: **anchor-text link picking** (beats SendGrid/Mailgun
  click-tracker wrappers) + **verify-wall routing** into the inbox-poll flow
- WebGL renderer spoof to a stock Intel GPU under patchright (page.evaluate
  re-apply; `toString` masked)
- **Email deliverability is PROVEN end-to-end** (`@trustysquire.ai` Workspace
  catch-all → IMAP poll; a real `noreply@amplitude.com` activation email was
  received + link-followed). The "fresh-MX withholding" theory is disproven —
  our MX is reputable Google Workspace.

**Genuinely still open (the real next frontiers), in priority order:**

### N1 — Planner-navigation: authenticated but can't reach the key [P1, the dominant open bucket]
The 2026-06-04 sweep was **77% authenticated** — the bottleneck is post-OAuth
navigation, not auth. ~20 services log in fine but the planner can't reach/
extract the API key. Three corpus-driven, generalizable prompt themes (NOT
per-service): **A)** create-the-first-resource (org/project/cluster) when no
key is visible — axiom, kinde, meilisearch, qdrant; **B)** locate key in-UI +
404-recovery, stop guessing key URLs — grafana-cloud, typesense, ipdata, last9,
circleci, hookdeck, cockroachdb; **C)** finish onboarding form-fill — imagekit,
statsig, loops. Round 1 (commit f3b4909) converted +5 (render, qdrant, workos,
statsig, hookdeck) — themes A/C generalize. Remaining ~16 are progressively
bespoke (multi-step wizards, complex key-creation forms, no-obvious-key-path).
Weigh each round against diminishing returns. Pairs with
[[feedback-generalize-not-per-service]] + [[project-planner-generalization-plan]].

**Shipped (0.9.0):** the offline navigation-planner eval harness
(`docs/DESIGN-planner-navigation-eval.md`) is built AND used: temp-0
deterministic planner (pin a backend with `UNIVERSAL_BOT_OR_PROVIDER` for
cross-run determinism), auto-derived **reject-driven** regress set (R1, now
seeded with 8 live cases), 30-case hand-labeled target set (4 themes), gated
`eval-gate`, CI gate, B2 `failure-stats`. The **create-over-extract wall is
broken** (netlify/qdrant/baseten/supabase + the anthropic holdout) and
**live-validated** (netlify ✅ baseten ✅ on the housekeeper run). R3 redaction
is layered + audited (operator-handle denylist, neutral high-entropy marker,
extracted-credential-value scrub).

**Open (N1, what's left):**
- **Grow the regress set** — it gains real teeth as the housekeeper accumulates
  FAILED-run rejects (a purely-successful page is a vacuous regress pass). The
  20-service batch (2026-06-05) is the first feed.
- **Bespoke per-service walls** remain (~14): multi-step wizards, complex
  key-creation forms, no-obvious-key-path. Diminishing returns; the
  deterministic gate makes each prompt change cleanly measurable.
- **Single-step eval limit:** "extract" failures are SOFT (the bot recovers via
  a "click Create" re-plan hint), so the single-step eval over-penalizes a
  recoverable wasted round. Multi-round/trajectory eval is D1-rejected; the
  housekeeper pass rate is the ground truth for those.
- supabase (post-auth nav stuck) + qdrant (OAuth-only signup, no form) are
  distinct buckets, not the extract wall.

### N2 — amplitude: clean-identity end-to-end [P2, one run from a credential]
Mechanically conquered (demo-escape → form → multi-step password → account
created → activation email received → verify link followed). Not a clean
credential only because ~10 repeated mixed runs left amplitude with TWO
conflicting identities for one Google account (Google-OAuth-in-demo +
email-signup-pending), so the verified-email account ≠ the browser's OAuth
session. A clean single run on a fresh identity completes; reproducing needs a
fresh Google identity or deleting the amplitude accounts. Not anti-bot.

### N3 — Re-run the old "impossible-class" services on residential [P2, partially run — RE-PROMOTE]
Run on residential 2026-06-04 (`~/.trusty-squire/logs/round3-*`). Confirmed:
- **plunk ✅** — signed up, extracted 2 creds (`api_key` + `secret_key`,
  multi-cred), auto-promoted. (Earlier rounds failed `oauth_session_not_persisted`
  / nav timeout; the residential exit cleared it.)
- **uploadcare ✅** — signed up, extracted `api_key` on round 9, auto-promoted.
  (An earlier round blocked on `oauth_consent_needs_review`.)
- **replit** — ran, NO clean outcome captured (the prior "GREEN" claim was an
  overstatement; unconfirmed).
- **codesandbox / tally / plausible / cronitor / growthbook** — NOT run in that
  batch. cockroachdb has partial captures, no outcome.

**The catch:** plunk + uploadcare auto-promoted to pending-review, then the
verifier RETIRED them — the same OAuth-consent / verify-false-rot failures fixed
this session (OAuth consent walk + returning-user reclassification, 0.9.3). They
are NOT in the registry today. So N3's residual is now mostly a RE-PROMOTE: re-run
plunk + uploadcare so they re-promote and the fixed verifier keeps them, then run
the never-attempted five (codesandbox/tally/plausible/cronitor/growthbook) +
replit + cockroachdb. Still data-gathering, not new code. (The current discover
batch covers some of these.)

---

## Tier 2 — known good, no time pressure

### Harvester subagent Phase 3 — dry-run [from `docs/DESIGN-harvester-subagent.md`]
Build `tools/harvester-subagent/`: Claude Code headless + PreToolUse hook
gating Edit/Write/Bash; reads structured `failure-report.json`; proposes fixes
as markdown diffs to disk (NOT real PRs). Eval suite (~10 fixtures + reference
diffs) grades each prompt iteration. Gated on Phase 1+2 having accumulated real
failure data for a few days.

### Harvester subagent Phase 4 — real draft PRs [strategic]
After Phase 3 hits ≥70% acceptance over 4 weeks: promote to real draft PRs
against staging, cap of 3 open, rejected-fix memory, auto-resume after fix-rc.

### Harvester subagent Phase 5 — scale + multi-machine [strategic]
services.yaml 15 → 200. Route Cloudflare-protected services to a Mac-based
harvester (real GPU). Central queue coordination via the registry (not FS state).

### ipdata — re-test email-gated signup [P3, carried from todos.md]
A live run reaches the real `dashboard.ipdata.co/sign-up.html` form and submits
it, but ipdata gates on email verification and the mail never arrived in 180s
(`verification_not_sent`) on the old fresh-MX domain. Email deliverability is now
PROVEN end-to-end via the Workspace `@trustysquire.ai` catch-all → IMAP poll, so
the original blocker should be gone — re-run and inspect the success-page
extraction. Single-service data point, low urgency.

### services.yaml curation pass [~1 hour data curation]
The queue is ~101 services (`tools/housekeeper-services.yaml`). Remaining work:
confirm `oauth_provider` / `signup_url` accuracy for the long tail as failure
data accumulates (the resolver now self-heals most stale URLs, so this is lower
urgency than before); prune entries with genuinely no API key (stackblitz,
zeabur — online IDEs).

### AB6 — Pick battles: route unwinnable signups to manual [SHIPPED — denylist grows]
Mechanism shipped (`unwinnable-services.ts` + `runSession()` short-circuit to
`manual_signup_required` before launching Chrome; B1 stage `manual`). Initial
denylist: clerk (spa_broken), cloudflare (max_antibot), vercel/mailersend/
twilio/sendgrid (sms_phone), mailgun/circleci/betterstack (credit_card),
northflank (github_2fa). **Ongoing:** add services to the denylist as 0%
prospects surface from housekeeper data. The `sms_phone` services stay on the
manual denylist permanently — the user-relayed SMS relay (former F12) was
dropped, so phone-gated signups are operator-manual by design. Override a single
re-test with `UNIVERSAL_BOT_FORCE_UNWINNABLE=1`. (AB2 real-GPU/WebGL tell is closed by the
renderer spoof; AB3–AB5 deprioritized at score 1.0.)

### F7 — Multi-step / inline-code flows [P2, mostly shipped — verify]
The single-page→submit→email-link assumption is broken by multi-step (Mistral)
and inline-code (DeepSeek) flows. 0.8.17 shipped the multi-step continuation +
email-code entry + verify-wall routing; re-test Mistral/DeepSeek to confirm the
state-machine handles both shapes, and close or scope the residual.

---

## Tier 3 — eventually

### T3.4 — reCAPTCHA v2 static-grid solver [large, deprioritized]
Per the rejected-spike design. Heavy LLM cost; the proxy + 0.8.17 combo handles
the captcha cases we hit (invisible v3, visible v2 via 2Captcha) without it.

### G2 — API-side identity model (Tier 0 → Tier 1 funnel) [deferred]
Replace the anonymous machine token with an OAuth identity; build an identified
conversion funnel. Fast-follow per the original plan.

---

## Tier 4 — strategic / multi-week (P-roadmap)

One-liner each; detailed plans in older TODOS history.

- **P3 — Agent reads the vault** [keystone] — agents fetch existing keys
  instead of re-provisioning.
- **P4 — Vouchflow secures the vault** — harden P3's read surface before
  traffic. Coupled to P3. (Currently wired but enforces nothing — see
  [[project-vouchflow-wired-but-not-enforcing]].)
- **P2 — Provision SaaS directly from the vault UI** — web entry + paired-CLI
  dispatch.
- **P1 / P1.1 — Skillify signups → adapters + living service-URL registry** —
  partially shipped via the skill registry; codegen → review → land is the open
  half.
- **P1.2 — Composio fallback for connect-existing-account** — TS's bot creates
  new accounts; for users who already have one, route through Composio's OAuth
  (100+ services pre-registered). Vault stores both API keys and OAuth refresh
  tokens under one slug. Needs a second credential model + per-user Composio UX.
- **P5 — Stripe billing for TS subscriptions** — monetization, independent.
- **P6 — Paid-SaaS via Stripe Issuing + mandate tab** — heaviest, longest
  external lead time (Stripe Issuing approval).

---

## Blocked / waiting

### G4 — Residential-capture for handshake-needed services [UNBLOCKED — now runnable]
Was blocked on lacking a residential IP. We now HAVE one (SK-Broadband SOCKS) +
a 1.0 score, so this is no longer blocked — it folds into **N3** (re-run the
old impossible-class on residential). The remaining genuine human-gates
(GitHub install-time sudo-2FA on northflank, SMS, TOTP) still need the operator
— SMS-relay automation (former F12) was dropped, so these stay manual.

### VOUCHFLOW_READ_KEY env on `trusty-squire-api` [GATED]
Wait until the revocation/introspection feature lands (no current caller). Set
with a rotated key at that point.

### H1 / H2 / H3 — Concurrency [DEFERRED until concurrency is real]
Bot is single-flight. Known races: `recordPrewarmSuccess` shared-file write,
MACHINE_TOKEN_QUOTA + LLM rate-limit check-then-act. Fix when concurrency is a
real product surface.

---

## Notes for the harvester operator

Operational reminders, not TODOs.

- **`sudo loginctl enable-linger lunchbox`** keeps the systemd user timers
  running across logout. One-time per dev box.
- **`TRUSTY_SQUIRE_REGISTRY_URL`** in `harvester.env` is required for
  auto-promote to publish captured skills (without it: signups succeed, skills
  don't ship).
- **Workspace IMAP**: `WORKSPACE_IMAP_USER=lunchbox@trustysquire.ai` + a fresh
  app password on `trusty-squire-api` is what makes the `@trustysquire.ai`
  catch-all → IMAP-poll path work (verified end-to-end). The `release.yml` /
  CI publish path needs no local npm token — see CLAUDE.md.
- **Heal timer**: `systemctl --user start trusty-squire-heal.timer` if it isn't
  already running (held historically to avoid a Chrome-profile collision with a
  harvest run).
- **Per-service ToS audit** before scaling above 50 services; **dedicated
  GitHub App** for the harvester-subagent identity before Phase 4.
