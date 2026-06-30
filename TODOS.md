# TODOS

Open work only. Completed items live in the git history (see
`git log --grep TODOS` or the file's history for the full archive).

Sections are ordered by priority within each tier; **gated** items
are isolated at the bottom so the actionable list stays scannable.

---

## Launch readiness — post-launch follow-ups (2026-06-30)

The production/launch checklist (secrets audit, KMS fail-closed, DB capacity +
Telegram `/readyz` alert, per-account + egress + per-IP-install rate caps, the
Fly-Grafana single-pane dashboard, global kill switches, the npm rollback
runbook, and the load test) is **complete and deployed** — folded here from the
retired `todos.md` (full history in git). None of the below blocks launch.

- **SMS / phone-verification gate** [feature]. No bot-side phone handling or
  setting exists; some services gate signup on an SMS code. This is the
  product-side complement to the AB6 `sms_phone` manual denylist below — a real
  phone setting + fail-fast/relay path, not a UX tweak.
- **Headless `connect`: auto-set `TRUSTY_SQUIRE_SESSION_FILE=1` when `DISPLAY` is
  unset.** The heartbeat (no more dead-looking sign-in wait) shipped; this is the
  other half — a headless box's ephemeral OS keychain doesn't persist the
  session, so `connect` re-loops the noVNC page every run unless the var is
  exported globally. Detect headless and default the durable file session.
- **Web maintenance-banner UI.** `GET /v1/status` already exposes `maintenance` +
  `message` (from the `MAINTENANCE_MESSAGE` kill switch); the frontend just needs
  to read it and render a banner.
- **DB HA replica** [infra, when traffic justifies]. `trusty-squire-db` is a
  single node; a replica survives a node death mid-launch and lifts the ~1,100
  rps read ceiling (`docs/LOAD-TEST.md`). Bigger lift.
- **Separate the egress proxy from the API server** [infra, when traffic
  justifies]. Launch-appropriate version (per-account + per-grant caps) shipped;
  full split (a separate Fly process/machine pool sharing the DB) later.
- **Write-path load ceiling unmeasured.** The load test exercised read paths only
  (avoided polluting prod data); the `/v1/install` + OAuth write ceiling is
  inferred, not measured.
- **Legal review of the privacy policy + ToS** [owner, not code]. `apps/web`
  `/privacy` + `/terms` are engineer-drafted, not counsel-reviewed.
- **Team / Pro tier — VouchFlow `signPayload` as the first-party signing
  backbone** [parked]. Signed vault mandates → approval workflows +
  device-attested vault access + tamper-evident compliance audit. Decision open:
  bundle vs wedge. Related to P4 below.

---

## Where we are (2026-06-27, `@trusty-squire/mcp@0.9.19-rc.24`)

Since the 0.9.3 snapshot this section used to carry: the closed loop (virgin
success → synthesized skill → replay), the operator surface (`operate_*`), and
Stripe billing all shipped; the housekeeper moved to its own repo
(`Trusty-Squire/trusty-squire-housekeeper`) and its proactive **discover sweep
was removed** — new-skill growth now comes from **on-provision auto-promote**,
not a discover run. The full 0.9.0→0.9.3 shipping recap lives in git history +
`apps/mcp/CHANGELOG.md`. The anti-bot frontier stays settled (NOT detected; the
"it's the IP" theory is falsified) — every "wall" decomposes into a
nav/session/product-gate bug; see `STATE.md`.

> ⚠ Items below are carried from the 0.9.3 backlog and predate the
> housekeeper-repo split + the discover-sweep removal. Re-triage before acting:
> anything premised on a housekeeper "discover" run or the retired residential
> proxy needs re-framing against the on-provision auto-promote model.

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

### N3 — Re-run the old "impossible-class" services on residential [P2, SUPERSEDED MECHANISM — re-frame]
> ⚠ The `--mode=discover` housekeeper sweep + the residential proxy this item
> relies on are both gone (discover removed; proxy retired, direct-first). The
> services below are no longer re-promoted by a discover run — they ride the
> on-provision auto-promote path. Keep the service list as a candidate set;
> drop the discover/proxy/`n3-repromote.yaml` instructions.

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
replit + cockroachdb. Still data-gathering, not new code.

**Queued:** all nine are in a focused queue, `tools/housekeeper-n3-repromote.yaml`
(the main `housekeeper-services.yaml` runs strictly top-of-file + `--limit` with no
rotation, so these buried entries never get reached by a small batch). Run:
`node apps/mcp/dist/bin.js housekeeper --mode=discover --from=tools/housekeeper-n3-repromote.yaml --once --limit=9`.

---

### N4 — kinde: complete onboarding + extract the M2M-app credential [P2, deep build]
UPDATE 2026-06-09: re-measured under the fresh workspace identity. Two walls,
not one:
1. **Onboarding `business_details`** — FIXED. The operator's prior account took
   "tsagent"; the unique-org-name stall recovery (agent.ts: `pickUniqueNameField`
   + `pickOnboardingSubmit`, fires on a taken/unavailable signal) now overwrites
   the business NAME (which re-derives a unique subdomain) and creates a FRESH
   org (`tsq######.kinde.com`), clearing business_details → business_stage.
2. **Tech-stack SDK radio (`p_sdk`)** — HARD WALL (measured 2026-06-09, 8
   iterations). A `kui-util-hide-visually` radio whose `kui-on-change` gates the
   Next button. The bot CANNOT register a selection by ANY method tried: native
   click on the sr-only radio (fails actionability), native click on the
   `<label for>` (no effect), Playwright `check({force})`, AND a full JS-dispatch
   (`checked=true` + bubbling input/change/click). The tech step never accepts
   the selection, so submitting Next re-presents `m:tech`. kinde's kui framework
   appears to track selection in internal JS state that standard DOM events don't
   reach. Cracking it would need reverse-engineering kui's event API — low
   confidence, deeply kinde-specific. The four generalizable radio fixes shipped
   (check-route, force-advance, full-inventory, JS-dispatch) help OTHER n1 wizards
   but not kui. **Realistic path: operator completes kinde onboarding ONCE
   manually** (gets past the SDK picker → reaches `/admin` on the fresh
   `tsq######.kinde.com` org), THEN a hand-built verify-skill replays step 3.
3. **M2M credential** — kinde's API key is NOT produced by finishing onboarding;
   it's a **M2M application** created deliberately in Settings → APIs, yielding
   `client_id`+`client_secret` (multi-cred). So even past the radio, the bot must
   navigate the admin SPA to Add-application → M2M → create → reveal both creds.
**Realistic solve: a HAND-BUILT skill** (like render/imagekit via
`tools/replay-one.mjs <skill.json>`) encoding the create-M2M-app flow — but the
radio wall (2) must fall first so the bot can reach `/admin` to probe it. This
is a bot task; account-modifying. See [[project_discovery_signup_hardening_jun09]],
[[project_drive_to_green_jun08]].

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
- ~~**P5 — Stripe billing for TS subscriptions**~~ — **SHIPPED** (live
  2026-06-10): free-quota → `402 payment_required` → Checkout → webhook flips
  `subscription_status` active. See CLAUDE.md "Billing (Stripe)".
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
