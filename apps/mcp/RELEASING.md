# Releasing `@trusty-squire/mcp`

## Pre-publish manual smoke — headless login

CI cannot verify the headless OAuth login: it needs a real display, an
Xvfb rig, and a human driving a browser. `login-assets.test.ts` guards
the bundled `vnc.html` *statically* (password param, stable noVNC `RFB`
API, valid markup) — but the live VNC connection is only proven by
hand. **Run this once per release**, on a headless box (or with
`TRUSTY_SQUIRE_FORCE_HEADLESS=true`):

- [ ] `npx @trusty-squire/mcp@<rc> install` (or `login`) reaches the
      headless login stage and prints a `*.trycloudflare.com/vnc.html`
      URL with a `?password=` query.
- [ ] Opening that URL shows the **branded** Trusty Squire login page
      (dark header, status dot) — not the stock noVNC client.
- [ ] The page auto-connects with **no VNC password prompt** (the
      password rode in the URL).
- [ ] The remote Chrome is visible and usable; a Google sign-in
      completes and the CLI reports the session connected.
- [ ] `Ctrl-C` during the login leaves **no orphaned processes**:
      `pgrep -a 'Xvfb|x11vnc|websockify|cloudflared'` is empty
      afterward (T7 — SIGTERM/SIGINT teardown).
- [ ] The temp websockify web dir (`/tmp/ts-novnc-*`) is removed after
      the run.

If any step fails, do not publish — the headless path is the worst-UX
path and a regression there is invisible to CI.

## Publish

See `CLAUDE.md` → "npm distribution" for the authoritative steps. In
short, from the repo root:

```bash
node -e "require('fs').rmSync('apps/mcp/dist',{recursive:true,force:true})"
pnpm -F @trusty-squire/mcp build
cd apps/mcp && pnpm pack
printf '//registry.npmjs.org/:_authToken=%s\n' "$NPM_AUTOMATION_TOKEN" > /tmp/np
npm publish apps/mcp/trusty-squire-mcp-<ver>.tgz --access public --userconfig /tmp/np
rm -f /tmp/np
```

The published tarball must include `dist/` **and** `assets/` (the
branded `vnc.html` / `interstitial.html` — `package.json` `files`).
Confirm with `tar tzf trusty-squire-mcp-<ver>.tgz | grep assets/login`.
