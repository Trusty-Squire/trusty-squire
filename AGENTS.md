# AGENTS.md — rules for AI coding agents in this repository

> If you are an AI agent (Claude, Goose, Codex, Cursor, Cline, Continue, …) working in this repo, read this file fully before taking any action that publishes, deploys, or modifies external state. Re-read it before claiming any such action succeeded.

## TL;DR — the three rules that matter most

1. **Never trust stdout alone.** `npm publish` can print `+ @trusty-squire/mcp@0.6.13` while the upload fails. `gh run view` can show old successful runs instead of the run you just triggered. Always verify external state with an independent read.

2. **Run `scripts/verify-install.sh <pkg> <version>` before claiming publish success.** This script is the single source of truth. It downloads the tarball from npm, unpacks it, and validates the content. If it fails, you failed. If you skip it, you hallucinated.

3. **Distinguish your prose from tool output.** You will be tempted to re-read your own confident claims ("✓ verified", "shipped to npm") as if they were facts. They are not. Facts come from tools. Keep a structured evidence ledger with timestamps and tool attribution. Never assert success without quoting the tool output that proves it.

---

## Never claim a publish succeeded without proof

### The canonical verification tool

**Location:** `scripts/verify-install.sh`

**Signature:**
```bash
scripts/verify-install.sh <pkg> <version> [<sentinel>]
```

**What it does:**
- Queries `https://registry.npmjs.org/<pkg>/<version>` (direct registry, bypasses CDN)
- Downloads the actual tarball
- Unpacks it to a temporary directory
- Optionally searches for a sentinel string to verify content
- Exits 0 only if all steps succeed

**When to run it:**
- Immediately after `npm publish` or `pnpm publish` returns
- Before claiming any version is "live", "shipped", "published successfully", or "verified"
- When debugging why users report "package not found"
- When in doubt

**What counts as proof:**
The script must exit 0 AND print output showing:
- Tarball download succeeded
- Extraction succeeded
- Sentinel found (if provided)

Example of valid proof:
```
$ scripts/verify-install.sh @trusty-squire/mcp 0.6.13
✓ Fetched metadata for @trusty-squire/mcp@0.6.13
✓ Downloaded tarball (542 KB)
✓ Extracted successfully
✓ Package verified
```

If the script exits non-zero or prints errors, the publish FAILED, even if `npm publish` claimed otherwise.

### What does NOT count as proof

- `npm publish` stdout containing `+ @trusty-squire/mcp@0.6.13`
  - *A prior agent burned four version numbers trusting this. The npm CLI prints this line before upload completes. Network failures, auth issues, and registry errors can occur after this line prints.*

- `npm view @trusty-squire/mcp version` returning `0.6.13`
  - *This queries the default registry, which is CDN-cached. Stale data can persist for hours.*

- `curl https://registry.npmjs.org/-/package/@trusty-squire/mcp/dist-tags`
  - *Fastly CDN caches this endpoint aggressively. A prior agent declared victory while this returned `{"latest":"0.6.12"}` for 90 minutes after 0.6.13 allegedly shipped.*

- Your own prior chat messages saying "✓ published"
  - *You wrote that prose before you had proof. It is not evidence. It is a prediction. Re-reading your predictions does not make them true.*

- GitHub Actions logs showing a successful `publish` job
  - *The job can succeed while the artifact is invalid. The tarball might be empty, truncated, or missing the sentinel file.*

### The failure mode that matters most

A prior agent claimed to publish 0.6.13, 0.6.14, 0.6.15, and 0.6.16 in sequence. None shipped on the first attempt. In one case, the version number was registered in the npm registry (so `npm view` returned it), but the tarball was never uploaded — users got 404s. In another case, `pnpm publish` silently applied the `--tag next` flag (workspace mode behavior) so the package existed but `npm install @trusty-squire/mcp` still fetched the old version.

**The rule:** If you did not run `scripts/verify-install.sh` and see it pass, you do not know whether the publish succeeded. Full stop.

---

