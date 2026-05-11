# inbox-api

Fastify HTTP gateway for SES inbound webhooks. Wraps `@trusty-squire/inbox`.

```
SES → S3 (raw RFC 822) → SNS → THIS SERVICE → @trusty-squire/inbox → Postgres
```

## Local dev

```bash
pnpm --filter @trusty-squire/inbox-api dev
# Listens on :4001 by default. Override with PORT=…
```

The dev server uses the in-memory alias / email stores and a stub S3 fetcher (it throws on any fetch). Useful for testing the SNS envelope plumbing; not useful for actual mail until a real fetcher is wired in.

Endpoints:
- `POST /webhooks/ses-inbound` — handles SNS `SubscriptionConfirmation` (logs the URL for manual confirmation) and `Notification` (extracts the S3 pointer, ingests the email).
- `GET /health` — liveness probe.

## SES + SNS + S3 setup (production)

Bento configures these via Terraform; this README documents the contract.

1. **MX record:** `mail.trustysquire.ai` → `inbound-smtp.us-east-1.amazonaws.com` (or whichever region's SES inbound endpoint).
2. **S3 bucket** `trusty-squire-inbound-mail` (private; lifecycle rule deletes objects ≥ 7 days old to align with body retention).
3. **SES Receipt Rule:**
    - Recipients: `*.mail.trustysquire.ai` (catch-all)
    - Action 1: write to S3 bucket above with the object-key prefix `incoming/`
    - Action 2: publish notification to SNS topic `trusty-squire-ses-inbound`
4. **SNS topic** `trusty-squire-ses-inbound` with HTTPS subscription pointing at this service's `/webhooks/ses-inbound`. Confirm the subscription by visiting the `SubscribeURL` from the first webhook hit.
5. **IAM:** the IAM role this service runs under needs `s3:GetObject` on the bucket so the production `RawEmailFetcher` can pull the raw mail.
6. **Optional**: SNS message signature verification middleware in front of `/webhooks/ses-inbound` (the chunk-7 implementation defers this to the WAF / mTLS gate; production hardening adds in-process verification).

## Body retention

`ReceivedEmail.body_text` / `body_html` are nulled at 7 days via a background job (not part of this service — separate worker package). Metadata stays for 90 days. The S3 bucket lifecycle rule (above) drives the actual byte deletion.

## What this service does NOT do

- Send mail (inbound only).
- Decrypt PGP / S/MIME mail (rejected with `EncryptedEmailError`).
- Support BYO domain (single domain at v0).
