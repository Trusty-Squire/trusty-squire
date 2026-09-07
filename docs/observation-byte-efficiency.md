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
10-character opaque hashes; new refs are intentionally 11-character production capabilities.
Its per-page columns isolate the one-byte-per-rendered-ref width cost from all other serializer
changes. Numbers are UTF-8 bytes of the emitted `dom`, before the unchanged text screen, excluding
the common response envelope. The measurement allocates refs by captured node
identity when rendered; it does not simulate whole-document query inventory or
a long-running session's document invalidation. They are not comparisons between different live
page loads. Numeric backend IDs in the Python oracle are normalized only by the
fixture comparison, not used as the baseline runtime refs.

| Page / reproduction | Baseline bytes | Current with 10-char refs | Current with 11-char refs | Ref-width change | Other serializer change | Total change |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| ipinfo | 7627 | 8131 | 8267 | 136 | 504 | 640 |
| mdn | 5390 | 5542 | 5622 | 80 | 152 | 232 |
| hacker-news | 19376 | 26350 | 26899 | 549 | 6974 | 7523 |
| wikipedia | 6422 | 6758 | 6841 | 83 | 336 | 419 |
| github | 4431 | 4477 | 4559 | 82 | 46 | 128 |
| gov-uk | 1434 | 1720 | 1742 | 22 | 286 | 308 |
| Highlighted code (synthetic Vouchflow case) | 515 | 73 | 73 | 0 | -442 | -442 |
| 12 repeated checkbox bindings (synthetic Resend case) | 1151 | 575 | 587 | 12 | -576 | -564 |
| 24 distinct unlabelled checkboxes (reachability control) | 1151 | 1151 | 1175 | 24 | 0 | 24 |
| Six hero cards and decorative SVGs (synthetic Xata case) | 653 | 84 | 84 | 0 | -569 | -569 |

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

Production refs use 11 base64url characters, preserving 66 bits of session-secret
HMAC output. A million arbitrary capability guesses succeeds with probability below
1 in 70 trillion, and a million independently minted refs has collision probability
below 1 in 100 million; a collision is retried before emission. The one-byte increase
over the baseline's 10-character payload is deliberately retained because refs authorize actions.
The per-page table attributes 136, 80, 549, 83, 82, and 22 bytes respectively to that
width change; the remaining growth is serializer output, principally Hacker News's
6,974-byte difference, rather than the capability length.

## Deliberate divergence from canonical browser-use

The six canonical comparisons still pass with only identity normalized. Their
production differences, including reachability, filtering, context, selection
evidence, and the explicit unchanged-DOM signal, are owned by
[the serializer-port contract](browser-use-serializer-port.md). The table above
measures production output.

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
  files: exit 0. Pagination fixtures increased from 150 to 250 controls to keep
  cursor assertions exercised with accepted 11-character capability refs.
- 2026-09-07 — final core rerun after serializer/context edits: exit 0,
  `Test Files 86 passed (86)`; `Tests 1459 passed | 1 skipped (1460)`.
- 2026-09-07 — final full session suite after the `dom_unchanged` addition:
  exit 0, `Test Files 1 passed (1)`; `Tests 326 passed (326)`. The regression
  checks absent `dom` plus `dom_unchanged: true`, a preserved revision, and a
  changed-to-blank `dom: ""` with the original ref in `removed`. Final TypeScript
  and changed-file lint checks also exit 0.

## Multi-select card evidence (PostHog follow-up)

The allowed selection evidence and the exclusion of decorative icons are owned by
[the serializer-port contract](browser-use-serializer-port.md). Opaque capability
refs deliberately outweigh the prior counter-based corpus reductions; the table
above was rerun after restoring them.

A stateless card is **undetectable by design**: clicking it may be reachable via a
stable ref, but no local selection state can be inferred when its DOM is unchanged.
An unrelated Get started button becoming enabled is not selection evidence for a
particular card. Include this limitation in the PR body.

`fixtures/observation-efficiency/selectable-cards.html` has stateless, aria-pressed,
aria-selected, data-state, class-change and appearing-check-icon cards. The real
Chrome test captures before/after, clicks the stateless card using its original
ref binding, confirms its row stays identical, and asserts each stateful row
changes with actual DOM evidence. The canonical six-page oracle still passes
unchanged. Targeted validation: `Test Files 3 passed (3)`; `Tests 39 passed (39)`.
