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
  case. Ready for a housekeeper run to attempt the signup.

## Bot/synthesizer — BLOCKED on artifacts / live runs

- **ipdata: "no credentials found"** — BLOCKED: no ipdata capture exists
  in `~/.trusty-squire/corpus/onboarding/` on this box, so the
  success-page DOM that would show ipdata's key shape isn't available.
  The extractor (`extractAllLabeledTokensFromReason`, agent.ts:1980) and
  `pickStableAttribute` (promote-to-skill.ts:843) can't be fixed blind.
  UNBLOCK: re-run the housekeeper against ipdata (now that capture is
  default-on) to regenerate the success-DOM, then add the ipdata key
  shape to the extractor against that fixture.

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

- **Convex Google number-challenge unreadable** — BLOCKED: the Convex
  captures on this box (`convex-mpmjcbbr-r*`) are a *different*,
  already-resolved case (a JWT/OIDC `eyJ…` token extract; round 10 =
  done). There is no Convex number-challenge screenshot here, so
  `extractGoogleNumberViaVision` (agent.ts:4710) crop widening can't be
  assessed. UNBLOCK: capture a Convex run that actually hits the Google
  number challenge, then inspect the screenshot crop.

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
