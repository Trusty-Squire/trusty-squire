# Single-`main` migration runbook

Consolidating Trusty Squire from the dual `staging` / `main` release model onto
a **single `main` branch**.

**The new model**

| | before | after |
|---|---|---|
| rc → npm `next` | version bump on `staging` | version bump on `main` |
| stable → npm `latest` | version bump on `main` | `workflow_dispatch` on **Release mcp** |
| CI / deploys | `main` + `staging` | `main` |
| feature PRs target | `staging` | `main` |

**Why.** The captain runs `@next` and develops predominantly through firstmate
crews. The split branch caused repeated stale-checkout drift (`main` and
`staging` are 10/214 commits apart as of this writing), and `main`'s stable line
(`1.1.12`) is effectively unused. Stable becomes an explicit, on-demand
promotion instead of a second always-on branch.

**Not changed:** `@next` still exists and still tracks the active line — it just
comes from `main` now. See [Captain's MCP config](#captains-mcp-config) — no
client-side change is needed.

---

## What the PR that carries this doc already did

Workflow-only, no app/product code:

- `.github/workflows/release.yml`
  - triggers on push to **`main`** only (`staging` dropped)
  - a push to `main` now requires a **prerelease** version in
    `apps/mcp/package.json` and publishes npm `next` (this is what `staging`
    used to do)
  - a new **`workflow_dispatch`** with a `stable_version` input publishes
    `main` HEAD as a stable `X.Y.Z` to npm `latest`
  - the verify gate, npm provenance, tag/npm idempotency, dist-tag
    cross-checks and install verification are all untouched
- `ci.yml`, `mcp-slow-tests.yml`, `release-api.yml`, `release-registry.yml`,
  `release-skill-schema.yml`, `release-recipe-schema.yml`:
  `branches: [main, staging]` → `branches: [main]`
- the two schema workflows also lose their now-unreachable
  "`staging` requires a prerelease" guard; they keep the `main` requires-stable
  guard, so schema packages publish stable straight from `main` with no rc
  channel. If an rc channel is ever wanted for them, mirror the
  `workflow_dispatch` pattern from `release.yml`.
- `deploy-web.yml` and `registry-status.yml` were already `main`-only and are
  untouched.

Everything below **cannot** be done in a PR. It is the maintainer's job.

---

## Step 0 — merge the workflow PR into `staging`

The PR is based on and targets `staging` (the active line). Merge it there
first; Step 1 carries it onto `main`.

Until the new `release.yml` is on the **default branch**, the "Release mcp"
`workflow_dispatch` button does **not** appear in the Actions UI — GitHub only
offers manual dispatch for workflows present on the default branch. So Step 1 is
also what turns the stable-promotion path on.

---

## Step 1 — consolidate `staging` into `main` (do this BEFORE deleting anything)

The goal: `main` ends up holding the current code, with nothing lost.

> **`main` is branch-protected and refuses direct pushes.** A `staging` → `main`
> PR is not a workable vehicle here (Case B has 47 conflicting files; GitHub's
> web resolver is not the tool for that). Decide up front: temporarily lift
> protection on `main` — or add yourself to its bypass list — for the duration of
> Steps 1–2, then restore it in Step 4.

### 1a. Audit what `main` has that `staging` does not

```bash
git fetch origin main staging

# Commits on main that are not on staging (by patch-id; a leading `-` means
# staging already has an equivalent patch, `+` means it does not).
git cherry origin/staging origin/main

# Same list with subjects, for eyeballing.
git log --oneline origin/staging..origin/main

# Files that exist on main but not on staging.
git diff --name-status --diff-filter=D origin/main origin/staging
```

For every `+` commit and every listed file, answer: *is this change already
represented on `staging`, or was it deliberately removed there?*

```bash
# Is a main-only fix present on staging under its own commit?
git log --oneline origin/staging --grep 'reap abandoned server'

# Was a main-only file deleted on staging on purpose? (the deleting commit
# shows up as the newest entry in staging's log for that path)
git log --oneline origin/staging -- apps/mcp/src/bot/xvfb.ts
```

**Decision rule:** if a main-only change is genuinely missing from `staging`
(not superseded, not deliberately deleted), cherry-pick it onto `staging` and
push **before** consolidating. Otherwise the tree-equality merge in 1c would
drop it.

<details>
<summary>Observed state at the time this runbook was written (re-verify — branches move)</summary>

- `main` `7b1ee7b4`, `staging` `d8c71b20`; 10 commits on `main` only, 214 on
  `staging` only → **diverged, Case B**.
- All three substantive `main`-only fixes were already on `staging` under the
  same PR numbers: `#555` repin workspace deps, `#556` profile-cleanup
  blocking, `#560` reap abandoned processes. The remaining `main`-only commits
  are release version bumps (`1.1.9`/`1.1.10`/`1.1.11`), superseded by
  `staging`'s `1.1.13-rc.27`.
- 12 files exist on `main` but not `staging` — every one was **deliberately
  deleted** by a later `staging` commit (`#598` removed the virtual-display
  stack: `xvfb.ts`, `short.ts`, `g/[slug]/route.ts`; `#599`/`5dcce320` replaced
  pooled operator profiles: `operator-profile-pool.ts`,
  `operator-direct-identity.ts`; `#585` replaced `install/proxy-url.ts`).
- A plain `git merge` reports **47 conflicted files**, largely because the same
  fixes landed twice against different surrounding code. Hand-resolving them
  risks resurrecting the files `staging` deleted on purpose — which is exactly
  why 1c takes `staging`'s tree wholesale.

</details>

### 1b. Case A — `main` is an ancestor of `staging` (fast-forward)

```bash
git merge-base --is-ancestor origin/main origin/staging \
  && echo "Case A: fast-forward" || echo "Case B: diverged"
```

If Case A:

```bash
git checkout main
git pull --ff-only origin main
git merge --ff-only origin/staging
git push origin main
```

Nothing is rewritten and nothing conflicts. Skip to Step 2.

### 1c. Case B — diverged (merge)

`staging` is the newer, authoritative line, so `main` should end up with
**`staging`'s exact tree** while still recording `main`'s history as a merge
parent (no force-push, no lost history):

```bash
git checkout main
git pull --ff-only origin main

# Start the merge; it will stop with conflicts. That is expected.
git merge --no-ff --no-commit origin/staging || true

# Resolve by taking staging's tree wholesale. MERGE_HEAD survives, so the
# commit below is still a real two-parent merge.
git read-tree -u --reset origin/staging

git commit -m "chore: consolidate staging into main (single-branch release model)"
```

Verify before pushing — all three must hold:

```bash
# 1. main's tree is now byte-identical to staging's.
git diff --quiet origin/staging && echo "OK: tree identical to staging"

# 2. The commit really has two parents (main + staging).
git log -1 --format='%h parents=%p %s'

# 3. Nothing left dirty.
git status --short
```

Then:

```bash
git push origin main
```

> If you would rather resolve the conflicts by hand instead, that is fine — but
> re-read the audit in 1a first. Several conflicts are deletions `staging` made
> deliberately; accepting "both sides" there silently reinstates dead code.

---

## Step 2 — confirm the workflow changes reached `main`

```bash
git fetch origin main
git show origin/main:.github/workflows/release.yml | head -40
git show origin/main:.github/workflows/ci.yml | grep -n "branches:"
```

`release.yml` on `main` must show `branches: [main]` plus the
`workflow_dispatch:` block. Then check the Actions UI: **Release mcp** should
now show a **Run workflow** button.

### What the consolidation push itself sets off

Pushing 200+ commits' worth of change onto `main` fires every `main`-triggered
workflow whose path filter matches. Expect, and watch:

| Workflow | What happens |
|---|---|
| `release.yml` | Fires (the push touches the workflow file). `apps/mcp/package.json` holds a prerelease, so the shape gate passes — and because that exact version is already on npm the run short-circuits as a **no-op**. |
| `release-skill-schema.yml`, `release-recipe-schema.yml` | Fire on the lockfile path. `0.1.6` / `0.1.0` are stable and already published → **no-op**. |
| `release-api.yml` | **Deploys `trusty-squire-api` to Fly**, and its `release_command` runs `prisma db push`. |
| `release-registry.yml` | **Deploys `trusty-squire-registry` to Fly.** |
| `deploy-web.yml` | **Deploys `trustysquire` (trustysquire.ai) to Fly.** |
| `ci.yml`, `mcp-slow-tests.yml` | Run for signal. |

The three Fly deploys are real production rollouts of everything `staging`
accumulated. That is the point of the consolidation — but do it when you can
watch it, not at the end of a day. Check the schema diff before pushing:

```bash
git diff origin/main origin/staging -- apps/api/prisma apps/registry/prisma
```

```bash
gh run list --branch main --limit 10
```

---

## Step 3 — re-target any open PR from `staging` to `main`

```bash
gh-axi pr list
```

For each PR whose base is `staging`:

```bash
gh pr edit <number> --base main
```

Re-targeting can surface new conflicts on the PR; resolve them on the PR branch
before merging. **There must be zero PRs based on `staging` before Step 4.**

> As of this writing the repo has **0 open PRs**, so this step is likely a no-op
> — but check, don't assume.

---

## Step 4 — repo settings, then delete `staging`

Do these in order, in **Settings → Branches** (or via `gh api`):

1. **Default branch is `main`.** Already true today — confirm it, don't change
   it.
   ```bash
   gh-axi repo view          # `branch:` must read `main`
   ```
2. **Move branch protection to `main`.** Per `CLAUDE.md`, `main` is already
   protected (required status checks `secret-scan` + `typecheck` + `test` —
   all three are real `ci.yml` jobs — 0 required approvals, no direct pushes).
   Restore it if you lifted it for Step 1, and delete any rule on `staging`.
   Confirm the required checks still name jobs that exist after this migration:
   ```bash
   gh api repos/Trusty-Squire/trusty-squire/branches/main/protection \
     --jq '.required_status_checks.contexts'
   gh api repos/Trusty-Squire/trusty-squire/branches/staging/protection \
     --jq '.required_status_checks.contexts' 2>/dev/null || echo "no staging rule"
   ```
   Note: with `main` protected and no direct pushes allowed, Steps 1–2 need
   either a PR or a temporary protection lift — decide which before starting
   Step 1.
3. **Delete `staging` — last, and only when all of these are true:**
   - `git diff --quiet origin/staging origin/main` (or `main` is strictly ahead)
   - `gh-axi pr list` shows no PR based on `staging`
   - the [pre-flight checklist](#pre-flight-checklist) below is clear
   ```bash
   git push origin --delete staging
   ```

---

## How to cut a stable release now

Stable is no longer a branch — it is an explicit promotion of `main` HEAD.

1. Make sure `main` holds the rc line you want to promote and that its CI is
   green:
   ```bash
   git fetch origin main
   git show origin/main:apps/mcp/package.json | grep '"version"'   # e.g. 1.1.13-rc.27
   ```
2. Actions → **Release mcp** → **Run workflow**, branch `main`, and enter the
   stable version — the rc version **with the prerelease suffix stripped**
   (`1.1.13-rc.27` → `1.1.13`).
3. The workflow will:
   - refuse anything that is not a bare `X.Y.Z`
   - refuse a version that does not match `apps/mcp/package.json` minus its
     suffix (so a typo like `1.11.3` fails the run instead of permanently
     burning a version number on `latest`)
   - refuse a dispatch from any branch other than `main`
   - no-op if tag `v<version>` exists or npm already serves that version
   - run the same verify gate as an rc, rewrite `apps/mcp/package.json` to the
     stable version **in the runner only**, publish with provenance to
     `latest`, verify the dist-tag and tarball, and cut GitHub release
     `v<version>` targeting `main` HEAD

Nothing is committed back to `main`, so `main` stays on its rc line. **After a
promotion, bump `apps/mcp/package.json` to the next rc** (e.g. `1.1.14-rc.1`) so
the next push to `main` publishes a `next` above the new `latest`.

To promote a version number that is *not* simply the current rc line minus its
suffix (a version jump, say), bump `apps/mcp/package.json` on `main` first, then
dispatch.

**Cutting an rc** is unchanged in spirit: bump `apps/mcp/package.json` to a
prerelease and land it on `main`; the push publishes `next`.

### Verify either release

```bash
npm view @trusty-squire/mcp dist-tags --json
scripts/verify-install.sh @trusty-squire/mcp <version>
```

---

## Pre-flight checklist

### In-repo references to the literal `staging` branch

Regenerate the list before deleting the branch:

```bash
grep -rn "staging" --exclude-dir=node_modules --exclude-dir=.git .
```

Known hits as of this runbook, split by whether deleting `staging` breaks them:

**Breaks on delete — fix before or immediately after Step 4**

| File | What it does |
|---|---|
| `bin/run-operator-mcp-local.sh` | `git fetch origin staging` + resets a dedicated checkout to `origin/staging` on every launch. **Hard-fails once the branch is gone.** Repoint to `main`. |
| `tools/release-mcp.mjs` | `const source = "staging"` — branches every release off `staging`, and PRs prereleases to `staging` / stables to `main`. Needs the new model: branch off `main`, rc PRs → `main`, stable = the `workflow_dispatch`. |
| `tools/__tests__/release-mcp.test.sh` | Fixture renames the test repo's branch to `staging` and asserts `gh pr create --base staging`. Update alongside `release-mcp.mjs`. |

**Stale docs — no runtime impact, but they will mislead agents**

| File | What to fix |
|---|---|
| `CLAUDE.md` | "Branch routing (enforced)" section: feature PRs → `staging`, stable cuts → `main`, and the npm-distribution release SOP. |
| `AGENTS.md` | `gh run list --branch staging` example (~L127); the `main`=stable / `staging`=prerelease rules (~L390-401); the schema-bump prerelease-shape rule (~L427); the operator-MCP `origin/staging` note (~L658). |
| `apps/mcp/RELEASING.md` | "derives the next RC from `origin/staging`". |
| `docs/OPERATOR-MCP-LOCAL.md` | Whole doc is written around an `origin/staging` checkout. |
| `TODOS.md` | Harvester Phase 4: "draft PRs against staging". |

**Not branch references — leave alone**

`apps/registry/**` and `apps/mcp/src/skill-cli/cli.ts` use "staging" for the
skill-lifecycle staging slot; `apps/web/next.config.ts` and
`apps/api/src/server.ts` use it to mean a staging *environment*;
`apps/mcp/CHANGELOG.md`, `corpus/**/*.har` and `replay-eval-output/` are
historical records.

### External checks the maintainer must confirm manually

None of these are visible from the repo — confirm each before `git push origin
--delete staging`:

- [ ] **Fly deploys.** `release-api.yml` / `release-registry.yml` /
      `deploy-web.yml` are the only deploy paths and are now `main`-only. Check
      that neither `trusty-squire-api`, `trusty-squire-registry` nor
      `trustysquire` has a *separate* Fly GitHub integration watching `staging`
      (`flyctl apps list`, then the app's GitHub settings).
- [ ] **Any external CI / preview host** (Vercel, Netlify, Cloudflare Pages,
      Codecov, Renovate/Dependabot base branch) configured against `staging`.
      Repo → Settings → Integrations, plus each provider's dashboard.
- [ ] **Repo webhooks** filtered on `refs/heads/staging`:
      Settings → Webhooks, and
      `gh api repos/Trusty-Squire/trusty-squire/hooks --jq '.[].config.url'`.
- [ ] **Branch-name filters in other Trusty-Squire repos** — notably
      `Trusty-Squire/trusty-squire-housekeeper`, which runs from a source
      checkout and may pin a branch.
- [ ] **Local clones and worktrees** (the captain's machine, firstmate lanes,
      treehouse pools) sitting on `staging`. After deletion:
      `git fetch --prune origin && git checkout main`.
- [ ] **Saved `gh` / CI aliases and dashboards** filtered by
      `--branch staging`.

---

## Captain's MCP config

**No change needed.** The captain's MCP config pins `@trusty-squire/mcp@next`.
`next` keeps meaning "the current rc line" — it is simply published from `main`
instead of `staging` after this migration. Today `next` is `1.1.13-rc.27` and
`latest` is `1.1.12`; both dist-tags survive the migration untouched, because
nothing in this change unpublishes or re-tags anything.

The first post-migration rc pushed to `main` moves `next` forward exactly as a
`staging` push used to.

---

## Rollback

Nothing here is destructive until Step 4.

- **Before `staging` is deleted:** revert the workflow PR; `staging` still
  exists and the old triggers come back with it.
- **After `staging` is deleted:** re-create it from the merge parent recorded in
  the consolidation commit —
  ```bash
  git push origin $(git rev-parse origin/main^2):refs/heads/staging
  ```
  (`origin/main^2` is the `staging` side of the Step 1c merge commit; in Case A
  there is no second parent and `staging` was an ancestor of `main`, so
  `git push origin origin/main:refs/heads/staging` restores it.)
- **npm is never rolled back.** A published version cannot be reused. If a
  promotion publishes the wrong stable version, deprecate it and move `latest`
  forward with the next correct promotion — do not attempt to unpublish.
