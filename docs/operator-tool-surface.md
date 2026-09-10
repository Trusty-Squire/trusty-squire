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

## Scope is declared at session start

Host authority is exact-host entitlement. Declare every non-provider host the
task needs in `allowed_hosts` on `operate_start`; do not rely on a sibling domain
or a later navigation to grant authority. `operate_allow_host` can activate a
host only inside that session’s declared startup entitlement and existing
identity-provider allowance. It cannot broaden a session to a new host.

```json
{
  "service_url": "https://console.example.test",
  "allowed_hosts": ["api.example.test"]
}
```

If an observation reports a scope denial, treat it as a bounded diagnostic:
record the owning document/frame, exact hostname, resource type, reason, and
occurrence range. Do not add a permission or retry against another host. Start a
new session with the required host declared instead. Diagnostics must not include
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

The source role is `textbox` or `code`; an optional named `dialog` or `region`
limits the selection. Capture pins exactly one element and returns vault metadata
or explicit ambiguity, never the captured value or a screenshot. Default actions
and reads remain unredacted. On an uncertain storage result, pass the returned
`write_id` in the same `capture` object to `operate_extract` for extraction-only
recovery. Never resend the create action. Mutation verbs refuse a supplied
`capture.write_id`; the vault binds retries to the account, service, label, and
original value and refuses rotation of an existing credential slot.


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
  success.
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
