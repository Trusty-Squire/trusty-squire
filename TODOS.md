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

Diagnosed 2026-05-16. **Done — 2026-05-18 (with M2).** Two parts:
(1) the post-submit page-state detection (`expectsVerificationEmail` +
a short 45s probe when the page never says "check your email") shipped
earlier; (2) the no-inbox fast-fail shipped 2026-05-18 with M2 — see
below.

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
  Fix or remove the search-for-signup-URL path. **Partially addressed
  2026-05-20 in `@trusty-squire/mcp@0.5.9`:** `guessSignupUrl(service)`
  now navigates to `https://<slug>.com/signup` first; the Google-search
  + `findSignupLink` path is the fallback only when the guess doesn't
  look like a signup page. Validic-class long-tail services still hit
  the fallback and the brittle regex; full fix is to either codify a
  known-services map or teach `findSignupLink` to click CTAs.

- [x] **F10 — Capture API keys hidden behind a Copy button. [P1]
  — shipped 0.6.0-rc.1 → -rc.4.** Three-pass extraction:
  visible scan → Copy-button + clipboard recovery → hidden-input
  fallback. Plus a `api_key_truncated` last-resort persistence so
  the host agent can surface a partial. New prefix recognitions for
  `sk-or-v1-` / `sk-ant-` / `sk-proj-` / `sk-<48>`. Validated live
  on an OpenRouter signup 2026-05-20: full key landed in vault.

- [ ] **F11 — Custom React combobox / Radix dropdown support. [P1]**
  Surfaced 2026-05-20 by a Sentry signup. The bot navigated through
  the OAuth handshake, reached the auth-tokens settings page, started
  creating a token, and got stuck on the permissions dropdown.
  Sentry uses a Radix-style combobox (a `<button role="combobox">`
  that opens a `[role="listbox"]` with `[role="option"]` children),
  not a native `<select>`. The bot's `select` executor only knows
  Playwright's `selectOption()` which requires a real `<select>`
  parent of `<option>` children — it threw "no selectable option"
  on 9 consecutive replans and gave up before clicking "Create."

  Increasingly common pattern — Radix UI, Headless UI, React Aria,
  cmdk, every modern React component library does this. Native
  `<select>` is rare on new dashboards.

  Fix path: in `BrowserController.selectOption()`, check the target
  element's tag. If `<select>`, existing native path. Otherwise treat
  as a combobox: click the trigger, wait for `[role="option"]` to
  appear (canonical ARIA — Radix, Headless UI, React Aria all emit
  it), click the chosen option. Choice: when the planner specifies
  an option text (new optional `option_text` field on the select
  step), match by text; otherwise pick the first option.

  Realistic scope: half-day. Two pieces — combobox detection +
  click-find-click helper in browser.ts; optional `option_text`
  field on PostVerifyStep + main signup-plan `select` action.

  Caveat once shipped: "first option" may not be the right choice
  for Sentry's permissions dropdown (the user probably wants
  Project: Read or similar — not whatever Sentry orders first).
  Adding the `option_text` field lets the planner request the
  specific option; without it, the bot makes a token but possibly
  with surprising permissions. The user can adjust manually.

- [ ] **F12 — User-relayed SMS verification. [P1]** Surfaced 2026-05-20
  by a Vercel signup. The bot signed in via Google OAuth as
  `lunchboxfortwo@gmail.com`, landed in Vercel's onboarding, and hit a
  phone-number entry + SMS-code wall — common on Vercel, Twilio, AWS,
  Stripe-on-Stripe, etc. New-account anti-fraud, gates the API token.

  Twilio/Plivo/Vonage numbers don't help — every major SMS gate runs a
  carrier lookup (Twilio Lookup, NumVerify) and rejects VoIP. The
  numbers that pass are real consumer SIMs from a mobile carrier;
  provisioning those programmatically is the opposite of cheap, and
  re-using one across users gets it shadow-banned in days.

  Fix path: don't try to be SMS infrastructure. Add a relay loop:

  1. Bot detects phone-entry → returns `status="phone_verification_required"`
     with `phone_entry_url` (noVNC if headless) and a `run_id`.
  2. The MCP tool description tells the host LLM: "ask the user for
     their phone number, then call `provide_phone_number` with it."
  3. New MCP tool `provide_phone_number(run_id, phone)` types the phone
     into the signup form via the existing bot session and clicks send.
  4. Bot waits for the SMS-code field to appear → returns
     `status="phone_code_required"`.
  5. The user gets the SMS on their real phone, reads it back to Goose.
  6. New MCP tool `provide_sms_code(run_id, code)` types the code into
     the field and clicks verify; bot continues to the API key.

  Half-day to build. SMS-gated services go from "manual signup" to
  "two-step tap on your phone." Doesn't touch the security boundary:
  the user's phone is the gate, and the bot just relays.

