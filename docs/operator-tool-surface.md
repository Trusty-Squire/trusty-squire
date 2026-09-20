# Flat operator tool surface

Trusty Squire’s operator surface is a set of flat, single-purpose MCP tools.
Discover the installed server’s exact input and output schemas with `tools/list`;
that registered schema is authoritative for a particular server version.

The operator surface is listed below. Recipe and vault/account tools are
separate surfaces.

Startup navigation waits for `DOMContentLoaded`, including deferred scripts,
but skips the humanized post-load dwell before observing the page. It does not
wait for all images or subframes to finish loading; later asynchronous UI may
still require another observation or an explicit wait.

| Purpose | Tool |
| --- | --- |
| Goal-shaped drive | `operate_drive` |
| Start and finish | `operate_start`, `operate_finish` |
| Read the page | `operate_observe`, `operate_screenshot`, `operate_network` |
| Drive ordinary UI | `operate_navigate`, `operate_click`, `operate_type`, `operate_select`, `operate_press`, `operate_scroll`, `operate_wait` |
| Email verification read | `operate_read_inbox` |
| Login | `operate_login` |
| Vault-aware browser work | `operate_fill_credential`, `operate_extract` |
| Payments and vault lists | `inject_card`, `list_credentials`, `list_payment_cards`, `edit_payment_card` |

For a signup, checkout, or other goal-shaped website task, call `operate_drive`
with the goal and a `facts` bag (email, name, address, `card_ref`, …). Pass
`session_id` of an open session, or `url` to open the page and drive in one
call; provide exactly one. Model-directed steps ask Jev for one operation (CLICK, TYPE_TEXT, SELECT,
SCROLL, WAIT, DONE, BLOCKED) plus a matching per-operation target; unused
target heads cannot act. Identifying values come only from the facts bag. A
search or query field may receive a phrase Jev assigns from the goal's own
words or the facts; identity and payment fields still require a fact.
On a drive carrying `card_ref`, the released card supplies its own facts —
`exp_month`, `exp_year`, `exp_year_short`, `card_expiry`, `card_expiry_long`,
and `card_name` — and the drive types expiry and cardholder name from them
after release. A later release rebuilds all of them, and they are never offered
as goal phrases, so a card value cannot be typed into a search box. Card
controls take those card values and nothing else: the shipping name never
lands in the cardholder field. A combined expiry control takes the year length
the control itself states (placeholder, pattern, inputmode, or label), never
its declared width — seven characters fits both `MM/YYYY` and `MM / YY`. With
nothing stated the drive writes the two-digit year, reads the value back, and
rewrites that control once with the four-digit year when the write was
rejected or truncated. A separate year control uses its own maxlength: two
digits take `exp_year_short`, anything else takes the four-digit `exp_year`.
The loop reads verification mail when a verification field is chosen or
the page is stuck after a click. It does not gate on confidence. The drive
loop snapshots and acts with an in-page registry plus CDP input; login,
inbox, and card still use those primitives. The two-head Jev request,
structured state, choice validation, WAIT, SELECT option targets, snapshot
evaluate, and drive rules prose are adapted from browser-use/jev-ultrafast
(MIT).
It returns a handoff (never a bare page): status, the current compact
observation with the same stable refs, trajectory, and done/remaining.
`needs_value` names the missing field's label; a country control already
showing a value, and expiry or cardholder-name controls on a drive carrying
`card_ref`, do not raise it. `stuck` means no listed element advances the
goal. Resume the same session with `answer` (a
readable action slug from the handoff options, `done`, or `stuck`) and/or
added `facts`. Use the single-step primitives only for a handoff you are
answering or a task that is not a goal.

When `operate_drive` opens a `url`, its first page read is the drive snapshot;
startup skips the general observation and automatic consent-banner dismissal
and settling retry. Consent overlays remain ordinary controls for the drive
loop to handle. The live Google-session admission gate still applies.
Standalone `operate_start` retains its general initial observation in the
requested format and best-effort consent-banner dismissal before that read.

After a guarded drive action, settling waits for two animation frames or
50 ms. If the document's time origin changed, the loop then polls for a
nonempty, changed fingerprint of body text and input/select/textarea types
and values before taking the next snapshot. URL or title changes alone do
not end that wait. This replaces the network-idle wait with a 300 ms timer
that also ends polling when animation frames are suspended. It detects
content movement, not complete page readiness; later asynchronous content
may still require another observation or WAIT. A guarded action whose target
sits outside the viewport scrolls it into view instantly before the occlusion
measurement, so an offscreen control does not burn the attempt.

