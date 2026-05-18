# TODOS

## Deploy follow-ups (from the 2026-05-15 eng review + security fix)

These must be done on/before the next deploy of `trusty-squire-api`.

- [x] **~~Set webhook signing secrets~~ — moot.** The Mailgun, Resend,
  postfix, and fly-email inbound webhook routes were removed; SES is the
  sole inbound-mail path and verifies the SNS cert (no secret needed).

- [x] **Run the inbox migration. — done.** Both inbox migrations
  (`inbox_init`, `alias_issued_to`) applied to the `trustysquire_inbox`
  database. The API schema was pushed to `trustysquire`. Both DBs live on
  the `trusty-squire-db` cluster; `INBOX_DATABASE_URL` + `AUTH_DATABASE_URL`
  are set on `trusty-squire-api`.

- [ ] **Set `VOUCHFLOW_READ_KEY` on `trusty-squire-api`** (lower urgency).
  `config/vouchflow.ts` no longer hardcodes the server-side read key; it
  reads `VOUCHFLOW_READ_KEY` from env (undefined until set). Not consumed by
  any code path yet, so it can wait until the revocation/introspection
  features land — but set it with the rotated key when those arrive.

> Larger queued engineering work (T2 Tier-1 Prisma persistence, T3 spend
> tracking, T4–T10) lives in the design doc and
> `~/.gstack/projects/Trusty-Squire-trusty-squire/tasks-eng-review-*.jsonl`.

## npm distribution

- [x] **Publish `@trusty-squire/mcp` + `@trusty-squire/universal-bot` to npm.**
  Both live on the public registry. `universal-bot` at `0.1.0`, `mcp` at
  `0.1.3`.
- [x] **Fix the broken `npx @trusty-squire/mcp install` entry point.**
  Two compounding bugs, both fixed and verified end-to-end against the live
  registry:
  - `0.1.0`/`0.1.1` shipped two bins, neither matching the unscoped package
    name, so npx couldn't resolve an executable. `0.1.2` adds an `mcp` bin.
  - `cli.ts`'s entrypoint guard compared `import.meta.url` to a raw
    `file://${process.argv[1]}`; launched via a bin shim, `argv[1]` is the
    symlink path, so `main()` silently never ran. `0.1.3` resolves the
    symlink with `realpathSync` before comparing.
  Both the documented `npx @trusty-squire/mcp install` and
  `scripts/install.sh` now work. See the npm distribution notes in `CLAUDE.md`.

## S1 — Residential proxy support for the universal-bot

- [x] **S1 = Residential proxy support for the universal-bot. — shipped.**
  The single biggest lever against the captcha problem when the bot can't run
  on a residential network (Codespaces, Replit, Hetzner CI/test boxes,
  corporate networks).

The shape converged on across two conversations:

| Aspect | Decision |
|--------|----------|
| **What it is** | Route Playwright egress through a residential proxy (Bright Data / IPRoyal / PacketStream) when the user's egress network is datacenter-class. |
| **Why it matters** | reCAPTCHA v2/v3 score datacenter IPs as bot-likely. A residential proxy removes the *IP* signal — but **not** the whole challenge: v3 also scores fingerprint + behavior. Early signal looked promising (same code passed on a residential Mac, blocked on datacenter Hetzner) — but see the 2026-05-16 empirical result below: a confirmed residential-proxied run was still blocked. |
| **Why deferred** | Pre-PMF, ~20% of users hit the problem, and there was no telemetry yet to justify ongoing proxy cost. Build the leading indicator first (bot-run telemetry — shipped ✅), then decide. |
| **Implementation effort** | ~half a day. Single change to `BrowserController.start()` to accept `proxy: { server, username, password }` via env vars. Gated so the ~80% of residential users pay zero proxy cost; only datacenter-detected sessions route through the proxy. |
| **Cost** | $0.05–$0.10 per signup via PacketStream or IPRoyal pay-as-you-go. Bright Data has a $5 one-time signup credit (~100–600 signups) for free initial validation. |

**Shipped.** `BrowserController.start()` reads `UNIVERSAL_BOT_PROXY_URL`
(`http://user:pass@host:port` or `socks5://host:port`) and routes egress
through it — gated by `shouldRouteThroughProxy()` so only datacenter-class
sessions use the proxy; residential/unknown stay direct at zero cost.
`UNIVERSAL_BOT_PROXY_ALWAYS=true` overrides the gate. Vendor-agnostic: any
proxy works, switching is one env var. Tests in `proxy.test.ts`.

