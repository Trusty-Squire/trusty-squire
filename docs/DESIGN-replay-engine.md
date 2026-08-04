# DESIGN — replay engine ("prepared-statement recipes")

Status: proposed (2026-08-04), for eng review. The eval harness (`docs/DESIGN-replay-eval-harness.md`)
is being built first and records the all-cold baseline; this engine is measured against it.
Supersedes the shape-hierarchy / anti-unification / platform-template design captured earlier in
gbrain `trusty-squire-shape-cache-design-2026-08-04` — that was an intermediate, heavier version;
this is the converged, deliberately-simpler one.

## 1. Purpose + predicate

Make *repeated* agent tasks (checkout, credential provisioning) fast by recording one successful run
and replaying it with new parameters, keeping the LLM out of the hot path on repeats. We build on the
predicate that replays are fast and accurate; the harness is the instrument that confirms it.

## 2. Governing principle: the key is guarded, so it may be crude

A replay is guarded by a deterministic pre-check with LLM fallback. Therefore:

```
 false MISS  (no recipe used)            → re-drive cold (no speedup, NO harm)
 false HIT   (guard rejects/falls back)  → LLM rescues (no speedup, NO harm)
 correct replay, clean                    → fast
 correct replay, some steps fell back     → success, just a cost
 wrong outcome the guard MISSED           → the ONLY real failure (money-path veto)
```

So the cache key never has to be *right* — only good enough to win the common repeat case. That is
what lets every mapping below be cheap. A fallback is a **cost**, never a failure.

## 3. The design

**Key = `(verb, eTLD+1)`.**
- `verb` ∈ a closed ~15-item set (`purchase, get_api_key, signup, subscribe, cancel, …`), tagged by
  the host LLM from the task (classification into a fixed list, not free generation → typo-robust,
  no embeddings). The product/object is NOT in the key — it is a param.
- `eTLD+1` via the Public Suffix List (`shop.`/`www.`/`checkout.` collapse to the registrable
  domain); path + query dropped. Small allowlist for subdomain-is-tenant hosts (`*.myshopify.com`,
  `*.notion.site`) where the full host is kept.
- This keys the **local `operate_use` recipe store** (`~/.trusty-squire/operator-recipes/`). It is
  NOT the registry's `serviceSlugFromUrl` signup-skill keying — those are a separate system and are
  untouched. (Review correction: the earlier "replaces the service-slug key" wording was imprecise.)

**Recipe = ordered `[{ action, target, value }]`.**
- `target` = a stable-attr bundle resolved at replay by an ORDERED FALLBACK, first hit wins:
  `testid → id/name → role+accessible-name → href → css`. Gloss visible-text is LAST and only if it
  resolves to exactly one element. (This is the E3 fix; the capture already records these attrs —
  `promote-to-skill.ts` synthesizeSteps pulls role/near-text/label/href/testId today.) It is an
  ordered fallback, NOT a weighted scoring engine.
- `value` = a literal, or a `{hole-ref}`.

**Holes bound by provenance (not inference).**
A hole is a typed value whose string matches a KNOWN run input — because Squire injected it and thus
knows its source at type time:

| typed value == | → hole |
|---|---|
| the user's saved address field | `{address.*}` |
| the task's object ("dark roast") | `{product_query}` |
| a vault secret / email | `{credential}` |
| the card via operate_pay | `{card}` |
| single-use token / session param in a URL | stripped (existing `isSingleUseUrl` transform) |

Everything else the agent typed that matches nothing known stays literal. Reuse the existing
enumerable transforms in `promote-to-skill.ts` (single-use-token strip, provider generalization,
`scrubKnownEmail`). At replay, holes are bound from the new task's inputs. This is literally a
prepared statement: recipe = compiled statement, holes = bind params.

**Replay is per-step.**
For a matching `(verb, eTLD+1)`, walk the steps and inject params. Per step: resolve `target` via the
ordered fallback → act. No resolve → hand THAT step to the host LLM to re-plan from the live page,
then continue the recipe. That per-step fallback IS the entire graceful-degradation story — no
monomorphic/polymorphic bookkeeping.

**Guards (unchanged safety surface).**
- Structural pre-check before acting on the money path (do the expected fields resolve?).
- Total-verify against `expected_total` before the passkey; mismatch ABORTS.
- `operate_pay` phone-approval + passkey mandate + card injection unchanged.

## 4. Maps onto existing code (mostly reuse, small new surface)

