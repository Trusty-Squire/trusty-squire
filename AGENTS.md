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
  - _A prior agent burned four version numbers trusting this. The npm CLI prints this line before upload completes. Network failures, auth issues, and registry errors can occur after this line prints._

- `npm view @trusty-squire/mcp version` returning `0.6.13`
  - _This queries the default registry, which is CDN-cached. Stale data can persist for hours._

- `curl https://registry.npmjs.org/-/package/@trusty-squire/mcp/dist-tags`
  - _Fastly CDN caches this endpoint aggressively. A prior agent declared victory while this returned `{"latest":"0.6.12"}` for 90 minutes after 0.6.13 allegedly shipped._

- Your own prior chat messages saying "✓ published"
  - _You wrote that prose before you had proof. It is not evidence. It is a prediction. Re-reading your predictions does not make them true._

- GitHub Actions logs showing a successful `publish` job
  - _The job can succeed while the artifact is invalid. The tarball might be empty, truncated, or missing the sentinel file._

### The failure mode that matters most

A prior agent claimed to publish 0.6.13, 0.6.14, 0.6.15, and 0.6.16 in sequence. None shipped on the first attempt. In one case, the version number was registered in the npm registry (so `npm view` returned it), but the tarball was never uploaded — users got 404s. In another case, `pnpm publish` silently applied the `--tag next` flag (workspace mode behavior) so the package existed but `npm install @trusty-squire/mcp` still fetched the old version.

**The rule:** If you did not run `scripts/verify-install.sh` and see it pass, you do not know whether the publish succeeded. Full stop.

---

## Endpoints that lie vs endpoints that tell the truth

### Endpoints that lie (CDN-cached, optimistic, or incomplete)

| Endpoint                                                            | Why it lies                                               | Cache duration                                    |
| ------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------- |
| `https://registry.npmjs.org/-/package/@trusty-squire/mcp/dist-tags` | Fastly CDN cache                                          | Up to 5 minutes, observed 90+ minutes in practice |
| `npm view @trusty-squire/mcp` (default registry)                    | Same CDN backing                                          | Same                                              |
| `npm publish` stdout                                                | Prints `+` line before upload finishes                    | N/A (not cached, just premature)                  |
| `gh run view <old-id>`                                              | Shows the run you pass it, not the run you just triggered | N/A (user error)                                  |
| `gh run view --log` (without filters)                               | Prints ALL job logs interleaved, easy to misread          | N/A                                               |

### Endpoints that tell the truth

| Endpoint                                         | Why it's trustworthy                   | Usage                                |
| ------------------------------------------------ | -------------------------------------- | ------------------------------------ |
| `https://registry.npmjs.org/<pkg>/<version>`     | Direct registry query, bypasses CDN    | Canonical version metadata           |
| `curl -I <tarball-url>`                          | HEAD request to actual tarball         | 200 = exists, 404 = does not exist   |
| `npm install <pkg>@<version> --dry-run --json`   | npm client does full resolution        | Shows what would actually install    |
| `gh run list --branch <branch> --limit 1 --json` | Queries API for latest run on branch   | Gives you the run you just triggered |
| `gh run view <id> --log-failed`                  | Shows only failed job logs             | Faster failure diagnosis             |
| `scripts/verify-install.sh <pkg> <version>`      | Downloads and inspects actual artifact | Single source of truth               |

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
gh run list --branch main --limit 1 --json databaseId,headSha --jq '.[0]'

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

The agent read the first line, declared victory, and ignored the second line. The `verify` job runs BEFORE the `publish` job and checks the _previous_ version. The `publish` job (which actually ships the new version) failed.

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
- Know whether the user _intended_ to publish as `--tag next` vs `--tag latest`
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

### 5. Single-`main` release model

The dual-branch release rule is superseded. The authoritative release contract
and maintainer cutover steps are in
[`docs/single-main-migration.md`](docs/single-main-migration.md).

### 6. The `verify` job runs before the `publish` job

In `.github/workflows/release.yml`, the job order is:

1. `build` — compiles the package
2. `verify` — installs the PREVIOUS version from npm and runs tests against it (sanity check)
3. `publish` — uploads the NEW version

**A prior agent confused `verify` success with `publish` success.** The `verify` job passing means the previous release was not broken. It does not mean the new release succeeded.

**The rule:** When checking CI logs, look for the job named `publish` (or `release`, or `upload`). If that job failed, the release failed, even if `verify` passed.

### 7. `release.yml`'s workspace-dep build step is an explicit list, not a glob — keep it in sync

