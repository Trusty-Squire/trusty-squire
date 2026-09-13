# Design: Trusty Squire operator observation model — skeleton + resident DOM + descriptive refs

**Status:** Current authority for the observation format and narrow card-value mask. The
full browser-use DOM wire, identity, and fixture contract is owned by
[`browser-use-serializer-port.md`](browser-use-serializer-port.md); the remaining
roadmap material is historical.
**Scope:** `@trusty-squire/mcp` operator observation/serialization layer (`operate_observe`, `operate_screenshot`, `operate_extract`, the flat acting verbs, and the browser-use DOM serializer)
**Author:** firstmate, from hands-on operator driving (ipinfo signup + whitejade.xyz checkout, rc.19)
**Related:** The compact-v2 cursor-map regression coverage in
`apps/mcp/src/bot/__tests__/operate-session-flow.test.ts`.

---

## 1. Historical problem statement (before the current compact-query contract)

Driving real signups and a real Shopify checkout on rc.19, the agent was effectively blind and could not reliably fill dynamic forms. Concrete failures:

- **Overflow paging is fatal on live forms.** Controls past the first ~4 go into `overflow`; paging to reach them fails with `stale_cursor`/`invalid_cursor` on essentially every attempt. Root cause (confirmed in `provision-session.ts observeQuery`): the snapshot is bound to the full current URL (Shopify appends a volatile `?_r=` token) and to a byte-identical live-element re-match, so any re-render or URL-token change invalidates it. Interactive checkouts re-render constantly. **Net: the delivery-address fields could not be reached at all.**
- **Controls lose their identity.** Non-viewport controls serialize as a bare role letter (`@e:3.1 "b"`) with no label. `operate_observe(query=...)` matches on labels, so an unlabeled control is unfindable.
- **Screenshots over-seal.** `operate_screenshot` returned `sealed_context` on plain browse and pre-payment checkout pages, not just secret pages — the agent could not see layout at all until after a payment attempt.
- **No readable page text.** `text` is always `""`. Combined with unlabeled controls and sealed screenshots, the agent had no window into the page beyond a lossy control table.
- **Refs churn every action.** Each action used to bump the generation and invalidate every ref, forcing a re-observe per field. A 5-field form was 5 fragile round-trips.

The through-line: the layer is tuned for **payload size** and **secret-safety**, and overshoots on both — compressing away identity and blanket-sealing visibility — which blinds the agent on exactly the dynamic forms (checkout, multi-step signup) that matter.

## 2. Goals

1. An agent can reliably locate and fill a multi-field dynamic form (checkout, signup) without thrashing.
2. An agent can inspect visual pages (shopping grids, product images) in a bounded number of calls.
3. Preserve the vault's write-only delivery boundary and the payment approval
   fences while treating content rendered by the page as observable.
4. Never reintroduce the "serialize everything and paginate" explosion.

## 3. Non-goals

- A browser-native autofill or a vault shipping-address feature (separate decision; the actual form-writing is this layer regardless).
- Rewriting the vault or payment security model.

## 4. Design

### 4.1 Opaque durable identity + descriptive label (DECIDED: option A)

**Correction from review:** an accessible name is *presentation, not identity*. Name-based re-resolution can silently hit the wrong element (duplicate names, swapped list items, localized/changed copy, recycled nodes). So the system does NOT key on the descriptive name. Instead:

- **Identity = physical CDP node identity**, scoped by a private frame namespace,
  Chrome document loader and session document epoch. No DOM id, semantic slug,
  sibling ordinal or selector supplies compact-v2 identity.
- **Ref = 132-bit opaque capability**, generated under a session secret for that
  node and its material intent. Removal or changed intent retires it; identical
  replacement markup never inherits it — with ONE bounded exception for benign
  re-renders, below.
- **Label = compatibility spelling of the same anchor**, allocated once per ref
  and reserved until document reset. It never re-resolves by semantic similarity.
