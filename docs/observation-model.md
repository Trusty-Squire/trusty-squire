# Design: Trusty Squire operator observation model — skeleton + resident DOM + descriptive refs

**Status:** Phases 1 (identity model) and 2 (node-level redaction) shipped — see §9; phases 3-4 not started
**Scope:** `@trusty-squire/mcp` operator observation/serialization layer (`operate_observe`, `operate_observe_query`, `operate_act`, `operate_screenshot`, and the compact-v2 serializer)
**Author:** firstmate, from hands-on operator driving (ipinfo signup + whitejade.xyz checkout, rc.19)
**Related:** PR #624 (interim gap-2 patch: tolerate live re-renders in compact-v2 overflow paging). This doc is the model that makes that patch unnecessary long-term.

---

## 1. Problem (observed, not theoretical)

Driving real signups and a real Shopify checkout on rc.19, the agent was effectively blind and could not reliably fill dynamic forms. Concrete failures:

- **Overflow paging is fatal on live forms.** Controls past the first ~4 go into `overflow`; paging to reach them fails with `stale_cursor`/`invalid_cursor` on essentially every attempt. Root cause (confirmed in `provision-session.ts observeQuery`): the snapshot is bound to the full current URL (Shopify appends a volatile `?_r=` token) and to a byte-identical live-element re-match, so any re-render or URL-token change invalidates it. Interactive checkouts re-render constantly. **Net: the delivery-address fields could not be reached at all.**
- **Controls lose their identity.** Non-viewport controls serialize as a bare role letter (`@e:3.1 "b"`) with no label. `operate_observe_query` matches on labels, so an unlabeled control is unfindable.
- **Screenshots over-seal.** `operate_screenshot` returned `sealed_context` on plain browse and pre-payment checkout pages, not just secret pages — the agent could not see layout at all until after a payment attempt.
- **No readable page text.** `text` is always `""`. Combined with unlabeled controls and sealed screenshots, the agent had no window into the page beyond a lossy control table.
- **Refs churn every action.** Each `operate_act` bumps the generation and invalidates every ref, forcing a re-observe per field. A 5-field form is 5 fragile round-trips.

The through-line: the layer is tuned for **payload size** and **secret-safety**, and overshoots on both — compressing away identity and blanket-sealing visibility — which blinds the agent on exactly the dynamic forms (checkout, multi-step signup) that matter.

## 2. Goals

1. An agent can reliably locate and fill a multi-field dynamic form (checkout, signup) without thrashing.
2. An agent can inspect visual pages (shopping grids, product images) in a bounded number of calls.
3. Preserve the vault guarantee: a raw secret (API key, recovery code, TOTP, card value) never enters the agent's context.
4. Never reintroduce the "serialize everything and paginate" explosion.

## 3. Non-goals

- A browser-native autofill or a vault shipping-address feature (separate decision; the actual form-writing is this layer regardless).
- Rewriting the seal/vault security model — this reuses it, pushed down to individual nodes.

## 4. Design

### 4.1 Opaque durable identity + descriptive label (DECIDED: option A)

**Correction from review:** an accessible name is *presentation, not identity*. Name-based re-resolution can silently hit the wrong element (duplicate names, swapped list items, localized/changed copy, recycled nodes). So the system does NOT key on the descriptive name. Instead:

- **Identity = a durable fingerprint** the system keys on, bound to an observed document epoch. The DOM `id` is the primary fingerprint input **when it is present, unique on the page, and stable across re-renders**; otherwise the fingerprint falls back to a structural signal (accessibility-tree path + role + name). Framework-random ids (React `useId` → `:r3:`, regenerated-per-render) are detected and excluded from the fingerprint — unique-per-render but unstable is worse than useless.
- **Label = a legible alias** the agent reads and uses (`@continue-with-google`, `@email-input`, `@sign-out-btn`). The agent talks in labels; the system resolves them to the fingerprint.
- **Every act carries the observed epoch + fingerprint.** Re-resolution is allowed only within a verified same-document/same-form scope. On any mismatch the operation **fails closed** (`stale_ref`) — it never optimistically re-targets. Duplicate labels (two "Add to cart" in a grid) resolve to distinct fingerprints; a label that maps to more than one live fingerprint returns an explicit ambiguity error, not a guess.

Consequence: the agent gets a readable, mostly-stable handle (the DOM id does most of the work where it exists), while the identity/authorization boundary survives — a page changing underneath produces an honest `stale_ref`, never a silent wrong click.

### 4.2 Resident DOM, projected skeleton (makes expansion free)

The full DOM is already loaded in the operator's browser. The observation is a **projection** of it, not a fetch.

**Compactness invariant (hard requirement, captain-mandated).** The *default* `operate_observe` payload — the vanilla form the driving agent sees every turn — MUST stay compact and bounded, regardless of page size. A huge page yields a bounded skeleton, not a huge payload. `expand`/`read`/`screenshot` exist precisely so richness is **pull-only** and never inflates the default. This is the whole point: the agent reasons over a small skeleton and drills in only where it needs to.

