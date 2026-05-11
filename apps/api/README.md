# api

The main backend gateway. Ties the runtime, mandate validator, vault, inbox, and adapter registry together. Serves the PWA (chunk 12) and the MCP server (chunk 11).

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
| `POST` | `/v1/accounts` | none | Create account from a Vouchflow `account_register` bundle |
| `POST` | `/v1/auth/login` | none | Exchange a Vouchflow `login` bundle for a session |
| `POST` | `/v1/auth/logout` | web | Revoke the active web session |
| `POST` | `/v1/mandates` | web | Submit a Vouchflow `mandate_signing` bundle |
| `GET` | `/v1/mandates/active` | web | Fetch the current active mandate |
| `POST` | `/v1/runs` | web or agent | Create a run; evaluator routes silent / needs_approval / reject |
| `GET` | `/v1/runs/:id` | web or agent | Run status |
| `GET` | `/v1/approvals/:token` | web | Approval flow info (PWA renders the page) |
| `POST` | `/v1/approvals/:token/grant` | web | Submit Vouchflow `delta_mandate_signing` bundle |
| `POST` | `/v1/approvals/:token/deny` | web | User declines |
| `GET` | `/v1/credentials/:reference` | agent | Retrieve credential (per-account scope enforced) |
| `GET` | `/v1/subscriptions` | web | List subscriptions |
| `DELETE` | `/v1/subscriptions/:id` | web | Cancel (stub: returns 202, cancellation pipeline arrives in chunk 11+) |
| `GET` | `/v1/ledger` | web | Recent runs |
| `GET` | `/v1/usage` | web or agent | Monthly + daily spend vs budget |
| `POST` | `/webhooks/vouchflow/device-revoked` | none | Stub for Vouchflow webhook (logs + 202; signature verification TBD) |
| `GET` | `/health` | none | Liveness |

## Auth model

Two paths:

- **Web session**: HTTP-only `ts_session` cookie, HS256 JWT signed with `SESSION_JWT_SECRET`. The JWT's `jti` is looked up in the `Session` table on every authenticated request — supports revocation without invalidating cookie format. Idle expiry (15 min from last activity, refreshed each authenticated request) plus an 8h absolute cap.
- **Agent (MCP)**: `Authorization: Bearer mcp_session_<base64url>`. The raw token is shown once at issuance; only `SHA-256(token)` is persisted. 24h absolute, no refresh.

Vouchflow `signPayload` bundles are verified by the `@trusty-squire/mandate-validator` package against Vouchflow's published JWKs. We never trust top-level bundle fields — only the verified JWS claims.

## Vouchflow contexts

| Context | Endpoint | Min confidence |
|---|---|---|
| `account_register` | `/v1/accounts` | `medium` |
| `login` | `/v1/auth/login` | `medium` |
| `mandate_signing` | `/v1/mandates` | `high` |
| `delta_mandate_signing` | `/v1/approvals/:token/grant` | per-mandate (defaults to `high`) |

The mandate validator enforces a lower-bound invariant: a mandate may RAISE a context's confidence requirement but cannot lower it below `DEFAULT_CONFIDENCE_REQUIREMENTS`.

## Worker

`src/workers/run-processor.ts` exports `processRunJob(data, deps)` — drives one `executeOneStep` call and re-enqueues if the run isn't terminal and isn't waiting for an external event (`PENDING_APPROVAL`). The BullMQ wiring + Redis connection lives in the production boot module; tests inject a fake `enqueueFollowUp` to avoid Redis.

## What's NOT here

- `/v1/devices` — Vouchflow tracks enrolled devices via its Web SDK's `getEnrollmentState`. The PWA reads enrollment state directly from Vouchflow; we record `signing_device_id`s we've seen for ledger purposes only.
- WebAuthn registration ceremony — handled entirely by the Vouchflow Web SDK on the client side.
- Stripe Issuing — separate chunk.
- OAuth — session cookies / agent bearer tokens only.
- Real WebSockets / SSE — PWA polls `GET /v1/runs/:id`.

## Production wiring (TODO at boot module)

The Prisma-backed implementations of `SessionStore`, `AgentSessionStore`, `ApprovalTokenStore`, and `AccountStore` live outside this package (in a deploy-only module). The `buildInMemoryDeps()` helper here serves dev + tests; replace it at production boot with a `buildPrismaDeps()` equivalent.
