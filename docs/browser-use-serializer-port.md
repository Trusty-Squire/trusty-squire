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

`[@e:...]` uses the existing document-scoped stable refs instead of canonical
browser-use's numeric identities. Those refs remain actionable after another
observation of the same document. A changed view sends its complete `dom` tree;
`delta: true` identifies an existing document, and `removed` names refs that left
the rendered view. An unchanged view omits `dom`, retaining the consumer's prior
view. Query operates on the full document inventory, including controls outside
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

The existing secret-shaped substring redactor screens human-readable naming
attributes, image names, compound-control descriptions and visible text before
rendering. Machine identifiers, source URLs and field values retain canonical
attribute semantics. It does not rewrite structural ref markers or collapse whitespace.
For truncated names, screening examines the full original name and tracks the
original positions of replaced spans. The canonical 100-code-point cutoff and
ellipsis stay fixed even if a redaction shortens the prefix or spans that cutoff;
no extra trailing words or partial secret fragments can become visible. The
detector expressions, order and entropy rules remain unchanged.
Screenshots, extracts, vault behavior, payments and OAuth are outside this change.
A failed DOM capture raises a concrete error; it cannot masquerade as an empty
but successful observation.

## Filters and follow-up

Viewport visibility is computed before tree simplification and containment.
The containment threshold is exactly 0.99; text, form fields/labels, nested
propagating controls, explicit onclick handlers, meaningful aria-labels and
interactive roles retain canonical carve-outs.

**Named immediate follow-up: browser-use paint-order removal.** This phase does
not claim occlusion equivalence. Implement canonical `PaintOrderRemover` together
with the required paint-order snapshot data, then regenerate the canonical
fixtures with paint-order filtering enabled. Do not approximate it with a center
point hit test. The current canonical captures explicitly disable this filter,
as authorized by the binding engineering review.

Recorded observation recipes are incompatible with the new DOM representation.
The existing 54-test recipe suite passes, so no recipe assertions were removed
or quarantined. Unrelated behavior and payment suites remain required.

## Validation

- `browser-use-serializer.test.ts` compares the six generated captures, allowing
  only identity substitution.
- `observation-prose.test.ts` now exercises the replacement through real Chrome,
  including hierarchy, containment, redaction, frame bindings and below-fold reachability.
- `operate-session-flow.test.ts` covers whole-document query, scroll reachability,
  stable refs, changed interleaved text, and explicit capture failures.
- `pnpm --filter @trusty-squire/mcp test:fast` runs the static required tier.

Canonical equality is checked **before screening**, normalizing identity only.
The unchanged secret-shape detection rules are tested separately. Corpus-wide
structural-invariance assertions require screening to change only redacted spans,
with identical line counts, indentation and refs. The HN fixture explicitly pins
`usernametaken29` becoming `[redacted]`: redacting this plain lowercase-plus-digits
username is a **redactor false positive** worth tuning in a separate task, not in
this port. This limitation must also be recorded in the PR body.
