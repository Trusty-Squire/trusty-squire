# DESIGN — compact operate observation payload

## Problem

Every `operate_*` turn returns a full perception payload from `observeSession`
(provision-session.ts). It is 30–50 KB per turn, and `operate_act` re-emits it
after *every* action — so a single form-fill flow spends hundreds of KB of host
context on perception, most of it redundant.

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
4. The planner drives off `text` (read state) + `elements` (pick `ref`); the
   `screen` region-tree and `accessibility` flat-tree are not needed to choose an
   action. `occluded_by`/`topmost`/`href` ARE load-bearing — keep them (per-element).

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
- **Compact `elements`**: omit any field that is `null` / `""` / `false`; emit
  `topmost` only when `false` (the informative case) and `occluded_by` only when
  set. Keep `ref`, `label`, `tag`, `role`, `type`, `checked`(true), `href`,
  `testId`, `path`.
- **Drop `container`** (redundant with `path`).
- **`value` → `value_len`** (a number), never the raw value — reinforces the
  sealed-field moat and saves bytes. (Sealed fields already render `[sealed]`;
  in compact they become `value_len` of the placeholder.)
- **Metadata** so omission is explicit, never silent:
  `elements_total` (count) and `text_truncated` (the 4000-char text cap tripped).

**Full mode is byte-identical to today** (default path unchanged) so nothing
regresses while compact is validated.

Projected: ~50 KB → ~17–20 KB per turn (≈60% cut) with **zero perception loss**
(`path` retained for disambiguation). Dropping `path` too (rely on `ref`) reaches
~74% but is deferred to the eval — `ref` is the machine target, `path` is the
human/planner disambiguator for repeated labels / modal overlays.

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
sub-tree reads and `since_observation_id` diffs likewise remain unbuilt.

## Eval gate (before flipping default)

Run the planner-eval / shadow harness comparing compact vs full on the corpus;
the corpus MUST include the wrong-click cases: repeated buttons, modal overlays,
icon-only controls, signup error states. Flip the default only when ref-selection
accuracy + provision success are unchanged.

## Non-goals / explicitly avoided

- Pagination as the primary model (page state + refs go stale).
- Replacing perception with screenshots.
- Hard element caps without ranking + truncation metadata.
- Dropping `accessibility`/`href`/`occluded_by` as a blanket default (they are
  perception, not logging).