## Endpoints that lie vs endpoints that tell the truth

### Endpoints that lie (CDN-cached, optimistic, or incomplete)

| Endpoint | Why it lies | Cache duration |
|----------|-------------|----------------|
| `https://registry.npmjs.org/-/package/@trusty-squire/mcp/dist-tags` | Fastly CDN cache | Up to 5 minutes, observed 90+ minutes in practice |
| `npm view @trusty-squire/mcp` (default registry) | Same CDN backing | Same |
| `npm publish` stdout | Prints `+` line before upload finishes | N/A (not cached, just premature) |
| `gh run view <old-id>` | Shows the run you pass it, not the run you just triggered | N/A (user error) |
| `gh run view --log` (without filters) | Prints ALL job logs interleaved, easy to misread | N/A |

### Endpoints that tell the truth

| Endpoint | Why it's trustworthy | Usage |
|----------|----------------------|-------|
| `https://registry.npmjs.org/<pkg>/<version>` | Direct registry query, bypasses CDN | Canonical version metadata |
| `curl -I <tarball-url>` | HEAD request to actual tarball | 200 = exists, 404 = does not exist |
| `npm install <pkg>@<version> --dry-run --json` | npm client does full resolution | Shows what would actually install |
| `gh run list --branch <branch> --limit 1 --json` | Queries API for latest run on branch | Gives you the run you just triggered |
| `gh run view <id> --log-failed` | Shows only failed job logs | Faster failure diagnosis |
| `scripts/verify-install.sh <pkg> <version>` | Downloads and inspects actual artifact | Single source of truth |

### The rule

Before claiming success, query an endpoint from the "truth" column. If an endpoint from the "lies" column disagrees with an endpoint from the "truth" column, believe the truth column.

---

## Reading CI logs correctly

### The SHA confusion failure mode

A prior agent ran `gh run view` without arguments after pushing a commit. GitHub CLI defaults to showing the most recent run in the repo, which was a successful run from 4 hours earlier on a different commit. The agent declared victory. The actual run (on the SHA the agent just pushed) was still queued.

**The rule:** Always filter by SHA or by branch + recency.

**Correct commands:**
```bash
# Get the run ID for the commit you just pushed
gh run list --branch staging --limit 1 --json databaseId,headSha --jq '.[0]'

# Then view that specific run
gh run view <id> --log-failed
```

**Incorrect commands:**
```bash
gh run view  # Shows whatever run GitHub feels like showing
gh run view --log  # Dumps all job logs, easy to mix up verify vs publish
```

### The job-log confusion failure mode

A prior agent ran `gh run view <id> --log` and saw this:

```
verify	✓ Package @trusty-squire/mcp@0.6.13 verified
publish	npm ERR! 404 Not Found - PUT https://registry.npmjs.org/@trusty-squire%2fmcp
```

The agent read the first line, declared victory, and ignored the second line. The `verify` job runs BEFORE the `publish` job and checks the *previous* version. The `publish` job (which actually ships the new version) failed.

**The rule:** 
- Use `--log-failed` to see only failure output
- If you use `--log`, read ALL job outputs, not just the first success
- If the workflow has multiple jobs, check the job named `publish` (or `release`, or whatever actually uploads the artifact)

**Correct usage:**
```bash
# See only what failed
gh run view <id> --log-failed

# Or view a specific job
gh run view <id> --log --job <job-id>
```

### The verdict

If `gh run view <id>` shows conclusion: `failure`, the run failed. Do not cherry-pick success lines from job logs. Do not re-run and hope. Fix the failure, push a new commit, and verify the new run.

---

## Forbidden phrases without evidence

The following phrases are **banned** unless IMMEDIATELY preceded (in the same message, within 10 lines) by the tool output that proves them.

### Banned phrase list

- "✓ verified"
- "✓ published"
- "🎯 shipped"
- "successfully published"
- "now live on npm"
- "version X.Y.Z is available"
- "users can now install"
- "confirmed working"
- "deployment successful"
- "changes are live"

### What "immediately preceded by tool output" means