A snapshot with no controls — a same-document checkout stage swap, or a page
still hydrating — is re-observed after up to three automatic waits per blank
window before any question is asked. For that case alone the progress
fingerprint and the planner's page text fold in the body text, because prose
is the only evidence such a page offers.

Drive offers `Open <label>` click choices for recognized picker fields alongside
typing where supported. Supply `origin`, `destination`, and `date` facts for
travel forms: Departure matches the date, not the origin. Picker typing preserves
the input focused by the opening click. Opening waits up to 400 ms for visible
options or calendar cells; typing waits up to 2 seconds for changed suggestion
labels. These bounded waits do not guarantee that an asynchronous picker is ready.

A custom combobox with a missing or different displayed value can be opened
automatically when a supplied fact matches its field, including `ticket_type`,
`cabin`, and `passengers`. Within a call, automatic opening is attempted once per
observation fingerprint. A stale, occluded, or offscreen click yields the next
decision to Jev even if the recovery observation changes. A matching page-wide
option also yields to Jev: the dispatcher cannot establish custom option
ownership and does not select it or mark the field filled. A native select or
a typeable control whose field matches a supplied fact is filled by the drive
itself before Jev is asked, once per target per observation fingerprint. A
checkout page's offscreen fillables stay eligible, because the act path
scrolls a target into view before it measures; a control already displaying
that fact is not offered again. Recovery and
option-ownership regressions live in
[`operate-drive-fixture.test.ts`](../apps/mcp/src/bot/__tests__/operate-drive-fixture.test.ts).

Calls default to 60 steps and 45 seconds; `max_steps` and `max_seconds` set
the per-call allowances within the registered schema's limits.
A `budget` handoff preserves partial progress for another call on the same
session. `jev_unavailable`, `no_progress`, and `evaluate_timeout` also return
handoffs; the last indicates that an in-page evaluation exceeded its deadline.
`pending_approval` supplies the card approval URL. `card_incomplete` means the
card was released but not every requested field was filled; resume the same
session to retry against the existing `approval_id`. The handoff's `payment`
contains the per-field results. Always call `operate_finish`
when the task is finished. Drive-initiated opens follow the
[broker refused-start receipt contract](browser-broker.md).

browser-use/jev-ultrafast (MIT) adoptions live in `operate-drive.ts`. Mapping:

| # | Adoption | Where |
| --- | --- | --- |
| 1 | Two heads: `operation` plus `<operation>_target`; unused heads cannot act | `buildDriveQuestions`, `decideAfterJev` |
| 2 | Structured `state` `{page, elements, recent_actions}` and `instructions` `{goal, rules}` | `DriveJevState`, `buildJevState`, `pageTextFromObservation` |
| 3 | Per-element `operations` plus checked/disabled/required/acted and live `value` from the drive snapshot | `elementState`, `operationsForRow`, `drive-snapshot.ts` |
| 4 | `validate_choice`: offered id, exact keys, finite [0,1], sum ±0.02, argmax. Malformed answers are `invalid_answer` (reason + confidence), not `low_confidence`; one same-observation retry | `validateChoiceReason`, `admitsChoice` |
| 5 | SELECT option is a target (`slug:option`) | `selectTargets`, `selectTargetKey`, `lastSelectOptions` |
| 6 | WAIT when the needed control is absent/disabled or results are loading | `DRIVE_RULES`, `{kind:"wait"}`, `DRIVE_WAIT_MS` |
| 7 | Rules prose adapted from their MIT `NEXT_ACTION` / `TARGET` | `DRIVE_RULES` |
| 8 | No confidence gates, including DONE. Validation of the answer shape stays. The purchase approval is the payment gate | `admitsChoice`, `decideAfterJev` |
| 9 | Three consecutive non-wait actions with no fingerprint change | `DRIVE_STALE_LIMIT`, `staleNonWait` |
| 10 | Decision bound to the observation fingerprint, consumed once | `boundFingerprint`, `consumedActionKey` |
| 11 | Candidate and question budgets; only offered choices can be selected | `driveTargetSets`, `buildDriveQuestions` |
| 12 | Snapshot, decision, guarded CDP action, then bounded settling; automatic combobox opening follows the policy above | `drive-snapshot.ts`, `drive-act.ts`, `operate-drive.ts` |

