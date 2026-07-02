# Changelog — @trusty-squire/mcp

## 1.0.27 (2026-07-02)

- fix(mcp): prune dead env keys from the config on connect (UNIVERSAL_BOT_PREFER_CHEAP)
- chore(release): resync staging with main (no-op pins)
- docs(changelog): tighten 1.0.26 entry
- release(mcp): 1.0.26
- fix(mcp): steer a stale Google session to --force-relogin, not plain connect
- chore(release): resync staging with main (no-op pins)
- docs(changelog): tighten 1.0.25 entry
- release(mcp): 1.0.25
- fix(mcp): don't emit the onboarding/setup-form steer on a login chooser
- chore(release): resync staging with main (no-op pins)
- docs(changelog): tighten 1.0.24 entry
- release(mcp): 1.0.24
- fix(mcp): extract prefixless all-uppercase API keys (ScrapingBee) — were rejected
- chore(release): resync staging with main (no-op pins)
- docs(changelog): tighten 1.0.23 entry
- release(mcp): 1.0.23
- fix: entry-url per-account id + egress multi-field ${SECRET} + login-page guidance
- chore(release): resync staging with main (no-op pins)
- docs(changelog): tighten 1.0.22 entry
- release(mcp): 1.0.22
- fix(mcp): finish_task scalar data + verification retry/wording + longer publish timeout
- chore(release): resync staging with main (no-op pins)
- docs(changelog): tighten 1.0.21 entry
- release(mcp): 1.0.21
- fix(mcp): open the mail row via extractInteractiveElements + this.click, not CSS
- chore(release): resync staging with main (no-op pins)
- docs(changelog): tighten 1.0.20 entry
- release(mcp): 1.0.20
- fix(mcp): await_verification reads the results LIST, never the opened mail's links
- chore(release): resync staging with main (no-op pins)
- docs(changelog): tighten 1.0.19 entry
- release(mcp): 1.0.19
- fix(mcp): await_verification missed passwordless "Login link" emails (found:false)
- chore(release): resync staging with main (no-op pins)
- docs(changelog): tighten 1.0.18 entry
- release(mcp): 1.0.18
- fix(mcp): surface ambiguous-service candidates + 404 signup-URL recovery guidance
- chore(release): resync staging with main (no-op pins)
- docs(changelog): tighten 1.0.17 entry
- release(mcp): 1.0.17
- fix(mcp): pickVerificationLink dropped magic-link/auth-callback URLs (link:null)
- chore(release): resync staging with main (no-op pins)
- docs(changelog): tighten 1.0.16 entry
- release(mcp): 1.0.16
- fix(mcp): value_len reported the [sealed] placeholder length (8), not the real fill
- chore(release): resync staging with main (no-op pins)
- docs(changelog): tighten 1.0.15 entry
- release(mcp): 1.0.15
- fix(mcp): derive service slug from the domain MAIN LABEL, not the dot-dashed host
- chore(release): resync staging with main (no-op pins)
- docs(changelog): tighten 1.0.14 entry
- release(mcp): 1.0.14
- fix(mcp): capture round URL is pre-action, not post-navigation
- chore(release): resync staging with main; pin to existing rc tags (no-op)
- docs(changelog): tighten 1.0.13 entry
- release(mcp): 1.0.13
- fix(mcp): resolve account id from session.json, not env-only — end-user loop was dead
- chore(release): resync staging with main; hold on rc channel (1.0.12-rc.1 / 0.1.4-rc.1)
- docs(changelog): tighten 1.0.12 entry
- release(mcp): 1.0.12
- fix(mcp): producer used a dotted host as the service slug → every auto-promote failed
- chore(release): resync staging with main; hold on the rc channel (1.0.11-rc.1 / 0.1.4-rc.1)
- docs(changelog): tighten 1.0.11 stable entry
- release(mcp): 1.0.11
- feat: operator-hints follow-ups — PII backfill, OAuth fallback logic, boot-version log
- fix(registry): reconcile old skills with the guidance paradigm + close deploy skew
- release: skill-schema 0.1.4-rc.1 + mcp 1.0.11-rc.1 (operator-hints)
- feat(mcp): Deliverable #1 — hint-lift measurement (slice 4)
- feat(mcp): producer — operate_* provision → capture → skill → publish (slice 3)
- feat(mcp): PII gate — redact identity fill values at synthesis (slice 2)
- feat(mcp): OAuth available[] generalization, capture→synth→render (slice 1)
- docs(spec): resolve R2-b — keep serving pending-review skills as hints
- docs(spec): resolve R2-a — medium capture shape, verified against the corpus
- docs(spec): rewrite on steps[]-as-guidance + eng review round 2
- docs(spec): resolve the 3 open decisions (Q1/Q2/Q3)
- docs(spec): refine hint resolution — mechanism as disambiguate-only tie-breaker
- docs: spec — operator hints (rewrite of recipe-to-registry)
- chore(release): resync staging with main; hold staging on the rc channel

## 1.0.26 (2026-07-01)

- **fix: a stale Google session is now recoverable.** After the bot's Google
  session went stale, plain `connect` reported "Already connected" (the preflight
  reads cached cookie presence, which outlives a server-invalidated session) and
  skipped relogin. The `google_session` wall now steers to
  `connect --force-relogin` and explains why plain `connect` won't refresh a stale
  session; the "Already connected" hint names the stale-session case too.

## 1.0.25 (2026-07-01)

- **fix: no onboarding/setup-form steer on a login chooser.** 1.0.23 stopped the
  "prefer app navigation" steer on a login page but the separate "onboarding form —
  fill the fields" steer still fired ("Create Account or Login" matched it). A
  login/OAuth chooser now gets no authenticated-surface guidance at all.

## 1.0.24 (2026-07-01)

- **fix: `operate_extract` now returns prefixless all-uppercase API keys**
  (ScrapingBee: 80-char A-Z0-9, no separator) instead of `no_legit_credential`.
  They were rejected twice — as an env-var name (that check is now length-bounded)
  and by the credential gate (now accepts a ≥40-char uppercase-alphanumeric key,
  still distinct from lowercase-hex hashes and session tokens). Measured against
  the real key format.

## 1.0.23 (2026-07-01)

- **fix: skill `entry_url` no longer bakes in a per-account id** (Deepgram
  `/project/<uuid>`, Neon `/app/org-…-<digits>`) — falls back to the app origin,
  which routes to the user's own default resource after login.
- **fix: egress `${SECRET}` resolves on a multi-field credential** by picking the
  secret-ish field (api_key/secret/token…), instead of erroring `secret_ambiguous`
  (server-side; deploys with this release).
- **fix: no more "prefer app navigation" steer on a login page** — a login/OAuth
  chooser is recognized as an auth wall, not the authenticated app surface.

## 1.0.22 (2026-07-01)

- **fix: `operate_finish_task.data` accepts scalar values** (boolean/number),
  coerced to string — a bare boolean used to be rejected with "Expected string".
- **fix: `operate_await_verification` retries the search up to 3× within one call**
  (verification emails commonly arrive 10–30s after the trigger, so a single
  search missed them). The first-miss message steers to retry first, not a
  misleading "SMS/authenticator" hint.
- **fix: skill publish gets a 15s timeout** (was the 3s read default) — the
  registry auto-stops, so an auto-promote after idle timed out on the cold start.

## 1.0.21 (2026-07-01)

