# Persistent element identity

## Design (before implementation)

The current HMAC allocator is document-scoped, but its input is a tiered,
inventory-relative fingerprint. A duplicate sibling changes that tier; removing
an indistinguishable sibling can transfer its ordinal to another node. Labels
are also assigned ordinals anew for each snapshot. Neither is a DOM identity.

Bind action identity to Chrome's backend DOM node ID, scoped by a private random
frame identity. These identifiers come from CDP, never from page attributes.
The external capability remains session-secret HMAC output; increase it from
66 to 132 bits (22 base64url characters). No DOM node ID or private frame identity
is emitted. Document epochs still invalidate navigation and logical route changes.

A single session allocator owns each anchor: physical node identity, material
intent signature, random capability and optional descriptive alias. Repeated
captures reuse that anchor despite inventory order, duplicates, sibling text,
values, selection or viewport changes. Material intent includes the element's
own full accessible naming signals, role/type, destination and form binding,
not a truncated label or inventory ordinal. Observing a material change retires
the capability; reverting later cannot revive it. Missing nodes are retired.
A replacement node receives a different capability even with identical markup.

Labels remain a compatibility spelling of the same anchor: assigned once per
capability, reserved until document reset, and never reassigned to a different
node. Query and live resolution use the same allocator. Labels do not provide
an independent semantic fallback. Full DOM serialization and the action map
share the handle computation from ac3a326d (fingerprint dedup). dom_unchanged
still compares the serialized DOM, and removed still names departed refs.

Wire change: the @e: prefix and observation/query shapes stay; opaque suffixes
increase from 11 to 22 characters. Duplicate label suffixes are now persistent
within a document rather than recomputed by row order. Existing screening,
state-evidence checks, payment authorization and frame guards remain unchanged.
Legacy non-compact fingerprints remain available for the legacy interface;
production compact captures always supply CDP identity.

Validation will cover sibling insertion/removal/reordering, identical-node
replacement, own-label/destination change and reversal, document replacement,
alias non-retargeting and session-separated high-entropy refs. Real Chrome
capture tests establish backend identity continuity across fresh CDP sessions;
operator tests establish held-ref acceptance/refusal and dispatched target.

## Initial validation checkpoint (superseded below)

- Initial targeted validation: 420 tests passed across operator flow, allocator,
  and real-browser observation suites; MCP typecheck passed.
- Required fast-core group: 87 files passed; 1492 tests passed, 1 skipped.
  Full required behavior/payment run was in progress at the initial handoff.
- At that checkpoint the additional frame-document regression was blocked: its srcdoc child control has
  no action ref, both on an about:blank parent and after moving the parent to a
  local HTTP origin. 20 other browser tests pass. Investigate capture binding /
  loader availability for srcdoc was the pending investigation. No security fallback was added.
- Project-memory helper returned a conflict because AGENTS.md and CLAUDE.md are
  both real files. Neither file was replaced; AGENTS.md already has its
  Maintaining this file section.
- At that checkpoint final changes were uncommitted (apart from the imported
  dedup prerequisite). No pipeline, push, PR, release or deployment had run.

## Srcdoc baseline decision (2026-09-07)

Firstmate authorized checking origin/main and excluding pre-existing frame
addressability limitations. Executed the browser controller, capture and ref
allocator from origin/main (6fe9c010) against real Chrome; both blank and HTTP
parents returned `capturedIds: ["submit", null]`, `childActionRef: null`, and
`actionRows: 2`. Source was loaded from git objects, not inferred from this
branch. Tool: `pnpm --filter @trusty-squire/mcp exec vitest run
src/bot/__tests__/srcdoc-baseline.test.ts`; 1 test passed. The temporary baseline
modules/test were removed after recording the output in `srcdoc-baseline.log`.

Conclusion: srcdoc child addressability predates this change and is out of scope.
The additional regression now checks form-destination invalidation only. The
physical-node test retains sibling/content change, replacement, own-name change,
reversal and removal coverage. No frame-addressability fallback was added.

## Final implementation details

Frame identity is additionally scoped by Chrome's document loader ID, preventing
node-number reuse across frame-document replacements. Material intent uses CDP's
accessible name and the node's own attributes; the legacy extractor can infer a
label from a preceding sibling, so that inferred label is deliberately excluded.
Both ancestral forms and explicit `form=` owners contribute destination and
ownership evidence. Effective link, form and submitter destinations are resolved
against the live per-frame `document.baseURI`, so a base-only retargeting change
retires the held capability even when the physical nodes and authored relative
attributes remain unchanged. Missing or duplicate physical identities receive no action
capability. The shared DOM/action handle computation remains intact.

Submitter anchors also bind their effective action, method, target, encoding and
validation semantics. Each value inherits from its owning form unless the submitter
overrides it, so mutations to either source retire the capability before a stale
submit can change request behavior. The first document base target supplies the
default browsing context for target-less forms, submitters and links, and the
submitter's name/value pair is also bound because it becomes submitted form data.
Explicitly empty targets remain distinct from a missing target, while missing or
empty form and submitter actions resolve to the document URL rather than a base
URL. Link download presence/value is material because it changes navigation into
a download. Reserved browsing-context target keywords are normalized
case-insensitively, while named targets preserve their authored case. Ordinary
editable-field values remain non-material.

Explicit `form=` ownership is resolved through the browser's effective form
association, not by matching every duplicate ID. A non-owner form can change
without retiring the control's capability; an actual owner change still does.
Inherited form context stops at shadow-root and nested-document boundaries, so
parent form changes do not stale controls the browser does not associate with it.
Form destination evidence applies only to the existing submitter classification;
non-submitting controls and iframe/frame wrappers do not inherit parent form intent.

## Deferred native activation concerns

Two source-reviewed concerns are explicitly outside this persistent-identity
change: link/form relation, ping and referrer-policy activation semantics; and
native button command/popover routing with auto-state submitter behavior. They
require their own scope and validation plan. No runtime or test changes for
either concern are included here, and neither is claimed as live-proven.

Final focused validation after the srcdoc decision: all 21 real-browser tests
passed, including physical-node persistence/replacement and both ancestral and
explicit form-destination changes. Typecheck and changed-file ESLint exited 0.

Required-tier evidence: `pnpm --filter @trusty-squire/mcp test:fast` exited 0.
Fast core: 87 files passed, 1492 tests passed / 1 skipped. Required behavior:
16 files passed, 624 tests passed / 3 skipped. Required payment safety:
9 files passed, 469 tests passed. Total: 112 files, 2585 passing tests and
4 existing skips. No tier manifest or screening/state-evidence gate was changed.
The final capture change was additionally covered by the subsequent 21-test
browser-suite run noted above. No publish or merge was attempted; no-mistakes
shipping follows Firstmate's post-commit instruction under the delivery contract.
