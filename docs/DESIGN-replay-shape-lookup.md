# DESIGN — per-site shape lookup for replay

Status: proposed. Extends the replay engine in
[`DESIGN-replay-engine.md`](DESIGN-replay-engine.md); measured against the
predicate in [`DESIGN-replay-eval-harness.md`](DESIGN-replay-eval-harness.md).
This document does not change either — it identifies a keying limitation in
the shipped engine, proposes a fix, and records independent test evidence for
it.

## 1. The problem

`readRecipeForTask(verb, serviceUrl)`
(`apps/mcp/src/bot/operator-recipe.ts:331-335`) resolves exactly one recipe,
once, at session entry, via `operatorRecipeKey(verb, url)` →
`` `${verb}--${operatorRecipeDomain(url)}` `` (`operator-recipe.ts:306-308`) —
a `(verb, eTLD+1)` key, per `DESIGN-replay-engine.md` §"Recipe identity".

Two consequences follow from keying at the domain level, at entry:

- **Near-zero cross-user reuse.** A recipe recorded on `whitejade.xyz` only
  ever replays for `whitejade.xyz`. Every store a different user provisions
  starts cold, even when the underlying checkout implementation is identical
  across stores (e.g. every Shopify store runs the same checkout).
- **The signature that would give reuse isn't observable at entry.** Shopify
  checkouts share a byte-identical field-name set (see §3 below) — that's a
  real platform signature a recipe could key on instead of the domain. But
  that signature only exists on the checkout page, at the *end* of a
  purchase funnel (catalog → storefront → checkout → pay). At entry, all
  that's known is the starting URL. Guessing the platform from the entry URL
  before the checkout page has loaded is a prediction, not an observation —
  and a wrong guess on the money path is not an acceptable failure mode.

So the engine's current single entry-time key cannot simultaneously be
correct (safe against wrong-platform mis-fires) and reusable (shared across
unrelated domains that happen to run the same platform).

## 2. The design

Stop resolving the replay decision once, at entry, for the whole task.
Recognize the page **shape** independently at each leg of the funnel as it's
reached, the same way a V8 inline cache checks the shape at each access site
rather than deciding once at function entry:

- **Catalog/search leg** — keyed per store: `store:<domain>:catalog`. The
  domain *is* known at entry, so domain-keying is correct here; it was never
  the problem for this leg.
- **Storefront/add-to-cart leg** — keyed by platform, matched on arrival:
  `platform:shopify:storefront`.
- **Checkout leg** — keyed by platform, matched on arrival by the
  field-name-set signature plus a total-amount landmark — observable exactly
  when the leg is reached, not before: `platform:shopify:checkout`.
- **Pay** — remains a guarded ceremony (`operate_pay`), never a recipe, per
  `DESIGN-replay-engine.md` §"Money-path guards".

Each leg hits or misses independently. A miss on any one leg falls back to
the LLM for that leg only; the run continues and a new shape is recorded.
This composes with the existing per-step `fallback_required` repair path
(`DESIGN-replay-engine.md` §"Replay and repair") — it adds a coarser,
per-leg granularity above it, not a replacement.

Properties that follow directly from arrival-time recognition, without extra
caveats:

- **Selection and safety are the same check.** A shape-keyed plan is only
  used once its shape is confirmed present on arrival — a hit cannot mis-fire
  onto the wrong platform, because matching the signature *is* the selection.
- **Drift is self-healing.** If Shopify changes its checkout, the signature
  stops matching, that leg misses, the LLM drives it, and a new shape is
  recorded — no manual invalidation or versioning needed.
- **Variants degrade gracefully.** A handful of known shapes at one leg can
  be tried in order; beyond that the leg is megamorphic and falls back to the
  LLM. A bespoke, one-off site is just a shape with a scope of one — no
  separate mechanism required for it.
- **Holes stay per-run.** Address/contact/card values are bound at replay
  time from the caller's inputs, never stored in the recipe
  (`SecretRef.stored: false` already enforces this per
  `DESIGN-replay-engine.md` §"Recording contract"), so per-store shapes
  sharing a plan never leak one user's values into another's run.

