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

### 10. Post-submit checkout cleanup must stay bound to its pre-submit documents

`fillAndSubmitCheckout` (`apps/mcp/src/bot/browser.ts`) fills into every CDP-reachable frame present at fill time, then submits, then cleans up filled fields. PR #565's cleanup refactor swapped a narrow, marker-only cleanup for one that also JP-label-stamps and substring-clears card-shaped fields — but wired it to a **fresh** `this.page.frames()` call taken _after_ `submitFilledCheckoutInScope` returned. On a checkout that forces 3-D Secure, a method/challenge iframe (`methodurl.vcas.visa.com`, `*.cardinalcommerce.com`, an issuer ACS) can already be attached by then, so cleanup evaluated JS in and cleared fields inside that live, cross-origin authentication frame — corrupting the in-flight device-fingerprint POST and silently failing real EbisuMart/JP 3DS checkouts (root-caused in `ts-operator-3ds-completion`; PR #565's own verification was explicitly "detection only, no submission," so this path went untested).

**The rule:** cleanup must reuse `fillAndSubmitCheckout`'s pre-submit `fillFrameSnapshot`, preserve each original document's root handle, and perform every stamping, clearing, and verification pass through that handle. Never re-query frames or use fresh frame locators after submission: a 3DS/ACS frame may be newly attached or may replace a snapshotted frame's document, and only document-bound handles make either transition fail closed without retargeting cleanup to the authentication page. See the regression tests `"never clears fields inside an unrecognized 3-D Secure frame during post-submit cleanup"` and `"never clears fields after a filled frame navigates to a 3-D Secure document"` in `browser-payment.test.ts`.

### 11. Bind checkout selection and post-submit evidence to the released card

**The rule:** `submitFilledCheckoutInScope` (`apps/mcp/src/bot/browser.ts`) scans every page frame and open shadow root for a competing merchant-saved card. It may select only the sole unambiguous new-card radio, using native radio-group semantics, and must verify that selection and every sealed field value again as the last operation before dispatching the charge click. Selected saved-card options, ambiguous radio groups, cleared fields, traversal errors, or any intervening state change fail closed with `payment_card_selection_ambiguous`; never guess or re-fill. See `"positively selects the new-card radio and completes on the filled card, deselecting the competing saved card"`, `"still refuses when the new-card radio's choice group has two equally-plausible non-saved candidates"`, and `"refuses (never re-fills) when selecting the new-card radio itself clears the filled fields"` in `browser-payment.test.ts`.

After submission, ACS content is untrusted, read-only evidence. `detectThreeDsChallenge` may compare rendered issuer/network/last-four evidence with the released card and return `payment_instrument_mismatch`, but it must never mutate, cancel, or add an approval gate to the challenge. `PendingThreeDsWait` preserves the first mismatch across `operate_payment_status` polls of the same live browser. See `"warns when a top-level token-override ACS names another issuer"` in `browser-payment.test.ts` and `"keeps an ACS instrument-mismatch warning visible across 3DS status waits"` in `operate-session-flow.test.ts`.

Post-submit outcome tracking remains resumable for 20 minutes without becoming a second authorization or charge path. `PendingThreeDsWait.outcome` must stay `unknown` until concrete 3DS evidence appears; neither timeout nor missing merchant confirmation may relabel uncertainty as 3DS. While `pendingThreeDs` exists, new `operate_pay` calls and guarded `operate_act` charge clicks are refused; session close performs one final live check and audit before clearing it. A charge click issued through `operate_act` during `operate_pay`'s own in-progress outcome wait is still governed by the existing `activePayment: "operating"` lease rather than `pendingThreeDs`.

### 12. An operator browser is session-scoped: never remove its watchdog or containment

