# Self-Hosted Mail Server on Fly.io

**Cost: $0/month** | **Setup: 15 minutes** | **No vendor lock-in**

Run your own Postfix mail server on Fly.io to receive verification emails for the universal signup bot.

---

## Architecture

```
Email sent to bot-xyz@trustysquire.ai
    ↓
DNS MX → trusty-squire-mail.fly.dev
    ↓
Postfix receives on port 25
    ↓
forward-to-webhook.sh pipes email to HTTP POST
    ↓
API /v1/webhooks/postfix parses and stores
    ↓
Universal bot waits for email via InboxService
    ↓
Bot clicks verification link
```

---

## Deploy

### 1. Deploy Mail Server

```bash
cd /home/chode/trusty-squire/mailserver
fly launch --no-deploy --name trusty-squire-mail --region iad
fly deploy
```

### 2. Get Mail Server IP

```bash
fly ips list --app trusty-squire-mail
```

You'll get:
- **IPv4**: `66.241.xxx.xxx`
- **IPv6**: `2a09:8280:1::xxxx`

### 3. Configure DNS

Add to your `trustysquire.ai` DNS:

```
MX 10   trustysquire.ai           trusty-squire-mail.fly.dev
A       mail.trustysquire.ai      <IPv4 from step 2>
AAAA    mail.trustysquire.ai      <IPv6 from step 2>
TXT     trustysquire.ai           "v=spf1 ip4:<IPv4> ip6:<IPv6> -all"
```

### 4. Test Email Reception

Send a test email:

```bash
# From any server with mail command
echo "Test email body" | mail -s "Test Subject" test@trustysquire.ai
```

Check mail server logs:

```bash
fly logs --app trusty-squire-mail
```

You should see:
```
Postfix received email for test@trustysquire.ai
Forwarding to webhook...
```

Check API logs:

```bash
fly logs --app trusty-squire-api
```

You should see:
```
Postfix email ingested { messageId: "...", result: "stored" }
```

---

## Test Universal Bot

Now the bot can receive verification emails!

```bash
cd /home/chode/trusty-squire/packages/universal-bot

# Update inbox to use real stores connected to API
# (Currently uses in-memory - need to connect to deployed API)

# Test signup
node dist/cli.js postmark
```

---

## Cost Breakdown

| Component | Cost |
|-----------|------|
| **Mail Server (Fly.io)** | $0 (free tier: 3 shared-cpu VMs) |
| **API (Fly.io)** | $0 (free tier) |
| **Postgres (Fly.io)** | $0 (free tier: 1GB) |
| **Redis (Fly.io)** | $0 (free tier: 256MB) |
| **Total** | **$0/month** |

Fly.io free tier includes:
- Up to 3 shared-cpu-1x VMs (256MB RAM each)
- 3GB persistent storage
- 160GB outbound data transfer

Your setup uses 2 VMs (mail + api) = **well within free tier**.

---

## Troubleshooting

**Emails not arriving:**
- Check DNS propagation: `dig MX trustysquire.ai`
- Check mail server is running: `fly status --app trusty-squire-mail`
- Check logs: `fly logs --app trusty-squire-mail`

**Mail server can't reach API:**
- Fly.io apps in same organization can reach each other via `.internal` domains
- API should be reachable at: `http://trusty-squire-api.internal:8080`
- Check with: `fly ssh console --app trusty-squire-mail -C "curl http://trusty-squire-api.internal:8080/health"`

**Webhook errors:**
- Check API logs: `fly logs --app trusty-squire-api`
- Verify webhook endpoint exists: `curl https://trusty-squire-api.fly.dev/health`

---

## Next: Connect Universal Bot to Real Inbox

Currently the bot uses in-memory email stores. To make it work with the deployed API:

1. Add API client to universal-bot package
2. Call API to create alias
3. Call API to wait for email
4. Bot gets verification link and proceeds

OR

Run the bot directly on Fly.io as a third app that shares the database with the API.

---

## Summary

You now have:
- ✅ Self-hosted mail server ($0/month)
- ✅ No vendor lock-in (own your infrastructure)
- ✅ Unlimited emails
- ✅ Full control

**Total setup: 15 minutes**
**Total cost: $0 forever**

This is the simplest, cheapest solution!
