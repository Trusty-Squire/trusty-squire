# SBPS card checkout investigation

Status: the CVV fix and the captain-approved payment-window network relaxation
are implemented. This enables merchant/issuer JavaScript to run native 3DS.
**SBPS AuthenticateInit completion remains UNVERIFIED.** The captain deferred
real-checkout acceptance to a human-in-loop payment with Firstmate after
deployment. Synthetic testing did not establish that the relaxation resolves
the AuthenticateInit error. This PR enables native 3DS to run; it does not claim
to fix the 3DS wall or complete a real payment.

## Evidence ledger — 2026-09-12

- `pwd -P` and `git rev-parse --show-toplevel` both identified the disposable
  `proj-ts-8bc037/16/proj-ts` worktree. Baseline commit:
  `0f434523` (before this change).
- `operate_start` with `https://translation.jaf.or.jp` and the specified Japan
  SOCKS5 proxy reached JAF's application landing page. The login action reached
  `/honyaku/uketuke/login_j.php`; this browser was not authenticated to JAF.
  Vault metadata contained no JAF credential. No checkout was submitted.
- Following Firstmate's instruction to investigate by version history rather
  than reproduce live, `operate_finish(outcome="none")` returned
  `execution: completed`, `mutation: not_dispatched`, `cleanup: closed`.
- The synthetic SBPS field `input#securityCode[type=tel][maxlength=4]`, without
  `cc-csc`, failed `fillCheckoutCardFields` with
  `payment_field_not_found:cvv` before the fix. It fills and clears after the
  fix. Tests also cover name-based fields, underscore spelling,
  CSC, and associated English/Japanese labels. Fixture HTML declares UTF-8;
  the initial Japanese-label fixture omitted that declaration, so its initial
  failure is not evidence of a production Japanese-label regression.
- The real browser host guard blocked a fetch to
  `https://methodurl.vcas.visa.com/method/status` after synthetic card fill.
  The new regression expected `method complete` and received `blocked`.
- Two exploratory network variants were exercised locally: a payment-scoped
  VCAS/Online-Metrix allowance and removal of the browser request-host block.
  The latter passed 48 tests across the checkout, decoupled-3DS, and Clerk
  network suites. Both variants were removed from the working implementation
  after Firstmate's final instruction to hold all host-scope changes.
  These synthetic fixtures are **not a reproduction of SBPS's server-side
  AuthenticateInit error**.

## Version comparison

Executed each tag's `requestHostInScope` and its literal host arrays, transpiled
from `git show <tag>:apps/mcp/src/bot/browser.ts`, using `tldts` for registrable
host comparison. The session allowlist was `["fep.sps-system.com"]`:

| Revision | methodurl.vcas.visa.com | h.online-metrix.net |
| --- | --- | --- |
| v1.1.11 | false | false |
| v1.1.12 | false | false |
| v1.1.13 | false | false |
| baseline HEAD | false | false |

`requestHostInScope` at v1.1.13 and baseline HEAD is byte-identical (SHA-256
prefix `5083da089a91`). `isFailFastScopeAbort` is byte-identical at all four
revisions (prefix `6a6c18b345b6`). Therefore the two missing host allowances
were not removed between those releases and HEAD. Successful purchases on
those versions do not establish that this particular SBPS/VCAS topology was
covered.

Relevant history, identified with `git log -S` and function-body diffs:

- `e85b759d7547db6eadce8c6a45d9163f2b751bea` introduced the fail-fast scope
  predicate, predating all three candidate GA versions.
- `784b931b` introduced the CardinalCommerce network allowance. v1.1.13 and
  HEAD retain the same single-entry list. This was an improvement, not removal
  of VCAS or Online Metrix.
- `22683018645719510596621e1db2a07e8a987926` introduced host-denial diagnostics.
  A newly visible diagnostic does not itself establish a newly blocked request.
- `git diff v1.1.13 HEAD -- apps/mcp/src/bot/pay-operator.ts` contains
  account-binding additions; the native 3DS wait/resume algorithm is unchanged.
- The browser's fill, submit, challenge detection, and wait functions now
  accept an explicit captured `page`, replacing `this.page` access. The
  detection patterns and native polling behavior remain. The background timer,
  occlusion, and renderer throttling disables remain in
  `browser-process-owner.ts`; their removal from browser.ts was a move.
- Pre-submit document-handle-bound cleanup is present in both v1.1.13 and HEAD.
  Reverting it would reintroduce the documented risk of clearing ACS fields.

No commit has been proven to regress the reported SBPS method/authenticate
sequence. There is no valid good/bad bisect boundary for the host predicate:
all candidate good versions reject both hosts. The native decoupled fixture
passes at current HEAD, so it cannot serve as the missing SBPS failure oracle.
Do not label the page-binding, broker, or observation changes regressors merely
because they are recent. A useful bisect needs a deterministic failing fixture
or captured failing request/response behavior from this specific topology.

## Implementation boundaries

CVV detection extends the existing selector and associated-label path. It does
not inject `autocomplete`, expose real card values, or change approval logic.
Existing form ambiguity, non-card exclusions, and sealed-field cleanup remain.

The captain approved the held payment-window relaxation on 2026-09-12 (inbox
005), following the earlier hold. The implementation:

- Relaxes the existing XHR/fetch request-host check for the exact payment page
  and its frames after card fill begins or payment submission is entered.
- Adds no curated ACS/fingerprinting host list. Merchant/issuer JavaScript can
  reach its native authentication destinations, including VCAS and Online
  Metrix. Other pages retain their existing host-scope behavior.
- Retains the allowance through resumable waits, bounded to 20 minutes from
  payment entry/submission. Split checkout relies on window expiry; its
  confirmation reporting does not revoke the allowance. Existing browser
  submit/wait paths can clear it earlier on their terminal outcomes, but
  terminal-result revocation is not guaranteed across all payment paths.
- Preserves PAN destinations, vault egress, session action hosts, one human
  approval per purchase, card sealing, and broker ownership checks.

No forced method-result submit, ACS mutation, additional human approval,
browser workaround, or alternative payment method is added. It remains unknown
whether AuthenticateInit's error is entirely downstream of the blocked hosts.
The original report says it also failed after those hosts were admitted; that
is evidence against assuming the host fix alone resolves it, but supplies no
request/response trace that would prove a separate root cause.

The captain explicitly deferred terminal-reporting integration to avoid
re-blocking in-flight authentication. Follow-up hardening is tracked as
`ts-payment-window-terminal-revocation` in `TODOS.md`. PR delivery must retain
the UNVERIFIED status and the deferred real-payment acceptance stated above.

## Validation

Historical CVV-only validation (before removing the bare `security` alias):
`vitest run src/bot/__tests__/browser-payment.test.ts`
reported `253 passed (253)`, including all seven SBPS cases. MCP typecheck,
ESLint on both changed files, and diff checks passed.

The payment-window regressions exercise real browser request routing in local
and broker modes. Before applying the approved patch both fail with expected
`method complete`, received `blocked`. Coverage includes method and fingerprint
requests, an unlisted issuer, a method iframe's requests, other-page exclusion,
inconclusive-wait retention, deadline expiry, terminal-failure revocation, and
preservation of the separate PAN destination restriction. All seven tests in
`browser-decoupled-3ds.test.ts` pass with the patch; MCP typecheck also passes.

The required project-memory helper was run. It refused because both AGENTS.md
and CLAUDE.md are distinct real files; neither was overwritten or reconciled as
part of this payment fix.
