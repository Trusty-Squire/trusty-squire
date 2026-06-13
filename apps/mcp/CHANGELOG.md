# Changelog — @trusty-squire/mcp

## 0.9.14-rc.1 (2026-06-13)

- fix(bot): self-launch Chrome + connectOverCDP to beat Cloudflare Turnstile
- docs(STATE): box can't reproduce exa's solvable Turnstile widget — IP reputation gates which challenge
- docs(STATE): exa serves 3 responses by context — datacenter IUAM soft-block (IP-driven) vs residential Turnstile widget (automation-layer, 2Captcha-solvable)
- fix(bot): more robust Turnstile sitekey extraction (widget variants)
- feat(bot): 2Captcha Turnstile escalation on the form-submit gate too (cartesia-class)
- feat(bot): explicit cross-process signup queue with expiry + watchdog (orphan/starvation fix)
- feat(bot): proxy liveness probe — fall back to DIRECT when the proxy is unreachable
- feat(bot): wire 2Captcha Turnstile escalation (TWOCAPTCHA_API_KEY already configured)
- fix(bot): bail captcha_blocked on inert (Turnstile-gated) OAuth click instead of false 'signed in'
- docs: add STATE.md — falsified-hypothesis ledger for discovery failures
- fix(bot): settle-then-recheck detectAlreadySignedIn for returning-user SPA redirects
- fix(bot): dotted-token extraction + guaranteed password class coverage (zerops, huggingface)
- chore(discovery): queue hygiene from heal-run diagnosis (URLs + dead-service dequeues)
- fix(bot): realistic screen geometry + availHeight (strict-Turnstile score)
- fix(bot): normalize device tells (hardwareConcurrency/deviceMemory) for Cloudflare Turnstile
- fix(bot): patient OAuth-scan when no provider button AND no credential form (replit)
- chore(discovery): dequeue cyclic (dead — acquired by AWS, shut down 2024)
- fix(bot): wait out GitHub's Authorize-button clickjacking countdown (defang)
- fix(bot): retry net::ERR_ABORTED on goto (defang)
- fix(bot): dead-route escape must skip OAuth-provider domains (typesense)
- fix(bot): treat an empty inventory as an unhydrated SPA shell in the OAuth-first scan (lancedb)
- fix(bot): reload once before declaring an OAuth session dead (galileo/turbopuffer/activeloop class)
- fix(bot): Mantine/Radix checkbox label-click + per-service allow_extra_oauth_scopes (friendliai, defang)
- fix(bot): profile-lock reap, hung-redirect wait cap, returning-user detect, octoai dequeue
- chore(discovery): dequeue superlinked (no self-serve signup)
- fix(bot): commit cmdk/Radix combobox selections via real pointer/click (meilisearch)
- fix(bot): chrome-error nav retry + credential-domain grounding (galileo/lancedb/typesense)
- fix(bot): captcha detection must never abort a signup (cartesia/cron-job.org/exa)
- fix(replay): zilliz-class replay hardening — MUI selects, OTP readback, post-click settle, consent-noise guard
- feat(replay): form-readiness parity — reach hydrating SPA forms before skipping
- fix(replay): guard waitForAuthWidgetHydration call (optional chaining)
- fix(replay): wait for SPA auth-widget hydration in the navigate step
- fix(bot): stamp stable signup_url on preamble rounds + replay-one session load
- feat(bot): capture the signup-form preamble (email-OTP skills replay end to end)
- feat(registry): static replay-completeness gate + email/URL generalization
- fix(synth): prefer a unique stable name/id over a duplicated placeholder
- feat: await_email_code step — email-OTP signups become replayable skills
- fix(bot): crack multi-wall onboarding signups (zilliz end-to-end)
- fix(bot): clickSubmit tolerates a navigation destroying the context
- feat(bot): capture inline validation errors + snapshot the post-verify stall
- fix(bot): OTP extraction must not grab recipient-address digits
- fix(bot): human-looking signup email (drop service-name leak) + snapshot failing re-submit
- docs(CLAUDE): document patchright CDP-hardening as the fingerprinting fix
- fix(bot): planner clicks Send-code buttons; synthesizer rejects IdP signup_url
- feat(bot): surface transient toasts after post-verify clicks
- fix(bot): resolve combobox options by role+accessible-name, not position
- fix(bot): combobox-option locator-click + name the unfilled required field
- docs(systemd): recommend UNIVERSAL_BOT_MAX_LLM_CALLS=25 for discovery
- chore(discovery): dequeue 5 unservable services (goal: servable OF#2)
- fix(housekeeper): cluster fixes by (stage, action-kind), not page signature
- feat(loop): surface fix outcomes on the dashboard + flag regressions (#1 slice 2)
- feat(housekeeper): close the output loop — fix grading (#1)
- feat(dashboard): 4-zone restructure + OF trend chips
- fix(dashboard): real-installs (residential) replaces inflated tokens-issued headline
- chore(release): release:mcp helper + branch-protection SOP
- fix(web): vault Copy works on first click (clipboard activation)
- docs: egress-grants design doc + roadmap pointer
- chore(skill-schema): cut 0.1.2-rc.2 — align next with main's code
- chore(mcp): cut 0.9.13-rc.1 — revive the next channel on main's code

## 0.9.13 (2026-06-11)

The autonomous self-improving loop, promoted to `latest`. Two objective
functions + the daily heal engine, the holistic fix-agent (`--mode=fix`), the
provision state machine with a single unknown-state escalation, the OF#3
registry hit-rate scoreboard, and the discovery-hardening arc that drove the
verifier queue to green — subdomain rebasing (kinde class), the returning-user
false-demotion fix, ephemeral-identifier generalization, and Plunk extraction.

- chore(discovery): smoke-test cleanup — drop active-dups, fix groq signup url
- feat(discovery): 300-service candidate queue + point the sweep at it
- feat(replay): subdomain rebasing for per-account-subdomain services (kinde class)
- fix(verify): don't demote active skills on authenticated returning-user divergence
- fix(replay): re-enter at host root when an extract finds nothing on a resource-id URL
- fix(extract): recognize Plunk pk_<hex> API keys (plaintext, no copy button)
- fix(replay): settle same-domain hosted-login before declaring OAuth recovery done
- fix(synth): generalize ephemeral identifiers (UUID hrefs, session-param URLs)
- feat(housekeeper): skip already-active services in the curated sweep
- feat(registry): OF#3 registry hit-rate scoreboard on the objectives panel
- feat(housekeeper): iterate-to-green — verify a fix unsticks the page before committing
- chore(housekeeper): dogfood next + tarball fence + output-loop spec (C4)
- feat(registry): stamp RC version on HealRun + dashboard RC column (C5)
- feat(housekeeper): holistic fix-agent + --mode=fix (C2)
- feat(housekeeper): failure-batch assembler + release fence + runEvalGate (C1/C3)
- feat(registry): migration for HealRun objective-function columns
- feat(loop): two objective functions — daily engine, dashboard, digest, CLAUDE.md
- test(housekeeper): end-to-end escalation dry-run
- docs: autonomous loop spec + skill-promotion pipeline
- feat(housekeeper): wire provision state machine + single unknown-state escalation
- feat(skill-schema): provision state machine + per-state policy + entry_state
- docs(todo): kinde N4 — kui SDK radio is a hard wall (4 methods fail); operator-assisted hand-build path
- fix(bot): JS-dispatch radio change as kui fallback (n1 wizards)
- fix(bot): force-advance reads full inventory; isolate kinde kui-radio wall
- fix(bot): route radio/checkbox clicks through check({force}) — fire change

## 0.9.12 (2026-06-09)

Single-identity consolidation + the existing-account/onboarding frontier. Closed
the open frontier: planetscale, replicate, railway, together, imagekit all green.

- **One operator IMAP identity.** The bot signs in as one Google account
  (`lunchbox@trustysquire.ai` Workspace); the OTP poller reads that one inbox.
  `gmail-otp-poller` → `operator-otp-poller`; env `OPERATOR_IMAP_USER`/
  `OPERATOR_IMAP_PASSWORD` (legacy `GMAIL_*` still read as fallback). Surfaces a
  clear `imap_auth_failed … rotate the app password` instead of opaque
  `Command failed`.
- **GitHub session no longer silently dies.** `login`/`connect` now auto-load
  `harvester.env`, so the interactive login routes through the SAME residential
  proxy the signups use — without it, the session was minted from the box's IP
  and the proxied run's IP jump silently killed the auth cookie.
- **`together` no longer abandons a working session.** `detectGoogleNoAccount`
  no longer false-fires on a logged-in dashboard that merely has a "create an
  account" CTA — a body match now only counts on a login/auth route.
- **`perplexity`/CF-class.** Clear the anti-bot interstitial (waitForFormReady)
  BEFORE the landing read, so the already-signed-in / OAuth-affordance decisions
  don't run against a Cloudflare "Verifying you are human" shell.
- **Bucket-2 `text_match` brittleness.** The synthesizer captures a stable
  `name=`/`id=` `dom_hint` (filtering React/css-in-js/hash values) and the replay
  matcher prefers a unique `dom_hint` over drift-prone visible text ("Next" /
  "Create"). Additive — clicks without a stable attr keep their canonical bytes.
- **Unique-org-name onboarding recovery.** On a "name taken" stall, overwrite the
  business/org NAME field (which re-derives a unique subdomain) and resubmit —
  unblocks re-signups whose org name collides with a prior account (kinde clears
  `business_details` and creates a fresh org).

## 0.9.11 (2026-06-09)

Discovery/signup-path hardening (the universal bot's `agent.ts`/`browser.ts` —
a separate path from 0.9.10's verifier-replay work). Nine generalizable fixes,
each diagnosed from a live batch log; 10 fresh services greened via discovery
(netlify, neon, brevo, qdrant, convex, plunk, mailtrap, chroma, weaviate,
honeycomb).

- **Profile-leak reap (the dominant fix).** A run whose Chrome leaked held the
  SingletonLock with a live pid, so the next run waited 120s and crashed with
  `ProfileBusyError` — one leak bricked every subsequent service in a batch
  (was ~30–40% of failures, pure infrastructure). Root cause: an un-capped
  `page.close()` hanging before the reap. Both `page.close()` (5s) and
  `context.close()` (10s) are now timeout-capped so the SIGKILL reap always
  runs; the reap kills any same-host lock holder after we're done with the
  profile (gated on `launchedContext`).
- **GSI-misroute recovery.** A classic redirect "Sign up with Google" button
  on a page that merely loads the GSI script no longer crashes — detect the
  in-flight Google redirect and drive the consent loop, else fall back to a
  redirect provider without re-clicking a dead button.
- **OAuth-offering login page = signup entry** (qdrant): a `/login` SPA with
  Continue-with-GitHub/Google is ridden via OAuth instead of dying on the
  Google-search fallback.
- **Login page ≠ dashboard** (fathom): bare "not a signup" no longer pivots a
  pre-auth login page into key extraction.
- **hCaptcha on the OAuth-first path**: escalates to the 2Captcha solver like
  the form-fill gate already did.
- **Bounded dead-ends**: abort the keys-URL walk after 3 consecutive 404s; cap
  post-verify navigates at 8 — both convert 600s URL-guessing hangs into
  prompt, honest failures.
- **Verify-link reload**: after following an emailed verification link that
  lands back on the "check your email" wall, reload so the SPA re-reads the
  now-verified session.

## 0.9.10 (2026-06-09)

Verifier-replay hardening — drove the verifier queue from 4 to 8 of 9 services
green. ~35 generalizable replay/synth fixes; the standouts:

- **OAuth recovery, end to end.** Detect a service's OWN auth-host redirect
  (`auth.porter.run`), not just social-IdP hosts. `settleAfterOAuth` in the
  replay path so Google GIS popup flows (imagekit/kinde) stop crashing on a
  closed popup tab. Prefer Google over GitHub in recovery (GitHub callbacks are
  rejected by more anti-bot services). GitHub `/authorize` consent is no longer
  misclassified as a 2FA challenge, and a DOM scope-fallback handles consent
  screens with no `scope=` param.
- **Returning-user replay.** Skip absent onboarding clicks/fills/selects; a
  glossed credential-creating click resolves by token-subset; `role_hint` is a
  soft preference; word-boundary click matching (so "Next" no longer matches
  "Next.js"); copy-button tie-break picks the first on a single-cred page.
- **Credential extraction.** Inline `label="value"` config-snippet parser
  (pusher's App Keys), `extract_labeled` counts toward multi-cred bundle
  completion, `app`↔`application` label synonym, low min-length floor for
  `*_id` fields, fuzzy fill-label match.
- **Ops.** `mcp housekeeper` auto-loads `~/.config/trusty-squire/harvester.env`
  on manual runs; CI secret-scan gate (`tools/secret-scan.sh`).

## 0.9.9 (2026-06-08)

Multi-cred loop completion + higher daily sweep budget.

- **Post-verify loop exits on a stable ≥2-cred bundle without `api_key`.**
  Pusher-class services issue no field literally named `api_key`
  (`application_id` + `app_key` + `secret`). The loop's stable-bundle exit
  required `api_key`/`username`, so for pusher it never fired — the loop spun
  every remaining round re-extracting the same bundle until the 15-call LLM
  budget tripped, surviving only via the existing-account fallback. A bundle of
  ≥2 named credentials that's been stable for the await window is now returned
  directly (mirrors the final success gate).
- **Daily signup cap default raised 30 → 88.** The 30 cap was a defensive
  guess from when sweeps were suspected of flagging the egress IP for abuse.
  That was disproved — the wall was SSH-tunnel concurrency, not IP reputation
  (gost runs 40/40 on the clean static IP). 88 covers a full sweep of the
  ~101-service curated queue across ~1.2 days. Still env-overridable via
  `UNIVERSAL_BOT_DAILY_SIGNUP_CAP`.
- **CI secret-scan gate.** `tools/secret-scan.sh` blocks credential-shaped
  values from entering the repo (dependency-free; wired into CI). Scrubbed
  several real captured values that had already landed in test fixtures.

## 0.9.8 (2026-06-08)

Post-OAuth onboarding wizards + provider fallback — the bot reaches API keys
on services it used to stall on.

- **Onboarding wizards with clickable cards now work.** Chakra/React wizards
  render selectable cards as bare clickable divs (cursor:pointer, no
  button/a/role), which the inventory missed — so the bot stalled with no
  target. It now captures them (tightly scoped so clean pages aren't
  polluted) and the existing card-radio grouping handles the rest.
  Live-validated: imagekit went from stalled to walking its full 3-step
  onboarding (role + objective + region + survey) and extracting an API key.
- **GitHub provider fallback when Google sign-in dead-ends.** Google won't
  render its FedCM dialog for an automated browser; when the page also offers
  GitHub (a redirect flow), the bot now retries via GitHub instead of failing.
- **Honest GSI/FedCM handling.** A Google GSI widget that doesn't complete no
  longer makes the bot falsely report "signed in"; it falls through to the
  redirect flow.
- **Onboarding stalls are now diagnosable** — the bot snapshots the page when
  the wizard breaker gives up.

## 0.9.7 (2026-06-08)

- **The CDP-hardened (patchright) browser launcher is now the default.**
  The old default (playwright-extra + stealth) self-inflicted a detectable
  `navigator.webdriver` via its manual defineProperty patch — strictly
  worse on the fingerprint. The hardened launcher runs evaluations in an
  isolated world and is all-green on the rebrowser bot-detector
  (mainWorldExecution / navigator.webdriver / viewport / runtimeEnableLeak
  all clean). Live A/B on the residential exit: meilisearch's Google
  consent-SPA block (approve button never hydrated for the leaky browser)
  became a FedCM path with the clean browser, and render still signed up +
  extracted a key — no crash on either (the historical crash was the
  retired rebrowser fork, not patchright). Opt out with
  `BOT_CDP_HARDENED=0`; if patchright isn't installed the launcher falls
  back to the stealth baseline gracefully.

## 0.9.6 (2026-06-08)

Multi-credential signups + OAuth/proxy resilience. Adds the label-scoped
multi-cred extraction primitive and a run of fixes that make the bot fail
fast and navigate consent/credential pages correctly instead of spinning.

- **Multi-credential synthesis.** New `extract_labeled` step kind — the
  canonical multi-cred primitive. When a planner reason names ≥2 labeled
  credentials, the synthesizer emits one label-scoped extract per
  credential and the replay engine resolves each value by its on-page
  LABEL (revealing a masked value), so two same-shaped keys on one page
  stay distinct. Single-cred captures keep the legacy path (byte-
  equivalent). Live-validated: algolia captures application_id +
  search_api_key + admin_api_key as a 3-credential skill.
- **Never extract an email address as a credential.** A signup that lands
  on an email-settings page no longer mistakes `name@host` for a key
  (the local-part used to slip past the credential-shape gate).
- **Fail fast on a degraded LLM proxy.** The form-fill loop capped its
  upstream-blip retries at 8 (mirroring post-verify) — a sustained
  proxy/credits outage previously spun ~177 planner calls to a 600s
  timeout; now it bails as `planning_failed (llm_proxy_unavailable)`.
- **OAuth consent, hardened.** The discover housekeeper approves a benign
  email/profile consent blind (the operator is provisioning on their own
  behalf; the DOM danger-phrase scraper still hard-aborts on
  Drive/Gmail/contacts). The Google approve-button matcher is broader
  (Allow / Allow access / Continue) with a DOM-scan fallback, and a
  slow-hydrating consent SPA gets a bounded wait before aborting.
- **Don't misclassify an OAuth signup-chooser as a verification wall.** A
  no-input page offering "Sign up with Google/GitHub" now takes the OAuth
  path instead of polling a phantom inbox.
- **Retry `page.goto` on transient SOCKS/connection drops** (up to 3×) so
  a residential-tunnel blip on a heavy page doesn't fail the whole signup.

## 0.9.5 (2026-06-07)

Closed-loop reliability: a run of post-OAuth navigation + signup-form +
skill-replay fixes that take services the universal bot could *sign up* but
not *promote to an active skill* all the way to active. Live-validated on the
residential housekeeper — axiom and statsig now go signup → auto-promote →
verify-replay → **active** end-to-end.

- **Onboarding wizards no longer false-stall.** The post-verify stuck
  detector treated two consecutive clicks with an unchanged element *count*
  as a stuck loop — but a multi-step wizard (role → company-size → plan)
  advances by clicking distinct radio cards that flip `aria-checked` without
  changing the count. A brand-new click selector is now treated as progress;
  only a repeated selector is a stall. (axiom went from `oauth_onboarding_
  failed` to a clean signup.)
- **Nav-link replay matches by stable href, not gloss text.** A synthesized
  skill could pass corpus checks yet fail live replay with `No element
  matches text_match="Settings"` — the sidebar link renders as an icon on
  replay and its URL's org slug differs between accounts. Click steps on
  links now carry an `href_hint`; replay matches by the href-path tail
  (ignoring a leading workspace/org slug) and, as a last resort, navigates
  to it rebased onto the current origin. This was the dominant
  active-promotion blocker.
- **Email verification-CODE gates (passwordless).** A "enter the code we
  emailed you" page with a single code input and no email/password field is
  now routed to the inbox-poll + code-entry path instead of the form-filler
  typing an empty literal and looping.
- **ARIA agreement checkboxes.** The unchecked-box detector now matches
  custom `<button role="checkbox">` / `<div role="checkbox">` agreements, not
  just native `<input type=checkbox>`, so wizard "Next" buttons gated on a
  required agreement get unblocked.
- **No premature post-verify `done`.** When the planner gives up with zero
  credentials captured on an authenticated dashboard, the bot now navigates
  to an unvisited canonical API-keys URL and re-plans (bounded) before
  honoring `done` — an empty services list is not "no API keys."

## 0.9.4 (2026-06-07)

Provision-path fixes for services where you already have an account, plus a
smarter OAuth provider choice. All of these run on the user-facing `provision`
flow, not just the housekeeper.

- **Already-authenticated services now produce a real key.** When your bot
  profile is already signed in to a service (very common — you sign up once,
  then ask for the key later), the bot used to bail `no_signup_link` ("the
  service likely has no self-serve signup") because the logged-in dashboard has
  no signup CTA. It now detects the authenticated state and routes straight to
  key extraction. Two follow-on guards make that produce a *real* key rather
  than a false success: the verification-wall detector only polls an inbox alias
  we actually own (not an operator/docs email shown on the page), and the
  extractor refuses to read a credential off a documentation page (which renders
  realistic SAMPLE keys). Live-validated: Anthropic signs in and mints a working
  `sk-ant-…` key end-to-end.
- **Google leads OAuth over a non-Google pin when its session is warm.** A
  service pinned to GitHub would take the GitHub path even when its signin page
  also offered Google — and hit GitHub's unclearable `/authorize` "Verify 2FA
  now" wall. Google now leads whenever its session is warm (GitHub stays as the
  fallback for pages whose Google is One-Tap-only). Measured: deepinfra failed
  on the GitHub wall, then succeeded immediately via Google.
- **npm README:** fixed the broken logo URL and the oversized headings; added
  dynamic badges (npm / CI / stars / license / Glama score).

## 0.9.3 (2026-06-07)

Graduates the 0.9.3 prerelease line (rc.1–rc.3) to stable and adds the
verify onboarding-skip fix. Everything here that touches `replay-skill.ts`
also runs on the router/provision replay path users hit, not just the
housekeeper.

- **Replay drives the OAuth handshake deterministically.** Skill replay
  used to bail to `needs_login` the moment an OAuth recipe hit an
  account-chooser / consent screen. It now walks the chooser + scope-gated
  consent deterministically (riding the operator's existing `mcp login`
  session — it does not log in), aborting to `needs_login` only on a real
  challenge or a sensitive scope. Live-validated on posthog/cohere/imagekit.
- **Replay no longer false-fails recipes against an already-registered
  account.** A signup-with-onboarding recipe replayed with an account that
  already exists skips the absent onboarding fill instead of hard-failing
  the step, and a credential step that then diverges from the fresh-signup
  capture is reported as `account_already_registered` (transient) rather
  than skill rot — so a working recipe can't be demoted just because the
  replaying account isn't brand new.
- **`use_credential` query-param auth.** The tool accepts `http.query` and
  passes it through, so query-string-auth APIs (FRED's `api_key`, gov/weather
  APIs with no header auth) work: `query: { api_key: "${SECRET}" }`. The
  secret is injected server-side after the host check and never appears in
  the URL.
- **Captures seed `allowed_hosts`.** The universal bot sends the signup host
  as `observed_hosts` when it writes a captured credential, so a new key
  lands with a usable allowlist instead of an empty one (which 403'd every
  `use_credential` call).
- **`nav_timeout` failure classifier.** A navigation / network / proxy
  timeout no longer counts as skill rot, so a transient tunnel blip can't
  retire a healthy skill.

## 0.9.2 (2026-06-06)

- **Quota runway nudge.** On a successful free-tier signup, `check_provision_status`
  now appends "N free signups left — you'll be prompted to upgrade ($19/mo) when
  they run out" while N is in the 1–3 band, so the paywall stops being an ambush.
  Reads the existing `/v1/install/status`; the band naturally skips paid accounts
  (which report 0). Best-effort — a status hiccup never alters or breaks a real
  signup result. Pairs with the API/web one-click pre-authenticated upgrade link.

## 0.9.1 (2026-06-05)

Operational hardening after the 0.9.0 live run burned a residential exit.

- **Housekeeper inter-run pacing.** The discover loop fired signups back-to-back
  within a batch and torched the residential IP's reputation (high-scrutiny
  services started rejecting the session at the OAuth callback). Added a base
  cooldown between live runs (`UNIVERSAL_BOT_RUN_COOLDOWN_SEC`, default 60s),
  adaptive backoff that grows when runs show IP-risk symptoms (OAuth-reject /
  dropped-conn / timeout / no-signup) and resets on a clean success, and a
  per-IP daily cap (`UNIVERSAL_BOT_DAILY_SIGNUP_CAP`, default 30) that stops the
  batch before it burns the exit. All env-tunable (0 disables).
- **AB6 — route unwinnable services to manual.** Known 0% prospects (clerk SPA,
  cloudflare dashboard, the SMS / credit-card / github-2fa human gates) now
  short-circuit to `manual_signup_required` before launching Chrome instead of
  burning ~6min + LLM calls. New B1 `manual` failure stage. Override with
  `UNIVERSAL_BOT_FORCE_UNWINNABLE=1`.
- **G14 — VNC password hardening.** The noVNC handoff passed the password as
  `-passwd <plaintext>` on x11vnc's argv (readable via `ps`); now a 0600
  `-passwdfile rm:<file>`.

## 0.9.0 (2026-06-05)

Post-OAuth navigation: deterministic planner, N1 planner wins (eval- AND
live-validated), an offline eval harness, and a flakiness taxonomy
(docs/DESIGN-planner-navigation-eval.md).

### Bot behavior (shipped)
- **Deterministic planner (temperature 0).** The post-verify navigation planner,
  the form-fill planner, and the tap-number vision read run at temperature 0
  instead of the provider default (~0.7). Same page → same decision run-to-run,
  removing the dominant source of post-OAuth navigation flakiness. Threaded
  through `LLMRequest`, all three LLM clients, and the `/v1/llm/chat` proxy.
- **create-over-extract (N1 wall).** On an API-keys/tokens page with a Create/
  Generate button — empty *or* listing existing masked keys — the planner now
  clicks Create to mint a fresh key instead of `extract`ing a masked/absent one;
  extract only when a complete unmasked value is shown. **Live-validated:**
  netlify + baseten now reach a key (baseten was the eval's sealed holdout).
- **Image media-type fix.** Planner image blocks label the screenshot by its
  actual bytes (PNG vs JPEG), not a hardcoded `image/jpeg` — fixes an Anthropic
  premium-fallback 400 on PNG screenshots.
- **`SignupResult.failure_stage`** — a structured terminal-stage taxonomy
  (oauth_handshake / hydration / planner_loop / extract / verify_email / captcha
  / …) on every run and the run-outcome sidecar.
- **New knobs:** `UNIVERSAL_BOT_PREMIUM_MODEL` (parse-failure fallback model),
  `UNIVERSAL_BOT_OR_PROVIDER` (pin one OpenRouter backend; eval determinism).

### Dev harness (not shipped in the tarball)
- Offline navigation-planner eval: A2 run-outcome capture sidecars → `build-corpus`
  (auto-derived **reject-driven** regress set, R1) → `label-target` (30 hand-
  labeled cases) → temp-0 gated `eval-gate` → `planner-eval.yml` CI gate → B2
  `failure-stats` aggregator.
- **Layered R3 redaction**, audited against real captures: provider keys / JWTs /
  emails, operator-handle denylist (`TRUSTY_SQUIRE_REDACT_IDENTITIES`), a neutral
  high-entropy marker (a `[REDACTED_TOKEN]`-littered page biased the planner
  toward extract), and an extracted-credential-value scrub (a success page shows
  the real key). Zero leakage verified.
