# TODOS

Open work only. Completed items live in the git history (see
`git log --grep TODOS` or the file's history for the full archive).

Sections are ordered by priority within each tier; **gated** items
are isolated at the bottom so the actionable list stays scannable.

---

## Where we are (2026-06-05, `@trusty-squire/mcp@0.9.0`)

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

### N3 — Re-run the old "impossible-class" services on residential [P2, quick win]
The services we previously wrote off as datacenter-IP anti-bot walls
(codesandbox, tally, plausible, cronitor, cockroachdb, growthbook, plunk,
uploadcare) were graded on a datacenter IP. We now have a residential exit AND
the 0.8.17 fixes AND a 1.0 score — re-run them; several should fall. plunk,
replit, uploadcare are already GREEN. This is data-gathering, not new code.

---

## Tier 1 — ship next (ungated, clear payoff)

### F12 — User-relayed SMS verification [P1, ~half day]
Vercel / MailerSend / Twilio / sendgrid all gate API tokens behind a phone +
SMS-code wall. The bot can't be SMS infrastructure (carrier-lookup rejects VoIP
numbers). Fix: a relay loop with two new MCP tools.
1. Bot detects phone-entry → returns `phone_verification_required` +
   `phone_entry_url` (noVNC if headless) + `run_id`.
2. Host LLM asks the user for their phone number.
3. New `provide_phone_number(run_id, phone)` types it via the existing session.
4. Bot waits for the SMS-code field → returns `phone_code_required`.
5. User reads the SMS; `provide_sms_code(run_id, code)` types it + verifies.

Doesn't touch the security boundary (the user's phone is the gate). Unblocks
~3 services in the queue today, many more in the expansion pool. **AB6 now
routes the `sms_phone` services (vercel/mailersend/twilio/sendgrid) to manual**
— when F12 lands, drop those entries from `unwinnable-services.ts` so the bot
clears them via the relay instead. The deep part is the mid-signup pause/resume
(a session registry + async continuation), not the two MCP tools.

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
prospects surface from housekeeper data; drop the `sms_phone` entries once F12's
relay can clear them. Override a single re-test with
`UNIVERSAL_BOT_FORCE_UNWINNABLE=1`. (AB2 real-GPU/WebGL tell is closed by the
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
or F12.

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
