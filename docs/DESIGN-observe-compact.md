# DESIGN — compact and delta operate observation payload

## Problem

Before compact observations shipped, every `operate_*` turn returned a full
perception payload from `observeSession` (provision-session.ts). It was 30–50 KB
per turn, and every action response re-emitted it — so a single
form-fill flow spent hundreds of KB of host context on mostly repeated
perception.

## Measured byte breakdown (real captured observations)

Two heavy real observations from a live session, measured field-by-field:

| section | OpenRouter sign-in (50.3 KB) | GCP console (49.1 KB) |
|---|---|---|
| `elements` | 26.4 KB (52%) | 28.9 KB (59%) |
| `screen` | 6.0 KB (12%) | 4.5 KB (9%) |
| `accessibility` | 4.9 KB (10%) | 3.6 KB (7%) |
| `text` | 2.5 KB (5%) | 1.8 KB (4%) |
| guidance + hint | ~0.9 KB | ~0.3 KB |

Inside `elements`:

| waste source | OpenRouter | GCP |
|---|---|---|
| null / "" / false fields | 7.0 KB (**27%** of elements) | 9.7 KB (**34%**) |
| `path` field | 4.5 KB | 4.4 KB |
| `container` field | 2.6 KB | 1.4 KB |
| container slug duplicated *inside* `path` | 2.5 KB | 1.1 KB |

**Key findings**
1. `screen` and `accessibility` are full re-encodings of the *same* node set
   `elements` already carries (same 75 / 88 refs). Pure duplication.
2. ~30% of the `elements` block is serialized `null`/`""`/`false`.
3. `container` is 100% redundant with `path` (`path` = `<container> > <kind>:<label>`).
4. In legacy V1, the planner normally drives off `text` (read state) + the
   element inventory (pick `ref`). If a visible clickable or typeable control has no inventory
   row, `operate_click` and `operate_type` have a live `text=…`/`css=…`
   fallback. The `screen` region-tree and
   `accessibility` flat-tree are not needed to choose an action.
   `occluded_by`/`topmost`/`href` ARE load-bearing — keep them (per-element).

## Observation mode and format

The session observation format is selected once at start by
`TRUSTY_SQUIRE_OBSERVE_V2=on|shadow|off` and defaults to `on`:

- `on` defaults to `format:"compact"`, a paged browser-use control map.
  `format:"full"` explicitly emits the browser-use DOM format and does not
  expose the V1 inventory.
- `shadow` runs the native browser-use DOM serializer without retaining or emitting
  its result, while callers continue to receive and target V1 observations.
- `off` keeps the V1 observation and action contract.

Within V1, the public `format` parameter selects the ordered per-call payload:

```
format: compact  <  full
        default     rich V1 (compact + screen + accessibility + raw fields)
```

`operate_observe({ format })` accepts `compact|full`. The click/type/select/press/scroll
verbs accept the same format choice and default to a compact changed-control delta;
`format:"full"` opts that action into the verbatim DOM. In V1, a genuinely
ambiguous step can escalate to `format:"full"` for that one call. In V2,
`compact` is the default paged control map and `full` is the verbatim DOM escape
hatch.

## Current Compact V2 wire-contract ownership

The default `format:"compact"` control map, byte budget, and cursor contract
are owned by [`observation-model.md`](observation-model.md). The explicit
`format:"full"` browser-use DOM contract is owned by
[`browser-use-serializer-port.md`](browser-use-serializer-port.md). This
document retains the original design rationale and V1 history below; it is not
a second current wire reference.

## Legacy V1 — Phase 1 compact encoder ✅ shipped

When V1 is selected and `format` is `compact` (the V1 default), `observeSession`:

- **Omit `screen` + `accessibility`** (the two re-encodings). Also skip computing
  them (CPU win).
- **Build compact element records**: omit empty fields; preserve `checked` for
  both true and false checkable states, emit `topmost` only when `false` (the
  informative case), and emit `occluded_by` only when set. Keep `ref`, `label`,
  `tag`, `role`, `type`, `href`, and `testId`; child-frame rows also keep their
  load-bearing `frame_origin`.
