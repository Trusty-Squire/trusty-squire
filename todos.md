# Production / launch checklist

Ordered by importance. Work top-down. `[ ]` = todo, `[~]` = in progress, `[x]` = done.

## Tier 1 — launch-blocking (catastrophic if wrong)

- [x] **1. Secrets-never-in-logs audit.** DONE.
  - Audited: the injecting proxy (`http-proxy.ts`) never logs by construction
    (zero log calls, typed `ProxyError`s carry field *names*/codes/sizes, never
    values); `vault.ts`/`egress.ts` don't log; Fastify's default serializers log
    only method/url/status (no headers/body).
  - Fixed 2 partial-secret leaks: `mcp-install.ts` logged a machine-token prefix
    (`slice(0,8)`); `llm.ts` logged the upstream response body.
  - Added the structural backstop: pino `redact` (`SECRET_REDACT_PATHS`,
    exported + tested) so a future careless `log.info({ token })` / `{ headers }`
    / `{ body }` CANNOT leak — proven by `log-redaction.test.ts` (no `SECRET`
    survives; non-secret context stays). 259 API tests green.

- [~] **2. Master key — was a P0; code + ops migration DONE; only cred rotation left (you).**
  FINDING: prod was encrypting EVERY credential with `LocalKMS.withFixedKey(0x7f)`
  — a constant in this open-source repo (`deps.ts:169`, unconditional). The server
  never read `LOCAL_KMS_KEY`. So at-rest encryption was theater: anyone with the
  repo + the vault DB could decrypt everything.
  - [x] CODE FIX (PR #257): prod uses `LocalKMS.fromEnv()` and fails closed on
    boot if `LOCAL_KMS_KEY` is unset. +3 tests.
  - [x] OPS MIGRATION DONE (2026-06-29, no downtime, verified live):
    `NEW` set + backed up out-of-band → deployed fail-closed code (boot log
    `keyed from LOCAL_KMS_KEY (+1 legacy)`) → `rewrap-kek --apply` `rewrapped=72
    failed=0` → unset `LOCAL_KMS_LEGACY_KEYS` → server `[NEW]`-only, an originally-
    0x7f cred decrypts under the new key alone. The 0x7f public key is out of prod.
  - [ ] **#6 STILL YOURS — rotate the previously-public-keyed creds.** They were
    under 0x7f for their whole life (exploit needed repo + *private* DB access, so
    realistic blast radius is low — but best practice for a cred broker is to
    rotate). Re-store: ipinfo / plunk / sentry / VouchFlow / growthbook / the rest.

- [~] **3. DB capacity + alerting.** Capacity DONE; alert-wiring is a quick you-step.
  - [x] Bumped `trusty-squire-db` primary 512MB → **1024MB** (2x headroom for the
    launch spike; was the 256MB OOM-wedge failure mode). Verified healthy + API
    reconnected.
  - [x] Added **`/readyz`** (DB-readiness probe, time-capped) — 200 when the DB
    answers, 503 on wedge. `/health` stays shallow for Fly liveness so a wedge
    can't trigger an API restart loop. +3 tests. (Deploys with this branch.)
  - [x] Telegram uptime alert wired: `tools/readyz-check.sh` (revived from the
    openrouter-credit-check Telegram pattern) polls `/readyz` every 5 min via
    cron on the housekeeper box; pushes a 🔴 alert to Telegram (token from
    harvester.env, chat-id from `~/.trusty-squire/telegram-chat-id.txt`) on a
    DB wedge. Install confirmation message verified end-to-end.
  - [ ] Consider (not launch-blocking): the DB is a SINGLE node (no HA failover).
    A replica would survive a node death mid-launch — bigger lift; flag for after.

- [~] **4. Per-account rate limits + egress default cap.** Core DONE.
  - [x] Per-account rolling-hour limiter on the authed control plane (the
    `requireWeb/Agent/Any` guards) — `API_ACCOUNT_HOURLY_LIMIT` default 1000,
    returns 429. DoS backstop; doesn't touch the deployed-app egress proxy path
    (separate grant-token auth + its own per-grant cap). +2 tests.
  - [x] Egress DEFAULT cap: a grant minted without a rate now gets
    `EGRESS_DEFAULT_RATE_PER_HOUR` (default 1000) instead of unlimited; explicit
    rate still overrides. +test. [was user item #2]
  - [ ] Follow-up (not launch-blocking): **account-creation rate limiting is
    IP-based** (unauthed, no account_id yet) — not covered by the per-account
    limiter. Add a per-IP cap on the signup/create route before/at launch if
    signup-spam shows up.

## Tier 2 — launch readiness (HN-bounce / correctness)

- [x] **5. Ship 1.0.7 → `latest`.** DONE (PR #261). `npm dist-tags` → `latest:
  1.0.7` — carries 2Captcha vaulting + the fail-fast captcha gate + the
  10-example README. Reconciled the main↔staging divergence (merge: only
  package.json/CHANGELOG conflicted; CLAUDE.md auto-merged).

- [x] **6. Clean-machine `connect` test.** DONE — full-range self-test PASSED on
  a fresh box (different user/home): tool surface, vault read, provision via
  Google OAuth → extract → store → use, egress grant mint/use, audit ledger,
  revoke → 403, browser close. Secrets stayed server-side throughout. The
  install-time `✖ provider session check` proved cosmetic (the provision OAuth
  worked). Two real bugs found + fixed:
  - [x] stale "universal bot" copy in the `--no-registry` connect output
    (`cli.ts`) — reworded. Ships in the next mcp release.
  - [x] `grant_app_access` advertised `base_url` as `http://` → Fly's http→https
    redirect dropped the Authorization header → spurious 401 on a backend's
    first call. Now honors `x-forwarded-proto` (https). +test. Deploys with this.

- [~] **7. Fail-fast gate UX.** [user item #1] 2 of 3 gates done.
  - [x] **Captcha:** `operate_captcha_gate` returns a structured
    `needs_user {gate, message, remedy}` on settled=false — `captcha_solver`
    (set up 2Captcha in settings) / `captcha_wall` (proxy or manual) — so the
    host fails fast with an actionable message. +2 tests. Shipped to `next`
    (1.0.7-rc.2); rides 1.0.7 → latest via #5.
  - [x] **Inbox:** already a structured handback (`buildConsentRefusal`).
  - [ ] **SMS/phone:** NO bot-side handling or phone setting exists — that's a
    FEATURE (like 2Captcha vaulting was), not a UX tweak. Tracked separately.

- [x] **8. Privacy policy + ToS live and linked.** DONE.
  - `/privacy` + `/terms` pages added (apps/web), in the design system; linked
    from the home, pricing, and legal-page footers. Cover encrypted /
    write-only-sink / never-read-back, your-own-inbox verification,
    export+erasure, the automated-signup-is-your-responsibility disclaimer, and
    beta "as is" terms. Web build compiles (static routes).
  - NOTE: engineer-drafted first version, NOT legal-reviewed — have counsel
    review before a real launch.

## Tier 2.5 — connect-flow UX (found 2026-06-29 on a headless VPS)

- [~] **Headless `connect` hangs at the noVNC step.** (a) heartbeat DONE; On a no-DISPLAY box
  (datacenter VPS, e.g. AS23470 ReliableSite) connect prints the
  `vnc.trustysquire.ai/#p=…` URL then blocks on the sign-in poll with NO
  timeout and NO heartbeat — looks dead even when it's working. Fixes:
  (a) emit a "still waiting for sign-in…" heartbeat every ~15s + a bounded
  timeout with a resume hint; (b) the headless keychain is ephemeral, so
  set `TRUSTY_SQUIRE_SESSION_FILE=1` automatically when DISPLAY is unset
  (today the user must export it globally or connect re-loops the page).

## Tier 3 — survive launch day (observability / ops)

- [x] **9. Live dashboard (funnel + health + 5xx) in Fly Grafana.** Private
  Prometheus exporter on the API (`/metrics`, port 9091, 6PN-only; PRs #264 +
  #265 incl. the IPv6-bind fix) emits `squire_*` funnel/health gauges; Fly
  scrapes them into "Prometheus on Fly". Dashboard JSON committed at
  `apps/api/observability/launch-dashboard.json` (5xx from `fly_edge_http_responses_count`;
  all queries verified live via the vaulted Fly token). Import = paste into
  fly-metrics.net. Sentry stays the error-triage click-through, not a watched pane.

- [ ] **10. Global kill switches.** Extend the `BILLING_ENABLED` flag pattern:
  disable new-account creation / egress / a maintenance banner, flippable fast
  if something goes sideways mid-launch.

- [x] **11. npm rollback plan.** Runbook at `docs/RELEASE-ROLLBACK.md` + a ready
  one-command script `tools/rollback-mcp.sh <good> [bad]` (moves the `latest`
  dist-tag back + deprecates the bad version via the npm Automation token).
  Covers the can't-unpublish fact, the npx-cache caveat, fix-forward, and the
  Fly/API rollback path. Grounded on the live state (latest=1.0.7).

- [x] **12. Load test.** `tools/loadtest.mjs` + findings in `docs/LOAD-TEST.md`.
  Prod read-path baseline (1 GB DB): /health 3,300+ rps, /readyz ~1,100 rps
  (DB-pool ceiling ~conc 50), **0 errors at every level**, graceful latency
  degradation, no wedge. Orders of magnitude over a human-paced connect storm.
  Open follow-ups: per-IP cap on /v1/install (unthrottled write path) + the
  write-path ceiling is unmeasured (avoided polluting prod data).

## Tier 4 — later (when traffic justifies it)

- [ ] **13. Separate egress proxy from API server.** [user item #3] Real, but a
  when-you-have-traffic move. Launch-appropriate version is the rate limits in #4
  + maybe a separate Fly process/machine pool sharing the DB. Full split when
  egress volume justifies it; not a launch blocker.

---

## Owner action items (YOU — surfaced from the items above)
- [ ] **Rotate the previously-public-keyed creds** (#2) — ipinfo / plunk / sentry /
  VouchFlow / growthbook / the rest. Low realistic blast radius; best practice.
- [ ] **Point an uptime monitor at** `https://trusty-squire-api.fly.dev/readyz`
  (#3) to get paged on a DB wedge.
- [ ] **Later: DB HA replica** (#3) — single node today; a replica survives a node
  death mid-launch. Bigger lift, not launch-blocking.

---

## Parked (post-launch)
- Team / Pro tier: VouchFlow `signPayload` as the first-party signing backbone —
  signed vault mandates → approval workflows + device-attested vault access +
  tamper-evident compliance audit. Decision open: bundle vs wedge. (Not a launch
  item.)