Also observed: 3/16 (Appwrite, MongoDB Atlas, Koyeb) submitted cleanly
and got no verification email — genuine S3 anti-abuse withholding,
confirming S3 is real and common.

**Process:** F1 + F2 shipped. Re-sweep ran (0/14 — confirmed the
planner/executor diagnosis). F3 planned + reviewed. Next: implement
F3, then re-sweep again (honest target ~8/14 — the rest are captcha /
multi-step / withholding, out of F3's scope).

- [x] **F13 — Headed signups on a headless box (on-demand Xvfb). [P1]
  — shipped 0.6.0-rc.16.**
  Surfaced 2026-05-20 by a Cloudflare signup. The bot landed on
  `dash.cloudflare.com/sign-up` correctly (rc.14's known-domains fix),
  but Cloudflare's React signup gates the OAuth buttons + email form
  behind JS that doesn't render under Chromium-headless. The bot's
  `BrowserController.start()` uses `headless: true` by default — only
  `mcp login` runs against Xvfb + headed Chrome.

  Increasing fraction of modern SaaS does this. Stytch, Clerk, Auth0,
  WorkOS-fronted signups all do heavy JS-detection that catches
  `navigator.webdriver`, missing window.chrome, etc. Stealth plugin
  helps but not always.

  Fix: have the signup rig spin up a temporary Xvfb on demand when
  the host has no display, exactly like `runHeadlessChrome` does for
  login — minus the noVNC/cloudflared stack the user never needs to
  SEE (signups don't need a viewer; only login does). One Xvfb per
  signup run, torn down at the end. Or: one long-running Xvfb the
  MCP server owns, all signups attach.

  Realistic scope: half-day. Mostly factoring out the Xvfb startup
  helper from google-login.ts and calling it from BrowserController
  before `launchPersistentContext` when DISPLAY is unset.

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

- [x] **G3 — Publish `0.2.1`. — done 2026-05-18.** Every fix since
  `0.2.0` — post-OAuth onboarding hardening (scroll-into-view, the
  `select` step, navigation-resilience, re-plan-on-rejection, async
  SSO re-extract), `findOAuthButton` icon/href detection, the
  extraction fixes (`pk_`/`phc_` dropped, `re_` charset, the
  label-separator guard), plus G5 (eval corpus) and G6 (`check`
  step) — shipped as `@trusty-squire/mcp@0.2.1`. dist cleaned before
  packing; the `corpus/` dir is not in the tarball (143 KB packed,
  123 files). CLAUDE.md's published-version line updated.
- [ ] **G4 — Capture pass for the 8 handshake-needed services**
  (Plunk, Hunter, IPInfo, PostHog, Koyeb, Netlify, SendPulse,
  Back4App). **BLOCKED** — G7 measured that the OAuth handshake is
  challenge-gated from this headless datacenter box for any account.
  Of the 8: SendPulse's handshake completed but its API key is
  paywalled (`onboarding_blocked`); the other 7 were all challenged.
  Unblocking needs the handshakes done from a residential IP + a
  headed browser (a developer's own machine), once per service, to
  capture the post-OAuth state — then G5.
- [x] **G5 — Curate the raw onboarding captures into the E1 eval
  corpus. — done 2026-05-18.** 46 raw round-captures (Sentry,
  Mistral, Resend, SendPulse) trimmed to **14 distinct, labelled
  cases** under `apps/mcp/corpus/onboarding/`. Each keeps the full
  DOM inventory, drops the screenshot for a 1×1 placeholder, and
  reduces HTML to the visible text the planner consumes. Cases cover
  the T12 sequences: Resend dashboard→keys→modal→reveal→extract,
  Sentry issues→settings→tokens→create, Mistral's org-creation gate,
  SendPulse's 404 dead-end. `loadCorpus()` defaults to the committed
  dir; `ONBOARDING_EVAL_CORPUS` still overrides. A test asserts the
  corpus loads and every case is structurally scorable.
- [x] **G6 — `postVerifyLoop` `check` step. — done 2026-05-18.**
  Added `PostVerifyStep` `check`: `parsePostVerifyStep` parses it,
  the loop executes via `browser.check` (force + scrollIntoView +
  verify), the planner prompt documents it for a disabled-button TOS
  gate, and the parse callback rejects a `check` that targets a link
  instead of a real checkbox. **Caveat:** Mistral's specific TOS
  checkbox is a visually-hidden `<input>` that
  `extractInteractiveElements` filters out, so it never reaches the
  inventory — `check` cannot target what isn't surfaced. Surfacing
  hidden-but-checkable inputs is a separate browser.ts fix → G12.
- [ ] **G12 — Surface visually-hidden checkboxes in the inventory.**
  `extractInteractiveElements` drops `visible:false` elements, but a
  custom-styled TOS checkbox is a real `<input type=checkbox>` with
  `opacity:0`/`sr-only` behind a styled label. It is checkable and
  must reach the inventory so the G6 `check` step can target it
  (Mistral's org-creation gate). Include a hidden input when it is
  `type=checkbox`/`radio` and inside/adjacent a visible label.
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
- [x] **G11 — Explore improving the headless-login VNC tool UX. —
  done: folded into the G13 plan.** The /plan-ceo-review of
  2026-05-18 evaluated the KasmVNC swap and **rejected it** — KasmVNC
  replaces the VNC *server* and ships as a `.deb`/container an npm
  package can't bundle, failing on exactly the constrained boxes that
  need the flow. Chosen instead: a custom branded `vnc.html` served
  off the existing x11vnc + websockify + noVNC stack. See G13.
- [x] **G13 — Streamlined OAuth onboarding. — built 2026-05-18,
  awaiting publish.** Folded the one-time OAuth login into `install`
  (non-fatal final stage), reworked the headless login UX (custom
  branded `vnc.html` served from a temp dir holding the installed
  noVNC core — no new binary), dropped email+password+mandate from the
  advertised onboarding (free-only MVP; mandate-validator stays
  armed/fail-closed). Cherry-picks shipped: headed interstitial,
  `--provider` choice, closing nudge. 8 tasks T1-T8, 250 tests pass.
  On branch `streamlined-oauth-onboarding` (commit `0cd919a`) —
  CEO + eng reviewed. Plan:
  `~/.gstack/projects/Trusty-Squire-trusty-squire/ceo-plans/2026-05-18-streamlined-oauth-onboarding.md`.
  Next: `/ship` (bump version, publish).
- [ ] **G14 — Harden the headless-login VNC password handoff. [P3]**
  `loginHeadless` passes the VNC password to `x11vnc` as a plaintext
  `-passwd` argv argument, readable by any other local UID via `ps`.
  Pre-existing and narrow (x11vnc binds `-localhost` only, so it needs
  a co-resident attacker), but the streamlined-onboarding sprint's
  theme is hardening this path. Fix: write the password to a `0600`
  file in the rig's temp dir and use `x11vnc -passwdfile`. Surfaced by
  the /ship adversarial review 2026-05-18.

- [ ] **G15 — Short URL for the noVNC tunnel link. [P2]** Raised
  2026-05-20. The headless install prints a cloudflared tunnel URL
  like `https://shouts-clean-mediawiki-cookies.trycloudflare.com/
  vnc.html#password=25f4cc35` (~80 chars). On a phone the long
  random-words subdomain is unreadable; shortening to something like
  `trustysquire.ai/g/abc12#password=25f4cc35` would be ~40 chars and
  brand-anchored.

  **Implementation** (~3 hours):
  - API: `POST /v1/short` body `{url}` → `{slug}` with a 15-min TTL
    (matches the install token expiry — both die at the same time).
    `GET /g/:slug` → 302 to the long URL. In-memory store is fine
    given the short TTL.
  - CLI: after the cloudflared tunnel is up, call `POST /v1/short`,
    print the shortened URL in the noVNC banner instead of the
    cloudflared one.
  - Fly deploy of the API change.

  **Fragment handling note:** the VNC password rides in the URL
  fragment (`#password=…`), which never reaches a server, so it
  can't be stored on the shortener — the SLUG resolves only the
  long URL prefix. Modern browsers preserve the original fragment
  across an HTTP 302 redirect (when the redirect target has no
  fragment of its own), so the password reaches the bot's vnc.html
  unchanged. Worth a quick smoke check across Chrome / Safari /
  Firefox Mobile because behavior at the spec edge has historically
  varied.

  **Domain decision required:** the user spec'd "trusty.ai/xxx"
  but the actual project domain is trustysquire.ai. Options:
  (a) use `trustysquire.ai/g/<slug>` — works today, no new domain.
  (b) register `trusty.ai` (if available) and attach to the Fly
      web app — cleanest brand.
  (c) dedicated short domain like `ts.sh` — most flexible, extra
      registration step.

- [ ] **G16 — Dedicated Cloudflare named tunnel for noVNC. [P3]**
  Surfaced 2026-05-20. Today the headless install spawns
  `cloudflared tunnel --url <local>` which provisions a random
  `*.trycloudflare.com` subdomain on demand. Two costs: ~5-10s cold
  start to allocate the subdomain + start the tunnel pod, and an
  orphaned cloudflared instance is possible if teardown is racy.

  A named tunnel (`cloudflared tunnel run <name>`) with a hostname
  bound to `vnc.trustysquire.ai` (or similar) keeps the routing
  pre-allocated on Cloudflare's edge — startup is ~1s, teardown is
  clean disconnect. Free tier, no usage cost.

  Tradeoffs:
  (a) **Single shared hostname for all users** — simplest, but ALL
      noVNC traffic globally goes through one identifiable hostname.
      Cloudflare can still see the traffic (they always could —
      that's what tunnels are), but it gives observers a single
      target. Probably fine given low volume + the password gate.
  (b) **Per-machine named tunnels** — each install provisions its
      own subdomain via Cloudflare API. Best isolation. Requires
      operator to manage tunnel tokens at scale; cloudflared
      tunnel-token machinery is involved.

  Recommendation when this gets prioritized: option (a). The latency
  win matters most on first-install, where the user is staring at
  the CLI waiting for the URL — shaving 5-10s there is noticeable.
  Once install preflight (rc.15) is in, noVNC fires rarely enough
  that the marginal latency improvement may not be worth the ops
  burden.

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

## M — Inbound mail strategy (decided 2026-05-18)

trustysquire.ai's MX was rerouted to Google Workspaces for company
email. That conflicts with SES inbound on the apex — but the decision
below makes the conflict moot rather than something to work around.

**Context.** The SES inbound pipeline (SES → S3 → SNS →
`/v1/webhooks/ses` → inbox DB) did two jobs: (a) catch-all inboxes for
the form-fill bot's verification emails, (b) forwarding personal
aliases (dani@, hello@, …) to Gmail. Workspaces now does (b) natively.
Job (a) feeds the form-fill bot — which the OAuth-first pivot demoted
to a fallback, and whose email-verification step Gate 1 measured
failing **7/7** (`verification_not_sent`): anti-fraud silently
withholds verification mail from <30-day-old domains.

- [x] **M1 — Do NOT move SES to trustysquire.com. SES inbound is
  mothballed. — decided 2026-05-18.** A new domain is a new *young*
  domain — it rebuilds the exact known-failing system (the wall is
  domain age, not the domain name). The OAuth-first MVP has no
  email-verification step at all, so the SES pipeline is off the
  critical path. Decision: stop depending on the SES inbound pipeline;
  leave the code/DB/route in place (do not delete yet) but treat it as
  out-of-MVP-scope. The form-fill *form* logic stays — only its email
  step is dead. No effort spent on a replacement domain or subdomain.
- [x] **M2 — Form-fill fails fast to manual signup. — done
  2026-05-18.** `provision-any.ts` no longer passes an `inbox` to
  `bot.signup()` (M1 — the SES pipeline is mothballed). `agent.ts`
  signup() now branches: credentials missing + post-submit page asks
  for email verification + no inbox → returns a `verification_not_sent`
  error immediately with the signup URL, no poll. Reused the existing
  `verification_not_sent` status (it already means "submitted, can't
  confirm by email → sign up manually") rather than adding a new
  `manual_signup_required` — same user action, one fewer status. The
  status message + CHECK_DESCRIPTION were made cause-agnostic (covers
  both "service withheld the mail" and "no inbox"). Tests:
  `verification-no-inbox.test.ts` — fast-fail fires, and does not
  over-trigger when the page shows no email prompt.
- [ ] **M3 — Future fallback: read verification mail from the user's
  own Gmail via the OAuth profile. [P3]** The streamlined-onboarding
  flow (G13) logs the bot's Chrome profile into the user's Google
  account — so that profile is also logged into Gmail. For a no-OAuth
  service, the bot can sign up with the user's own aged Gmail (or a
  `+alias`) and read the verification email by driving Gmail in the
  same profile: an aged, real, readable inbox that does not get
  withheld. This supersedes SES inbound entirely and costs no new
  infrastructure. Future work, not MVP — but it is the reason M1's
  mothballed pipeline should eventually be deleted, not revived.

## P — Product roadmap: vault → credential broker → agent commerce

Six large buckets raised by the founder 2026-05-19, after the OAuth +
pairing + web-vault work shipped. These are multi-day product buckets,
not single-PR tasks. Founder's first-pass labels in brackets;
recommended slot + rationale below.

### The strategic read

The core loop is: **agent needs a key → Squire provisions it → key
lands in the vault → agent uses the key.** Today the *populate* half
works (the bot writes credentials into the vault); the *read* half
does not — nothing pulls keys back out programmatically. So the vault
is currently a write-only sink, and an agent re-provisions a service
it already has a key for.

**P3 closes that loop and is the keystone.** Everything else either
hardens it (P4), widens its entry points (P1, P2), or monetizes on top
of it (P5, P6).

The **spine** of the long-term vision — *secure credential broker for
agents, including paid SaaS* — is **P3 → P4 → P6**. P1, P2, P5 hang off
the side and are independently shippable (parallel-track / filler
work; "LOW" = low coupling, not "blocked").

### Recommended sequencing

| Slot | Bucket | Founder label | Why here |
|------|--------|---------------|----------|
| 1 | **P3** — agent reads the vault | HIGH | Keystone. Makes the vault a real broker. Read API already half-built. |
| 2 | **P4** — Vouchflow secures the vault | MEDIUM | Harden P3's *new* read surface before it sees traffic — retrofitting later reworks the reveal path twice. Unblocks P6. |
| 3 | **P2** — provision from the vault UI | MEDIUM | Widens provisioning to the web. Gated on one architecture call (where the bot runs). |
| 4 | **P1** — skillify signups → adapters | MEDIUM | Compounding cost/quality win; no urgency — can skillify retroactively from logs. = the open half of A1.2. |
| 5 | **P5** — Stripe billing for Squire | LOW | Monetizes the product. Fully independent — parallelizable anytime. |
| 6 | **P6** — paid-SaaS via Stripe Issuing + mandate tab | LOW | Heaviest; most dependencies; Stripe Issuing has external approval lead time. |

**Deviation from the founder's labels:** P4 is pulled ahead of P1/P2
(all three MEDIUM) because it is coupled to P3's new surface — ship P3
unsecured and the reveal path gets built twice. If P6 is committed,
**start the Stripe Issuing application now** regardless of code slot —
its approval lead time is the long pole.

---

### P1 — Closed feedback loop: skillify signups into adapters [MEDIUM]

**This is the open half of A1.2** (see the A1 section) — restated here
for the roadmap view; tracked as A1.2.

- **What.** When `provision_any_service` (the universal browser bot)
  completes a signup for a service with no native adapter, capture the
  run — the DOM-grounded step trail, field map, verification flow —
  and codify it into a native `defineAdapter` adapter registered in
  `registry-api`. Future signups take the deterministic `provision`
  fast path.
- **Why.** The bot is slow, LLM-metered, captcha-fragile; native
  adapters are free, fast, deterministic. Every skillified service is
  a permanent win — the product compounds, getting better the more it
  is used. `adapters/resend/manifest.ts` already anticipates this.
- **Depends on.** Nothing hard — the bot already emits a structured
  step trail (F3's DOM-grounded inventory makes it clean enough to
  codegen from).
- **Scope.** Persist successful runs' trails → adapter-codegen step
  (LLM-assisted scaffold, offline) → human review → register. Start
  human-in-the-loop; do not auto-ship generated adapter code to prod.
- **Open Q.** Fully-automated codegen vs. assisted-scaffold-then-review
  (start assisted). Routing: detect "this service now has an adapter"
  and prefer it over the bot.

### P2 — Provision SaaS directly from the vault UI [MEDIUM]

- **What.** A web flow in the vault to trigger a signup directly — pick
  / enter a service, watch it run (Linear-style tabs + the landing
  page's signup animation), the key lands in the vault.
- **Why.** Today provisioning is only agent-triggered via MCP. A web
  entry point lets a user provision without a coding agent in the
  loop, and turns the web app into a place you *do* things.
- **Depends on.** A web-triggerable provision path. **Architecture
  decision required** — the bot runs Playwright in the user's *local*
  MCP process; a web-triggered signup has no local process:
  - **(a)** Run the bot server-side on Fly (Playwright-in-container).
    Heavier, and **loses the residential-IP advantage** — S1/T3
    findings show datacenter egress is scored as bot-likely.
  - **(b)** Dispatch the job to the user's *paired CLI/MCP* if one is
    connected (reuse the agent-session channel). Preserves the
    residential-IP model; web is just the trigger + live view.
  Recommend **(b)** when a paired agent exists, (a) as fallback.
- **Decided 2026-05-19: (b)** — dispatch the signup job to the paired
  CLI/MCP; the web is the trigger + live view. Server-side (a) is a
  fallback only, for when no agent is paired.

### P3 — Agent sessions fetch existing keys from the vault [HIGH] ★ keystone

> **Status — 2026-05-19: discovery path shipped.** The fetch half
> already existed (`GET /v1/credentials/:reference` + `get_credential`,
> agent-auth); the missing piece was *discovery*. Now: `GET
> /v1/vault/credentials` accepts agent-session auth (`requireAny`) and
> returns the vault `reference`; new MCP `list_credentials` tool closes
> the loop with `get_credential`; `provision` / `provision_any`
> descriptions nudge check-vault-first. Tests green (MCP 237, API 69).
> API deployed. **MCP republished — `@trusty-squire/mcp@0.3.0`**
> (2026-05-19). Remaining: per-service / per-agent access scoping —
> deferred, shipped per-account.

- **What.** A coding agent (via MCP, authed by its `mcp_session_*`
  agent-session token) can list and retrieve credentials already in
  the vault. Provision flows check the vault *first* and reuse what is
  there before signing up for a new key.
- **Why.** THE keystone. The vault is write-only from the agent side
  today — the bot pushes keys in, nothing reads them back — so an agent
  re-provisions a service it already has. P3 makes the vault a real
  broker: provision once, reuse everywhere, across machines and
  sessions. The core value proposition, currently a dead end.
- **Depends on.** The vault read API exists from the Phase-1 work
  (`GET /v1/vault/credentials`, `POST /v1/vault/credentials/:id/
  reveal`) but is **web-session-auth only** — it must also accept
  agent-session bearer auth.
- **Scope.** Extend the vault API auth to agent sessions; add MCP tools
  (`list_credentials` / `get_credential`); wire provision flows to
  check-vault-first; audit every agent-side reveal (`VaultAuditEvent`
  already exists).
- **Open Q.** Access scope — can any paired agent read *all* the
  account's keys, or per-service / per-agent scoping? Ship per-account
  now, design the schema for scoping (also the reason to do P4 next).

### P4 — Vouchflow secures the vault credentials [MEDIUM]

- **What.** Wire the Vouchflow web SDK so credential access requires a
  Vouchflow-signed proof (`signPayload()`), not just a session/bearer
  token.
- **Why.** The vault already has AES-256-GCM envelope encryption + KMS.
  Vouchflow adds an *authorization/attestation* layer: every reveal
  becomes a signed, attestable action. It is the security story behind
  the landing pitch — and dogfoods the founder's own product. It
  should land right after P3: P3 opens a new "secrets-flow-to-agents"
  surface, and that surface is exactly what you want gated by signed
  proof before it sees real traffic.
- **Depends on.** P3 defines the surface. Vouchflow SDK capabilities
  (review needed). `config/vouchflow.ts` + `VOUCHFLOW_READ_KEY` (see
  the deploy-follow-ups section) are the existing hooks.
- **Open Q.** What exactly does Vouchflow attest — the user approving a
  reveal? the agent identity? the spend? Map `signPayload()` to a
  concrete gate. Also unblocks P6's `signPayload()` requirement.

### P5 — Stripe billing for Trusty Squire subscriptions [LOW]

- **What.** Users pay for Trusty Squire itself — Stripe Checkout,
  plans, webhooks, billing state on the `Account`.
- **Why.** Monetizes the product. Fully independent of the vault work
  — a well-trodden Stripe Checkout integration. "LOW" here means low
  coupling: it can run on a parallel track whenever capacity exists.
- **Depends on.** Nothing technical. Needs a pricing/tier decision (the
  Tier 0 free → paid model in CLAUDE.md's quota design is the start).

### P6 — Paid-SaaS signup via Stripe Issuing + mandate tab [LOW]

- **What.** The agent signs up for *paid* SaaS using a Stripe Issuing
  virtual card, bounded by a user-set spending mandate. The web app
  gains a three-tab structure — **Vault / Provision / Mandate**. The
  Mandate tab is policy guardrails (spend caps, per-service limits,
  approval thresholds). Every spend is gated by Vouchflow
  `signPayload()`.
- **Why.** Unlocks the full vision — an agent that provisions
  *anything*, including paid services, within provable limits. Also
  the heaviest bucket with the most dependencies.
- **Depends on.** P3 (vault read), P4 (Vouchflow signing), a Stripe
  relationship (P5-adjacent), AND the existing mandate concept in
  `packages/runtime` (`mandate-validator`) — **stubbed** during the
  OAuth work, needs un-stubbing/rebuilding. There must be **one**
  mandate model, not a new "Mandate tab" model alongside the
  runtime's.
- **External lead time.** Stripe **Issuing** requires separate Stripe
  approval/onboarding (compliance, KYC) — the long pole. Founder is
  filing that application (decided 2026-05-19); code start is
  independent of approval.
- **MVP scope (decided 2026-05-19).** Paid API services with *no free
  tier* are **out of the MVP** — the MVP covers services that have a
  free tier. ~A few weeks of runway.
- **Open Q.** Reconcile the Mandate tab with the runtime
  `mandate-validator` into one model.