- **fix: `await_verification` now actually opens the mail row** (1.0.20's CSS
  selector missed — the row never opened, so a magic link still couldn't be read).
  Opens the conversation via `extractInteractiveElements` + the humanized
  positional click `operate_act` uses (Gmail's `div[role=link]` rows don't fire on
  a synthetic click). Validated live against the real Loops login email: the row
  opens and its `/api/auth/callback?token=…` link is extracted.

## 1.0.20 (2026-07-01)

- **fix: `operate_await_verification` never read a magic LINK — only the results
  list.** It extracted hrefs from the search-results list (snippets + Gmail chrome
  links), but a verification/magic link lives in the email BODY, which only
  renders when the mail is opened. So OTP codes worked (visible in the snippet)
  but passwordless magic links returned `found:false` even after 1.0.19 let the
  mail be found. Now opens the first result before extracting, and merges body +
  list (so OTP-in-snippet still works if opening fails). Measured against the real
  Loops login email.

## 1.0.19 (2026-07-01)

- **fix: `operate_await_verification` missed passwordless "Login link" emails
  (`found:false`).** The inbox search required verify/confirm/code/otp/password —
  none of which appear in a passwordless magic-link email (Loops: "Please login…
  Login") — so the email was never found and the 1.0.17 link parser never ran.
  The search now also covers login / "sign in" / "magic link" / activate / welcome
  vocabulary. Verified live against the real Loops login email + its
  `/api/auth/callback/email?token=…` link.

## 1.0.18 (2026-07-01)

- **fix: `use_credential` on an ambiguous service now lists the candidate
  references** (and points at `list_credentials`) instead of a bare
  `ambiguous_service` — no blind round-trip to disambiguate.
- **fix: a 404 signup URL now steers to recovery.** New not-found-page detection
  tells the agent to try `/register` / `/sign-up` / the root-domain signup link
  instead of looping on a stale `/signup` (unblocks Loops/OpenRouter, and the
  email fallback after an unlinked-OAuth "account not found").

## 1.0.17 (2026-07-01)

- **fix: `operate_await_verification` returned `link:null` for magic-link emails.**
  The link scorer only credited `verify`/`confirm`/`activate`, so a Next.js /
  NextAuth confirmation link (`/api/auth/callback/email?token=…`, as Loops and
  Supabase/Clerk/Auth0 send) scored 0 and was dropped even when it was the only
  actionable link. Now also credits auth-callback/magic/passwordless paths and
  token-bearing query params (and decodes `&amp;` before scoring). Non-verification
  links (dashboard, unsubscribe) are unaffected.

## 1.0.16 (2026-07-01)

- **fix: a filled sealed field reported `value_len: 8` (the `[sealed]` placeholder
  length), not the real fill.** A correctly-typed 19-char email read as truncated,
  so the agent fought a phantom bug across email/password signups. `value_len` now
  reports the real character count (a length signal, not the value — the value
  stays hidden).
- **fix: login guidance no longer tells the agent to use an OAuth provider a page
  doesn't offer.** On an email-only signup it now hedges (use the session provider
  if offered, else sign up with email) instead of chasing a missing button.

## 1.0.15 (2026-07-01)

- **fix: new skills landed in a separate slug namespace.** The producer and hint
  lookup slugged `resend.com` → `resend-com` (dot dashed), while agent/housekeeper
  skills are `resend` — so freshly-published skills never superseded old ones and
  the slug lookup missed them, and the next provision fell back to the stale skill
  by host. Now derives the slug from the domain's main label (`resend.com` →
  `resend`, `console.neon.tech` → `neon`) via a shared `serviceSlugFromHost`, so
  producer, lookup, and existing skills share one namespace. Ships skill-schema 0.1.5.

## 1.0.14 (2026-07-01)

- **fix: skill entry_url pointed at a post-login page and the OAuth step was
  dropped.** The producer recorded each capture round's URL *after* the action
  navigated, but paired it with the pre-action inventory — so an OAuth click that
  redirected made round 0's URL the dashboard, corrupting `entry_url` (→ `/emails`
  instead of `/signup`) and dropping the login step (so `available[]` never
  surfaced in the hint). Now records the pre-action URL. Fixes both.

## 1.0.13 (2026-07-01)

- **fix (critical): the registry loop was dead for every end-user install.** The
  hint read and the auto-promote write resolved the account id from
  `process.env` only, but `connect` binds end-user installs by writing
  `account_id` to `session.json` (only the registry URL goes to the env). So no
  hint was served and `auto_promote` returned `produced:no_account`. Now falls
  back to `session.json`, matching the documented design.

## 1.0.12 (2026-07-01)

- **fix (critical): the accumulation loop never closed for any real service.**
  The producer derived a skill's service slug from the registrable host
  (`resend.com`), which fails SkillSchema's slug regex (no dots), so every real
  provision's synthesized skill was rejected `schema_invalid` and nothing
  published. Now derived exactly like the hint lookup (`serviceSlugFromUrl` →
  `canonicalizeServiceSlug`): a valid dot-free slug that matches the key the next
  provision reads, so the loop closes.
- `auto_promote` now surfaces the rejection detail, not just the error kind.

## 1.0.11 (2026-07-01)

**The operator-hints loop.** A verified provision now feeds the registry, and the
next provision of that service gets a hint — closing the "registry never
accumulates from real provisions" gap. Ships with skill-schema 0.1.4.

- **Producer:** a verified `operate_finish_task` (credential vaulted, not blocked)
  captures the run as a MEDIUM capture (structured inventory + action + scrubbed
  URL per step; raw HTML only on the extract round; no screenshots), synthesizes a
  skill, and publishes it pending-review — served back as a hint on the next
  provision. Best-effort; never fails the provision.
- **PII gate at upload:** identity fill values (name/company/org) redact to
  `${IDENTITY}` at synthesis; a `backfill-pii` script re-scrubs pre-existing
  skills. Secret-bearing actions never enter a shared skill.
- **OAuth `available[]`:** the login step records the whole provider menu the page
  offered, surfaced as guidance and available for replay fallback.
- **Guidance-paradigm reconciliation (registry):** a rotted blind-replay now
  DOWNGRADES a skill (active → pending-review, still served as a hint, re-proven)
  instead of demoting it out of the router. Deploy-skew fix so a schema bump
  redeploys the registry.
- **Measurement:** a `provision-measurement` line per finish for the hint-on vs
  hint-off lift.

## 1.0.10 (2026-06-30)

Promotes the 1.0.10 line (rc.1 → rc.3) to stable. Highlights:

- **Compact operate observations, default-on.** `observeSession` now emits a
  compact perception payload — drops the `screen`/`accessibility` re-encodings,
  omits null/empty/false element fields, drops `container` (redundant with
  `path`), and returns `value_len` instead of raw values. ~50% smaller per turn
  with no perception loss (proven by an information-equivalence eval).
- **One ordered verbosity knob.** A single per-call `detail: none|compact|full`
  on `operate_observe` (compact|full) and `operate_act` (none|compact|full) —
  `full` restores the legacy payload for an ambiguous step, `none` is a bare ack
  so chained fills don't each echo the page. Replaces the short-lived
  `BOT_OBSERVE_COMPACT` env + `include` option from the rc line.
- **Cleanup:** retired the orphaned eval corpus (`apps/mcp/corpus/eval`, dead
  since the autonomous planner was removed), rebranded the `[universal-bot]` log
  prefixes to `[operator]`, and pruned stale `agent.ts`/doc references in
  comments. No behavior change.

## 1.0.10-rc.3 (2026-06-30)

- refactor(mcp): collapse the observation-verbosity controls into **one ordered
  per-call knob** `detail: none|compact|full` on both `operate_observe`
  (compact|full) and `operate_act` (none|compact|full). Removed the
  `BOT_OBSERVE_COMPACT` env default (payload shape has no server-side blast
  radius — nothing for an operator to revert; compact is simply the hardcoded
  default) and the `operate_observe` `include` option (broke the linear ladder;
  `full` is the escalation). Same behavior, one coherent vocabulary the planner
  sets per call.

## 1.0.10-rc.2 (2026-06-30)

- feat(mcp): compact observation is now **default-on** (`BOT_OBSERVE_COMPACT`
  opt out with `=0`), after the information-equivalence eval + live format-smoke.
- feat(mcp): `operate_observe({ detail:"compact"|"full", include:["screen"|"accessibility"] })`
  — `full` restores the legacy payload; `include` re-adds one heavy view on demand.
- feat(mcp): `operate_act({ observe:"none"|"compact"|"full" })` — `none` returns a
  minimal ack so chained fills don't each echo the page (the per-act multiplier).

## 1.0.10-rc.1 (2026-06-30)

