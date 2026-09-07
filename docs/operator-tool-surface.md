# Flat operator tool surface

The public operator contract is the 14 driving verbs in
`apps/mcp/src/tools/provision-drive.ts`'s `OPERATE_TOOLS` (excluding the two
separate recipe tools), plus `operate_pay`, `operate_payment_status`,
`list_credentials`, and `list_payment_cards` in `apps/mcp/src/tools/index.ts`.
That named set contains **18 tools** (the original design's 17-tool heading was
a counting error).
The exact-set check applies to the operator driving surface and the two named vault
lists, not to other MCP surfaces. The two recipe tools and nine other vault/account
tools remain separately exposed, as explicitly reconfirmed during implementation:
29 default tools total, or 31 with maintainer diagnostics enabled.

Actions use `ref` from the current observation. `operate_observe` is the single
general reader; `query`, `role`, and `cursor` retain the existing query/paging
semantics. `operate_extract(store=...)` still vaults credentials and strips their
values from its response. Extraction without `store` retains its existing behavior.

`operate_fill_credential` is only a rename and description change. It retains the
existing `reference`/`service`, `fields`, and `slot_prefix` schema and encrypted,
host-gated slot-loading handler. Fill its returned slots with `operate_type(slot=...)`.
It does not introduce an observation seal or expose vault values.

`operate_login(provider, ref)` delegates to the existing atomic OAuth flow on the
real profile. A pending chooser/challenge remains an honest `awaiting_human` result;
observe that session to continue. The existing password lifecycle actions
`prepare_signup`, `store_signup`, and `load_saved` remain available through the
same login tool. No OAuth browser, cookie, or state-machine mechanics change.

`operate_allow_host` retains the existing hostname/control-plane validator and
adds a public startup-scope check. Only hosts already entitled by the startup
hosts (including their subdomains, service login routes, and existing auth-provider
allowances) may be granted. A `mid_session` grant from an internal caller cannot
bootstrap further public grants. For an unrelated host, start a new session with
that host declared in `allowed_hosts`. Internal action/replay scope behavior is
unchanged. Refusals retain the blocked host and a remedy.

## Capability migration (include in the PR body)

| Old kind/tool | New tool or explicit removal |
| --- | --- |
| `operate_start` | Unchanged |
| `operate_finish`, `operate_finish_task` | `operate_finish(session_id, outcome?, store?, summary?, data?, verify_recipe?)`; outcome is `none`, `credentials`, or `result`, replacing the nested kind union; terminal preparation and teardown are unchanged |
| `operate_observe` | `operate_observe(session_id, query?, role?, cursor?, detail?)` |
| `operate_screenshot` | Same capture handler/schema and cost warning; reader name in guidance updated |
| `operate_act` | Removed public union; use the verbs below |
| `goto`, `navigate` | `operate_navigate(session_id, url)` (`navigate` was already absent in this checkout) |
| `click`, `js_click` | `operate_click(session_id, ref)`; DOM dispatch is an internal fallback only for pointer-interception failure with positive no-dispatch evidence, with all existing action guards re-applied |
| `type`, `fill` | `operate_type(session_id, ref, text, submit?)`; `fill` was already absent |
| `type_secret` | `operate_type(session_id, ref, slot, submit?)`; mutually exclusive with text |
| `select`, `select_many`, `operate_form_select_many` | `operate_select(ref, values)` for one option, or `operate_select(selections)` for ordered multi-field selection with partial results; native multi-select arrays were not supported by the old executor and are not added |
| `set_phone_country` | `operate_select(session_id, country)` preserves the native phone-country control helper |
| `press` | `operate_press(session_id, key)`; fill followed by Enter can use `operate_type(submit=true)` |
| `scroll` | `operate_scroll(session_id, direction)`; preserves the existing viewport scroll operation; element-scoped scrolling is not added |
| `allow_host` | `operate_allow_host(session_id, host)` with startup entitlement enforced |
| `oauth_login`, `oauth_click`, `oauth_settle` | `operate_login(session_id, provider, ref)` invokes the atomic OAuth flow; observe pending human completion, without exposing click/settle choreography |
| `lease` | Removed as a public configuration verb (already absent); the server's session call lease and internal OAuth boundary remain automatic |
| `login_prepare_signup`, `operate_prepare_login` | Existing `operate_login(action='prepare_signup', ...)` |
| `login_store_signup`, `operate_store_login` | Existing `operate_login(action='store_signup', ...)` |
| `login_load_saved` | Existing `operate_login(action='load_saved', ...)`, also `operate_fill_credential` |
| `operate_seal_vault_credential` | `operate_fill_credential`; handler and schema unchanged |
| `extract`, `operate_extract` | `operate_extract(session_id, store?, into_slot?, secret_label?)`; vault persistence and slot capture retained |
| `cart_add`, `operate_cart_add` | Removed specialized cart mutation/idempotency helper from the public surface; add items with `operate_click` and inspect the resulting cart |
| `cart_clear` | Removed specialized cart helper; use cart UI clicks and observation |
| `solve_captcha`, `operate_captcha_gate` | Removed dedicated solver/gate dispatch; the page state is visible through observe/screenshot and ordinary controls through click/type; autonomous solver dispatch is explicitly gone |
| `await_verification`, `operate_await_verification` | Removed dedicated inbox polling/OTP-slot helper; verification is a page state, and ordinary navigation/reading/interaction remain available; automatic inbox search/backoff and OTP-slot transfer are explicitly gone from the public surface |
| `upload` | Removed local-file chooser dispatch from the public surface: no upload verb is in the approved named target |
| `full`, `frame`, `handle` | Removed public configuration kinds (already absent); existing observe detail and screenshot frame capture remain, and action refs retain their existing frame identity |
| `confirm`, `missing_confirm`, `execute_capability` | Removed public kinds (already absent); task reporting uses finish, payments retain their existing separate approval flow |
| `operate_remember`, `operate_use` | Removed aliases; unchanged `operate_recipe_save` and `operate_recipe_run` remain |
| `operate_pay`, `operate_payment_status`, `list_credentials`, `list_payment_cards` | Unchanged |