**Registry consequence.** The shape id becomes the sharable key.
`platform:shopify:checkout` is one registry row that serves every Shopify
store; `store:<domain>:catalog` rows stay per-store. Cross-user reuse falls
out of the keying scheme itself — no new schema, and no per-domain rows that
nobody else can ever hit.

## 3. Evidence

Three tests were run against this design, independent of the engine's
existing E1-E4 baseline (Shopify checkout field-name sets byte-identical
across merchants, ~5s deterministic fill vs. ~6min LLM). Full detail and raw
data are in the source falsification report; summarized here with numbers.

### Test 1 — discriminator (checkout-shape signature)

**Claim:** the arrival signature (checkout field-name set + total-amount
landmark) fires on Shopify checkouts and never on non-Shopify ones.

Computed the signature as the intersection of `name="..."` attributes across
6 distinct-merchant Shopify checkout captures (45 non-generic field names)
plus presence of the `totalAmount` GraphQL landmark. Fire rule: ≥90% of the
field-name set present AND landmark present.

- **9/9 Shopify captures fire** (6 distinct merchants: allbirds, deathwish,
  brooklinen, colourpop, tentree, plus 4 whitejade product checkouts) — every
  one matched 45/45 field names with the landmark present.
- **6/6 non-Shopify captures don't fire** (nipponflorist.jp and
  myglobalflowers.com, across home/product/cart/checkout-redirect pages) —
  0/45 or 1/45 (one generic field name) overlap, no landmark, no
  Shopify-branded markers anywhere in the page.
- **Result: 100% true-positive / 100% true-negative**, on live-fetched
  specimens (not the corpus — see §5).

### Test 2 — cross-store transfer (the decisive test)

**Claim:** a checkout plan recorded on one Shopify store fills every
checkout field on an unrelated Shopify store, unmodified.

Recorded a plan on `whitejade.xyz` (8 labeled fields: email, first/last
name, address, city, state, ZIP, phone). Replayed it on an unrelated store,
`flower-shop-rin-japan.myshopify.com` (JPY, Japan-only checkout), by
locating each **same-labeled** field — not the same screen position — and
typing the plan's literal value.

This mattered because the target store's field **order is reversed**
(last-name-first, the Japanese convention) versus the source store
(first-name-first). A position-based replay would have swapped the two
names; label/shape-based resolution did not.

- **Target resolution: 9/9 (100%).** Every field named in the plan was
  correctly located on the foreign store, including the two whose value
  ultimately didn't fit (see below).
- **Literal value transfer: 7/9.** Email, last name, first name, address,
  city, and phone were accepted as-is. State/Prefecture and ZIP/Postal were
  **correctly targeted but rejected** — `California` isn't a valid option in
  a Japan-only `<select>`, and `94105` fails Tokyo's postal-code validator.
- **Reading:** this is the design's own hole/target distinction working as
  specified, not a design failure — a plan promises the *target* transfers
  across stores, not that a US state name or ZIP format is semantically
  valid on a Japan-only form. Locale-specific literals need a
  locale-appropriate fallback value at replay; that's expected behavior, not
  a defect in target resolution.

### Test 3 — composition and per-leg fallback

**3(a) — cold catalog + shared checkout plan, on a never-recorded store.**
Drove `tentree.com` (never recorded before) end to end: catalog leg cold
(~30s, including recovering from an intercepting popup) and checkout leg
filled from the whitejade/flower-shop-rin plan unmodified (~36s), reaching
the checkout review page with the correct item and price. **Composition
holds** — legs from different origins (one cold, one replayed) combine into
one successful run. A mid-run stale DOM-ref was repaired using the existing
step-level `fallback_required` path — live confirmation that the step-level
half of graceful degradation already works today.

**3(b) — per-leg fallback on today's engine: does not exist yet.** Static
analysis of `apps/mcp/src/bot/provision-session.ts`, the only implementation
of replay, found two distinct escape hatches that are not equivalent:

- `fallback_required` (`provision-session.ts:4205-4225`) is a working
  **step**-level degrade: a single missed target returns `next_index`, the
  host repairs just that step, and replay resumes there.
- `human_required` (`provision-session.ts:4155-4161`, called from
  guard-failure sites including the post-fill verification at line 4197)
  aborts the **entire** replay call the moment any one field's post-fill
  guard trips — there is no continuation path from it.

