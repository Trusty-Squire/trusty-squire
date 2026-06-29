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
  - [ ] YOU: point an external uptime monitor (UptimeRobot / Betterstack / the
    housekeeper Telegram cron) at `https://trusty-squire-api.fly.dev/readyz` to
    get paged on a wedge. (Broader metrics dashboard lives in #9.)
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

- [ ] **5. Ship 1.0.7 → `latest`.** `npx @trusty-squire/mcp` currently pulls
  1.0.6 (no 2Captcha vaulting). Promote before pointing HN at it.

- [ ] **6. Clean-machine `connect` test.** Run on a fresh box/container (no Chrome
  profile, no keychain, headless + Xvfb). That's the actual first impression and
  the most likely place strangers bounce.

- [ ] **7. Fail-fast gate UX.** [user item #1] When the operator hits a gate it
  can't pass without config — 2Captcha, SMS/phone, email/inbox verification —
  return a STRUCTURED `needs_user` with the specific gate
  (`captcha_key` / `sms_phone` / `inbox_consent`) and the exact remedy
  (`npx @trusty-squire/mcp settings → …`). Detect early so it bails in seconds,
  not after a 6-minute drive. Doubles as expectation-setting.

- [ ] **8. Privacy policy + ToS live and linked.** Storing people's credentials
  is a legal necessity AND a trust feature. Surface the encrypted / write-only-
  sink / deletion-path story (GDPR export + erasure already exist).

## Tier 3 — survive launch day (observability / ops)

- [ ] **9. Error tracking + live dashboard.** Instrument the API (Sentry creds
  already vaulted) so failures are visible in real time; add request/error-rate
  + egress-volume metrics. Can't fix what we can't watch.

- [ ] **10. Global kill switches.** Extend the `BILLING_ENABLED` flag pattern:
  disable new-account creation / egress / a maintenance banner, flippable fast
  if something goes sideways mid-launch.

- [ ] **11. npm rollback plan.** Can't unpublish — so the move is publish a patch
  + move the `latest` tag. Have it written down and ready.

- [ ] **12. Crude load test.** Simulate a few hundred concurrent connects + vault
  ops + egress calls to find the breaking point BEFORE HN does.

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
