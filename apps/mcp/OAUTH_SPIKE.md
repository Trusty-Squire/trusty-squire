# OAuth-First Feasibility Spike — run recipe

Phase 1, T1 of the OAuth-first plan
(`~/.gstack/projects/Trusty-Squire-trusty-squire/ceo-plans/2026-05-17-oauth-first-signup.md`).

## What it answers

The kill-switch question: **can a Playwright-launched real-Chrome
(`channel:'chrome'`) persistent profile complete a Google login without
Google's automation detection blocking it?**

- **PASS** → the OAuth-first F1 architecture (a bot-driven dedicated Chrome
  profile) is viable. Proceed to the Phase 1 Render thin slice.
- **BLOCKED** → it does not work; the plan falls back to `connectOverCDP`
  into the user's own running Chrome. Stop and rethink before building more.

Scope is deliberately narrow (decision D8): the initial login only. Session
persistence and downstream re-consent are the thin slice's job, not this.

## Prerequisites

```bash
# Google Chrome must be installed (channel:'chrome' is the thing under test)
npx playwright install chrome

# Stealth toolchain — the spike reports whether this loaded. If it prints
# "stealth: UNAVAILABLE", install it before trusting a BLOCKED verdict:
pnpm -F @trusty-squire/mcp add -D playwright-extra puppeteer-extra-plugin-stealth
```

## Running it — machine with a display

```bash
cd apps/mcp && npx tsx src/bot/oauth-login-spike.ts
```

A Chrome window opens. Log into your Google account. The spike auto-detects
the result within 5 minutes.

## Running it — headless box (the Hetzner machine)

The login needs a visible window. Start a virtual display + a noVNC bridge,
then view it from your phone or laptop.

```bash
# 1. Install the virtual-display + VNC stack (Debian/Ubuntu)
sudo apt-get update && sudo apt-get install -y xvfb x11vnc novnc websockify

# 2. Virtual display
Xvfb :99 -screen 0 1280x800x24 &
export DISPLAY=:99

# 3. VNC server on that display — bound to localhost only (do NOT expose it)
x11vnc -display :99 -nopw -forever -localhost -rfbport 5900 &

# 4. Bridge VNC to a browser-viewable noVNC page
websockify --web=/usr/share/novnc 6080 localhost:5900 &

# 5. Run the spike (DISPLAY is already :99)
cd apps/mcp && npx tsx src/bot/oauth-login-spike.ts
```

**View it securely** — port 6080 is bound to localhost; reach it without
exposing it to the internet (this box just had public services locked down —
keep it that way):

```bash
# Option A — SSH tunnel from your laptop:
ssh -L 6080:localhost:6080 chode@<hetzner-ip>
#   then open http://localhost:6080/vnc.html

# Option B — over Tailscale: open http://<tailscale-hostname>:6080/vnc.html
#   (only works because Tailscale is a private network)
```

Do the Google login in the noVNC window. When the spike finishes, tear the
stack down:

```bash
pkill -f websockify; pkill -f x11vnc; pkill -f Xvfb
```

## Reading the verdict

The spike prints `PASS`, `BLOCKED`, or `TIMEOUT` in a boxed summary, and
exits 0 only on PASS. It also prints whether **stealth** was active — a
BLOCKED verdict with stealth off is not conclusive; install the stealth
toolchain and re-run first.

On PASS, the logged-in profile persists at `~/.trusty-squire/chrome-profile`
(override with `OAUTH_SPIKE_PROFILE_DIR`). The Phase 1 thin slice reuses it.
