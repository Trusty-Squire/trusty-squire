# Releasing `@trusty-squire/mcp`

## Pre-publish manual smoke — headless login

CI cannot verify the headless OAuth login: it needs a real display, an
Xvfb rig, and a human driving a browser. `login-assets.test.ts` guards
the bundled `vnc.html` *statically* (password param, stable noVNC `RFB`
API, valid markup) — but the live VNC connection is only proven by
hand. **Run this once per release**, on a headless box (or with
`TRUSTY_SQUIRE_FORCE_HEADLESS=true`):

- [ ] `npx @trusty-squire/mcp@<rc> install` (or `login`) reaches the
      headless login stage and prints the named, shortened, or raw
      `*.trycloudflare.com` VNC URL. The long URL carries the password in
      a `#p=` fragment, never in a query parameter.
- [ ] Opening that URL shows the **branded** Trusty Squire login page
      (dark header, status dot) — not the stock noVNC client.
- [ ] The page auto-connects with **no VNC password prompt** (the
      password rode in the URL).
- [ ] The remote Chrome is visible and usable; a Google sign-in
      completes and the CLI reports the session connected.
- [ ] The fallback per-session `cloudflared` command includes
      `--protocol http2`; the operator-managed named-tunnel path still
      starts no per-session `cloudflared` process.
- [ ] Normal completion, timeout, an injected startup/poll error,
      `Ctrl-C`, and `SIGTERM` each leave **no new orphaned processes**.
      Capture `pgrep -a 'Xvfb|x11vnc|websockify|cloudflared'` before the
      run and confirm it returns to that baseline afterward; do not stop
      or count the persistent housekeeper Xvfb as a per-session leak.
- [ ] Starting a concurrent `connect` or `login` exits non-zero without
      waiting and prints `another Trusty Squire session is already using
      the browser — close it first`.
- [ ] The temp websockify web dir (`/tmp/ts-novnc-*`) is removed after
      every termination path above.

If any step fails, do not publish — the headless path is the worst-UX
path and a regression there is invisible to CI.

## Publish

[`CLAUDE.md`](../../CLAUDE.md#npm-distribution-the-install-path) owns the
release SOP. Normal releases use `pnpm release:mcp <version>` and publish through
CI; follow its emergency fallback only when CI cannot publish. Verify the actual
registry tarball with `scripts/verify-install.sh` as required by `AGENTS.md`.