**Vendor strategy (operational — not in code):**
1. **Validate** with Bright Data's $5 free credit — set `UNIVERSAL_BOT_PROXY_URL`
   to the Bright Data endpoint, run a Resend signup from the Hetzner box, confirm
   captcha blocked → passes. Zero cost.
2. **Production** on IPRoyal Royal Residential (pay-as-you-go, non-expiring
   balance) — cleaner pool than PacketStream's P2P network for a few cents more
   per signup, and the non-expiring balance fits sporadic low-volume use. Swap
   the env var; no code change.

**Proxy-usage telemetry — shipped 2026-05-16.** A `proxied` boolean
now threads from `BrowserController.proxied` → `SignupResult.proxied`
→ the `/v1/captcha-events` POST → `CaptchaEvent.proxied` (nullable;
`null` = pre-0.1.8 client that didn't report it, distinct from
`false` = ran direct). "Did the proxy actually run when this captcha
fired?" is answerable from a single SQL query. Schema pushed to
`trustysquire`, API deployed, route smoke-tested end-to-end. Tests in
`apps/api/src/__tests__/captcha-events.test.ts`.

**Empirical result — 2026-05-16: a residential IP alone does NOT
defeat reCAPTCHA.** With `@trusty-squire/mcp@0.1.8` (proxied
telemetry) and `UNIVERSAL_BOT_PROXY_ALWAYS=true`, a Postmark signup
ran with browser egress confirmed through a residential proxy
(SK Broadband AS9318, Seoul). The `CaptchaEvent` row:
`proxied=true, blocked=true` — Postmark's reCAPTCHA flagged the
session anyway. The proxy removes the IP signal; the automation
fingerprint + behavior signals remain enough to score the session
as a bot. (Contrast: Mailgun *passed* reCAPTCHA from the same
machine — it was never purely about the IP.) **Conclusion:** the
residential proxy is a marginal-case lever, not a captcha-defeat
mechanism. Postmark-class signups are a hard block on the Tier 0
browser path — the honest outcome is `captcha_blocked` + a
manual-signup CTA, which `provision_any_service` already returns.

## S2 — Universal-bot: ambiguous submit selector + 5-minute false hang

Diagnosed 2026-05-16 from a real Resend signup run. **Fixed** — see the
S2.1/S2.2/S2.3 checklist below.

**Symptom.** A `provision_any_service` Resend signup appeared to hang for
~5 minutes, then failed with the generic `Could not find credentials on
page or via email`. The real cause was buried in the step trail.

**Root cause.** Resend's signup page renders **three `button[type="submit"]`**
elements — "Continue with Google", "Continue with GitHub", and "Create
account" (the OAuth buttons are also submit-typed). The Claude planner
emits one `submit_selector`; when it isn't specific enough it matches all
three. `BrowserController.click()` → `humanClick()` calls
`page.locator(selector).boundingBox()`, and a Playwright **locator is
strict-mode** — resolving to >1 element throws
`strict mode violation: locator resolved to 3 elements`.

**Why it became a 5-minute "hang" instead of a clean failure** — two
amplifiers in `agent.ts`:
1. The submit is wrapped in `try/catch` (`agent.ts:751`) that only does
   `steps.push("⚠ submit click failed: …")` and **continues as if the
   form submitted**.
2. With no credentials on the (unsubmitted) page, `signup()` enters the
   verification-email poll — `verificationTimeoutSeconds ?? 300` — and
   waits the full 5 minutes for an email that can never arrive because
   the form was never submitted. The final error is generic; the real
   cause (`⚠ submit click failed`) is only visible in `steps[]`.

**Fixes:**

- [x] **S2.1 — Disambiguate the submit button. — done.**
  `BrowserController.clickSubmit()` (new) resolves the planned selector;
  when it matches >1 element it scores the candidates' visible text via
  `pickSubmitButtonIndex()` (new, exported from `browser.ts`, mirrors
  `pickVerificationLink`) and clicks the winner. Positive for
  `create account` / `sign up` / `register` / `get started` / `continue`;
  strongly negative for OAuth provider names (`google`, `github`, …) and
  `sign in` / `log in`. OAuth-only pages (all candidates negative) throw
  a clear error rather than mis-clicking an OAuth flow.

