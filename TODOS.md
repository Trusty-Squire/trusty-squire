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
- [ ] **T3.2 — Spike telemetry.** Extend `CaptchaEvent` with
  `captcha_variant`, `challenge_rendered`, `signup_succeeded`. Same
  pattern as the `proxied` column. This is the instrumentation for T3.3.
- [ ] **T3.3 — The spike.** Collect ~2 weeks of real bot runs; answer
  with data: which captcha variant does the bot actually face, and do
  cleared captchas lead to a *completed* signup or a re-scored reject?
  Define a minimum sample size before deciding. **Gates T3.4.**
- [ ] **T3.4 — Module A v1: reCAPTCHA v2 static-grid solver.** GATED on
  T3.3. Build only if the data shows the bot meaningfully faces static
  grids AND v2 solves get accepted. Extends `solveVisibleCaptcha()`;
  dedicated ~6-call LLM sub-budget; `solveGrid()` on `llm-client.ts`;
  explicit fail-fast ladder; fast-model default; gated by a ~20-30 grid
  eval; regression test for the checkbox-only path.

**Deferred (data-gated, do not start):** Module A dynamic-refill grids,
hCaptcha, audio/Whisper fallback. Validate need from T3.3 data first.

**Cut:** Module B — reCAPTCHA v3 anti-detection (patched Chromium,
fingerprint hardening). An open-ended anti-detection treadmill with no
completion state. Postmark and other v3 services stay `captcha_blocked`
+ manual-signup CTA. Reopen only if v3-service coverage becomes a
funded, ongoing commitment.