The authoritative lifecycle, bounded teardown, Linux marker-watchdog, and accepted
reparented-idle-renderer residual are documented in
[`docs/DESIGN-warm-browser-reuse.md`](docs/DESIGN-warm-browser-reuse.md#5-ownership-crash-recovery-and-containment).
Preserve that contract when changing browser startup or shutdown: never replace its
identity-proven scope with root-PID-only signaling or broad `pkill`. The strict
containment follow-up is `ts-operator-browser-cgroup-containment` in `TODOS.md`.

### 13. OAuth identity uses the real profile and a narrow lease

Every `oauth_login` and legacy `oauth_click` stays in the single real
`CHROME_PROFILE_DIR` browser context. The serialized boundary preserves the
authorized target and delegates to `loginWithOAuth`; never copy cookies, restore
storage state, swap browsers, or add a parallel OAuth driver.

`operate_start` admits Google only through `detectSessionProviders()` on that
live context and feeds it to `googleSessionGate`. Do not read Chrome's on-disk
cookie database for identity or completion.

Connect's Google-safe plain browser deliberately has no CDP context. Its
completion is the install claim plus explicit Finish callback, not a disk-cookie
probe. See `apps/mcp/src/bot/google-login.ts` and
`docs/DESIGN-warm-browser-reuse.md`.

### 14. MCP tests have required-fast and post-merge-slow tiers

`apps/mcp/vitest.tiers.ts` is the static tier manifest. The required `test`
check and `release.yml` run `test:fast`; `.github/workflows/mcp-slow-tests.yml`
runs the named integration files after merges and the complete suite nightly.
Payment/card-sealing files and operator behavior files (session fail-closed,
OAuth lifecycle, observation — `REQUIRED_BEHAVIOR_FILES`) are explicitly listed
in the required tier and run whole, without generated test-name filters. Never
move card-sealing, payment-safety, or operator behavior coverage to the slow
tier; slow is reserved for genuinely slow non-behavioral files (corpus evals,
packaging smoke, replay harness).

### 15. Operator browser lifetime is owner-bound

`apps/mcp/src/bot/owner-process-reaper.ts` is the crash/SIGKILL backstop for
self-managed and Playwright-launched local operator browsers. Every local launch
must receive the private operator marker at the shared launch boundary; never
register external/remote CDP browsers. The manifest records exact PID/group,
marker, process birth identity, and `user_data_dir`; it owns process signaling,
not profile or snapshot deletion. The profile pool and normal session teardown
remain the only directory-cleanup owners. Process teardown uses bounded
SIGTERM→SIGKILL.

Idle cleanup uses the provision-session call lease as its action boundary. Any new
session-addressed operate/auth/payment surface must acquire that lease, and session
teardown must clear its rolling observe snapshot before removing the live session.
That lease, the watchdog, and the whole terminal-teardown ordering now live in
`apps/mcp/src/bot/session/lifecycle.ts` (`provision-session.ts` re-exports them);
see CLAUDE.md's "Operator session model" for what may not be reordered.

### 16. The operator does not seal, redact, or refuse a read — do not add one back

Owner's order (2026-09-05, stated three times, after twice declining an offered
card-number carve-out): **remove ALL seals.** `operate_observe`,
`operate_observe_query`, `operate_screenshot`, and `operate_act { kind:
"extract" }` return what the page actually renders. There is no mask pass, no
`screenshot_unavailable_sealed_context` (the code no longer exists), no
observation value/label masking, no compact-v2 tool-result seal, and no
"the secret is still masked/hidden" extract refusal.