- **Drop `path` and `container` from the wire payload.** `container` is redundant
  with `path`; the verbose `path` remains in the complete persisted snapshot for
  re-expansion and targeted searches.
- **`value` → `value_len`** (a number) — a payload size budget, not a seal, and
  it reports the field's REAL length for every field including password inputs.
  `format:"full"` carries the raw `value`.
- **Metadata** so omission is explicit, never silent:
  `elements_total` (the complete current count, including delta/collapsed
  omissions), `text_truncated` (the 4000-char text cap tripped), and
  `modal_active:true` when a dialog/modal region (`role="dialog"`, `<dialog>`, or
  `aria-modal="true"`) has at least one topmost element. `modal_active` is omitted
  when no modal is interactable and is computed from the complete element set,
  so it remains accurate on delta emits.

**V1 full mode remains the byte-equivalent escape hatch:** it returns every
element and field plus `screen` and `accessibility`, with no delta markers, link
collapse, or snapshot pointer.

Measured on a real six-observe Casetify sequence, compact deltas cut context by
78%; dropping `path` from the wire payload raised the cut to 85%. The
token-weighted aggregate over the real corpus is approximately 66%. Across
approximately 58,000 same-selector re-observe pairs, mutable path-region data
re-minted 0.00% of refs.

## Legacy V1 — Phase 2 `format` ladder ✅ shipped

- In V1, `operate_observe({ format: "compact" | "full" })` — `full` restores the
  legacy screen+accessibility+raw-field payload for an ambiguous step.
- In V1, actions return their normal result. Call `operate_observe` before the
  next ref-targeted action when the state changed.

deferred (Phase 2.5, only if evidence demands): an `include` partial-escalation
(re-add just one heavy view) was considered and dropped — it breaks the linear
ladder and `full` already covers the rare escalation. `scope:{ref}`/`depth`
sub-tree reads remain unbuilt.

## Legacy V1 — Phase 3 stable refs and per-session deltas ✅ shipped

V1 compact observations minimize repeated context without making the stream lossy:

- **Stable refs.** Refs are `@e:<identity>_<ordinal>`. For a normal control the
  `<identity>` is its generation-independent `stableElementId`, so an unchanged
  element keeps resolving across observes. The identity includes the element
  selector plus its frame origin and nested-frame path, so same-label siblings
  with distinct stable selectors get distinct refs and identical selectors in
  different documents cannot collide. After one is removed, its old ref resolves
  to `null` instead of retargeting its sibling or another frame. Public
  flat action calls translate that miss into `target_stale`, carrying the last
  completed observation generation, `reobserve_required: true`, best-effort
  semantic-label-keyed replacement candidates, and
  `retry_policy: "do_not_retry_old_ref"`. The candidates are hints rather than a
  ref-identity guarantee: the caller re-observes and chooses from the current
  inventory before retrying.