Concretely, the default skeleton is: visible/actionable controls plus a few salient read-only nodes (headings, error banners), and **each row carries only the minimum identity to target and reason** — the ref/label, role, and a compact state flag (e.g. `required`/`invalid`/`disabled`/`checked`). Heavier detail — full attributes, placeholder text, long/validation-message text, node subtrees, images — is **not** in the default; it comes only via `expand`/`read`/`screenshot`. The implementation must hold a per-observation size budget and prove the default stays within it on a large real page (a product grid, a long checkout).

Because the source of truth (loaded DOM) never leaves the browser, every detail request is a cheap in-memory read — no navigation, no re-render, no round-trip, no blowup — and, critically, no cost to the default payload.

### 4.3 On-demand scoped expansion, addressed by ref (replaces overflow paging)

Instead of paginating a serialized whole page, the agent pulls detail on a specific ref:

- `expand @ref` → that node's neighborhood (parents / siblings / children) to disambiguate ("which of these five buttons").
- `read @ref` → the element's text subtree, redacted.

Requests are scoped to a stable ref and return a bounded local view, so navigation is deterministic and cannot explode — the agent only pulls the neighborhood it is inspecting. This replaces `overflow` + cursor paging entirely.

### 4.4 Vision via set-of-marks, not per-element crops

Per-element cropped screenshots are O(N) calls — a flower grid would be death by a thousand `show`. Default visual primitive:

- `screenshot` → **one** viewport (or full-page) capture with a labeled bounding box drawn over each interactive element, each box labeled with **the same descriptive ref**. The agent sees the whole grid at once and correlates "the red one, `@product-flower-3`" to its ref — one call, whole page. (This is the proven "set-of-marks" pattern.)
- `show @ref` survives only as a secondary "zoom into this one element" primitive (e.g. one product image in detail), never the default.

### 4.5 Redaction, not sealing (DECIDED: option B — don't seal, node redaction only)