- [x] **S2.2 — Fail fast when submit fails. — done.** Both submit sites
  in `agent.ts` now use `clickSubmit()`; a throw returns
  `error: "submit_failed: <reason>"` immediately with the step trail,
  instead of falling through into the 5-minute verification-email poll.
  (The "submission can't be confirmed — URL unchanged" refinement was
  not implemented — it risks false positives on SPA signups that don't
  change URL. The throw-based fail-fast fully covers the observed bug.)

- [x] **S2.3 — Surface the real cause. — covered by S2.2.** The failed
  run now returns `submit_failed: …` as its top-level `error`, not the
  generic `Could not find credentials…`.

Regression tests: `pick-submit-button.test.ts` (8 cases incl. the exact
Resend three-button case) and `submit-failure.test.ts` (full `signup()`
with a fake browser — asserts `submit_failed` and that the verification
poll is never entered). universal-bot 65 tests + mcp 36 tests pass.

> Not shipped: feeding the planner the candidate button texts so it
> emits a precise selector up front. The executor-side `clickSubmit()`
> disambiguation makes this a marginal optimization, not a fix — left
> for later if planner-emitted selectors prove noisy in telemetry.

## S3 — provision_any_service: detect withheld verification, don't blind-wait

Diagnosed 2026-05-16. **Not yet implemented.**

When a signup submits successfully but the service withholds the
verification email (anti-abuse — observed with Resend: form submitted,
account scored as automated, no verification mail ever dispatched), the
bot enters the 300s verification-email poll and reports a generic
timeout. Indistinguishable from a real "email is just slow" case.

Root cause is not Squire's: the SES inbound pipeline is verified working
(send → S3 → SNS → /v1/webhooks/ses → ReceivedEmail confirmed
end-to-end 2026-05-16). The service simply never sends the mail.

**Fix:** after submit, read the post-submit page state before entering
the email poll. Distinguish:
- "check your email" / "verify your inbox" copy visible → poll as today.
- an error, a captcha re-challenge, or the signup form still present →
  return `verification_not_sent` (or `signup_rejected`) immediately with
  the page text, instead of a blind 5-minute wait.
The Claude planner already screenshots the page; one classification
call (or a keyword scan of the visible text) covers it. Lives in
`agent.ts` between the submit and the `waitForVerificationEmail` call.

## A1 — Consolidate the provision / provision_any_service packages

Raised by the user 2026-05-16. **Part 1 (the package merge) shipped in
`@trusty-squire/mcp@0.1.7`. Part 2 (the feedback loop) still open.**

Native adapters live in `packages/adapters/*` + `apps/registry-api`.
Two reasons drove the consolidation:

1. **[x] DONE — two published npm packages caused dependency skew.**
   `@trusty-squire/mcp` pinned `@trusty-squire/universal-bot`; S1/S2
   shipped to git but `universal-bot` wasn't republished, so every `npx`
   user ran the stale bot through five "fixed but still broken" cycles.
   Fixed in `0.1.7`: the bot's source moved into `apps/mcp/src/bot/`,
   `universal-bot` is no longer a package or published. One package, one
   version — the version-skew bug class is gone.
2. **[ ] Closed feedback loop.** `provision_any_service` should be the
   *fallback* when no native adapter exists — and a successful universal
   signup should **codify a native adapter and register it** (same idea
   as the /skillify pattern: a proven flow becomes a permanent fast
   path). Bot, adapter format (`defineAdapter`), and registry
   (`registry-api`) under one roof closes that loop. The codebase
   already anticipates this — `adapters/resend/manifest.ts` says it's a
   placeholder "until the browser tier ... rewritten against the real
   flow."

**Tradeoff to resolve in the review:** `universal-bot` pulls Playwright
(browser binaries, heavy); native adapters are light. One package means
every install pays the Playwright cost. Options: keep one package with
Playwright as an `optionalDependency` / lazy-installed; or one repo,
two thin published entrypoints. The pain is the *npm package boundary*,
not the code organization — consolidate the published surface.

**A1 hard constraint — Tier 0 zero-friction must survive.** Any
consolidation must keep: `install` issues an anonymous machine token
with no account/pairing; `provision_any_service` runs on a
machine-token-only session; 10 free signups (`MACHINE_TOKEN_QUOTA`)
before any pairing CTA. **[x] Locked** by
`apps/mcp/src/__tests__/tier0.test.ts` — verified through the 0.1.7
merge: `install` does not pair by default, and the Tier-0 server
exposes `provision_any_service` while gating account-scoped tools.

## T3 — Tier 3 captcha handling

