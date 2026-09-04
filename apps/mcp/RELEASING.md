# Releasing `@trusty-squire/mcp`

## Pre-publish manual smoke — interactive login

CI cannot complete an OAuth login. **Run both login paths once per release**:

- [ ] `npx @trusty-squire/mcp@<rc> install` (or `login`) opens Chrome and
      a Google sign-in completes on a machine with a user-visible display.
- [ ] On a headless Linux host with no user-visible display, `install`,
      `connect`, or `login` prints a reachable noVNC URL; keyboard and pointer
      input complete sign-in from another device. Record
      `pgrep -a 'Xvfb|x11vnc|websockify|cloudflared'` before each teardown case;
      completion, timeout, error, Ctrl-C, SIGTERM, and SIGHUP must each return
      to that baseline with no per-login helper or owned quick-tunnel process.
- [ ] With both `TS_LOGIN_PUBLIC_HOSTNAME` and `TS_LOGIN_LOCAL_PORT` set,
      headless login reuses the operator-managed named tunnel while teardown
      removes the per-login display and local listener without stopping that
      external tunnel.
- [ ] With that same named tunnel configured but its local port already held
      by another listener, login prints one notice naming the busy port and
      completes over a one-off quick tunnel instead.
- [ ] A normal automated `operate_start` session launches Chrome new-headless
      and starts no Xvfb, x11vnc, websockify, or login tunnel.
- [ ] Starting a concurrent `connect` or `login` exits non-zero without
      waiting and prints `another Trusty Squire session is already using
      the browser — close it first`.

## Publish

[`CLAUDE.md`](../../CLAUDE.md#npm-distribution-the-install-path) owns the
release SOP. The normal RC cut is one command plus one merge:

```bash
pnpm release:mcp next-rc
```

The command derives the next RC from `origin/main`, bumps it, commits, pushes,
and opens the release PR. Merge after the required checks pass; `release.yml`
publishes npm `next` automatically. Pass an explicit version only for stable or
nonstandard cuts. Follow the emergency fallback only when CI cannot publish.
Verify the actual registry tarball with `scripts/verify-install.sh` as required
by `AGENTS.md`.