Unlike `ci.yml` (which builds every `packages/**` dist generically via `pnpm -r --filter "./packages/**" --if-present build`), `.github/workflows/release.yml`'s "Build mcp's workspace deps" steps (both the `verify` and `publish` jobs) name mcp's workspace deps **explicitly**: `pnpm --filter '@trusty-squire/skill-schema' --filter '@trusty-squire/recipe-schema' build`. This is deliberate — `release.yml` installs only mcp's filtered dep tree (`--filter '@trusty-squire/mcp...'`), so a blind `./packages/**` glob would also try to build packages mcp doesn't depend on (e.g. `packages/vault`, never installed in this job) and fail.

**The rule:** When `apps/mcp/package.json` gains a new `@trusty-squire/*` workspace dependency (a new `packages/*` package), add it to the `--filter` list in **both** `release.yml` build steps. Missing this makes every "Release mcp" CI run fail at the `Test (MCP package only)` step with `Failed to resolve entry for package "@trusty-squire/<new-pkg>"` — a fresh clone never builds that package's `dist/`, so vitest's vite resolver can't follow its `main`. This exact bug shipped when `@trusty-squire/recipe-schema` was added (fixed in `fm/fix-release-recipe-schema-build`) — nothing published to npm `next` from `1.1.8-rc.1` until it did.

### 8. `recipe-schema`/`skill-schema` publish is version-driven — a source change alone does NOT republish

`release-recipe-schema.yml` and `release-skill-schema.yml` both trigger only on a push whose diff touches that package's `package.json` (path-filtered — see the `on.push.paths` list in each workflow). A commit that changes `packages/recipe-schema/src/**` without bumping `packages/recipe-schema/package.json`'s `version` does not fire the workflow at all, so npm keeps serving the pre-change tarball indefinitely — mcp's `workspace:*` dep resolves fine locally (same checkout) but a real `npx @trusty-squire/mcp` install gets the stale published package and can crash on a missing export.

**This exact bug shipped**: PR #450 added `checkoutFieldSetSignature` to `packages/recipe-schema/src/operator-recipe.ts` without bumping the version past the `0.1.0-rc.1` PR #449 had already published, so `@trusty-squire/mcp@1.1.9-rc.1` crashed at import (`SyntaxError: @trusty-squire/recipe-schema missing checkoutFieldSetSignature`) — fixed by bumping to `0.1.0-rc.2` on `fm/fix-recipe-schema-republish`.

**The rule:** any PR that changes `packages/recipe-schema/src/**` or `packages/skill-schema/src/**` MUST bump that package's `version` in the same PR. Schema releases publish stable versions from `main`; see the authoritative single-branch contract in [`docs/single-main-migration.md`](docs/single-main-migration.md). Verify a bump actually shipped the change with `npm view @trusty-squire/<pkg> versions --json` and `npm pack --dry-run` / grepping `dist/index.js` for the new export, not just by reading the source.

### 9. `Locator.selectOption({ value })` doesn't fail fast on a value-format mismatch — it eats the full 30s actionability timeout

