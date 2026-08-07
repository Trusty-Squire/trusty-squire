# DESIGN — replay-engine eval harness

Status: v1 harness implemented (2026-08-05); engine bridge implemented (2026-08-06). The harness
now replays the captured prepared recipes through the production engine
(`docs/DESIGN-replay-engine.md`) via `pnpm -F @trusty-squire/mcp eval:replay`. The checked-in
measured report at [`apps/mcp/replay-eval-output/`](../apps/mcp/replay-eval-output/report.md) owns
the current warm evidence and SHIP/NO-SHIP verdict. The checked-in corpus owns the
frozen all-cold evidence; [`corpus/shopping/capture-log.json`](../corpus/shopping/capture-log.json)
owns the target, captured, and skipped task counts.
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

The reporter also returns `NO-SHIP` when a novel task false-hits, an applied recipe lacks a warm
sample, a structured infrastructure failure occurs, or a required repeat capture artifact is
unavailable. These are completeness invariants around the same predicate, not extra performance
thresholds — an unavailable sample is never scored as an escape, but it can never be scored as a
pass either.

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
| `drift_catch_rate` | money-affecting mutations the guard **aborted** with the independent total-verify oracle agreeing and the price guard causally credited (a fallback or an uncredited abort does NOT count as a catch; an infrastructure-failed trial counts against the rate) | **= 100%** |
| `recipe_survival` | recipes still replaying clean at T+7d / T+30d (housekeeper) | reported |

## 5. The corpus (`corpus/shopping/`)

One task record per file (JSON), same directory convention as onboarding captures:

```jsonc
{
  "task_id": "whitejade-purchase-r0",
  "verb": "purchase",
  "domain": "whitejade.xyz",                 // canonicalized key domain
  "entry_url": "https://whitejade.xyz/products/the-glow-serum",
  "params": {
    "product_query": "The Glow Serum",
    "product_variant_id": "53575613546607",
    "product_price_cents": 6800,
    "address": {…},
    "contact": {…},
    "card_ref": "whitejade-test-card"
  },
  "expected_end_state": {                     // GROUND TRUTH, programmatically checkable
    "line_items": [{ "title_contains": "The Glow Serum", "qty": 1 }],
    "total_cents": 7600,
    "reached": "checkout_review"              // stop before pay
  },
  "har": "whitejade-purchase-r0.har",         // stable product-page capture (see §6)
  "bucket": "repeat",
  "cold_baseline": {                           // measured driver evidence, not estimates
    "turns": 13,
    "tokens": 227750,
    "wall_clock_ms": 69147,
    "end_state": {…},
    "provenance": {…}                          // incl. trace_artifact + checkout_artifact
                                               // pointers into corpus/shopping/traces/
  },
  "capture": { "status": "captured", "captured_at": "2026-08-04T21:05:00Z" }
}
```

**Buckets + target sizes** (real captures are expensive; v1 is intentionally under-seeded):

| Bucket | What it proves | Target |
|---|---|---|
| `repeat` | hit-rate + hole-binding across whitejade products and parameter variations | 20 |
| `novel` | the MISS path never false-hits (10 unseen stores) | 10 |
| `drift` | guard catches all six mutations on every captured repeat task | 6 trials per repeat task |

Cross-param variation is folded into `repeat` (same recipe, swapped product/address).
The checked-in v1 seed uses all four whitejade products plus five named third-party novel tasks.
Do not infer missing records: `capture-log.json` is the authoritative under-seeding ledger and logs
every captured task plus skipped counts and reasons.

## 5.5. Live substrate — whitejade.xyz (operator-owned, test mode)

The realism layer is a real Shopify store we control: **whitejade.xyz** (live, 4 products, NOT
password-protected). **Shopify test mode is ON.** The v1 baseline reaches checkout review and stops
before the final order control; it does not claim order completion. This is the truth substrate:
- Real Shopify storefront + checkout-review DOM, with line item and displayed totals checked before
  payment. The Glow Serum was live-verified at a 6,800-cent subtotal plus 800-cent shipping, for a
  7,600-cent total.
- Deterministic CI drift comes from the six HAR mutations in §6. Because whitejade is
  operator-owned, later periodic realism runs can also exercise controlled live theme or price drift.
- **Known completion gap:** after the `whitejade-admin` Admin API `read_orders` token is vaulted,
  submit a test order and assert line items, total, and shipping address through server readback.
  Until then, final submission and order completion are intentionally unasserted.

Seed the `repeat` and money-path corpus from whitejade's real products (Glow Serum, Recovery Crème,
etc.). Third-party stores belong only in the `novel` MISS bucket. Cross-store replay is out of scope,
so one operator-owned repeat store is the correct v1 substrate, not a limit.

## 6. Split substrate: stable HAR replay + live whitejade checkout

The stable storefront and product-listing leg must be reproducible and free in CI. Record HARs from
those whitejade live pages, then replay them deterministically. Use Playwright's **native HAR**
support — no custom VCR:

```
STOREFRONT SEED:  browserContext({ recordHar: { path: task.har } }) → captures stable pages
STOREFRONT WARM:  page.routeFromHAR(task.har, { update: false })    → deterministic replay
STOREFRONT DRIFT: routeFromHAR(mutate(task.har, mutation))          → controlled stable-page change
CHECKOUT:         drive whitejade.xyz LIVE in Shopify test mode     → no HAR replay / no real charge
```

The checkout redirect chain is session-keyed and does not freeze cleanly. Do **not** HAR-freeze or
strictly replay that leg. Run checkout live against operator-owned whitejade in Shopify test mode;
it is free and repeatable, and it is the truth substrate for the money path. On the stable
storefront/product-page HAR leg, retain `routeFromHAR(..., { notFound: 'abort' })` so an
uncaptured request is a loud test error rather than a silent live fetch. On the live whitejade
checkout leg, do not install `notFound: 'abort'` at all. Sites whose stable pages still cannot be
frozen cleanly are logged as skipped in `capture-log.json`; they do not enter the CI corpus.

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

The `eval:replay` CLI now executes this flow end to end: it loads the per-task prepared recipe
captured during the cold run (`corpus/shopping/traces/*.recipe.json`), splits it at the
storefront→checkout boundary (`two-context-handoff.ts`), replays the storefront prefix in a frozen
HAR context and the checkout suffix in a fresh live JS-enabled context via a whitejade cart
permalink, drives both through the production engine adapter, then runs the drift battery. The
deterministic CI gate (`pnpm -F @trusty-squire/mcp test replay-harness`) still exercises only the
frozen corpus tests; the warm evaluation is run explicitly and its report checked in.

```
 for each task in corpus:
   ┌─ COLD ────────────────────────────────────────────────┐
   │ constrained LLM drives live; assert end_state==expected │ ← baseline evidence only in v1
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

- **CI gate** (frozen HAR corpus, harness/corpus changes now and every future engine change): emits
  the metrics table §4 + a single
  `SHIP / NO-SHIP` line applying the §1 predicate. `money_escape > 0` or `drift_catch_rate < 100%`
  → NO-SHIP, loud. The measured warm run lives in `apps/mcp/replay-eval-output/` — that report,
  not this document, owns the current verdict and any invalidated-measurement caveats.
- **Periodic realism pass** (future, after the replay engine and Admin API readback are available):
  same metrics on live sites incl. `live_only`; catches drift the frozen corpus cannot and feeds
  `recipe_survival` plus housekeeper demotion tuning.

The reporter renders one JSON document plus one markdown summary.

## 9. Explicitly out of scope (v1)

- Cross-store platform-template transfer (deferred with the engine itself) — the harness keys and
  scores per `(verb, domain)`; add a `platform_transfer` bucket only when that engine feature lands.
- Vision/taste-selection accuracy — the harness scores DOM-mechanics + checkout, not "did it pick a
  nice bouquet." Selection is a param/hole; taste quality is not a replay-engine metric.
- Anti-unification of N runs — v1 records one run; if a `repeat` task needs fallback on the SAME
  step across variations, that's the signal to revisit, surfaced as high `fallback_rate` on that recipe.

## 10. Implemented v1 layout

1. `apps/mcp/src/eval/replay-harness/` — corpus loader, baseline runner, metrics, reporter, native-HAR
   substrate, the six-mutation drift battery, the engine adapter (`engine-adapter.ts`), the
   storefront/checkout split (`two-context-handoff.ts`), and the warm-evaluation CLI (`cli.ts`).
2. `corpus/shopping/` — all four whitejade products for repeat/money cases; deathwish, allbirds,
   brooklinen, colourpop, and tentree for novel MISS cases only. `corpus/shopping/traces/` holds the
   per-task captured prepared recipes (`*.recipe.json`) and settled checkout artifacts
   (`*.checkout.json`) the warm evaluation replays.
3. `apps/mcp/scripts/capture-replay-baseline.mjs` — constrained real-LLM cold capture; run with
   `pnpm -F @trusty-squire/mcp eval:replay:capture`. `apps/mcp/scripts/record-replay-storefront-har.mjs`
   refreshes the frozen storefront HARs by replaying the persisted recipes (session-keyed checkout
   traffic is stripped before persistence).
4. `apps/mcp/src/eval/replay-harness/cli.ts` — the full warm evaluation; run with
   `pnpm -F @trusty-squire/mcp eval:replay`. Writes `report.json` + `report.md` to
   `apps/mcp/replay-eval-output/` (scratch state under `apps/mcp/.replay-eval/` is not committed).
5. `.github/workflows/ci.yml` — runs the deterministic frozen gate for harness, corpus, and
   replay-engine paths; the warm evaluation is not run in CI.

The all-cold baseline was recorded before the replay engine, so speedup and correctness deltas are
measured against driver-recorded evidence rather than estimates.
