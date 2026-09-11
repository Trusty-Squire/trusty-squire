# Canonical DOM serialization

`format:"full"` compact-v2 observations use the TypeScript port of browser-use 0.13.10 in
`apps/mcp/src/bot/browser-use-serializer.ts`. `browser-use-capture.ts` adapts
Chrome's DOM, layout snapshot and accessibility trees to its input. Python is
used only by the committed fixture generator, never by the MCP runtime.

The full-DOM response uses `dom`: tab-indented nodes with interleaved visible
text. It has no byte-count acceptance target or tail truncation. The default
`format:"compact"` response is instead the bounded paged control map specified
in [`observation-model.md`](observation-model.md). The exact full-DOM output
contract is the mechanically generated corpus in `fixtures/browser-use/`; see
its README for regeneration and drift checks.

## Identity, deltas and query

`[@e:<22 base64url characters>]` is a 132-bit session-secret HMAC capability.
`StableObservationRefs` owns one anchor per physical CDP node, scoped by a private
random frame namespace, Chrome document loader, and the existing document epoch.
Unrelated text, sibling insertion/order, values, selection and scrolling preserve
that anchor. A missing node or changed material intent retires it; restoring the
old appearance cannot revive a retired capability. Identical replacement markup
is a different node and cannot inherit a ref. Unbound/duplicate identities fail
closed. Full CDP accessible names and authored role, destination and form binding
supply intent checks; inventory-relative inferred labels do not supply identity.

Query labels are compatibility aliases bound once to that same capability. Every
actionable compact-map row receives a concise alias: Chrome's resolved accessible
name takes precedence, followed by authored `aria-label`, `aria-labelledby` or
an associated label, an image control's own `alt`, visible control text, a
button value or descendant icon name, title, and—only for textboxes—placeholder
or name. If none is meaningful, a named semantic container plus the control
role is used; otherwise the emitted role and a deterministic position provide
the floor. Aliases preserve page-provided Unicode content after NFKC
normalization, exclude the compact-map delimiters, and are bounded to 32
characters. This display-only derivation neither changes private query matching
nor becomes a second semantic re-resolution path. An alias is reserved through
document reset and never transferred to a replacement node. The opaque suffix
grew from 11 to 22 characters; the prefix and observation/query field shapes
remain. The full design and regression map are in
[data/ts-persistent-element-identity/report.md](../data/ts-persistent-element-identity/report.md).

A changed view sends its complete `dom` tree;
`delta: true` identifies an existing document, and `removed` names refs that left
the rendered view. An unchanged view emits `dom_unchanged: true` and omits `dom`, retaining the
consumer's prior view. A newly blank view still emits `dom: ""` with no unchanged
signal. `unchanged` remains the legacy numeric count; the DOM signal has its
own name. This is wire clarity only; change detection, revisions and removals
retain their existing semantics. Query operates on the full document inventory, including controls outside
the viewport, and retains its existing paged search-result format and aliases.
Query results are not a second DOM observation serializer.

Compact roles retain the existing short codes for common controls. Other captured
roles are emitted literally (for example `slider` or `generic` for a listener
container), never defaulted to `button`; role queries accept these literal roles.
Visible verification instructions and structurally identified validation errors
appear in `semantic.blockers`, with `semantic.blocked: true` independent of `stage`.
This reports observed evidence and adds no action or payment gate. Missing evidence
is not proof the page is unblocked. Startup can precede a late-rendering error;
use a fresh observation to distinguish timing from extraction loss.

