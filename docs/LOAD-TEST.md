# Load test (checklist #12)

Find the API's breaking point before HN does. Tool: `tools/loadtest.mjs`
(no deps; per-level socket pool sized to the concurrency so client backpressure
doesn't skew latency).

```bash
node tools/loadtest.mjs https://trusty-squire-api.fly.dev/readyz 25,50,100,200 6
```

Use **read-only** endpoints against prod — `/health` (shallow, pure HTTP/edge),
`/readyz` (hits the DB pool), `/v1/status`. They create no data and aren't
rate-limited.

## Baseline (2026-06-30, prod, single API machine + 1 GB Postgres)

| endpoint | c25 | c50 | c100 | c200 | errors | p99 @ c200 |
|---|---|---|---|---|---|---|
| `/health` (no DB) | 693 rps | 1343 | 2639 | **3362 rps** | 0 | 581 ms |
| `/readyz` (DB) | 596 rps | 1106 | ~1100 | ~1070 | 0 | 627 ms |

**Findings:**
- **Zero errors at every level**; `/readyz` returned 200 immediately after — no
  wedge, no 503s, no rate-limit trips. The 1 GB DB (up from the 256 MB OOM-wedge
  size) held.
- **The DB-touching path tops out at ~1,100 req/s** — the connection-pool ceiling,
  reached around concurrency 50. Past that, latency climbs (p50 40 → 164 ms) but
  throughput stays flat and nothing errors: graceful degradation, not collapse.
- The shallow path scales to **3,300+ rps**, confirming the **single Postgres is
  the bottleneck** (as expected), not Fastify or the Fly edge.

**Verdict:** an HN launch is human-paced (people running `connect`) — tens of
concurrent, a few requests each. ~1,100 DB-req/s of headroom is orders of
magnitude beyond that. The infra is ready.

## Caveats + follow-ups
1. **Write path not load-tested** — `/v1/install` (machine-token insert) and OAuth
   account creation are heavier per request and weren't hammered (they'd pollute
   prod data / the funnel metric). They share the same DB ceiling; at human-paced
   launch volumes the risk is low, but the absolute write ceiling is unmeasured.
2. **`/v1/install` is unthrottled** (unauthed, pre-account, so the per-account
   limiter doesn't cover it). The one concrete pre-launch action: add a **per-IP
   cap on the signup/create route** (already flagged under checklist #4) so a
   malicious burst can't mint machine tokens + DB rows unbounded.
3. **DB is a single node.** The ~1,100 rps ceiling is one Postgres; a read replica
   (checklist #3 follow-up) raises it and survives a node death mid-launch.
4. Numbers were generated from a single client box; the shallow 3,300 rps shows
   the client wasn't the limiter for the DB path, but a distributed test would
   confirm the edge ceiling.
