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
