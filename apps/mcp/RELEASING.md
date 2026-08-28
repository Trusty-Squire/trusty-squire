# Releasing `@trusty-squire/mcp`

## Pre-publish manual smoke — visible login

CI cannot complete an OAuth login. **Run this once per release** on a
machine with a user-visible display:

- [ ] `npx @trusty-squire/mcp@<rc> install` (or `login`) opens Chrome and
      a Google sign-in completes.
- [ ] Starting a concurrent `connect` or `login` exits non-zero without
      waiting and prints `another Trusty Squire session is already using
    the browser — close it first`.

## Publish

[`CLAUDE.md`](../../CLAUDE.md#npm-distribution-the-install-path) owns the
release SOP. Normal releases use `pnpm release:mcp <version>` and publish through
CI; follow its emergency fallback only when CI cannot publish. Verify the actual
registry tarball with `scripts/verify-install.sh` as required by `AGENTS.md`.