Do NOT reintroduce a reduced seal, a default-on env flag, an allowlist, or a
"payments only" remnant — that carve-out was offered and refused. Repeated
attempts to "harden" this by adding shape matching or a vocabulary allowlist are
what blinded the agent on real signups and checkouts (#627 → #636 → #639 → #645),
and the final failure was the two halves contradicting each other: on a
BrowserStack settings page with the Access Key revealed, `operate_screenshot`
refused ("a secret is present, you may not look") while `extract` on the same
page answered `candidate_count: 4, blocked_reason: "still masked/hidden"`.

Out of scope for that order and still in place: the vault's write-only property
and `use_credential`'s server-side injection (storage, not sealing); the payment
approval flow, 3DS, and the human-approval step; the
`data-ts-sealed-payment="1"` marker (card-fill machinery — cleanup, saved-card
resolution, profile destruction — which gates no read); and the two
non-agent-read surfaces that keep `recordableTokenV2`'s vocabulary screen, the
stderr audit trail and the registry-bound recipe action trace. The policy and its
file-by-file map live in
[`docs/observation-model.md`](docs/observation-model.md) §4.5 — read it before
touching this area.

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
- **Its description is a security control.** It has to keep steering agents to
  `use_credential` first and keep saying that the value lands in the transcript.
  A shorter, friendlier description measurably makes the model reach for the
  raw key when injection would have done.

`apps/api/src/__tests__/credential-fetch.test.ts` and
`apps/mcp/src/tools/__tests__/never-exposed-paths.test.ts` are the oracles.
Contract: [`SECURITY.md`](SECURITY.md#security-model); implementation map:
[`CLAUDE.md`](CLAUDE.md).

## Final note

You are reading this file because a prior agent burned four version numbers, confused users, and forced a human to intervene. The agent was not malicious. It was not lazy. It was pattern-matching on its own prose instead of on tool output.

You will be tempted to do the same. You will write "✓ published" and then re-read that phrase 50 tokens later and believe it. Resist that temptation.

**The meta-rule:** When you are about to claim success, pause and ask: "What tool output proves this claim?" If you cannot quote the tool output in the same message, you are hallucinating. Stop, run the tool, get the proof, then make the claim.

If you follow this file's rules, you will not burn version numbers. If you skip them because you're confident, you will burn version numbers. Confidence is not evidence.

Read this file. Follow the rules. Run the verify script. Paste the output. Then claim success.

---

## Skill-Promotion Pipeline (autonomous loop)

How a successful provision becomes a replayable, registry-published **Skill** —
fully automatically, no human in the path. This is the skill-growth half of
the loop; the runtime/retry half is host-driven — the host agent plans each
step and its retries via the `operate_*` tools (no in-package state machine).

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
- **failure-taxonomy is shared** in `@trusty-squire/skill-schema` so the
  registry and the mcp client agree. Change it there; never fork.

### Reference

- `packages/skill-schema/src/skill.ts` (`SkillSchema`, `entry_state`)
- `apps/mcp/src/bot/promote-to-skill.ts`, `apps/mcp/src/bot/onboarding-capture.ts` (auto-promote)

---

## Browser launch posture

- **`connect` is the only sign-in command, and the login browser is always
  PLAIN Chrome.** There is no `login` subcommand and no CDP-attached login path
  — Google's OAuth secure-browser check rejects a CDP attach, and a second
  command that seeded a provider session outside the account claim let an
  install report success with no live Google session. Re-auth is
  `connect --force-relogin[=google|github]`; connect gates its own success on
  the post-ceremony live provider probe (`decideConnectComplete`,
  `apps/mcp/src/install/cli.ts`), and the operator's `google_session` wall hands
  back `resume: "connect"`. Never reintroduce a second sign-in entry point, and
  never point a user or an agent at `login`.
- **Never quit a Chrome whose profile state you still need with SIGTERM.** Chrome
  routes SIGTERM to its abrupt "session ending" exit and does NOT flush the
  SQLite cookie store (its own commit timer is ~30s out), so a SIGTERM teardown
  seconds after a sign-in silently discards the session that sign-in just
  established — the 2026-09-04 `connect` regression. The login browser quits with
  `PLAIN_LOGIN_BROWSER_QUIT_SIGNAL` (SIGINT) and waits for the graceful exit
  before the owner reaper's SIGTERM → SIGKILL escalation takes over
  (`apps/mcp/src/bot/browser.ts`); the evidence is in `STATE.md`.
- `BrowserController` local launches are new-headless only; do not reintroduce
  virtual-display selection or `DISPLAY` plumbing into automated operator runs.
  `apps/mcp/src/bot/browser.ts` owns the supported local-headless and remote-CDP
  operator paths.
- Interactive human login is the deliberate exception. When `connect` (the one
  onboarding and re-auth pathway, including `--force-relogin`) runs without a
  user-visible display,
  `apps/mcp/src/bot/remote-login-display.ts` starts an on-demand Xvfb + noVNC
  quick tunnel and tears the entire owned rig down with that login. Keep this
  module scoped to login flows. SSH/TTY sessions must not treat an inherited
  virtual `DISPLAY` as a user-visible desktop; route those logins through noVNC.
  When both `TS_LOGIN_PUBLIC_HOSTNAME` and `TS_LOGIN_LOCAL_PORT` select a named
  tunnel, that tunnel is operator-managed external infrastructure: the login
  owns and tears down its per-login display and websockify listener, but never
  creates, owns, or stops the external tunnel. That fixed local port is shared
  with everything else on the box, so login preflights it and degrades to a
  per-login quick tunnel when it is occupied (`planLoginTunnel` in
  `remote-login-display.ts`); never let a helper's bind failure be the first
  signal, and keep helper stderr drained into the thrown error.
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

## Never touch the operator's live local state from a test or a check

Manual checks must use an isolated `HOME` and `XDG_CONFIG_HOME`, never the
developer's real state. The test suite enforces this through
`apps/mcp/src/__tests__/setup/isolate-config-home.ts`, wired in
`vitest.shared.ts`; preserve that setup and do not resolve the default session
or profile path from a test. The session-storage compatibility contract lives
in `apps/mcp/src/session.ts`.

## Maintaining this file

This file is a living contract, not a historical record. Keep it for durable,
repo-specific knowledge useful to almost every future agent session, not step-by-step
task narration or facts already obvious from the code. When a task reveals a gotcha,
footgun, or rule that would have changed the approach, add it in the same pass and
point to the authoritative file, command, or document. Prefer rewriting or pruning
existing guidance over appending duplicates, and remove stale guidance rather than
leaving it to mislead the next agent.