- feat(mcp): compact operate observation payload behind `BOT_OBSERVE_COMPACT`
  (default **off**). Drops the redundant `screen`/`accessibility` re-encodings,
  omits empty element fields, reports `value_len` not the raw value, drops
  `container` (redundant with `path`), adds `elements_total`/`text_truncated`
  metadata. ~50% smaller per turn with zero perception loss; full mode unchanged.
  Information-equivalence eval + design doc included. Flip the default only after
  a live format-smoke. (#282)

## 1.0.9 (2026-06-30)

Promotes the 1.0.9-rc line to stable. Full detail in the rc.1 / rc.2 entries below.

- fix(mcp): `connect` provider-session probe launches the system Chrome
  (`channel:"chrome"`) — fixes the spurious "Provider session check failed
  (continuing)" ✗ on every connect. (#278)
- fix(mcp): operator-recipes record a stable `entry_url` and drop single-use
  links, so `operate_use` replays no longer open on a dead token page. (#280)
- fix(captcha): configured 2Captcha token solve counts the gate as settled;
  invisible reCAPTCHA passes the `invisible` flag; v3 escalates to the solver
  only when a key is configured (else it stays a `captcha_wall`). (#279)
- docs: canonical `docs/ARCHITECTURE.md` + docs index; stale public design/E2E
  docs removed. (#279)

## 1.0.9-rc.2 (2026-06-30)

- fix(captcha): a successful 2Captcha token solve now counts the gate as
  settled, and invisible reCAPTCHA passes the `invisible` flag to the solver
  so the right widget mode is solved. (#279)
- docs: add canonical `docs/ARCHITECTURE.md` + docs index; remove stale public
  design/E2E planning docs and repoint internal references at the canonical
  doc. (#279)

## 1.0.9-rc.1 (2026-06-30)

- fix(mcp): the `connect` provider-session probe now launches the system Chrome
  (`channel:"chrome"`) like the login flow, instead of reaching for an absent
  bundled Chromium — fixes the spurious "Provider session check failed
  (continuing)" ✗ on every connect (the catch also surfaces the real error). (#278)
- fix(mcp): operator-recipes record a stable `entry_url` and drop single-use
  links (email-verify / magic / reset tokens) from the trace, so `operate_use`
  replays no longer open on a dead "invalid or expired token" page. (#280)

## 1.0.8 (2026-06-30)

Promotes 1.0.8-rc.1 to stable.

- feat(mcp): the headless `connect` sign-in wait shows a heartbeat with remaining
  time instead of sitting on a blank cursor (looked frozen on no-DISPLAY boxes). (#271)
- refactor(mcp): removed the dead OpenRouter LLM-proxy client — the BYOK
  `OPENROUTER_API_KEY` install prompt and the `UNIVERSAL_BOT_LLM_TIER` /
  `UNIVERSAL_BOT_PREFER_CHEAP` knobs are gone (the in-process planner was already
  retired). OpenRouter stays a provisionable service. (#269)
- fix(mcp): reworded stale "universal bot" copy in the `--no-registry` connect output. (#263)

## 1.0.7 (2026-06-29)

Promotes the 1.0.7-rc line to stable: **2Captcha key vaulting** (your own key,
encrypted in the vault, spent through the injecting proxy — never on disk) and a
**fail-fast captcha gate** (a structured `needs_user` with the exact remedy).
Full detail in the rc.2 / rc.1 entries below.

## 1.0.7-rc.2 (2026-06-29)

- feat(mcp): fail-fast captcha gate — `operate_captcha_gate` returns a structured
  `needs_user {gate, message, remedy}` when it can't clear a challenge, so the
  host surfaces an actionable message and stops driving (`captcha_solver` → set
  up 2Captcha in settings; `captcha_wall` → proxy or manual signup).

## 1.0.7-rc.1 (2026-06-29)

- **feat(captcha): vault the 2Captcha key at install; spend it through the
  proxy.** `connect`/`settings` advanced setup optionally prompts for a 2Captcha
  API key and stores it ENCRYPTED as the `2captcha` vault credential (never
  written to the MCP config). The captcha gate then spends it through the
  injecting proxy (`use_credential`, `${SECRET}` injected server-side) so the
  raw key never lives in the bot process. Falls back to `TWOCAPTCHA_API_KEY` for
  back-compat. Fingerprint-neutral (the v2 token is a back-channel fetch,
  injected into the user's real session).

## 1.0.6 (2026-06-29)

Promotes the 1.0.6-rc line to stable: the expanded 10-example "what you can ask
your squire" marketing section (full detail in the rc.2 entry below). Docs only
— no code change over 1.0.5.
## 1.0.6-rc.2 (2026-06-29)

- docs(readme): expand "What you can ask your squire" into a 10-example
  marketing section spanning the full operator + vault range — provision,
  stack bootstrap, sealed multi-console OAuth, egress grants (deployed app /
  local agent / third-party leash), transparent rotation, instant kill-switch,
  the audit ledger, and zero-downtime vendor migration. Eight verified live;
  the two composite asks chain verified primitives.

## 1.0.6-rc.1 (2026-06-29)

Sync the staging RC line up to `1.0.5` (staging had drifted to `1.0.1-rc.2`,
12 commits behind main — so the next RC would have been cut from a base missing
the audit/revoke tools, the honest README, and the extraction + captcha fixes).
No functional change over `1.0.5`; this just realigns the prerelease channel.

## 1.0.5 (2026-06-29)

**Extraction — prefixless keys beside a copy/reveal control.** `operate_extract`
returned `no_legit_credential` on pages whose API key is a bare, separatorless
token (deepinfra's `Hb1bT6VZJdM2cvxVKdm2WCL3kdg6VNNz`) — the strict scanners
refuse such a token from raw page text because it's indistinguishable from a
hash/trace-id. Fixed by using *copy/reveal-affordance proximity* as the
disambiguator: `extractCredentialsNearCopyButtons` now also recognises icon
controls by id/class/data-testid (not just visible "copy" text) and reveal /
toggle-visibility affordances, and a new `pickRelaxedNearCopyCredential` accepts
a copy-proximate token under a relaxed shape rule (rejects dates, times, emails,
URLs, bare UUIDs, and hex-only shas). Applies only when no labeled/prefixed key
was found, so it can't clobber a real match.

**Captcha gate — token-true success signal.** `operate_captcha_gate` now drives
the substrate's provider-specific gate (invisible reCAPTCHA v3 trigger → visible
checkbox solve → 2Captcha token-solver fallback for reCAPTCHA v2 / hCaptcha /
Turnstile) and requires a real response token before reporting `settled`, rather
than treating challenge-disappearance alone as cleared (a v2 checkbox can sit
idle with an empty token).

## 1.0.4 (2026-06-29)

Closes two gaps where the README marketed a capability the agent surface
couldn't actually perform. Found during an end-to-end pass over the seven
"what you can ask your squire" use cases.

- **`audit_log`** — "show me everything that touched my keys." The vault audit
  ledger was web-only; the account's own agent now reads it
  (`GET /v1/vault/audit`, account-scoped, no secret values — strictly less than
  `list_credentials`, which is already agent-readable). Filter by `type` /
  `reference`, page with `before`.
- **`revoke_app_access`** — "something leaked, kill that key now." Instantly
  revokes an egress grant (`DELETE /v1/egress/grants/:id`); the next call
  through it is rejected. The DELETE route existed but no tool wrapped it.
- **`list_app_access`** — lists this account's egress grants so you can find
  the `grant_id` to revoke.

## 1.0.3 (2026-06-29)

- **`connect` no longer re-opens the install/noVNC page when the bot profile is
  busy.** The preflight probes live profile cookies to confirm the session; if
  another Chromium already holds the profile (a live operate run, a background
  job, or an orphaned Chrome) the probe threw and connect fell through to a full
  re-pair. It now falls back to the session's cached provider state, so a valid
  install short-circuits ("Already connected") regardless of profile contention.

## 1.0.2 (2026-06-29)

**`connect` reliability.**
- `connect` no longer re-opens the install/noVNC page every run on headless
  boxes where the OS keychain is present-but-ephemeral: set
  `TRUSTY_SQUIRE_SESSION_FILE=1` (globally) to use the durable
  `~/.config/trusty-squire/session.json` instead of the keychain. `connect`
  now prints a hint pointing at this when the keychain backend is in use.
- Install page: the GitHub step reflects the **bot's** live GitHub session, not
  a stale account link — it shows "linked — sign in to enable" until the OAuth
  runs in the bot's Chrome (which is what actually lets the bot act on GitHub),
  and the contradictory "connected but might not work" copy is gone.

**Housekeeping.**
- Dropped stale alias/pricing copy from this README (the Squire-alias inbound
  mail and the Pro tier are gone — verification reads your own inbox; beta is
  free).
- Retired the inbound-mail subsystem end to end (package + DB + secrets) and
  swept the leftovers; the API owns its own Prisma tooling now.

## 1.0.1 (2026-06-29)

Promotes the 1.0.1-rc line to stable. Highlights since 1.0.0 (full detail in the
rc.1 / rc.2 entries below):

**User-owned signups (sign-in vault).** The operator signs services up with the
user's own Google identity (captured at `connect`), seals the login + a
generated password into a `username_password` vault credential, and reads the
verification code from the user's own inbox behind a just-in-time consent gate —
no Squire email aliases.

**Privacy hardening.**
- Observations no longer echo a sealed value: after `type_secret`, the password
  (and the email filled from the sealed login slot) is masked to `[sealed]` in
  `elements[].value`, the accessibility tree, the screen outline, and the
  element label — the cleartext never returns to the host.
- Operator recipes no longer record inbox-provider steps, so a shared recipe
  can't leak the user's mail (subject text or webmail navigation).
- Browser-fill responses are encrypted to an ephemeral key; login-host wildcard
  storage rejects broad public-suffix scopes; rotation persists non-secret
  metadata.

**Inbound-mail subsystem retired.** With aliases gone, the Squire-alias inbound
pipeline (`packages/inbox`, the resend-inbound webhook) is removed and the API
owns its own Prisma tooling.

## 1.0.1-rc.2 (2026-06-28)

**Sign-in vault hardening**
- Browser-fill responses are encrypted to an ephemeral MCP key instead of
  returning plaintext fields over the API boundary.
- Credential rotation now persists non-secret metadata/type updates used by
  browser-fill and egress policy.
- Login-host wildcard storage rejects broad public-suffix scopes.
- CI/release hygiene: remove stale package filters and run canonical install
  verification after publish.

## 1.0.1-rc.1 (2026-06-28)

**Universal-bot retirement (completed)**
- Excised the autonomous skill-replay engine (`replay-skill.ts` + the
  `mcp skill replay-test` command) — skills are operator hints now, not
  autonomously executed recipes.
- Swept the dead code the retirement stranded: `llm-client`, `inbox-client`,
  inbox `mailgun-handler`, vault `kek-derivation`, and skill-schema
  `provision-state`/`provision-policy` (all verified zero-caller).

**Sign-in + vault credentials (user-owned non-OAuth signups)**
- Consent gate: `operate_await_verification` no longer reads the user's inbox
  without consent (fail-closed); `grant_inbox_consent` grants it in-context at
  the verification wall (session-remembered).
- Capture-at-login: the user's Google email is captured at `connect` and
  surfaced as `user_email` on the start observation, so signups use the user's
  own address (no Trusty Squire alias) and the read inbox matches it.
- `operate_prepare_login` / `operate_store_login`: seal the user's email + a
  generated password into session slots (masked handles only) and vault them as
  a `username_password` credential — the account is the user's, re-loginable.
- Privacy: the user's real email is redacted from operator recipes (heuristic
  email-shape + exact known-email scrub).

## 1.0.0 (2026-06-28)

First stable release. Promotes the 1.0.0-rc line, plus:

**Free during beta**
- Billing is kill-switched off (`BILLING_ENABLED`, default off): no one can be
  charged by a stray Upgrade click, even with a live Stripe key.
- The free-signup quota / 402 paywall is removed — provisioning is unlimited.
- Client drops the stale quota nudge + `getMachineStatus` plumbing.

**Positioning**
- Three pillars: provision / vault / operate. Pricing is Free / $20 Pro (no
  Enterprise tier yet). Rotation and egress spend-caps are marked "coming
  soon" / "planned" until enforced — claims no longer run ahead of the code.

**Cleanup + hardening**
- Removed the dead Vouchflow device-attestation integration and the orphaned
  signup-quota upgrade-token path end to end.
- `SESSION_JWT_SECRET` now fails closed in production.

## 1.0.0-rc.0 (2026-06-27)

First 1.0 release candidate. Headlines: the operator surface gains user-saved
workflows, the credential-extraction shape logic is consolidated, and a
production audit cleared out dead code + stale docs.

**Operator surface — user-saved workflows (Phase A)**
- `operate_remember` / `operate_use`: save a successful operator run as a named
  local recipe (goal + text-targeted rail + sealed-slot references + a
  machine-checkable postcondition) and replay it by name — planner-on-rails,
  verified before close (the anti-false-green gate). Secrets are stored as slot
  references, never values. See `docs/ARCHITECTURE.md`.
- Persistent single-session operate-driver harness (`tools/op-driver.mjs`).

**Extraction hardening**
- Reveal keys hidden behind a "View" button (Zilliz) or a copy-button aria-label
  (GCP's new client secret) — two real false-green/miss fixes.
- Converged the credential-shape predicates into one canonical module + a single
  masked-glyph definition (was four divergent spellings that disagreed — the
  masked-key trap). 17 new tests.
- Steer the host past real-identity signup walls: existing-account → log in and
  read the existing key (OpenRouter); unlinked-OAuth → switch to email/OTP (Clerk).

**Hygiene**
- Removed dead code (dev spikes, an unregistered route) and orphaned artifacts
  (retired SES records, a dangerous root `fly.toml`); freshened stale docs
  (SES → Resend, version drift); pruned the stale `TODOS.md` snapshot.
- fix(extract): reveal keys hidden behind a view-button or copy-button aria-label
- release(mcp): 0.9.19-rc.24 — recognize multi-segment vendor keys (luma-api-)
- release(mcp): 0.9.19-rc.23 — force-relogin no longer wipes the other provider
- chore(tools): tidy the comments that referenced the deleted orphan probes
- chore(tools): drop orphaned operator probes + tidy their comment refs
- release(mcp): 0.9.19-rc.22 — proactively prompt GitHub reconnect on dead session
- release(mcp): 0.9.19-rc.21 — force-relogin=github routes to GitHub-only login
- docs+fix(connect): session-validation spec + 'GitHub dead' notice on skip
- release(mcp): 0.9.19-rc.20 — guidance: drive through setup forms + one-time secrets
- release(mcp): 0.9.19-rc.19 — recognize hyphen-prefixed keys (tally) + web GitHub reconnect
- release(mcp): 0.9.19-rc.18 — validate GitHub session on every path
- release(mcp): 0.9.19-rc.17 — kill false-green extraction + report-back
- release(mcp): 0.9.19-rc.16 — validate GitHub session + secret_label
- release(mcp): 0.9.19-rc.15 — ARIA switch activation + masked-secret guard
- fix(operate): never seal a masked secret into a slot
- release(mcp): 0.9.19-rc.14 — scroll action + sealed OTP (T3/T5 fixes)
- refactor(operate): delete the inert TRUSTY_SQUIRE_OPERATE flag
- release(mcp): 0.9.19-rc.13 — operator surface Phase 1
- test(operate): functional session-flow suite (8 tests, mocked browser)
- feat(operate): Change 2+3 — 2-kind terminal + operate_* rename (no aliases)
- feat(operate): Change 5 — Google-session precondition gate + operate feature flag
- test(operate): validateAllowHost hardening + maskSecretValue (16 new cases, 71 pass)
- feat(operate): Change 1+4 tool layer — allowed_hosts, allow_host, type_secret, into_slot, egress_hosts
- feat(operate): Change 1+4 substrate — source-tracked allow-set, allow_host, sealed secret slots, egress decouple
- chore: scrub stale pwa/inbox-api refs + drop dead/demo scripts
- chore: final sweep — drop orphaned tools + old autonomous-loop docs; track 2 design notes
- refactor: extract housekeeper to its own repo + delete dead apps/tools
- feat(provision): wall hand-off Flow B — captcha_blocked → sign-up-and-vault hand-back
- feat(provision): wall hand-off Flow A — needs_user_code on await_verification
- docs(wall-handoff): fold Codex review — two contracts, metadata, honesty fixes
- docs(wall-handoff): pivot to conversational hand-back; bridge → deferred shelf option
- docs(wall-handoff): spike results — Linux+Xvfb bridge viable; fold Codex findings
- fix(redact): run structural DOM-secret patterns before the generic redactor
- chore: stop ignoring /docs/ — design notes belong in the repo
- docs: design note — wall hand-off (pause, surface live browser, resume)
- refactor(bot): rip out the operator-only Telegram notifier
- fix(systemd): daily verify timer uses OnCalendar, not monotonic
- refactor(registry): remove dead verdict/sampler decision path
- docs(housekeeper): Phase 6 — rewrite runbook + CLAUDE.md for verify-only model
- feat(housekeeper): Phase 5 — systemd verify unit + --check preflight
- fix(connect): require google identity for connected state
- chore: snapshot dogfood fixes
- refactor(mcp): delete the old in-mcp housekeeper (moved to apps/housekeeper)
- docs(housekeeper): Phase 0 — registry mechanical rule already present
- feat(housekeeper): verify scheduler + thin registry client
- feat(housekeeper): codex-exec runner + failure classifier
- feat(housekeeper): scaffold apps/housekeeper standalone package
- docs(housekeeper): design note — codex-driven verify scheduler

## 0.9.19-rc.24 (2026-06-27)

Prerelease (`next`). Recognize multi-segment vendor keys.

- **fix(extract):** `looksLikeCredentialToken` now accepts a multi-hyphen vendor
  key (Luma's `luma-api-4Y7FDyM…`) when a segment is a high-entropy run (≥10
  chars with both a letter and a digit). Single-run/underscore keys were already
  recognized; this adds the multi-segment case while still rejecting
  word-word-word-date slugs (`trusty-squire-dogfood-20260625`).

## 0.9.19-rc.23 (2026-06-27)

Prerelease (`next`). **Critical:** a force-relogin no longer wipes the *other*
provider's session.

- **fix(connect):** `ensureOAuthSession({forceOpen})` cleared **all** cookies
  (bare `ctx.clearCookies()`), so `--force-relogin=github` (and
  `login --provider=github --force-relogin`) nuked the live **Google** session —
  after which every `require_live_identity` operate task failed the precondition
  gate with "no live Google session." Now it clears only the *named provider's*
  session cookies, leaving the other provider intact.

## 0.9.19-rc.22 (2026-06-27)

Prerelease (`next`). connect now proactively fixes a dead GitHub session.

- **feat(connect):** when a plain `connect` would short-circuit (Google valid +
  bound) but the bot's GitHub session validated **dead**, it now **prompts**
  "Reconnect GitHub now?" (default yes) and does a GitHub-only login if accepted
  — instead of just printing a notice. A dead GitHub session is exactly why
  people re-run connect (GitHub-OAuth signups were failing), so it's fixed in
  place. Skippable; non-interactive/scripted installs fall back to the notice.
- **refactor:** the GitHub-only relogin is now a shared helper used by both
  `--force-relogin=github` and the proactive prompt.

## 0.9.19-rc.21 (2026-06-27)

Prerelease (`next`). First slice of the connect/session-validation redesign
(`docs/ARCHITECTURE.md`).

- **fix(connect):** `--force-relogin=github` on an already-bound account now
  routes straight to a **GitHub-only login** (with the account chooser, since the
  session was cleared) — it no longer drags in the Google-first account-binding
  page. Google's gate is already satisfied; GitHub is logged in on its own.
- **fix(connect):** when connect short-circuits (Google valid + bound) but the
  bot's GitHub session validated **dead**, it now prints a notice ("run
  --force-relogin=github") instead of silently hiding it.

Still pending (next slice): the plain-ceremony confirm page should drive the
GitHub step from the bot's validated session, not the account link.

## 0.9.19-rc.20 (2026-06-27)

Prerelease (`next`). Perception guidance so the host agent drives THROUGH setup
forms and one-time-secret modals instead of treating them as walls.

- **feat(operate):** the observation `guidance` now flags an **onboarding /
  org-creation form** ("Tell us about yourself", "create your organization",
  "you aren't part of an org yet") as NOT a wall — telling the agent to fill the
  required fields with sensible inferred values (name; org/workspace = your name
  or "Personal"; smallest/free plan) and submit to reach the keys page.
- **feat(operate):** the guidance now flags a **one-time secret reveal** ("won't
  be shown again", "copy your key now") — telling the agent to extract it
  IMMEDIATELY (with `secret_label` to pick the right field) before navigating
  away, since the value vanishes. Addresses the Luma one-time-key miss.

## 0.9.19-rc.19 (2026-06-27)

Prerelease (`next`). Stop refusing real keys whose vendor prefix isn't hardcoded.

- **fix(extract):** `looksLikeCredentialToken` accepted only underscore tokens or
  a hardcoded prefix list, so a real hyphen-prefixed key (Tally `tly-…`) was
  refused and returned `no_legit_credential`. Now any `prefix-<single random
  run>` token is recognized, while word-word-word-date slugs (multiple hyphens)
  stay rejected.

## 0.9.19-rc.18 (2026-06-27)

Prerelease (`next`). The GitHub session validation (rc.16) is now the DEFAULT on
every path, not opt-in.

- **fix(connect):** `detectActiveProviderSessions` now validates GitHub
  everywhere — including the hot provision start, not just the install display —
  so the agent's "you have GitHub" hint and the connected_providers sync reflect
  a session that actually works, not a dead-but-present cookie. Stays cheap: it
  only pays the github.com round-trip when a GitHub cookie is present; no cookie
  → fast false, no navigation. Google remains presence-based (it doesn't lie).

## 0.9.19-rc.17 (2026-06-27)

Prerelease (`next`). Stops false-green credential extraction (page noise being
stored as "keys"), and reports back so the agent retries instead of stopping.

- **fix(extract):** harden the credential-noise filter — reject ISO dates
  (`2026-06-23`), emails, anything containing whitespace (greetings/sentences),
  and UI label fragments (`Owner:`). These were being stored in the vault as
  junk "keys". Real keys have none of those shapes, so nothing legit is dropped.
- **feat(extract):** when a page had candidate values but none survived as a
  real credential, `operate_extract` now returns a `blocked_reason`
  (`no_legit_credential: … navigate to the keys page or reveal the key, then
  extract again`) instead of a silent empty — so the host agent keeps going
  rather than treating junk/empty as success.

## 0.9.19-rc.16 (2026-06-27)

Prerelease (`next`). Two fixes from the third live run.

- **fix(connect):** the "GitHub marker lies" bug — a GitHub session that expired
  server-side leaves its `user_session` cookie in the profile, so the install
  display showed GitHub "connected" when it wasn't (and tasks then failed to
  authorize). The install/preflight checks now *validate* the session
  (`detectActiveProviderSessions({validate:true})` navigates to github.com and
  reads the refreshed `logged_in` flag) instead of trusting cookie presence. The
  hot provision path stays on the fast cookie check.
- **fix(operate):** `operate_extract{into_slot, secret_label?}` — when a page
  shows several credentials (Google's OAuth dialog has both a client ID and a
  client secret), the into_slot capture was sealing the first non-masked value
  (the ID). Pass `secret_label:"client secret"` to seal the right one.

## 0.9.19-rc.15 (2026-06-27)

Prerelease (`next`). Two fixes from the second live operator-surface run (the
"add Google OAuth" capstone, which reached one Firebase toggle from done).

- **fix(operate):** `operate_act{click}` now activates ARIA toggles —
  `<button role="switch">` / `role="checkbox"` (Firebase's Google-provider
  "Enable" switch, Material toggles). A synthetic click often doesn't flip these;
  we now click, and if `aria-checked` doesn't move, focus + press Space (then
  Enter). This was the last blocker on the OAuth capstone.
- **fix(operate):** `operate_extract{into_slot}` never seals a *masked* secret —
  Google's OAuth client secret renders as `GOCSPX-••••` + a copy button, and the
  slot was capturing the mask. Now it prefers a non-masked value and, if only a
  masked one is present, returns `sealed:false` with a "reveal it first" reason.

## 0.9.19-rc.14 (2026-06-26)

Prerelease (`next`). Two fixes from the first live operator-surface test run
(Codex against rc.13), plus removal of the inert `TRUSTY_SQUIRE_OPERATE` flag.

- **feat(operate):** `operate_act{kind:"scroll", direction?}` reveals
  below-the-fold controls on long SPA forms (the GCP-console capstone stalled
  because lower fields never entered the element inventory). `operate_observe`
  after a scroll picks up the newly-visible elements.
- **feat(operate):** `operate_await_verification{into_slot}` seals a found email
  OTP into a session slot — the host gets a masked handle, not the digits, and
  enters it with `operate_act{type_secret, slot}`. The code never round-trips
  through the host (safer, and dodges host-side payload truncation).
- **removed:** the inert `TRUSTY_SQUIRE_OPERATE` flag (it gated nothing; the
  real gate is per-call `require_live_identity`).

## 0.9.19-rc.13 (2026-06-26)

Prerelease (`next`). **Operator surface Phase 1** — the host-driven browser
tools generalize from "drive a signup, extract a key" to driving arbitrary,
credential-gated, often multi-app tasks. Every new capability is opt-in
per-call (the precondition gate fires only on `require_live_identity`; the new
params/actions activate only when the host uses them).

- **renamed:** the 7 `provision_*` tools → `operate_*` (no aliases), plus a new
  `operate_finish_task`. `operate_finish` stays for abort.
- **feat(operate):** multi-app task scope — `operate_start{allowed_hosts[]}` and
  a mid-session `allow_host` action let a task cross between apps (GCP Console →
  Firebase → your app). Source-tracked allow-set; hardened host validation
  (rejects punycode/IP/IPv6/public-suffix/port/wildcard).
- **feat(operate):** sealed in-session credential transfer — `operate_extract`
  `{into_slot}` stashes a secret server-side (host gets a masked handle only);
  `operate_act{type_secret}` types the real value into another site's form. The
  raw secret never crosses the MCP boundary (the write-only-vault moat extended
  to transfers).
- **feat(operate):** pluggable terminal — `operate_finish_task` reports
  `kind:"credentials"` (extract + vault-store, byte-identical to the old store
  path) or `kind:"result"` (a summary + structured data for any task).
- **feat(operate):** Google-session precondition gate — operate tasks acting as
  the user (`require_live_identity`) fail closed to a connect hand-back BEFORE
  driving when no live session exists, instead of hitting a mid-task wall.
- **security(vault):** credential egress decoupled from task scope — explicit
  `egress_hosts` + service-default table (added gcp/firebase/fcm → googleapis);
  a mid-session host never seeds a key's egress allow-list.

## 0.9.19-rc.12 (2026-06-25)

Prerelease (`next`). Fixes Goose installs that kept loading older Trusty Squire
servers after reconnecting.

- fixed(connect): Goose configs written from npx now launch
  `npx -y @trusty-squire/mcp@<version> server` instead of pinning a temporary
  npx cache path that can disappear or keep stale tool schemas alive.
- fixed(connect): Goose reconnects now remove legacy `trustysquire` /
  `trusty-squire` extension aliases, including old entries pinned to versions
  like `@trusty-squire/mcp@0.4.1`, while preserving useful env settings such as
  proxy configuration.

## 0.9.19-rc.11 (2026-06-25)

Prerelease (`next`). Removes the old async provisioning surface and deprecated
installer compatibility flags for the host-driven signup flow.

- removed(provision): the public MCP tool list no longer exposes `provision` or
  `check_provision_status`; agents now drive signups directly with
  `provision_start`, `provision_observe`, `provision_act`, `provision_extract`,
  and `provision_finish`.
- removed(connect): the old `install` command alias and deprecated flags
  `--registry`, `--registry-url`, `--skip-login`, and `--skip-secondary` now
  fail fast with explicit migration guidance.
- changed(connect): managed skill registry participation defaults on, while
  `--no-registry` remains the explicit opt-out.
- changed(provision): the interactive signup driver is always available; the
  previous environment opt-out was removed.
- docs(connect): README, agent guidance, and helper scripts now describe
  `connect` and the explicit signup-driver tools only.

## 0.9.19-rc.10 (2026-06-25)

Prerelease (`next`). Improves the interactive signup driver after the latest
dogfood batch against hosted developer tools.

- feat(provision): observations now include generated action refs plus compact
  accessibility-style region context, so planners can target repeated labels
  without guessing from flat page text.
- fix(provision): OAuth sessions recover the active product page after popup or
  account-switch flows, and tenant subdomains reached by organic redirects can
  be reused for scoped navigation.
- fix(provision): credential extraction drops UI noise such as versions, dates,
  referral codes, key names, masked placeholders, and Together-style key IDs.
  Langfuse and Neon extraction now normalize the real one-time key/token fields.
- fix(provision): post-signup recovery can try curated key routes, reveal masked
  credential surfaces before sweeping, detect create-key/payment loops, and use
  Render account settings when API keys live behind the account menu.

## 0.9.19-rc.9 (2026-06-25)

Prerelease (`next`). Tightens the session-agent install flow after the first
account-switching and consent tests.

- fix(connect): `--force-relogin=google|github` can now clear a single provider
  session while bare `--force-relogin` still resets the full browser profile for
  a true account switch.
- fix(connect): duplicate install claims recover from the paired state instead
  of surfacing `not_pending` after the user completes browser sign-in.
- changed(connect): managed skill registry and skillification consent are now
  one user-facing choice. Registry participation controls whether successful,
  redacted signup/navigation traces can become reusable skills.
- changed(connect): registry participation, matching-service email OTP polling,
  and proxy URL moved into Advanced settings. OTP polling defaults to off.
- fix(connect): proxy URLs from the CLI or browser claim are parsed and
  whitespace/control characters are rejected before they reach MCP config env.
- changed(connect): stale LLM/provider setup copy was removed from the install
  flow; signups are now described as session-agent driven.

## 0.9.19-rc.8 (2026-06-25)

Prerelease (`next`). Account-switching and privacy gates for the session-agent
signup flow.

- fix(connect): `connect --force-relogin` now waits for the bot Chrome profile
  to be free, then clears the whole bot browser profile. This wipes the
  Trusty Squire app session as well as provider cookies, so the Google sign-in
  button prompts for a fresh account instead of silently reusing the old
  install session.
- feat(connect): install now asks two explicit permissions: whether successful
  signup/navigation traces may become reusable skills without personal data or
  secrets, and whether the squire may poll only matching OTP/verification
  emails for the requested service.
- fix(provision): the persisted consent flags are enforced at runtime. Missing
  or declined consent disables auto-promotion/skillification and disables
  operator-inbox OTP/device-link polling.
- chore(connect): the interactive setup copy no longer asks users to configure
  or provision their own LLM. Signups are described as session-agent driven.

## 0.9.19-rc.7 (2026-06-25)

Prerelease (`next`). Extraction fails CLOSED on a login wall — kills the
last class of false-green (the Grok/X case from the field test).

- fix(provision): `provision_extract` now detects an anti-bot / login-wall page
  (X's "JavaScript is not available" tombstone, Cloudflare's "Just a moment",
  "Verifying you are human", etc.) and refuses to scrape it. Such a page has no
  credential — every token on it is a session/CSRF/asset value — so returning one
  is a false-green. The tool returns `{credentials:{}, blocked_reason}` instead,
  telling the host to drive an interactive login or hand back to the user.
- Net: Grok is a genuine X-login wall (x.ai signup routes through X/Twitter
  OAuth, which blocks headless Chromium). No hint can overcome X's anti-bot on
  the login step; the bot now says so explicitly rather than handing back junk.

## 0.9.19-rc.6 (2026-06-25)

Prerelease (`next`). Login-agnostic hints — makes ALL registry skills usable for
end users regardless of how the discoverer signed up, dissolving the thin-skill
problem (81% of skills carry no usable login provider).

- feat(provision): the route hint no longer prescribes a login method. A skill's
  recorded login reflects how the *housekeeper* signed up (usually an email
  alias), not how the user will. The hint now carries the durable, reusable part
  — entry URL, the **post-auth navigation breadcrumb** to the keys page, and an
  always-on "grab EVERY credential, not just the first" exhortation.
- feat(provision): `provision_start` tells the agent which provider the user
  **actually has a live session for** (read from profile cookies via
  `detectSessionProviders`), Google-preferred, with "the account may exist — log
  IN, don't re-sign-up." So the agent doesn't guess the login.
- Net: even a skill with `oauth_provider:null` + single-cred now yields a useful
  hint. (xai-grok's hint now points straight at `console.x.ai` — the keys page —
  which would have prevented the Grok flail.)

## 0.9.19-rc.5 (2026-06-25)

Prerelease (`next`). Registry-hint reachability (Gap 1) — the hint now finds
skills whose slug doesn't derive from the URL.

- feat(provision): resolve the route hint by **signup_url host**, not just slug.
  A skill promoted under a curated name (x.ai → "xai-grok") is unreachable by
  the URL-canonicalized slug ("x-ai"); `provision_start` now falls back to a new
  registry lookup (`GET /skills/by-host`) that returns the best skill (active or
  pending-review) whose signup_url host matches. Requires the registry deploy
  that adds the endpoint; degrades gracefully (no hint) against an older registry.
- fix(provision): `renderSkillHint` reads the skill's top-level `oauth_provider`
  field (the source of truth), not just a click_oauth_button step — so a skill
  that records its login method surfaces it correctly.

## 0.9.19-rc.4 (2026-06-25)

Prerelease (`next`). Registry-route hints — the map the host agent was missing.

- feat(provision): `provision_start` now consults the registry for a known skill
  for the target service and, when one exists, attaches a `hint` to the first
  observation: the route (login method, where the key lives + its shape, how
  many credentials to expect). The agent reads the map and drives toward it
  instead of making ad-hoc decisions (the Grok flail: try Google → "account
  exists" → tombstone → scrape junk). Best-effort: no skill / no registry /
  network error → no hint, agent drives as before. Pure `renderSkillHint` +
  `serviceSlugFromUrl` are unit-tested.

## 0.9.19-rc.3 (2026-06-25)

Prerelease (`next`). Two extraction-correctness fixes from the first fresh-agent
field test (Grok + VouchFlow):

- fix(provision): reject code-identifier false-greens. X's anti-bot tombstone
  ("JavaScript is not available…") leaked `loader.tweetUnavailableTombstoneHandler`
  (a JS function name) into `provision_extract`, which wrote it to the vault as
  an api_key and reported success — a false-green. Any dotted member-access
  token is now rejected (JWTs excepted via their `eyJ` prefix).
- fix(provision): multi-credential extraction. The single-key extraction policy
  stopped at the first key, so VouchFlow's sandbox **read** key was dropped when
  the **write** key was captured. `provision_extract` now also collects every
  distinct credential-shaped token (prefix + body + digit) and surfaces the
  extras as `api_key_2`, `api_key_3`, …
- Both guarded by unit tests against the exact field-test strings.

## 0.9.19-rc.2 (2026-06-25)

Prerelease (`next`). Boot-crash fix — 0.9.19-rc.1 pinned the stale-by-content
`@trusty-squire/skill-schema@0.1.2` (published before the `canonicalizeServiceSlug`
export), so `npx @next` crashed on boot with "does not provide an export named
'canonicalizeServiceSlug'". Republished skill-schema as `0.1.3-rc.1` with the
matching content; this build pins it. No feature changes from rc.1.

## 0.9.19-rc.1 (2026-06-25)

Prerelease (`next`). Phase 1 of the host-as-planner architecture: an
interactive, host-driven provisioning tool surface a frontier coding agent
drives directly. The agent is the planner; Trusty Squire is the browser + the
credential-broker moat.

- feat(provision): interactive `provision_*` tool surface (DEFAULT-ON; opt out
  with `PROVISION_DRIVE_TOOLS=0`). The host agent drives a real signup on the
  user's machine via a session-held browser: `provision_start` →
  `provision_observe` / `provision_act` → `provision_captcha_gate` /
  `provision_await_verification` → `provision_extract` → `provision_finish`.
  Backed by the existing `BrowserController` substrate (OAuth popup adoption,
  captcha gate, extraction). Elements are targeted by text/role with
  re-resolution every action (never a stale index); agent-initiated `goto` is
  domain-scoped to the target + its identity providers; the vault stays
  write-only; every action is audit-logged with no credential values.
- feat(provision): `provision_await_verification` reads the user's OWN inbox
  through their signed-in browser session (no IMAP, no mail token) — a scoped
  Gmail search-and-extract for the OTP code / verification link.
- Validated live end-to-end: a fresh-identity virgin LangWatch signup (Auth0 →
  Google OAuth → onboarding wizard → API key) driven entirely through the
  tools. `parseVerification` (OTP/link parsing) and the targeting/scoping logic
  are unit-tested. Full mcp suite green (2148 passed).
- Design + remaining hardening (consent-at-install) tracked in
  `docs/ARCHITECTURE.md`.

## 0.9.18 (2026-06-24)

Stable (`latest`). Verify-replay hardening that drove meilisearch pending-review
-> active end-to-end, plus the egress 503 mitigation (#231/#227).

- fix(verify): replay drives the OAuth login inline instead of bailing
  `needs_login`; restores the product page after a popup-OAuth handshake
  (`settleAfterOAuth` on the primary path); fills required onboarding-survey
  comboboxes before a disabled submit.
- fix(verify): same-provider `needs_login` is redrawable (per-robot session
  variance, bounded cap); reclaim robots that bail `needs_login`; post-OAuth +
  deterministic login-wall guards stop a single wall starving the heal sweep.
- fix(replay): a visible auth gate dominates weak nav keywords in
  `detectAlreadySignedIn` (no more skipping the OAuth step on a /login shell).
- fix(egress): `Retry-After` + `scope:"proxy"` on the 503, plus a short-TTL
  credential-lookup cache -- a proxy outage no longer burns escalation rungs and
  the per-request DB pressure (P1017, #227) is relieved.

## 0.9.18-rc.1 (2026-06-23)

Prerelease (`next`). Three services cracked end-to-end (meilisearch, firebase,
gcp) plus the generalizing bot fixes that did it.

- fix(bot): meilisearch — SPA stale-URL 404 trap. cloud.meilisearch.com serves
  one 200 shell for /login and /signup, so the HTTP probe "upgraded" a working
  /login to a /signup that only 404s after React mounts. Added a live
  `looksLike404` fallback (revert to the original hint when the resolved URL
  renders a client-side 404) + a 404 veto on the already-authenticated
  classifier. Generalizes to any SPA whose curated URL goes stale. meilisearch
  now OAuths through end-to-end.
- feat(bot): crack firebase + gcp (live: discover firebase → ok, gcp → ok). The
  wall was identity + MFA, not nav: the Workspace verify robots can't create GCP
  projects (org policy). New `BOT_GOOGLE_PROFILE_DIR` (+ `mcp login
  --profile-dir`) pins an isolated PERSONAL Google identity for org-gated
  targets. A mandatory 2SV gate is now classified `mfa_setup_required`
  (`looksLikeMfaEnrollmentGate`) instead of a misleading `oauth_required`. The
  authenticated Google console (firebase/gcp), which the OAuth scan read as a
  perpetual loading shell, now routes to post-verify
  (`isAuthenticatedGoogleConsoleUrl`). And a deterministic extractor
  (`extractGoogleApiKeyFromCredentials`) pulls the auto-created "Browser key"
  from the GCP credentials page once a project exists — the same AIzaSy is the
  firebase web apiKey AND a GCP API key, so one extractor covers both.

## 0.9.17-rc.5 (2026-06-23)

Prerelease (`next`). Anti-bot fingerprint hardening, the refuse-walled provision
gate (BYO anchors), and a batch of generalizing bot/nav fixes.

- fix(bot): hCaptcha in-iframe fingerprint spoof — the WebGL/device spoof now
  reaches the cross-origin captcha iframe's own main world (it was main-frame
  only, so hCaptcha read the real software-WebGL/20-core profile), timing-hardened
  until the renderer reads Intel. Generalizes to hCaptcha/Turnstile sites that
  fingerprint in-iframe. Plus a `BOT_CDP_ENDPOINT` real-GPU remote-CDP path
  (spoof + Xvfb auto-disabled in remote mode) for the end-user-on-real-hardware
  path. Stripe stays a multi-layer BYO anchor (see STATE.md).
- feat(provision): refuse-walled pre-flight — a permanent wall (phone/payment/
  manual / operator-dequeue) refuses fast and routes to bring-your-own-key
  instead of botting a KYC wall; temporary walls (anti_bot/nav) still flow to the
  discover loop. Reuses the registry ServiceState dossier; fails open.
- fix(bot): per-service capture isolation (multi-service discover no longer
  cross-contaminates capture chains), terminal-gate legal-onboarding-vs-review
  disambiguation, nav-search Google-console detour guard, humanized submit routing.
- feat(housekeeper): `--mode=shopping` — a read-only fetch+regex signup-link
  resolver/classifier (no accounts, no robots, no LLM).
- chore: queue the buildable vibe-coder head-spine services; clear pre-existing
  typecheck + test debt (verifier test files, pick-verification, discover
  identity-pool isolation).

## 0.9.17-rc.2 (2026-06-17)

Prerelease (`next`). groq cracked end-to-end, the verify-pool warmer no longer
false-succeeds, and the housekeeper memory overhaul (Phases 1-4) lands.

- fix(bot): mint through groq's in-modal Cloudflare Turnstile — nav-search now reaches the create-key surface (a virgin keys table's headers no longer mis-classify as an existing masked listing), drives the "name your key" modal, and runs the captcha gate INSIDE the modal so the disabled submit enables. groq signs up + extracts a key live; skill auto-promoted.
- fix(verify-pool): `warm` actually ACTIVATES never-`agreedToTerms` robots instead of reporting a false success off a stale cookie — it prechecks activation and forces a clean ToS login. verify-01..05 recovered.
- feat(memory): Phase 1 — `ProvisionEvent` carries `mode` (discover/verify/replay) + a captcha summary (firehose unification, no rename).
- feat(memory): Phase 2 — the discover worker uploads its full per-round failure chain to the registry (redacted: captcha tokens, auth/cookie headers, password values scrubbed before upload), closing the "evidence dies locally" gap.
- feat(memory): operator ledger CLI — `mcp housekeeper issue list|claim|resolve|wall` drains the registry's failure queue (server-side close-gate: no resolve without a green run, no wall without a falsification), and `state-doc` generates the status doc from materialized `ServiceState`. (Registry-side Phases 3-4 ship via the registry deploy.)

## 0.9.17-rc.1 (2026-06-14)

Prerelease (`next`). Diagnosis-driven bot reliability: a controlled experiment
falsified the long-standing "it's the IP" story for the OAuth-callback failures,
and instrumentation found the real, fixable causes. Several services that read
as anti-bot blocks are now servable (cartesia signs up end-to-end, api_key
extracted live).

- fix(bot): managed Turnstile post-submit no longer false-`captcha_blocked` — a Clerk/managed Turnstile resolves server-side, so on a post-submit timeout WITH an inbox the bot proceeds to email verification and lets the inbox poll arbitrate (a code = the submit went through). Cracked cartesia (api_key extracted).
- fix(bot): sticky email-path commit after a login-only OAuth — once Google OAuth is found login-only (Clerk `form_identifier_not_found`), the dispatch loop stops re-clicking Google and stays on email.
- fix(bot): correct `oauth_session_not_persisted` message + env-gated OAuth network/cookie instrumentation — IP falsified via a direct-vs-residential proxy matrix; cause is the Clerk sign-in-vs-sign-up flow, not egress.
- fix(bot): Clerk OAuth callback waits for the session via cookies before navigating away (helps Clerk services that auto-transfer).
- feat(bot): classify closed/invite-only registration as `signups_closed` (dequeue, not a misleading `oauth_onboarding_failed`); turbopuffer dequeued.
- fix(bot): don't mislabel an email-verification timeout as `onboarding_blocked` (tested pure helper `isOnboardingReviewGate`).
- fix(bot): click the real in-page API-keys link before guessing a URL; compose key-path guesses onto the app origin, not the auth/IdP subdomain.
- feat(bot): account-review / waiting-room gate → `onboarding_blocked`; ci: production build job (catches build-order / dep-skew on PR).
- refactor: relocate mcp-only probe-demotion symbols out of `skill-schema` (kills the published-dep-skew for those symbols).

## 0.9.16 (2026-06-13)

Stable release. Promotes the staging post-OAuth navigation work to `latest`,
plus the egress + CI increments already cherry-picked onto `main`.

- fix(oauth): generalize the multi-account chooser across account count — replay walks the Google account-chooser as a dynamic interstitial and picks the card matching the intended account (no longer assumes a single-account flow)
- fix(fresh-verify): fail fast on `oauth_onboarding_failed` — a deterministic post-OAuth wizard wall short-circuits instead of burning the retry budget
- fix(bot): post-verify planner skips optional setup wizards and beelines to the API key (no more stalling on "invite your team" / "name your project" interstitials)
- fix(egress): decompress upstream gzip/br/deflate bodies + make grant limits opt-in (already on `main` via cherry-pick; listed for completeness)
- ci(api): deploy the API to Fly on release to close the client/server skew (already on `main` via cherry-pick; listed for completeness)

## 0.9.15 (2026-06-13)

**HOTFIX: 0.9.14 could not start the MCP server.** 0.9.14 pinned
`@trusty-squire/skill-schema@0.1.2-rc.2`, but that published version predates the
`replay-graph` module — so the `validateReplayGraph` import on the server's eager
boot path (`server.js → tools/index.js → provision-any.js → promote-to-skill.js`)
threw a missing-export error and the server died on launch. CI missed it because the
monorepo resolves skill-schema via `workspace:*` (source has the module); only the
npm-published pin was stale. Fix: republish `@trusty-squire/skill-schema@0.1.2`
(stable, with `replay-graph`) and pin it here. Also folds in the staging work since
0.9.14:

- fix(skill-schema): publish 0.1.2 with the replay-graph module (validateReplayGraph) — unbreaks server boot
- fix(oauth): generalize skills across account count — replay walks the Google account-chooser as a dynamic interstitial; bot picks the card matching the intended account
- fix(fresh-verify): fail fast on oauth_onboarding_failed (deterministic post-OAuth wizard wall)
- chore(egress): direct-first — datacenter IP clears 23/24 anti-bot doors; residential proxy retired as the default

## 0.9.14 (2026-06-13)

Stable promotion of 0.9.14-rc.1 + rc.2. Two headlines: **Cloudflare Turnstile is
beaten** (self-launch Chrome + `connectOverCDP` — the wall was Playwright's
`launchPersistentContext`, not IP/GPU/fingerprint), and **fresh-verify no longer
loses skills to per-run variance** (transient OAuth-callback flakes retry toward
the 2-of-N bar; deterministic walls short-circuit — rescued 4/5 held OAuth services
live). Plus a session of discovery-bot hardening, an explicit cross-process signup
queue, replay fixes, and two Egress Grant increments (Prisma persistence + non-bearer
`auth_shape`). Full per-commit notes under the rc.1 / rc.2 sections below.

## 0.9.14-rc.2 (2026-06-13)

**Headline: fresh-verify no longer loses skills to per-run variance.** A sweep held
5 of 12 OAuth services at exactly 1/2 agreement — one robot passed, one flaked on a
non-deterministic OAuth-callback failure. fresh-verify now retries TRANSIENT flakes
with extra identities toward the 2-of-N bar while short-circuiting deterministic
walls, so a reproducible recipe promotes instead of stalling (proven: clarifai
1/2-hold → 2/2 PROMOTE across 3 attempts). Plus two Egress Grant increments:
grants survive an API redeploy, and non-bearer providers work end to end.

- feat(fresh-verify): retry transient flakes toward agreement, short-circuit hard walls (`retryBudget`, default 2 in the runner; `--retry-budget=` override)
- feat(egress): Prisma-persist egress grants — new EgressGrant table + store, wired through the deps layer (survives API redeploy)
- feat(egress): store_credential sets auth_shape (`bearer | header:<name> | query:<param>`) so an egress grant injects non-bearer keys with no per-service code

## 0.9.14-rc.1 (2026-06-13)

**Headline: Cloudflare Turnstile is beaten.** The Turnstile wall (exa, cartesia,
render-cron, replit, runpod, turso) was never the IP, GPU, or fingerprint — it was
Playwright's `launchPersistentContext`. The bot now self-launches the Chrome binary
(no `--enable-automation`) and attaches via `connectOverCDP`; Turnstile treats it as
a real browser (proven end-to-end: exa issues a token). Gated `BOT_SELF_LAUNCH`
(default-on). Plus a session's worth of discovery-bot hardening, a 2Captcha
Turnstile escalation, an explicit cross-process signup queue, and replay fixes.

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
(docs/ARCHITECTURE.md).

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