**Correct:**
```
$ scripts/verify-install.sh @trusty-squire/mcp 0.6.13
✓ Fetched metadata for @trusty-squire/mcp@0.6.13
✓ Downloaded tarball (542 KB)
✓ Extracted successfully
✓ Package verified

✓ verified — @trusty-squire/mcp@0.6.13 is live on npm.
```

**Incorrect:**
```
I published the package using `npm publish`. Let me verify it's working.

[... 30 lines of explanation about what you're about to do ...]

✓ verified — @trusty-squire/mcp@0.6.13 is live on npm.
```

The second example is a hallucination. You wrote "✓ verified" without showing the tool output that proves it.

### The rule

If you want to use a success phrase, paste the tool output first, then say the phrase. If you can't paste the tool output (because you didn't run the tool, or the tool failed), don't say the phrase.

---

## Evidence ledger

### The problem

You have a context window. You will read your own prior messages. You will see phrases like "I published @trusty-squire/mcp@0.6.13 successfully" and you will pattern-match those phrases as facts. They are not facts. They are prose you wrote. Prose is not evidence.

### The solution

Maintain a structured ledger of observations in your working notes or TODO. Every claim about external state gets an entry with:
- **Timestamp** (turn number or wall-clock time)
- **Source** (tool name + arguments)
- **Observation** (the actual output, verbatim or summarized)
- **Conclusion** (what you infer from the observation)

**Example ledger:**
```
## Evidence Ledger

### Turn 42 (2024-01-15 14:32:00)
**Source:** `npm publish`
**Output:** `+ @trusty-squire/mcp@0.6.13`
**Conclusion:** UNKNOWN (npm publish stdout is not proof; need to verify)

### Turn 43 (2024-01-15 14:32:15)
**Source:** `scripts/verify-install.sh @trusty-squire/mcp 0.6.13`
**Output:**
```
✓ Fetched metadata for @trusty-squire/mcp@0.6.13
✓ Downloaded tarball (542 KB)
✓ Extracted successfully
✓ Package verified
```
**Conclusion:** CONFIRMED — @trusty-squire/mcp@0.6.13 is live on npm.

### Turn 50 (2024-01-15 14:45:00)
**Source:** User report
**Output:** "npm install @trusty-squire/mcp still pulls 0.6.12"
**Conclusion:** CONFLICT — verify-install passed but user sees old version; likely CDN cache issue or dist-tag mismatch.
```

### The rule

Before asserting that X is true, check your evidence ledger. If the most recent entry for X is "UNKNOWN" or "CONFLICT", you do not have proof. Do not assert. Instead, run another tool or ask the user.

**Corollary:** Never delete old ledger entries when they conflict with new observations. The conflict itself is data. It tells you the system state is subtle (e.g., CDN lag, tag mismatch, partial failure).

---

## When in doubt, ask the user

### The escalation protocol

You are an agent. You have tools. You can read logs, query APIs, and run scripts. But you cannot:
- Wait 90 minutes for a CDN cache to expire
- Access the npm account's auth token to debug registry rejections
- Know whether the user *intended* to publish as `--tag next` vs `--tag latest`
- Decide whether to burn another version number or wait and retry

**The rule:** If `scripts/verify-install.sh` fails, stop and ask the user before continuing.

**Scenarios that require escalation:**
1. `scripts/verify-install.sh` exits non-zero
2. The verify script passes but the user reports the package is unavailable
3. `gh run view` shows a `publish` job failed
4. You are about to publish version N+2 because N+1 failed
5. You see `--tag next` in the publish output but expected `--tag latest`
6. You cannot determine which GitHub Actions run corresponds to the commit you just pushed

**What "ask the user" looks like:**
```
The publish appears to have failed. Here's what I observed:

$ npm publish
+ @trusty-squire/mcp@0.6.13

$ scripts/verify-install.sh @trusty-squire/mcp 0.6.13
✗ Failed to fetch metadata: 404 Not Found

The npm CLI printed a success message, but the registry does not have the tarball. This is consistent with an auth failure or a race condition in the registry.

Options:
1. Retry the publish (burns another version number: 0.6.14)
2. Wait 5 minutes and re-run the verify script (in case of registry lag)
3. Investigate the npm auth token

Which would you like me to do?
```

