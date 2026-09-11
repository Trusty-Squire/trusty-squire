# Screenshot-click integration

## Provenance and scope

Isolation checks (`pwd -P` and `git rev-parse --show-toplevel`) both returned
`/home/lunchbox/.treehouse/proj-ts-8bc037/14/proj-ts`. The branch
`fm/ts-targeting-integration-rc13` starts at fetched `origin/main`
`277c5eb9036653be1387dca36aa3cad115e13802`.

That baseline contains the outcome/DOM integration including all pipeline fixes.
`git diff origin/fm/ts-rc13-fixes-integration origin/main --stat` was empty; the
integration branch's head was `19162b9cb7b9a3299e58cdf0fcfa88c056c33f1b`.
Only targeting implementation `9912475edd8fcaf9a57f946cbfd96191114619ac` was
cherry-picked, becoming `7b34bc44`. The report-only commit `1246966d` was excluded;
the existing `FIX-REPORT.md` was not overwritten.

Read the three component `FIX-REPORT.md` files in sibling worktrees 10, 11 and 12,
and the native retry, Cloudflare click, dispatch, progress and handoff reports in
`/home/lunchbox/firstmate/data/ts-rc13-live`. Those reports describe native
pre-dispatch `stale_ref` failures for screenshot-derived checkbox labels, OAuth
errors despite later visible progress, and DOM/rendering discrepancies. They are
supervisor evidence, not live reproductions by this integration worker.

## Semantic integration review

The cherry-pick auto-merged all shared files without conflicts. Inspection of the
diff against the landed main confirmed:

- `browser.ts` changes only screenshot capture and its optional binding metadata.
  The landed direct OAuth dispatch tracking is retained.
- `provision-session.ts` adds the image click branch, dispatch receipt recovery,
  and unknown-label distinction. Existing OAuth completion/denial recovery,
  attempt-owned popup preservation, and observation blocker metadata remain.
  Image clicks reuse existing action, frame-scope and payment predicates. No new
  payment guard or read seal was added.
- `compact-observation-v2.ts` gains only the `hasLabel` history accessor. The
  alias-owner map retains retired aliases within the document, so a retired
  alias stays `stale_ref`; a never-issued click label becomes `target_unresolved`.
  Literal roles, offscreen facts and blocker extraction remain as landed.
- `provision-drive.ts` merges the exclusive ref/image input, optional screenshot
  binding, and dispatch receipt schemas with main's literal-role query schema
  and OAuth guidance. Description snapshot changes are limited to click and
  screenshot; the landed observe/login snapshots are preserved.
- Main's containing-block clipping and fixed-shell blocker fixes are untouched,
  as are the server resilience schema typing fix and release/test configuration.

The current targeting contract, including binding identity and dispatch receipts,
is owned by the [operator tool-surface document](docs/operator-tool-surface.md#clicking-a-screenshot-visible-control).

## Integration additions

Both new targeting suites are explicitly included in `REQUIRED_BEHAVIOR_FILES`
in `apps/mcp/vitest.tiers.ts`; whole files run in the required behavior group.
No test moved to a slow tier or gained a skip.

Added one combined public-session fixture in `screenshot-click.test.ts`: a real
closed-shadow iframe click is delivered, its acknowledgement is deliberately
lost, and subsequent full/query observations must retain invisible-control
filtering, the literal slider role and verification blocker evidence. The fixture
also checks that precisely one trusted checkbox click occurred. Existing suites
cover retired aliases, OAuth recovery, containing blocks, screenshot transforms,
navigation/geometry invalidation, payment behavior and published tool contracts.

## Validation ledger

All checks use local fixtures and the repository's isolated test configuration.
The fresh worktree initially had no `node_modules`, so the first validation
commands could not find Prettier or Vitest; no tests ran in that attempt.
`pnpm install --frozen-lockfile` completed without lockfile changes, followed by
builds of the two MCP workspace schema dependencies.

- MCP TypeScript check: exit 0.
- Scoped ESLint over changed TypeScript files and the tier manifest: exit 0.
- `git diff --check`: exit 0.
- Combined ten-suite behavioral run (14:12:17 local, 481.97s): nine files passed,
  with `991 passed | 1 failed (992)`. The sole failure was the new combined
  fixture: startup navigation discarded markup injected before startup. A second
  attempt incorrectly attributed the missing text to deltas and still failed.
  Firstmate reviewed the two-attempt escalation and authorized correction of
  fixture ownership; no production observation behavior changed.
- Route-owned markup survives startup navigation. The affected targeting suite
  rerun (14:22:33 local, 8.39s) exited 0: `Test Files 1 passed (1); Tests 25
  passed (25)`. The nine other suites were unchanged and were not repeated.
  Together these cover all 992 selected tests, not one wholly green combined run.
- Final formatting checks passed. Local logs: `.targeting-integration-tests.log`,
  `.targeting-focused.log`, `.targeting-focused-final.log`, `.targeting-typecheck.log`
  and `.targeting-lint.log` (ignored working artifacts).
- No-mistakes PR/CI validation follows this committed integration head; no PR or
  publication success is asserted by this local report.

The required memory helper reported that `AGENTS.md` and `CLAUDE.md` are distinct
real files and requested reconciliation. Neither was edited; the existing
authoritative operator tool-surface documentation contains the targeting contract.
CodeGraph tools were not exposed in this worker session, so semantic inspection
used the known component files and Git diffs/history.

## Acceptance boundary

Firstmate's subsequent inbox instructions 001/002 combine RC bookkeeping into
this same PR and authorize following the helper's version/changelog operations
without its separate branch/push/PR side effects. The helper itself is unchanged.
At `2026-09-11T18:18:22.912Z`, a fresh upstream read showed `1.1.14-rc.13` and the
registry package metadata returned `next=1.1.14-rc.13`, `latest=1.1.13`, with no
`1.1.14-rc.14` version entry. The helper's increment therefore derives RC.14.
`apps/mcp/package.json` and its changelog prepare that prerelease; publication
must still be independently verified after Firstmate merges the green PR.

No worker accessed a live provider, shared browser/profile, account or credential.
No auth reset, Hermes/broker lifecycle change, dependency upgrade, stable
promotion or R22–R25 work was performed. Firstmate owns native Exa/Groq/Cartesia
acceptance, authorized merge, and the subsequent RC release. Fixture results do
not establish actual Cloudflare topology or clearance. The live page is not
frozen during input; binding is not pixel-by-pixel screenshot equivalence.
