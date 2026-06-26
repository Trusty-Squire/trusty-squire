# DESIGN — Wall hand-off: conversational hand-back (not a live-browser bridge)

Status: **proposed** (design discussion 2026-06-26; not yet built). Branch:
`claude/wall-handling`. Supersedes the earlier "pause + surface a live browser"
framing of this doc — that (the **live-browser bridge**) is now a documented,
spiked, but **deferred shelf option** (last section). The chosen design is the
cheap one.

## Thesis

Today TS treats every wall (visible captcha, 2FA, phone/SMS, anti-bot) as
**bypass-or-die**: try hard, then return a terminal give-up. Replace that with a
**resumable conversational hand-back**: when the bot hits a wall it can't clear,
it returns a structured `needs_user` signal, the host agent relays it in plain
language, the user supplies the one missing piece (a code, or a credential they
got themselves), and the run continues. **No live browser, no public tunnel, no
new attack surface.**

## Why the cheap version, not the bridge

Walls are **rare overall, but bite on a few spine services (e.g. Stripe).** The
honest analysis (full reasoning in the deferred-bridge section):

1. **Walls split three ways and only one needs a live browser.** *Code-walls*
   (SMS/authenticator/email OTP) just need the user to relay a code the bot then
   types — a text exchange. *Start-walls* (a landing-page interstitial) lose
   nothing to "retry / do it yourself." Only *interactive walls* (a visible
   Turnstile checkbox, drag-puzzle, biometric) truly need in-page human input —
   and that's the rare case.
2. **Spine signups are one-time, and the model already operates existing
   accounts.** You make one Stripe account ever; the recurring value (create a
   product, mint a key) is an **operate-task on the logged-in account** — wall-free
   (the Stripe operate-task already drives the existing dashboard, no captcha). So
   the interactive wall only bites at *fresh signup*, a rare-squared event.
3. **The bridge's value lands on end-users (often Macs), which the cheap rig
   can't serve.** `x11vnc` is X11-only; macOS Chrome is Quartz. Serving the actual
   use case would need the harder **cross-platform CDP-screencast** viewer — a
   rare event needing the expensive version. Poor ROI, plus a live-authenticated-
   session-on-a-public-URL attack surface.

So: capture the SMS/OTP class fully and close the Stripe-class credibility gap,
at ~5% of the bridge's cost and none of its security surface.

## The two flows

### Flow A — code-walls (SMS / authenticator / email OTP). In-band; session + vault moat preserved.

```
agent:  Mailgun texted a 6-digit code to verify your phone. What's the code?
you:    492013
agent:  (types it, keeps driving) … API key extracted and stored in your vault.
```

