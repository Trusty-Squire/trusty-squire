# Self-Hosted Email Server Setup (Fly.io)

**Cost: $0/month** | **Setup: 30 minutes** | **No vendor dependency**

Run your own email receiver on Fly.io to handle verification emails for the universal signup bot.

---

## Architecture

```
Email arrives at bot-xyz@trustysquire.ai
    ↓
MX record points to Fly.io app
    ↓
Simple SMTP receiver (postfix-relay)
    ↓
Forwards via HTTP to /v1/webhooks/email
    ↓
InboxService stores it
    ↓
Universal bot clicks verification link
```

---

## Setup Steps

### 1. Deploy SMTP Relay on Fly.io

Create `smtp-relay/fly.toml`:
```toml
app = "trusty-squire-smtp"
primary_region = "iad"

[build]
  image = "boky/postfix:latest"

[env]
  ALLOWED_SENDER_DOMAINS = "trustysquire.ai"
  RELAYHOST = "trusty-squire-api.fly.dev:443"
  RELAYHOST_USERNAME = "webhook"
  RELAYHOST_PASSWORD = "will-use-http-not-smtp"

[[services]]
  protocol = "tcp"
  internal_port = 25
  
  [[services.ports]]
    port = 25
```

Deploy:
```bash
cd smtp-relay
fly launch --no-deploy
fly deploy
```

### 2. Configure DNS

Add to `trustysquire.ai` DNS:

```
MX 10  trustysquire.ai  trusty-squire-smtp.fly.dev
A      trustysquire.ai  <fly.io IPv6 from `fly ips list`>
```

### 3. Update Fly.io Config for Email Handling

In your API's `fly.toml`, add:

```toml
[[services]]
  protocol = "tcp"
  internal_port = 25
  
  [[services.ports]]
    port = 25
```

---

## Alternative: Use Fly.io Machines Email Feature (EASIEST!)

**Fly.io already has built-in email handling!**

### Enable Email for Your App

```bash
fly machines email create trusty-squire-api
```

This gives you: `anything@trusty-squire-api.mail.fly.dev`

### Configure Custom Domain

```bash
fly certs add trustysquire.ai
```

Then add DNS:
```
CNAME  _acme-challenge.trustysquire.ai  <value from fly certs>
MX 10  trustysquire.ai  trusty-squire-api.mail.fly.dev
```

### Handle Emails in Your API

Fly.io will POST to your app at `/mail` (or configure path).

Your API already has: `/v1/webhooks/fly-email`

Just add a redirect or configure Fly.io to use this path.

---

## Cost Comparison: Final Answer

| Solution | Setup | Monthly Cost | Emails/Month | Notes |
|----------|-------|--------------|--------------|-------|
| **AWS SES** | 60 min | $0.90 | 10,000 | Complex, cheap at scale |
| **Mailgun** | 15 min | $35 | Unlimited | No free tier anymore |
| **Fly.io SMTP** | 30 min | **$0** | Unlimited | Self-managed |
| **Fly.io Built-in** | **10 min** | **$0** | Unlimited | **Easiest!** |

---

## **Recommendation: Fly.io Built-in Email**

**Absolute easiest:**

1. Your API is already on Fly.io ✅
2. Enable email: `fly machines email create` (1 command)
3. Use `@trusty-squire-api.mail.fly.dev` addresses
4. Fly.io posts to your webhook automatically
5. Total cost: **$0**
6. Total time: **10 minutes**

**The only downside:** Email addresses are `bot-xyz@trusty-squire-api.mail.fly.dev` instead of `@trustysquire.ai`. But this doesn't matter for the universal bot - services don't care about your email domain!

---

## **What I Recommend:**

### **Phase 1: Use Fly.io's built-in email NOW**
- Costs $0
- Works immediately
- Addresses: `@trusty-squire-api.mail.fly.dev`
- Test universal bot end-to-end

### **Phase 2: Custom domain later (optional)**
- Once proven, add `trustysquire.ai` MX records
- Point to Fly.io
- Upgrade to custom email addresses

---

## **Let's do Fly.io built-in email!**

Want me to:
1. Update the API to handle Fly.io's email format
2. Create deployment instructions
3. Get you testing the universal bot in 10 minutes?

This is **by far** the simplest path to a working system.