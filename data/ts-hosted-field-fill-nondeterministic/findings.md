# inject_card hosted-field fill nondeterminism — findings

Task: `ts-hosted-field-fill-nondeterministic`
Branch: `fm/ts-hosted-field-fill-nondeterministic`
Date: 2026-09-15
Code: `apps/mcp/src/bot/browser.ts`, `apps/mcp/src/bot/provision-session.ts`
Tests: `apps/mcp/src/bot/__tests__/browser-hosted-field-remount.test.ts`,
`apps/mcp/src/bot/__tests__/browser-inject-card.test.ts`

## What the live failure was

Oura Ring 5 (ouraring.com), JPY 65,800, Braintree hosted fields, rc.28,
session 6dcd7859, approval 01M2JG5QKBTEQD7DHPQ05SF8P0. Five consecutive
attempts, each after its own fresh `operate_observe`, resolved a different
subset of card fields:

1. `exp_month`, `exp_year` filled; `pan`, `cvv`, `name` `not_found`.
2. `name` filled; `pan`, `cvv` `not_found`.
3. `pan`, `cvv`, `exp_month`, `exp_year` filled; `name` `not_found`.
4. Same as 3 with freshly re-observed refs; `name` `not_found` again.
5. After a full reload and settle: `name`, `exp_month`, `exp_year` filled;
   `pan`, `cvv` `not_found`.

After attempt 4 the Place Order control was enabled, the order submitted, and
Oura returned its generic "We apologize, something went wrong" with the
card-number input carrying `invalid=true`. No charge, no order.

## Defect 1 — resolution race (the blocker)

### Before

`injectCardIntoResolvedRefs` (`provision-session.ts`) took ONE
`extractInteractiveElements` snapshot at the top of the call and resolved all
six fields against it. `injectCardIntoTargets` (`browser.ts`) then reported a
field's verdict without attempting a write:

```ts
if (target.element === undefined) {
  results[field] = { status: target.missing ?? "not_found" };
  continue;
}
```

Braintree serves each card box from its own cross-origin iframe and remounts
those frames in response to input and its own lifecycle. The frame walk is not
atomic across siblings: a frame mid-remount contributes nothing, the field
silently drops out, and which fields make it in is a race. A `not_found` result
did not mean a write failed — it meant the field's ref was absent from one
snapshot taken moments earlier. `detached` (the ref existed in
`session.lastElements`, so its frame was remounting) was computed and then
collapsed into the same non-attempt.

Two 20-run trials of the new harness against the unmodified code (the
aggressive-storm trial and the final gentler-storm trial) both reported 0/20.
Representative failures from the final trial:

```
inject_card single-call across self-driven remounts: 0/20 passed
  run 6 FAILED: values(pan=4111111111111111,expiry=2030,cvv=123,name=) complete=true statuses[pan=filled,cvv=filled,exp_month=filled,exp_year=filled,exp=not_found,name=filled]
  run 11 FAILED: values(pan=4111111111111111,expiry=12,cvv=123,name=Synthetic Buyer) complete=false statuses[pan=filled,cvv=filled,exp_month=filled,exp_year=detached,exp=not_found,name=filled]
```

(Full 0/20 output for the gentler storm is quoted in the "Twenty-run result"
section below.) Run 6 is the second defect made visible: the tool reported
`complete=true` while the cardholder-name field was empty in the live frame.
Runs report a mix of `detached`, `not_found`, `cleared` and `native_error`
across the six fields, landing differently every time — the same signature as
the live five attempts.

### After

1. **Resolution happens at each field's own write step.** `injectCardIntoTargets`
   accepts an optional live resolver. `injectCardIntoSessionTargets` supplies
   one that re-runs `extractInteractiveElements` and `resolveTarget` on every
   call, including every retry. The shared up-front snapshot is gone.
2. **A miss retries inside a bounded window.** `CARD_FIELD_RESOLVE_WINDOW_MS`
   (1500ms) / `CARD_FIELD_RESOLVE_RETRY_MS` (100ms) are internal constants — no
   new tool parameter, config, or flag. `not_found` now means "still absent
   after we waited."
3. **The `detached` signal is used.** The resolver keeps
   `previouslyPresent ? "detached" : "not_found"`; both are retried, and the
   distinction survives into the reported status instead of collapsing into one
   non-attempt.
4. **Disconnected nodes no longer resolve.** `resolveFrameElementInFrame` was
   calling `handle.evaluate(el => el.isConnected)` and discarding the result; a
   remount can leave the old frame momentarily enumerable with its former input
   still resolvable but out of the document. A disconnected element now resolves
   to `null` so the durable frame-URL fallback finds the live frame.

No tool schema, no Braintree-specific branch, no provider registry. The
card-value output mask and the single-approval flow are untouched.

### Twenty-run result

