# Vault operations runbook

Operational reference for the credential vault: the security + lifecycle
surface, master-key custody, retention, and backup/DR. Companion to
`DESIGN-vault-operations-v2.md` (which captures the write-only-sink design
decisions) — this doc is the *runbook*, not the design.

Landed in the 2026-05-30 vault-hardening sweep. Everything below is
account-scoped and, for the human paths, web-session only.

## Encryption model (what's actually at rest)

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
| `GET /v1/vault/audit` | web | Who-touched-my-keys timeline — full event trail, newest-first, keyset paginated (`before`), `type`/`reference` filters. No secret values. |
| `POST /v1/vault/credentials/:id/health` | web | Envelope integrity probe — confirms the row still decrypts under the current keyring. No secret returned, no retrieval counted. `healthy:false` ≠ HTTP error. |
| `POST /v1/vault/credentials/:id/restore` | web | Undelete a soft-deleted credential. `409` if a live `(service,label)` twin holds the slot. |
| `POST /v1/vault/credentials/revoke-all` | web | Kill-switch: soft-delete every active credential. Requires `{ confirm: true }`. Recoverable via restore until retention sweeps. |
| `GET /v1/vault/export` | web | GDPR export — all credential metadata (active + deleted) + full audit trail, as a download. No secret values. |
| `DELETE /v1/vault/account` | web | GDPR erasure — irreversibly hard-purge all credential rows AND the audit trail. Requires `{ confirm: true }`. |

`revoke-all` (soft, recoverable) vs `DELETE /v1/vault/account` (hard,
irreversible) are deliberately distinct: the first is the panic button,
the second is right-to-be-forgotten.

**Rate limiting:** every decrypt path — agent retrieve, runtime
retrieve, AND web `reveal` — counts against one per-account ceiling
(100/hr). There is no human-only bypass.

## Notifications

A **new** credential stored via the agent path (bot signup) fires a
best-effort "new `<service>` key added" email to the account owner.
Rotations and manual web pastes do not notify. Mailer failures are
swallowed — a notification never breaks a signup. The email never
contains the secret.

## Retention

The hourly in-process retention cron (`retention-cron.ts`) sweeps:

| Data | Window | Env |
|---|---|---|
| Inbox bodies → null | 7d | `INBOX_BODY_RETENTION_DAYS` |
| Inbox metadata → delete | 90d | `INBOX_METADATA_RETENTION_DAYS` |
| Pairing tokens → delete | 1h | `PAIRING_TOKEN_RETENTION_HOURS` |
| LLM usage events → delete | 30d | `LLM_EVENT_RETENTION_DAYS` |
| **Vault audit events → delete** | **365d** | **`VAULT_AUDIT_RETENTION_DAYS`** |

Vault audit is kept a year — long enough for a post-hoc compromise
investigation, bounded so the table doesn't grow unbounded (it had no
sweep before this sweep). Soft-deleted *credentials* are NOT swept by
the cron; they persist (recoverable) until a GDPR `DELETE /v1/vault/account`.

`VAULT_ROTATION_STALE_DAYS` (default 90) drives the `stale` flag on the
list response — advisory only, not enforced.

## Backup / DR

- **Storage:** Fly Postgres cluster `trusty-squire-db`, database
  `trustysquire` (the API auth schema owns the `Credential` +
  `VaultAuditEvent` tables). Backed by Fly's volume snapshots.
- **What a backup contains:** the encrypted envelope only. A restored
  DB is useless without the matching `LOCAL_KMS_KEY` — so **the master
  key must be backed up independently of the database** (it lives as a
  Fly secret; export it to your password manager / KMS out-of-band).
  Losing `LOCAL_KMS_KEY` = losing every credential, restore or not.
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
- **Leaked-credential detection / proxy_rejected alerting.** The events
  exist in the audit trail; no alerting consumer is wired yet.