- **Every act checks the observed map and live anchor.** Document/frame guards,
  intent checks, payment gates and the state-evidence gate remain fail closed.

**Benign re-render adoption (2026-09-08).** A dialog/portal mounting re-renders
the underlying page and re-creates its nodes (new CDP backend node ids), which
used to churn every pre-existing ref into `removed` + `*` re-issuance even though
nothing about those controls changed. When an element's physical identity
disappears and a new identity appears in the same round, the new element ADOPTS
the retired ref only when ALL of the following hold; anything else stays
fail-closed and mints a fresh ref:

1. its inventory-independent fingerprint (authored DOM id or semantic
   role+tag+name, evaluated for that element alone) matches the retired anchor;
2. its material action intent is byte-identical to the retired anchor's;
3. its `screenPath` is present and identical on both sides;
4. its frame namespace and document loader match the retired anchor's; and
5. the combined match is unique among both retired anchors and live controls.

Form submitters and checkbox label proxies record durable owner location and
submission semantics in their intent. Physical owner IDs are captured separately:
a persisting node whose owner changes retires its ref, while an unchanged control
remounted with its form or checkbox can adopt within the same frame document.

A new dialog sharing a control's name cannot change this match by changing the
inventory's fingerprint tier. CDP-synthesized controls receive a location path
at capture time from their DOM ancestry, shadow boundaries, stable authored IDs,
roles and explicit labels. The path excludes sibling ordinals and backend node
IDs; indistinguishable matches still cannot adopt. Aliases remain bound to the
adopted capability. See the dialog-remount and owner-replacement regressions in
`observation-prose.test.ts` and the adoption guard cases in
`compact-observation-v2.test.ts`.

Within the same document epoch, compact queries retain the last full DOM's URL,
dynamics and rendered refs together until another full observation is emitted.

**Change hashing beyond the DOM string (2026-09-08).** The canonical DOM string
does not render iframe `src` or element geometry, so a closed-shadow challenge
widget swapping its iframe (Groq Turnstile, Cartesia protect-check) used to
serialize byte-identically and report `dom_unchanged:true` through a real
content swap. `compactV2Observation` therefore also hashes a dynamics signature
(`browserUseDynamicsSignature`: every iframe/frame node's tag, `src`, rounded
bounds and shallow content-document digest; every shadow root's type, host
bounds and child tag digest; plus the live frame URL set) and the page URL into
the last full-emission baseline. A change in any of them — even with a byte-identical
DOM string — forces DOM re-emission on the next full observation, and a
changed main document during an action's settle window marks the returned
observation `navigated:true`. This flag compares `mainDocumentIdentity` before
and after the action. A `history.pushState` pathname change does not set it;
the separate URL-scoped observation epoch still invalidates refs on route changes.

