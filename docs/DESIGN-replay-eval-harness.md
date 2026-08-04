# DESIGN — replay-engine eval harness

Status: proposed (2026-08-04). Prerequisite deliverable, built **before** the replay engine.
Related: prepared-statement recipe design (gbrain `trusty-squire-shape-cache-design-2026-08-04`),
`docs/WIDGET-CORPUS-EVAL.md` (the corpus-eval pattern this reuses).

## 1. Purpose + the go/no-go predicate

We are about to build a `(verb, domain)`-keyed replay cache on the predicate that replays are
**fast** and **accurate**. This harness is the instrument that decides whether that predicate holds.
It must emit a single go/no-go:

> **SHIP** iff: net speedup clears the bar on realistic repeat traffic **AND** clean-replay
> correctness ≥ 90% **AND** zero money-path escapes in the drift battery.
> The last clause is a **veto** — any escaped wrong-outcome on the money path fails the build
> regardless of speed.

## 2. The governing principle: a fallback is NOT a failure

The engine is *guarded*: a recipe that can't resolve a step hands that step to the LLM. So the
harness scores only two things as bad, and they are asymmetric:

```
 outcome of a replay attempt          harness verdict
 ───────────────────────────          ───────────────
 clean replay, correct end-state      ✅ success (fast)
 fell back to LLM, correct end-state  ✅ success (a COST, not an error — erodes speedup)
 false MISS (no recipe used)          ➖ lost speedup only (re-drove cold; no harm)
 false HIT, guard ABORTED/fell back   ➖ lost speedup only (guard worked; no harm)
 false HIT, guard MISSED, wrong state ❌ THE ONLY REAL FAILURE — veto on money-path
```

A naive eval that counts every fallback as a "replay error" would condemn a system that is
behaving correctly-but-slowly. Correctness is **only** about end-state; safety is **only** about
escaped wrong-outcomes; fallbacks are a **cost** that shows up in net speedup.

## 3. System under test (self-contained recap)

- **Key** = `(verb, eTLD+1)`. `verb` ∈ a closed ~15-item set (purchase, get_api_key, signup, …),
  tagged by the host LLM from the task. `eTLD+1` via Public Suffix List; path/query dropped; small
  allowlist for `*.myshopify.com`-class subdomain-is-tenant hosts.
- **Recipe** = ordered `[{ action, target, value }]` where `target` is a stable-attr bundle
  `{testid?, id?, name?, role+name?, href?, css}` and `value` is a literal or a `{hole-ref}`.
- **Holes** bound by provenance at record (a typed value === a known run input → address / product /
  credential / card); bound from the new task's inputs at replay.
- **Per-step replay**: resolve `target` via ordered fallback (testid → id/name → role+name → href →
  css); resolve → act; no-resolve → LLM rescues that step, continue.
- **Guards**: structural pre-check before acting on checkout; total-verify against `expected_total`
  before the passkey; `operate_pay` passkey ceremony unchanged.

## 4. Metrics (precise definitions + thresholds)

Cost is counted in **LLM round-trips (turns) and tokens**, not wall-clock alone — agent-thinking
wall-clock is not cleanly attributable (confirmed in the 2026-08-04 live runs); turns/tokens is the
robust metric. Wall-clock reported as a secondary.

| Metric | Definition | Threshold |
|---|---|---|
| `speedup_on_hit` | `cold_turns / warm_turns` per task (also tokens, wall-clock) | median ≥ 5× |
| `hit_rate` | `recipes_applied / tasks_attempted` on the realistic-traffic bucket | **measured, reported** (no preset — but headline metric below must clear) |
| **`net_speedup`** | `hit_rate × speedup_on_hit`, netted of fallback cost, over realistic traffic | **median ≥ 5×** ← headline |
| `clean_replay_correctness` | share of hits with `end_state == expected` AND `fallbacks == 0` | **≥ 90%** |
| `task_success` | share of hits with `end_state == expected` (fallbacks allowed) | ≥ 98% |
| `fallback_rate` | `steps_rescued / total_steps` | reported (cost driver) |
| **`money_escape`** | replays where a mismatched recipe produced `end_state != expected` (wrong item/total/recipient) the guard did **not** abort | **= 0 (veto)** |
| `drift_catch_rate` | money-affecting mutations the guard correctly aborted/fell-back | **= 100%** |
| `recipe_survival` | recipes still replaying clean at T+7d / T+30d (housekeeper) | reported |

