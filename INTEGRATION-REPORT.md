# RC.13 action and observation integration

## Scope and provenance

Isolated worktree: `/home/lunchbox/.treehouse/proj-ts-8bc037/13/proj-ts`.
Both `pwd -P` and `git rev-parse --show-toplevel` returned this path.
Branch: `fm/ts-rc13-fixes-integration`.
Baseline: `f738871b7e5830e40134e3dffdb6d373f44bde7b`.

2026-09-11, tool evidence: `git fetch origin` exited 0, then
`git log -5 --oneline origin/main` began with `f738871b release(mcp): 1.1.14-rc.13`.
There was no upstream advancement before integration. This establishes Git
provenance, not the loaded native provider runtime or an npm publication result.

Implementation commits only were cherry-picked, without conflicts:

- `2a54b2c7c006b61c3203af1a437c01b0a24e9d76` became `30ff9903`.
- `25a26be965feba1641c184321e07cefe57b9f956` became `b882455b`.

Original component reports remain unchanged at worktrees 11 and 12's
`FIX-REPORT.md`. Their report-only commits were not imported. Read alongside them:
`progress-report-20260911.md`, `retry-20260911-native-current.md`, and
`cloudflare-click-20260911.md` under `/home/lunchbox/firstmate/data/ts-rc13-live/`.
The later dispatch supersedes the progress report's instruction to wait for
targeting. No unfinished targeting patch was inspected or imported.

## Combined interaction review

- `browser.ts` records the existing dispatch boundary around direct native OAuth
  initiation while preserving the ordinary click implementation. It does not
  replace shared click helpers or change screenshot or payment behavior.
- `provision-session.ts` checks attempt-owned completion evidence after an
  uncertain dispatch error. Proven no-dispatch, provider denial, human challenge,
  and onboarding signals retain their explicit outcomes. Unknown progress clears
  prior observation/snapshot state and requests a fresh observation without replay.
- Compact `semantic.blocked` describes captured blocker evidence independently
  of stage. It does not authorize or prohibit actions, assert OAuth failure, or
  turn missing metadata into proof of an unblocked page. Uncertain OAuth's
  metadata-only result does not manufacture fresh DOM evidence.
- The next actual observation uses the updated canonical capture: ancestor-hidden
  controls stay excluded, scrollable offscreen controls retain physical identity,
  literal roles survive the compact map, and visible verification/error text is
  retained. The existing bounded metadata degradation remains in place.
- `server.ts` retains native OAuth session identity and observe-before-action
  guidance; unsettled/busy cancellation keeps its wait/finish instruction.
  Forwarded results retain their existing detail handling.
- `provision-drive.ts`'s OAuth description and control-query role contract coexist
  in the merged description snapshot. Shared snapshot/test merges were reviewed;
  the new observation fixture stays in the required behavior tier.

CodeGraph tools were not exposed in this session. Review used the known changed
files, their combined Git diff, and executable fixture interfaces.

## Integration regression

Extended the direct native OAuth lifecycle fixture with visible verification
instructions and an ancestor-hidden consent control at the pending destination.
It performs one real routed click, injects a driver-return exception after
navigation, and then reads the retained session through compact observation.
Assertions jointly establish unknown OAuth progress, current blocked metadata,
hidden-control exclusion, and exactly one initiating click. The callback sibling
still preserves completion evidence. All provider-shaped URLs are locally routed;
no credential or live provider session is involved.

## Local validation evidence

2026-09-11 local tool observations:

- Initial fixture command could not start: `Command "vitest" not found` in the
  fresh worktree. `pnpm install --frozen-lockfile` then exited 0 without changing
  the lockfile. Workspace package builds exited 0.
- MCP typecheck exited 0.
- Cross-component regression: `Test Files 1 passed (1); Tests 2 passed | 93
  skipped (95)`, exit 0. The skips are the explicit test-name selection, not new
  skips in source. Log: `.integration-cross-test.log`.
- Prettier: `All matched files use Prettier code style!`; scoped ESLint and
  `git diff --check` exited 0.

- Combined full-file fixture run (12:49:48 start, 214.75s, exit 0):
  `Test Files 11 passed (11); Tests 822 passed | 3 skipped (825)`.
  Files: operate-session-flow, oauth-lifecycle, broker-operator,
  server-resilience, tool-descriptions, observation-dom-correctness,
  observation-prose, compact-observation-v2, browser-use-serializer,
  observation-byte-efficiency, and observe-delta (all `.test.ts`).
  Log: `.integration-tests.log`. The three existing skips are in observe-delta.

No-mistakes owns full validation and any subsequent fixes after submission.

## Boundaries and remaining acceptance

Local fixture evidence is not native Exa/Groq/Cartesia acceptance. Firstmate owns
that acceptance and the authorized merge after green CI. No live provider session,
shared profile, credential, broker/Hermes lifecycle, release, stable promotion,
dependency upgrade, or R22–R25 work was touched. The screenshot component ships
separately through its own validation against then-current main.