Current implementation and wire contract:
[Canonical DOM serialization](browser-use-serializer-port.md#identity-deltas-and-query).

### 4.2 Resident DOM, projected skeleton (makes expansion free)

The full DOM is already loaded in the operator's browser. The observation is a **projection** of it, not a fetch.

**Compactness invariant (hard requirement, captain-mandated).** The
`operate_start`, `operate_observe`, and ordinary click/type/select/press/scroll
observation payloads MUST stay compact and bounded by default,
regardless of page size. A huge page yields a bounded control-map page, not a
huge payload. `format:"full"` is an explicit escape hatch when the agent needs
the verbatim DOM.

Concretely, `operate_start`, `operate_observe`, and the ordinary click/type/select/press/scroll
actions default to `format:"compact"`: the existing paged `browser-use-control-query` map of
actionable controls, with each `[ref, role, facts?]` row carrying only the identity and state
needed to act. An action can return `delta:true`, changed/new rows in `safe_table`, and
departed stable refs in `removed` only while its same-document comparison map has been
fully delivered to the caller. A fresh, unfiltered observe returns the current map;
`overflow.next_cursor` continues either map under the existing observation-v2 wire budget.
For an initial action response without `delta:true`, replace the prior map;
cursor pages extend the map or delta started by that response.

Full-format observations, filtered queries, paginated responses, and observations
discarded by compound actions or capture invalidate delta eligibility. This includes
the fill before `operate_type(submit:true)`, internal multi-select refreshes, and
every capture-enabled verb whose observation is replaced with vault metadata. The
next compact action returns the current map, paginated if necessary. Paging does
not itself restore delta eligibility; a complete map or eligible delta must fit in
one delivered response. If removal metadata alone exceeds the byte budget, the
action falls back to the current paginated map without `delta` or `removed`.
These delivery and budget cases are covered by the flat operator verb regressions
in `apps/mcp/src/bot/__tests__/operate-session-flow.test.ts`.

Click, type, press, scroll, and single-control select return the observation directly.
`operate_select(selections)` preserves `{ session_id, fields, observation }`, including
partial field results; `format` chooses the format inside `observation`. Capture
continues to return its vault result rather than an action observation.

Non-control nodes are absent by construction; this is a size/shape choice, never
screening or redaction. `format:"full"` explicitly selects the unchanged, verbatim
`browser-use-dom` tree when arbitrary page text, raw attributes, or layout context is needed.

Because the source of truth (loaded DOM) never leaves the browser, rendering
either shape is an in-memory read; the compact map remains bounded and the full
DOM remains an explicit choice.

### 4.3 Superseded proposal: on-demand scoped expansion

Instead of paginating a serialized whole page, the agent pulls detail on a specific ref:

- `expand @ref` → that node's neighborhood (parents / siblings / children) to disambiguate ("which of these five buttons").
- `read @ref` → the element's text subtree, verbatim.

Requests are scoped to a stable ref and return a bounded local view, so navigation is deterministic and cannot explode — the agent only pulls the neighborhood it is inspecting. This proposal was not adopted: compact observations retain their paged `overflow.next_cursor` contract.

### 4.4 Superseded proposal: vision via set-of-marks

Per-element cropped screenshots are O(N) calls — a flower grid would be death by a thousand `show`. Default visual primitive:

- `screenshot` → **one** viewport (or full-page) capture with a labeled bounding box drawn over each interactive element, each box labeled with **the same descriptive ref**. The agent sees the whole grid at once and correlates "the red one, `@product-flower-3`" to its ref — one call, whole page. (This is the proven "set-of-marks" pattern.)
- `show @ref` survives only as a secondary "zoom into this one element" primitive (e.g. one product image in detail), never the default.

### 4.5 Narrow released-card output mask (FINAL: owner's order, 2026-09-12)

`operate_observe`, `operate_network`, console/error evidence, and
`operate_screenshot` expose the live checkout directly. They have one narrow
exception: after `inject_card` opens a released card, that card's complete PAN
and CVV/CVC/CID are replaced before any normal operator output. The record is
installed before the first field write and remains for the browser session,
including after rerenders, navigation, partial fills, or cleared controls.

- Compact versus full observation remains a size/shape choice. The mask applies
  to emitted DOM/AX values, properties, attributes, text, URLs, errors, headers,
  and request/response bodies. PAN formatting with spaces or hyphens is covered.
- `operate_screenshot` composites masks over value-bearing pixels of injected
  controls and identified ordinary displayed copies. It preserves their borders,
  labels, validation errors, and every unrelated pixel. Capturing is never refused.
- Merchant last4, brand/issuer, cardholder name, expiry, billing address, amount,
  currency, DCC text, OTP/3DS controls, HTTP error bodies, API keys, cookies, PII,
  and all unrelated three- or four-digit values remain visible. This is not a
  general secret scanner and does not apply Luhn-wide masking.
- The browser-use DOM format's `url` is the live page URL, path and query included. Its DOM
  attributes follow canonical browser-use's selection and ordering; see the
  pinned serializer contract in `browser-use-serializer-port.md`.
- Credential extraction selects values rather than providing a verbatim page
  read. Its restored selection, truncation metadata, storage behavior, and known
  limitations are owned by the [credential capture contract](operator-tool-surface.md#credential-capture-and-retrieval).

**Boundary and accepted limit.** The normal read API is the masked capture;
raw `Runtime.evaluate` remains operator-internal and the live browser is not also
exposed as an unfiltered debugger. Ordinary forms and reachable hosted fields are
covered. A hostile page can transform, split, encode, or draw a value (for example
into canvas pixels) so it no longer matches the released value; this design does
not claim adversarial information-flow containment. It deliberately adds no
entropy detector, vendor-prefix table, broad Luhn scan, host allowlist, or second
approval.

**What stays separate.** The vault's write-only property, `use_credential`'s
server-side injection, and the existing single human purchase approval remain.
The output mask observes but never blocks or changes a browser action.

Structured audit records and captured action traces carry closed-vocabulary
metadata rather than card values. Browser-originated logs, errors, and
diagnostics pass through the same card-value mask before they leave the
operator.

### 4.6 Superseded proposal: descriptive-ref join key

One handle names a skeleton row, addresses an `expand`/`read`, and labels a set-of-marks box. The agent never translates between "what I see" and "what I act on."

## 5. Historical migration / compatibility notes

- Compact observations retain session-owned cursor pages; see §4.2 for the current format contract.
- The `expand`/`read` and set-of-marks ideas below are historical proposals, not public tools.
- Recipe replay (`operate_recipe_save/run`) binds to targets; descriptive refs are more stable for replay than positional indices, but the migration must confirm recorded recipes still resolve.

## 6. Risks / open questions (for the review)

1. **Ref uniqueness / collisions.** Two "Add to cart" buttons in a grid need disambiguation (index suffix, container path). How is uniqueness guaranteed without reintroducing positional fragility?
2. **Accessible-name absence.** Icon-only buttons with no label/aria — what is the fallback handle, and is it stable?
3. **Set-of-marks cost and legibility.** Rendering boxes on a dense grid; overlap; whether full-page vs viewport; image size limits into the model context.
4. **Secret-node detection accuracy.** False negatives leak a key; false positives redact needed text. What is the detection basis (marked slots vs shape heuristics)?
5. **Expand blast radius.** `expand` on the `<body>` could still be large — expansion must be depth/size-bounded, and the bound's contract must be defined.
6. **Seal interaction.** How `expand`/`read`/`screenshot` each enforce redaction, and whether the generation/HMAC seal still governs cross-document isolation.
7. **Stability across genuine navigation.** A descriptive ref must invalidate on real document change, not persist misleadingly across a navigation.

## 7. Test plan (outline)

- Fill a 5+ field dynamic checkout (name/street/city/zip) in one observe + N acts without a re-observe-per-field, on a page that re-renders between acts.
- Page-token churn (`?_r=` changing) does not invalidate refs on the same origin+path; a real path change does.
- Set-of-marks screenshot labels every interactive element with its ref; a product grid is actionable from one image.
- A rendered API key / recovery code stays visible. A released card's complete PAN/CVV is replaced in DOM/network/error output and covered in screenshots; no page or frame is sealed and no capture is refused.
- Recorded recipe replay still resolves its targets under descriptive refs.

## 8. Review outcomes (plan-eng-review, 2026-09-02)

Independent outside voice: codex (gpt-5.x, high effort, read-only). It landed real hits; both pivotal forks went to the captain.

### Decisions made
- **D1 — element identity = option A** (§4.1): opaque durable fingerprint (DOM id primary when unique+stable, structural+role+name fallback) bound to an observed document epoch; descriptive name is a readable label only; re-resolution only within a verified same-document/form scope; mismatch **fails closed**. Reverses the doc's original "descriptive = stable by construction," which codex correctly showed is false.
- **D2 — sealing = option B** (§4.5): don't seal, node-level redaction only (extended to attributes/control state). Captain accepted the residual canvas/image/SVG/QR/OCR/iframe leak risk in exchange for agent visibility, against codex's push for a frame-level seal. **Superseded twice since — narrowed to payment-only 2026-09-03, then removed entirely 2026-09-05. See §4.5.**

### Codex findings folded as scope/implementation requirements (not open captain forks)
- **Resident-DOM is not universal (feasibility).** Virtualized lists, lazy-load, offscreen controls, shadow DOM, and cross-origin iframes mean a node may not exist. skeleton/`expand`/`read` must handle scroll-to-materialize, shadow-DOM traversal, and iframe boundaries; "`expand` is free" holds only for already-resident nodes.
- **Same-document test must exceed origin+path.** SPA route/history/form/embedded-checkout state changes the logical page with no path change; the epoch must key on more than the URL.
- **Atomicity/epoch.** Every op records the DOM version observed vs acted on; browser reads race framework updates; "no round-trip" is not "no race." Fail closed on version mismatch.
- **Prompt-injection surface.** `expand`/`read`/set-of-marks return page-controlled text (labels, aria, DOM text) — untrusted input that must not steer action selection.
- **Set-of-marks bound.** Viewport-first, top-N by salience/size, hard rendering budget, clustering on dense grids — not "label every element."
- **Flat-verb migration is not drop-in.** Ref grammar, escaping, HMAC/seal binding, and recipe serialization assume positional refs; migrate deliberately.
- **Recipes get less deterministic.** Name/label replay needs versioned locators (fingerprint + label + document scope) with fail-closed migration.

### Phasing (codex + review: this is a big-bang; ship it in slices)
1. **Identity model A** (fingerprint + label + epoch) — highest value (fixes ~80% of the thrashing), ships and proves first.
2. **Stop sealing + node-redaction extension** (D2) — shipped, then the redaction itself was removed (§4.5).
3. **`expand`/`read`** with resident/virtualized/shadow/iframe handling.
4. **Set-of-marks** with the rendering budget.

PR #624 (compact-v2 re-render tolerance) is the interim bridge; it is not superseded until phase 1 lands.

### NOT in scope (deferred, with rationale)
- **TS shipping-address feature** — the form-writing rides on this layer regardless; a value store is a separate decision (gap 1). Chrome-native autofill is the zero-code alternative.
- **Frame-level seal** — considered and rejected under D2.
- **Full adversarial-page hardening** (hostile id/aria forgery) — flagged by codex; belongs in phase-1 fingerprint design, not this doc.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | issues_open | 2 forks decided (identity, sealing); 7 codex findings folded as scope; 1 feasibility gap (resident-DOM) |
| Outside Voice | codex | Independent 2nd opinion | 1 | issues_found | Refuted the descriptive=stable thesis; flagged screenshot-redaction and resident-DOM gaps |

- **CODEX:** refuted the core identity thesis (name ≠ identity → adopted opaque-fingerprint model A), showed node-redaction can't secure screenshots (canvas/image/iframe/attribute), and flagged virtualized/shadow/iframe DOM, prompt-injection, atomicity, and recipe-determinism gaps.
- **CROSS-MODEL:** Review and outside voice agreed on the identity flaw (folded into D1). They diverged on sealing — codex recommended a frame-level seal, the captain chose node-redaction-only (D2); tension recorded, risk accepted by the captain.
- **VERDICT:** ENG reviewed — design revised (D1, D2 folded), phased rollout defined; not yet clear-to-implement until phase-1 fingerprint design resolves the open engineering items below.

**RESOLVED DEFAULTS (captain-approved 2026-09-02):**
- **Fingerprint:** DOM `id` when present, unique on the page, and not framework-random (reject `useId`-style `:r…:` and regenerated-per-render ids); otherwise a hash of (accessibility-tree path + role + normalized accessible-name + ordinal among same-role-and-name siblings). A label resolving to exactly one live fingerprint acts; to more than one, return an explicit ambiguity error (never guess); to zero, `stale_ref`.
- **Epoch / same-document:** key on a stable document identity + a monotonic DOM mutation counter, not the URL. An act is authorized against the version it observed; a real document-identity change (navigation) invalidates; benign mutations advance the counter and re-resolve within scope.
- **Resident-DOM handling:** materialize on demand — scroll a virtualized/lazy/offscreen target into view before read/act; traverse open shadow roots; cross-origin iframes are unreadable and reported explicitly, never faked as present.
- **Prompt-injection:** all page-derived text (labels, aria, DOM text from skeleton/`expand`/`read`, set-of-marks labels) is untrusted data, annotated as page-content, and never interpreted as instructions.
- **Set-of-marks budget:** viewport-only by default, cap ~50 boxes prioritized by size/salience, cluster or require scroll beyond that, with a hard image-size budget.

NO UNRESOLVED DECISIONS

---

## 9. Phase 1 — as implemented

Phase 1 (identity model A) shipped in `apps/mcp/src/bot/`. What the code does,
and where it is deliberately narrower or more conservative than §4.1 above.

### Where it lives

| Concern | File |
| --- | --- |
| Physical node, document loader and material intent | `browser-use-capture.ts` |
| Handle minting, epoch, target authorization, live re-resolution | `provision-session.ts` |
| Browser-use DOM serialization and its contract | `browser-use-serializer.ts`; `browser-use-serializer-port.md` |
| Control-query rows and `@label` aliases | `compact-observation-v2.ts` |

### Identity

The original phase-1 tiered fingerprint and per-snapshot label ordinals have
been superseded for compact-v2 by physical node anchors. See
[the current contract](browser-use-serializer-port.md#identity-deltas-and-query).
The legacy non-compact interface retains its structural fingerprints.

### Deviations from §4.1, and why

- **`epoch.doc` still folds in a normalized origin+pathname** alongside the
  document identity, rather than document identity alone. This is a fail-closed
  backstop, and the load-bearing one: document identity now moves only on a real
  document replacement, so this fold is what retires refs on a same-document
  SPA route change to a different logical page. Normalized means the volatile
  parts of the URL are excluded — the query string and fragment (the bug PR #624
  patched around) and, since #625's follow-up, the volatile token a live
  checkout writes into its own path (`…/checkouts/cn/<token>/<step>`, collapsed
  to one key by `normalizeVolatileCheckoutPath`). That exclusion is a CLOSED
  list of known checkout shapes AND only applies to a segment that looks minted
  rather than authored; every other path keeps its full identity. Two
  DIFFERENT checkouts normalize onto the same key on purpose — reaching one from
  the other replaces the document, which the primary signal catches.
- **No `invalid` state flag.** §4.2 lists `required`/`invalid`/`disabled`/
  `checked`; the DOM inventory captures the other three but has no
  `aria-invalid` signal to serialize. Adding one is an extractor change, not a
  ref-identity change, so it is left for a later phase.
- **Overflow paging stays.** `expand`/`read` (phase 3) replace it; until then
  the PR #624 re-render-tolerant cursor protocol is intact, now keyed on
  `epoch.rev`.

### Physical continuity

For physical continuity and guarded benign re-render adoption, see
[§4.1](#41-opaque-durable-identity--descriptive-label-decided-option-a).

### Phase 2 — broad seals removed; released-card value mask added

The earlier document-level screenshot refusal and broad observation screening
were removed in 2026-09. Reads are direct and never refused. The current, much
narrower exception is §4.5's session-persistent mask for the released complete
PAN and CVV/CVC/CID. `CardValueOutputMask` applies to model-facing text and
composites covers over injected value-bearing screenshot pixels without
clearing or otherwise changing merchant controls.

Credential-selection predicates in `credential-shape.ts` remain governed by
the [credential capture contract](operator-tool-surface.md#credential-capture-and-retrieval),
not by this narrow card-value boundary. `recordableTokenV2` and its closed
vocabulary remain for the stderr audit trail and registry-bound action trace;
browser-originated text is masked before it reaches either output.
