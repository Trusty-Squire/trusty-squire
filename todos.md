# Open housekeeper-run TODOs (triaged 2026-05-30)

Surfaced by the 2026-05-29 harvest marathon. Triaged 2026-05-30 against
the artifacts actually on this box — three of the four are blocked on
captured artifacts / a live run that isn't reproducible from source, NOT
on a code change. Notes below say exactly what each needs to unblock.

## Done

- **fal.ai added to the provisioning surface (2026-05-30).** Entry in
  `tools/housekeeper-services.yaml` (slug `falai`, Google OAuth, key on
  the dashboard keys page) + host allowlist seed in
  `packages/vault/src/service-hosts.ts` (`falai`/`fal` → `fal.run`,
  `rest.alpha.fal.ai`, `queue.fal.run`) with a `service-hosts.test.ts`
  case.

- **Key-generation CTA suppression FIXED (2026-05-30).** A live fal.ai
  run (bot already Google-authed → landed on the dashboard) returned
  `planning_failed` because the "Add key" CTA scored 0 in
  `scoreSignupButton` and got capped out by `rankAndCapInventory` —
  the SAME bug as OpenRouter's "Get API Key" suppression (see the
  openrouter yaml note). Fix: key/token/secret generate/reveal CTAs now
  score +14 so they survive ranking on busy dashboards. Unit-tested
  (`f3-inventory.test.ts`). Should unblock fal.ai AND OpenRouter; re-run
  both to confirm full key extraction. Captures: `fal-ai-mpsq8vvz-r*`.

- **ipdata signup URL corrected (2026-05-30).** Was guessed as
  `ipdata.com/signup` (404). Real signup is
  `dashboard.ipdata.co/sign-up.html` — added as a curated yaml entry.

- **fal.ai key-CTA fix shipped in 0.8.5 + live-validated (2026-05-30).**
  Re-ran fal.ai with the fix → `ok`: signed up, extracted 1 credential,
  auto-promoted `falai v1` skill (pending-review).

