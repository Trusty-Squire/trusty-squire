# Mailgun Setup for Trusty Squire Inbound Email

Once your API is deployed to Fly.io, configure Mailgun to receive emails at `@trustysquire.ai` and forward them to your API.

## 1. Deploy API to Fly.io

```bash
cd /home/chode/trusty-squire
fly launch --name trusty-squire-api --region iad
```

Your API will be at: `https://trusty-squire-api.fly.dev`

## 2. Provision Databases

```bash
# Postgres
fly postgres create --name trusty-squire-db --region iad
fly postgres attach trusty-squire-db

# Redis (optional, for sessions)
fly redis create --name trusty-squire-redis --region iad
```

## 3. Set Secrets

```bash
fly secrets set \
  SESSION_JWT_SECRET=$(openssl rand -hex 32) \
  VOUCHFLOW_CUSTOMER_ID=ts-local-dev \
  VOUCHFLOW_STUB_MODE=true \
  NODE_ENV=production
```

## 4. Configure Mailgun

### A. Sign up for Mailgun
- Go to https://signup.mailgun.com
- Create a free account (100 emails/day)

### B. Add Your Domain
- In Mailgun dashboard → Sending → Domains → Add New Domain
- Domain: `trustysquire.ai`
- Follow their DNS setup instructions (add TXT, MX, CNAME records)

### C. Set Up Inbound Route
- In Mailgun dashboard → Receiving → Routes → Create Route
- **Expression Type:** Match Recipient
- **Recipient:** `.*@trustysquire.ai` (regex to match all)
- **Actions:**
  - ✅ Forward to: `https://trusty-squire-api.fly.dev/v1/webhooks/mailgun`
  - ✅ Store message (optional, for debugging)
- **Priority:** 0
- **Description:** Forward all inbound to Trusty Squire API

## 5. DNS Configuration

Add these records to your `trustysquire.ai` DNS:

### For Sending (Mailgun provides these):
```
TXT  mg.trustysquire.ai  "v=spf1 include:mailgun.org ~all"
TXT  _domainkey.trustysquire.ai  "<Mailgun will provide DKIM value>"
CNAME email.trustysquire.ai  mailgun.org
```

### For Receiving:
```
MX 10  trustysquire.ai  mxa.mailgun.org
MX 10  trustysquire.ai  mxb.mailgun.org
```

## 6. Test It

Send a test email:
```bash
curl -X POST https://trusty-squire-api.fly.dev/v1/webhooks/mailgun \
  -d 'sender=test@example.com' \
  -d 'recipient=test-alias@trustysquire.ai' \
  -d 'subject=Test Email' \
  -d 'stripped-text=This is a test' \
  -d 'message-id=<test-123@example.com>'
```

Or send a real email to any address @trustysquire.ai and check your API logs:
```bash
fly logs --app trusty-squire-api
```

## 7. Verify Universal Bot Works

Once email is working:
```bash
# Test the bot
cd /home/chode/trusty-squire/packages/universal-bot
node dist/cli.js postmark

# Should complete signup including email verification!
```

## Troubleshooting

**Emails not arriving:**
- Check Mailgun routes are active
- Verify DNS records propagated (use `dig MX trustysquire.ai`)
- Check Mailgun logs for delivery attempts
- Check Fly.io logs for webhook calls

**Webhook returning errors:**
- Verify API is deployed and healthy: `curl https://trusty-squire-api.fly.dev/health`
- Check payload format matches `MailgunInboundPayload` schema
- Review API logs for detailed errors

## Cost

- **Fly.io**: Free tier covers small usage (~$0-5/month for light load)
- **Mailgun**: Free tier = 100 emails/day (plenty for testing)
- **Total**: ~$0-5/month for a working universal signup bot
