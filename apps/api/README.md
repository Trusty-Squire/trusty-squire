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
| `GET` | `/v1/vault/credentials` | web | List vault credentials |
| `GET` | `/v1/llm/credits` | web | Current LLM credit state |
| `GET` | `/health` | none | Liveness |

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
