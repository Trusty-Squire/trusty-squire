# DESIGN — Wall hand-off: pause, surface a live browser, let the user clear it, resume

Status: **proposed** (design discussion 2026-06-26; not yet built). Branch:
`claude/wall-handling`.

## Thesis

Today TS treats every "wall" (visible captcha, 2FA, phone/SMS, anti-bot
interstitial) as **bypass-or-die**: try hard to defeat it, and on failure return
a terminal give-up status. Replace that with **bypass-if-cheap, else hand off**:
when the bot can't clear a wall autonomously, **pause the run, surface the *live*
browser to the user, let them clear the wall, detect it, and resume** — instead
of giving up.

This converts the walls TS currently calls **permanently unservable**
(`phone`/`SMS`, `kyc`, sometimes `payment` — `provision-gate.ts`
`PERMANENT_WALL_KINDS`) into **user-assisted-servable**: those are exactly the
walls a human clears in 20 seconds. It's a coverage expansion, not just nicer UX.

## Research: this is NOT what browser-use does

The trigger for this work was "do what browser-use does." Worth correcting:
**browser-use (2026) has no native pause / human-in-the-loop.** Its official
answer to walls is "infrastructure, not code" — bypass harder via Browser Use
Cloud (stealth fingerprinting + proxy rotation + CAPTCHA-solving). The community
has asked for HITL ([issue #221], [discussion #1695]) but it isn't in the
library. So browser-use is the *same* bypass-or-give-up philosophy we're leaving.

The **"surface a live browser, let the human clear it, resume"** pattern is the
**Cloudflare Browser Run / Browserbase "Live View"** model:

1. Script detects a wall (login / CAPTCHA / MFA).
2. It obtains a **Live View URL** into the *same running session* and shares it
   with the user (Slack / email / UI).
3. The human takes control of the live browser and clears the wall.
4. The script detects completion by event/poll (navigation, a DOM element
   appearing, network idle) with a timeout (~5 min), then resumes.

TS is unusually well placed to do this **on infra it already owns** (below) — it
doesn't need to rent a cloud browser.

[issue #221]: https://github.com/browser-use/browser-use/issues/221
[discussion #1695]: https://github.com/browser-use/browser-use

## TS is already ~80% there (two halves, never composed)

The two pieces of the Live-View pattern already exist in the codebase:

1. **Pause → poll-live-page → detect-clear → resume.** `waitForGoogleChallenge`
   / `waitForGitHubChallenge` (`apps/mcp/src/bot/agent.ts:11621`/`11698`): on a
   Google number-match or GitHub "verify it's you," the bot already notifies,
   pauses mid-run, polls the live page every 3s for up to 4 min, and resumes on
   clear. **But it's wired ONLY for OAuth provider challenges** — not captcha,
   anti-bot, phone, or form-OTP.
2. **A live-browser-over-a-URL bridge.** `runInBotChrome` / `runHeadlessChrome`
   (`apps/mcp/src/bot/google-login.ts:585`/`:679`): Xvfb + x11vnc + websockify +
   branded noVNC + **cloudflared tunnel → public URL** + a `pollUntilDone` loop +
   clean `teardown`. **But it spawns a *fresh* Chrome for `mcp login`** — it has
   never been attached to the *running* signup `BrowserController`.

**The one genuinely hard new piece:** bridge the *in-flight* `BrowserController`
Chrome out through the existing x11vnc/websockify/cloudflared rig, instead of
launching a new browser. Everything else is composition + policy.

## Decisions

### D1 — Build surface A (host-driven) first; defer B; C is a queue

Three contexts the wall hand-off could serve. We build **A** first, **defer B**,
and make **C** a worklist (no pause):

- **A — Host-driven `provision_*` (BUILD FIRST).** The host agent (Claude
  Code/Codex) *is* the conversational surface, so hand-off is nearly free: a tool
  returns a paused status + a Live View URL, the agent shows it to the user in
  natural language, and resumes on clear. This is the strategic direction
  (host-as-planner) and needs no notification plumbing.
- **B — End-user autonomous provision (DEFER / likely YAGNI).** A background bot
  on the user's laptop that pauses + notifies the user directly. Given the
  host-as-planner direction, an end-user flow with *no* host agent watching is
  rare; and without a per-user notification channel (Telegram was operator-only
  and is being removed) there's no clean surface anyway. Revisit only if a real
  no-host end-user flow appears.
- **C — Unattended housekeeper (NO pause).** Nobody is watching an unattended
  verify run, so it must not block on a human. It classifies the wall and routes
  it to a **"needs user"** worklist (a small evolution of today's `quarantined`),
  so walls accumulate as a checkable list instead of silent give-ups. A *push*
  for that worklist is a separate, later, per-account-channel concern — NOT the
  removed personal Telegram bot.

### D2 — Telegram is removed (done on this branch)

Telegram was operator-only (end users never set `TELEGRAM_BOT_TOKEN`); its main
use (the housekeeper digest) already went with the housekeeper extraction, and
the hand-off design routes all notification through the host agent. Ripped out
(`telegram-notify.ts` + test + the `sendTelegramHeightenedAuth` call sites). The
API `notifyHeightenedAuth` path + stderr banners remain.

### D3 — The bypass/pause policy (never nag for the auto-handleable)

- **Keep auto-bypassing (no user):** invisible Turnstile / reCAPTCHA v3 (Tier-1
  behavior sim — free, works; `runCaptchaGate` `agent.ts:5876`), and email-OTP
  (the inbox poll already nails this — `provision_await_verification`,
  `read-otp.ts`).
- **Pause + hand off (only these):** visible Turnstile / reCAPTCHA-v2 checkbox,
  authenticator/2FA codes, phone/SMS, and "verify it's you" device challenges —
  the walls only a human can or should clear. This also lets interactive runs
  **drop the paid 2captcha tier** (a human is cheaper and more reliable than a
  solver whose tokens get rejected at the IP layer).
- **Anti-bot interstitial (CF "just a moment"):** keep the existing wait/reload;
  if it won't clear, offer the hand-off as a last resort (a human clicking the
  Turnstile in the live browser may clear it) before any give-up.

### D4 — Status taxonomy: a resumable paused state + the missing phone status

- Add a **resumable** `paused_for_user` / `awaiting_user` status, distinct from
  the terminal give-ups in the mapper (`provision-any.ts:1227-1408`). It carries
  `{ live_view_url, reason, expires_in }`.
- Add the missing **`phone_required`** host status (today phone walls collapse
  into `verification_not_sent`/`failed` — a gap; `phone` exists only as a
  `FailureStage` and a `PERMANENT_WALL_KIND`).
- `provision-gate.ts` `PERMANENT_WALL_KINDS` (phone/kyc/payment) shift from
  "refuse" to "pausable" in interactive contexts — a human can complete them.

## The mechanism — `pauseAndSurface(reason)`

One primitive, reused by every surface:

1. **Bridge the running browser out.** Attach the existing
   x11vnc/websockify/cloudflared rig (`google-login.ts`) to the *in-flight*
   `BrowserController`'s Chrome/Xvfb display (the new work), yielding a
   password-gated public Live View URL.
2. **Surface it.** Surface A: return `{ status: "paused_for_user", reason,
   live_view_url, expires_in }` as the tool result. (B/C: their own surfaces.)
3. **Poll for clear.** Reuse the `waitFor*Challenge` poll: every ~3s check the
   live page for (a) the wall element/text gone, (b) the expected next-step
   element present, or (c) navigation off the challenge URL — with a timeout.
4. **Resume or time out.** Cleared → tear down the bridge, continue the run.
   Timed out → tear down, return a **resumable** `paused_timeout` (not a hard
   fail).

## UX — surface A in detail

- Agent drives a signup → hits a visible Turnstile / a 2FA prompt.
- `provision_act` / `provision_captcha_gate` returns
  `{ status: "paused_for_user", reason: "turnstile_checkbox",
  live_view_url: "https://….trycloudflare.com", expires_in: 300 }`.
- The agent tells the user, in its own words: *"Stripe wants a Turnstile
  checkbox I can't solve — open this live browser, click it, and I'll continue:
  \<URL\>."*
- The bot auto-detects the clear (poll) **or** the user says "done" → a new
  `provision_resume` tool (or the next `provision_observe`) continues.
- Security: the Live View exposes the user's live session — keep it
  password-gated (the rig already does) and tear it down on resume/timeout.

## Phased plan

1. **The bridge (hard part).** Make `pauseAndSurface` attach the rig to a running
   `BrowserController` (vs spawning fresh). Unit-test the URL/teardown lifecycle;
   manual live test against a known Turnstile service.
2. **Surface A tools.** `paused_for_user` status + `live_view_url` on
   `provision_captcha_gate` / `provision_act`, a `provision_resume` tool, and the
   poll-for-clear loop. Tool-description copy so the host agent surfaces the URL
   well.
3. **Policy wiring (D3).** Branch `runCaptchaGate` + the OAuth-challenge handlers
   into `pauseAndSurface` for the pause-list walls; keep auto-bypass for the
   rest. Generalize the `waitFor*Challenge` poll to captcha/phone/anti-bot.
4. **Taxonomy (D4).** `paused_for_user` / `paused_timeout` / `phone_required`;
   `provision-gate` permanent→pausable in interactive contexts.
5. **C — needs-user queue.** Route unattended-housekeeper walls to a registry
   "needs user" worklist instead of silent give-up. (Separate from A; do after.)
6. **Deferred:** B (end-user autonomous), and any operator push for the C queue.

## Spike results (2026-06-26) — Linux+Xvfb bridge is VIABLE

Ran the feasibility spike on the Linux operator box (patchright Chrome headed on
Xvfb, x11vnc attach, xdotool = the same XTEST path noVNC→x11vnc uses):

| Question | Result |
|---|---|
| Chrome boots headed on a shareable X display (the F13 path)? | ✅ yes |
| x11vnc attaches to the *running* browser's display? | ✅ yes |
| Page renders correctly / viewable? | ✅ yes (screenshot confirmed) |
| Human input (XTEST) registers a click on the page? | ✅ yes (click count incremented) |
| Still works while the bot drives via CDP concurrently? | ✅ yes (clicks landed) |
| Automation survives the external input? | ✅ yes (run continued) |

**The late-attach bridge works on Linux+Xvfb.** No window manager needed (Chrome
already holds X focus; XTEST clicks + keyboard reach the renderer). Codex's
concurrent-control concern (#4) is real but *not* a blocker: the OS-input and
CDP-input channels coexist — the only race is page *state*, solved by the
**automation lock** (bot polls, never acts, while the human drives).

Caveat learned the hard way: an early "input never registers" scare was a broken
test page (a setContent inline `<script>` that never ran), not an input problem.
Attach listeners via `evaluate`, not inline `<script>`, when spiking.

### What the spike did NOT resolve (and reshapes the architecture)

- **macOS is out of reach for the x11vnc rig — by nature, not just access.**
  `x11vnc` is X11-only; macOS Chrome renders via Quartz, not X11, so the existing
  rig **cannot** attach to Chrome on a Mac. (Also: the Tailscale Mac doesn't
  advertise Tailscale SSH and has no authorized key for the dev box, so it's
  currently un-drivable from here — a one-time enable.)
- **Cross-platform (Mac/Windows end-users on Surface A) needs a different
  viewer.** The strong candidate is a **CDP screencast** (`Page.startScreencast`
  for frames + `Input.dispatchMouseEvent` for input): cross-platform, **tab-scoped**
  (fixes Codex's "x11vnc is display-level" concern), input guaranteed to reach the
  renderer (it's how Playwright drives), and no Xvfb/x11vnc/WM dependency. Cost:
  it's more app-building (the host renders frames + captures clicks) vs noVNC's
  ready-made browser viewer.

### Decision the spike sharpens

- **Linux (operator/housekeeper + Linux users):** x11vnc late-attach is proven —
  buildable now.
- **Cross-platform Surface A:** x11vnc won't work → CDP-screencast.
- **So: build two viewers (x11vnc for Linux now, CDP-screencast later), or build
  the CDP-screencast viewer once (cross-platform, more host UI work)?** This
  replaces the original "is the bridge even possible" question — it is, on Linux.

## Codex outside-voice findings folded in (2026-06-26)

Beyond the bridge, fold these into implementation (not forks):
- **Automation lock** (#4): while the user has control, the bot may poll, never act.
- **Independent paused-session lifecycle** (#5,#7): sessions are live `Map`
  objects with no paused-state/owner/timeout/reconnect/teardown. A returned
  `paused_for_user` URL needs its own timers + teardown even if the host agent
  disappears — the rig's `finally` only works inside one long call today.
- **Don't reuse `runInBotChrome` as-is** (#2): it waits for the profile to be
  *free* then launches its own Chrome; wrong abstraction for an in-flight session.
- **Respect the self-launch/CDP launch path** (#3): don't force the old
  `launchPersistentContext`/fingerprint-exposing path when bridging.
- **Security** (#9,#10,#11): >8-char secret, single-viewer lock, kill-on-disconnect,
  tab-scoped (not whole-desktop), and the URL leaks into transcripts/history.
- **Payment/KYC ≠ phone** (#12): consent boundaries, explicit consent + distinct
  status, not auto-"pausable".
- **Keep 2captcha as primary, human as fallback** (#14) until data says otherwise.
- **Path fix** (#13): `provision-gate.ts` lives at `apps/mcp/src/`, not `.../bot/`.

## Open questions

1. **Attach vs relaunch.** RESOLVED for Linux (attach works). Remaining: can we
   expose the running `BrowserController`'s Chrome
   over x11vnc without disrupting the in-flight automation (it's headed under
   Xvfb already via F13)? Or do we need CDP-attach a viewer? This is the crux of
   phase 1 — spike it first.
2. **Tunnel lifetime.** Cloudflare's Live View expires ~5 min; our cloudflared
   `trycloudflare` tunnel can live for the run's duration — confirm and set a
   sane pause timeout (lean 5–10 min, resumable).
3. **Resume trigger.** Auto-detect (poll) vs explicit `provision_resume` vs both.
   Default: both — poll auto-resumes, and the host can force-continue.
