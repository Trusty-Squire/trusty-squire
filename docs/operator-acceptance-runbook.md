# Operator acceptance runbook

This runbook defines the evidence required to qualify an operator build. It is
an acceptance contract, not evidence that a particular build has passed. Use the
schemas advertised by that build’s `tools/list`; proposed fields called out below
must remain feature-detected until they are registered.

## Before a run

1. Record the exact MCP launch command, configured artifact/version, initialized
   version, connection epoch, and test start time. A successful SDK fallback is
   not evidence that the configured native transport is healthy.
2. Use an isolated HOME, configuration directory, browser profile, and test
   account. Do not copy a user’s browser cookies or profile. Do not change a
   user’s configured launch command, clear a shared cache, or restart a shared
   browser as a retry strategy.
3. Declare every non-provider destination in `allowed_hosts` on
   `operate_start`. A denied exact host is an observation to record, not a reason
   to widen the session. Start a new session with the required host declared.
4. Capture the operation, session, request, document, and browser/process
   identities needed to correlate each result. Suppress raw credentials and URL
   query values from the record.

## Deterministic acceptance

Run the required fast behavior and payment-safety suites whole, then the affected
browser/process, API-notification, packaging, and policy suites. Do not move
operator behavior, card-sealing, payment, or safety coverage to a slower tier.
The acceptance record must cover the following observable outcomes.

| Area | Required proof |
| --- | --- |
| Cancellation and dispatch | Abort before registration, before dispatch, while queued, and during a browser step. Prove no subsequent action, no uncertain mutation replay, and truthful `not_dispatched`, `dispatched`, or `unknown` evidence. |
| Finish and cleanup | Finish a settled operation, a running operation, and a non-settling operation. Prove bounded response, no foreign-target close, same-lineage repeat/reconnect receipt retention, and payment/cookie cleanup ordering. |
| OAuth and challenge | Exercise popup and same-tab return, denial, unrelated same-origin page, onboarding, and delayed hydration. A product return stops consent automation but does not itself prove authentication. A visible Google challenge returns its current number and delivery status, then pauses automation. |
| Observation | Check semantic native/custom/SVG/proxy/nested controls, offscreen query controls, shadow roots, rerendered refs, cursorless fresh queries, and stale/foreign cursors. Compare roles and names to an independent accessibility source. No page root or decorative container becomes an action. |
| Scope denial | Exercise an allowed page with a denied secondary host. The response identifies the owner, exact host, resource type, reason, and bounded occurrence summary; it never silently grants the host. |
| Vault capture and schemas | Verify registered schemas through both SDK `tools/list` and the host adapter. For capture, test one source, ambiguous sources, vault failure after creation, and lost reply. Results contain metadata only—never raw credentials—and failure never repeats a creation. |
| Native connection | Distinguish launch/dependency failure, configured-version drift, native transport close, and same-lineage recovery. A native reconnect claim needs native-process evidence, not a different client path. |
| Fresh qualification | Seed an old valid key as a negative control. A fresh run needs correlated authentication, provider-side creation evidence, unique run label, exact vault identity, reviewed provider-specific read-only probe, and bounded cleanup. Probe before any explicitly requested revoke. |

## Live qualification

Use the configured native MCP connection, per-call deadlines, and screenshots at
meaningful page transitions. A live run is qualified only after its provider-side
creation evidence, exact vault-store correlation, read-only probe, and cleanup
are recorded together. Existing credentials, page text, a dashboard title, or a
successful login alone do not qualify a fresh credential.

Keep the user-designated retained credential untouched. No qualification requires
outgoing email, paid-resource creation, or a real Google challenge. When Google
does show a number, record it immediately through the approved status path; when
it does not, label live challenge delivery unexercised rather than successful.

## Reading outcomes

Do not infer a completed action from timeout text, a browser title, or a delivery
acknowledgment. The planned additive finish receipt is:

```json
{
  "session_id": "session-id",
  "operation_id": "operation-id",
  "execution": "completed | cancelled | pending | unknown",
  "mutation": "not_dispatched | dispatched | unknown",
  "cleanup": "open | closing | closed | already_closed | unknown",
  "closed": true
}
```

This receipt is **pending implementation** until it appears in the installed
output schema. Until then, preserve the raw registered result and record
unresolved cleanup as unresolved; never manufacture `closed: true` from a
timeout or unknown-session response.
