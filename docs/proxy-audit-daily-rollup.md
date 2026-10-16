# Proxy audit daily totals

Successful `vault.proxy_executed` calls with HTTP status below 400 are stored in
`VaultProxyDailyTotal`, keyed by UTC day, account, credential reference, target
host, requester, and grant ID. PostgreSQL `INSERT ... ON CONFLICT DO UPDATE`
atomically increments calls, per-status counts and bytes across API machines.
The first and last timestamps track the actual call times. Failed HTTP calls,
proxy errors, rejected calls, and all credential, grant, and payment events stay
as individual `VaultAuditEvent` rows. Streaming responses keep a provisional
row until the body completes; a successful completion is folded and deleted in
one transaction, while an errored stream keeps its event row.

The API release's existing `prisma db push` release command creates the table
before new API code starts. After that deploy, run the one-shot backfill as a
**separate command** with `AUTH_DATABASE_URL` set to the API auth database:

```sh
node apps/api/dist/scripts/backfill-proxy-daily.bin.js
node apps/api/dist/scripts/backfill-proxy-daily.bin.js --apply
```

The first command prints an eligible-row count for each completed UTC day,
oldest first. `--apply` aggregates one day at a time with an indexed
`(type, emitted_at)` range, then deletes that day's eligible source rows in
the same repeatable-read transaction. Each transaction has a 30-minute timeout.
Today is skipped so live API writes own its totals; rerun after midnight for
rows from that day. A stopped run can be resumed safely: rollback leaves both
source rows and counters intact, and a completed day has no source rows to
count again. It does not take a long table lock or run `VACUUM FULL`.
Ordinary PostgreSQL autovacuum reclaims the dead rows over time. The existing
hourly retention cron deletes daily totals older than the same 365-day audit
horizon.

The MCP `audit_log` ledger reads daily totals and retains failed calls as
anomalies. `expand` returns daily totals; old per-call successes may still
appear until backfill finishes. The `raw` view remains the individual-event
stream and therefore omits rolled-up successes. The web Activity page also
shows only individual events. Per-call drill-down and intra-day burst detail
for successful traffic are intentionally no longer available.
The account export includes the daily totals alongside individual audit events.

The notification decorator still receives every record call and keeps its
existing event-type policy; proxy access remains excluded from per-call
notifications. The vault retrieval rate limit
queries only `vault.credential_retrieved` rows. Egress grant rate limits use
an in-memory per-grant window; the grant spend-cap field remains grant metadata
and does not query proxy audit rows. Grant mint/revoke reconciliation queries
only their corresponding lifecycle audit rows.
