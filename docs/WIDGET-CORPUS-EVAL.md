# Widget Corpus Eval

Executable ground truth for widget-driving primitives (`selectOption`, the
inventory walker, and `setPhoneCountry`), evaluated against
**real captured onboarding DOMs** instead of reviewer-vs-fixer hypotheses.

- Eval: `apps/mcp/src/bot/__tests__/widget-corpus-eval.test.ts`
- Helper: `apps/mcp/src/bot/__tests__/helpers/corpus.ts`
- Corpus: `~/.trusty-squire/corpus/onboarding/` (override with
  `TRUSTY_SQUIRE_CORPUS_DIR`; not in the repo). Capture files carry walked
  element inventories and observed actions; replay samples use the records
  that also carry a non-empty full-page HTML snapshot.

## Run it

```bash
pnpm -F @trusty-squire/mcp test widget-corpus-eval
```

- **No corpus on the machine** (CI): the eval logs "corpus absent … 0 records
  scanned" and skips — the suite stays green.
- `WIDGET_EVAL_MAX_RECORDS=N` caps each suite's total replay sample (default
  12). Invalid or blank-HTML captures are skipped with deterministic backfill
  and do not consume the cap. The census always scans the whole corpus (a raw
  byte-probe pass, no JSON parsing; ~4.5GB, expect tens of seconds on
  first/cold run).
- `TRUSTY_SQUIRE_CORPUS_DIR=off` disables the eval entirely on a box that has
  the corpus but doesn't want the scan.

Every corpus-backed run prints a census block
(`[widget-corpus-eval] census: …`) — records scanned, matches per category
(native `<select>`, `input[type=tel]`, combobox/listbox roles, phone-country
signals), and per-suite counts of records replayed, successful drives, and
loud refusals. Quote those numbers in review threads; they are the coverage
claim. Corpus-less runs print the explicit zero-count availability message
instead.

## What the harness proves

Captured HTML is replayed via `page.setContent` in real Chromium with
**JavaScript disabled and all external resource loads aborted** —
deterministic and offline. Against that replayed DOM it runs the *real*
`BrowserController.extractInteractiveElements`,
`BrowserController.selectOption`, and `BrowserController.setPhoneCountry`
(page injected directly, same pattern as `shadow-dom-topmost.test.ts`), and
asserts the properties that are
**static-DOM questions**:

1. **Target detection & locality.** Walked selectors resolve uniquely;
   distinct inventory rows never alias to the same node; driving one native
   select leaves every sibling select untouched; custom phone country-code
   triggers resolve to non-`<select>` nodes, while supported native
   phone-country selects are classified separately from address-country /
   industry / timezone selects.
2. **Native `<select>` driving.** A matcher chosen to move the value away
   from both the current value and the no-matcher default is passed to
   `selectOption`; the committed value is read back off the DOM node and
   compared against an independently re-derived expectation of the matcher
   contract (case-insensitive substring, first match wins). The
   `data-ts-touched` marker is asserted too.
3. **Phone-country native driving and refusal.** Real supported native
   phone-country selects are driven through `setPhoneCountry` and their
   committed value is verified. Custom-trigger captures without a supported
   native target exercise the primitive's loud unsupported-widget refusal;
   dynamic custom-widget commit remains live-smoke territory.
4. **Loud-failure contracts.** A selector matching nothing throws; a sampled
   option-less `<select>` throws when encountered; a supplied native-select
   matcher with no match throws without changing the value; a custom combobox
   that cannot open (static DOM, JS off) throws rather than reporting false
   success.
5. **Fixed and open gaps are executable**:
   - **FIXED #1** — native-select matchers with no matching option now throw.
     The corpus test asserts the post-#409 contract and verifies the select
     value remains unchanged.
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

Automatic capture writes the accumulated rounds only when a successful
credential task reaches capture/promotion. Mid-round `operate_act` captures
store inventory and the action with `state.html: ""`; `operate_observe`
persists no corpus round. Only the final extract round stores full HTML.
To capture a static widget, finish a provision with its final extract round on
the page where that widget is present.

A manually saved DOM can also be added as a corpus-shaped `.json` file. The
loader requires only a top-level object containing `state.html` as a non-empty
string:

```json
{
  "service": "example",
  "state": { "url": "https://example.com/signup", "html": "<!doctype html>..." },
  "inventory": []
}
```

`service`, `state.url`, and `inventory` are optional to the loader. The raw
census uses inventory probes to choose suite candidates, so include a minimal
matching inventory row such as `{ "tag": "select" }`, `{ "type": "tel" }`, or
`{ "role": "combobox" }` when the record must enter that category.

There is no targeted capture capability for a mid-flow open-popover state
today. `operate_observe` cannot create that replay record.

## `setPhoneCountry` coverage boundary

The native phone suite drives `setPhoneCountry` against supported phone-local
country `<select>` captures, including ISO2, country-name, and dial-code
options, and verifies the retained value. The custom-trigger suite uses the
same replayed-DOM support predicate to drive a supported native target or
assert the unsupported-widget error. Opening and committing a dynamic custom
phone-country widget still requires a live smoke test.
