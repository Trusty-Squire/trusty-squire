# Test Services for Universal Signup Bot

Targets are ordered from "easiest first" to "captcha-hard stretch." The v1
agent uses Claude vision + heuristic credential extraction; reCAPTCHA-protected
sites are expected to fail until we add a CAPTCHA-solver integration.

## Tier 1 — Headless-friendly, no captcha (v1 target)

1. **Resend** — https://resend.com/signup
   - Plain email + password, no captcha, instant credentials (`re_…`) on dashboard load.
   - Free tier: 3000 emails/month.

2. **Loops.so** — https://app.loops.so/signup
   - Email + password, dashboard shows API key after first login.
   - Free tier available.

3. **Plunk** — https://app.useplunk.com/signup
   - Open-source-friendly, simple form, API token on dashboard.
   - Free self-hosted, paid cloud tier.

4. **Brevo (Sendinblue)** — https://www.brevo.com/free-account
   - Email + password, sometimes captcha (varies by IP reputation).
   - Free tier: 300 emails/day.

5. **MailerSend** — https://app.mailersend.com/signup
   - Email + password, email verification required.
   - Free tier: 3000 emails/month.

## Tier 2 — Stretch goals (likely require captcha solver)

6. **Postmark** — https://account.postmarkapp.com/sign_up
   - Required: name, email, username, password, TOS checkbox.
   - Has reCAPTCHA invisible scoring — headless will likely score low.

7. **Mailgun** — https://signup.mailgun.com/new/signup
   - Multi-step signup, reCAPTCHA.

8. **Hunter.io** — https://hunter.io/users/sign_up
   - Cloudflare Turnstile.

## v1 success bar
- 3/5 Tier 1 services pass = ship-ready.
- 4/5 Tier 1 = comfortably good.
- Postmark/Mailgun are not v1 blockers.

## How to run

```bash
# From repo root
ANTHROPIC_API_KEY=... pnpm --filter @trusty-squire/universal-bot exec \
  tsx cli.ts resend https://resend.com/signup
```

Set `UNIVERSAL_BOT_HEADLESS=false` to watch the browser drive the form.