The bot can't *read* the code but can *type* it. `await_verification` already
does this for email (reads the user's Gmail); extend it with an "ask the user"
branch when the channel is SMS/authenticator (no inbox to poll).

### Flow B — interactive captcha (the Stripe case). Out-of-band; one-time.

```
agent:  Stripe's signup wants a Turnstile checkbox I can't click. Options:
        1. Sign up at dashboard.stripe.com/register yourself (~30s), then paste me
           a restricted key — I'll vault it and handle everything after.
        2. Skip Stripe.
you:    rk_live_…
agent:  (stores it in your vault) Got it. Create that $20/mo product now?
```

You sign up for the giant once; TS operates it wall-free forever after. Closes
the "it can't even do Stripe" credibility hole without a live browser.

## The `needs_user` resumable status (D1)

Replaces today's terminal give-up for walls (`provision-any.ts:1227-1408`):

```
{ status: "needs_user",
  wall: "sms_code" | "authenticator_code" | "interactive_captcha" | "phone_unavailable",
  message: "<plain English the host agent relays>",
  resume: "code" | "connect_existing" }
```

- `resume: "code"` → agent asks the user, then `provision_act type=<code>`,
  continues. (Flow A.)
- `resume: "connect_existing"` → agent relays the external-signup hand-back; a
  user-pasted credential goes to the vault. (Flow B.)

## Bypass / hand-off policy (D2 — never nag for the auto-handleable)

- **Keep auto-bypassing (no user):** invisible Turnstile / reCAPTCHA v3 (Tier-1
  behavior sim, free; `runCaptchaGate` `agent.ts:5876`), and email-OTP (the inbox
  poll — `provision_await_verification`, `read-otp.ts`).
- **Keep the 2captcha tier as the primary solver** for visible checkboxes (Codex
  #14 — human hand-back is a *fallback*, not a replacement; revisit on data).
- **Hand off (`needs_user`):** an SMS/authenticator code (→ Flow A); an
  interactive captcha the solver can't beat (→ Flow B); a phone number we can't
  supply.
- **Payment/KYC stay terminal-with-consent** (Codex #12 — consent boundaries, not
  20-second clears). They are NOT auto-handed-back.

## Minimal build (days, not weeks)

1. **`needs_user` status** on the `provision_*` results + the terminal mapper
   (`provision-any.ts`). Replaces "manual signup, giving up" with the structured
   resumable signal. Plus the missing `phone_required`/`sms_code` taxonomy.
2. **`await_verification` "ask the user" branch** (SMS/authenticator) alongside
   the inbox poll.
3. **Accept-pasted-credential → vault** path for Flow B (the vault already takes
   credentials; wire a `provision_store_credential` or reuse the extract write).
4. **Tool-description / prompt copy** so the host agent relays each hand-back
   cleanly (the two flows above are the copy).

No Xvfb, no x11vnc, no cloudflared, no live session on a public URL.

## What it deliberately does NOT do

Let you clear a captcha *inside the bot's live session* mid-flow. That's the
bridge (below). Cost of skipping it: on a *fresh* signup of an interactive-walled
service, you lose the bot's in-progress session and do that signup yourself. For
one-time spine services, that's the right trade.

---

# Deferred shelf option — the live-browser bridge

Kept here because it was spiked and de-risked; revisit only if usage data shows
*fresh signup behind an interactive wall* is a recurring pain the operate-existing
model doesn't cover.

**The idea:** when the bot hits an interactive wall, expose the *running* browser
to the user over a URL (TS's existing noVNC/cloudflared rig), let them clear it
in-session, detect + resume. This is the Cloudflare Browser Run / Browserbase
"Live View" pattern (browser-use itself has no HITL — it bypasses via its cloud).

### Spike results (2026-06-26) — the bridge IS viable on Linux

Patchright Chrome headed on Xvfb, x11vnc attach, xdotool (= the noVNC→x11vnc XTEST
path):

| Question | Result |
|---|---|
| Chrome boots headed on a shareable X display (the F13 path)? | ✅ |
| x11vnc attaches to the *running* browser's display? | ✅ |
| Human input (XTEST) registers a click on the page? | ✅ |
| Still works while the bot drives via CDP concurrently? | ✅ |
| Automation survives the external input? | ✅ |

No window manager needed. The OS-input and CDP-input channels coexist; the only
race is page *state*, solved by an **automation lock** (bot polls, never acts,
while the human drives). (An early "input never registers" scare was a broken
test page — a `setContent` inline `<script>` that never ran — not an input
problem. Attach listeners via `evaluate` when spiking.)

### Why it's still deferred (the costs the spike + Codex surfaced)

- **macOS can't use it by nature.** `x11vnc` is X11-only; macOS Chrome is Quartz.
  Cross-platform Surface A would need a **CDP-screencast** viewer
  (`Page.startScreencast` + `Input.dispatchMouseEvent`) — cross-platform,
  tab-scoped, but more host-UI to build.
- **New infra + lifecycle** (Codex #5,#7): a paused-session state machine with
  independent owner/timeout/reconnect/teardown (the rig's `finally` only works
  inside one long call today).
- **`runInBotChrome` is the wrong abstraction to reuse** (Codex #2): it waits for
  the profile to be free, then launches its *own* Chrome.
- **Security surface** (Codex #9-11): a live authenticated session on a public
  cloudflared URL; needs >8-char secret, single-viewer lock, kill-on-disconnect,
  and the URL leaks into chat transcripts/history.

### If revisited, build order

1. Spike the **CDP-screencast** viewer on Linux + (when access is set up) macOS,
   to decide one cross-platform viewer vs two.
2. Paused-session lifecycle + automation lock + a `provision_resume` tool.
3. Wire `runCaptchaGate` → pause for visible-captcha walls, behind a flag.

(To unblock the macOS spike: enable Tailscale SSH on the Mac, or Remote Login +
the dev-box key — currently the Mac is reachable but un-drivable from here.)