The test (`apps/mcp/src/bot/__tests__/browser-hosted-field-remount.test.ts`)
mounts three cross-origin iframes on **three different registrable domains**
(`example.org`, `example.net`, `example.edu`; a different port is same-site and
would not site-isolate), each input inside an **open shadow root**, and the
child frames remount on their own jittered schedule (the piece the old test did
not model — remount-on-first-input alone cannot race a snapshot taken before any
write). Each run observes once, starts the storm, issues **ONE** `inject_card`
call for `pan` + `cvv` + `exp_month` + `exp_year` + `name`, then reads the
values back inside the live frames.

Fixed code:

```
=== FIX ROUND 1 ===
inject_card single-call across self-driven remounts: 20/20 passed
=== FIX ROUND 2 ===
inject_card single-call across self-driven remounts: 20/20 passed
```

plus the full real-browser tier run:

```
inject_card single-call across self-driven remounts: 20/20 passed
```

**60/60 consecutive runs**, each a single call filling every field. Unmodified
code, same harness, gentler storm:

```
inject_card single-call across self-driven remounts: 0/20 passed
  run 1 FAILED: values(pan=,expiry=,cvv=,name=) complete=false statuses[pan=detached,cvv=detached,exp_month=cleared,exp_year=cleared,exp=not_found,name=not_found]
  run 2 FAILED: values(pan=,expiry=,cvv=,name=) complete=false statuses[pan=not_found,cvv=not_found,exp_month=not_found,exp_year=not_found,exp=not_found,name=not_found]
  run 6 FAILED: values(pan=4111111111111111,expiry=2030,cvv=123,name=) complete=true statuses[pan=filled,cvv=filled,exp_month=filled,exp_year=filled,exp=not_found,name=filled]
  run 11 FAILED: values(pan=4111111111111111,expiry=12,cvv=123,name=Synthetic Buyer) complete=false statuses[pan=filled,cvv=filled,exp_month=filled,exp_year=detached,exp=not_found,name=filled]
  ... (all 20 failed)
```

**A single `inject_card` call now fills every field every time, on this harness,
across repeated sibling remounts: 20/20, 20/20, 20/20.**

## Defect 2 — `filled` could be a lie

### Before

#792 verified a written value by reading it back and comparing
`actual === expected || digits(actual) === digits(expected)`. Testing for
containment lets the verdict pass on a value that is a superset, a truncation,
or a doubled value when the extra content is non-digit.

### After

Both sides are normalised for **formatting separators only**
(`/[\s\-/.]+/g`) and then compared for **equality**:

```ts
const normalize = (value: string) => value.replace(/[\s\-/.]+/g, "");
return normalize(actual) === normalize(expected);
```

A card number the page reformats with spaces or dashes still matches; a
truncation, a doubled value, or any non-separator content the field does not
hold fails.

Evidence (`reports cleared, never filled…` and `still reports filled when the
page only reformats…`, both green):

- page truncates to the first four digits → `pan` reported `cleared`, never
  `filled` (final value `4111`);
- page doubles a complete number (and again on every re-fill) → `pan` reported
  `cleared`;
- page regroups with spaces as you type → `pan` reported `filled`
  (final value `4111 1111 1111 1111`).

## Defect 3 — `fill()` emitted no key events

### Measurement

The old card writer used `handle.fill(value)`, which sets the value with no
`keydown`/`keypress` events. A faithful provider page accepts a number only when
every character arrived as a real key event. Measured directly
(`types real key events, so a key-event-driven provider accepts the number`,
green):

```
input.fill(pan)                        -> data-provider-invalid="true"
input.fill(""); input.pressSequentially(pan) -> data-provider-invalid="false"
injectCardIntoTargets(pan)             -> status filled, data-provider-invalid="false"
```

So a one-shot `fill()` is rejected by a client that tracks typing, while the
real-key write is accepted — consistent with the live `filled` then
`invalid=true` observation. The evidence is harness-level, not the live Oura
checkout (the live checkout is not reachable from CI); the harness models the
mechanism the brief named.

### Fix

The card writer now types text fields through the ordinary humanized typing
core, extracted from `typeInner` as `typeWithRealKeys(locator, text)`: clear the
field, then ONE `pressSequentially` call with a randomised per-key delay
(`rand(40, 110)`). `typeInner` and `typeInFrame` delegate to the same helper, so
there is no new loop and no second typing implementation. The per-character loop
that stranded every character after the first (rc.29) is not reintroduced. The
value still goes from the vault straight into the page — never through
`operate_type`, a tool result, or a log.

(Typing added time to two existing `browser-inject-card` tests, which had no
explicit timeout and ran ~5.2–5.7s against the 5s default; both now carry an
explicit 120s timeout, matching the other browser tests.)

## Validation

- `pnpm typecheck` — clean.
- `pnpm test:fast` (fast core 79 files / 1079 passed, required behavior 10 /
  131, required payment safety 6 / 83) — green.
- `pnpm test:real-browser` — 36 files, 635 tests, green; includes the 20/20
  single-call run.
