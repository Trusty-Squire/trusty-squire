# Gmail SMTP Forwarding Setup

Configure your self-hosted mail server to forward business emails to Gmail using Gmail's SMTP.

**Cost: $0** (uses your existing Gmail account)

---

## Step 1: Generate Gmail App Password

Google doesn't allow regular passwords for SMTP. You need an "App Password":

### A. Enable 2-Factor Authentication (if not already enabled)
1. Go to https://myaccount.google.com/security
2. Click **2-Step Verification**
3. Follow the setup process

### B. Generate App Password
1. Go to https://myaccount.google.com/apppasswords
2. Select app: **Mail**
3. Select device: **Other (Custom name)**
4. Name it: **Trusty Squire Mail Server**
5. Click **Generate**
6. Copy the 16-character password (format: `xxxx xxxx xxxx xxxx`)

⚠️ **Save this password!** You won't be able to see it again.

---

## Step 2: Add Secrets to Fly.io

```bash
cd /home/chode/trusty-squire/apps/api

# Add Gmail credentials (replace with your values)
flyctl secrets set \
  GMAIL_USER=lunchboxfortwo@gmail.com \
  GMAIL_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx \
  --app trusty-squire-api
```

This will automatically restart the API with the new secrets.

---

## Step 3: Test Email Forwarding

Send a test email:

```bash
curl -X POST https://trusty-squire-api.fly.dev/v1/webhooks/postfix \
  -H "Content-Type: message/rfc822" \
  -H "X-Original-To: dani@speakeasyapp.xyz" \
  --data-binary "From: partner@example.com
To: dani@speakeasyapp.xyz
Subject: Test Partnership Email
Message-ID: <test-123@example.com>

Hello Dani,

This is a test email to verify forwarding works.

Best regards,
Test Partner
"
```

### Expected Result:
You should receive an email in **lunchboxfortwo@gmail.com** with:
- **From:** Shows as your Gmail (because we're using Gmail's SMTP)
- **Subject:** `[dani@speakeasyapp.xyz] Test Partnership Email`
- **Reply-To:** partner@example.com (so you can reply directly)

---

## Step 4: Test from Real Email Service

Send an actual email from your phone/computer:

```
To: hello@vouchflow.dev
Subject: Testing forwarding
Body: Does this work?
```

Check your Gmail inbox - it should arrive!

---

## How It Works

```
Email sent to dani@speakeasyapp.xyz
    ↓
DNS MX → trusty-squire-mail.fly.dev
    ↓
Postfix receives email
    ↓
Forwards to API webhook
    ↓
API checks EmailForwarder aliases
    ↓
Matches: dani@speakeasyapp.xyz → lunchboxfortwo@gmail.com
    ↓
Sends via Gmail SMTP (nodemailer)
    ↓
Arrives in your Gmail inbox!
```

---

## Email Format in Gmail

**What you'll see:**
```
From: dani@speakeasyapp.xyz (via lunchboxfortwo@gmail.com)
To: lunchboxfortwo@gmail.com
Subject: [dani@speakeasyapp.xyz] Original Subject
Reply-To: original-sender@example.com
```

The `[business@domain.com]` prefix helps you identify which business email it was sent to.

---

## Gmail SMTP Limits

**Free Gmail Account:**
- **500 emails per day** (plenty for personal business use)
- **100 recipients per email**

If you exceed these, consider:
- Google Workspace ($6/month) - 2,000 emails/day
- Resend ($0.001 per email after 100/day free)

---

## Troubleshooting

**"Invalid credentials" error:**
- Make sure you're using App Password, not regular password
- Remove spaces from app password (`xxxx xxxx xxxx xxxx` → `xxxxxxxxxxxxxxxx`)
- Verify 2FA is enabled on your Google account

**Emails not arriving:**
- Check API logs: `flyctl logs --app trusty-squire-api`
- Verify secrets are set: `flyctl secrets list --app trusty-squire-api`
- Test with curl command above
- Check Gmail spam folder

**"Daily sending quota exceeded":**
- You've hit 500 emails/day limit
- Wait 24 hours or upgrade to Google Workspace

---

## Security Notes

✅ **App passwords are safe:**
- Scoped to just SMTP
- Can be revoked anytime at https://myaccount.google.com/apppasswords
- Doesn't give access to your full Gmail account

✅ **Secrets are encrypted:**
- Fly.io encrypts secrets at rest
- Only accessible to your API app
- Not visible in logs

---

## Next Steps

Once forwarding works:
1. Add more business email aliases (edit DEFAULT_ALIASES in email-forwarder.ts)
2. Test universal signup bot with real email verification
3. Save $288/year on Google Workspace!