Planned + reviewed 2026-05-16 (`/plan-eng-review`). Full plan:
`~/.gstack/projects/Trusty-Squire-trusty-squire/chode-main-tier3-captcha-plan-20260516.md`.

**Reframe:** reCAPTCHA v2/hCaptcha present a solvable *challenge*;
reCAPTCHA v3/Turnstile produce only a *score* — nothing to solve.
Postmark is v3.

- [x] **T3.1 — Geo/fingerprint fix. — shipped in `@trusty-squire/mcp@0.1.10`.**
  `BrowserController.probeEgressGeo()` loads ipinfo.io through a
  throwaway context (inherits the launch-level proxy, so it reports the
  *proxy exit* geo), and `start()` sets the context `timezoneId` +
  `geolocation` to match. `locale` stays `en-US` deliberately (matching
  it would render signup pages in the proxy country's language and
  break the form planner). Best-effort: a probe failure falls back to
  the prior hardcoded default. `parseEgressGeo()` unit-tested
  (`geo.test.ts`, 9 cases). Re-measure Postmark on 0.1.10 — though the
  v3 reframe says this likely re-measures a near-certain negative.
- [x] **T3.2 — Spike telemetry. — shipped `@trusty-squire/mcp@0.1.9`.**
  `CaptchaEvent` gained `captcha_variant`, `challenge_rendered`,
  `signup_succeeded`; `BrowserController.detectCaptchaVariant()` does
  the classification. Same nullable pattern as `proxied`.
- [x] **T3.3 — The spike. — done 2026-05-16 (designed sweep, not the
  2-week passive wait).** 16 fresh dev-SaaS signups via
  `provision_any_service`. Result: **0/16 succeeded.** Captcha was a
  *minority* blocker — 3 encounters, 2 blocked. The bot fails *upstream
  of captcha* on form mechanics. Inbox pipeline exonerated (Neon's
  verification email round-tripped fine end to end). Full diagnosis +
  per-service failure map → the F-workstream below. Sweep file:
  `~/.gstack/projects/Trusty-Squire-trusty-squire/chode-main-t33-spike-sweep-20260516.md`.
- [ ] **T3.4 — Module A v1: reCAPTCHA v2 static-grid solver. —
  DEFERRED.** The T3.3 spike says captcha is not the bottleneck:
  captcha blocked 2/16, form-interaction bugs blocked 13/16. A solver
  now fixes 2 runs while 13 stay broken. Mildly *for* it: Mailtrap +
  Mailjet both rendered real reCAPTCHA image grids
  (`challenge_rendered=true`) — so it would have targets. But it is
  gated behind a working form layer (the F-workstream). Design when
  resumed: extends `solveVisibleCaptcha()`; dedicated ~6-call LLM
  sub-budget; `solveGrid()` on `llm-client.ts`; fail-fast ladder;
  fast-model default; ~20-30 grid eval; checkbox-path regression test.

**Deferred (data-gated, do not start):** Module A dynamic-refill grids,
hCaptcha, audio/Whisper fallback. Validate need from spike data first.

**Cut:** Module B — reCAPTCHA v3 anti-detection (patched Chromium,
fingerprint hardening). An open-ended anti-detection treadmill with no
completion state. Postmark and other v3 services stay `captcha_blocked`
+ manual-signup CTA. Reopen only if v3-service coverage becomes a
funded, ongoing commitment.

## F — Form-interaction reliability

The T3.3 spike (16 fresh services, 2026-05-16) signed up **0/16**.
Step-trail diagnosis: the bot fails upstream of captcha on basic form
mechanics. Ranked by leverage.

- [x] **F1 — Planner render-wait. — shipped `0.1.11`.** The planner
  screenshotted before SPA / two-stage pages rendered, then emitted
  plausible-but-fake selectors (every action timed out — Axiom,
  Back4app, Netlify, Together). `BrowserController.waitForFormReady()`
  now gates the planner on networkidle + a visible form control.
- [x] **F2 — Top-level `signup()` timeout. — shipped `0.1.11`.** 5 runs
  hung >50min; sub-steps are bounded but a stall outside them wedges
  the run. `signup()` now races a hard deadline
  (`UNIVERSAL_BOT_RUN_TIMEOUT_MS`, default 600s) and returns
  `run_timeout` instead of hanging. Test: `run-timeout.test.ts`.