The required memory helper was run. It reported distinct real `AGENTS.md` and
`CLAUDE.md` files and refused reconciliation. Neither file was changed: existing
guidance already points to the authoritative operator and observation documents
updated by the components; repository-wide memory restructuring is outside scope.


## No-mistakes review fixes

The review phase in worktree
`/home/lunchbox/.no-mistakes/worktrees/4ff216715903/01M28P82G83Y1QWHJFS9KSHG6K`
confirmed both reported defects and fixed them locally:

- Overflow filtering now respects fixed/absolute containing blocks instead of
  treating every DOM ancestor as a clip. Local browser fixtures compare hit
  testing, observation action refs, and actual clicks, including transformed
  and positioned wrappers that really do clip.
- A click that opens an attempt-owned popup and then rejects retains that popup
  and OAuth ownership through cleanup. Navigation listeners are removed on the
  error path, pending same-tab recovery stays alive, duplicate login stays
  refused, and popup close restores the product. The existing routed lifecycle
  regression now covers popup and same-tab pending/callback outcomes.

These are isolated fixture regressions, not live native signup acceptance.
No shared browser/profile, credential, payment, or screenshot-targeting changes
were included. The outer pipeline still owns subsequent validation and delivery.

Review-phase verification (2026-09-11, start 12:58:51): after locked dependency
installation and workspace schema builds,
`pnpm --filter @trusty-squire/mcp exec vitest run src/bot/__tests__/observation-dom-correctness.test.ts src/bot/__tests__/oauth-lifecycle.test.ts`
exited 0: `Test Files 2 passed (2); Tests 106 passed (106)` in 151.89s.
This was the single focused verification run after both fixes; no full repository
test/lint suite or downstream pipeline phase was run here.


## Follow-up review fixes (R3/R4)

The published `operate_observe` tools/list schema now accepts the same bounded
literal-role strings as its runtime validator. An in-memory MCP SDK client
retrieves that schema and validates accepted and rejected roles with the SDK's
JSON Schema validator, comparing runtime validation for the same inputs.

Blocker traversal now uses each node's captured visibility instead of inheriting
an ordinary ancestor's empty layout box; hidden frame boundaries remain enforced.
An isolated browser fixture exercises a fixed-position shell inside a zero-height
body, visible verification and validation evidence, and opacity-, display-,
visibility-, overflow-, and frame-hidden evidence. R1/R2 remain in place.
These changes use no live provider, shared profile, credential, OAuth/payment
boundary, or screenshot component changes. Native acceptance remains outstanding.

R3/R4 tool evidence, 2026-09-11:

- Focused Vitest run at 13:06:21: server-resilience (15), compact-observation-v2
  (89), and observation-prose (45) all passed. The DOM file had nine passes and
  one fixture setup failure: quirks mode gave body height 720 instead of zero.
- Added the fixture's standards-mode doctype; no production change followed that
  failure. Reran only observation-dom-correctness at 13:06:41: `Test Files 1 passed
  (1); Tests 10 passed (10)`, exit 0, 1.89s. Its zero-height assertion and visible/
  hidden blocker assertions passed. All 159 selected tests now have passing
  evidence, across those runs; this does not claim a full pipeline pass.


## Callback denial review fix (R5)

Confirmed that a driver exception after the initiating click bypassed the normal
OAuth denial scan. The lifecycle now records denial evidence from navigation to
this attempt's expected callback and promotes that concrete denial at the shared
error boundary before uncertainty handling. The normal scan shares the denial
formatter. A denial clears pending ownership through existing teardown; no OAuth
replay or success inference is added.

The routed click-then-error fixture now includes same-tab and popup callbacks
carrying `error=access_denied`, asserting the provider's denial message, one click,
cleared OAuth ownership, and a still-observable session. Prior pending/completed
regressions remain. No live provider or shared profile was accessed.

R5 focused verification, 2026-09-11 at 13:11:10: selected the click-then-error,
existing denial, unrelated navigation, and pre-existing error-query cases in
`oauth-lifecycle.test.ts` using Vitest's test-name filter. Tool output:
`Test Files 1 passed (1); Tests 10 passed | 89 skipped (99)`, exit 0, 24.78s.
The 89 skips are selection-only. Both new denial regressions passed alongside
pending/completed recovery cases. No full test/lint or downstream phase ran here.

## Test-phase schema characterization fix

On 2026-09-11 at 13:24:40, the focused command
`pnpm --filter @trusty-squire/mcp exec vitest run src/bot/__tests__/session-characterization.test.ts -t 'merges query and cursor into the observation schema'`
reproduced the reported failure (exit 1): the intentional published-schema
characterization still expected the old role enum after R3 introduced bounded
literal roles. Updated only that expectation to require the string length bounds
and role pattern, retaining exact schema equality and existing behavioral coverage.

The same command at 13:24:54 exited 0: `Test Files 1 passed (1); Tests 1 passed |
18 skipped (19)`. Skips are test-name selection only. R1–R5 remain intact; no
production code, live provider sessions, shared profiles, or screenshot component
changed. No transient untracked artifacts remained. This is focused fixture
evidence; the outer executor owns remaining pipeline validation and delivery.
