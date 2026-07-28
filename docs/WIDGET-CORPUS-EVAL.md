# Widget Corpus Eval

Executable ground truth for widget-driving primitives (`selectOption`, the
inventory walker, and — once it lands — `setPhoneCountry`), evaluated against
**real captured onboarding DOMs** instead of reviewer-vs-fixer hypotheses.

- Eval: `apps/mcp/src/bot/__tests__/widget-corpus-eval.test.ts`
- Helper: `apps/mcp/src/bot/__tests__/helpers/corpus.ts`
- Corpus: `~/.trusty-squire/corpus/onboarding/` (override with
  `TRUSTY_SQUIRE_CORPUS_DIR`; not in the repo). Each record carries the full
  page HTML, the walked element inventory, and the observed action.

## Run it

```bash
pnpm -F @trusty-squire/mcp test widget-corpus-eval
```

- **No corpus on the machine** (CI): the eval logs "corpus absent … 0 records
  scanned" and skips — the suite stays green.
- `WIDGET_EVAL_MAX_RECORDS=N` caps the per-category replay sample (default
  12). The census always scans the whole corpus (a raw byte-probe pass, no
  JSON parsing; ~4.5GB, expect tens of seconds on first/cold run).
- `TRUSTY_SQUIRE_CORPUS_DIR=off` disables the eval entirely on a box that has
  the corpus but doesn't want the scan.

Every run prints a census block (`[widget-corpus-eval] census: …`) — records
scanned, matches per category (native `<select>`, `input[type=tel]`,
combobox/listbox roles, phone-country signals), and per-suite counts of
records replayed and assertions run. Quote those numbers in review threads;
they are the coverage claim.

## What the harness proves

Captured HTML is replayed via `page.setContent` in real Chromium with
**JavaScript disabled and all external resource loads aborted** —
deterministic and offline. Against that replayed DOM it runs the *real*
`BrowserController.extractInteractiveElements` and
`BrowserController.selectOption` (page injected directly, same pattern as
`shadow-dom-topmost.test.ts`), and asserts the properties that are
**static-DOM questions**:

1. **Target detection & locality.** Walked selectors resolve uniquely;
   distinct inventory rows never alias to the same node; driving one native
   select leaves every sibling select untouched; phone country-code triggers
   are custom widgets (never a native `<select>`), so a phone-country intent
   can never legitimately resolve to an address-country / industry / timezone
   select.
2. **Native `<select>` driving.** A matcher chosen to move the value away
   from both the current value and the no-matcher default is passed to
   `selectOption`; the committed value is read back off the DOM node and
   compared against an independently re-derived expectation of the matcher
   contract (case-insensitive substring, first match wins). The
   `data-ts-touched` marker is asserted too.
3. **Loud-failure contracts.** A selector matching nothing throws; an
   option-less `<select>` throws; a custom combobox that cannot open (static
   DOM, JS off) throws `no options found after click` rather than reporting
   false success.
4. **Known gaps are pinned as tests** (both found by running this eval, i.e.
   exactly the ground truth the review loop was missing):
   - **KNOWN GAP #1** — native-select matcher with *no* matching option
     silently falls back to the first real option instead of throwing. Flip
     the pinned test to `rejects.toThrow` when `selectOption` gains loud
     no-match handling.
   - **KNOWN GAP #2** — the walker pins ambiguous CSS paths with Playwright
     chain syntax (`div > … > select >> nth=1`), but `selectOption`'s native
     path lists options by composing `${selector} option`, which matches
     nothing for a chained selector. A select FULL of options therefore
     throws `has no selectable option` — every ambiguous-path native select
     is undrivable today. The driving suites skip + count these
     (`nth-chain (undrivable, KNOWN GAP #2): N` in the run log); the pinned
     test flips to asserting success when the composition is fixed.

## What it cannot prove (honest scope)

A replayed static snapshot has **no live framework JS**. Custom dropdowns
(react-select, Radix, Base UI popovers, cmdk) will not open, filter, or
commit — so this harness can never validate the *dynamic* half of a custom
widget interaction (menu opens, option commits, form state updates). That
residual gap belongs to live smoke tests against the real service. Treat a
green eval as "the primitive targets the right node and honors its static
contracts", not "the widget flow works end to end".

Also note: external CSS is blocked, so replay-time visibility can differ from
capture-time visibility. All visibility judgments are made self-consistently
by the real walker on the replayed DOM. One concrete consequence: some
captures carry an already-rendered option list in the HTML (captured
mid-open, or hidden only by external CSS), so the combobox loud-failure suite
pre-filters pages where the option tiers would legitimately find visible
options (logged as `skipped (option list already visible …)`).

## Adding captures (growing coverage)

Captures accumulate automatically: every host-driven `operate_*` provision
writes onboarding rounds to `~/.trusty-squire/corpus/onboarding/` (default-on
via `TRUSTY_SQUIRE_ONBOARDING_CAPTURE`). The eval picks new records up on the
next run — no registration step.

**To capture a specific problem widget from a live operate session:** drive
the page to the state where the widget is visible (e.g. the phone-country
dialog's trigger rendered) using `operate_start` / `operate_act`, then call
`operate_observe` — each observation round is captured with full HTML +
inventory. The record lands in the corpus dir named
`<service>-<runid>-r<N>.json`. If the interesting state is *inside* an open
popover, observe **while it is open** so the popover's DOM is in the
snapshot; that is the only way a static replay can ever see it.

For a review/no-mistakes crewmate arguing about a widget's DOM shape: capture
the state once, then point at the census + the failing/passing assertion
instead of trading hypotheses.

## Wiring `setPhoneCountry` when it lands

The phone suite (`phone-country signals …`) already classifies the records a
`setPhoneCountry` eval needs (tel input + country-code trigger; see
`hasCountryCodeTrigger` / `isDialCodeTriggerText` in `helpers/corpus.ts`) and
asserts the static prerequisites. When the primitive is exported from
`browser.ts`, add its target-resolution call to that suite over the same
sample — the sampling, census, and locality assertions are already in place.