| Piece | Where | Change |
|---|---|---|
| Record on verified success | `provision-session.ts` verifyPostcondition gate; `promote-to-skill.ts` synthesizeSteps | add provenance hole-tagging; keep existing transforms |
| Targeting bundle | already captured in the inventory (role/testId/aria/href) | consume in the ordered-fallback resolver (new, small) |
| Recipe store + key | `operator-recipe.ts` (writeRecipe, entry_url); registry keying (`serviceSlugFromUrl`) | re-key to `(verb, eTLD+1)`; param injection at replay |
| Deterministic replay path | `operate_use` (the same-user local fast path) | extend from hint-only to resolve-then-fallback per step |
| Money guards | `operate_pay`, total-verify | unchanged |
| Verify / demote | housekeeper (`classify.ts`), registry (`prisma-skill-store.ts`) | unchanged; already distinguishes transient vs rot |

New code is essentially: the `(verb, eTLD+1)` keyer, the ordered-fallback resolver, provenance
hole-tagging, and the per-step replay-with-fallback loop. Everything else is reuse.

## 5. Scope — the corrected 3-quadrant value model

Value wherever selection is text-decidable/pinned **OR** the store rides a common checkout platform:

| | Platform checkout | Custom checkout |
|---|---|---|
| **Text-decidable / pinned** | ① both cache (max win) | ② selection cheap + per-store recording |
| **Visual taste** | ③ cache all but the choice | ④ weakest (repeat-only rescue) |

Build for ①②③. The dead slice is ④'s one-off novel-visual-taste on a bespoke storefront — that
stays a full LLM+vision drive, and should.

## 6. Explicitly OUT of scope (superseded / deferred)

- **Cross-store platform templates** (Shopify-checkout-transfers-across-stores) — the big hit-rate
  multiplier, but the complex part (platform detection, cross-store keying). Deferred until data
  shows many one-shot different-store visits. Per-`(verb,domain)` already wins the repeat loop.
- **Anti-unification of N runs** — v1 records ONE run + parametrizes known holes. Add merging only if
  a single recording proves too brittle (surfaced as high fallback-rate on that recipe).
- **The 3-level shape hierarchy** — collapsed to one recipe per `(verb, domain)`.
- **Inline-cache state machine, fingerprint scoring, embeddings** — cut.
- **Vision/taste selection quality** — never cached; it is a decision/param, not mechanics.

## 7. Money-path safety (non-negotiable)

1. Pre-check must pass before any deterministic act on checkout (no blind replay on a drifted page).
2. Total-verify vs expected before the passkey; mismatch aborts to LLM/user.
3. **Field-value verify (added by eng review 2026-08-04).** `total-verify` only catches price/qty
   drift. A per-step LLM fallback on a checkout FILL step could mis-fill a field that does not change
   the total — wrong shipping address / wrong contact — and ship a real gift to the wrong person on a
   real charge. So before the passkey, the money-path pre-check ALSO deterministically asserts every
   filled field equals the param Squire injected (address, contact, qty); a mismatch aborts to the
   human. Cheap — it compares the live field values to the provenance values Squire already holds.
   (Per-step fallback stays enabled on the money path; this check closes the wrong-data gap without
   forcing a full re-drive. The stricter alternative — disable per-step fallback on checkout entirely
   — is the fallback position if field-value verify proves insufficient.)
4. `operate_pay` passkey + phone approval unchanged — the human confirms the charge.
5. Any pre-check miss falls through to the LLM → no regression vs today's behavior.
The eval harness's drift battery asserts 100% catch on money-affecting mutations (price/item/qty AND
address/contact mis-fill); a single escape is a ship veto.

## 8. Build order

1. Eval harness + all-cold baseline — **in flight** (crewmate).
2. Engine: `(verb, eTLD+1)` keyer + ordered-fallback resolver + provenance hole-tagging + per-step
   replay-with-fallback, behind the guards. Record-on-verified-success wired to the existing gate.
3. Measure against the harness (net speedup ≥5×, correctness ≥90%, zero money escapes). Iterate.
4. ONLY if the data justifies it: the cross-store platform-template multiplier.

## 9. Honest risks / open questions (for the review)

- **Hit rate is unproven.** The whole value is `hit_rate × speedup`; per-`(verb,domain)` keying bets
  on repeat traffic (the gifting loop). If real traffic is mostly one-off novel stores, hit rate is
  low and the engine underdelivers regardless of per-hit speed. The harness measures this before we
  over-invest.
- **Provenance hole-tagging assumes Squire supplied the value.** A value the *user* typed into the
  live page that Squire did not inject (rare in our flows) would be recorded literal and could leak a
  run-specific value into the recipe. Mitigation: only vault/param/address/card values are ever
  injected by Squire; free-typed values are already rare and flagged.
- **`operate_use` is currently the "blind replay" path DESIGN-operator-hints deliberately fenced off.**
  Extending it to resolve-then-fallback must not regress the operator-hint path (which stays
  LLM-guidance). Clean seam needed between "hint the planner" (unchanged) and "replay with fallback"
  (new).
- **Verb taxonomy drift.** A closed verb set is only stable if it stays small and closed; adding
  verbs ad hoc would fragment keys. Governance: the set is a reviewed enum, not free-form.