The reason there's no narrower fallback is structural, one level below the
abort call site: `OperatorRecipe` (`operator-recipe.ts:90-108`) stores an
entire task as one flat `trace: TraceEntry[]` array under one
`operatorRecipeKey(verb, domain)` (`operator-recipe.ts:306-308`). Catalog,
storefront, and checkout steps are just consecutive entries in the same
array under the same key — there is no leg boundary in the schema for a
guard failure to fall back to. So a money-path guard trip has nowhere
narrower to escalate to than "abort the whole call."

This confirms the gap the design in §2 is meant to close: the engine already
degrades gracefully *within* a leg but aborts to a human *across* the whole
run on any single-field guard failure.

## 4. The scoped engine change (not a redesign)

Test 3(b) points to one concrete change, not a rearchitecture:

1. Segment `OperatorRecipe.trace` into named legs — or, closer to the design
   in §2, store separate recipes per leg-key instead of one recipe per
   `(verb, domain)` — so a leg boundary is representable in the schema at
   all.
2. Change `humanRequired`'s callers so a guard failure returns a leg-scoped
   `fallback_required`-shaped result (re-drive from the start of the
   *current leg* under LLM control) instead of unconditionally killing the
   whole `replayOperatorRecipe` call. Reserve true `human_required` for a
   guard failure that recurs after the leg has already been re-driven once —
   generalizing `fallback_required`'s existing single-shot-retry semantics
   from "retry the step" to "retry the leg."

This is a registry/schema change plus a change to `humanRequired`'s call
sites in `provision-session.ts` — not a new subsystem. Neither change is
implemented as of this writing.

## 5. A corpus defect to fix before CI depends on it

`corpus/shopping/*.har` (the eval harness's checked-in corpus, described in
`DESIGN-replay-eval-harness.md` §5-6) — specifically the files named for
Test 1's positive specimens (allbirds, brooklinen, colourpop, deathwish,
tentree, whitejade) — are **not full purchase-flow captures**. Each contains
exactly one HAR entry: a GET of the product page's top-level HTML document.
No XHR, no subresources, no checkout page. Verified directly against all 9
corpus files: 1 entry each, product-page URL, no `/checkout` anywhere in any
entry. The only "checkout" strings present are theme CSS variables and
Shopify's accelerated-checkout button markup — never the actual checkout DOM
or field set.

These files cannot support computing the checkout field-name-set
discriminator as designed. Test 1's results above were obtained by capturing
live checkout pages instead (`POST /cart/add` + `GET /checkout`, read-only,
no submission) as a workaround — not by fixing the corpus. Before CI-gated
tests depend on this discriminator, `corpus/shopping/*.har` needs to be
recaptured as full `recordHar` traces through checkout, per
`DESIGN-replay-eval-harness.md` §6's own description of the intended
capture method (`STOREFRONT SEED` / live checkout leg).

## 6. Open generality questions

The following are under test, not yet answered:

- Does a shape class exist beyond Shopify (e.g. WooCommerce), or does
  Shopify's uniquely centralized checkout implementation make it a
  favorable but non-representative case?
- How safe is partial-match under drift — does the ≥90%-of-field-names
  threshold hold up as real sites evolve their DOM incrementally, versus the
  clean before/after snapshots tested here?
- As more shapes are registered, does mutual discrimination hold — can two
  distinct platform shapes ever both cross threshold on the same page?
- Does the shape-lookup approach generalize to non-checkout verbs (signup,
  get_api_key, subscribe), or is the checkout leg's unusually rigid,
  centralized implementation (one vendor, one field set) a special case?
- How much does field-set variance across locales erode the discriminator
  (the JP-vs-US field reordering in Test 2 didn't break target resolution,
  but a larger locale set is untested)?
- Does recognizing a shape on arrival interact with anti-bot defenses that
  key off deterministic, fast-fill timing versus the slower, more organic
  pacing of an LLM-driven cold run?

## 7. Explicitly out of scope

Per `DESIGN-replay-engine.md`'s existing scope line, this document does not
change registry Skill keying (`packages/skill-schema/src/service-slugs.ts`),
does not introduce fingerprint scoring or embeddings, and does not touch the
`operate_pay` guard ceremony. It also does not implement §4's engine change
or §5's corpus recapture — both are scoped follow-ups, not part of this
design.
