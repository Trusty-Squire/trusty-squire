# DESIGN — compact and delta operate observation payload

## Problem

Before compact observations shipped, every `operate_*` turn returned a full
perception payload from `observeSession` (provision-session.ts). It was 30–50 KB
per turn, and `operate_act` re-emitted it after *every* action — so a single
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
4. The planner drives off `text` (read state) + the element inventory (pick
   `ref`); the `screen` region-tree and `accessibility` flat-tree are not needed
   to choose an action. `occluded_by`/`topmost`/`href` ARE load-bearing — keep
   them (per-element).

## The one knob — `detail`

There is a single ordered control, set **per call**, no env/global flag:

```
detail:  none  <  compact  <  full
         ack       default     legacy (compact + screen + accessibility + raw fields)
```

`operate_observe({ detail })` accepts `compact|full`; `operate_act({ detail })`
also accepts `none` (a bare ack). Default everywhere is **compact**. There is no
deploy-time override: unlike the server kill-switches (signups/egress/billing),
`detail` only shapes the payload returned to the host on the user's own machine —
it has no server-side blast radius, so there's nothing for an operator to revert.
If a step is genuinely ambiguous the planner escalates to `detail:"full"` for
that one call.

## Phase 1 — compact encoder ✅ shipped, DEFAULT

When `detail` is `compact` (the default), `observeSession`:

- **Omit `screen` + `accessibility`** (the two re-encodings). Also skip computing
  them (CPU win).
- **Build compact element records**: omit empty fields; preserve `checked` for
  both true and false checkable states, emit `topmost` only when `false` (the
  informative case), and emit `occluded_by` only when set. Keep `ref`, `label`,
  `tag`, `role`, `type`, `href`, and `testId`.
- **Drop `path` and `container` from the wire payload.** `container` is redundant
  with `path`; the verbose `path` remains in the complete persisted snapshot for
  re-expansion and targeted searches.
- **`value` → `value_len`** (a number), never the raw value — reinforces the
  sealed-field moat and saves bytes. (Sealed fields already render `[sealed]`;
  in compact they become `value_len` of the placeholder.)
- **Metadata** so omission is explicit, never silent:
  `elements_total` (the complete current count, including delta/collapsed
  omissions) and `text_truncated` (the 4000-char text cap tripped).

**Full mode remains the byte-equivalent escape hatch:** it returns every element
and field plus `screen` and `accessibility`, with no delta markers, link collapse,
or snapshot pointer.

Measured on a real six-observe Casetify sequence, compact deltas cut context by
78%; dropping `path` from the wire payload raised the cut to 85%. The
token-weighted aggregate over the real corpus is approximately 66%. Across
approximately 58,000 same-selector re-observe pairs, mutable path-region data
re-minted 0.00% of refs.

## Phase 2 — the `detail` ladder ✅ shipped

- `operate_observe({ detail: "compact" | "full" })` — `full` restores the legacy
  screen+accessibility+raw-field payload for an ambiguous step.
- `operate_act({ detail: "none" | "compact" | "full" })` — `none` returns a
  minimal ack (action ran; no page dump) so chained fills don't each echo the
  page (call `operate_observe` before the next ref-targeted act). Same vocabulary
  as `operate_observe`, plus the bottom rung.

deferred (Phase 2.5, only if evidence demands): an `include` partial-escalation
(re-add just one heavy view) was considered and dropped — it breaks the linear
ladder and `full` already covers the rare escalation. `scope:{ref}`/`depth`
sub-tree reads remain unbuilt.

## Phase 3 — stable refs and per-session deltas ✅ shipped

Compact observations minimize repeated context without making the stream lossy:

- **Stable refs.** Refs use `@e:<identity>_<ordinal>` and do not contain an
  observation generation. An unchanged element keeps resolving across observes.
  The identity includes the element selector, so same-label siblings with
  distinct stable selectors get distinct refs; after one is removed, its old ref
  resolves to `null` instead of retargeting its sibling. There is one bounded,
  unguarded exception: when sibling controls are distinguishable only by a
  positional `:nth-child`/`:nth-of-type` selector and `screenPath` does not
  distinguish their row, removing the first sibling shifts the survivor onto the
  removed node's identity. The removed node's old ref is then not in `removed`
  and still resolves to the survivor. `screenPath` normally includes a row/index
  and prevents this collision. Fully closing it requires an extractor-provided
  stable node id or a per-observe generation; the latter defeats the stable-ref
  reuse this design exists to preserve.
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

`detail:"full"` bypasses all delta and collapse behavior and preserves the rich
payload shape byte-for-byte. As an unsurfaced side effect it replaces the
persisted snapshot, invalidates the compact baseline so the next compact observe
is a full resync, and removes the stale snapshot if persistence fails.

## Phase 4 — columnar element encoding + type-elision ✅ shipped

Two per-element encoding transforms applied on TOP of the Phase-3 delta. Both
change only the COMPACT wire; the persisted snapshot file and `detail:"full"`
keep full fidelity.

- **Columnar `el_table`.** A compact `elements` JSON array repeated every field
  NAME on every element (`"ref":`, `"label":`, `"tag":`, …). The compact wire now
  carries the element set as `el_table`: a tab-delimited table whose first line is
  a header naming the columns present in this emit (a subset of
  `ref,label,tag,role,type,value_len,checked,href,testId,topmost,occluded_by`,
  always leading `ref,label,tag`), then one tab-joined row per element in header
  order. An empty cell means the field is absent; `value_len` is numeric,
  `checked`/`topmost` are `true`/`false`. Tab, newline, carriage-return and
  backslash inside a cell are backslash-escaped (`\t \n \r \\`) — measured
  escaping overhead on the corpus is negligible (<0.1% of labels carry any of
  them). Column order is canonical so a parsed row reconstructs byte-identically
  (`parseElementsTable` is the inverse and backs the lossless-resync gate).
  `el_table` is omitted entirely when an emit has no element rows (e.g. an
  all-unchanged delta). It composes with the delta exactly as `elements` did:
  on `delta:true` it lists only the changed rows (upsert by ref); on a full
  resync it is the resync set minus collapsed chrome links; `removed`/`unchanged`/
  `text_unchanged` are unchanged. `detail:"full"` keeps the `elements` JSON array
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
text-delta, distinct-selector no-retarget, corpus budget, snapshot permission and
failure fallback, remove-then-restore resynchronization, and full-escape-hatch
invariants, plus the Phase-4 columnar/type-elision marginal. The corpus budget
requires at least 50% token-weighted aggregate savings vs the pre-delta payload
while allowing low-savings single-observe and high-churn runs; the Phase-4
marginal gate separately requires columnar ≥ 10% and combined ≥ columnar on top
of the delta baseline. Type-elision is measured and printed but not gated because
its standalone whole-payload marginal is negligible. The lossless-resync
invariant reconstructs the full element set by parsing the columnar `el_table`
delta stream.

## Non-goals / explicitly avoided

- Pagination as the primary model (it requires host-managed page boundaries and
  cannot represent small in-place changes as directly as ref-keyed deltas).
- Replacing perception with screenshots.
- Hard element caps without ranking + truncation metadata.
- Dropping `accessibility`/`href`/`occluded_by` as a blanket default (they are
  perception, not logging).
