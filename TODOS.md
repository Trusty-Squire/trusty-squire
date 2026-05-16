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

- [ ] **S1 = Residential proxy support for the universal-bot.** Originally
  framed as the single biggest lever against the captcha problem when the bot
  can't run on a residential network (Codespaces, Replit, Hetzner CI/test
  boxes, corporate networks).

The shape converged on across two conversations:

| Aspect | Decision |
|--------|----------|
| **What it is** | Route Playwright egress through a residential proxy (Bright Data / IPRoyal / PacketStream) when the user's egress network is datacenter-class. |
| **Why it matters** | reCAPTCHA v2/v3 score datacenter IPs as bot-likely regardless of fingerprint quality. A residential proxy bypasses this entirely. Validated empirically: the same code passed on a residential Mac (Comcast AS7922) and was blocked on datacenter Hetzner (AS24940). |
| **Why deferred** | Pre-PMF, ~20% of users hit the problem, and there was no telemetry yet to justify ongoing proxy cost. Build the leading indicator first (bot-run telemetry — shipped ✅), then decide. |
| **Implementation effort** | ~half a day. Single change to `BrowserController.start()` to accept `proxy: { server, username, password }` via env vars. Gated so the ~80% of residential users pay zero proxy cost; only datacenter-detected sessions route through the proxy. |
| **Cost** | $0.05–$0.10 per signup via PacketStream or IPRoyal pay-as-you-go. Bright Data has a $5 one-time signup credit (~100–600 signups) for free initial validation. |

## S2 — Universal-bot: ambiguous submit selector + 5-minute false hang

Diagnosed 2026-05-16 from a real Resend signup run. **Not yet fixed.**

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