**What "ask the user" does NOT look like:**
```
Hmm, that's weird. Let me try publishing 0.6.14 instead.
```

The second example is you guessing. Guessing burns version numbers, confuses users, and fills the registry with broken releases.

---

## Repository-specific gotchas

### 1. Dual release workflows

This repo has TWO release workflows:
- `.github/workflows/release.yml` — publishes the main MCP package (`@trusty-squire/mcp`)
- `.github/workflows/release-skill-schema.yml` — publishes the adapter SDK (`@trusty-squire/skill-schema`)

**The rule:** When releasing, check which workflow corresponds to the package you're publishing. Do not assume `release.yml` handles everything.

### 2. `pnpm publish` and the `--tag` footgun

In a pnpm workspace, `pnpm publish` has surprising tag behavior:
- If the workspace root has `publishConfig.tag`, that tag is used
- If the package version contains a prerelease identifier (e.g., `0.6.13-staging.1`), pnpm infers `--tag next`
- If neither applies, `--tag latest` is used

**A prior agent published 0.6.13 with pnpm and the package was tagged `next` instead of `latest`. Users running `npm install @trusty-squire/mcp` continued to receive 0.6.12.**

**The rule:** After publishing with pnpm, verify the dist-tag:
```bash
npm dist-tag ls @trusty-squire/mcp
```

If you see `latest: 0.6.12` and `next: 0.6.13`, but you intended 0.6.13 to be latest, fix it:
```bash
npm dist-tag add @trusty-squire/mcp@0.6.13 latest
```

### 3. `MCP_SKIP_PACK_SMOKE=1` in CI

The release workflows set `MCP_SKIP_PACK_SMOKE=1` to skip smoke tests during the pack step. This is intentional (smoke tests run in a separate job). Do not remove this variable or the pack step will hang.

### 4. Inode exhaustion with `pnpm install`