Recorded-recipe compatibility is not an acceptance constraint. The superseded Tool objects, union input schema, alias wrappers, and union dispatch
are deleted. The flat verbs call the existing guarded executor through a private
function. Tests invoke the new verbs or test internal executor behavior directly.
No work is spent migrating recordings.
No recipe assertions were deleted or quarantined for this change.

The serializer, observation payload, payment/3DS implementation, vault internals,
and OAuth mechanics are out of scope. In particular, serializer-owned guidance
may still mention the legacy union while the concurrent serializer task replaces
it; this change does not edit `compact-observation-v2.ts` or rewrite its output.

## Click fallback validation follow-up

Ordinary click dispatch tracking wraps the original click operation, retaining
checkbox/toggle, widget and modal behavior. The browser-use DOM format carries only a sanitized,
proven pre-dispatch pointer-interception signal to the internal `operate_click`
fallback. Other failures retain their existing mapping; payment callers retain
the existing handle-bound tracking path.

Reachability is tested deterministically through the browser-use DOM session and tool
seam using the production dispatch error class and classifier. A legacy
real-Chromium overlay case also proves a failed plain click reaches DOM dispatch
and activates the control exactly once. The optional browser-use DOM fixture
was dropped after stale-ref failures before dispatch, as explicitly authorized;
it did not exercise the intended failure path. No existing flow assertions were
weakened or skipped to fix tracking regressions.

## Validation

- MCP typecheck, ESLint for changed TypeScript files, Prettier checks, and `git diff --check` passed.
- The complete static `test:fast` run passed all 109 files: 84 fast-core files
  (1,431 tests, 1 existing skip), 16 required behavior files (584 tests,
  3 existing skips), and 9 payment-safety files (469 tests).
  Required behavior/payment files were not filtered or moved to the slow tier.
- The operator export test checks the literal name set, uniqueness, registration
  parity, and absence of public `kind` schemas while preserving separate surfaces.
- `provision-session.test.ts` passed 155 tests and `operator-recipe.test.ts`
  passed 54 tests. No recipe assertions were deleted or quarantined.
- A direct comparison against the pre-change source confirmed the credential-fill
  handler is byte-identical; only its tool name and description changed.
