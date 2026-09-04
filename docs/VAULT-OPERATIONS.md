# Vault operations runbook

Operational reference for the credential vault: the security + lifecycle
surface, master-key custody, retention, and backup/DR. Companion to
`docs/ARCHITECTURE.md`, which is the canonical system overview. This doc is
the runbook, not the design history.

Landed in the 2026-05-30 vault-hardening sweep. Everything below is
account-scoped and, for the human paths, web-session only.

## Server-managed encryption model (what's actually at rest)

Envelope, per credential:

```
master key (LocalKMS)  ──wraps──▶  account_kek_blob   (the only thing the master key touches)
        KEK            ──wraps──▶  encrypted_dek
        DEK            ──wraps──▶  ciphertext = AES-256-GCM(JSON.stringify(fields))
```

- **Field NAMES are plaintext** (`field_names` column) — not secret.
- **Field VALUES never leave encrypted** except transiently in memory
  during `reveal` / `use_credential` / `health`. They are never returned
  to an agent and never written to logs or audit payloads.
- AAD binds each layer to `(reference, account_id)`, so a row can't be
  decrypted under a different identity even with the right keys.

Client-encrypted card records use a separate cryptographic boundary. The API
stores their blobs verbatim and never receives the WebAuthn PRF output or
derived key; see the authoritative
[`SECURITY.md` contract](../SECURITY.md#client-encrypted-card-data). These blobs
are not re-encrypted during `LocalKMS` rotation and cannot be recovered if the
enrolled passkey is lost.

## Master-key custody + rotation

`LocalKMS` is a **keyring**, not a single key:

- `LOCAL_KMS_KEY` — the current key (64 hex chars / 32 bytes). Encrypt
  always uses this. A Fly secret, never hardcoded.
- `LOCAL_KMS_LEGACY_KEYS` — comma-separated old keys, tried on decrypt
  after the current one (GCM auth means the right key is self-evident).
  Set only during a rotation window.
- Unset `LOCAL_KMS_KEY` → an **ephemeral** key with a loud warning.
  Dev/CI only; credentials are unrecoverable on restart.

**Rotating the master key (zero downtime):**

1. Generate a new key: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
2. Deploy with `LOCAL_KMS_KEY=<new>` and `LOCAL_KMS_LEGACY_KEYS=<old>`.
   Old blobs still decrypt (legacy), new writes use the new key.
3. Re-wrap every `account_kek_blob` onto the new key:
   ```
   node apps/api/dist/scripts/rewrap-kek.bin.js            # dry run, round-trip verified
   node apps/api/dist/scripts/rewrap-kek.bin.js --apply    # mutate
   ```
   The migration is idempotent and verifies each re-wrapped blob
   decrypts back to the identical KEK *before* writing.
4. Verify decryptability across the whole vault:
   ```
   node apps/api/dist/scripts/vault-decrypt-check.bin.js
   ```
5. Once `failed=0`, drop `LOCAL_KMS_LEGACY_KEYS` and redeploy.

Only `account_kek_blob` is re-encrypted — `ciphertext` + `encrypted_dek`
live under the DEK/KEK and are untouched by a master-key rotation.

## Security + lifecycle endpoints

| Method + path | Auth | Purpose |
|---|---|---|
| `GET /v1/vault/credentials` | web+agent | Metadata list. Now also `age_days`, `last_changed_at`, `rotated_at`, and a `stale` flag (rotation nudge). |
| `POST /v1/vault/mutation-approvals` | web+agent | Begin a Telegram/passkey-vouched metadata edit or soft delete. The signed payload binds operation, target reference, requesting agent, nonce, and exact before/after metadata. |
| `POST /v1/vault/credentials/:id/health` | web | Envelope integrity probe — confirms the row still decrypts under the current keyring. No secret returned, no retrieval counted. `healthy:false` ≠ HTTP error. |
| `POST /v1/vault/credentials/:id/restore` | web | Undelete a soft-deleted credential. `409` if a live `(service,label)` twin holds the slot. |
| `POST /v1/vault/credentials/revoke-all` | web | Kill-switch: soft-delete every active credential. Requires `{ confirm: true }`. Recoverable via restore until retention sweeps. |
| `GET /v1/vault/export` | web | GDPR export — credential metadata, client-encrypted card records, and vault + payment audit trails. No plaintext secret values. |
| `DELETE /v1/vault/account` | web | GDPR erasure — irreversibly hard-purge all credential rows AND the audit trail. Requires `{ confirm: true }`. |

`revoke-all` (soft, recoverable) vs `DELETE /v1/vault/account` (hard,
irreversible) are deliberately distinct: the first is the panic button,
the second is right-to-be-forgotten.

The complete vault, payment-audit, and short-lived approval route/auth
reference is owned by [`apps/api/README.md`](../apps/api/README.md#endpoints).

The web and agent flows share the same server-side mutation chokepoint. The web
ceremony signs the displayed capability but never writes credential metadata
directly. After signature verification, one short database transaction locks
the pending approval, checks expiry using the database clock, verifies the
signed before-state, applies the metadata edit or soft delete, records the audit
event, and marks the approval terminal. A transaction failure leaves the
approval pending and the credential unchanged.

**Rate limiting:** every decrypt path — agent retrieve, runtime
retrieve, AND web `reveal` — counts against one per-account ceiling
(100/hr). There is no human-only bypass.

## Reading the audit trail (`audit_log`)

`GET /v1/vault/audit` is, and stays, the flat per-request stream: one row per
vault action, newest first, keyset-paginated. That stream is unreadable at
egress volume — a few hundred proxied LLM calls are a few hundred
`vault.proxy_executed` rows carrying the same reference, host, and requester.

The MCP `audit_log` tool therefore shapes it on READ (nothing about how events
are recorded changes; `apps/mcp/src/tools/audit-rollup.ts` owns the shaping):

- **`view: "ledger"` (default)** — `events` carries the security-relevant
  lifecycle rows (stored / rotated / deleted / edited, grant minted / revoked,
  payments) plus every anomaly, marked `anomaly: true` with an
  `anomaly_reason`. Routine successful egress is not listed here.
- **`egress.rollups`** — routine proxied calls collapsed per
  (credential reference × target host × burst): count, status breakdown, total
  bytes, first/last timestamp, and the grants live over that window. A burst
  ends when the gap between adjacent calls exceeds `window_minutes` (60).
- **`expand: "<rollup id>"`** — the individual calls behind one rollup. The id
  carries (reference, host, window), so the drill-down is stateless.
- **`grant_totals`** — cumulative calls / bytes / last-used per egress grant.
  Attribution is by credential reference within the grant's lifetime: the write
  side records no grant id on a proxied call, so direct `use_credential` traffic
  on the same credential is counted here too. The response says so in
  `attribution`. Per-event provenance is a planned write-side follow-up.
- **`view: "raw"`** — the unaggregated escape hatch, exactly the server's page.

Only verifiably-2xx egress is allowed to disappear into an aggregate: a non-2xx
status, a 429, a proxy error, a missing status, a `proxy_rejected`, or any
non-`success` outcome is surfaced as its own marked ledger row *and* still
counted in its rollup's totals.

## Notifications

A **new** credential stored via the agent path (bot signup) fires a
best-effort "new `<service>` key added" email to the account owner.
Rotations and manual web pastes do not trigger this email. Mailer failures
are swallowed — an email failure never breaks a signup. The message never
contains the secret.

An account with Telegram linked also receives best-effort, secret-free lifecycle
alerts for credential store/rotate/delete/restore, card add/remove, payment
execution or caller-placed order attempts, and egress-grant mint/revoke events. These sends decorate the single
vault audit-store dependency, so every producer shares the same notification
path. Delivery is fire-and-forget and all Telegram failures are swallowed; a
Telegram outage never delays or fails a vault operation. Messages use only
non-secret display metadata: service/label or merchant/amount, action, timestamp,
and the card's last four digits when relevant. A caller-placed click is labeled
as attempted rather than executed because its merchant outcome is not verified.

Credential retrieval and proxy execution/rejection are deliberately excluded
from per-event Telegram pushes to avoid access spam. They remain visible in the
Activity trail. The intended future shape is a batched, default-off,
per-account access digest.

## Retention

The hourly in-process retention cron (`retention-cron.ts`) sweeps:

| Data | Window | Env |
|---|---|---|
| Inbox bodies → null | 7d | `INBOX_BODY_RETENTION_DAYS` |
| Inbox metadata → delete | 90d | `INBOX_METADATA_RETENTION_DAYS` |
| Pairing tokens → delete | 1h | `PAIRING_TOKEN_RETENTION_HOURS` |
| LLM usage events → delete | 30d | `LLM_EVENT_RETENTION_DAYS` |
| **Vault audit events → delete** | **365d** | **`VAULT_AUDIT_RETENTION_DAYS`** |
| **Payment audit events → delete** | **365d** | **`VAULT_AUDIT_RETENTION_DAYS`** |
| Expired payment approvals → delete | After `expires_at` | none |
| Expired credential-mutation approvals → delete | After `expires_at` | none |

Vault and payment audit events share the one-year window — long enough for a
post-hoc investigation, bounded so the tables do not grow without limit.
Soft-deleted *credentials* are NOT swept by the cron; they persist
(recoverable) until a GDPR `DELETE /v1/vault/account`.

`VAULT_ROTATION_STALE_DAYS` (default 90) drives the `stale` flag on the
list response — advisory only, not enforced.

## Backup / DR

- **Storage:** Fly Postgres cluster `trusty-squire-db`, database
  `trustysquire` (the API auth schema owns the `Credential` +
  `VaultAuditEvent`, `E2ECredential`, `PaymentAuditEvent`, and
  `PendingPaymentApproval` tables). Backed by Fly's volume snapshots.
- **What a backup contains:** the encrypted envelope only. A restored
  DB is useless without the matching `LOCAL_KMS_KEY` — so **the master
  key must be backed up independently of the database** (it lives as a
  Fly secret; export it to your password manager / KMS out-of-band).
  Losing `LOCAL_KMS_KEY` = losing every credential, restore or not.
  Restored `E2ECredential` rows still require the matching enrolled passkey to
  recover their protected card payload; see the
  [`SECURITY.md` contract](../SECURITY.md#client-encrypted-card-data) for the
  server-visible fields.
- **Restore procedure:** restore the Fly volume snapshot, confirm
  `LOCAL_KMS_KEY` (and any `LOCAL_KMS_LEGACY_KEYS`) match the snapshot's
  era, then run `vault-decrypt-check` to confirm decryptability before
  taking traffic.
- **What's lost on restore:** anything written between the snapshot and
  the failure — including audit events. There is no point-in-time WAL
  shipping configured beyond Fly's defaults; if tighter RPO is needed,
  enable continuous archiving on the cluster.

## Deferred (intentionally not built in this sweep)

- **Device-gating / device-revocation** (Vouchflow `DeviceAssertion`
  path in `credential-vault.ts`). Device-attestation, not KMS — a larger
  design (`~/.claude/plans/…jolly-hollerith…`). The `retrieve()` +
  `StaleAssertionError` scaffolding is half-built for it.
- **True secret value versioning/history.** Deliberately NOT added:
  retaining prior secret *values* turns a write-only sink into a
  secret-history store — a confidentiality downgrade. Rotation events
  are already in the audit trail; the *values* are gone by design.
- **Live "key still works" upstream probe.** The `health` endpoint
  checks the *envelope*, not whether the provider still accepts the key
  — that needs per-service live calls (out of this layer's scope).
- **Access-event digest.** Retrieval and proxy events remain in the Activity
  trail but are intentionally excluded from per-event Telegram pushes. A
  batched, default-off, per-account digest is not built yet; the operative
  anti-spam invariant lives in
  [`vault-notify.ts`](../apps/api/src/services/vault-notify.ts).