## 5. The corpus (reuses `~/.trusty-squire/corpus`, new `shopping/` subdir)

One task record per file (JSON), same directory convention as onboarding captures:

```jsonc
{
  "task_id": "whitejade-purchase-r0",
  "verb": "purchase",
  "domain": "whitejade.xyz",                 // canonicalized key domain
  "entry_url": "https://whitejade.xyz/products/the-glow-serum",
  "params": { "product_query": "The Glow Serum", "address": {…}, "card_ref": "…" },
  "expected_end_state": {                     // GROUND TRUTH, programmatically checkable
    "line_items": [{ "title_contains": "The Glow Serum", "qty": 1 }],
    "total_cents": 7600,
    "reached": "checkout_review"              // stop before pay
  },
  "har": "whitejade-purchase-r0.har",         // stable product-page capture (see §6)
  "bucket": "repeat"
}
```

**Buckets + starter counts** (small; real captures are expensive; corpus grows):

| Bucket | What it proves | N (v1) |
|---|---|---|
| `repeat` | hit-rate + hole-binding (5 stores × 4 param variations) | 20 |
| `novel` | the MISS path never false-hits (10 unseen stores) | 10 |
| `drift` | guard catches change (5 recipes × 6 mutations) | 30 trials |

Cross-param variation is folded into `repeat` (same recipe, swapped product/address).

## 5.5. Live substrate — whitejade.xyz (operator-owned, test mode)

The realism layer is a real Shopify store we control: **whitejade.xyz** (live, 4 products, NOT
password-protected). **Shopify test mode is ON**, so checkout COMPLETES end-to-end with a test card
(`4242 4242 4242 4242`, any future expiry/CVV) and NO real charge. This is the truth substrate:
- Real Shopify storefront + real checkout DOM, exercised end-to-end incl. the full money path
  (mandate → passkey → total-verify → field-value-verify) — free and repeatable.
- Operator-owned, so drift is REAL and controlled: rename a button / change a price / swap the theme
  in admin to test the guards, instead of hand-mutating a HAR.
- **Order-readback ground truth (when the Admin API token lands):** after a test purchase, read the
  order via the Admin API (`read_orders`) and assert line-items + total + shipping address match the
  intended params. This is the authoritative money-path correctness + field-verify check, better than
  scraping the review DOM. Token lives in the Squire vault (`whitejade-admin`), used via the injecting
  proxy — never in source/logs/worktree. Setup need: a test card (`4242…`) available to operate_pay
  for whitejade runs.

Seed the `repeat` and money-path corpus from whitejade's real products (Glow Serum, Recovery Crème,
etc.). Third-party stores belong only in the `novel` MISS bucket. Cross-store replay is out of scope,
so one operator-owned repeat store is the correct v1 substrate, not a limit.

## 6. Split substrate: stable HAR replay + live whitejade checkout

The stable storefront and product-listing leg must be reproducible and free in CI. Record HARs from
those whitejade live pages, then replay them deterministically. Use Playwright's **native HAR**
support — no custom VCR:

```
STOREFRONT COLD:  browserContext({ recordHar: { path: task.har } }) → captures stable pages
STOREFRONT WARM:  page.routeFromHAR(task.har, { update: false })    → deterministic replay
STOREFRONT DRIFT: routeFromHAR(mutate(task.har, mutation))          → controlled stable-page change
CHECKOUT:         drive whitejade.xyz LIVE in Shopify test mode     → no HAR replay / no real charge
```

