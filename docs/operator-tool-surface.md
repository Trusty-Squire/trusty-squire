# Flat operator tool surface

Trusty Squire’s operator surface is a set of flat, single-purpose MCP tools.
Discover the installed server’s exact input and output schemas with `tools/list`;
that registered schema is authoritative for a particular server version.

The named operator surface contains 18 tools: the 14 driving verbs in
`OPERATE_TOOLS`, excluding the separately exposed recipe tools, plus
`operate_pay`, `operate_payment_status`, `list_credentials`, and
`list_payment_cards`. Recipe tools and vault/account tools are separate surfaces.

| Purpose | Tool |
| --- | --- |
| Start and finish | `operate_start`, `operate_finish` |
| Read the page | `operate_observe`, `operate_screenshot` |
| Drive ordinary UI | `operate_navigate`, `operate_click`, `operate_type`, `operate_select`, `operate_press`, `operate_scroll` |
| Scope and login | `operate_allow_host`, `operate_login` |
| Vault-aware browser work | `operate_fill_credential`, `operate_extract` |
| Payments and vault lists | `operate_pay`, `operate_payment_status`, `list_credentials`, `list_payment_cards` |

Use an action `ref` from the current observation. `operate_start` and
`operate_observe` default to `format: "compact"`, a paged control map;
`format: "full"` is the explicit, verbatim-DOM view. Neither observation mode
masks, seals, or refuses page content. `operate_screenshot` likewise returns
the page’s actual pixels and is not a secret-redaction surface. Payment approval,
3-D Secure, and vault write-only boundaries remain separate safety controls.

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
storage success does not establish the provider outcome. Screenshot clicks also
use the existing popup adoption rules, so subsequent observations follow an
adopted tab opened by the click.

Coordinate clicks use the session's existing domain and payment predicates and
are not promoted into replay recipes. They do not change vault storage,
credential capture, payment approval, or 3-D Secure behavior. Local regression
fixtures prove pointer mechanics; they do not guarantee Cloudflare clearance.

## Scope is declared at session start

Startup merchant hosts also authorize matching registrable-domain siblings,
such as `shop.example.com` and `api.example.com`. Declare other required
non-provider hosts in `allowed_hosts` on `operate_start`. `operate_allow_host`
can activate a host only inside the declared startup entitlement and existing
identity-provider allowance; it cannot broaden that entitlement.

```json
{
  "service_url": "https://console.example.test",
  "allowed_hosts": ["api.example.test"]
}
```

A small set of challenge-infrastructure hosts is always in scope: the captcha
families (challenges.cloudflare.com, hCaptcha, reCAPTCHA). When an
`accounts.<service>` document is authorized by the base scope and has loaded
Clerk assets, its effective request scope also includes the bot-protection result
endpoints (`*.client.protect.clerk.com`,
`specter.protect.clerk.com`). Those endpoints are part of that already
authorized Clerk sign-in, so a Clerk-fronted protect-check needs no extra host
declaration for those requests. This exception applies to that document only;
it does not authorize an out-of-scope embedded Clerk document or arbitrary
caller-declared wildcard hosts.

If an observation reports a scope denial, treat it as a bounded diagnostic:
record the owning document/frame, exact hostname, resource type, reason, and
occurrence range. Challenge blockers can identify a scope cause; see the
[blocker diagnostic contract](browser-use-serializer-port.md#identity-deltas-and-query).
Retrying a widget does not authorize a denied host. Do not add a permission
or retry against another host. Start a new session with the required host
declared instead. Diagnostics must not include
request bodies or URL query values.

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
proof; do not replay a mutation. Broker closure proof survives delivery
acknowledgement and restart within its five-minute retention window and remains
bound to the original forwarder lineage. Missing proof is unknown, never an
inferred `already_closed`. Clients should feature-detect the output schema in
`tools/list` when talking to older installed servers.

## Credential capture and retrieval

`operate_extract(store=...)` sends a revealed credential directly to the
write-only vault and returns storage metadata, not the secret. Its default
behavior without `store` is unchanged. `operate_click`, `operate_type`,
`operate_select`, and `operate_press` accept an optional `capture` field:

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
Capture pins exactly one element and returns vault metadata
or explicit ambiguity, never the captured value or a screenshot. Default actions
and reads remain unredacted. On an uncertain storage result, pass the returned
`write_id` in the same `capture` object to `operate_extract` for extraction-only
recovery. Never resend the create action. Mutation verbs refuse a supplied
`capture.write_id`; the vault binds retries to the account, service, label, and
original value and refuses rotation of an existing credential slot.


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
service/label, and the same still-open session. Zero or multiple matches remain
an explicit ambiguity; do not repeat creation. The selector is grounded in the
reported structure and synthetic regression, not a live validation of this fix.

For Firstmate's live retest: create one uniquely labelled Neon key with this
capture source; if needed retry extraction only with that write ID. Require
`stored: true` and vault metadata without plaintext, then use that returned
reference with server-side credential injection for the read-only
`GET https://console.neon.tech/api/v2/projects` and require HTTP 200. Finish the
session and require `cleanup: "closed"` and `closed: true`. Preserve existing
keys. Closed sessions from earlier diagnostics cannot be recovered by replaying
their write IDs in a new session.

This adds capture for a known field structure, not general secret-free selector
discovery. The native capture response supplies counts/metadata, not DOM
structure; the Neon selector above came from Firstmate's bounded inspection.
Do not request an unredacted snapshot of a newly revealed key to discover a
selector. If another page needs a different selector, obtain value-free
structure evidence before choosing it.

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
  `apps/mcp/src/bot/__tests__/oauth-lifecycle.test.ts`. Native OAuth
  errors retain `error.session_id`; ordinary errors direct observation, while
  unsettled cancellation keeps its existing wait/finish guidance. Never replay
  OAuth automatically after an uncertain result.
- `operate_type` accepts exactly one of literal `text` or a protected `slot`.
  Use `operate_fill_credential` for login slots; it does not expose vault values.
- `operate_extract`, `use_credential`, and `grant_app_access` preserve the
  write-only vault boundary. `fetch_credential` has the separate passkey gate
  above.
- `operate_pay` and `operate_payment_status` retain their independent approval,
  card-selection, and 3-D Secure rules. Never infer a charge from form
  validation, repeat an uncertain submit, or use page reads as approval.

Legacy union verbs and aliases are not part of this contract. Use the flat names
shown above, and use the installed server’s `tools/list` schema for optional
arguments and output details.
