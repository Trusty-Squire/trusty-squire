# Vault operations cleanup (write-only sink, v2)

Refines the credential surface now that the vault is a write-only sink
(0.8.3-rc.3: `use_credential` proxy only, no raw-value extraction,
enforced host allowlist). Four decisions, all resolved below.

## Decisions (recommendations — locked)

### 1. Agents cannot rotate → remove `rotate_credential`
Rotation is incoherent for an agent in a write-only sink:
- Overwriting with a value the agent holds is just `store` (the agent
  only ever has a value at the moment the user pastes one).
- Minting a new key at the provider returns the new plaintext through
  the proxy response — a secret leak.

So rotation = re-`store` (see #2). Drop the dedicated tool.

### 2. One entry per app; `store` is an upsert
A credential entry is **unique on `(account_id, service, label)`**:
- `label` defaults to `"default"` → "one entry per app" in the common
  case, while still allowing prod/dev/personal keys for the same
  service (a separate axis from multi-*field*, #4).
- `store` becomes an **upsert**: first write creates; later writes for
  the same `(account, service, label)` overwrite the field set. This
  *is* rotation — no separate verb.

Cost (accepted): `store` is now destructive (overwrite). A compromised
agent could clobber a real key with junk — but that's an **availability**
dent (next `use_credential` fails until re-pasted), never a
confidentiality leak, and it's audited.

### 3. Agents cannot delete → human-only (web vault)
Deletion is pure downside on the agent surface: same availability-
sabotage as overwrite but worse (loses the entry's allowlist + field
structure + env hints, and a looping agent could wipe the vault), with
near-zero agent benefit. No confidentiality impact, but destructive
lifecycle. Keep delete in the web UI (human, soft-delete + audit).
Remove `delete_credential` from the agent.

### 4. Arbitrary multi-credentials → named-field map, no per-service schema
An entry holds a **map of named secret fields**:
`{ access_key_id, secret_access_key }`, `{ account_sid, auth_token }`,
`{ host, port, user, password, dbname }`, or `{ value }` for a lone key.
Field **names** are not secret (like `AWS_ACCESS_KEY_ID`); only the
**values** are encrypted. The "common format" is just `string → string`
— universal across AWS / Twilio / DB DSN / OAuth / single-key, zero
special-casing. This also subsumes the old `type` enum.

Proxy substitution generalizes:
```
${SECRET}               → the sole / default field (single-key back-compat)
${SECRET.access_key_id} → a named field
${SECRET_JSON.field}    → JSON-escaped variant, per field
```
Same injection/SSRF guards applied per substituted value.

## Resulting surface

**Agent (3 tools):**
- `list_credentials` → `[{ reference, service, label, field_names[],
  allowed_hosts, last_used }]` (names, never values).
- `store_credential` → upsert `{ service, label?, fields | value,
  env_var_suggestions? }`. Create-or-overwrite.
- `use_credential` → proxy with `${SECRET[.field]}` substitution;
  allowlist enforced.

**Human only (web vault):** delete, edit allowed_hosts, edit individual
fields, reveal. Plus manual create/upsert.

Gone: `rotate_credential`, `delete_credential` (agent), the
request/poll/approval/grant/trust machinery (already removed in rc.3).

## Schema

Keep one `Credential` row per entry; the encrypted payload becomes a
**JSON object of fields** rather than a bare string. Reuses the existing
AES-256-GCM envelope unchanged (only the plaintext shape changes).

`Credential` changes:
- add `label String @default("default")`
- add `field_names String[]` (plaintext — non-secret; powers
  `list_credentials` + the web field editor + proxy validation without
  decrypting)
- `ciphertext` now encrypts `JSON.stringify({ [field]: value })`
- `@@unique([account_id, service, label])` — but `service` currently
  lives in `metadata` JSON, not a column. Promote it to a real
  `service String` column to support the constraint + cheaper lookups.
- `type`/`env_var_suggestion` → per-field env-var hints map (optional),
  or drop `type` entirely.

Migration: the deployed vault holds only throwaway test credentials, so
either a one-shot re-encrypt (decrypt → wrap as `{value}` JSON → set
`service`/`label`/`field_names`) or accept re-adding them. No real user
data at risk.

## Web UI changes

- **Vault list row** shows `service · label`, the field names (or
  `key_name`), allowed hosts, and last-used. Overflow menu: Edit fields,
  Edit allowed hosts, Delete.
- **New / edit credential page** — redesigned (Linear register), see
  below. Progressive disclosure: single masked secret by default;
  "+ Add field" for multi-part credentials; label + env hints + hosts
  under Advanced. Allowed-hosts as a chip/token input, pre-seeded from
  the service. `⌘↵` to save, `Esc` to cancel.
- **Field editor** (web only) for per-field edits; reveal stays web-only.

## Sequencing (independently shippable)

1. **Schema + vault core**: `service`/`label`/`field_names` columns,
   unique constraint, JSON-field payload, upsert `store`, generalized
   `${SECRET.field}` substitution in the proxy + guards. Unit tests.
2. **API**: upsert route semantics, `list_credentials` field_names,
   migration. Integration tests.
3. **MCP**: trim to list/store(upsert)/use; store accepts fields/label;
   use supports `${SECRET.field}`; drop rotate + delete tools; refresh
   `instructions`; installer permissions. Tests.
4. **Web**: redesigned new/edit page, field editor, list row, delete +
   allowlist in overflow.
5. Cut RC, deploy API + db migrate, deploy web, publish mcp.

## Risks
- Upsert overwrite = availability-sabotage vector (accepted; audited,
  recoverable, no confidentiality loss).
- Field names stored plaintext (non-secret by design; note to users not
  to put secrets in field *names*).
- `(account, service, label)` uniqueness needs `service` promoted to a
  column; dedupe any existing duplicates at migration (throwaway today).