- **GitHub forced-2FA wall — fast-abort FIXED (0.8.6, 2026-05-30).** A
  Convex→GitHub run hit GitHub's NON-skippable "Verify your two-factor
  authentication (2FA) settings / Verify 2FA now / you can no longer
  delay" wall. The bot mis-handled it as a phone-tap challenge and burned
  the 60s gmail poll + 4-min phone-tap wait before aborting — neither can
  clear it. New `isGitHubForced2faVerification()` (oauth-providers.ts,
  excludes the dismissible "skip 2FA verification" nag) makes the agent
  abort immediately with the right instruction ("run `mcp login
  --provider=github`, click Verify 2FA now"). Unit-tested. NOTE: the
  operator must still clear the wall once on the GitHub account — until
  then ALL GitHub-OAuth signups fail.

## Bot/synthesizer — BLOCKED on artifacts / live runs

- **Synthesizer `duplicate_credential_produces` false-reject — FIXED
  (0.8.11, 2026-05-30).** Convex's live run extracted 1 credential (one
  "Copy" auth token) but auto-promote rejected with
  `duplicate_credential_produces`: the post-verify loop re-extracts each
  round, so the single token was captured as TWO `extract_via_copy_button`
  rounds, both deriving `produces="copy"`. The `>1 extract step ⇒
  multi-cred` dispatch then hit the duplicate-name guard and rejected the
  whole skill. Fix: `collapseRedundantExtracts()` (promote-to-skill.ts)
  merges extract steps that derive the same credential name BEFORE the
  multi-cred dispatch — keying on the derived name so it catches
  non-consecutive re-extractions too, and keeping single-cred captures on
  the byte-equivalent single-cred path. Genuinely-distinct creds (Phase E
  multi-cred) get distinct planner hints ⇒ distinct names ⇒ untouched.
  Unit-tested (Convex-class single-cred collapse + Twitter multi-cred
  duplicate collapse-to-2). VALIDATED LIVE (2026-05-30): re-ran Convex
  against 0.8.11 → `[auto-promote] published convex v1`
  (skill_id=5HH3ZZBQE2Q8V47B3BDSV87JC7, pending-review). No rejection.
  Next: the verifier worker validates + promotes to active, after which
  a subsequent Convex signup should replay the skill in ~30s.

- **Convex post-OAuth email-code gate — FIXED (0.8.10, 2026-05-30).** The
  post-verify loop now re-runs `detectEmailOtpGate` each round; on a
  post-OAuth "Enter the code sent to <email>" wall (Convex's
  radar-challenge) it polls the operator's gmail via the same
  `readOperatorOtp` the signup gate uses and hands the code to the planner
  to fill (guarded to poll a given gate URL once). Wired machineToken +
  apiBase through `postVerifyLoop`. Unit-tested that the Convex text
  triggers detection; API has GMAIL_USER/GMAIL_APP_PASSWORD deployed. Full
  end-to-end still wants a live Convex run (one Google number-tap) to
  confirm the fill+submit, but every piece is in place + tested.

- **ipdata: "no credentials found"** — STILL BLOCKED, blocker moved. A
  live run with the corrected URL (above) now REACHES the real ipdata
  email/password signup form and submits it — but ipdata gates on email
  verification and the verification mail never arrives in 180s
  (`verification_not_sent`), the fresh-MX withholding caveat. So the bot
  can't reach the dashboard where the extractor runs; #1 can't be
  reproduced until the verification email lands. UNBLOCK: a maildomain
  ipdata will actually deliver to (or manual verification), THEN inspect
  the success-page extraction.

- **"Try another method" SMS-gate reclassification** — BLOCKED + premise
  stale: there is NO `sms_required` outcome in the agent's union (it's
  submitted / captcha_blocked / oauth_required / email_otp_required /
  anti_bot_blocked / sso_restricted / …). A service that hits its own
  SMS phone-verification page today just stalls (planner can't progress)
  rather than returning a dedicated status. UNBLOCK: first capture a real
  Vercel/MailerSend SMS-gate DOM, add a phone-gate detection + outcome,
  THEN add the "Try another method" → email-OTP reclassifier against the
  captured markup. This is net-new work, not a one-line fix.

- **Cloudflare/reCAPTCHA Tier 3 (2Captcha)** — code already shipped: the
  fallthrough is implemented in `runCaptchaGate` (agent.ts:2406-2447) —
  on a Tier-2 reCAPTCHA-v2 timeout with `TWOCAPTCHA_API_KEY` set it reads
  the sitekey, submits to 2Captcha, polls, injects the token. The solver
  is unit-tested (`captcha-solver-2captcha.test.ts`,
  `captcha-short-circuit.test.ts`). This todo is VALIDATION-only: needs a
  live Cloudflare-class signup where Tier 2 times out, to confirm the
  token actually clears the challenge. Not unit-testable.

- **Convex Google number-challenge unreadable** — RESOLVED, does NOT
  reproduce (2026-05-30 live run, screenshot
  `.debug/1780186239758-google-challenge.png`). The "Verify it's you"
  number ("11") rendered large, sharp, centre-right, fully in-frame, and
  the bot read it correctly. There is no crop problem; the original
  "couldn't read the number" was an intermittent vision miss on some
  other render, not a systematic issue. No `extractGoogleNumberViaVision`
  crop change warranted.

## Synthesizer follow-ups (all fixed 2026-05-28)

See `memory/project_synthesizer_followups_may28.md`. #1 missing
form-submit click, #2 literal value_template, #3 retry steps surviving
(`stripRetrySequences()`), #4 ipinfo prefix mis-detection, #5 typeform
`tfp_` regex — all fixed.

## Reference

- Last housekeeper run: 20-service requeue after the GitHub
  `--force-relogin` fix. Telegram notifier on; failures in bot-step trails.
- The bot lock-recovery / cross-process serialization fixes (0.8.4)
  landed 2026-05-30 — re-running the housekeeper should no longer brick
  on a stale Chrome profile lock.
