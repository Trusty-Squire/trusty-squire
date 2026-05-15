# TODOS

## Deploy follow-ups (from the 2026-05-15 eng review + security fix)

These must be done on/before the next deploy of `trusty-squire-api`.

- [ ] **Set webhook signing secrets on `trusty-squire-api`.**
  `MAILGUN_WEBHOOK_SIGNING_KEY` and `RESEND_WEBHOOK_SECRET`. The
  `/v1/webhooks/mailgun` and `/v1/webhooks/resend` routes now verify sender
  signatures and **fail closed (503) when these are unset** — inbound mail
  from Mailgun/Resend will break until they are set.

- [ ] **Run the inbox migration.**
  `pnpm -F @trusty-squire/inbox prisma migrate deploy` against the inbox
  database. Adds the `issued_to` column on `EmailAlias` that backs the new
  per-token alias ownership check; the API expects the column to exist.

- [ ] **Set `VOUCHFLOW_READ_KEY` on `trusty-squire-api`** (lower urgency).
  `config/vouchflow.ts` no longer hardcodes the server-side read key; it
  reads `VOUCHFLOW_READ_KEY` from env (undefined until set). Not consumed by
  any code path yet, so it can wait until the revocation/introspection
  features land — but set it with the rotated key when those arrive.

> Larger queued engineering work (T1 distribution/npm publish, T2 Tier-1
> Prisma persistence, T3 spend tracking, T4–T10) lives in the design doc and
> `~/.gstack/projects/Trusty-Squire-trusty-squire/tasks-eng-review-*.jsonl`.

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