- **Volatile positional groups (issue #399).** The dangerous recycling case is
  closed for group-size changes: sibling controls distinguishable *only* by a
  positional `:nth-child`/`:nth-of-type`/`>> nth=` selector can shift onto a
  departed member's selector when one is removed. `volatilePositionalGroups`
  detects the ≥2 positional members of a same-base-identity group and gives those
  members a group fingerprint: a hash of the positional members'
  `stableElementId`s in extraction order. Stable-anchored members of the same base
  group keep their plain refs. `elementIdentity` prefixes each positional
  member's ref with the fingerprint (`<fp>-<hash>`), so a group ref is valid only
  while that fingerprint matches. Removing or inserting a member changes the
  group size and fingerprint. Every old group ref therefore appears in `removed`
  (or a full resync) and resolves to `null` — never to a surviving sibling.
  Because the identity is derived from composition (not an observe counter), this
  also holds within a turn: the act path re-extracts, so a group-size change
  between observe and act changes the fingerprint and returns the same
  `target_stale` repair rather than mis-targeting the shifted sibling. A static
  group's refs stay stable across observes (no wasted churn), and a filled field
  or toggled checkbox — mutable state is excluded from `stableElementId` — keeps
  its ref.
  These groups are rare, so the corpus token-weighted aggregate saving is
  unchanged (~66%). Bounded residual: a size-preserving shuffle of TRULY
  indistinguishable members (delete-one-and-insert-one, or a pure reorder, where
  members carry zero distinguishing signal — identical label/aria/testid/text/
  `screenPath`, only the `nth` differs) leaves the fingerprint unchanged. That
  observation is byte-identical to "nothing changed," so no string-derived ref
  scheme can flag it; real per-row controls carry a distinguishing signal and are
  non-volatile (guarded by the #398 stable-selector identity). Fully closing it
  needs an extractor-stamped per-node id that survives DOM mutation — deferred
  because stamping every interactive node with a persistent attribute is
  anti-bot-detectable.
- **Full resyncs.** The first compact observe, a URL change, or element churn over
  60% emits `delta:false`. Replace the prior element map from `snapshot_file`;
  the wire `el_table` may omit collapsed chrome links.
- **Incremental updates.** A same-URL, low-churn observe emits `delta:true`.
  Parse and upsert the emitted `el_table` rows by ref, delete `removed`, and
  retain the elements represented by `unchanged`. An empty delta means nothing
  changed, not that the page is empty.
- **Text deltas.** When normalized page text is byte-identical to the prior
  observe, `text` is empty and `text_unchanged:true` tells the host to reuse its
  previous text. Changed text is emitted in full.
- **Complete snapshot.** Every compact observe atomically replaces one
  session-scoped JSON file containing the complete current text and element
  inventory, including `path` and `text_truncated`. Its session directory is mode
  `0700` and the file is mode `0600`, so the host can safely re-expand after its
  own context compacts. If persistence fails, the response falls back to
  `delta:false` with a complete, uncollapsed `el_table` and no `snapshot_file`;
  the delta baseline is invalidated so the next compact observe is another full
  resync.
- **Safe chrome collapse.** Full compact resyncs may omit only navigational
  `<a>`/link elements in chrome regions such as navigation, banners, asides, and
  footers. Buttons, inputs, role-controls, submit controls, fragment or
  JavaScript links, links without an `href`, links inside a consent widget, and
  links labeled as close/dismiss/accept/reject/decline/agree/cookie/consent/
  preferences actions are never collapsed. `chrome_links_collapsed` reports the
  omitted count; the file still contains them.

In V1, `format:"full"` bypasses all delta and collapse behavior and preserves
the rich payload shape byte-for-byte. As an unsurfaced side effect it replaces the
persisted snapshot, invalidates the compact baseline so the next compact observe
is a full resync, and removes the stale snapshot if persistence fails.

## Legacy V1 — Phase 4 columnar element encoding + type-elision ✅ shipped

Two per-element encoding transforms applied on TOP of the Phase-3 delta. Both
change only the COMPACT wire; the persisted snapshot file and `format:"full"`
keep full fidelity.

- **Columnar `el_table`.** A compact `elements` JSON array repeated every field
  NAME on every element (`"ref":`, `"label":`, `"tag":`, …). The compact wire now
  carries the element set as `el_table`: a tab-delimited table whose first line is
  a header naming the columns present in this emit (a subset of
  `ref,label,tag,role,type,value_len,checked,href,testId,topmost,occluded_by,frame_origin`,
  always leading `ref,label,tag`), then one tab-joined row per element in header
  order. `frame_origin` is present only for child-frame controls; known captcha
  challenge frames are omitted from this ordinary inventory. An empty cell means
  the field is absent; `value_len` is numeric,
  `checked`/`topmost` are `true`/`false`. Tab, newline, carriage-return and
  backslash inside a cell are backslash-escaped (`\t \n \r \\`) — measured
  escaping overhead on the corpus is negligible (<0.1% of labels carry any of
  them). Column order is canonical so a parsed row reconstructs byte-identically
  (`parseElementsTable` is the inverse and backs the lossless-resync gate).
  `el_table` is omitted entirely when an emit has no element rows (e.g. an
  all-unchanged delta). It composes with the delta exactly as `elements` did:
  on `delta:true` it lists only the changed rows (upsert by ref); on a full
  resync it is the resync set minus collapsed chrome links; `removed`/`unchanged`/
  `text_unchanged` are unchanged. `format:"full"` keeps the `elements` JSON array
  (the escape hatch stays byte-equivalent to the legacy shape).
- **Type-elision.** On the wire form only, drop a `type` value the planner
  already infers from tag/role — `button`/`submit` (implied by the tag/role) and
  `text` (the default input type); other types (email, password, checkbox, …) are
  kept. An input action control keeps `button`/`submit` unless its tag or role
  already identifies it as a button. `role` elision was measured at ~0.08% and
  SKIPPED. A `landmark`→1-char code was scoped but is a no-op: the region field
  (`container`/`landmark`) was already dropped from the compact wire in Phase 1,
  so there is nothing left to shorten — that saving is already banked.

**Measured MARGINAL saving on top of the Phase-3 delta** uses the whole
production-shaped observation over ~500 real corpus runs / ~4,200 observes:
corpus-derived page text with text-delta behavior, every emitted field, and the
fixed `snapshot_file` cost. The harness prints aggregate and per-run
p10/median/p90 for columnar, type-elision, and combined. The measured aggregates
are 14.5%, 1.8%, and 15.9%, respectively. Columnar is gated at ≥10%, combined
must be at least columnar, and the small net-positive type-elision is measured
but not numerically gated.

## Regression gates

`apps/mcp/src/bot/__tests__/observe-delta.test.ts` owns the lossless-resync,
actionable-never-dropped (including dismiss anchors), clickable-unchanged,
text-delta, distinct-selector no-retarget, positional-group volatile re-mint
(issue #399 — state-differing checkbox siblings, per-row Remove buttons, and
remove-then-restore across a failed persist), corpus budget, snapshot permission
and failure fallback, remove-then-restore resynchronization, and
full-escape-hatch invariants, plus the Phase-4 columnar/type-elision marginal.
The corpus budget requires at least 50% token-weighted aggregate savings vs the
pre-delta payload while allowing low-savings single-observe and high-churn runs;
the Phase-4 marginal gate separately requires columnar ≥ 10% and combined ≥
columnar on top of the delta baseline. Type-elision is measured and printed but
not gated because its standalone whole-payload marginal is negligible. The
lossless-resync invariant reconstructs the full element set by parsing the
columnar `el_table` delta stream.

`apps/mcp/src/bot/__tests__/locator-fallback.test.ts` owns the real-browser
ref-less click gates: visible affordance matching, ambiguity refusal, overlay
behavior, shadow roots, disabled controls, bounded candidate scans, and handle
disposal. `operate-session-flow.test.ts` owns locator typing and the action-time
frame guards. `browser-frame-support.test.ts` owns ordinary same-/cross-origin
frame extraction, origin tagging, frame-scoped clicking, captcha-frame
exclusion, and the no-frame negative control.

`apps/mcp/src/bot/__tests__/modal-overlay-inert.test.ts` owns the real-browser
inert-ancestor modal gates: dialog controls remain topmost and clickable while
background controls remain protected; inert state and temporary markers are
restored across close, replacement, open-shadow, and child-frame paths; true
sibling portals remain unaffected; and `modal_active` stays correct on full and
delta emits.

## Legacy V1 non-goals / explicitly avoided

- Pagination as V1's primary model (it requires host-managed page boundaries and
  cannot represent small in-place changes as directly as ref-keyed deltas). V2
  intentionally uses bounded, session-owned cursor pages instead.
- Replacing perception with screenshots.
- Hard element caps without ranking + truncation metadata.
- Dropping `accessibility`/`href`/`occluded_by` as a blanket default (they are
  perception, not logging).