Challenge blockers may include `cause: "scope"` and sorted, distinct
`cause_hosts` when challenge-host denials belong to the current main document
and it has exactly one identified challenge. Child-frame denials, prior-document
denials, and ambiguous or unowned challenges do not receive this causal label;
the separate `scope_denials` diagnostic remains available. Annotation happens
before format serialization: compact observations and query results retain it
in `semantic.blockers`; full observations include `semantic.blocked` and the
blocker list when a scope cause is present, even when `dom_unchanged` is true.
See [session scope](operator-tool-surface.md#scope-is-declared-at-session-start)
for host allowances and recovery guidance, and `clerk-protect-scope.test.ts`
for the document-correlation and format regressions.

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
Live capture uses each frame's actual viewport, ancestor opacity, positive layout
area and overflow clipping that respects fixed/absolute containing blocks. A
viewport-fixed control can escape an ordinary overflow wrapper; a transformed
containing block can still clip it. Transparent or fully clipped contents do not
become visible controls merely because a descendant has opacity 1. An ordinary
ancestor's empty layout box does not suppress visible descendant blockers (for
example, a fixed app shell inside a zero-height body); hidden frame boundaries
still suppress their contents. Offscreen controls in a scrollable document remain
queryable; compact rows mark them `v=offscreen`.
Frame coordinate translation stays separate from same-document overflow clipping.
Hidden file inputs retain the existing upload exception. The canonical fixture
serializer's fallback for missing geometry is unchanged.
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
For three or more structurally matching custom-element siblings containing
controls, production may emit a `<tag repeated ×N>` group with ordered `[item N]`
entries. Each control and every differing product name, price or state remains
explicit. Identical inert custom subtrees are emitted once with `[subtree N]`
and referenced as `[same subtree N]` within that group. These numbers are display
annotations, never action capabilities. Grouping is used only when its UTF-8
output is smaller than the normal rendering. It never shares an interactive
subtree, crosses frame/shadow boundaries, or coalesces distinct action refs.

Custom elements require real activation evidence: an authored interaction role,
handler, command/popover trigger, or registered form association. Focusability
alone, including `tabindex` and AX focusability, is insufficient; nor are a tag,
search-like class, small dimensions or inherited pointer cursor.
Capture checks form association, roles and command/popover triggers across all
open DOM roots. Expensive handler discovery uses `DOMDebugger.getEventListeners`
with `pierce` on at most 100 likely-actionable custom elements, prioritizing
visible product, price, form and interaction-role context ahead of decorative
elements. It traverses open shadow roots; closed roots remain uninspectable. A
listener-only custom element outside that prioritized budget fails closed rather
than being inferred interactive. A custom wrapper's explicit label can name its
sole enabled interactive descendant only after the wrapper and every descendant
are counted; hidden or disabled inputs do not compete for ownership, while
multiple genuine controls prevent label inheritance.


Unlabelled, non-interactive SVG rows are omitted. Interactive SVG descendants
remain visible. Unlabelled iframe hints inherit only bounded local container text or
the nearest bounded preceding heading in document order; oversized containers supply no inherited hint.
Only explicitly non-interactive empty hints may be omitted. Unlabelled form rows inherit enclosing row/heading text when available. A row
may be omitted only if its exact target ref has already been emitted.
Distinct checkboxes survive regardless of how similar they look. This does not
infer that a second checkbox is a proxy from appearance alone.

Plain `pre`/`code` syntax markup becomes one quoted text row, preserving original
spaces, line breaks and punctuation (including single-character tokens). Internal
paint coverage from syntax markup cannot empty a visible code root; external
occlusion still suppresses it. Explicit controls, listeners, focusability and
scrolling prevent coalescing their action surface. The canonical small-icon
class/geometry heuristic is not evidence that a syntax-highlight span is a control.

Selectable controls emit authored `aria-pressed`/`aria-selected` and existing
`data-state` values, plus raw `state_class` for selection classes and directly-owned,
noninteractive visible check, selected, tick, or authored ARIA-state `state_icons`
evidence. These are DOM facts, not inferred selected booleans. Ambiguous nested
controls retain their own refs and do not establish state for a parent.
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

- `browser-use-serializer.test.ts` compares the seven generated captures in canonical
  mode, allowing only identity substitution. `observation-byte-efficiency.test.ts`
  covers the local differences.
- `observation-dom-correctness.test.ts` compares rendered hidden/visible, collapsed/scrollable,
  generic/slider, duplicate-link and settled-error fixtures with both projections.
  These local fixtures do not establish live-provider CSS or timing.
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