- [x] **F3 — Planner/executor reliability rework. — shipped in
  `@trusty-squire/mcp@0.1.12`.** [P1] Reviewed + implemented
  2026-05-16 (`/plan-eng-review`, 8 tasks T1-T8). Confirmed by the
  re-sweep (0/14):
  the planner guesses CSS selectors off a screenshot — it is fed a
  `<form>`-regex scrape that returns marketing chrome on `<form>`-less
  SPA pages — and the executor runs the plan blind. Fix: a DOM-grounded
  element inventory the planner *picks* from (never invents a
  selector), parse-time inventory validation, a unified
  verify-and-replan loop with split error/progress caps, and
  element-type-aware execution. **Subsumes the former F4 (checkbox),
  F5 `<select>`, F6 (cookie-consent), and two-stage signup forms.**
  Full reviewed plan:
  `~/.gstack/projects/Trusty-Squire-trusty-squire/chode-main-planner-reliability-plan-20260516.md`.
- [ ] **F7 — Multi-step / inline-code flows. [P2]** Mistral (email-first
  multi-step), DeepSeek (inline verification code typed into the page).
  The bot assumes single-page → submit → email-link.
- [ ] **F8 — Verification-link extraction. [P2]** Neon: the email
  arrived but "had no usable verification link." HTML-email /
  button-link parsing.
- [ ] **F9 — Search fallback. [P2]** Validic: no URL given → the bot
  landed on Google's results page and tried to solve Google's captcha.
  Fix or remove the search-for-signup-URL path.

Also observed: 3/16 (Appwrite, MongoDB Atlas, Koyeb) submitted cleanly
and got no verification email — genuine S3 anti-abuse withholding,
confirming S3 is real and common.

