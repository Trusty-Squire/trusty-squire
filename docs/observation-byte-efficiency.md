# Observation byte-efficiency evidence

Measured 2026-09-07 against baseline `c386d00bea4961a2fd82f07a892463b08e1a739e`.
Copy the table and divergence notes below into the delivery PR body.

## Reproduce

```sh
bash scripts/capture-browser-use.sh
pnpm exec tsx scripts/measure-observation-bytes.ts c386d00bea4961a2fd82f07a892463b08e1a739e
pnpm --filter @trusty-squire/mcp test:fast
```

The measurement command loads the actual baseline serializer from git and runs
both implementations on the **same newly captured DOM input**. Baseline refs are
10-character opaque hashes; new refs use the production stable allocator. Numbers
are UTF-8 bytes of the emitted `dom`, before the unchanged text screen, excluding
the common response envelope. The measurement allocates refs by captured node
identity when rendered; it does not simulate whole-document query inventory or
a long-running session's counter. They are not comparisons between different live
page loads. Numeric backend IDs in the Python oracle are normalized only by the
fixture comparison, not used as the baseline runtime refs.

| Page / reproduction | Before bytes | After bytes | Saved | Reduction |
| --- | ---: | ---: | ---: | ---: |
| ipinfo | 7627 | 6459 | 1168 | 15.3% |
| mdn | 5390 | 4733 | 657 | 12.2% |
| hacker-news | 19376 | 15025 | 4351 | 22.5% |
| wikipedia | 6422 | 5723 | 699 | 10.9% |
| github | 4431 | 3368 | 1063 | 24.0% |
| gov-uk | 1434 | 1226 | 208 | 14.5% |
| Highlighted code (synthetic Vouchflow case) | 515 | 73 | 442 | 85.8% |
| 12 repeated checkbox bindings (synthetic Resend case) | 1151 | 467 | 684 | 59.4% |
| 24 distinct unlabelled checkboxes (reachability control) | 1151 | 935 | 216 | 18.8% |
| Six hero cards and decorative SVGs (synthetic Xata case) | 653 | 84 | 569 | 87.1% |

The six named pages are the pinned live corpus, regenerated with
`browser-use==0.13.10`, 1280 × 800, viewport threshold 0 and paint-order filtering
**enabled**. The `.json` inputs and verbatim `.txt` outputs were generated together;
no expected output was edited by hand. Hacker News stories, GitHub content, and
backend identities drift between captures. HN's prior literal username disappeared,
so the existing false-positive regression now injects that same username into
visible fixture text instead of depending on a live front-page user.

The last four rows are deterministic reproductions, **not measured production
Vouchflow, Resend or Xata observations**. The run report supplies descriptions but
no raw captures. The duplicate-checkbox case demonstrates repeated bindings to
12 identical action identities; it does not claim that Resend's 12 extra DOM
controls have been proven to share bindings. Distinct unlabelled controls are
preserved, as the 24-control row demonstrates. Deleting apparent proxy checkboxes
without an identity relationship could remove an independent action.

## Deliberate divergence from canonical browser-use

The six canonical comparisons still pass with only identity normalized. The
internal canonical mode runs the ported upstream paint-order behavior. Production
also keeps covered controls reachable; removes empty decorative SVGs; collapses
consecutive inert repeated subtrees; coalesces plain highlighted code; supplies
nearby context for empty iframe hints and unlabelled form rows; and omits already-emitted unlabelled form
bindings. Unchanged deltas now explicitly emit `dom_unchanged: true`, distinguishing
them from newly empty `dom: ""` views without changing delta semantics. The separate name preserves the legacy
numeric `unchanged` field. No distinct interactive ref is removed by sibling collapse or form
binding deduplication. Code coalescing ignores only the geometry/class heuristic
on plain syntax markup, never explicit action semantics.

The screen is unchanged. `usernametaken29` remains a documented lowercase-plus-
digits false positive, covered by the HN-based regression. Tool descriptions,
the `format` label, OAuth, vault behavior and payment approval are unchanged.

## Evidence ledger

- 2026-09-07 — `bash scripts/capture-browser-use.sh`: six `CAPTURED` lines;
  canonical bytes 6134 (IPinfo), 4669 (MDN), 13987 (HN), 5503 (Wikipedia),
  3590 (GitHub), 1214 (GOV.UK). These are upstream numeric-ref outputs, separate
  from the runtime comparison table above.
- 2026-09-07 — targeted serializer, efficiency and real-Chrome observation tests:
  `Test Files 3 passed (3)`; `Tests 38 passed (38)`.
- 2026-09-07 — memory helper: `conflict: both AGENTS.md and CLAUDE.md are real
  files`; pre-existing files left unchanged, no memory reconciliation attempted.
- 2026-09-07 — `pnpm --filter @trusty-squire/mcp test:fast`, exit 0:
  core `86 passed`, `1458 passed | 1 skipped`; required behavior `16 passed`,
  `587 passed | 3 skipped`; payment safety `9 passed`, `469 passed`.
- 2026-09-07 — package TypeScript check and ESLint on all changed bot TypeScript
  files: exit 0. Pagination fixtures increased from 150 to 250 controls because
  the shorter refs put the old fixture entirely on one page; cursor assertions
  remain intact.
- 2026-09-07 — final core rerun after serializer/context edits: exit 0,
  `Test Files 86 passed (86)`; `Tests 1459 passed | 1 skipped (1460)`.
- 2026-09-07 — final full session suite after the `dom_unchanged` addition:
  exit 0, `Test Files 1 passed (1)`; `Tests 326 passed (326)`. The regression
  checks absent `dom` plus `dom_unchanged: true`, a preserved revision, and a
  changed-to-blank `dom: ""` with the original ref in `removed`. Final TypeScript
  and changed-file lint checks also exit 0.
