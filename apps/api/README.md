# api

The main backend gateway. Ties OAuth sessions, the vault, inbox, billing, and the MCP install/runtime APIs together.

## Local dev

```bash
# Generate a session JWT secret + set in your shell:
export SESSION_JWT_SECRET="$(node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))")"

# Then:
pnpm --filter @trusty-squire/api dev
# Listens on :3000 by default. Override with API_PORT.
```

The dev server uses **in-memory implementations** of every store. Production wires the Prisma + Redis-backed equivalents at boot (out-of-package, since the api package keeps its dependency surface minimal).

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/v1/auth/oauth/:provider/start` | none | Start Google/GitHub OAuth login |
| `GET` | `/v1/auth/oauth/:provider/callback` | none | Complete OAuth login and mint a web session |
| `POST` | `/v1/auth/logout` | web | Revoke the active web session |
| `GET` | `/v1/auth/whoami` | none/web | Report the current web session and linked OAuth identities |
| `POST` | `/v1/mcp/sessions` | web | Issue an MCP agent session token |
| `POST` | `/v1/vault/use` | agent | Retrieve a vault credential for allowed egress |
| `POST` | `/v1/vault/browser-fill` | agent | Seal login/password fields for allowed browser sign-in hosts |
| `GET` | `/v1/vault/credentials` | web/agent | List vault credentials |
| `GET` | `/v1/vault/audit` | web/agent | List the account's secret-free Activity trail with keyset pagination and optional `type`/`reference` filters |
| `POST` | `/v1/vault/e2e` | web | Store an opaque, client-encrypted card blob |
| `GET` | `/v1/vault/e2e` | web/agent | List client-encrypted card metadata without blobs |
| `GET` | `/v1/vault/e2e/:id` | web/agent | Retrieve account-owned card display metadata plus its opaque encrypted blob |
| `PATCH` | `/v1/vault/e2e/:id/label` | web | Rename an account-owned encrypted card |
| `DELETE` | `/v1/vault/e2e/:id` | web | Delete an account-owned encrypted card blob |
| `POST` | `/v1/vault/payments/audit` | agent | Record a payment attempt without PAN or CVV |
| `GET` | `/v1/vault/payments/audit` | web/agent | List payment attempts, newest first, with keyset pagination |
| `GET` | `/v1/pay/config` | agent | Return the configured Vouchflow mandate audience |
| `POST` | `/v1/pay/approvals` | agent | Create an account-scoped approval: card-less expires in 18 minutes; has-card in 10 minutes |
| `POST` | `/v1/pay/approvals/:id/notify-3ds` | agent | Send a Telegram 3-D Secure nudge to the account's linked chat and return `{ sent }` |
| `GET` | `/v1/pay/approvals/:id` | web/agent | Poll an account-owned payment approval |
| `POST` | `/v1/pay/approvals/:id/bind-card` | web | Bind an account-owned card to a card-less pending approval |
| `POST` | `/v1/pay/approvals/:id/approve` | web | Relay a signed mandate and HPKE-sealed card to the operator |
| `GET` | `/health` | none | Liveness |

Client-encrypted card creation accepts optional plaintext `brand` and `last4`
display metadata alongside the opaque blob. `brand` must be 1–32 characters,
start with a letter, and otherwise contain only letters, spaces, and hyphens;
`last4` must be exactly four digits. The full PAN remains only inside the
encrypted blob. List responses and GDPR vault exports include `brand` and
`last4` (`null` for legacy rows). `PATCH /v1/vault/e2e/:id/label` accepts
`{ label }` and changes only the label; the blob and card metadata remain
unchanged. The detail response has exactly `id`, `label`, `blob`, `brand`,
`last4`, and `createdAt`; PAN and CVV never appear as separate response fields.

`GET /v1/vault/audit` includes credential access and lifecycle activity plus
card, payment, and egress-grant lifecycle events. Its `type` filter is derived
from the canonical
[`VAULT_AUDIT_TYPES`](../../packages/vault/src/types.ts) values rather than a
second hand-maintained enum. Every event payload is display metadata only.

Payment approval creation requires non-empty `item` and `reason` strings and
stores their trimmed values. The API records `agent` from a valid, non-empty
`X-Squire-Agent-Identity` header; the MCP server sets that header from the
requesting host's `initialize` `clientInfo.name`. An absent or invalid header
falls back to the authenticated install identity and then `unknown-agent`; an
`agent` field in the JSON body cannot override it. The create response returns
`agent`, and polling returns all three values for the approval page and signed
mandate. `card_ref` is optional, but `operator_pubkey` remains required at
creation. Card-less approvals expire after 18 minutes to allow the JIT add-card
ceremony; approvals created with a card keep the 10-minute window. A card-less
approval follows the server-enforced seal → bind → approve order. Binding is
pending-only, write-once, rejects an expired approval, and accepts only an
`E2ECredential` owned by the same account; an unknown or foreign card returns
`404`. Approving before a card is bound returns
`409 { "error": "card_required" }`.

## Auth model

Two paths:

- **Web session**: HTTP-only `ts_session` cookie, HS256 JWT signed with `SESSION_JWT_SECRET`. The JWT's `jti` is looked up in the `Session` table on every authenticated request — supports revocation without invalidating cookie format. Idle expiry (15 min from last activity, refreshed each authenticated request) plus an 8h absolute cap.
- **Agent (MCP)**: `Authorization: Bearer mcp_session_<base64url>`. The raw token is shown once at issuance; only `SHA-256(token)` is persisted. 24h absolute, no refresh.

Human login is Google/GitHub OAuth only. The retired Vouchflow signed-bundle login path and mandate-validator package are no longer part of the API.

## Worker

`src/workers/run-processor.ts` exports `processRunJob(data, deps)` — drives one `executeOneStep` call and re-enqueues if the run isn't terminal and isn't waiting for an external event (`PENDING_APPROVAL`). The BullMQ wiring + Redis connection lives in the production boot module; tests inject a fake `enqueueFollowUp` to avoid Redis.

## What's NOT here

- Stripe Issuing — separate chunk.
- Vouchflow signed-bundle login or WebAuthn registration ceremony.
- Real WebSockets / SSE — PWA polls `GET /v1/runs/:id`.

## Production wiring (TODO at boot module)

The Prisma-backed implementations of `SessionStore`, `AgentSessionStore`, `ApprovalTokenStore`, and `AccountStore` live outside this package (in a deploy-only module). The `buildInMemoryDeps()` helper here serves dev + tests; replace it at production boot with a `buildPrismaDeps()` equivalent.