**Process:** F1 + F2 shipped. Re-sweep ran (0/14 — confirmed the
planner/executor diagnosis). F3 planned + reviewed. Next: implement
F3, then re-sweep again (honest target ~8/14 — the rest are captcha /
multi-step / withholding, out of F3's scope).

## G — OAuth-gated services: managed identity + conversion loop

Raised 2026-05-16 (planner/executor `/plan-eng-review`, Issue 4).
**Product/strategy item — belongs in `/plan-ceo-review`, not eng.**

Many SaaS make "Sign up with Google/GitHub" the only signup path. The
Tier 0 anonymous bot cannot do those — no identity, and it cannot
drive Google's login (harder than the captcha problem).

- [x] **G1 — Managed identity for OAuth signup. — SHIPPED.**
  OAuth-first signup shipped as `@trusty-squire/mcp@0.2.0` (Phase 1
  T1–T14 + the GitHub provider T13). The bot rides a Google/GitHub
  session in a persistent Chrome profile through a service's consent
  screen — clicking the affordance, scope-gating the consent, driving
  the post-OAuth onboarding to the API key. Plan:
  `ceo-plans/2026-05-17-oauth-first-signup.md`.
- [ ] **G2 — API-side identity model (Tier 0 → Tier 1 funnel).** The
  OAuth-first *signup path* shipped (G1); what remains of G2 is the
  API side — replace the anonymous machine token with the OAuth
  identity, build the identified conversion funnel. Deferred per the
  plan ("API-side identity model, B phase 2 — a fast-follow, not a
  blocker").

### Post-build follow-ups (2026-05-18)

From the OAuth-first verification sweep — see the plan's "Post-Build
Findings (2026-05-18)" section.

- [ ] **G3 — Publish `0.2.1`.** Every fix since `0.2.0` — post-OAuth
  onboarding hardening (scroll-into-view, the `select` step,
  navigation-resilience, re-plan-on-rejection, async SSO re-extract),
  `findOAuthButton` icon/href detection, and the extraction fixes
  (`pk_`/`phc_` dropped, `re_` charset, the label-separator guard) —
  is committed and unpublished. `rm -rf dist` before packing so no
  dev-harness artifact leaks into the tarball.
- [ ] **G4 — Capture pass for the 8 handshake-needed services**
  (Plunk, Hunter, IPInfo, PostHog, Koyeb, Netlify, SendPulse,
  Back4App). **BLOCKED** — G7 measured that the OAuth handshake is
  challenge-gated from this headless datacenter box for any account.
  Of the 8: SendPulse's handshake completed but its API key is
  paywalled (`onboarding_blocked`); the other 7 were all challenged.
  Unblocking needs the handshakes done from a residential IP + a
  headed browser (a developer's own machine), once per service, to
  capture the post-OAuth state — then G5.
- [ ] **G5 — Curate the raw onboarding captures into the E1 eval
  corpus.** 34 raw round-captures sit in
  `apps/mcp/.onboarding-corpus-raw/` (Sentry, Mistral, Resend) shaped
  as `OnboardingEvalCase` minus `expect`. Add the `expect` labels,
  trim to distinct states, commit as the corpus `eval-onboarding.ts`
  loads via `ONBOARDING_EVAL_CORPUS`.
- [ ] **G6 — `postVerifyLoop` needs a `check` step.** It has `select`
  but no `check`; Mistral's custom TOS "checkbox" (not a plain
  `<input>`) stalls the onboarding loop. Mirror the form planner's
  `browser.check` (force + scrollIntoView + verify).
- [x] **G7 — Measure the Google anti-abuse threshold. — done
  2026-05-18.** Two batches: an aged account (`lunchboxfortwo`) got
  exactly **1** clean handshake then challenged; a fresh dev account
  (`methoxine`) was challenged on **8 of 9**, including run #1. A
  fresh account is treated as MORE suspicious — no history + headless
  + datacenter IP = "verify it's you" on the first OAuth. **The
  dev-account-pool idea is dead** — fresh accounts add no headroom.
  Reliable handshakes need an aged account on a residential IP at low
  volume (the production case). The dev escape is NOT more handshakes
  — it is capturing each service's post-OAuth state once (from a
  residential/headed environment) and iterating onboarding offline
  (G5). See the plan's Post-Build Findings.
- [ ] **G8 — `mcp login --provider=github`.** The persistent profile
  is logged into Google only. The 8 of 11 reachable services that
  also expose GitHub OAuth need a one-time GitHub login first.
- [x] **G9 — Re-probe the affordance probe's inconclusive services.
  — done.** Brevo (corrected URL) loaded fully — **no OAuth**
  affordance (email-only; joins Postmark/Mailgun/DeepSeek). Loops,
  MailerSend, Axiom still render only 2–3 elements for the headless
  throwaway-profile probe even with 18s of waits — a headless-render
  problem, not an OAuth question; resolving them needs a headed
  probe. Coverage holds at 11/18 OAuth-first-reachable.
- [x] **G10 — DeepSeek offers no Google OAuth. — confirmed, note
  only.** No affordance, no GIS iframe, zero OAuth references in the
  DOM at `/sign_up` or `/sign_in`. OAuth-first is N/A for DeepSeek;
  form-fill is its only (walled) path.
- [ ] **G11 — Explore improving the headless-login VNC tool UX.** The
  one-time `mcp login` on a display-less box bridges Chrome out via
  Xvfb + x11vnc + noVNC + cloudflared (`google-login.ts`). noVNC's
  client UI is dated; KasmVNC is a more modern drop-in (modern
  client, built-in clipboard sync) — it replaces the VNC *server*
  layer, a contained one-time packaging change. Evaluate the swap:
  this is a human-facing one-shot login screen, so its UX is the
  product there.

## H — Concurrency: the bot is single-flight

Raised 2026-05-16. `provision_any_service` has no concurrency story —
it is safe only run serially (the sweeps were). One concrete race was
fixed; the rest is deferred.

- [x] **H0 — `run_id` collision. — fixed in `0.1.13`.** `runId` was
  `mcp-${Date.now().toString(36)}` — a bare millisecond timestamp.
  Two concurrent signups for the same service in the same ms got the
  same `run_id` → the same inbox alias → cross-read each other's
  verification email. `provision-any.ts` now appends a `randomBytes`
  suffix.
- [ ] **H1 — Concurrent signups correlate on one exit IP.** Every
  concurrent run egresses the *same* residential proxy IP at the same
  instant; two account creations from one IP in one second is a far
  stronger anti-bot signal than serial runs. Concurrency through a
  single proxy silently lowers per-signup success. Real concurrency
  needs per-run distinct exits — a residential proxy pool (the S1
  vendor path), not one Tailscale Mac.
- [ ] **H2 — Single proxy = SPOF + capacity.** One `ssh -D` tunnel,
  one Mac: it saturates or the Mac sleeps → all in-flight runs fail
  together. `ssh -D` has connection limits.
- [ ] **H3 — Latent check-then-act races concurrency would expose.**
  `recordPrewarmSuccess` writes a shared prewarm-cache file
  (concurrent writes corrupt it); `MACHINE_TOKEN_QUOTA` and the LLM
  rate-limit counter are both check-then-act (concurrent runs can slip
  past the cap). Fix when concurrency becomes real.
