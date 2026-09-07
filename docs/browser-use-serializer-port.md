# Canonical DOM serialization

Compact-v2 observations use the TypeScript port of browser-use 0.13.10 in
`apps/mcp/src/bot/browser-use-serializer.ts`. `browser-use-capture.ts` adapts
Chrome's DOM, layout snapshot and accessibility trees to its input. Python is
used only by the committed fixture generator, never by the MCP runtime.

The former flat observation table and separate `text` / `text_unavailable`
channel are replaced by `dom`: tab-indented nodes with interleaved visible text.
There is no observation byte-count acceptance target and no tail truncation to
meet one. The exact output contract is the mechanically generated corpus in
`fixtures/browser-use/`; see its README for regeneration and drift checks.

## Identity, deltas and query

`[@e:<11 base64url characters>]` uses session-secret HMAC identities instead of
canonical browser-use's per-observation indices. `StableObservationRefs` maps the
existing fingerprint to a 66-bit opaque capability for the lifetime of its document;
the document identity and collision retry are part of its HMAC input. Display-only
refs use a separate identity namespace in that same allocator. Action authorization
requires the observed map and live fingerprint match in addition to possession of
the capability. Those refs remain actionable after another observation of the same
document while their fingerprint is unchanged. If a structural change changes a
control's fingerprint, its earlier capability invalidates fail closed and requires
re-observation. A changed view sends its complete `dom` tree;
`delta: true` identifies an existing document, and `removed` names refs that left
the rendered view. An unchanged view emits `dom_unchanged: true` and omits `dom`, retaining the
consumer's prior view. A newly blank view still emits `dom: ""` with no unchanged
signal. `unchanged` remains the legacy numeric count; the DOM signal has its
own name. This is wire clarity only; change detection, revisions and removals
retain their existing semantics. Query operates on the full document inventory, including controls outside
the viewport, and retains its existing paged search-result format and aliases.
Query results are not a second DOM observation serializer.

Every DOM observation includes `more_above` and `more_below`. The existing scroll
action remains reachable. A below-fold control can be found with
`operate_observe(query=...)`, then scrolled into view or targeted by its returned ref.
Changing the viewport does not retire a control's document identity.

An unbindable node never blanks the observation. Bindable controls retain their
action refs; other interactive nodes retain a document-scoped display ref and
`not-targetable=true` in the tree. These fallback refs are excluded from the
action/query map, so targeting one cannot dispatch an action. Closed shadow
roots are visible through CDP but not addressable by the current Playwright
selectors; their controls follow this path. This explicit marker is the
captain-authorized exception for unbindable nodes, not a change to canonical
rendering of bindable nodes. The shadow fixture and session regression cover
complete surrounding text, working sibling controls and stable fallback refs.

Read-path redaction is removed by the standing captain directive, restated on
2026-09-07. Names, visible text, semantic headings and revealed field values are
page content; no vendor-prefix, entropy or secret-shape screen rewrites them.
Canonical attribute and length semantics remain. Payment fences, the vault's
write-only boundary and sealed credential-slot injection are untouched.
A failed DOM capture raises a concrete error; it cannot masquerade as an empty
but successful observation.

## Filters and follow-up

Viewport visibility is computed before tree simplification and containment.
The containment threshold is exactly 0.99; text, form fields/labels, nested
propagating controls, explicit onclick handlers, meaningful aria-labels and
interactive roles retain canonical carve-outs.

`browser-use-paint-order.ts` ports the pinned `PaintOrderRemover`: full rectangle
union coverage, descending paint-order batches (equal orders cannot cover one
another), separate iframe documents, transparent-background exclusion, opacity
threshold 0.8, and the upstream 5000-rectangle insertion cap. Capture requests
`includePaintOrder` and retains computed styles. No hit-test approximation.

Production adds explicit byte-efficiency/reachability differences after the
canonical port. Covered interactive controls remain addressable, even though
upstream suppresses their indices. Consecutive inert sibling subtrees with the
same structure and text collapse with `[repeated ×N]`; only whitespace differences
and presentation attributes (`id`, `class`, `style`) are ignored. Numbers, names,
prices, statuses, meaningful attributes and all interactive descendants prevent
collapse. Structural keys are interned bottom-up rather than recursively escaped.

Unlabelled, non-interactive SVG rows are omitted. Interactive SVG descendants
remain visible. Unlabelled iframe hints inherit only bounded local container text or
the nearest bounded preceding heading in document order; oversized containers supply no inherited hint.
Only explicitly non-interactive empty hints may be omitted. Unlabelled form rows inherit enclosing row/heading text when available. A row
may be omitted only if its exact target ref has already been emitted.
Distinct checkboxes survive regardless of how similar they look. This does not
infer that a second checkbox is a proxy from appearance alone.

Plain `pre`/`code` syntax markup becomes one quoted text row, preserving original
spaces, line breaks and punctuation (including single-character tokens). Explicit
controls, listeners, focusability and scrolling prevent coalescing their action
surface. The canonical small-icon class/geometry heuristic is not evidence that
a syntax-highlight span is a control.

Selectable controls emit authored `aria-pressed`/`aria-selected` and existing
`data-state` values, plus raw `state_class` for selection classes and visible
check, selected, tick, or authored ARIA-state child `state_icons` evidence. These are
DOM facts, not inferred selected booleans.
Stateless cards keep stable action refs but selection is undetectable by design;
an unrelated button enabling cannot establish which card is selected.

The internal `canonical: true` test option disables these local differences;
production never selects it. Canonical fixtures are regenerated verbatim using
the pinned Python script with paint-order filtering enabled. The fixture equality
test still normalizes only identity. Production efficiency and reachability are
tested separately against those same captured inputs and executable regressions.
See [byte measurements](observation-byte-efficiency.md) for reproducible before/after
numbers and the distinction between live captures and synthetic reproductions.

Recorded observation recipes are incompatible with the new DOM representation.
The existing 54-test recipe suite passes, so no recipe assertions were removed
or quarantined. Unrelated behavior and payment suites remain required.

## Validation

- `browser-use-serializer.test.ts` compares the six generated captures in canonical
  mode, allowing only identity substitution. `observation-byte-efficiency.test.ts`
  covers the local differences.
- `observation-prose.test.ts` now exercises the replacement through real Chrome,
  including hierarchy, containment, verbatim page content, frame bindings and below-fold reachability.
- `operate-session-flow.test.ts` covers whole-document query, scroll reachability,
  stable refs, changed interleaved text, and explicit capture failures.
- `pnpm --filter @trusty-squire/mcp test:fast` runs the static required tier.

Canonical equality is checked directly, normalizing identity only. The volatile HN
capture does not pin `usernametaken29`; its regression injects that value into visible
fixture text before serialization. Browser regressions also cover the reported
`trusty-squire-dogfood-20260625` slug, synthetic key names and documentation JSON,
and rendered API-key-shaped text in names, prose and revealed input values.
