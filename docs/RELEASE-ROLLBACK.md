# Release rollback runbook (checklist #11)

A shipped release is broken. This is how you get users back to a good version
**fast**, then fix forward. Two independent surfaces ship separately — figure out
which one is broken first:

| Broken thing | Surface | Rollback mechanism |
|---|---|---|
| `npx @trusty-squire/mcp …` crashes / misbehaves for users | **npm** (`@trusty-squire/mcp`) | move the `latest` dist-tag (below) |
| API route 500s / bad deploy on `trusty-squire-api.fly.dev` | **Fly** | `flyctl releases` → redeploy previous (below) |

---

## npm rollback — the mcp client

### The core fact
**You cannot unpublish.** npm only allows unpublish within 72h and it *breaks
every install that pinned the version* — never do it. Rollback instead means:

1. **Repoint `latest` at the last known-good version** — instant for every new
   `npx` / `npm i` (they resolve `latest`). No republish needed.
2. **Deprecate the bad version** so anyone pinning it sees a warning.
3. **Fix forward** with a patch release that becomes the new `latest`.

### Fast path (one command)
Needs `NPM_AUTOMATION_TOKEN` (npmjs.com → Access Tokens → **Automation** — the
account's passkey-2FA blocks interactive `npm` writes with `EOTP`, so the
automation token is the only thing that works from a laptop):

```bash
# move latest back to a known-good version, and deprecate the bad one
NPM_AUTOMATION_TOKEN=… tools/rollback-mcp.sh 1.0.7 1.0.8
#                                              ^good  ^bad(optional)
```

### Manual path (if the script isn't handy)
```bash
printf '//registry.npmjs.org/:_authToken=%s\n' "$NPM_AUTOMATION_TOKEN" > /tmp/np
npm dist-tag add @trusty-squire/mcp@1.0.7 latest --userconfig /tmp/np
npm deprecate @trusty-squire/mcp@1.0.8 "Broken — use @1.0.7 or newer." --userconfig /tmp/np
rm -f /tmp/np
```

### Verify
```bash
npm view @trusty-squire/mcp dist-tags        # latest should now read the good version
cd /tmp && npx -y @trusty-squire/mcp@latest --version   # clean-machine smoke
```

### Then fix forward
Cut a patch the normal way — `pnpm release:mcp <next-patch>` → PR to `main` →
merge → `release.yml` publishes it and moves `latest` forward. (Bump *past* the
bad version; you can't reuse a version number.)

### Caveats
- **npx cache**: users who already ran the bad version have it cached locally and
  keep it until the cache expires or they clear it (`npx clear-npx-cache`). The
  dist-tag move only fixes *new* installs — so move fast, before many people pull
  the bad one.
- **Idempotent CI**: `release.yml` is a no-op if tag `v<version>` already exists,
  so re-pushing `main` without a version bump won't republish. A rollback never
  touches the CI token — it uses the Automation token directly.
- The GitHub release `v<bad>` is cosmetic; optionally mark it "pre-release" or
  delete it, but it doesn't affect installs.

---

## API rollback — Fly (`trusty-squire-api`)

The API auto-deploys on push to `main` (`release-api.yml`). To roll back a bad
deploy without reverting code first:

```bash
flyctl releases -a trusty-squire-api                 # list; find the last-good version vN
flyctl deploy -a trusty-squire-api --image <registry.fly.io/trusty-squire-api:deployment-…>
# (image ref of the good release, from `flyctl releases --json`)
```

Then **revert the bad commit on `main`** (`git revert <sha>` → PR → merge) so CI
doesn't immediately redeploy the broken version on the next push. For a config
mistake (not code), prefer flipping the relevant env/secret or a **kill switch**
(`SIGNUPS_DISABLED` / `EGRESS_DISABLED` / `MAINTENANCE_MESSAGE`, see CLAUDE.md)
over a full rollback.

> Note: `prisma db push` runs in the deploy's `release_command`. If the bad
> deploy changed the schema destructively, a code rollback alone won't restore
> dropped columns — check `apps/api/prisma` before assuming an image redeploy is
> enough.

---

## Where the tokens live
- **CI publish**: `NPM_TOKEN` in GitHub Actions secrets — used only by
  `release.yml`. A normal release never needs a local token.
- **Manual rollback / publish**: the npmjs **Automation** token, fetched from
  npmjs.com when needed. Do not store it in the repo. Do not go looking for the
  CI token — it's scoped to Actions.