Captain's call, made against codex's push for a frame-level seal: **never seal a whole page or frame; redact at the node level only.** Rationale: agent visibility is worth more than closing every leak path, and the common secret (a rendered API key, a payment iframe's masked field) is either node-redactable or already masked by the processor.

- Redact secret-shaped / secret-marked content in `read`/`screenshot`, and extend redaction **beyond text nodes to attributes and control state** (input `value`, `placeholder`, `aria-*`, `title`, autocomplete previews, secret-bearing URLs) — codex correctly noted secrets are not only in text nodes.
- Do **not** seal ordinary or payment pages.

**Accepted residual risk (recorded, not hand-waved).** Node redaction cannot cover a secret rendered in a `<canvas>`, an image, an SVG, a QR code, OCR-readable pixels, or a cross-origin third-party iframe, and "payment iframes mask their own fields" is an assumption some processors violate. Under option B these can leak a secret into the agent's context. The captain accepts this exposure in exchange for agent visibility; revisit if a real leak occurs or a processor is found rendering PAN/CVV outside its iframe.

### 4.6 The descriptive ref is the join key

One handle names a skeleton row, addresses an `expand`/`read`, and labels a set-of-marks box. The agent never translates between "what I see" and "what I act on."

## 5. Migration / compatibility

- PR #624 is an interim patch on the current compact-v2 paging; it unblocks now. This model supersedes `overflow` + cursor paging.
- `operate_act` targets already accept a ref; descriptive refs are a drop-in change to how refs are minted, plus `expand`/`read` as new read verbs and `screenshot` gaining the set-of-marks overlay.
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
- A rendered API key / recovery code is redacted in `read` and `screenshot`; a payment page is NOT sealed.
- Recorded recipe replay still resolves its targets under descriptive refs.

## 8. Review outcomes (plan-eng-review, 2026-09-02)

Independent outside voice: codex (gpt-5.x, high effort, read-only). It landed real hits; both pivotal forks went to the captain.

### Decisions made
- **D1 — element identity = option A** (§4.1): opaque durable fingerprint (DOM id primary when unique+stable, structural+role+name fallback) bound to an observed document epoch; descriptive name is a readable label only; re-resolution only within a verified same-document/form scope; mismatch **fails closed**. Reverses the doc's original "descriptive = stable by construction," which codex correctly showed is false.
- **D2 — sealing = option B** (§4.5): don't seal, node-level redaction only (extended to attributes/control state). Captain accepted the residual canvas/image/SVG/QR/OCR/iframe leak risk in exchange for agent visibility, against codex's push for a frame-level seal. Recorded as accepted risk, revisit on a real leak.

### Codex findings folded as scope/implementation requirements (not open captain forks)
- **Resident-DOM is not universal (feasibility).** Virtualized lists, lazy-load, offscreen controls, shadow DOM, and cross-origin iframes mean a node may not exist. skeleton/`expand`/`read` must handle scroll-to-materialize, shadow-DOM traversal, and iframe boundaries; "`expand` is free" holds only for already-resident nodes.
- **Same-document test must exceed origin+path.** SPA route/history/form/embedded-checkout state changes the logical page with no path change; the epoch must key on more than the URL.
- **Atomicity/epoch.** Every op records the DOM version observed vs acted on; browser reads race framework updates; "no round-trip" is not "no race." Fail closed on version mismatch.
- **Prompt-injection surface.** `expand`/`read`/set-of-marks return page-controlled text (labels, aria, DOM text) — untrusted input that must not steer action selection.
- **Set-of-marks bound.** Viewport-first, top-N by salience/size, hard rendering budget, clustering on dense grids — not "label every element."
- **`operate_act` migration is not drop-in.** Ref grammar, escaping, HMAC/seal binding, and recipe serialization assume positional refs; migrate deliberately.
- **Recipes get less deterministic.** Name/label replay needs versioned locators (fingerprint + label + document scope) with fail-closed migration.

### Phasing (codex + review: this is a big-bang; ship it in slices)
1. **Identity model A** (fingerprint + label + epoch) — highest value (fixes ~80% of the thrashing), ships and proves first.
2. **Stop sealing + node-redaction extension** (D2).
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
| Fingerprint (DOM id / structural fallback, framework-random id rejection) | `element-fingerprint.ts` |
| Handle minting, epoch, target authorization, live re-resolution | `provision-session.ts` |
| Skeleton rows, `@label` aliases, wire encoding, size budget | `compact-observation-v2.ts` |

### Identity

- **Ref** — `@e:<10 base64url chars>`, a truncated session-secret HMAC over
  `(epoch.doc, fingerprint)`. Opaque, unforgeable, and unlinkable across
  sessions. It is *not* an index: it is derived from the element, so
  re-serializing the same page mints the same ref.
- **Fingerprint** — the DOM `id` when present, unique on the page, and not
  framework-random; otherwise
  `(frame, accessibility path, role, accessible name, ordinal among
  otherwise-identical siblings)`. Both branches are frame-scoped so a control in
  an embedded frame can never hash onto a main-page ref.
- **Label** — `@continue-with-google`, slugified from the already-screened
  control description. It is an addressable alias: `operate_act` accepts it and
  resolves it to a ref. A label naming more than one observed control raises
  `ambiguous_target` listing the candidate refs; it never guesses.
- **Epoch** — `{ doc, rev }`. `doc` is an HMAC of the browser's stable
  main-document identity; `rev` is a monotonic counter that advances only when
  the serialized skeleton actually changed. `doc` is the authorization boundary
  (a real navigation kills every ref minted under it); `rev` binds only the
  positional overflow cursors, so a re-render invalidates a page offset without
  touching a single ref.

### Deviations from §4.1, and why

- **`epoch.doc` still folds in origin+pathname** alongside the document
  identity, rather than document identity alone. This is a fail-closed
  backstop: it invalidates a strict superset of what document identity alone
  would, and it keeps the cross-document isolation guarantee if a host's
  document identity fails to move on a logical page change. The volatile part
  of the URL (query string, fragment) is still excluded — that was the actual
  bug PR #624 patched around.
- **No `invalid` state flag.** §4.2 lists `required`/`invalid`/`disabled`/
  `checked`; the DOM inventory captures the other three but has no
  `aria-invalid` signal to serialize. Adding one is an extractor change, not a
  ref-identity change, so it is left for a later phase.
- **Overflow paging stays.** `expand`/`read` (phase 3) replace it; until then
  the PR #624 re-render-tolerant cursor protocol is intact, now keyed on
  `epoch.rev`.

### Known residual

The structural fallback's sibling ordinal is positional. Removing one of two
*truly indistinguishable* siblings (identical frame, path, role, and accessible
name) shifts the survivor onto the departed element's fingerprint. Real
per-row controls carry a distinguishing signal — an authored `id`, differing
row text, a `data-testid` — which puts them on the id branch or in distinct
structural groups. This is the same information-theoretic residual documented
at `volatilePositionalGroups` in `provision-session.ts`.

### Phase 2 — redaction, not sealing

`operate_screenshot` no longer rejects an ordinary or checkout document solely
because it contains a filled secret field. `browser.ts` discovers sensitive
nodes immediately before a capture and paints masks over their rendered
rectangles; it rechecks after capture and discards an unstable image. The mask
set covers secret-marked nodes, payment fields, Luhn PANs, secret-shaped text,
control values, and attribute/state surfaces including `placeholder`,
`aria-*`, `title`, autocomplete previews, and session-known injected vault
values. `provision-session.ts` applies corresponding shape/exact-value
redaction to host-facing observation text.

The accepted §4.5 residual remains unchanged: this cannot redact a secret
rendered in canvas, an image, SVG, QR/OCR-readable pixels, or a cross-origin
third-party iframe. That exposure is accepted for the visibility gained by
node-level redaction; no additional concealment mechanism is implied here.
