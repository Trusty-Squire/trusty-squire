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

- [~] **2. Master key — was a P0, code fixed; ops remediation PENDING (you).**
  FINDING: prod was encrypting EVERY credential with `LocalKMS.withFixedKey(0x7f)`
  — a constant in this open-source repo (`deps.ts:169`, unconditional). The server
  never read `LOCAL_KMS_KEY`. So at-rest encryption was theater: anyone with the
  repo + the vault DB could decrypt everything.
  - [x] CODE FIX: prod now uses `LocalKMS.fromEnv()` and fails closed on boot if
    `LOCAL_KMS_KEY` is unset (commit on `production-hardening`). +3 tests.
  - [ ] OPS RUNBOOK (no-downtime; `OLD = 7f`×32 = 64-hex; `NEW = openssl rand -hex 32`):
    1. Generate `NEW`; **back it up out-of-band** (password manager, NOT the DB/repo).
    2. `flyctl secrets set LOCAL_KMS_KEY=$NEW LOCAL_KMS_LEGACY_KEYS=$OLD -a trusty-squire-api`
       (old code ignores these — still runs on 0x7f, no breakage). **Do this BEFORE
       the new code deploys, or prod fails closed.**
    3. Deploy the new code (merge `production-hardening` → main → CI). New server
       boots `[NEW, 0x7f-legacy]` → decrypts existing creds via legacy, writes new
       ones under NEW. No downtime.
    4. Rewrap (re-wrap every KEK 0x7f→NEW). Easiest on the box — env is already set:
       `flyctl ssh console -a trusty-squire-api` then
       `node /app/apps/api/dist/scripts/rewrap-kek.bin.js`  (dry-run)
       `node /app/apps/api/dist/scripts/rewrap-kek.bin.js --apply`  (mutate)
       Confirm `failed=0`.
    5. `flyctl secrets unset LOCAL_KMS_LEGACY_KEYS -a trusty-squire-api` (now `[NEW]` only).
    6. **Rotate the sensitive creds** — they lived under a public key, treat as
       compromised: ipinfo / plunk / sentry / VouchFlow keys / etc. Re-store them.
  - [ ] After: verify with `vault-decrypt-check` that all creds decrypt under NEW.

- [ ] **3. DB capacity + alerting.** `trusty-squire-db` OOMs at 256MB (known —
  see DB-OOM-wedge note). A launch spike WILL hit it. Bump VM memory + add an
  alert on DB mem / CPU / connection count. The DB is the SPOF.

- [ ] **4. Per-account rate limits on all authed routes + egress default cap.**
  - Rate limit vault store/list/use, grant mint, account creation per account/
    token (not just the old LLM-proxy 150/hr). One token must not hammer the
    control plane.
  - Egress: apply a server-side DEFAULT cap (per-grant AND per-account aggregate)
    — today caps are opt-in / unlimited-by-default (`perHour <= 0`). [user item #2]

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

## Parked (post-launch)
- Team / Pro tier: VouchFlow `signPayload` as the first-party signing backbone —
  signed vault mandates → approval workflows + device-attested vault access +
  tamper-evident compliance audit. Decision open: bundle vs wedge. (Not a launch
  item.)