Playwright's `selectOption({ value })` (and `{ label }`) treats "no `<option>` with that value" as an actionability precondition it retries, not an immediate error — an already-visible, already-enabled `<select>` with simply the wrong value/label still hangs for the **default 30s** before rejecting. This bit `apps/mcp/src/bot/browser.ts`'s checkout card-fill (`fillCheckoutCardIntoFrames`'s `fillFirst`), which tries `selectOption({ value })` then falls back to `selectOption({ label })` for `<select>`-based expiry fields — e.g. a JP EbisuMart-platform expiry-year `<select>` with 2-digit `<option value="26">2026</option>` values: filling a 4-digit `exp_year` misses on `{ value }` and only succeeds on the `{ label }` fallback, so every such fill silently cost 30s until this was caught by a Hibiya Kadan checkout repro (no test in this repo had exercised a real `<select>`-based expiry field before).

**The rule:** any `selectOption()` call written on the expectation that a miss falls through to another attempt (a value→label fallback, a try/catch retry, etc.) MUST pass an explicit short `{ timeout }` (3000ms in the existing fixes) — never rely on the default. This applies to any future `<select>` fill code in this file (address/country dropdowns included), not just card expiry.

### 10. Payment is driven through generic observation and actions

The operator does not own a checkout state machine. The agent reads the same
masked DOM, network, console, exception, and screenshot evidence used for other
browser work, then drives ordinary click/type/select/press/scroll/wait actions.
`inject_card` only releases and writes the named card fields; it never searches
for providers, chooses a saved/new card, submits, re-reads totals, clears fields,
or claims a payment outcome. Do not restore payment status stages, submitter
guessing, post-submit custody, or checkout cleanup sweeps.

3-D Secure is notification-only. After a card release, the operator detects a
rendered challenge on the next observation or action result, nudges the
cardholder once through the API notify path, and reports `three_ds`
(`observedThreeDsChallenge` in `apps/mcp/src/bot/provision-session.ts`). It never
blocks, waits on, gates, or takes custody of the challenge; the human completes
it in their bank app and the agent keeps observing.

### 11. Released PAN and security code have one narrow output boundary

Before the first card write, register the released PAN and CVV/CVC/CID plus the
injected node identities in the session's card-value output mask. Every
model-facing DOM/AX property, attribute, text, URL, header, body, error,
diagnostic, log, trace, and screenshot passes through that mask. The record
survives failed fills, clearing, re-rendering, and navigation for the browser
session, and it never gates a browser action.

Mask only the released PAN (complete ordinary formatting variants and prefixes
of at least eight digits) and security code, replacing them with `[card number]`
and `[security code]`.
Keep merchant last4, brand/issuer, name, expiry, billing address, amount,
currency, DCC, OTP/3DS text, HTTP bodies, API keys, cookies, and other page data
visible. This is not a general secret scanner or Luhn detector. The boundary is
designed for ordinary forms and hosted-field checkouts; hostile pages that
transform secrets into split, encoded, or canvas copies are outside the claim.
Raw live runtime evaluation remains internal rather than a public read API.

### 12. Broker browser custody and session tab lifetime

The broker exclusively owns the physical operator browser; sessions own independent
families of tabs. Preserve the election, physical-profile lease, and process-marker
watchdog/reaper contracts in [`docs/browser-broker.md`](docs/browser-broker.md).
A resident broker whose credential no longer matches the enrolled agent session
token is reclaimed or refused by that guide's stale-credential contract; do not
diagnose it as a missing CLI kill-switch. `stale_lease` means another connection
owns a live session, never a session that was never created — a wall-refused
start's `session_id` replays its wall. The underlying bounded teardown and
accepted reparented-idle-renderer residual are
in [`docs/DESIGN-warm-browser-reuse.md`](docs/DESIGN-warm-browser-reuse.md#5-ownership-crash-recovery-and-containment).
Never replace identity-proven Chrome containment with root-PID-only signaling or
broad `pkill`. The strict containment follow-up remains
`ts-operator-browser-cgroup-containment` in `TODOS.md`.

### 13. OAuth identity uses the real profile and a narrow lease

Every OAuth action routed through `operate_login` stays in the single real
`CHROME_PROFILE_DIR` browser context. The serialized boundary preserves the
authorized target and delegates to `loginWithOAuth`; never copy cookies, restore
storage state, swap browsers, or add a parallel OAuth driver.

`operate_start` never requires or probes a Google session. Operations that
actually depend on Google identity (Google OAuth, Google-backed signup
preparation, and Gmail verification) call `detectSessionProviders()` on the
live context and feed it to `googleSessionGate` at that operation boundary.
An OPERATOR session's identity answer still comes from that live context — do
not substitute a cookie-database read for it.

Connect's ceremony and its exception for cookie-snapshot probes are owned by
[`docs/browser-broker.md`](docs/browser-broker.md). Do not apply that exception
to operator identity admission.

### 14. MCP tests have fast, real-browser, and post-merge-slow tiers

`apps/mcp/vitest.tiers.ts` is the static tier manifest. Tiers run whole files —
never select or shard individual test names.

- **fast (`test:fast`)** — gates every PR (ci.yml) and every publish
  (`release.yml` verify, rc and stable alike). Non-browser only: real-browser
  files are excluded via `REAL_BROWSER_FILES`.
- **real-browser (`test:real-browser`)** — every test that launches
  Chromium/Chrome (`REAL_BROWSER_FILES`, incl. the browser halves of
  `REQUIRED_BEHAVIOR_FILES`/`REQUIRED_PAYMENT_SAFETY_FILES`). Runs post-merge
  in `.github/workflows/mcp-slow-tests.yml` and gates ONLY a stable/`latest`
  release (release.yml dispatch; skipped for rc/`next` prereleases and PRs).
  Never re-add these files to a PR or prerelease gate — they are the slow,
  flaky tail that made rc cuts painful.
- **slow (`test:slow`)** — genuinely slow NON-behavioral files only (corpus
  evals, packaging smoke, replay harness). Never move non-browser
  card-sealing, payment-safety, or operator behavior coverage here.

The nightly full suite (`vitest run`) remains the partition-drift backstop.
When adding a test that launches a browser, list it in `REAL_BROWSER_FILES`;
when adding non-browser behavior coverage, list it in the REQUIRED_* files.

Vitest `--related` is not usable on this package. `provision-session.ts`,
`browser.ts`, and `act.ts` are hubs: a transitive walk collapses to the
operator cone (~134 files) for almost any leaf. Select tests with
`apps/mcp/scripts/run-related-tests.mjs` (own test + direct importers +
one hop of non-hub production callers). Do not call `vitest related`.

Validation fail-closed policy lives in `apps/mcp/scripts/validation-plan.mjs`
and is executed by `apps/mcp/scripts/run-validation-tests.mjs`. When the
map cannot prove a test irrelevant it runs `test:fast`, not the full
suite. Only the real-browser / broker / vitest / lockfile cone pays a
full `vitest run`. A mapper bug here skips tests, so treat a planner
failure as a safety regression, not a test to weaken.

### 15. Operator browser lifetime is owner-bound

`apps/mcp/src/bot/owner-process-reaper.ts` is the crash/SIGKILL backstop for
self-managed and Playwright-launched local operator browsers. Every local launch
must receive the private operator marker at the shared launch boundary; never
register external/remote CDP browsers. The manifest records exact PID/group,
marker, process birth identity, and `user_data_dir`; it owns process signaling,
not profile or snapshot deletion. Physical profile custody follows
[`docs/browser-broker.md`](docs/browser-broker.md). Process teardown uses bounded
SIGTERM→SIGKILL.

Idle cleanup uses the provision-session call lease as its action boundary. Any new
session-addressed operate/auth/payment surface must acquire that lease, and session
teardown must clear its rolling observe snapshot before removing the live session.
That lease, the watchdog, and the whole terminal-teardown ordering now live in
`apps/mcp/src/bot/session/lifecycle.ts` (`provision-session.ts` re-exports them);
see CLAUDE.md's "Operator session model" for what may not be reordered.

### 16. Reads stay direct except for the narrow released-card value mask

Observation and screenshot reads remain verbatim except for the session's
released PAN (complete ordinary spellings and prefixes of at least eight digits)
and security code. Do not widen that exception into
general secret screening, a content seal, or a read refusal. The authoritative
policy and implementation map are in
[`docs/observation-model.md`](docs/observation-model.md) §4.5; read that section
before touching this area. Credential selection is a separate contract owned by
[`docs/operator-tool-surface.md`](docs/operator-tool-surface.md#credential-capture-and-retrieval).
The canonical DOM capture, identity, query, and fixture contracts live in
[`docs/browser-use-serializer-port.md`](docs/browser-use-serializer-port.md).

### 17. `await_verification` must score link-picking on anchor TEXT too, and must retry through Gmail's own transient backend error

Two failure modes measured live during a Xata Keycloak account-link signup
(rc.25), both in `pickVerificationLink`/`awaitVerification`
(`apps/mcp/src/bot/email-verification.ts`, `apps/mcp/src/bot/provision-session.ts`):

- A verification email's action link is often rewritten by the sender's ESP
  into an opaque, per-recipient click-tracking URL (SendGrid/Mailgun/
  Customer.io/Postmark-style) — no verify/login/token vocabulary survives in
  the href at all. `pickVerificationLink` takes an optional
  `VerificationLinkCandidate {url, text}` and scores the anchor's visible
  text/label the same way it scores the href, so the button's own words
  ("Link your Google account") still resolve it. Any caller reading real
  DOM links must pass the anchor text, not just the href — a bare
  `string[]` of hrefs silently loses this signal.
- Gmail's own search backend intermittently throws "...encountered a
  problem (#2014) - Retrying in Ns" and can render "No messages matched
  your search" during that window even though the message exists.
  `awaitVerification`'s inbox read detects that banner (`isGmailTransientErrorText`)
  and an accompanying empty-looking render (`isEmptyGmailResultText`) and
  retries with bounded backoff (`gmailTransientBackoffMs`, capped at 4s)
  before accepting a result as final. Do not treat a single empty/erroring
  Gmail search read as proof the message hasn't arrived.

### 18. `fetch_credential` is the ONLY raw-value path, and it is not the agent's to open

The vault stays a write-only sink for everything the agent can do alone.
`fetch_credential` returns a raw credential value only after the USER signs
that specific fetch with their passkey — first call mints an approval link and
NO value, the resume with the returned `approval_id` delivers the value once.

Three things about it are load-bearing; do not "simplify" any of them:

- **It is a separate approval kind, not a third mutation `operation`.** Its own
  vouch context (`vault_credential_fetch`), store, table, and routes. A signed
  credential-mutation or payment mandate therefore has nowhere to land — the
  refusal is structural, not a check someone can forget to write.
- **Delivery is single-use.** The store's `approved → consumed` conditional
  update is the fence; the decrypt happens only on that transition. Making the
  resume idempotent "for convenience" would turn one approval into unlimited
  reveals.
- **The human half is signer-authenticated, not session-authenticated — and
  the three endpoints do NOT share one rule.** None of them takes a web
  session; the Telegram link opens in whatever browser the human has, exactly
  like the payment path. What differs is what each one demands:
  - `ceremony` is a read. It discloses the bytes to be signed and nothing
    else — no value, no session, no assertion. Reading it authorizes nothing.
  - `approve` is the only one with an authority check, and it is the whole
    control: the Vouchflow assertion must be signed over THIS approval's
    account-bound payload, AND its `device_token` claim must name a signing
    device the owning account registered through the web-session-authenticated
    `POST /v1/vouchflow/devices`. An assertion naming no device is refused
    `missing_device_token`; one naming an unregistered device is refused
    `mandate_signer_not_authorized`; both refuse before the approval moves at
    all. Possession of the link is not authority — the requesting agent
    necessarily holds that link, and without the signer binding anyone it
    reaches could release the owner's secret with their own genuine passkey.
  - `deny` carries NO assertion and asks for no proof. Any caller holding the
    approval id closes it, and the `denied` row it writes names nobody. That
    is deliberate: refusing moves no value, so the conservative answer is the
    one anybody reaching the link may give. Do not "fix" it by demanding an
    assertion, and do not describe it as signer-authenticated.

  Registration is what carries the owner's identity, so keep it
  session-authenticated and keep `approve` refusing unregistered signers; do
  not weaken registration into a self-registering path, and do not answer a
  rollout complaint by putting session auth back on the ceremony.

  **The signer half rests on an UNVALIDATED premise — check it before that
  binding ships.** It reads a `device_token` claim out of the verified JWS, and
  nothing here has confirmed Vouchflow puts that claim inside the JWS rather
  than beside it in the sign-complete HTTP response. The check fails CLOSED: if
  the claim is absent, every reveal and every credential mutation returns
  `403 missing_device_token` — and no test can catch it, because every
  device-bearing JWS in the suite is minted by the suite's own `signHash`. The
  pre-deploy validation (decode one real assertion, confirm three things about
  the claim) and the refusal to ship if any of it fails are owned by
  [`CLAUDE.md`](CLAUDE.md)'s "Unvalidated premise" block — run it before this
  binding ships.
- **Its description is a security control.** It has to keep steering agents to
  `use_credential` first and keep saying that the value lands in the transcript.
  A shorter, friendlier description measurably makes the model reach for the
  raw key when injection would have done.

`apps/api/src/__tests__/credential-fetch.test.ts` and
`apps/mcp/src/tools/__tests__/never-exposed-paths.test.ts` are the oracles.
Contract: [`SECURITY.md`](SECURITY.md#security-model); implementation map:
[`CLAUDE.md`](CLAUDE.md).

### 19. Frame attachment is decided by layout, never viewport visibility — and a failed OOPIF probe must still emit an omission

Shopify's hosted card fields (`checkout.pci.shopifyinc.com` iframes on
`/checkout`) render BELOW the fold. `attachFrames`
(`apps/mcp/src/bot/browser-use-capture.ts`) gated on the iframe node's
viewport `visible` flag, so every offscreen OOPIF was skipped silently — no
elements from the frame AND no `capture_omissions` entry (#778's frame map
was fine; this second gate hid its work). Two invariants in that file:

- **Attachment gates on `rendered` + `bounds`, not `visible`.** A rendered
  iframe with real bounds is capturable wherever it sits; only
  display:none / never-laid-out frames stay unattached (hidden content is
  collapsed by the serializer, not reported).
- **Any qualifying rendered iframe whose child document never reached the
  capture and whose frame could not be resolved yields `frame_attach_failed`.**
  A failed `outOfProcessFramesByCdpId` probe stores no frameId on the node,
  so the old `meta?.frameId !== undefined` condition silently swallowed
  probe failures too. Compact map and omissions must never both be empty for
  a rendered card frame.

Regression: `apps/mcp/src/bot/__tests__/browser-oopif-observation.test.ts`
(the iframe is rendered out of the initial viewport on purpose — keep it that
way). Live repro: `apps/mcp/scripts/oopif-live-diagnostics.ts` (manual
diagnostics, never a test; hits the real whitejade checkout, never orders).

### 20. Hosted card fields are resolved at write time, typed with real keys, and verified by normalised equality

Braintree serves each card box from its own cross-origin iframe and remounts
those frames on its own schedule, so a single `extractInteractiveElements`
walk is not atomic across siblings: a frame mid-remount contributes nothing
and its field silently drops out of a shared snapshot. `inject_card`
(`injectCardIntoTargets` in `apps/mcp/src/bot/browser.ts`,
`injectCardIntoSessionTargets` in `provision-session.ts`) must keep these four
invariants; rc.28 violated the first two and shipped five consecutive live
failures on the Oura/Ring purchase (session `6dcd7859`):

- **Resolve each field at its own write step.** The caller supplies a live
  resolver that re-extracts on every call; never resolve all fields once up
  front from one shared snapshot.
- **Retry a miss inside a bounded window.** `CARD_FIELD_RESOLVE_WINDOW_MS`.
  `not_found` means "still absent after we waited", and `detached` (the ref was
  live in the last observation, so its frame is remounting) is retried rather
  than reported as a non-attempt. Do not turn this into a tool parameter or a
  config knob.
- **Type text fields through `typeWithRealKeys` (one `pressSequentially`, no
  per-character loop).** `handle.fill()` emits no keydown/keypress, and a
  hosted-field client can leave the field `invalid=true` even though the DOM
  value looks right. The released value goes vault → page only; never through
  `operate_type`, a tool result, or a log. The card writer bounds its
  clear-fill and `pressSequentially` waits to `CARD_FIELD_WRITE_TIMEOUT_MS`
  (3s): a frame remounted mid-write leaves the old frame's locator
  permanently unactionable, and Playwright's 30s default burns one refill per
  doomed attempt — starving the bounded retry budget (shipped as three
  consecutive real-browser release-gate failures on `pan=native_error`).
  Ordinary typing callers keep the default; do not widen the bound to them.
- **Verify by normalising both sides for formatting separators, then requiring
  equality.** `actual === expected || digits(actual) === digits(expected)`
  accepts a superset/truncation; a field that is not genuinely equal must
  report `cleared`, never `filled`.

Regression: `apps/mcp/src/bot/__tests__/browser-hosted-field-remount.test.ts`
(three site-isolated OOPIFs on different registrable domains, open shadow
roots, child-driven sibling remounts; 20 consecutive single-call runs — the
loop classifies honestly reported `detached`/`not_found`/`native_error`
misses under the synthetic storm as bounded transients (`≤2` of 20) and fails
absolutely on wrong/partial values, silent misses (`filled`-but-absent),
unknown statuses, or a value not correct after the masked-token re-arm).
Evidence ledger: `data/ts-hosted-field-fill-nondeterministic/findings.md`.

### 21. Captcha auto-solve diagnostics live in the broker daemon's stderr, and token lifetime outpaces sparse observers

`[captcha-autosolve-diag]` lines and `provision-audit` entries go to the
broker daemon's stderr (`~/.trusty-squire/.trusty-squire-broker-leases/launch/broker.log`),
NEVER the MCP server's or operator's log — the operator log shows no solver
output by design. Audit outcome values are sealed; only diag lines and the
`challenge_rendered`/`card_released` booleans are readable. The broker also
rekeys session ids (`broker/operator.ts` `remapSession`), so daemon-side lines
carry an internal id, not the wire session id.

The auto-solve DOES engage on a plain drive (proven live on Kaggle,
`data/ts-recaptcha-autosolve-not-engaging/findings.md`): detect
`challenge_rendered:true` → detached 2Captcha fetch (25s–5min observed) →
inject on the observe after purchase → `ok confirmed=true` → blockers clear.
The reported "never engages, no diag" was a stale shared daemon (npx-cached
old release, stderr → /dev/null) blinding every lane sharing the profile.
Check `ps -o args=` on the daemon pid before concluding "no diagnostics".

**The rule:** before claiming the auto-solve didn't run, read `broker.log`
under the daemon's internal session id; remember `CAPTCHA_TOKEN_LIFETIME_MS`
is 120s — a `token_expired` diag means the observer's cadence, not the
solver, missed the window. A risk engine (Kaggle) can also stop issuing
challenges entirely after repeated cycles; no challenge, no solve.

### 22. Inbox reader: listing rows omit To and group conversations

`operate_read_inbox` (`awaitVerification` in
`apps/mcp/src/bot/capture/verification.ts`) runs in the **broker** process —
a local MCP `server` forwards the tool, so a worktree fix is invisible until
that broker is rebuilt. Listing rows do not show To and one row can group
many same-subject messages. Open a to:-scoped or same-registrable-domain
row; pick the opened message whose To/body is the session recipient.
`mailRowMatchesSender` matches the page host to From on eTLD+1 (and the
display-name SLD), not a substring of `app.service.test`.
`mailRowPredatesSession` floors session start to the minute. Recipient-scoped
reads do not veto a predating listing row — the plus-address pick happens
after open. `TRUSTY_SQUIRE_INBOX_READER_DIAG=1` logs `[inbox-reader-diag]`
to broker stderr (listing, per-row candidate/predates, which row opened,
opened-view yield). No bodies, links, codes, or full From addresses.

## Final note

You are reading this file because a prior agent burned four version numbers, confused users, and forced a human to intervene. The agent was not malicious. It was not lazy. It was pattern-matching on its own prose instead of on tool output.

You will be tempted to do the same. You will write "✓ published" and then re-read that phrase 50 tokens later and believe it. Resist that temptation.

**The meta-rule:** When you are about to claim success, pause and ask: "What tool output proves this claim?" If you cannot quote the tool output in the same message, you are hallucinating. Stop, run the tool, get the proof, then make the claim.

If you follow this file's rules, you will not burn version numbers. If you skip them because you're confident, you will burn version numbers. Confidence is not evidence.

Read this file. Follow the rules. Run the verify script. Paste the output. Then claim success.

---

## Browser launch posture

- **`connect` is the only sign-in command.** Never reintroduce `login`.
  The shared-browser ceremony and fallback contracts are owned by
  [`docs/browser-broker.md`](docs/browser-broker.md); user-facing setup is in
  [README.md](README.md). Machine callers use `connect --json` — the typed
  report (`state`, `sign_in_url`, `account`, `holder`, `browser_location`) is
  built by [`apps/mcp/src/install/connect-report.ts`](apps/mcp/src/install/connect-report.ts)
  and the human copy renders from the same value. Do not parse connect's English.
  One report per run, on EVERY exit path — a `--json` caller must never meet
  an empty stdout. `needs-sign-in` carries its `sign_in_url` by construction
  (the type says so); an outcome with no live URL gets a different state, and
  the ceremony never outlives the pairing token that URL belongs to — as a
  duration counted locally, never by differencing the server's timestamp
  against this machine's clock. A field that names what was OBSERVED (`holder`,
  `browser_location`) carries the observation or an explicit unknown; never an
  assumption made by an error handler. `state` agrees with the exit code: a run
  that fails never reports `connected`, and a `connected` that was read off the
  cookie store rather than probed says so in `reason`. `browser_location` is
  OBSERVED and handed back by whichever path placed the ceremony browser
  (`onBrowserPlacement` in `bot/google-login.ts`) — never predicted from the
  CLI process's own environment — and it never carries an address that will be
  dead when the report is read: the noVNC tunnel dies with the ceremony, so a
  run that did not claim reports `unreachable` rather than naming a display
  nothing can reach. A refusal that means another session holds the browser —
  `ProfileBusyError` or a contention `BrokerRefusal` (`broker_unavailable`,
  `profile_busy`) — reaches connect typed and reports `busy` with the holder,
  read from Chrome's lock OR the operation lease. Every other refusal code is
  the run breaking, not contention, and reports `run_failed`. `account` carries
  the binding whenever the run proved one, `connected` or not, and its
  `providers` is `null` — not `[]` — when the probe could not read the profile. A rejected flag is answered as a
  usage error, never as a connection state. Do not add a report variant no path
  emits.
- **Never quit a Chrome whose profile state you still need with SIGTERM.** Chrome
  routes SIGTERM to its abrupt "session ending" exit and does NOT flush the
  SQLite cookie store (its own commit timer is ~30s out), so a SIGTERM teardown
  seconds after a sign-in silently discards the session that sign-in just
  established — the 2026-09-04 `connect` regression. The ceremony browser quits
  with `BROWSER_QUIT_SIGNAL` (SIGINT) and waits for the graceful exit before
  the owner reaper's SIGTERM → SIGKILL escalation takes over
  (`apps/mcp/src/bot/browser-process-runtime.ts`, re-exported by `browser.ts`);
  the operator owner shares that bounded graceful quit after page/context close.
  `browser-close-cookie.test.ts` proves fresh login cookies survive the local
  launch modes; the original plain-login evidence is in `STATE.md`.
- `BrowserController` local launches stay headed. A real screen wins:
  `hostDisplayAcceptsConnections()` (`apps/mcp/src/bot/display-env.ts`) means
  use the machine display; Xvfb and the noVNC rig exist only on headless
  hosts, or when that display stops answering (a daemon outlives the X session
  that handed it a DISPLAY). `ownedHeadedBrowserEnvironment` in
  `apps/mcp/src/bot/browser-process-owner.ts` is the launch-time gate.
  Do not start Xvfb when the host already has a live screen.
  Launch helpers live in `browser-process-runtime.ts`; the supported local
  and remote-CDP operator paths stay there.
- `apps/mcp/src/bot/broker/runtime.ts` owns Chrome's identity runtime and physical
  profile lease. The broker is the only operator launch path; sessions acquire
  independent tab families and MCP servers forward over IPC. See
  `docs/browser-broker.md` for discovery, election, and recovery.
- Interactive login display custody follows
  [`docs/browser-broker.md`](docs/browser-broker.md); tunnel configuration is
  documented in [README.md](README.md). Never tear down a broker-owned display
  or an externally managed tunnel when closing a ceremony.
- Keep self-launch + `connectOverCDP` and Patchright as the defaults. The
  2026-08-28 read-only A/B used serial, fresh-profile trials against Exa, Groq,
  Cartesia, Replit, Runpod, and Turso from egress `172.93.111.86`:

  | Factor | Arm                            | Content reached |
  | ------ | ------------------------------ | --------------: |
  | Launch | self-launch + `connectOverCDP` |           15/18 |
  | Launch | persistent context             |           15/18 |
  | Driver | Patchright                     |           15/18 |
  | Driver | baseline                       |           15/18 |

  The 72 trials were reachability-only; Replit challenged in every cell. They
  did not exercise interactive Turnstile challenges behind product flows, so the
  result is inconclusive—not evidence to remove either low-cost defense. Changing
  either default requires an interactive, controlled test.

---

## Operator Codex MCP runtime

The operator's Codex MCP runs its dedicated local `origin/main` checkout via
`bin/run-operator-mcp-local.sh`, never a package-manager cache. The wrapper
fetches/resets to main and caches the build by commit plus lockfile digest;
see `docs/OPERATOR-MCP-LOCAL.md` for the installed config and force-rebuild
command. Keep the wrapper's runtime command on `apps/mcp/dist/bin.js server` so
workspace dependencies are built before the server starts.

---

## `page.evaluate` callbacks must be self-contained

Playwright serializes only the callback's source text into the page — the
module's closure does not travel. Keep page callbacks self-contained and test the
real browser path.

A live repro harness run under `tsx` (as the wave-2 studies run theirs) needs a
page-side shim for esbuild's `keepNames` helper, or production paths that call
`elementHandle.evaluate` fail with `ReferenceError: __name is not defined` and
look like a product fault:
`await page.addInitScript({ content: "window.__name = window.__name || function(f){return f;};" })`.

---

## Never touch the operator's live local state from a test or a check

Manual checks must use an isolated `HOME` and `XDG_CONFIG_HOME`, never the
developer's real state. The test suite enforces this through
`apps/mcp/src/__tests__/setup/isolate-config-home.ts`, wired in
`vitest.shared.ts`; preserve that setup and do not resolve the default session
or profile path from a test. The session-storage compatibility contract lives
in `apps/mcp/src/session.ts`.

## Operator tool surface

The public operator contract and capability migration are owned by
[`docs/operator-tool-surface.md`](docs/operator-tool-surface.md).

## Cross-process browser broker

The default broker custody and recovery
contracts live in [`docs/browser-broker.md`](docs/browser-broker.md). Mechanical
fixture acceptance does not qualify real Google auth or prove the current head.

Ask `browserBusy()` / `openTab` in
[`apps/mcp/src/browser-busy.ts`](apps/mcp/src/browser-busy.ts)
(`@trusty-squire/mcp/browser`) instead of inferring availability from a live
socket or tab family. The authoritative busy-status contract and mapping are in
[`docs/browser-broker.md`](docs/browser-broker.md#busy-façade).

The client wire is the frozen Contract B (`connect` / `open` / `command` /
`close`), owned by `apps/mcp/src/bot/broker/protocol.ts`. A tool name crosses
the wire only inside `command`; `close` finishes a session or ends the
connection. The 512-entry retained-result replay guard, the 5 s
connection-session grace, and the reserved `abort` control frame (cancel
exactly one in-flight request by its frame id, leaving the connection and its
other sessions alive) stay internal policy behind the contract. Do not re-add
`hello`/`tool`/`cancel`/`client_close`/`maintenance`/`resume`/`maintain` as
wire operations.

### 22. Connect uses the target profile's shared broker

Runtime profile resolution must use `currentProfileDir()` after connect selects
its target environment. Connect joins the browser's broker instead of competing
for its profile. The authoritative discovery, preflight, ceremony, and recovery
contracts and their regression tests are in
[`docs/browser-broker.md`](docs/browser-broker.md).

## Maintaining this file

This file is a living contract, not a historical record. Keep it for durable,
repo-specific knowledge useful to almost every future agent session, not step-by-step
task narration or facts already obvious from the code. When a task reveals a gotcha,
footgun, or rule that would have changed the approach, add it in the same pass and
point to the authoritative file, command, or document. Prefer rewriting or pruning
existing guidance over appending duplicates, and remove stale guidance rather than
leaving it to mislead the next agent.