The drive considers up to 250 candidates and caps each decision batch at 128
total choice criteria, including operation and goal-value choices. Truncation
is disclosed in the question instructions; retained dropdown choices with
omitted siblings carry `options_elided` in planner state. The allocator reserves
a usable goal-value choice alongside `none` when available. Omitted choices
cannot be selected in that batch.

The drive snapshot excludes ordinary offscreen buttons, retaining offscreen
form controls and controls in header, navigation, and footer regions. This
limits calendar-button floods. Jev's visible element state includes each ref
once even when it supports both typing and clicking; the operation-specific
choices remain separate.

`operate_read_inbox` reads the session's signed-in Gmail inbox for a
verification email in dedicated utility tabs that are closed when the read
finishes, so the page waiting for the code never navigates away. Because
Gmail's search index is eventually consistent (it can lack freshly delivered
mail for minutes), the read cross-checks the search listing AND the real-time
All Mail listing and opens the genuinely newest matching row on the page it
was extracted from. A matching row dated before the session started is a
previous task's mail — its single-use link is already consumed or expired —
so it is never returned; when only such pre-session matches are seen, the
read reports an honest `found: false` with retry guidance instead of a dead
link. When the opened message renders, its text and links are read from the
message's own cards rather than the whole page, and Gmail's own chrome
(account-menu, mailbox, and support links) is dropped before scoring; the
remaining mail links are read verbatim from the DOM, not from the
size-capped interactive inventory.

Use an action `ref` from the current observation. `operate_start` and
`operate_observe` default to `format: "compact"`, a paged control map;
`format: "full"` is the explicit DOM view. After `inject_card` releases a card,
both modes replace that card's complete PAN and security code while leaving all
other content verbatim — including a CVV the agent typed itself via the masked
per-digit tokens (`{{pan}}`, `{{cvv}}`, `{{pan:N}}`, `{{cvv:N}}`) into any
textbox ref. `operate_screenshot` composites covers over only the
injected controls and identified ordinary displayed copies that contain those
two values. Payment approval and vault write-only boundaries remain separate.

## Pickers and popup return

For a readonly field backed by a picker, click its Select button, then click
the choice in the resulting observation or a fresh screenshot. Do not type
into the readonly field. An inline dialog stays on the current page; an owned
popup opened by an ordinary action becomes the active page. Unrelated pages
and pages without a proven opener are not adopted.

When the active picker closes after a selection, post-click observations and
subsequent screenshots return to its nearest still-live, session-owned opener
in the creation-time ancestry. This return does not choose a sibling or foreign
page. Re-observe before using refs from the restored form and check the selected
value. The dispatched click and field verification remain bound to the original
picker document; returning does not dispatch another action on the form.

This ordinary-popup return excludes tracked OAuth provider/product pages. Card
release and later checkout actions use the same generic page lifecycle.
The local regression fixture is
[`picker-window.test.ts`](../apps/mcp/src/bot/__tests__/picker-window.test.ts).

## Clicking a screenshot-visible control

Prefer an observed `ref` or unique `@label`. A closed-shadow control may be
visible in a screenshot without a usable DOM ref. In that case,
`operate_screenshot` can return an additive `click_binding`:

```json
{
  "click_binding": {
    "screenshot_id": "12345678-1234-4234-8234-123456789abc",
    "width": 1600,
    "height": 1200,
    "coordinate_space": "image_pixels"
  }
}
```

Pass coordinates in that original image's pixels, measured from its top-left:

```json
{
  "session_id": "session-id",
  "screenshot": {
    "screenshot_id": "12345678-1234-4234-8234-123456789abc",
    "x": 348,
    "y": 488
  }
}
```

This is an `operate_click` input. Supply exactly one of `ref` or `screenshot`.
If your image viewer resizes the image, scale the displayed coordinates back to
`click_binding.width` and `height`. The server handles device scale, frame crops,
full-page origins, and current scroll, rounding to the nearest CSS pixel for
both hit testing and dispatch. Points outside the current viewport cannot
be clicked from a full-page or frame image; scroll and take a new screenshot.

The binding belongs to the captured page, expires after 60 seconds, is replaced
by the next screenshot, and permits one attempt. Navigation, viewport/scroll or
frame-geometry changes invalidate it. The hit node must retain its physical
identity, attributes and bounds, including its control's text and associated
label text, across capture and dispatch preparation. Overlapping surfaces must
retain their geometry, relative paint order and hit-affecting styles: removing, hiding or
moving an overlay cannot authorize a newly exposed control from the old image.
Unrelated text changes do not invalidate an otherwise unchanged target. This is
a geometry/identity binding, not proof that every pixel or page animation stayed
unchanged. If capture cannot establish a binding, the image is still returned
without `click_binding`; observations and other actions remain usable.