The checkout redirect chain is session-keyed and does not freeze cleanly. Do **not** HAR-freeze or
strictly replay that leg. Run checkout live against operator-owned whitejade in Shopify test mode;
it is free and repeatable, and it is the truth substrate for the money path. On the stable
storefront/product-listing HAR leg, retain `routeFromHAR(..., { notFound: 'abort' })` so an
uncaptured request is a loud test error rather than a silent live fetch. On the live whitejade
checkout leg, do not install `notFound: 'abort'` at all. Sites whose stable pages still cannot be
frozen cleanly are marked `live_only` and run in the **periodic realism pass** (§8), never the CI
gate.

**Mutation set** (post-process the HAR response bodies) — the drift battery:

| Mutation | Applied to | Correct guard behavior |
|---|---|---|
| rename add-to-cart / continue button text | storefront/checkout | ordered-fallback still resolves via testid/role → clean; else fall back |
| change a field's `testid`/`id` | checkout | resolve via role+name/css → clean; else fall back |
| remove a required field | checkout | pre-check fails → fall back, never mis-fill |
| **change displayed price** | checkout review | **total-verify ABORTS (money veto test)** |
| mark item out-of-stock | product/cart | catch → fall back |
| inject an overlay/interstitial | any | pre-check fails → fall back |

## 7. The runner (data flow)

```
 for each task in corpus:
   ┌─ COLD ────────────────────────────────────────────────┐
   │ recordHar; LLM drives cold; assert end_state==expected │ ← baseline + records the recipe
   │ log cold_turns, cold_tokens, cold_wallclock            │
   └───────────────────────────┬────────────────────────────┘
                               │ recipe = synthesize(cold trace)   (the engine under test)
   ┌─ WARM ────────────────────▼────────────────────────────┐
   │ routeFromHAR(frozen); replay recipe with task.params    │
   │ record: fallbacks, end_state, warm_turns/tokens/wall    │
   │ verdict per §2 table                                    │
   └───────────────────────────┬────────────────────────────┘
   ┌─ DRIFT (drift bucket) ─────▼────────────────────────────┐
   │ for m in mutations: routeFromHAR(mutate(har,m)); replay  │
   │ record guard behavior vs the "correct" column of §6      │
   └─────────────────────────────────────────────────────────┘
 aggregate → report (§8)
```

Ground-truth check = compare the live cart/review page's structured content (line items + total,
read via the platform JSON `cart.js`/`products.json` where available, else the fingerprinted
review DOM) against `expected_end_state`. Money veto asserts `observed_total == expected_total`.

## 8. Output + cadence

- **CI gate** (frozen HAR corpus, every engine change): emits the metrics table §4 + a single
  `SHIP / NO-SHIP` line applying the §1 predicate. `money_escape > 0` or `drift_catch_rate < 100%`
  → NO-SHIP, loud.
- **Periodic realism pass** (weekly, live sites incl. `live_only`): same metrics, catches real drift
  the frozen corpus can't; feeds `recipe_survival` and the housekeeper demotion tuning.

Report is a single JSON + a rendered markdown summary (reuse the WIDGET-CORPUS-EVAL reporter).

## 9. Explicitly out of scope (v1)

- Cross-store platform-template transfer (deferred with the engine itself) — the harness keys and
  scores per `(verb, domain)`; add a `platform_transfer` bucket only when that engine feature lands.
- Vision/taste-selection accuracy — the harness scores DOM-mechanics + checkout, not "did it pick a
  nice bouquet." Selection is a param/hole; taste quality is not a replay-engine metric.
- Anti-unification of N runs — v1 records one run; if a `repeat` task needs fallback on the SAME
  step across variations, that's the signal to revisit, surfaced as high `fallback_rate` on that recipe.

## 10. Build order + location

1. `apps/mcp/src/eval/replay-harness/` — runner + reporter (vitest-driven, reuse corpus-eval scaffolding).
2. `corpus/shopping/` — seed the `repeat` + money-path tasks from operator-owned whitejade's real
   products; deathwish, allbirds, brooklinen, and other external stores are `novel` MISS cases only.
3. `har-mutate.ts` — the §6 mutation set.
4. Wire the CI gate to run the frozen corpus on any change under the engine's paths.

The harness ships and its baseline (all-cold, no engine) is recorded FIRST — so the day the engine
lands, the speedup and correctness deltas are measured against a real baseline, not a guess.
