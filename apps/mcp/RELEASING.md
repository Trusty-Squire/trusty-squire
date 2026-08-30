# Releasing `@trusty-squire/mcp`

## Pre-publish manual smoke — interactive login

CI cannot complete an OAuth login. **Run both login paths once per release**:

- [ ] `npx @trusty-squire/mcp@<rc> install` (or `login`) opens Chrome and
      a Google sign-in completes on a machine with a user-visible display.
- [ ] On a headless Linux host with no user-visible display, `install`,
      `connect`, or `login` prints a reachable noVNC URL; keyboard and pointer
      input complete sign-in from another device; completion, timeout, error,
      and SIGHUP each remove the per-login Xvfb, x11vnc, websockify, and owned
      quick-tunnel processes.
- [ ] With both `TS_LOGIN_PUBLIC_HOSTNAME` and `TS_LOGIN_LOCAL_PORT` set,
      headless login reuses the operator-managed named tunnel while teardown
      removes the per-login display and local listener without stopping that
      external tunnel.
- [ ] Starting a concurrent `connect` or `login` exits non-zero without
      waiting and prints `another Trusty Squire session is already using
      the browser — close it first`.

## Publish

[`CLAUDE.md`](../../CLAUDE.md#npm-distribution-the-install-path) owns the
release SOP. Normal releases use `pnpm release:mcp <version>` and publish through
CI; follow its emergency fallback only when CI cannot publish. Verify the actual
registry tarball with `scripts/verify-install.sh` as required by `AGENTS.md`.