On some CI runners (especially GitHub Actions' `ubuntu-latest`), `pnpm install` can exhaust inodes if the cache is corrupt. If you see:
```
ENOSPC: no space left on device, mkdir '/home/runner/.pnpm-store'
```

But `df -h` shows plenty of disk space, the issue is inodes, not bytes.

**The fix:**
```bash
rm -rf ~/.pnpm-store
pnpm install --no-frozen-lockfile
```

Or in CI:
```yaml
- name: Clear pnpm cache
  run: rm -rf ~/.pnpm-store
```

### 5. Staging branch requires prerelease versions

The `staging` branch is for testing. Releases from `staging` MUST have a prerelease identifier:
- ✅ `0.6.13-staging.1`
- ✅ `0.6.13-rc.1`
- ❌ `0.6.13` (stable version on staging is forbidden)

The `main` branch is for stable releases. Releases from `main` MUST NOT have a prerelease identifier:
- ✅ `0.6.13`
- ❌ `0.6.13-staging.1` (prerelease version on main is forbidden)

**The rule:** Before cutting a release, check the branch name. If `git branch --show-current` returns `staging`, the version in `package.json` must contain a hyphen. If it returns `main`, the version must not contain a hyphen.

### 6. The `verify` job runs before the `publish` job

In `.github/workflows/release.yml`, the job order is:
1. `build` — compiles the package
2. `verify` — installs the PREVIOUS version from npm and runs tests against it (sanity check)
3. `publish` — uploads the NEW version

**A prior agent confused `verify` success with `publish` success.** The `verify` job passing means the previous release was not broken. It does not mean the new release succeeded.

**The rule:** When checking CI logs, look for the job named `publish` (or `release`, or `upload`). If that job failed, the release failed, even if `verify` passed.

---

## Final note

You are reading this file because a prior agent burned four version numbers, confused users, and forced a human to intervene. The agent was not malicious. It was not lazy. It was pattern-matching on its own prose instead of on tool output.

You will be tempted to do the same. You will write "✓ published" and then re-read that phrase 50 tokens later and believe it. Resist that temptation.

**The meta-rule:** When you are about to claim success, pause and ask: "What tool output proves this claim?" If you cannot quote the tool output in the same message, you are hallucinating. Stop, run the tool, get the proof, then make the claim.

If you follow this file's rules, you will not burn version numbers. If you skip them because you're confident, you will burn version numbers. Confidence is not evidence.

Read this file. Follow the rules. Run the verify script. Paste the output. Then claim success.

---

## Skill-Promotion Pipeline (autonomous loop)

How a successful provision becomes a replayable, registry-published **Skill** —
fully automatically, no human in the path. This is the "maximize skills in the
registry" half of the autonomous loop; the runtime/retry half is the provision
state machine + policy (`packages/skill-schema/src/provision-state.ts`).

### Pipeline: capture → synthesize → sign → publish → verify → active

```
virgin signup succeeds on an UNCOVERED service (no active skill in registry)
  1. CAPTURE     bot/onboarding-capture.ts — one integrity-chained JSON sidecar
                 per post-verify round (state + inventory + the planner's chosen
                 step) under ~/.trusty-squire/corpus/onboarding/. A run-outcome
                 sidecar records ok + credential field NAMES (never values).
  2. SYNTHESIZE  bot/promote-to-skill.ts promoteToSkill() — PURE function: verify
                 the hash chain → PostVerifyStep[]→SkillStep[] → infer signup_url/
                 oauth_provider/entry_state → multi-cred dispatch → infer
                 credential spec+validators → Zod-validate. Same captures ⇒ same
                 skill_id (SHA-256 derived).
  3. SIGN        tools/provision-any.ts runAutoPromote() — Ed25519 over canonical
                 bytes (SKILL_SIGNING_PRIVATE_KEY, else an ephemeral key).
  4. PUBLISH     POST {TRUSTY_SQUIRE_REGISTRY_URL}/skills {skill, signature}.
                 Idempotent on skill_id (201 new / 200 present).
  5. VERIFY-GATE signup_url/oauth_provider changes land `pending-review`; the
                 verifier worker replays; only a clean replay → `active`.
```

### Trigger rule the loop owns

- The discover queue includes uncovered services; the loop runs a **virgin**
  provision against each. On `success`, auto-promote fires (default-on;
  `TRUSTY_SQUIRE_AUTO_PROMOTE`, opt-out `0`/`off`), **fire-and-forget** — a
  synthesis/network failure is logged `[auto-promote]` and never fails the signup.

### Contracts you MUST keep when touching this pipeline

- **Determinism / idempotency.** Same captures ⇒ byte-identical skill ⇒ same
  `skill_id`. No `Date.now()`/`Math.random()` in skill bytes. Re-promote = no-op.
- **Single-cred byte-equivalence.** A new synthesizer feature must not shift the
  canonical bytes of existing single-cred fixtures (shadow test guards this); ride
  an **optional** field (`entry_state`, `dom_hint`) emitted only when applicable.
- **Storage = registry, not git.** "Commit a skill" = `POST /skills`. Do NOT
  write skill files into the repo.
- **No real credentials in fixtures** (captures redact to field NAMES). A leaked
  real key = rotate + delete the account.
- **Write-only vault** — no path reads a secret back; promotion never needs to.
- **failure-taxonomy / provision-state are shared** in `@trusty-squire/skill-schema`
  so the registry and the mcp client agree. Change them there; never fork.

### Reference

- `packages/skill-schema/src/skill.ts` (`SkillSchema`, `entry_state`)
- `packages/skill-schema/src/provision-state.ts`, `provision-policy.ts`
- `apps/mcp/src/bot/promote-to-skill.ts`, `apps/mcp/src/bot/onboarding-capture.ts`
- `apps/mcp/src/tools/provision-any.ts` (`runAutoPromote`)
