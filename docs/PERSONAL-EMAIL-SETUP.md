# Personal Email Server Setup

Host all your business emails (speakeasyapp.xyz, vouchflow.dev, helmpoint.ai, trustysquire.ai) on your self-hosted mail server.

**Cost: $0/month** (vs $72/year per domain for Google Workspace)

---

## Architecture Options

### **Option A: Forward to Gmail (5 minutes)**
- ✅ Simplest
- ✅ Use Gmail interface
- ⚠️ Replies show "via trustysquire.ai"
- ⚠️ Not as professional

### **Option B: Full IMAP Server (1 hour)**
- ✅ Professional (reply from business@yourdomain.com)
- ✅ Use any email client (Spark, Apple Mail, Thunderbird)
- ✅ Full control
- ⚠️ More setup

---

## Option A: Forward to Gmail

### 1. Set Up Email Aliases
Create a mapping file for who gets what:

```bash
# On your mail server
cat > /etc/postfix/email_aliases << EOF
# speakeasyapp.xyz
team@speakeasyapp.xyz          yourname@gmail.com
support@speakeasyapp.xyz       yourname@gmail.com
hello@speakeasyapp.xyz         yourname@gmail.com

# vouchflow.dev
team@vouchflow.dev            yourname@gmail.com
support@vouchflow.dev         yourname@gmail.com

# helmpoint.ai
team@helmpoint.ai             yourname@gmail.com
support@helmpoint.ai          yourname@gmail.com

# trustysquire.ai
team@trustysquire.ai          yourname@gmail.com
EOF
```

### 2. Update Postfix Config
```bash
postconf -e "virtual_alias_maps = hash:/etc/postfix/email_aliases"
postmap /etc/postfix/email_aliases
postfix reload
```

### 3. Add DNS Records
For each domain, add:
```
MX 10   @   trusty-squire-mail.fly.dev
```

### 4. Test
```bash
echo "test" | mail -s "Test" team@speakeasyapp.xyz
# Should arrive in your Gmail
```

---

## Option B: Full IMAP Email Server

This gives you a complete email server with:
- IMAP access (read mail from any client)
- SMTP sending (send from business@domain.com)
- Multiple mailboxes
- Folder organization

### 1. Deploy Dovecot (IMAP Server)

Create `email-server/docker-compose.yml`:
```yaml
version: '3.8'
services:
  postfix:
    image: bokysan/postfix
    environment:
      - ALLOWED_SENDER_DOMAINS=trustysquire.ai speakeasyapp.xyz vouchflow.dev helmpoint.ai
      - DOVECOT_HOST=dovecot
    volumes:
      - ./mail:/var/mail
    ports:
      - "25:25"
  
  dovecot:
    image: dovecot/dovecot
    volumes:
      - ./mail:/var/mail
      - ./dovecot.conf:/etc/dovecot/dovecot.conf
    ports:
      - "993:993"  # IMAP SSL
      - "587:587"  # SMTP submission
```

### 2. Configure User Accounts

```bash
# Create mailbox users
doveadm user add team@speakeasyapp.xyz -p secure_password
doveadm user add support@vouchflow.dev -p another_password
doveadm user add hello@helmpoint.ai -p third_password
```

### 3. Configure Spark/Email Client

In Spark (or any email client):

**Incoming (IMAP):**
```
Server:   mail.trustysquire.ai
Port:     993
Security: SSL/TLS
Username: team@speakeasyapp.xyz
Password: secure_password
```

**Outgoing (SMTP):**
```
Server:   mail.trustysquire.ai
Port:     587
Security: STARTTLS
Username: team@speakeasyapp.xyz
Password: secure_password
```

### 4. Deploy to Fly.io

```bash
cd email-server
fly launch --name trusty-squire-email
fly deploy
```

---

## Recommended Approach

**Start with Option A (forwarding):**
- Takes 5 minutes
- Get all emails in Gmail immediately
- Test it works for a week

**Upgrade to Option B later if needed:**
- More professional
- Better for teams
- Full control

---

## Cost Savings

**Current (Google Workspace):**
- 4 domains × $6/month × 12 months = **$288/year**

**New (Self-hosted on Fly.io):**
- Fly.io mail server: **$0/month** (free tier)
- Unlimited domains
- Unlimited mailboxes
- **$288/year saved**

---

## Security Considerations

**For Personal Email:**
- ✅ Use DKIM signing (add TXT records)
- ✅ Use DMARC policy (add TXT records)
- ✅ SSL/TLS for IMAP/SMTP
- ✅ Strong passwords
- ⚠️ No spam filtering (Gmail handles this in Option A)

**DKIM/DMARC Setup:**
```
# Generate DKIM key
opendkim-genkey -d speakeasyapp.xyz -s mail

# Add to DNS:
TXT mail._domainkey.speakeasyapp.xyz "v=DKIM1; k=rsa; p=<public_key>"
TXT _dmarc.speakeasyapp.xyz "v=DMARC1; p=quarantine; rua=mailto:dmarc@speakeasyapp.xyz"
```

---

## What I Recommend For You

**Phase 1 (Today):**
1. Add MX records for all 4 domains → mail server
2. Set up forwarding to your Gmail
3. Test by sending to team@speakeasyapp.xyz
4. Use Gmail to reply (will show "via trustysquire.ai" but works)

**Phase 2 (Later):**
1. Deploy full IMAP server if you want professional replies
2. Configure Spark with business@domain.com accounts
3. Reply directly from business addresses

**Start simple, upgrade if needed.**

Want me to help you set up Option A (forwarding) now?
