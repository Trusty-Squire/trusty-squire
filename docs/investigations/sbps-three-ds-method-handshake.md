# SBPS 3DS2 method handshake investigation

Status: **the operator-native topology passes; no production step-up fix is
warranted by current evidence.** The reported SBPS failure is not reproduced by
the supplied topology alone. Real SBPS AuthenticateInit completion remains
unverified and requires a post-deploy human-in-loop payment. This diagnostic is
folded into the SBPS detection and notification delivery so the no-fix decision
stays executable as regression coverage.

## Evidence ledger — 2026-09-12

- `pwd -P` and `git rev-parse --show-toplevel` both returned the isolated
  `proj-ts-8bc037/15/proj-ts` worktree. `git ls-remote origin refs/heads/main`
  returned `ad3f41b781a215f612e3b2cf009f4a3547945eb8`, equal to the initial HEAD
  (MCP `1.1.14-rc.15`). Investigation branch:
  `fm/ts-operator-3ds-method-handshake`.
- The first `vitest run src/bot/__tests__/browser-three-ds-method.test.ts`
  run reported `Tests 2 passed (2)`. Both plain Playwright and Patchright with
  production page initialization completed the synthetic method without any
  change to production code. This initial variant used two loopback ports.
- The second run changed the issuer host to `localhost` while the parent used
  `127.0.0.1`, and added a full `BrowserController.start()` trial on a fresh
  profile. It reported `Tests 3 passed (3)` in 2.29 seconds of test execution.
  Operator output included:

  ```text
  [operator] launching browser channel=chrome proxy=direct
  [operator] self-launch + connectOverCDP (Turnstile-safe launch) binary=/usr/bin/google-chrome
  ```

  That trial asserted headed mode and `cdp_hardened`. Only the external IP-geo
  probe was stubbed; process launch, owned display, CDP attachment, page setup,
  host routing, page JavaScript and browser teardown used production code.
  The trial did not use the captain's live profile, proxy, session or card.
- Every successful trial observed, in order: lookup document request, native
  POST of `threeDSMethodData` into the named iframe, delayed fingerprint POST,
  and native AuthenticateInit POST. The authenticate fixture returned HTTP 200
  only after fingerprint collection and receipt of its synthetic server-issued
  completion token. The host-denial list was empty. Neither the test driver nor
  the operator clicked the method submit control; only fixture-owned JS did.
- `fm-ensure-agents-md.sh .` refused because AGENTS.md and CLAUDE.md are distinct
  real files. Neither was overwritten. This is the same existing memory-file
  condition documented in `sbps-card-checkout.md`.
- Fold-in verification on `fm/ts-3ds-detect-notify` reported all 337 tests in
  `browser-payment.test.ts`, `browser-decoupled-3ds.test.ts`,
  `pay-operator.test.ts`, and this diagnostic passing. The diagnostic again
  passed all three drivers without a forced submit.

## What the evidence establishes

The fixture is in
`apps/mcp/src/bot/__tests__/fixtures/three-ds-method/`, driven by
`apps/mcp/src/bot/__tests__/browser-three-ds-method.test.ts`.
It covers an inline body onload handler, an initially empty-src named iframe
loaded by native form POST, a child load handler and timer, asynchronous
fingerprint collection, cross-origin postMessage with origin/source checks,
and a delayed native submit of `input#resSumbitButtonId` carrying the result.
The form targets the synthetic `FepChargePaymentInfoAuthenticateInit.do`.

An empty iframe **src attribute alone does not establish that its document
failed to load**. A form targeting the iframe can navigate it without updating
that attribute; this fixture deliberately demonstrates that topology.
Inspect the actual frame document/network request, not only the parent element.

The production flags in `browser-process-owner.ts` disable background timer,
renderer and occlusion throttling; they do not disable timers. The native
fixture runs with those flags, including the full production launch. The
production host guard lets iframe documents and scripts through. Page setup
contains no postMessage override and no load-handler cancellation. Existing
post-submit cleanup remains bound to pre-submit document handles.

These results falsify a general failure of this synthetic handshake under
rc.15's default launch/page instrumentation. They do **not** rule out a
site-specific JS, CSP, network, proxy, cookie, issuer or timing problem. No
root cause outside this repository has been established either.

## Evidence needed to continue

Obtain the actual failed lookup document and referenced scripts, the actual
frame URL/document (including form-target navigations), page/iframe JavaScript
exceptions and CSP violations, and the method/notification request timeline
with statuses and failure reasons. Preserve the ordering around load and
method completion. Remove live card values and transaction secrets from any
shareable reproduction, retaining script structure and event wiring.

A recorded, sanitized response fixture can reproduce the client-side failure
without another human challenge or another charge. Until it fails under the
operator and passes under a controlled change, do not force-submit the method,
change launch flags speculatively, add page DOM patches, or claim this test
fixes SBPS. This is diagnostic coverage, not a regression test proven red
against the reported defect.

## Running the diagnostic

```sh
pnpm --filter @trusty-squire/mcp exec vitest run src/bot/__tests__/browser-three-ds-method.test.ts
```

Requires the Playwright Chromium binary; the full self-launch trial also uses
local Chrome and Xvfb. The shared Vitest setup isolates HOME and profile state.

Final local checks: MCP `typecheck` exited 0; ESLint and Prettier checks on the
new test passed; `git diff --check` passed. An initial typecheck rejected the
Patchright/Playwright union types in the test adapter; the context boundary now
uses an explicit type cast, matching the production adapter convention. No
production source files changed and no full-suite/no-mistakes run was started.