Results include `screenshot_click.dispatch` (`dispatched`, `not_dispatched`, or
`unknown`), `outcome: "unknown"`, and a retry policy. `dispatched` means the
native pointer call completed, not that the provider accepted the action or
cleared a challenge. A lost pointer acknowledgement reports unknown dispatch; a
failed observation after an acknowledged click retains `dispatch: "dispatched"`.
Both leave the outcome unknown; observe before deciding a new action. The same image token
cannot replay an uncertain click. `stale_screenshot` requires a new screenshot;
`invalid_screenshot_point` means the point was outside the image/current viewport.
For ordinary clicks, `target_unresolved` means the label was never issued in this document;
`stale_ref` remains the response for an expired physical ref or retired alias.

When combined with `capture`, the vault capture result retains the click receipt;
storage success does not establish the provider outcome. Screenshot clicks use
the same [picker and popup return rules](#pickers-and-popup-return).

Coordinate clicks use the session's existing control-plane and payment predicates and
are not promoted into replay recipes. They do not change vault storage,
credential capture, payment approval, or 3-D Secure behavior. Local regression
fixtures prove pointer mechanics; they do not guarantee Cloudflare clearance.

## Browser egress is unrestricted

The operator does not filter browser requests by host. Payment SDKs, issuer/ACS
frames, fingerprinting, authentication providers, analytics, and arbitrary
third-party resources need no host declaration. This holds before, during, and
after payment; there is no payment-network window or scope-denial reporting.

`operate_start` accepts `allowed_hosts` and `extra_allowed_hosts` for backward
compatibility and ignores them. There is no host-widening tool.
Existing control-plane action restrictions, credential vault egress, card-fill
recognition and sealing, and the purchase's single human approval are unchanged.

## Finish with the flat schema

`operate_finish` uses the flat enum shape, not a nested union:

```json
{ "session_id": "session-id", "outcome": "none" }
```

```json
{
  "session_id": "session-id",
  "outcome": "credentials",
  "store": { "service": "Example Service" }
}
```

```json
{
  "session_id": "session-id",
  "outcome": "result",
  "summary": "Provider setup reached its reported completion page.",
  "data": { "provider_reported": true }
}
```

`credentials` requires `store`; `result` requires `summary` or `data`.
Agent-supplied data is reported data, not proof that login, provisioning, or a
mutation completed. Preserve booleans as booleans in result data.

`operate_finish` returns a common, additive finish receipt:

```json
{
  "session_id": "session-id",
  "operation_id": "operation-id",
  "execution": "completed",
  "mutation": "not_dispatched",
  "cleanup": "closed",
  "closed": true
}
```

Its allowed values are `execution: completed | cancelled | pending | unknown`,
`mutation: not_dispatched | dispatched | unknown`, and
`cleanup: open | closing | closed | already_closed | unknown`. `closed` is true
only when closure is positively established. A bounded finish can return
`execution: "pending"`, `cleanup: "closing"`, and `closed: false` while the
lifecycle retains ownership and drains work. Repeat finish to obtain closure
proof; do not replay a mutation. That closure proof lives with the live session:
ending the broker connection ends it. Missing proof is unknown, never an
inferred `already_closed`. Clients should feature-detect the output schema in
`tools/list` when talking to older installed servers.

## Credential capture and retrieval

`operate_extract(store=...)` sends a revealed credential directly to the
write-only vault and returns storage metadata, not the secret. Without `store`,
it returns selected credential fields. Extraction uses the v1.1.6 selection
behavior: masked named candidates and identifier-like code values are excluded,
a recovered primary key takes precedence over a same-named labeled snippet,
and a recognized truncated primary candidate is returned as `api_key_truncated`.
Team and project IDs retain their own labels. A contextually accepted near-copy
key, such as DeepInfra's opaque key format, survives generic API-key sanitization.
Reveal the full key on the provider page before storing it.

Both `operate_extract(store=...)` and `operate_finish(outcome="credentials")`
exclude `_truncated` fields from storage and return `stored_credential: null`
when only identifiers or truncated metadata remain; that is not a successful
credential capture. These checks retain v1.1.6's limitations: split-node masks,
substring scans of masked rows, and provider-specific rescans can lose mask
evidence and produce invalid storage or a successful outcome. They do not
establish that every selected value is a usable key. Executable selection and
storage coverage lives in `apps/mcp/src/bot/__tests__/operate-session-flow.test.ts`
under “v1.1.6 credential candidate selection”. Observation and screenshot reads
remain verbatim; credential selection does not redact those surfaces.

`operate_click`, `operate_type`, `operate_select`, and `operate_press` accept an
optional `capture` field:

```json
{
  "store": { "service": "Example Service", "label": "fresh-key" },
  "source": {
    "role": "textbox",
    "name": "API key",
    "container": { "role": "dialog", "name": "New API key" }
  }
}
```

The source role is `textbox` or `code`. For a plain-text copy field without
those roles, use `source: {"selector": "<observed CSS selector>"}` instead of
`role`/`name`. Choose the selector from the actual element structure, never from
the secret value; CSS sources select visible elements only. Either source can
include an optional named `dialog` or `region` container to limit the selection.
Capture pins exactly one element and returns vault metadata, an unresolved
result, or explicit ambiguity, never the captured value or a screenshot. A `stored: true`
result includes `resolved_source`, describing the pinned element used to read the
value by tag and role/name or selector. If that descriptor is unavailable, the
receipt falls back to the requested source. Default actions and reads remain
unredacted.

Resolution includes open shadow roots and unions matching sources before
requiring exactly one. An id-less `<input>` with no type or `type="text"`
has the `textbox` role; its value does not override a requested name or role.
Password, search, and datalist-backed inputs do not substitute for textboxes.
The CSS fallback supports bare simple selectors in shadow roots and simple
descendant chains that cross a shadow boundary. With a requested container,
the chain must start at that container (for example, `[role=dialog] input`);
it cannot use an ancestor outside the container. Other selector forms retain
Playwright's matching behavior.

Zero source matches return `capture_unresolved` with `candidate_count: 0`
and `found`: up to 12 visible roles/names from the document and its open
shadow roots, never field values. This diagnostic list can include elements
outside the requested container; it is not a list of matching sources.
It is empty when no reportable elements exist or diagnostics are unavailable.
More than one source match returns `capture_ambiguous`. A single source with
no usable value, or an extraction/storage exception, also returns
`capture_unresolved`; inspect `candidate_count` and storage metadata before
choosing recovery.

For `operate_click` with capture, the source is probed before the click and
resolved again after the click settles. Capture waits a bounded render window
for a changed resolution. A new element or a changed value in the same element
can be captured; an unchanged element and value cannot. If the resolution stays
unchanged, or the pre-click probe failed, capture returns
`error: "capture_pre_action_only"`, `stored: false`, `storage: "unknown"`, and
`retry: "extract_only"`, without a value or vault write. Zero or multiple
candidates never authorize storage. See the post-action and same-element reveal
fixtures in `apps/mcp/src/bot/__tests__/credential-capture-browser.test.ts`.

On an uncertain storage result, pass the returned
`write_id` in the same `capture` object to `operate_extract` for extraction-only
recovery. Never resend the create action. Mutation verbs refuse a supplied
`capture.write_id`; the vault binds retries to the account, service, label, and
original value and refuses rotation of an existing credential slot.

Pending capture storage permits unrelated plain actions and reads, including
`operate_click`, `operate_type`, `operate_observe`, and `operate_extract` without
`capture` or `store`. A new vaulting attempt (including top-level
`operate_extract.store`) and `operate_finish(outcome="credentials")` remain
fenced; extraction with the original `capture.write_id` remains available.
This exception does not relax other unresolved-mutation guards. Broker recovery
records are audit-only and preserve the capture's prior admission state, including
across delivery acknowledgement. See the recovery-transition coverage in
`apps/mcp/src/bot/__tests__/broker-operator.test.ts`.

For the Neon success dialog structure observed on 2026-09-10 (a LABEL named
`API token`, followed by a nested plain-DIV value and a Copy button), the
value-free source is:

```json
{
  "selector": "label:text-is(\"API token\") + div div:not(:has(*))",
  "container": { "role": "dialog" }
}
```

This uses Playwright's CSS text-label matcher and selects leaf DIVs in the
label's following value group. It does not match on token content or click Copy.
The native operator can use this documented source directly in atomic capture,
or in `operate_extract` with the original `capture.write_id`, unchanged store
service/label, and the same still-open session. The capture result and recovery
contract above applies. The selector is grounded in the
reported structure and synthetic regression, not a live validation of this fix.

For Firstmate's live retest: create one uniquely labelled Neon key with this
capture source; if needed retry extraction only with that write ID. Require
`stored: true` and vault metadata without plaintext, then use that returned
reference with server-side credential injection for the read-only
`GET https://console.neon.tech/api/v2/projects` and require HTTP 200. Finish the
session and require `cleanup: "closed"` and `closed: true`. Preserve existing
keys. Closed sessions from earlier diagnostics cannot be recovered by replaying
their write IDs in a new session.

The resolved-source receipt identifies a captured element; it does not discover
a selector for an uncaptured field. The Neon selector above came from bounded
inspection. For another page, inspect its rendered structure and choose a
selector that does not depend on the secret value. The read policy is owned by
[the observation model](observation-model.md), §4.5.

`fetch_credential` is the only raw-value path. Its first call returns an
approval link and no value; only a user’s passkey signature for that exact fetch
permits one resumed call with the returned `approval_id` to receive the value.
Do not use a payment or mutation approval as a substitute. Prefer
`use_credential` or a scoped app grant whenever server-side injection can do the
job without exposing plaintext to the agent.

## Using the rest of the surface

- `operate_login(provider, ref)` keeps OAuth and password lifecycle actions on
  the real profile. A chooser, challenge, return with uncertain authentication,
  or other human step is an honest pending result; stop automation and observe
  the owned session rather than treating a page title or same-origin URL as
  success. A browser error after dispatch follows the same contract as request
  cancellation: return attempt-owned completion evidence when available, otherwise
  `oauth: {state: "in_progress", completion: "unknown", next_action: "operate_observe"}`
  with the retained `session_id` and observe-before-action guidance. A timeout
  alone proves neither failure nor a human challenge. An attempt-owned popup
  opened before the initiating click rejects stays the observation target and
  retains OAuth ownership; closing it restores the viable product page. Concrete
  attempt-owned callback denials take precedence over interrupted-click uncertainty;
  they and proven pre-dispatch failures retain their failure semantics. See the
  routed click-then-error regression in
  `apps/mcp/src/bot/__tests__/oauth-login.test.ts`. Native OAuth
  errors retain `error.session_id`; ordinary errors direct observation, while
  unsettled cancellation keeps its existing wait/finish guidance. Never replay
  OAuth automatically after an uncertain result.
- `operate_type` accepts exactly one of literal `text` or a protected `slot`.
  For a saved login, read the selected credential's `field_names` with
  `list_credentials`, then call `operate_fill_credential` with `session_id`,
  `reference` (or `service`), and those exact names as `fields`. Use each returned
  slot with `operate_type(ref, slot)` on its matching form control; vault values
  are not returned. The installed schema documents the field defaults and naming
  conventions. A missing-slot error points to this vault flow; `operate_extract`
  with `into_slot` is for capturing a page value instead.
- `operate_extract`, `use_credential`, and `grant_app_access` preserve the
  write-only vault boundary. `fetch_credential` has the separate passkey gate
  above.
- `inject_card` retains the existing single purchase approval and fills only
  caller-named `pan`/`cvv` refs. Expiry, cardholder name, and billing are NOT
  inject targets and are not secret: after approval the result carries
  `exp_month`, `exp_year`, `name`, and any stored `billing` alongside `last4`;
  type those with ordinary `operate_type`/`operate_select`, or place the masked
  per-digit tokens returned in the inject_card result (`card_tokens`) into any
  ref yourself. It does not submit
  or interpret the checkout. Use
  `operate_observe`, `operate_network`, and masked screenshots as evidence, then
  drive the page with ordinary actions. A rendered 3-D Secure challenge is
  detected on observation/action results; the operator notifies the cardholder
  once and reports `three_ds` state `challenge_detected` without waiting on or
  gating the challenge. The same key also carries state `sdk_error_retryable`
  — no challenge rendered and nothing notified, because the processor's SDK
  failed to launch its challenge UI (e.g. `THREEDS_CARDINAL_SDK_ERROR` in the
  page's error telemetry). It is observation-only advice that the failure is
  transient, the checkout re-arms, and a resubmitted payment is expected to
  launch the challenge; a detected challenge always takes precedence.

Legacy union verbs and aliases are not part of this contract. Use the flat names
shown above, and use the installed server’s `tools/list` schema for optional
arguments and output details.
